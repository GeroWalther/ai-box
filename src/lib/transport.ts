// Transport abstraction: the whole app talks to the Rust backend through these
// two functions. In the Tauri desktop window they use IPC (`invoke` / `Channel`);
// when the UI is loaded over HTTP on a phone they use `fetch` / a WebSocket to the
// companion server (see src-tauri/src/server.rs). UI and feature code stay identical.

import { invoke, Channel } from "@tauri-apps/api/core";

const TOKEN_KEY = "ai-studio.remote-token";

/** True when running inside the Tauri desktop webview (vs. served over HTTP). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// On first web load, capture a pairing token from the URL hash (#token=…) so the
// QR-code link authenticates the device, then strip it from the address bar.
function captureToken(): void {
  if (typeof window === "undefined" || isTauri()) return;
  const hash = window.location.hash || "";
  const m = hash.match(/token=([^&]+)/);
  if (m) {
    try {
      localStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1]));
    } catch {
      /* ignore */
    }
    // Remove the token from the visible URL / history.
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}
captureToken();

function token(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

/** One-shot command. Desktop → `invoke`; web → `POST /rpc/:name`. */
export async function invokeCmd<T>(
  name: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  if (isTauri()) return invoke<T>(name, args);
  const res = await fetch(`/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
    },
    body: JSON.stringify(args),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok || (data && data.error)) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data.result as T;
}

/**
 * Streaming command. Desktop → a Tauri `Channel`; web → multiplexed over a shared
 * WebSocket. `onEvent` receives each emitted event object; the promise resolves
 * with the command's return value when it completes.
 */
export function streamCmd<T>(
  name: string,
  args: Record<string, unknown>,
  onEvent: (ev: any) => void
): Promise<T> {
  if (isTauri()) {
    const channel = new Channel<any>();
    channel.onmessage = onEvent;
    return invoke<T>(name, { ...args, onEvent: channel });
  }
  return wsRequest<T>(name, args, onEvent);
}

/** Abort an in-flight streaming generation by request id (Stop button). Works in
 *  both transports: desktop → `cancel_generation` command; web → a cancel frame on
 *  the shared socket. Server-side this stops the upstream request, not just the UI. */
export function cancelStream(requestId: string): void {
  if (!requestId) return;
  if (isTauri()) {
    invoke("cancel_generation", { requestId }).catch(() => {});
    return;
  }
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({ id: nextId++, command: "cancel_generation", args: { targetRequestId: requestId } })
    );
  }
}

// ---- Web WebSocket multiplexer -------------------------------------------

interface Pending {
  onEvent: (ev: any) => void;
  resolve: (v: any) => void;
  reject: (e: any) => void;
}

let socket: WebSocket | null = null;
let socketReady: Promise<WebSocket> | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function connect(): Promise<WebSocket> {
  if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  if (socketReady) return socketReady;
  socketReady = new Promise((resolve, reject) => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const t = token();
    const url = `${proto}://${window.location.host}/ws${t ? `?token=${encodeURIComponent(t)}` : ""}`;
    const ws = new WebSocket(url);
    ws.onopen = () => {
      socket = ws;
      resolve(ws);
    };
    ws.onerror = () => {
      socketReady = null;
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      socket = null;
      socketReady = null;
      // Fail any in-flight requests so callers don't hang forever.
      for (const [, p] of pending) p.reject(new Error("connection closed"));
      pending.clear();
    };
    ws.onmessage = (e) => {
      let frame: any;
      try {
        frame = JSON.parse(e.data);
      } catch {
        return;
      }
      const p = pending.get(frame.id);
      if (!p) return;
      if (frame.done) {
        pending.delete(frame.id);
        if (frame.error) p.reject(new Error(frame.error));
        else p.resolve(frame.result);
      } else if ("event" in frame) {
        p.onEvent(frame.event);
      }
    };
  });
  return socketReady;
}

async function wsRequest<T>(
  command: string,
  args: Record<string, unknown>,
  onEvent: (ev: any) => void
): Promise<T> {
  const ws = await connect();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { onEvent, resolve, reject });
    ws.send(JSON.stringify({ id, command, args }));
  });
}

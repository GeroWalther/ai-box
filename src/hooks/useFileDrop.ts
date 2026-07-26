// Dropping a file onto the terminal, resolved to a real path on the Mac.
//
// Why this needs a hook at all: dropping an image onto the terminal did nothing,
// for two separate reasons.
//
//   1. Tauri handles OS file drops natively (`dragDropEnabled` defaults to true),
//      so the webview never receives HTML5 `dragover`/`drop` events. A perfect
//      DOM handler would simply never fire. The drop arrives as a Tauri event
//      instead — which is the better source anyway, because it carries real
//      filesystem paths, while a `File` in a WKWebView does not expose one.
//   2. Nothing wrote anything into the PTY. A native terminal inserts the
//      dropped file's path at the cursor; that is what a CLI like Claude Code
//      reads to open the image. We have to do that ourselves.
//
// On the phone there is no host path at all, so the bytes are shipped to the Mac
// (`save_dropped_file`) and the path it returns is what gets inserted.

import { useEffect, useRef, useState } from "react";
import { invokeCmd, isTauri } from "../lib/transport";
import { logError } from "../lib/log";

/** Single-quote a path for the shell, escaping any embedded quote. */
export function quoteForShell(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.onload = () => {
      const result = String(reader.result);
      // Strip the "data:<mime>;base64," prefix the reader adds.
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

interface Options {
  /** The element drops must land on. */
  target: React.RefObject<HTMLElement | null>;
  /** Only react while this pane is the visible one. */
  enabled: boolean;
  /** Called with the resolved Mac paths, in drop order. */
  onPaths: (paths: string[]) => void;
}

/**
 * Returns whether a drag is currently hovering the target, so the caller can
 * show a drop affordance.
 */
export function useFileDrop({ target, enabled, onPaths }: Options): boolean {
  const [hovering, setHovering] = useState(false);
  const onPathsRef = useRef(onPaths);
  onPathsRef.current = onPaths;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // --- desktop: Tauri's native drag-drop event (carries real paths) ---------
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    /** Is this physical screen position inside our element? */
    const isOverTarget = (position?: { x: number; y: number }) => {
      const el = target.current;
      if (!el) return false;
      if (!position) return true; // no position given — assume the visible pane
      const rect = el.getBoundingClientRect();
      // Tauri reports physical pixels; the DOM works in CSS pixels.
      const dpr = window.devicePixelRatio || 1;
      const x = position.x / dpr;
      const y = position.y / dpr;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };

    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (!enabledRef.current) return;
          const payload = event.payload;
          switch (payload.type) {
            case "enter":
            case "over":
              setHovering(isOverTarget(payload.position));
              break;
            case "leave":
              setHovering(false);
              break;
            case "drop":
              setHovering(false);
              // The event is window-wide, so ignore drops onto other panes.
              if (isOverTarget(payload.position) && payload.paths.length) {
                onPathsRef.current(payload.paths);
              }
              break;
          }
        })
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => logError("drop.listen", e));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [target]);

  // --- phone / browser: HTML5 drop, bytes shipped to the Mac ---------------
  useEffect(() => {
    if (isTauri()) return; // Tauri swallows these events; handled above
    const el = target.current;
    if (!el) return;

    const stop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onOver = (e: DragEvent) => {
      if (!enabledRef.current) return;
      stop(e);
      setHovering(true);
    };
    const onLeave = () => setHovering(false);
    const onDrop = async (e: DragEvent) => {
      if (!enabledRef.current) return;
      stop(e);
      setHovering(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      const paths: string[] = [];
      for (const file of files) {
        try {
          const base64 = await fileToBase64(file);
          paths.push(
            await invokeCmd<string>("save_dropped_file", { base64, name: file.name })
          );
        } catch (err) {
          logError("drop.upload", err);
        }
      }
      if (paths.length) onPathsRef.current(paths);
    };

    el.addEventListener("dragover", onOver);
    el.addEventListener("dragenter", onOver);
    el.addEventListener("dragleave", onLeave);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragover", onOver);
      el.removeEventListener("dragenter", onOver);
      el.removeEventListener("dragleave", onLeave);
      el.removeEventListener("drop", onDrop);
    };
  }, [target]);

  return hovering;
}

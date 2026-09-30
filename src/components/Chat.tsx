import { useEffect, useMemo, useRef, useState } from "react";
import { listOllamaModels } from "../lib/api";
import { assistProvider, resolveTextProvider, type Settings } from "../lib/settings";
import { isTauri } from "../lib/transport";
import { remoteStoreMerge } from "../lib/remoteStore";
import { registerSyncSource } from "../lib/syncBus";
import { logError } from "../lib/log";
import { parseSyncList } from "../lib/syncList";
import { useOpenrouterModels } from "../lib/openrouterModels";
import { useToast } from "../lib/toast";
import { Recorder, say, spokenText, transcribe } from "../lib/screenAssist";
import {
  approveTask,
  deleteTask,
  getTask,
  isLive,
  replyTask,
  sendToTask,
  startTask,
  stopTask,
  type Task,
} from "../lib/tasks";
import TaskThread from "./TaskThread";
import { listen } from "@tauri-apps/api/event";
import ModelSelect from "./ModelSelect";
import { useDirectModels } from "../hooks/useDirectModels";
import Markdown from "./Markdown";
import SidebarList, { SidebarSlot } from "./SidebarList";
import { useFileDrop } from "../hooks/useFileDrop";
import {
  attachFile,
  attachPath,
  attachmentUrl,
  isImageFile,
  isImagePath,
  type Attached,
} from "../lib/attachments";

interface Msg {
  role: "user" | "assistant" | "tool";
  content: string;
  reasoning: string;
  detail?: string; // tool: expandable output/diff
  ok?: boolean; // tool: success/failure for the status icon
  images?: Attached[]; // user: attached images, stored on the Mac by id
}
interface Session {
  id: string;
  title: string;
  messages: Msg[];
  /** Last-edit timestamp (ms) used to merge concurrent desktop/phone edits. */
  updatedAt?: number;
  /** In Agent mode the conversation runs as a task on the Mac; this is it.
   *  `messages` then only holds what was said before it became one. */
  taskId?: string;
}

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onOpenSettings: () => void;
  /** DOM node in App's unified sidebar where this tab's chat list is portaled. */
  sidebarSlot: HTMLElement | null;
  onCloseDrawer?: () => void;
}

const SESSIONS_KEY = "ai-studio.sessions";
const SESSIONS_DEL_KEY = "ai-studio.sessions.deleted";

function splitThink(raw: string): { think: string; answer: string } {
  if (!raw.includes("<think>")) return { think: "", answer: raw };
  const m = raw.match(/<think>([\s\S]*?)(?:<\/think>|$)/);
  const think = m ? m[1] : "";
  const answer = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/, "").trim();
  return { think, answer };
}
/** One attached image, loaded from the Mac on demand. */
function AttachmentThumb({ a, onRemove }: { a: Attached; onRemove?: () => void }) {
  const [url, setUrl] = useState("");
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    attachmentUrl(a.id).then(
      (u) => live && setUrl(u),
      () => live && setMissing(true),
    );
    return () => {
      live = false;
    };
  }, [a.id]);
  return (
    <div className="attach-thumb" title={a.source || a.name}>
      {url ? <img src={url} alt={a.name} /> : <span>{missing ? "missing" : "…"}</span>}
      {onRemove && (
        <button className="attach-thumb-x" onClick={onRemove} title="Remove image" aria-label="Remove image">
          ×
        </button>
      )}
    </div>
  );
}

/** A model id as a person would say it: "google:gemini-3.8-flash" → "gemini-3.8-flash". */
function shortModel(id: string): string {
  if (!id) return "no model";
  return id.split(/[:/]/).pop() || id;
}

function newSession(): Session {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    messages: [],
    updatedAt: Date.now(),
  };
}

export default function Chat({ settings, onChange, onOpenSettings, sidebarSlot, onCloseDrawer }: Props) {
  const { error: toastError } = useToast();
  const [sessions, setSessions] = useState<Session[]>(() => {
    try {
      const s = JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]");
      return Array.isArray(s) && s.length ? s : [newSession()];
    } catch {
      return [newSession()];
    }
  });
  const [activeId, setActiveId] = useState<string>(() => localStorage.getItem("ai-studio.chat.active") || "");
  const [input, setInput] = useState("");
  // Images waiting to go out with the next message, and how many are still
  // being read and shrunk on the Mac — sending waits for those.
  const [attachments, setAttachments] = useState<Attached[]>([]);
  const [attaching, setAttaching] = useState(0);
  const viewRef = useRef<HTMLDivElement>(null);
  const [toolsOpen, setToolsOpen] = useState(false); // collapse the model/agent bar for a clean canvas
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  /** The active chat's task, when it has one, as last fetched from the Mac. */
  const [task, setTask] = useState<Task | null>(null);
  const taskRef = useRef<Task | null>(null);
  taskRef.current = task;
  /** Per task: how much of it has been read aloud, so voice mode speaks only
   *  what is new — never a whole history on opening a chat. */
  const spokenRef = useRef<Record<string, { steps: number; pending: string }>>({});
  /** Whether the last message was spoken. Replies to a spoken message are
   *  read aloud; replies to a typed one are not — no switch to set. */
  const spokeRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef("");
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /**
   * Whether speech can become text here. Transcription borrows the Screen
   * Assist model — one picked because it can hear — and no local model can.
   * A browser also only hands the microphone to a secure page, which a phone
   * reaching the Mac over plain http is not. Where either fails, the mic and
   * Voice are not offered at all; the phone keyboard's own dictation works.
   */
  const canTranscribe = !assistProvider(settings).local && (isTauri() || window.isSecureContext);
  /** A phone or tablet keyboard: Return makes a new line there. */
  const touchKeyboard = useMemo(() => window.matchMedia?.("(pointer: coarse)").matches ?? false, []);

  // Grow the box with what is typed, up to a limit, then scroll inside it.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [input]);
  // Dictation. The transcript lands in the composer rather than being sent, so
  // a misheard instruction is caught before an agent with shell access acts on
  // it — and so it works with chat models that cannot hear, local ones included.
  const recorder = useRef(new Recorder());
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);

  async function toggleDictation() {
    if (transcribing) return;
    if (listening) {
      setListening(false);
      const clip = await recorder.current.stop().catch(() => null);
      if (!clip) return;
      setTranscribing(true);
      try {
        const text = await transcribe(settings, clip);
        if (text) void handleSpoken(text);
      } catch (e) {
        logError("chat.dictate", e);
        toastError(String(e));
      } finally {
        setTranscribing(false);
      }
      return;
    }
    unlockSpeech();
    try {
      await recorder.current.start();
      setListening(true);
    } catch (e) {
      logError("chat.mic", e);
      // A phone reaching the Mac over plain http is not a "secure context", and
      // browsers only hand the microphone to secure pages. Say so, rather than
      // blaming a permission the user cannot find.
      toastError(
        !isTauri() && !window.isSecureContext
          ? "The browser only allows the microphone on a secure (https) connection. Use your keyboard's dictation key instead — with Voice on, replies are still read aloud."
          : "No microphone access. Grant it in System Settings → Privacy & Security → Microphone.",
      );
    }
  }

  /** Mobile browsers only speak after a tap has allowed it once; a silent
   *  utterance during one (the mic, the Voice switch) unlocks the rest. */
  function unlockSpeech() {
    if (isTauri() || !("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    window.speechSynthesis.speak(u);
  }

  /** Read something aloud: the Mac's voice on the Mac, the phone's on the phone.
   *  Long answers are cut at a sentence — nobody wants a table read to them. */
  function speakOut(text: string) {
    let clean = spokenText(text);
    if (clean.length > 600) {
      const cut = clean.slice(0, 600);
      const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
      clean = (end > 200 ? cut.slice(0, end + 1) : cut) + " …";
    }
    if (!clean) return;
    if (isTauri()) {
      void say({ ...settings, assistSpeak: true }, clean);
    } else if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(clean);
      u.lang = navigator.language;
      window.speechSynthesis.speak(u);
    }
  }

  /** What was said, in voice mode: a yes or no when it is waiting for one,
   *  otherwise a message like any other. */
  async function handleSpoken(text: string) {
    const said = text.trim().replace(/[.!?,…]+$/, "");
    spokeRef.current = true;
    const p = task?.status === "waiting" ? task.pending : undefined;
    if (p?.kind === "approve") {
      if (
        /^(yes|yeah|yep|ok(ay)?|sure|approve[d]?|do it|go ahead|ja|jawohl|klar|genau|mach (es|das)|passt)\b/i.test(said)
      ) {
        return answerTask(() => approveTask(p.id, true));
      }
      if (/^(no|nope|don'?t|stop|cancel|nein|nicht|lass (es|das)|abbrechen)\b/i.test(said)) {
        return answerTask(() => approveTask(p.id, false));
      }
    }
    if (p?.kind === "handover" && /^(done|finished|continue|ok|fertig|erledigt|weiter)\b/i.test(said)) {
      return answerTask(() => replyTask(p.id, "done"));
    }
    await send(text);
  }
  const [deletedSessions, setDeletedSessions] = useState<Record<string, number>>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(SESSIONS_DEL_KEY) || "null");
      if (v && typeof v === "object") return v;
    } catch {
      /* ignore */
    }
    return {};
  });
  const sessionsRef = useRef(sessions); // latest sessions for async saves
  const deletedRef = useRef(deletedSessions); // latest tombstones for async saves
  const loadedRef = useRef(false); // shared history loaded — safe to write back
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    deletedRef.current = deletedSessions;
  }, [deletedSessions]);

  async function addImages(jobs: (() => Promise<Attached>)[]) {
    setAttaching((n) => n + jobs.length);
    await Promise.all(
      jobs.map(async (job) => {
        try {
          const a = await job();
          setAttachments((prev) => [...prev, a]);
        } catch (e) {
          logError("chat.attach", e);
          toastError(String(e));
        } finally {
          setAttaching((n) => n - 1);
        }
      }),
    );
  }

  // Desktop drops arrive as real paths. Images are attached; any other file
  // goes into the message as its path, which the agent can open with its tools.
  function onDropPaths(paths: string[]) {
    const images = paths.filter(isImagePath);
    const others = paths.filter((p) => !isImagePath(p));
    if (images.length) void addImages(images.map((p) => () => attachPath(p)));
    if (others.length) setInput((prev) => (prev ? `${prev.trimEnd()} ${others.join(" ")}` : others.join(" ")));
  }
  // A phone has no paths to offer, only the files themselves.
  function onDropFiles(files: File[]) {
    const images = files.filter(isImageFile);
    if (images.length < files.length) toastError("Only images can be attached here.");
    if (images.length) void addImages(images.map((f) => () => attachFile(f)));
  }
  const dropHover = useFileDrop({
    target: viewRef,
    enabled: true,
    onPaths: onDropPaths,
    onFiles: onDropFiles,
  });

  function onPaste(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData.items)
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f && isImageFile(f));
    if (!files.length) return;
    e.preventDefault();
    void addImages(files.map((f) => () => attachFile(f)));
  }

  function onAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (isImageFile(file)) {
      void addImages([() => attachFile(file)]);
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result).slice(0, 60000);
      setInput((prev) => `${prev}\n\n[Attached: ${file.name}]\n\`\`\`\n${text}\n\`\`\`\n`.trimStart());
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  // Ensure a valid active session.
  useEffect(() => {
    if (!sessions.find((s) => s.id === activeId)) setActiveId(sessions[0].id);
  }, [sessions, activeId]);
  useEffect(() => {
    activeIdRef.current = activeId;
    // Persist + broadcast so cross-device "where you left off" can restore it.
    localStorage.setItem("ai-studio.chat.active", activeId);
    window.dispatchEvent(new Event("ai-studio-nav"));
  }, [activeId]);
  // A workspace sync from another device may pick a different active chat.
  useEffect(() => {
    const onWs = () => {
      const id = localStorage.getItem("ai-studio.chat.active");
      if (id && sessionsRef.current.find((s) => s.id === id)) setActiveId(id);
    };
    window.addEventListener("ai-studio-ws", onWs);
    return () => window.removeEventListener("ai-studio-ws", onWs);
  }, []);

  const provider = useMemo(() => resolveTextProvider(settings), [settings]);
  const { models: orModels, refresh: refreshOR } = useOpenrouterModels(settings.openrouterKey);
  const directModels = useDirectModels(settings);
  const active = sessions.find((s) => s.id === activeId) || sessions[0];
  const messages = active?.messages ?? [];

  async function refreshOllama() {
    try {
      setOllamaModels(await listOllamaModels(settings.ollamaUrl));
    } catch {
      setOllamaModels([]);
    }
  }
  useEffect(() => {
    refreshOllama();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Adopt the merged union (from store_merge_list) into local session state.
  function adoptSessions(raw: string) {
    const { items, deleted } = parseSyncList<Session>(raw);
    if (!items.length) return;
    setDeletedSessions(deleted);
    setSessions(items);
    if (!items.find((s) => s.id === activeIdRef.current)) setActiveId(items[0].id);
  }

  // Push this device's chat history and adopt the merged union back. A conflict-free
  // merge (last-writer-wins by updatedAt + tombstones) so concurrent desktop/phone
  // chats don't clobber each other. Used for the initial load and manual Sync.
  async function syncSessions() {
    try {
      const merged = await remoteStoreMerge(
        SESSIONS_KEY,
        JSON.stringify({
          items: sessionsRef.current,
          deleted: deletedRef.current,
        }),
      );
      adoptSessions(merged);
    } catch (e) {
      // Offline or no server — local work continues and the next sync reconciles.
      logError("chats.sync", e);
    }
  }

  // Load + merge the shared chat history once on mount.
  useEffect(() => {
    let cancelled = false;
    syncSessions().finally(() => {
      if (!cancelled) loadedRef.current = true;
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Register as a sync source: every syncAll() (on connect, or when the user taps
  // Sync) pulls the shared chat history and WAITS for it, so the workspace
  // pointer is only adopted once the sessions it refers to actually exist.
  useEffect(() => registerSyncSource("chats", syncSessions), []);

  useEffect(() => {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    localStorage.setItem(SESSIONS_DEL_KEY, JSON.stringify(deletedSessions));
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    // Mirror to the shared store as a MERGE (not overwrite), debounced so streaming
    // doesn't hammer the file.
    if (!loadedRef.current) return;
    const t = setTimeout(() => {
      remoteStoreMerge(
        SESSIONS_KEY,
        JSON.stringify({
          items: sessionsRef.current,
          deleted: deletedRef.current,
        }),
      ).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [sessions, activeId, deletedSessions]);

  // Update the ACTIVE session's messages (targets whatever is active now).
  function setMessages(updater: Msg[] | ((prev: Msg[]) => Msg[])) {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeIdRef.current) return s;
        const msgs = typeof updater === "function" ? (updater as any)(s.messages) : updater;
        let title = s.title;
        if (title === "New chat") {
          const firstUser = msgs.find((m: Msg) => m.role === "user");
          if (firstUser) title = (firstUser.content || firstUser.images?.[0]?.name || "Image").slice(0, 40);
        }
        return { ...s, messages: msgs, title, updatedAt: Date.now() };
      }),
    );
  }

  function newChat() {
    const s = newSession();
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
  }
  function switchChat(id: string) {
    setActiveId(id);
  }
  function deleteChat(id: string) {
    const taskId = sessionsRef.current.find((s) => s.id === id)?.taskId;
    if (taskId) void deleteTask(taskId).catch(() => {});
    setDeletedSessions((prev) => ({ ...prev, [id]: Date.now() }));
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      return next.length ? next : [newSession()];
    });
  }
  function renameChat(id: string, title: string) {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title, updatedAt: Date.now() } : s)));
  }

  /** Session the overlay's questions are filed under. */
  const ASSIST_TITLE = "Screen Assist";

  // Exchanges from the overlay land here rather than in a store of their own,
  // which is what gives them history, search and cross-device sync for free.
  // The main window is the single writer of sessions — both windows share a
  // localStorage, so letting the overlay write directly would race this one.
  useEffect(() => {
    const un = listen<{
      question: string;
      answer: string;
      sawScreen: boolean;
      focus: boolean;
    }>("screen-assist://exchange", (e) => {
      const { question, answer, sawScreen, focus } = e.payload ?? ({} as never);
      if (!question && !answer) return;
      const user: Msg = {
        role: "user",
        content: sawScreen ? `${question}\n\n_(asked about my screen)_` : question,
        reasoning: "",
      };
      const reply: Msg = { role: "assistant", content: answer, reasoning: "" };

      setSessions((prev) => {
        const existing = prev.find((x) => x.title === ASSIST_TITLE);
        if (existing) {
          const updated = {
            ...existing,
            messages: [...existing.messages, user, reply],
            updatedAt: Date.now(),
          };
          if (focus) setActiveId(updated.id);
          return [updated, ...prev.filter((x) => x.id !== existing.id)];
        }
        const fresh: Session = {
          id: crypto.randomUUID(),
          title: ASSIST_TITLE,
          messages: [user, reply],
          updatedAt: Date.now(),
        };
        if (focus) setActiveId(fresh.id);
        return [fresh, ...prev];
      });
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // The key of the provider the model actually uses, checked only on the Mac:
  // a phone never holds keys, and the Mac supplies them per request.
  const canSend = !!provider.model && !(isTauri() && settings.provider === "openrouter" && !provider.apiKey);

  /** The conversation so far as plain text: what was said before it became a
   *  task, then the task's own messages and replies. */
  function plainHistory(list: Msg[]): { role: "user" | "assistant"; content: string }[] {
    const early = list
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
    const later = (task?.steps ?? [])
      .filter((s) => (s.kind === "user" || s.kind === "reply") && s.title.trim())
      .map((s) => ({
        role: (s.kind === "user" ? "user" : "assistant") as "user" | "assistant",
        content: s.title,
      }));
    return [...early, ...later];
  }

  const taskLive = !!task && isLive(task.status);

  /** Fetch the active task now, rather than at the next poll. */
  async function pokeTask(id = active?.taskId) {
    if (!id) return;
    try {
      const t = await getTask(id);
      if (t && activeIdRef.current === active?.id) setTask(t);
    } catch (e) {
      logError("chat.task", e);
    }
  }

  async function answerTask(fn: () => Promise<void>) {
    try {
      await fn();
      void pokeTask();
    } catch (e) {
      toastError(String(e));
    }
  }

  /** Agent mode: the message goes to the Mac, which does the work. */
  async function sendToAgent(
    text: string,
    images: Attached[],
    history?: { role: "user" | "assistant"; content: string }[],
  ) {
    const session = active;
    if (!session) return;
    try {
      if (session.taskId && !history) {
        try {
          await sendToTask(session.taskId, text, images, provider.baseUrl, provider.model);
          void pokeTask(session.taskId);
          return;
        } catch (e) {
          // The chat points at a task the Mac no longer has. Rather than a
          // chat that answers every message with "no such task", start it
          // afresh below, carrying the conversation on as context.
          if (!/no such task/i.test(String(e))) throw e;
          logError("chat.task.missing", e);
        }
      }
      // The recent part only: a long chat (Screen Assist collects hundreds of
      // exchanges) would otherwise go to the model in full with every step.
      const context = (history ?? plainHistory(session.messages)).slice(-40);
      const t = await startTask(text, images, provider.baseUrl, provider.model, context);
      // Speak this one's replies even though it is new: it was just asked.
      spokenRef.current[t.id] = { steps: t.steps.length, pending: "" };
      setTask(t);
      setSessions((prev) =>
        prev.map((x) =>
          x.id === session.id
            ? {
                ...x,
                taskId: t.id,
                title: x.title === "New chat" ? (text || images[0]?.name || "Image").slice(0, 40) : x.title,
                updatedAt: Date.now(),
              }
            : x,
        ),
      );
    } catch (e) {
      toastError(String(e));
    }
  }

  async function send(override?: string) {
    const text = (override ?? input).trim();
    const images = attachments;
    if ((!text && !images.length) || attaching) return;
    if (!canSend) {
      onOpenSettings();
      return;
    }
    if (override === undefined) {
      setInput("");
      spokeRef.current = false; // typed: answer in text only
    }
    setAttachments([]);
    await sendToAgent(text, images);
  }

  function stopGen() {
    if (taskLive && task) void answerTask(() => stopTask(task.id));
  }

  // Edit a prior user message and resend: truncate everything from that message
  // onward, then regenerate from the edited text (like ChatGPT).
  function startEdit(i: number) {
    setEditingIndex(i);
    setEditText(messages[i].content);
  }
  function cancelEdit() {
    setEditingIndex(null);
    setEditText("");
  }
  async function resendEdit(i: number) {
    const text = editText.trim();
    // Editing changes the words; the images the message was sent with stay.
    const images = messages[i].images;
    if (!text && !images?.length) return;
    if (!canSend) {
      onOpenSettings();
      return;
    }
    const prior = messages.slice(0, i);
    setMessages([
      ...prior,
      {
        role: "user",
        content: text,
        reasoning: "",
        ...(images?.length ? { images } : {}),
      },
    ]);
    setEditingIndex(null);
    setEditText("");
    // Starts the conversation over from the edited message, as a new task.
    await sendToAgent(text, images ?? [], plainHistory(prior).filter((_, k) => k < prior.length));
  }

  // Follow the active chat's task: often while it works, rarely after. On the
  // Mac a change event makes it immediate; the phone relies on the poll.
  const activeTaskId = active?.taskId ?? "";
  useEffect(() => {
    if (!activeTaskId) {
      setTask(null);
      return;
    }
    if (taskRef.current?.id !== activeTaskId) setTask(null);
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const current = taskRef.current?.id === activeTaskId ? taskRef.current : null;
        const next = await getTask(activeTaskId, current?.rev);
        if (stop) return;
        if (next) setTask(next);
        const t = next ?? current;
        timer = setTimeout(tick, t && isLive(t.status) ? 1000 : 6000);
      } catch (e) {
        logError("chat.task", e);
        // Gone for good: stop asking. The next message starts a new task.
        if (/no such task/i.test(String(e))) {
          setTask(null);
          return;
        }
        if (!stop) timer = setTimeout(tick, 4000);
      }
    };
    void tick();
    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      void listen<{ id: string }>("task://changed", (e) => {
        if (e.payload?.id === activeTaskId) {
          clearTimeout(timer);
          void tick();
        }
      }).then((f) => (stop ? f() : (unlisten = f)));
    }
    return () => {
      stop = true;
      clearTimeout(timer);
      unlisten?.();
    };
  }, [activeTaskId]);

  // Keep the newest step in view as a task works.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [task?.steps.length, task?.pending?.id]);

  // Voice mode: read out replies and whatever it is waiting on, once each.
  useEffect(() => {
    if (!task) return;
    const seen = spokenRef.current[task.id];
    if (!seen) {
      // Opening a chat is not the moment to hear its whole history.
      spokenRef.current[task.id] = {
        steps: task.steps.length,
        pending: task.pending?.id ?? "",
      };
      return;
    }
    if (spokeRef.current) {
      for (const s of task.steps.slice(seen.steps)) if (s.kind === "reply") speakOut(s.title);
      const p = task.status === "waiting" ? task.pending : undefined;
      if (p && p.id !== seen.pending) {
        speakOut(
          p.kind === "approve"
            ? `${p.title} Say yes or no.`
            : p.kind === "handover"
              ? `Your turn in the browser. ${p.body}`
              : p.title,
        );
      }
    }
    seen.steps = task.steps.length;
    seen.pending = task.pending?.id ?? "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  return (
    <div className="chat-layout">
      <SidebarSlot slot={sidebarSlot}>
        <SidebarList
          items={sessions}
          activeId={activeId}
          onSelect={switchChat}
          onNew={newChat}
          onDelete={deleteChat}
          onRename={renameChat}
          newLabel="+ New chat"
          onAfterAction={onCloseDrawer}
        />
      </SidebarSlot>

      <div className={dropHover ? "chat-view drop-hover" : "chat-view"} ref={viewRef}>
        <div className="chat-scroll" ref={scrollRef}>
          {messages.length === 0 && !task && (
            <div className="chat-empty">
              Ask anything, or tell me what to do.
              <br />
              I work on this Mac — in a browser, the terminal and your files — and keep going if you close
              this window. I ask before paying, booking, sending or deleting anything.
            </div>
          )}
          {messages.map((m, i) => {
            if (m.role === "tool") {
              const icon = m.ok === false ? "✗" : "✓";
              if (m.detail && m.detail.trim()) {
                return (
                  <details key={i} className={`tool-line has-detail ${m.ok === false ? "err" : ""}`}>
                    <summary>
                      <span className="tool-icon">{icon}</span> {m.content}
                    </summary>
                    <pre className="tool-detail">{m.detail}</pre>
                  </details>
                );
              }
              return (
                <div key={i} className={`tool-line ${m.ok === false ? "err" : ""}`}>
                  <span className="tool-icon">{icon}</span> {m.content}
                </div>
              );
            }
            const { think, answer } = splitThink(m.content);
            const thinking = (m.reasoning + (think ? "\n" + think : "")).trim();
            const isAssistant = m.role === "assistant";
            const editing = editingIndex === i;
            return (
              <div key={i} className={`msg ${m.role}`}>
                <div className="msg-head">
                  <div className="msg-role">{m.role === "user" ? "You" : "AI Box"}</div>
                  {!editing && m.role === "user" && !active?.taskId && (
                    <button className="msg-copy" title="Edit & resend" onClick={() => startEdit(i)}>
                      Edit
                    </button>
                  )}
                  {!editing && answer && (
                    <button
                      className="msg-copy"
                      title="Copy message"
                      onClick={() => navigator.clipboard.writeText(answer)}
                    >
                      Copy
                    </button>
                  )}
                </div>
                {thinking && (
                  <details className="thinking">
                    <summary>Thinking</summary>
                    <div className="thinking-body">{thinking}</div>
                  </details>
                )}
                {m.images?.length ? (
                  <div className="msg-images">
                    {m.images.map((a) => (
                      <AttachmentThumb key={a.id} a={a} />
                    ))}
                  </div>
                ) : null}
                {editing ? (
                  <div className="msg-edit">
                    <textarea
                      className="msg-edit-input"
                      value={editText}
                      autoFocus
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          resendEdit(i);
                        } else if (e.key === "Escape") {
                          cancelEdit();
                        }
                      }}
                    />
                    <div className="msg-edit-actions">
                      <button className="btn ghost" onClick={cancelEdit}>
                        Cancel
                      </button>
                      <button className="btn primary" onClick={() => resendEdit(i)}>
                        Save &amp; send
                      </button>
                    </div>
                  </div>
                ) : answer || isAssistant ? (
                  <div className="msg-body">
                    {answer ? (
                      isAssistant ? (
                        <Markdown>{answer}</Markdown>
                      ) : (
                        answer
                      )
                    ) : isAssistant && !thinking ? (
                      "…"
                    ) : (
                      ""
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
          {task && (
            <TaskThread
              task={task}
              onApprove={(id, ok) => void answerTask(() => approveTask(id, ok))}
              onReply={(id, text) => void answerTask(() => replyTask(id, text))}
              renderImages={(imgs) => (
                <div className="msg-images">
                  {imgs.map((a) => (
                    <AttachmentThumb key={a.id} a={a} />
                  ))}
                </div>
              )}
            />
          )}
        </div>

        <div className="promptbar-wrap">
          {toolsOpen && (
            <div className="prompt-tools">
              <ModelSelect
                settings={settings}
                ollamaModels={ollamaModels}
                orModels={orModels}
                directModels={directModels.models}
                directLoading={directModels.loading}
                directError={directModels.error}
                onChange={onChange}
                onRefresh={() => {
                  refreshOR();
                  refreshOllama();
                }}
              />
            </div>
          )}
          <div className="composer">
            {(attachments.length > 0 || attaching > 0) && (
              <div className="attach-strip">
                {attachments.map((a) => (
                  <AttachmentThumb
                    key={a.id}
                    a={a}
                    onRemove={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  />
                ))}
                {Array.from({ length: attaching }, (_, k) => (
                  <div key={`pending-${k}`} className="attach-thumb pending">
                    <span>…</span>
                  </div>
                ))}
              </div>
            )}
            <input
              type="file"
              ref={fileRef}
              hidden
              accept="image/*,.heic,.txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.rs,.html,.css,.csv,.yml,.yaml,.toml"
              onChange={onAttach}
            />
            <textarea
              ref={inputRef}
              className="composer-input"
              rows={1}
              placeholder={
                task?.status === "waiting"
                  ? "Answer, or say what to do instead…"
                  : taskLive
                    ? "Working… you can tell it more"
                    : "What should I do?"
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={onPaste}
              onKeyDown={(e) => {
                // On a phone, Return is for new lines and the arrow sends —
                // the keyboard has no Shift+Return to fall back on.
                if (e.key === "Enter" && !e.shiftKey && !touchKeyboard) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-row">
              <button
                className="btn ghost attach-btn"
                title="Attach an image or a text file (you can also drop or paste images)"
                onClick={() => fileRef.current?.click()}
              >
                📎
              </button>
              {canTranscribe && (
                <button
                  className={listening ? "btn ghost attach-btn dictating" : "btn ghost attach-btn"}
                  title={
                    listening
                      ? "Stop and transcribe"
                      : transcribing
                        ? "Transcribing…"
                        : "Speak — sent when you tap again, and the answer is read aloud"
                  }
                  onClick={() => {
                    unlockSpeech();
                    void toggleDictation();
                  }}
                  disabled={transcribing}
                >
                  {transcribing ? (
                    "…"
                  ) : (
                    /* The same mic the overlay draws, so dictation looks like one
                     feature in two places rather than two features. */
                    <svg
                      viewBox="0 0 24 24"
                      width="17"
                      height="17"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                    >
                      <rect x="9" y="2" width="6" height="12" rx="3" />
                      <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
                    </svg>
                  )}
                </button>
              )}
              <button
                className={toolsOpen ? "composer-chip open" : "composer-chip"}
                onClick={() => setToolsOpen((v) => !v)}
                aria-expanded={toolsOpen}
                title="Model"
              >
                {shortModel(provider.model)} {toolsOpen ? "▴" : "▾"}
              </button>
              <span className="composer-spacer" />
              {taskLive && (
                <button className="btn stop promptbar-send" onClick={stopGen} title="Stop">
                  ■
                </button>
              )}
              {(!taskLive || input.trim() || attachments.length > 0) && (
                <button
                  className="btn primary promptbar-send"
                  onClick={() => void send()}
                  disabled={attaching > 0 || (!input.trim() && !attachments.length)}
                  title={attaching > 0 ? "Preparing images…" : "Send"}
                >
                  →
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

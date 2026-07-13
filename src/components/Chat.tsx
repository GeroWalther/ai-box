import { useEffect, useMemo, useRef, useState } from "react";
import { generateText, listOllamaModels } from "../lib/api";
import {
  AGENT_TOOLS,
  chatCompletion,
  fsDelete,
  fsEdit,
  fsList,
  fsMove,
  fsRead,
  fsSearch,
  fsWrite,
  runCommandStream,
  webFetch,
} from "../lib/agent";
import { resolveTextProvider, type Settings } from "../lib/settings";
import { isTauri } from "../lib/transport";
import { remoteStoreGet, remoteStoreSet } from "../lib/remoteStore";
import { useOpenrouterModels } from "../lib/openrouterModels";
import { useToast } from "../lib/toast";
import ModelManager from "./ModelManager";
import ModelSelect from "./ModelSelect";
import Markdown from "./Markdown";
import SidebarList, { SidebarSlot } from "./SidebarList";

interface Msg {
  role: "user" | "assistant" | "tool";
  content: string;
  reasoning: string;
  detail?: string; // tool: expandable output/diff
  ok?: boolean; // tool: success/failure for the status icon
}
interface Session {
  id: string;
  title: string;
  messages: Msg[];
}

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onOpenSettings: () => void;
  onInsertManuscript?: (text: string) => void;
  /** DOM node in App's unified sidebar where this tab's chat list is portaled. */
  sidebarSlot: HTMLElement | null;
  onCloseDrawer?: () => void;
}

const SESSIONS_KEY = "ai-studio.sessions";

const AGENT_SYSTEM =
  "You are AI Studio, an agentic coworker running on the user's Mac (macOS, Apple Silicon). " +
  "You CAN and SHOULD use your tools to actually do the work, not just describe it. " +
  "Tools: read_file, write_file, edit_file (targeted unique-match replace — prefer for small changes), " +
  "list_dir, search_files (grep/find), move_file, delete_file, run_command (shell), and web_fetch. " +
  "Explore with search_files/list_dir/read_file before editing. Prefer edit_file over rewriting whole files. " +
  "Prefer absolute paths (the Desktop is ~/Desktop). Take actions with the tools first, then briefly summarize what you did.";

const CHAT_SYSTEM =
  "You are AI Studio, a capable, friendly assistant. Help with coding, writing, analysis, and general questions. Write correct, well-explained code. Be clear and concise.";

function splitThink(raw: string): { think: string; answer: string } {
  if (!raw.includes("<think>")) return { think: "", answer: raw };
  const m = raw.match(/<think>([\s\S]*?)(?:<\/think>|$)/);
  const think = m ? m[1] : "";
  const answer = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/, "").trim();
  return { think, answer };
}
function safeParse(s: string): any {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}
function newSession(): Session {
  return { id: crypto.randomUUID(), title: "New chat", messages: [] };
}

export default function Chat({ settings, onChange, onOpenSettings, onInsertManuscript, sidebarSlot, onCloseDrawer }: Props) {
  const { error: toastError } = useToast();
  const [sessions, setSessions] = useState<Session[]>(() => {
    try {
      const s = JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]");
      return Array.isArray(s) && s.length ? s : [newSession()];
    } catch {
      return [newSession()];
    }
  });
  const [activeId, setActiveId] = useState<string>(() => "");
  const [input, setInput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [showModels, setShowModels] = useState(false);
  const [pending, setPending] = useState<{
    title: string;
    body: string;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const allowAllRef = useRef(false); // "always allow this session"
  const genIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef("");
  const fileRef = useRef<HTMLInputElement>(null);
  const sessionsRef = useRef(sessions); // latest sessions for async saves
  const loadedRef = useRef(false); // shared history loaded — safe to write back
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  function onAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
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
  }, [activeId]);

  const provider = useMemo(() => resolveTextProvider(settings), [settings]);
  const {
    models: orModels,
    refresh: refreshOR,
    loading: orLoading,
  } = useOpenrouterModels(settings.openrouterKey);
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

  // Load the shared chat history (same on desktop + phone) once on mount. If the
  // shared store is empty, seed it from whatever this device already has locally.
  useEffect(() => {
    let cancelled = false;
    remoteStoreGet(SESSIONS_KEY)
      .then((raw) => {
        if (cancelled) return;
        if (raw) {
          try {
            const s = JSON.parse(raw);
            if (Array.isArray(s) && s.length) setSessions(s);
          } catch {
            /* ignore corrupt payload */
          }
        } else {
          remoteStoreSet(SESSIONS_KEY, JSON.stringify(sessionsRef.current)).catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) loadedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-pull shared chat history when the user taps Sync (in the nav rail).
  useEffect(() => {
    function onSync() {
      remoteStoreGet(SESSIONS_KEY)
        .then((raw) => {
          if (!raw) return;
          try {
            const s = JSON.parse(raw);
            if (Array.isArray(s) && s.length) setSessions(s);
          } catch {
            /* ignore */
          }
        })
        .catch(() => {});
    }
    window.addEventListener("ai-studio-sync", onSync);
    return () => window.removeEventListener("ai-studio-sync", onSync);
  }, []);

  useEffect(() => {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    // Mirror to the shared store, debounced so streaming doesn't hammer the file.
    if (!loadedRef.current) return;
    const t = setTimeout(() => {
      remoteStoreSet(SESSIONS_KEY, JSON.stringify(sessionsRef.current)).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [sessions, activeId]);

  // Update the ACTIVE session's messages (targets whatever is active now).
  function setMessages(updater: Msg[] | ((prev: Msg[]) => Msg[])) {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeIdRef.current) return s;
        const msgs = typeof updater === "function" ? (updater as any)(s.messages) : updater;
        let title = s.title;
        if (title === "New chat") {
          const firstUser = msgs.find((m: Msg) => m.role === "user");
          if (firstUser) title = firstUser.content.slice(0, 40);
        }
        return { ...s, messages: msgs, title };
      })
    );
  }
  const pushMsg = (m: Msg) => setMessages((prev) => [...prev, m]);
  const patchLast = (fn: (m: Msg) => Msg) =>
    setMessages((prev) => {
      const c = [...prev];
      c[c.length - 1] = fn(c[c.length - 1]);
      return c;
    });

  function newChat() {
    genIdRef.current++;
    setGenerating(false);
    const s = newSession();
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
  }
  function switchChat(id: string) {
    genIdRef.current++;
    setGenerating(false);
    setActiveId(id);
  }
  function deleteChat(id: string) {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      return next.length ? next : [newSession()];
    });
  }

  const canSend =
    !!provider.model &&
    !(settings.provider === "openrouter" && !settings.openrouterKey);

  function historyMessages(): { role: "user" | "assistant"; content: string }[] {
    return messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  }

  async function send() {
    const text = input.trim();
    if (!text || generating) return;
    if (!canSend) {
      onOpenSettings();
      return;
    }
    setInput("");
    setGenerating(true);
    const myGen = ++genIdRef.current;
    const history = historyMessages();
    pushMsg({ role: "user", content: text, reasoning: "" });
    if (agentMode) await runAgent(text, history, myGen);
    else await runStream(text, history, myGen);
    if (genIdRef.current === myGen) setGenerating(false);
  }

  function stopGen() {
    genIdRef.current++;
    setGenerating(false);
    if (pending) {
      pending.resolve(false);
      setPending(null);
    }
  }

  async function runStream(
    text: string,
    history: { role: "user" | "assistant"; content: string }[],
    myGen: number
  ) {
    const apiMessages = [
      { role: "system" as const, content: CHAT_SYSTEM },
      ...history,
      { role: "user" as const, content: text },
    ];
    pushMsg({ role: "assistant", content: "", reasoning: "" });
    const live = () => genIdRef.current === myGen;
    await generateText(
      {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.model,
        messages: apiMessages,
        temperature: 0.7,
        maxTokens: 1500,
      },
      {
        onToken: (t) => {
          if (live()) patchLast((m) => ({ ...m, content: m.content + t }));
        },
        onReasoning: (t) => {
          if (live()) patchLast((m) => ({ ...m, reasoning: m.reasoning + t }));
        },
        onDone: () => {},
        onError: (msg) => {
          if (live()) patchLast((m) => ({ ...m, content: m.content + `\n\n[error] ${msg}` }));
        },
      }
    );
  }

  async function runAgent(
    text: string,
    history: { role: string; content: string }[],
    myGen: number
  ) {
    const convo: any[] = [
      { role: "system", content: AGENT_SYSTEM },
      ...history,
      { role: "user", content: text },
    ];
    for (let step = 0; step < 16; step++) {
      if (genIdRef.current !== myGen) return;
      let msg: any;
      try {
        msg = await chatCompletion({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.model,
          messages: convo,
          tools: AGENT_TOOLS,
          temperature: 0.3,
        });
      } catch (e) {
        toastError(String(e));
        pushMsg({ role: "assistant", content: `[error] ${String(e)}`, reasoning: "" });
        return;
      }
      if (genIdRef.current !== myGen) return;
      convo.push(msg);
      if (msg.content) pushMsg({ role: "assistant", content: msg.content, reasoning: "" });

      const calls = msg.tool_calls || [];
      if (!calls.length) return;

      for (const tc of calls) {
        if (genIdRef.current !== myGen) return;
        const name = tc.function?.name;
        const args = safeParse(tc.function?.arguments);
        let label = name as string;
        let detail = "";
        let ok = true;
        let result: any;

        // run_command streams into its own live tool line.
        if (name === "run_command") {
          const approved = await requestApproval("Run this command?", args.command);
          if (!approved) {
            pushMsg({ role: "tool", content: `Denied: ${args.command}`, reasoning: "", ok: false });
            convo.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ denied: true }) });
            continue;
          }
          pushMsg({ role: "tool", content: `$ ${args.command}`, reasoning: "", detail: "", ok: true });
          try {
            const out = await runCommandStream(args.command, (line) =>
              patchLast((m) => ({ ...m, detail: (m.detail || "") + line + "\n" }))
            );
            patchLast((m) => ({
              ...m,
              content: `$ ${args.command}  (exit ${out.code})`,
              ok: out.code === 0,
            }));
            convo.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(out).slice(0, 12000) });
          } catch (e) {
            patchLast((m) => ({ ...m, content: `$ ${args.command}  (failed)`, ok: false, detail: (m.detail || "") + String(e) }));
            convo.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: String(e) }) });
          }
          continue;
        }

        try {
          if (name === "read_file") {
            const content = await fsRead(args.path);
            label = `Read ${args.path}`;
            detail = content;
            result = { content };
          } else if (name === "write_file") {
            const msg = await fsWrite(args.path, args.content ?? "");
            label = `Wrote ${args.path}`;
            detail = args.content ?? "";
            result = { message: msg };
          } else if (name === "edit_file") {
            const r = await fsEdit(args.path, args.old ?? "", args.new ?? "");
            label = `Edited ${args.path}`;
            detail = r.diff;
            result = r;
          } else if (name === "list_dir") {
            const entries = await fsList(args.path);
            label = `Listed ${args.path} (${entries.length})`;
            detail = entries.join("\n");
            result = { entries };
          } else if (name === "search_files") {
            const hits = await fsSearch(args.root, args.query, args.kind);
            label = `Searched "${args.query}" — ${hits.length} hit(s)`;
            detail = hits.join("\n");
            result = { matches: hits };
          } else if (name === "web_fetch") {
            const text = await webFetch(args.url);
            label = `Fetched ${args.url}`;
            detail = text.slice(0, 2000);
            result = { text };
          } else if (name === "write_story") {
            const text = args.text ?? "";
            onInsertManuscript?.(text);
            label = `Wrote ${text.split(/\s+/).filter(Boolean).length} words to the manuscript`;
            detail = text.slice(0, 2000);
            result = { message: "Appended to the Write tab manuscript." };
          } else if (name === "move_file") {
            const approved = await requestApproval("Move a file?", `${args.from}\n→ ${args.to}`);
            if (!approved) {
              ok = false;
              label = `Denied move: ${args.from}`;
              result = { denied: true };
            } else {
              const m = await fsMove(args.from, args.to);
              label = m;
              result = { message: m };
            }
          } else if (name === "delete_file") {
            const approved = await requestApproval("Delete this path?", args.path);
            if (!approved) {
              ok = false;
              label = `Denied delete: ${args.path}`;
              result = { denied: true };
            } else {
              const m = await fsDelete(args.path);
              label = m;
              result = { message: m };
            }
          } else {
            ok = false;
            result = { error: `unknown tool ${name}` };
          }
        } catch (e) {
          ok = false;
          result = { error: String(e) };
          label = `Error — ${name}: ${String(e)}`;
        }
        pushMsg({ role: "tool", content: label, reasoning: "", detail, ok });
        convo.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result).slice(0, 12000),
        });
      }
    }
    pushMsg({ role: "assistant", content: "(stopped after 16 steps)", reasoning: "" });
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
    if (!text || generating) return;
    if (!canSend) {
      onOpenSettings();
      return;
    }
    const prior = messages.slice(0, i);
    const history = prior
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    setMessages([...prior, { role: "user", content: text, reasoning: "" }]);
    setEditingIndex(null);
    setEditText("");
    setGenerating(true);
    const myGen = ++genIdRef.current;
    if (agentMode) await runAgent(text, history, myGen);
    else await runStream(text, history, myGen);
    if (genIdRef.current === myGen) setGenerating(false);
  }

  function requestApproval(title: string, body: string): Promise<boolean> {
    // Over the network (phone), approval happens ON THE MAC via the server bridge,
    // so we don't prompt again here — the desktop enforces it once.
    if (!isTauri()) return Promise.resolve(true);
    if (allowAllRef.current) return Promise.resolve(true);
    return new Promise((resolve) => setPending({ title, body, resolve }));
  }
  function answerApproval(ok: boolean, always = false) {
    if (always && ok) allowAllRef.current = true;
    pending?.resolve(ok);
    setPending(null);
  }

  return (
    <div className="chat-layout">
      <SidebarSlot slot={sidebarSlot}>
        <SidebarList
          items={sessions}
          activeId={activeId}
          onSelect={switchChat}
          onNew={newChat}
          onDelete={deleteChat}
          newLabel="+ New chat"
          onAfterAction={onCloseDrawer}
        />
      </SidebarSlot>

      <div className="chat-view">
        <div className="chat-bar">
          <ModelSelect
            settings={settings}
            ollamaModels={ollamaModels}
            orModels={orModels}
            onChange={onChange}
            onRefresh={refreshOR}
            loading={orLoading}
            onManageModels={() => setShowModels(true)}
          />
          <label className="agent-toggle" title="Let the AI read/write files and run commands">
            <input
              type="checkbox"
              checked={agentMode}
              onChange={(e) => setAgentMode(e.target.checked)}
            />
            Agent
          </label>
        </div>

        <div className="chat-scroll" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="chat-empty">
              Ask anything — code, writing, reasoning, questions.
              <br />
              Turn on <b>Agent</b> to let it read/write files and run commands on your Mac.
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
                  <div className="msg-role">{m.role === "user" ? "You" : "AI Studio"}</div>
                  {!editing && m.role === "user" && !generating && (
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
                  <details className="thinking" open={generating && i === messages.length - 1}>
                    <summary>Thinking</summary>
                    <div className="thinking-body">{thinking}</div>
                  </details>
                )}
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
                ) : (
                  <div className="msg-body">
                    {answer ? (
                      isAssistant ? <Markdown>{answer}</Markdown> : answer
                    ) : (
                      isAssistant && !thinking ? "…" : ""
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {generating &&
            (messages.length === 0 ||
              messages[messages.length - 1].role !== "assistant" ||
              messages[messages.length - 1].content === "") && (
              <div className="msg assistant">
                <div className="msg-role">AI Studio</div>
                <div className="typing">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            )}
        </div>

        <div className="promptbar-wrap">
          <div className="promptbar">
            <input
              type="file"
              ref={fileRef}
              hidden
              accept=".txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.rs,.html,.css,.csv,.yml,.yaml,.toml"
              onChange={onAttach}
            />
            <button
              className="btn ghost attach-btn"
              title="Attach a text file as context"
              onClick={() => fileRef.current?.click()}
            >
              📎
            </button>
            <textarea
              className="promptbar-input"
              rows={1}
              placeholder={
                agentMode
                  ? "Ask the agent to build, edit files, install, run things…"
                  : "Message AI Studio…  (Enter to send, Shift+Enter for newline)"
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!generating) send();
                }
              }}
            />
            <button
              className={generating ? "btn stop promptbar-send" : "btn primary promptbar-send"}
              onClick={generating ? stopGen : send}
            >
              {generating ? "■" : "→"}
            </button>
          </div>
        </div>
      </div>

      {showModels && (
        <ModelManager
          settings={settings}
          installed={ollamaModels}
          onClose={() => setShowModels(false)}
          onChanged={refreshOllama}
        />
      )}

      {pending && (
        <div className="modal-backdrop">
          <div className="modal approve">
            <div className="modal-head">
              <h2>{pending.title}</h2>
            </div>
            <div className="modal-body">
              <p className="hint">The agent wants to take this action on your Mac:</p>
              <pre className="cmd-preview">{pending.body}</pre>
            </div>
            <div className="modal-foot approve-foot">
              <button className="btn ghost" onClick={() => answerApproval(true, true)}>
                Always allow this session
              </button>
              <div className="approve-foot-right">
                <button className="btn" onClick={() => answerApproval(false)}>
                  Deny
                </button>
                <button className="btn primary" onClick={() => answerApproval(true)}>
                  Approve
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

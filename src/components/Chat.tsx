import { useEffect, useMemo, useRef, useState } from "react";
import { generateText, listOllamaModels } from "../lib/api";
import {
  AGENT_TOOLS,
  chatCompletion,
  fsList,
  fsRead,
  fsWrite,
  runCommand,
} from "../lib/agent";
import { resolveTextProvider, type Settings } from "../lib/settings";
import { useOpenrouterModels } from "../lib/openrouterModels";
import ModelManager from "./ModelManager";
import ModelSelect from "./ModelSelect";

interface Msg {
  role: "user" | "assistant" | "tool";
  content: string;
  reasoning: string;
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
}

const SESSIONS_KEY = "ai-studio.sessions";

const AGENT_SYSTEM =
  "You are AI Studio, an agentic assistant running on the user's Mac (macOS, Apple Silicon). " +
  "You CAN and SHOULD use your tools to actually do the work, not just describe it. " +
  "When asked to create/edit files or run things, call write_file / read_file / list_dir / run_command directly. " +
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

export default function Chat({ settings, onChange, onOpenSettings }: Props) {
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
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [showModels, setShowModels] = useState(false);
  const [pendingCmd, setPendingCmd] = useState<{
    command: string;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const genIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef("");

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

  useEffect(() => {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
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
    if (pendingCmd) {
      pendingCmd.resolve(false);
      setPendingCmd(null);
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
        let label = name;
        let result: any;
        try {
          if (name === "read_file") {
            label = `read ${args.path}`;
            result = { content: await fsRead(args.path) };
          } else if (name === "write_file") {
            label = `write ${args.path}`;
            result = { message: await fsWrite(args.path, args.content ?? "") };
          } else if (name === "list_dir") {
            label = `list ${args.path}`;
            result = { entries: await fsList(args.path) };
          } else if (name === "run_command") {
            const ok = await requestApproval(args.command);
            if (!ok) {
              result = { denied: true, message: "User denied this command." };
              label = `denied: ${args.command}`;
            } else {
              const out = await runCommand(args.command);
              result = out;
              label = `run: ${args.command}  (exit ${out.code})`;
            }
          } else {
            result = { error: `unknown tool ${name}` };
          }
        } catch (e) {
          result = { error: String(e) };
          label = `error — ${name}: ${String(e)}`;
        }
        pushMsg({ role: "tool", content: label, reasoning: "" });
        convo.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result).slice(0, 12000),
        });
      }
    }
    pushMsg({ role: "assistant", content: "(stopped after 16 steps)", reasoning: "" });
  }

  function requestApproval(command: string): Promise<boolean> {
    return new Promise((resolve) => setPendingCmd({ command, resolve }));
  }
  function answerApproval(ok: boolean) {
    pendingCmd?.resolve(ok);
    setPendingCmd(null);
  }

  return (
    <div className="chat-layout">
      <aside className="chat-sessions">
        <button className="btn primary new-chat" onClick={newChat}>
           + New chat
        </button>
        <div className="session-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={s.id === activeId ? "session-item active" : "session-item"}
              onClick={() => switchChat(s.id)}
            >
              <span className="session-title">{s.title || "New chat"}</span>
              <button
                className="session-del"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteChat(s.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="chat-view">
        <div className="chat-bar">
          <ModelSelect
            settings={settings}
            ollamaModels={ollamaModels}
            orModels={orModels}
            onChange={onChange}
            onRefresh={refreshOR}
            loading={orLoading}
          />
          <button className="btn ghost" onClick={() => setShowModels(true)}>
            Models
          </button>
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
              return (
                <div key={i} className="tool-line">
                  {m.content}
                </div>
              );
            }
            const { think, answer } = splitThink(m.content);
            const thinking = (m.reasoning + (think ? "\n" + think : "")).trim();
            return (
              <div key={i} className={`msg ${m.role}`}>
                <div className="msg-role">{m.role === "user" ? "You" : "AI Studio"}</div>
                {thinking && (
                  <details className="thinking" open={generating && i === messages.length - 1}>
                    <summary>Thinking</summary>
                    <div className="thinking-body">{thinking}</div>
                  </details>
                )}
                <div className="msg-body">
                  {answer || (m.role === "assistant" && !thinking ? "…" : "")}
                </div>
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

      {pendingCmd && (
        <div className="modal-backdrop">
          <div className="modal approve">
            <div className="modal-head">
              <h2>Run this command?</h2>
            </div>
            <div className="modal-body">
              <p className="hint">The agent wants to run a shell command on your Mac:</p>
              <pre className="cmd-preview">{pendingCmd.command}</pre>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => answerApproval(false)}>
                Deny
              </button>
              <button className="btn primary" onClick={() => answerApproval(true)}>
                Approve &amp; run
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// A direct terminal for the Mac, usable from the desktop app or a paired phone.
// Each command runs via run_command_stream (a fresh `sh -c` — not a persistent
// shell), streaming stdout/stderr live. Over the LAN the desktop must approve
// unless the auto-approve toggle is on; on the desktop it runs immediately.
import { useEffect, useRef, useState } from "react";
import { runCommandStream } from "../lib/api";
import { isTauri } from "../lib/transport";

interface Block {
  command: string;
  lines: string[];
  code?: number;
  error?: string;
  running: boolean;
}

const HISTORY_KEY = "ai-studio.terminal-history";

export default function Terminal() {
  const [input, setInput] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    } catch {
      return [];
    }
  });
  const [histIdx, setHistIdx] = useState(-1); // -1 = current (editing) line
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Keep the newest output in view as lines stream in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function run() {
    const command = input.trim();
    if (!command || running) return;
    setInput("");
    setHistIdx(-1);
    const next = [...history.filter((h) => h !== command), command].slice(-100);
    setHistory(next);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota */
    }
    const idx = blocks.length;
    setBlocks((b) => [...b, { command, lines: [], running: true }]);
    setRunning(true);
    const patch = (fn: (bl: Block) => Block) =>
      setBlocks((b) => b.map((bl, i) => (i === idx ? fn(bl) : bl)));
    try {
      await runCommandStream(command, (ev) => {
        if (ev.type === "line") patch((bl) => ({ ...bl, lines: [...bl.lines, ev.text] }));
        else if (ev.type === "done") patch((bl) => ({ ...bl, code: ev.code, running: false }));
        else if (ev.type === "error") patch((bl) => ({ ...bl, error: ev.message, running: false }));
      });
    } catch (e) {
      patch((bl) => ({ ...bl, error: String(e), running: false }));
    } finally {
      patch((bl) => ({ ...bl, running: false }));
      setRunning(false);
      inputRef.current?.focus();
    }
  }

  // Up/Down walk shell history; Enter runs (Shift+Enter = newline).
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      run();
      return;
    }
    if (e.key === "ArrowUp" && !input.includes("\n")) {
      e.preventDefault();
      const ni = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
      if (history[ni] != null) {
        setHistIdx(ni);
        setInput(history[ni]);
      }
    } else if (e.key === "ArrowDown" && histIdx >= 0) {
      e.preventDefault();
      const ni = histIdx + 1;
      if (ni >= history.length) {
        setHistIdx(-1);
        setInput("");
      } else {
        setHistIdx(ni);
        setInput(history[ni]);
      }
    }
  }

  return (
    <div className="terminal-view">
      <div className="terminal-scroll" ref={scrollRef} onClick={() => inputRef.current?.focus()}>
        {blocks.length === 0 && (
          <div className="terminal-empty">
            Run shell commands on this Mac{isTauri() ? "" : " from your phone"}. Each command is a
            fresh <code>sh -c</code> (no persistent session — <code>cd</code> won&apos;t carry over;
            chain with <code>&amp;&amp;</code>).
            {!isTauri() && " Commands may need approval on the Mac."}
          </div>
        )}
        {blocks.map((bl, i) => (
          <div className="terminal-block" key={i}>
            <div className="terminal-cmd">
              <span className="terminal-prompt">$</span> {bl.command}
            </div>
            {bl.lines.length > 0 && <pre className="terminal-out">{bl.lines.join("\n")}</pre>}
            {bl.error && <pre className="terminal-out err">{bl.error}</pre>}
            {bl.running ? (
              <div className="terminal-status running">running…</div>
            ) : (
              bl.code != null &&
              bl.code !== 0 && <div className="terminal-status err">exit {bl.code}</div>
            )}
          </div>
        ))}
      </div>
      <div className="terminal-bar">
        <span className="terminal-prompt">$</span>
        <textarea
          ref={inputRef}
          className="terminal-input"
          rows={1}
          placeholder="Type a command…  (Enter to run, ↑/↓ history)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <button
          className={running ? "btn" : "btn primary"}
          onClick={run}
          disabled={running || !input.trim()}
        >
          {running ? "…" : "Run"}
        </button>
      </div>
    </div>
  );
}

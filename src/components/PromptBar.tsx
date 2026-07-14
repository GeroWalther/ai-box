import type { ReactNode } from "react";

interface Props {
  value: string;
  onChange: (s: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  generating: boolean;
  status: string;
  /** Optional controls (model, preset, language, actions) revealed above the
      input by the "Model & options" toggle — keeps the canvas clean. */
  tools?: ReactNode;
  toolsOpen?: boolean;
  onToggleTools?: () => void;
}

export default function PromptBar({
  value,
  onChange,
  onSubmit,
  onStop,
  generating,
  status,
  tools,
  toolsOpen,
  onToggleTools,
}: Props) {
  return (
    <div className="promptbar-wrap">
      {status && <div className="promptbar-status">{status}</div>}
      {tools && (
        <div className="prompt-toolbar">
          <button
            className="write-tools-toggle prompt-tools-toggle"
            onClick={onToggleTools}
            aria-expanded={toolsOpen}
            title="Model, preset, language & document tools"
          >
            Model &amp; options {toolsOpen ? "▲" : "▾"}
          </button>
          {toolsOpen && <div className="prompt-tools">{tools}</div>}
        </div>
      )}
      <div className="promptbar">
        <textarea
          className="promptbar-input"
          rows={1}
          placeholder="Tell the AI what to write…  (or leave empty to continue)"
          value={value}
          disabled={generating}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!generating) onSubmit();
            }
          }}
        />
        {generating ? (
          <button className="btn stop promptbar-send" onClick={onStop}>
            ■
          </button>
        ) : (
          <button className="btn primary promptbar-send" onClick={onSubmit}>
            →
          </button>
        )}
      </div>
    </div>
  );
}

interface Props {
  value: string;
  onChange: (s: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  generating: boolean;
  status: string;
}

export default function PromptBar({
  value,
  onChange,
  onSubmit,
  onStop,
  generating,
  status,
}: Props) {
  return (
    <div className="promptbar-wrap">
      {status && <div className="promptbar-status">{status}</div>}
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

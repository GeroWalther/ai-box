// Renders a `+`/`-` unified diff. Shared by the two approval dialogs (the local
// agent's, and the one raised on the Mac by a remote request) so an approval
// looks and reads the same wherever the request came from.

interface Props {
  diff: string;
  /** Accessible description of what is being previewed. */
  label?: string;
}

export default function DiffPreview({ diff, label = "change preview" }: Props) {
  if (!diff.trim()) return null;
  return (
    <pre className="diff-preview" aria-label={label}>
      {diff.split("\n").map((line, i) => {
        const cls = line.startsWith("+")
          ? "diff-add"
          : line.startsWith("-")
            ? "diff-del"
            : "diff-ctx";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

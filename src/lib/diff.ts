// Small diff engine shared by two features that both need to show a human
// "here is exactly what will change before you accept it":
//   • the agent's write/edit approval dialog (line-level)
//   • the Write tab's proofreader (word-level, so corrections read naturally)
//
// Plain LCS via dynamic programming. Inputs are bounded before the O(n·m) table
// is built, because a 10k-line file would otherwise allocate 100M cells.

export type DiffOp = "add" | "del" | "ctx";

export interface DiffPart {
  type: DiffOp;
  text: string;
}

/** Longest-common-subsequence backtrace over two token arrays. */
function lcsDiff(a: string[], b: string[]): DiffPart[] {
  const n = a.length;
  const m = b.length;
  // table[i][j] = LCS length of a[i..] and b[j..]
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const out: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

/** Merge runs of the same op so the UI renders "three words changed", not three spans. */
function coalesce(parts: DiffPart[], joiner: string): DiffPart[] {
  const out: DiffPart[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.type === p.type) last.text += joiner + p.text;
    else out.push({ ...p });
  }
  return out;
}

const MAX_LINES = 1500;

/**
 * Line-level diff for the approval dialog. Very large inputs are truncated
 * rather than diffed — the point is an honest preview, not a patch file, and a
 * caller that hides the truncation would be lying about what it's approving.
 */
export function lineDiff(before: string, after: string): { parts: DiffPart[]; truncated: boolean } {
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];
  const truncated = a.length > MAX_LINES || b.length > MAX_LINES;
  const parts = lcsDiff(a.slice(0, MAX_LINES), b.slice(0, MAX_LINES));
  return { parts, truncated };
}

/** Render a line diff the way `preview_diff` in the Rust server does. */
export function lineDiffText(before: string, after: string): string {
  const { parts, truncated } = lineDiff(before, after);
  const body = parts
    .map((p) => `${p.type === "add" ? "+" : p.type === "del" ? "-" : " "} ${p.text}`)
    .join("\n");
  return truncated ? `${body}\n… (truncated)` : body;
}

/**
 * Word-level diff for the proofreader. Splits on whitespace boundaries but keeps
 * the whitespace attached, so reassembling the "after" side reproduces the text
 * exactly — punctuation-only fixes ("dont" → "don't") show as one changed token
 * instead of redrawing the whole sentence.
 */
export function wordDiff(before: string, after: string): DiffPart[] {
  const tokenize = (s: string) => s.match(/\S+\s*/g) ?? [];
  const parts = lcsDiff(tokenize(before), tokenize(after));
  return coalesce(parts, "");
}

/** How many tokens the proofreader actually changed — used to say "12 fixes". */
export function countChanges(parts: DiffPart[]): number {
  return parts.filter((p) => p.type !== "ctx").length;
}

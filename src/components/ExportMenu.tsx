// Export the current manuscript to .txt / .md / .html / .docx. Text formats are
// built inline; .docx uses the `docx` library. All download via a Blob link,
// which works inside the Tauri webview (same pattern as the image Save button).
import { useEffect, useRef, useState } from "react";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { exportLibrary } from "../lib/versionStore";

/** Editor HTML to readable plain text, preserving paragraph breaks. */
function htmlToText(html: string): string {
  const el = document.createElement("div");
  el.innerHTML = html.replace(/<\/(p|div|h[1-6])>/gi, "\n\n").replace(/<br\s*\/?>/gi, "\n");
  return (el.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

interface Props {
  title: string;
  getText: () => string;
  getHTML: () => string;
  /** The whole library, for "export everything" — see exportAll below. */
  documents?: { title: string; html: string }[];
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeName(title: string): string {
  const base = (title || "manuscript").trim().replace(/[^\w\-]+/g, "_").slice(0, 60);
  return base || "manuscript";
}

export default function ExportMenu({ title, getText, getHTML, documents }: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(""), 6000);
    return () => clearTimeout(t);
  }, [status]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const name = safeName(title);

  function exportTxt() {
    download(new Blob([getText()], { type: "text/plain" }), `${name}.txt`);
  }
  function exportMd() {
    // Paragraphs separated by blank lines read cleanly as Markdown.
    const md = getText().split("\n").map((l) => l.trimEnd()).join("\n\n").replace(/\n{3,}/g, "\n\n");
    download(new Blob([md], { type: "text/markdown" }), `${name}.md`);
  }
  function exportHtml() {
    const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>\n${getHTML()}`;
    download(new Blob([html], { type: "text/html" }), `${name}.html`);
  }
  async function exportDocx() {
    const paras = getText()
      .split("\n")
      .map((line) => new Paragraph({ children: [new TextRun(line)] }));
    const doc = new Document({ sections: [{ children: paras.length ? paras : [new Paragraph("")] }] });
    const blob = await Packer.toBlob(doc);
    download(blob, `${name}.docx`);
  }

  /**
   * Write every document to a dated folder in ~/Downloads.
   *
   * The library lives in an app-private store, which is convenient right up
   * until someone wants their manuscripts out of it — or wants a backup they
   * control. The Mac does the writing, so this works from the phone too.
   */
  async function exportAll() {
    if (!documents?.length) return;
    const used = new Set<string>();
    const files = documents.map((d) => {
      // Two documents called "Untitled" must not overwrite each other.
      let base = safeName(d.title);
      let candidate = base;
      let n = 2;
      while (used.has(candidate)) candidate = `${base}-${n++}`;
      used.add(candidate);
      const text = htmlToText(d.html);
      return { name: `${candidate}.md`, content: text };
    });
    try {
      const dir = await exportLibrary(files);
      setStatus(`Exported ${files.length} to ${dir.replace(/^.*\/Downloads\//, "Downloads/")}`);
    } catch (e) {
      setStatus(`Export failed: ${String(e)}`);
    }
  }

  function run(fn: () => void | Promise<void>) {
    setOpen(false);
    fn();
  }

  return (
    <div className="export-menu" ref={ref}>
      <button className="btn ghost" onClick={() => setOpen((v) => !v)} title="Export manuscript">
        Export ▾
      </button>
      {status && (
        <span className="export-status" role="status">
          {status}
        </span>
      )}
      {open && (
        <div className="export-pop">
          <button onClick={() => run(exportTxt)}>Plain text (.txt)</button>
          <button onClick={() => run(exportMd)}>Markdown (.md)</button>
          <button onClick={() => run(exportHtml)}>HTML (.html)</button>
          <button onClick={() => run(exportDocx)}>Word (.docx)</button>
          {documents && documents.length > 1 && (
            <>
              <div className="export-sep" />
              <button onClick={() => run(exportAll)}>
                All {documents.length} documents → Downloads
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

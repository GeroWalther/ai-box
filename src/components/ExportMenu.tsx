// Export the current manuscript to .txt / .md / .html / .docx. Text formats are
// built inline; .docx uses the `docx` library. All download via a Blob link,
// which works inside the Tauri webview (same pattern as the image Save button).
import { useEffect, useRef, useState } from "react";
import { Document, Packer, Paragraph, TextRun } from "docx";

interface Props {
  title: string;
  getText: () => string;
  getHTML: () => string;
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

export default function ExportMenu({ title, getText, getHTML }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  function run(fn: () => void | Promise<void>) {
    setOpen(false);
    fn();
  }

  return (
    <div className="export-menu" ref={ref}>
      <button className="btn ghost" onClick={() => setOpen((v) => !v)} title="Export manuscript">
        Export ▾
      </button>
      {open && (
        <div className="export-pop">
          <button onClick={() => run(exportTxt)}>Plain text (.txt)</button>
          <button onClick={() => run(exportMd)}>Markdown (.md)</button>
          <button onClick={() => run(exportHtml)}>HTML (.html)</button>
          <button onClick={() => run(exportDocx)}>Word (.docx)</button>
        </div>
      )}
    </div>
  );
}

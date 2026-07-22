// Manuscript outline / binder: lists the document's headings (chapters & scenes)
// with per-section word counts, click-to-jump navigation, and a one-click "add
// chapter". Derived live from the editor — no change to how documents are stored;
// writers structure with H1 (chapter) / H2 (scene) headings.
import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";

interface Section {
  level: number;
  text: string;
  pos: number;
  words: number;
}

function computeOutline(editor: Editor): Section[] {
  const heads: { level: number; text: string; pos: number; end: number }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      heads.push({
        level: node.attrs.level as number,
        text: node.textContent,
        pos,
        end: pos + node.nodeSize,
      });
    }
    return true;
  });
  const size = editor.state.doc.content.size;
  return heads.map((h, i) => {
    const stop = i + 1 < heads.length ? heads[i + 1].pos : size;
    const body = editor.state.doc.textBetween(h.end, Math.max(h.end, stop), " ").trim();
    return {
      level: h.level,
      text: h.text || "Untitled",
      pos: h.pos,
      words: body ? body.split(/\s+/).length : 0,
    };
  });
}

export default function Outline({ editor }: { editor: Editor | null }) {
  const [sections, setSections] = useState<Section[]>([]);

  useEffect(() => {
    if (!editor) return;
    const update = () => setSections(computeOutline(editor));
    update();
    editor.on("update", update);
    editor.on("selectionUpdate", update);
    return () => {
      editor.off("update", update);
      editor.off("selectionUpdate", update);
    };
  }, [editor]);

  function jump(pos: number) {
    if (!editor) return;
    editor.chain().focus().setTextSelection(pos + 1).scrollIntoView().run();
  }

  function addChapter() {
    if (!editor) return;
    const n = sections.filter((s) => s.level === 1).length + 1;
    editor
      .chain()
      .focus("end")
      .insertContent([
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: `Chapter ${n}` }] },
        { type: "paragraph" },
      ])
      .scrollIntoView()
      .run();
  }

  return (
    <div className="outline">
      <div className="outline-head">
        <span>Outline</span>
        <button className="outline-add" title="Add a chapter heading" onClick={addChapter}>
          + Chapter
        </button>
      </div>
      {sections.length === 0 ? (
        <div className="outline-empty">
          Add chapter (H1) or scene (H2) headings to build your outline.
        </div>
      ) : (
        <div className="outline-list">
          {sections.map((s, i) => (
            <button
              key={i}
              className={`outline-item lvl${Math.min(s.level, 3)}`}
              onClick={() => jump(s.pos)}
              title={s.text}
            >
              <span className="outline-title">{s.text}</span>
              <span className="outline-words">{s.words}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

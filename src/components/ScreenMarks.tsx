// The drawing layer: highlights painted straight onto the screen.
//
// This window is full-screen, transparent, and permanently click-through — it
// takes no clicks and no keys, ever. That is the whole reason it is separate
// from the ask bar: a layer that can never intercept a click can never come
// between you and the button it just highlighted.
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Annotation } from "../lib/presets";

/** How long a highlight stays before fading itself out. */
const HOLD_MS = 12_000;
const FADE_MS = 700;

export default function ScreenMarks() {
  const [marks, setMarks] = useState<Annotation[]>([]);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const un = listen<Annotation[]>("screen-assist://marks", (e) => {
      setMarks(Array.isArray(e.payload) ? e.payload : []);
      setFading(false);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // Highlights clear themselves. They sit on top of the user's actual work, so
  // leaving them until something else happens to dismiss them turns a pointer
  // into litter — and the answer they belong to has long since been read.
  useEffect(() => {
    if (!marks.length) return;
    const fade = setTimeout(() => setFading(true), HOLD_MS);
    const clear = setTimeout(() => {
      setMarks([]);
      setFading(false);
    }, HOLD_MS + FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(clear);
    };
  }, [marks]);

  if (!marks.length) return null;

  return (
    <svg className={fading ? "sa-marks fading" : "sa-marks"} viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <marker id="sa-head" markerWidth="6" markerHeight="6" refX="4.8" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" fill="var(--sa-mark)" />
        </marker>
        {/* A dark halo under the blue keeps the mark readable on a white
            document and a dark editor alike, without tinting either. */}
        <filter id="sa-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="0" stdDeviation="5" floodColor="rgba(0,0,0,0.6)" floodOpacity="1" />
        </filter>
      </defs>
      {marks.map((a, i) => (
        <Mark key={i} a={a} index={i} />
      ))}
    </svg>
  );
}

function Mark({ a, index }: { a: Annotation; index: number }) {
  const [x1, y1, x2, y2] = a.box;
  const w = x2 - x1;
  const h = y2 - y1;
  const cx = x1 + w / 2;
  const cy = y1 + h / 2;

  // Marks appear in reading order rather than all at once, so a two-step answer
  // reads as a sequence instead of a puzzle.
  const style = { animationDelay: `${index * 90}ms` };

  const stroke = {
    fill: "none",
    stroke: "var(--sa-mark)",
    strokeWidth: 3,
    filter: "url(#sa-glow)",
    vectorEffect: "non-scaling-stroke" as const,
  };
  // The wash is what makes it read as highlighting rather than outlining. Kept
  // faint: this sits over the user's actual work, which must stay legible.
  const wash = { fill: "var(--sa-wash)", stroke: "none" };

  return (
    <g className="sa-mark" style={style}>
      {a.kind === "circle" && (
        <>
          <ellipse cx={cx} cy={cy} rx={Math.max(w / 2 + 7, 12)} ry={Math.max(h / 2 + 7, 12)} {...wash} />
          <ellipse cx={cx} cy={cy} rx={Math.max(w / 2 + 7, 12)} ry={Math.max(h / 2 + 7, 12)} {...stroke} />
          {/* A soft pulse draws the eye without moving anything on screen. */}
          <ellipse className="sa-ping" cx={cx} cy={cy} rx={Math.max(w / 2 + 7, 12)} ry={Math.max(h / 2 + 7, 12)} {...stroke} />
        </>
      )}
      {a.kind === "box" && (
        <>
          <rect x={x1} y={y1} width={w} height={h} rx={5} {...wash} />
          <rect x={x1} y={y1} width={w} height={h} rx={5} {...stroke} />
        </>
      )}
      {a.kind === "underline" && (
        <>
          <rect x={x1} y={y1} width={w} height={h} {...wash} />
          <path d={`M${x1},${y2 + 4} L${x2},${y2 + 4}`} {...stroke} strokeLinecap="round" />
        </>
      )}
      {a.kind === "arrow" && (
        // Approaches from the upper-left so the arrow never covers the thing it
        // is pointing at, and stays on screen near an edge.
        <path
          d={`M${Math.max(cx - 85, 10)},${Math.max(cy - 65, 10)} L${cx - 12},${cy - 12}`}
          {...stroke}
          markerEnd="url(#sa-head)"
          strokeLinecap="round"
        />
      )}
      {a.label && (
        <text className="sa-label" x={cx} y={y1 - 9 > 18 ? y1 - 9 : y2 + 24} textAnchor="middle">
          {a.label}
        </text>
      )}
    </g>
  );
}

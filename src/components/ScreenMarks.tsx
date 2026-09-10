// The drawing layer: highlights painted straight onto the screen.
//
// This window is full-screen, transparent, and permanently click-through — it
// takes no clicks and no keys, ever. That is the whole reason it is separate
// from the ask bar: a layer that can never intercept a click can never come
// between you and the button it just highlighted.
//
// Everything is drawn in REAL PIXELS rather than in the model's normalised
// 0–1000 space. Stretching a square viewBox across a 16:10 display turns every
// circle into an oval and every corner radius into a lopsided one — the marks
// looked hand-drawn because they were being distorted, not because of the
// shapes. Coordinates are converted once, on the way in.
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Annotation } from "../lib/presets";

/** How long a highlight stays before fading itself out. */
const HOLD_MS = 12_000;
const FADE_MS = 600;

/** Keep marks clear of the screen edge so nothing is clipped. */
const EDGE = 14;

export default function ScreenMarks() {
  const [marks, setMarks] = useState<Annotation[]>([]);
  const [fading, setFading] = useState(false);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const un = listen<Annotation[]>("screen-assist://marks", (e) => {
      setMarks(Array.isArray(e.payload) ? e.payload : []);
      setFading(false);
      // The display can change between questions (a different monitor, a
      // resolution switch), and the mapping is only right for the current one.
      setSize({ w: window.innerWidth, h: window.innerHeight });
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
    <svg
      className={fading ? "sa-marks fading" : "sa-marks"}
      width={size.w}
      height={size.h}
      viewBox={`0 0 ${size.w} ${size.h}`}
      aria-hidden="true"
    >
      <defs>
        <marker
          id="sa-head"
          markerWidth="10"
          markerHeight="10"
          refX="7.2"
          refY="5"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M0.5,0.5 L9,5 L0.5,9.5 Z" fill="var(--sa-mark)" />
        </marker>
        {/* Two soft shadows rather than one hard one: the tight pass keeps the
            edge crisp on a busy background, the wide one lifts the mark off the
            screen the way macOS lifts a popover. */}
        <filter id="sa-lift" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodColor="rgba(0,0,0,0.30)" />
          <feDropShadow dx="0" dy="6" stdDeviation="10" floodColor="rgba(0,0,0,0.22)" />
        </filter>
      </defs>
      {marks.map((a, i) => (
        <Mark key={i} a={a} index={i} w={size.w} h={size.h} />
      ))}
    </svg>
  );
}

function Mark({ a, index, w, h }: { a: Annotation; index: number; w: number; h: number }) {
  // 0–1000 in each axis maps onto the display's real pixels independently, then
  // everything downstream is honest geometry.
  const sx = (v: number) => (v / 1000) * w;
  const sy = (v: number) => (v / 1000) * h;

  // Clamp inside the viewport so a mark on something near the edge is never
  // half-drawn — the model routinely points at menu bars and window corners.
  const pad = 5; // the stroke's own half-width plus a hair
  const x1 = Math.max(EDGE, Math.min(sx(a.box[0]) - pad, w - EDGE));
  const y1 = Math.max(EDGE, Math.min(sy(a.box[1]) - pad, h - EDGE));
  const x2 = Math.max(EDGE, Math.min(sx(a.box[2]) + pad, w - EDGE));
  const y2 = Math.max(EDGE, Math.min(sy(a.box[3]) + pad, h - EDGE));
  const bw = Math.max(x2 - x1, 22);
  const bh = Math.max(y2 - y1, 22);
  const cx = x1 + bw / 2;
  const cy = y1 + bh / 2;

  // Marks appear in reading order rather than all at once, so a two-step answer
  // reads as a sequence instead of a puzzle.
  const style = { animationDelay: `${index * 110}ms` };

  const line = {
    fill: "none",
    stroke: "var(--sa-mark)",
    strokeWidth: 3,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    filter: "url(#sa-lift)",
  };
  // Faint, because this sits over the user's actual work, which has to stay
  // readable through it.
  const wash = { fill: "var(--sa-wash)", stroke: "none" };

  // Apple rounds a highlight to roughly the shape it wraps rather than using a
  // fixed radius: a squat control gets a pill, a large region a soft rectangle.
  const radius = Math.min(bh / 2, Math.max(7, Math.min(bw, bh) * 0.22));

  return (
    <g className="sa-mark" style={style}>
      {(a.kind === "circle" || a.kind === "box") && (
        <>
          <rect x={x1} y={y1} width={bw} height={bh} rx={radius} {...wash} />
          <rect x={x1} y={y1} width={bw} height={bh} rx={radius} {...line} />
          <rect
            className="sa-ping"
            x={x1}
            y={y1}
            width={bw}
            height={bh}
            rx={radius}
            {...line}
            filter={undefined}
            style={{ transformOrigin: `${cx}px ${cy}px` }}
          />
        </>
      )}
      {a.kind === "underline" && (
        <>
          <rect x={x1} y={y1} width={bw} height={bh} rx={4} {...wash} />
          <path d={`M${x1 + 2},${Math.min(y2 + 4, h - EDGE)} L${x2 - 2},${Math.min(y2 + 4, h - EDGE)}`} {...line} />
        </>
      )}
      {a.kind === "arrow" && (
        <Arrow cx={cx} cy={cy} w={w} h={h} line={line} />
      )}
      {a.label && <Label text={a.label} cx={cx} y1={y1} y2={y2} w={w} h={h} />}
    </g>
  );
}

/**
 * An arrow that always has room. It approaches from whichever diagonal has the
 * most space, so a target in the top-left corner is pointed at from below-right
 * instead of from off-screen — the case where the old fixed upper-left approach
 * simply drew nothing visible.
 */
function Arrow({
  cx,
  cy,
  w,
  h,
  line,
}: {
  cx: number;
  cy: number;
  w: number;
  h: number;
  line: Record<string, unknown>;
}) {
  const reach = 96;
  const fromLeft = cx > w / 2 ? -1 : 1; // come from the side with more room
  const fromTop = cy > h / 2 ? -1 : 1;
  const tailX = Math.max(EDGE, Math.min(cx + fromLeft * -reach, w - EDGE));
  const tailY = Math.max(EDGE, Math.min(cy + fromTop * -reach, h - EDGE));
  // Stop short of the target so the head points AT it rather than covering it.
  const tipX = cx - fromLeft * -14;
  const tipY = cy - fromTop * -14;
  // A gentle curve reads as a gesture; a straight line reads as a diagram.
  const mx = (tailX + tipX) / 2 + (fromTop * 18);
  const my = (tailY + tipY) / 2 - (fromLeft * 18);
  return (
    <path
      d={`M${tailX},${tailY} Q${mx},${my} ${tipX},${tipY}`}
      {...line}
      markerEnd="url(#sa-head)"
    />
  );
}

/**
 * The caption, as a filled pill rather than outlined text.
 *
 * Stroked text over an unknown background is the single thing that made this
 * look homemade. A solid tinted pill with white SF text is what macOS itself
 * uses for a badge, and it is legible over anything.
 */
function Label({
  text,
  cx,
  y1,
  y2,
  w,
  h,
}: {
  text: string;
  cx: number;
  y1: number;
  y2: number;
  w: number;
  h: number;
}) {
  // Measuring text properly means a DOM round trip; SF at 13px averages a shade
  // over half its size per character, which is close enough to size a pill and
  // never leaves the text touching the edge.
  const pw = Math.min(text.length * 7.2 + 22, w - EDGE * 2);
  const ph = 24;
  // Above by preference; below when there is no room up there.
  const above = y1 - ph - 10 > EDGE;
  const py = above ? y1 - ph - 10 : Math.min(y2 + 10, h - EDGE - ph);
  // Keep the whole pill on screen, which the old centred text did not.
  const px = Math.max(EDGE, Math.min(cx - pw / 2, w - EDGE - pw));
  return (
    <g className="sa-labelgroup">
      <rect x={px} y={py} width={pw} height={ph} rx={ph / 2} className="sa-pill" />
      <text x={px + pw / 2} y={py + ph / 2} className="sa-label">
        {text}
      </text>
    </g>
  );
}

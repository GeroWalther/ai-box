// The tools Screen Assist uses to actually do things.
//
// The model already points at the screen in a 0–1000 coordinate space to draw
// its arrows, and it is good at it. These tools reuse that exact space rather
// than inventing a second one: "click the Wi-Fi menu" is the same act of
// pointing as "circle the Wi-Fi menu", so the model's existing accuracy carries
// straight over and there is one less thing for it to get wrong.
//
// Two kinds of tool live here, and the split is the point:
//
//   * SWITCHES — Bluetooth, Wi-Fi, volume, appearance, opening an app. These go
//     straight to the system. No pointer, no timing, no window that might be
//     somewhere else today. When there is a real API for something, using it
//     beats clicking through a UI every time.
//   * HANDS — click, type, scroll, drag, keys. The fallback for everything
//     macOS gives no API for, which is most of what a person actually does.
//
// The model is told to prefer the first and reach for the second when it must.
import {
  controlClick,
  controlDrag,
  controlKey,
  controlMove,
  controlScroll,
  controlSystem,
  controlType,
  screenSize,
} from "./api";

/** OpenAI-format tool definitions, handed to the model when acting is on. */
export const CONTROL_TOOLS = [
  {
    type: "function",
    function: {
      name: "click",
      description:
        "Click something on screen. Coordinates are the same 0–1000 space you use for " +
        "annotations: x from the left edge, y from the top. Aim at the CENTRE of the " +
        "control. Use count 2 to double-click (opening a file or app), button 'right' for " +
        "a context menu.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number", description: "0–1000 from the left edge" },
          y: { type: "number", description: "0–1000 from the top edge" },
          button: { type: "string", enum: ["left", "right"] },
          count: { type: "number", description: "1 normally, 2 to double-click" },
          what: { type: "string", description: "What you are clicking, e.g. 'the Send button'" },
        },
        required: ["x", "y", "what"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description:
        "Type text into whatever has keyboard focus. Click the field first. Types the " +
        "characters literally — it does not press Return, use press_keys for that.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "press_keys",
      description:
        "Press a key or shortcut: 'return', 'escape', 'tab', 'cmd+s', 'cmd+shift+4', " +
        "'down'. One combination per call.",
      parameters: {
        type: "object",
        properties: { combo: { type: "string" } },
        required: ["combo"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description:
        "Scroll the area under a point. Positive dy scrolls DOWN the page, negative up. " +
        "About 400 is one comfortable swipe.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number", description: "0–1000 from the left edge" },
          y: { type: "number", description: "0–1000 from the top edge" },
          dy: { type: "number", description: "Positive scrolls down" },
          dx: { type: "number", description: "Positive scrolls right" },
        },
        required: ["x", "y", "dy"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "drag",
      description:
        "Press at one point, drag to another, release — sliders, scrollbars, selecting " +
        "text, moving a file. Coordinates in the 0–1000 space.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          toX: { type: "number" },
          toY: { type: "number" },
        },
        required: ["x", "y", "toX", "toY"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_pointer",
      description:
        "Move the pointer without clicking — to reveal a hover menu or a tooltip before " +
        "looking again.",
      parameters: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "system",
      description:
        "Flip a system switch directly, with no clicking. ALWAYS prefer this over hunting " +
        "through Control Centre or System Settings. Actions: bluetooth (on/off/toggle), " +
        "wifi (on/off/toggle), volume (0–100), mute (on/off), appearance (light/dark/" +
        "toggle), open_app (app name), quit_app (app name), open_url (https link), lock " +
        "(screen off), sleep, install_bluetooth_helper (only when the Bluetooth action " +
        "says the helper is missing AND the user agrees to install it).",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "bluetooth",
              "wifi",
              "volume",
              "mute",
              "appearance",
              "open_app",
              "quit_app",
              "open_url",
              "lock",
              "sleep",
              "install_bluetooth_helper",
            ],
          },
          value: { type: "string", description: "on, off, toggle, a number, or a name" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "look",
      description:
        "Take a fresh screenshot and look again. Use it after something that takes a " +
        "moment — an app launching, a page loading — before deciding the next step.",
      parameters: {
        type: "object",
        properties: {
          wait: { type: "number", description: "Seconds to wait first, 0–5" },
        },
      },
    },
  },
] as const;

export const CONTROL_TOOL_NAMES = new Set(CONTROL_TOOLS.map((t) => t.function.name));

/** One executed step, for the trail the user watches. */
export interface Step {
  tool: string;
  /** Human sentence: what was done, or why it could not be. */
  message: string;
  ok: boolean;
}

/**
 * Display size in points, fetched once per run.
 *
 * Cached per call chain rather than globally: a laptop that wakes on a different
 * external display would otherwise keep clicking against the old geometry.
 */
async function pointScale(): Promise<{ w: number; h: number }> {
  const [w, h] = await screenSize();
  return { w, h };
}

/** 0–1000 → screen points, clamped so a hallucinated 1400 lands on the edge. */
function toPoints(v: unknown, span: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return span / 2;
  return (Math.min(1000, Math.max(0, n)) / 1000) * span;
}

/**
 * Run one tool call and describe what happened.
 *
 * Failures come back as a Step with `ok: false` rather than as a thrown error:
 * the model needs to be TOLD that a click missed or a permission is absent so it
 * can try something else, and an exception here would end the run instead.
 */
export async function runTool(name: string, args: any): Promise<Step> {
  try {
    const message = await dispatch(name, args ?? {});
    return { tool: name, message, ok: true };
  } catch (e) {
    return { tool: name, message: String(e).replace(/^Error:\s*/, ""), ok: false };
  }
}

async function dispatch(name: string, a: any): Promise<string> {
  switch (name) {
    case "click": {
      const { w, h } = await pointScale();
      const done = await controlClick(
        toPoints(a.x, w),
        toPoints(a.y, h),
        a.button === "right" ? "right" : "left",
        Number(a.count) === 2 ? 2 : Number(a.count) === 3 ? 3 : 1
      );
      return a.what ? `${done} (${a.what})` : done;
    }
    case "type_text":
      return controlType(String(a.text ?? ""));
    case "press_keys":
      return controlKey(String(a.combo ?? ""));
    case "scroll": {
      const { w, h } = await pointScale();
      return controlScroll(
        toPoints(a.x, w),
        toPoints(a.y, h),
        Number(a.dx) || 0,
        Number(a.dy) || 0
      );
    }
    case "drag": {
      const { w, h } = await pointScale();
      return controlDrag(
        toPoints(a.x, w),
        toPoints(a.y, h),
        toPoints(a.toX, w),
        toPoints(a.toY, h)
      );
    }
    case "move_pointer": {
      const { w, h } = await pointScale();
      return controlMove(toPoints(a.x, w), toPoints(a.y, h));
    }
    case "system":
      return controlSystem(String(a.action ?? ""), String(a.value ?? ""));
    case "look": {
      const secs = Math.min(5, Math.max(0, Number(a.wait) || 0));
      if (secs) await new Promise((r) => setTimeout(r, secs * 1000));
      return "Took a fresh look at the screen.";
    }
    default:
      throw new Error(`there is no tool called ${name}`);
  }
}

/**
 * A short line for the trail in the overlay.
 *
 * The user is watching their own Mac being driven, and the one thing they need
 * at a glance is what it is doing right now — not the JSON it was asked with.
 */
export function describe(name: string, a: any): string {
  switch (name) {
    case "click":
      return a?.what ? `Clicking ${a.what}` : "Clicking";
    case "type_text":
      return `Typing “${String(a?.text ?? "").slice(0, 40)}”`;
    case "press_keys":
      return `Pressing ${a?.combo}`;
    case "scroll":
      return Number(a?.dy) < 0 ? "Scrolling up" : "Scrolling down";
    case "drag":
      return "Dragging";
    case "move_pointer":
      return "Moving the pointer";
    case "system":
      return `${a?.action === "open_app" ? "Opening" : "Setting"} ${a?.action}${
        a?.value ? ` ${a.value}` : ""
      }`;
    case "look":
      return "Looking again";
    default:
      return name;
  }
}

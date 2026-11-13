// Colour themes: the whole UI and the terminal, switched together.
//
// A theme is a full set of the app's design tokens (see styles/tokens.css) plus
// a terminal palette — background, foreground and the sixteen ANSI colours that
// `ls`, git, and Claude Code's own UI paint with. Switching one restyles both,
// so the terminal never looks pasted into a different app.
//
// The schemes besides AI Box's own are the well-known open ones, with their
// published palettes. "System" follows macOS between AI Box Light and Dark.
//
// Applied as inline custom properties on <html>, which win over the defaults in
// tokens.css; `data-theme` still carries light/dark for the handful of rules
// that differ by mode rather than by colour.

import type { ITheme } from "@xterm/xterm";

export interface ThemeUi {
  bg: string;
  bg2: string;
  panel: string;
  panel2: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  /** A second accent: hover states, active nav, the far end of the gradient. */
  accent2: string;
  /** Text drawn ON the accent (primary buttons, chips). Dark for pale accents. */
  onAccent: string;
  danger: string;
}

export interface Theme {
  id: string;
  name: string;
  mode: "light" | "dark";
  ui: ThemeUi;
  term: ITheme;
}

/** The terminal AI Box has always had, kept for its own two themes. */
const AI_BOX_TERM: ITheme = {
  background: "#0e0e13",
  foreground: "#e6e6ea",
  cursor: "#8b7cf6",
  cursorAccent: "#0e0e13",
  selectionBackground: "#33335a",
};

export const THEMES: Theme[] = [
  {
    id: "aibox-light",
    name: "AI Box Light",
    mode: "light",
    ui: {
      bg: "#ffffff", bg2: "#f4f5f8", panel: "#f8f9fb", panel2: "#eceef3", border: "#e2e5eb",
      text: "#1b1d24", muted: "#6c7280", accent: "#6b5cf0", accent2: "#5646d6", onAccent: "#ffffff",
      danger: "#d9434f",
    },
    term: AI_BOX_TERM,
  },
  {
    id: "aibox-dark",
    name: "AI Box Dark",
    mode: "dark",
    ui: {
      bg: "#0d0e12", bg2: "#121319", panel: "#16181f", panel2: "#1e212b", border: "#272b36",
      text: "#eceef3", muted: "#9096a4", accent: "#7b6ef0", accent2: "#9d92ff", onAccent: "#ffffff",
      danger: "#ef5f6b",
    },
    term: AI_BOX_TERM,
  },
  {
    id: "dracula",
    name: "Dracula",
    mode: "dark",
    ui: {
      bg: "#282a36", bg2: "#21222c", panel: "#2d2f3d", panel2: "#363948", border: "#44475a",
      text: "#f8f8f2", muted: "#a0a6c6", accent: "#bd93f9", accent2: "#ff79c6", onAccent: "#21222c",
      danger: "#ff5555",
    },
    term: {
      background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", cursorAccent: "#282a36",
      selectionBackground: "#44475a",
      black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
      blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
      brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94", brightYellow: "#ffffa5",
      brightBlue: "#d6acff", brightMagenta: "#ff92df", brightCyan: "#a4ffff", brightWhite: "#ffffff",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    mode: "dark",
    ui: {
      bg: "#1a1b26", bg2: "#16161e", panel: "#1f2335", panel2: "#292e42", border: "#2f3549",
      text: "#c0caf5", muted: "#8089b3", accent: "#7aa2f7", accent2: "#bb9af7", onAccent: "#16161e",
      danger: "#f7768e",
    },
    term: {
      background: "#1a1b26", foreground: "#c0caf5", cursor: "#c0caf5", cursorAccent: "#1a1b26",
      selectionBackground: "#33467c",
      black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
      blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
      brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a", brightYellow: "#e0af68",
      brightBlue: "#7aa2f7", brightMagenta: "#bb9af7", brightCyan: "#7dcfff", brightWhite: "#c0caf5",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    mode: "dark",
    ui: {
      bg: "#1e1e2e", bg2: "#181825", panel: "#232334", panel2: "#313244", border: "#45475a",
      text: "#cdd6f4", muted: "#a6adc8", accent: "#cba6f7", accent2: "#b4befe", onAccent: "#11111b",
      danger: "#f38ba8",
    },
    term: {
      background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc", cursorAccent: "#1e1e2e",
      selectionBackground: "#45475a",
      black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
      blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
      brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1", brightYellow: "#f9e2af",
      brightBlue: "#89b4fa", brightMagenta: "#f5c2e7", brightCyan: "#94e2d5", brightWhite: "#a6adc8",
    },
  },
  {
    id: "nord",
    name: "Nord",
    mode: "dark",
    ui: {
      bg: "#2e3440", bg2: "#292e39", panel: "#3b4252", panel2: "#434c5e", border: "#4c566a",
      text: "#eceff4", muted: "#a3adbf", accent: "#88c0d0", accent2: "#8fbcbb", onAccent: "#2e3440",
      danger: "#bf616a",
    },
    term: {
      background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9", cursorAccent: "#2e3440",
      selectionBackground: "#434c5e",
      black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
      blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
      brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c", brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1", brightMagenta: "#b48ead", brightCyan: "#8fbcbb", brightWhite: "#eceff4",
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    mode: "dark",
    ui: {
      bg: "#282c34", bg2: "#21252b", panel: "#2c313a", panel2: "#333842", border: "#3e4451",
      text: "#d7dae0", muted: "#8b929e", accent: "#61afef", accent2: "#c678dd", onAccent: "#1e2127",
      danger: "#e06c75",
    },
    term: {
      background: "#282c34", foreground: "#abb2bf", cursor: "#528bff", cursorAccent: "#282c34",
      selectionBackground: "#3e4451",
      black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
      blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
      brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379", brightYellow: "#e5c07b",
      brightBlue: "#61afef", brightMagenta: "#c678dd", brightCyan: "#56b6c2", brightWhite: "#ffffff",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    mode: "dark",
    ui: {
      bg: "#282828", bg2: "#1d2021", panel: "#32302f", panel2: "#3c3836", border: "#504945",
      text: "#ebdbb2", muted: "#a89984", accent: "#fe8019", accent2: "#fabd2f", onAccent: "#1d2021",
      danger: "#fb4934",
    },
    term: {
      background: "#282828", foreground: "#ebdbb2", cursor: "#ebdbb2", cursorAccent: "#282828",
      selectionBackground: "#504945",
      black: "#282828", red: "#cc241d", green: "#98971a", yellow: "#d79921",
      blue: "#458588", magenta: "#b16286", cyan: "#689d6a", white: "#a89984",
      brightBlack: "#928374", brightRed: "#fb4934", brightGreen: "#b8bb26", brightYellow: "#fabd2f",
      brightBlue: "#83a598", brightMagenta: "#d3869b", brightCyan: "#8ec07c", brightWhite: "#ebdbb2",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    mode: "dark",
    ui: {
      bg: "#002b36", bg2: "#00252f", panel: "#073642", panel2: "#0c3f4c", border: "#174d5a",
      text: "#eee8d5", muted: "#93a1a1", accent: "#268bd2", accent2: "#2aa198", onAccent: "#fdf6e3",
      danger: "#dc322f",
    },
    term: {
      background: "#002b36", foreground: "#93a1a1", cursor: "#93a1a1", cursorAccent: "#002b36",
      selectionBackground: "#073642",
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
      brightBlack: "#586e75", brightRed: "#cb4b16", brightGreen: "#a4b82a", brightYellow: "#d6a520",
      brightBlue: "#4aa3e0", brightMagenta: "#6c71c4", brightCyan: "#40c4b8", brightWhite: "#fdf6e3",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    mode: "light",
    ui: {
      bg: "#fdf6e3", bg2: "#f5eedb", panel: "#eee8d5", panel2: "#e6dfca", border: "#d9d2bc",
      text: "#073642", muted: "#657b83", accent: "#268bd2", accent2: "#1a6fb0", onAccent: "#fdf6e3",
      danger: "#dc322f",
    },
    term: {
      background: "#fdf6e3", foreground: "#586e75", cursor: "#586e75", cursorAccent: "#fdf6e3",
      selectionBackground: "#eee8d5",
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#93a1a1",
      brightBlack: "#586e75", brightRed: "#cb4b16", brightGreen: "#6b7a00", brightYellow: "#946f00",
      brightBlue: "#1a6fb0", brightMagenta: "#6c71c4", brightCyan: "#1f8079", brightWhite: "#002b36",
    },
  },
  {
    id: "github-light",
    name: "GitHub Light",
    mode: "light",
    ui: {
      bg: "#ffffff", bg2: "#f6f8fa", panel: "#f6f8fa", panel2: "#eaeef2", border: "#d0d7de",
      text: "#1f2328", muted: "#656d76", accent: "#0969da", accent2: "#0550ae", onAccent: "#ffffff",
      danger: "#cf222e",
    },
    term: {
      background: "#ffffff", foreground: "#1f2328", cursor: "#0969da", cursorAccent: "#ffffff",
      selectionBackground: "#b6e3ff",
      black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#4d2d00",
      blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
      brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01",
      brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
    },
  },
];

/** "Follow macOS": AI Box Light by day, AI Box Dark by night. */
export const SYSTEM_THEME = "system";

/** What a fresh install starts in. */
export const DEFAULT_THEME = "gruvbox-dark";

const byId = new Map(THEMES.map((t) => [t.id, t]));

function systemDark(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

/** The theme a saved choice means right now. Unknown ids fall back to the default. */
export function resolveTheme(id: string | undefined): Theme {
  if (!id || id === SYSTEM_THEME) return byId.get(systemDark() ? "aibox-dark" : "aibox-light")!;
  return byId.get(id) ?? byId.get(DEFAULT_THEME)!;
}

let current: Theme = resolveTheme(undefined);

/** The terminal palette of the theme in force — read when a terminal opens. */
export function terminalTheme(): ITheme {
  return current.term;
}

/** Fired on window whenever the theme changes, with the Theme as detail. */
export const THEME_EVENT = "ai-box-theme";

/** Restyle the app (and, via THEME_EVENT, every open terminal). */
export function applyTheme(id: string | undefined): Theme {
  const t = resolveTheme(id);
  current = t;
  const root = document.documentElement;
  root.dataset.theme = t.mode;
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  const u = t.ui;
  set("--bg", u.bg);
  set("--bg-2", u.bg2);
  set("--panel", u.panel);
  set("--panel-2", u.panel2);
  set("--border", u.border);
  set("--text", u.text);
  set("--muted", u.muted);
  set("--accent", u.accent);
  set("--accent-2", u.accent2);
  set("--on-accent", u.onAccent);
  set("--danger", u.danger);
  set("--accent-soft", `color-mix(in srgb, ${u.accent} ${t.mode === "dark" ? 16 : 11}%, transparent)`);
  set("--accent-grad", `linear-gradient(135deg, ${u.accent} 0%, ${u.accent2} 100%)`);
  set("--term-bg", String(t.term.background));
  // Native controls (scrollbars, form fields) follow the mode too.
  root.style.colorScheme = t.mode;
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: t }));
  return t;
}

/** Re-apply when macOS switches between light and dark, if following it. */
export function watchSystemTheme(getId: () => string | undefined): () => void {
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!mq) return () => {};
  const on = () => {
    if ((getId() ?? SYSTEM_THEME) === SYSTEM_THEME) applyTheme(SYSTEM_THEME);
  };
  mq.addEventListener("change", on);
  return () => mq.removeEventListener("change", on);
}

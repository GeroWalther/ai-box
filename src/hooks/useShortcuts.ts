// Global keyboard shortcuts.
//
// Bound once for the app's lifetime; the handlers are read through a ref so the
// listener never fires a stale closure (the original bug this pattern fixes:
// ⌘↵ generating from a snapshot of the document taken at mount).

import { useEffect, useRef } from "react";

export interface ShortcutHandlers {
  setView: (v: "chat" | "write" | "images" | "terminal") => void;
  openSettings: () => void;
  /** Write-tab only. */
  generate: () => void;
  stop: () => void;
  newDoc: () => void;
  find: () => void;
  toggleFocusMode: () => void;
}

export function useShortcuts(view: string, handlers: ShortcutHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      const h = ref.current;
      if (mod && e.key === "1") return void (e.preventDefault(), h.setView("chat"));
      if (mod && e.key === "2") return void (e.preventDefault(), h.setView("write"));
      if (mod && e.key === "3") return void (e.preventDefault(), h.setView("images"));
      if (mod && e.key === "4") return void (e.preventDefault(), h.setView("terminal"));
      if (mod && e.key === ",") return void (e.preventDefault(), h.openSettings());

      if (viewRef.current !== "write") return;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        h.generate();
      } else if (e.key === "Escape") {
        h.stop();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        h.toggleFocusMode();
      } else if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        h.find();
      } else if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        h.newDoc();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

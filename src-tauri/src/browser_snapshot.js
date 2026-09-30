// Read a page as the assistant sees it: its text, and a numbered list of the
// things that can be clicked, typed into or chosen from.
//
// Adapted from jev-ultrafast's snapshot.js — MIT License, Copyright (c) 2026
// Browser Use (https://github.com/browser-use/jev-ultrafast). Changes: every
// element on the page is listed rather than only those in the viewport (the
// executor scrolls to a target before touching it), one entry per element with
// its options inline, and a node cache under our own name.
//
// Password, file and hidden inputs are never listed, so the assistant cannot
// type into them: logging in is always handed back to the person.
(() => {
  if (!document.body) return null;
  const cache = (window.__aibox ||= { ids: new WeakMap(), nodes: new Map(), next: 1 });
  const identity = (e) => {
    if (!cache.ids.has(e)) cache.ids.set(e, cache.next++);
    const id = cache.ids.get(e);
    cache.nodes.set(id, e);
    return id;
  };
  for (const [id, e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);

  const safe = (e) => !["password", "file", "hidden"].includes(e.type);
  const visible = (e) =>
    !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return "";
    seen.add(e);
    const referenced = (e.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => name(document.getElementById(id), seen))
      .filter(Boolean)
      .join(" ");
    return (
      referenced ||
      e.getAttribute("aria-label") ||
      [...(e.labels || [])].map((l) => name(l, seen)).filter(Boolean).join(" ") ||
      (["button", "submit", "reset"].includes(e.type) ? e.value : "") ||
      e.getAttribute("alt") ||
      // A field's own contents are not its name: an input's value, or a
      // dropdown's option list, would otherwise read as its label.
      (["INPUT", "SELECT", "TEXTAREA"].includes(e.tagName)
        ? ""
        : [...e.childNodes]
            .map((n) =>
              n.nodeType === 3
                ? n.textContent
                : n.nodeType === 1 && n.getAttribute("aria-hidden") !== "true"
                  ? name(n, seen)
                  : ""
            )
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()) ||
      e.getAttribute("title") ||
      e.getAttribute("placeholder") ||
      ""
    );
  };
  const roles = ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemradio",
    "option", "gridcell", "combobox", "textbox", "searchbox", "spinbutton"];
  const selector =
    'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    roles.map((r) => '[role="' + r + '"]').join(",");
  const role = (e) => {
    const explicit = e.getAttribute("role");
    if (roles.includes(explicit)) return explicit;
    if (e.tagName === "BUTTON" || e.tagName === "SUMMARY") return "button";
    if (e.tagName === "A") return "link";
    if (e.tagName === "SELECT") return "select";
    if (e.tagName === "TEXTAREA" || e.isContentEditable) return "textbox";
    if (e.tagName === "INPUT") {
      if (["checkbox", "radio"].includes(e.type)) return e.type;
      if (["button", "submit", "reset", "image"].includes(e.type)) return "button";
      if (e.type === "search") return "searchbox";
      if (e.type === "number") return "spinbutton";
      if (["text", "email", "url", "tel", "date", "time", "datetime-local", "month", "week", ""].includes(e.type))
        return "textbox";
    }
    return null;
  };

  const elements = [];
  let omitted = 0;
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(":disabled") || e.closest('[aria-disabled="true"]')) continue;
    const r = e.getBoundingClientRect();
    const kind = role(e);
    if (!kind || r.width <= 0 || r.height <= 0) continue;
    if (kind === "gridcell" && e.querySelector('button,[role="button"]')) continue;
    if (elements.length >= 300) {
      omitted++;
      continue;
    }
    const item = { node: identity(e), role: kind, label: name(e).slice(0, 120) || kind };
    for (const key of ["checked", "selected", "expanded"]) {
      const v = e.getAttribute("aria-" + key);
      if (v !== null) item[key] = v;
    }
    if (["checkbox", "radio"].includes(e.type)) item.checked = String(e.checked);
    if (e.tagName === "SELECT") {
      item.value = [...e.selectedOptions].map((o) => o.label).join(", ");
      item.options = [...e.options]
        .filter((o) => !o.disabled && !o.closest("optgroup[disabled]"))
        .slice(0, 60)
        .map((o) => o.label);
    } else {
      item.editable =
        !e.readOnly &&
        e.getAttribute("aria-readonly") !== "true" &&
        (["textbox", "searchbox", "spinbutton"].includes(kind) ||
          (kind === "combobox" && ["INPUT", "TEXTAREA"].includes(e.tagName)));
      const value = "value" in e ? String(e.value) : e.isContentEditable || kind === "combobox" ? e.innerText.trim() : "";
      if (value && item.editable) item.value = value.slice(0, 200);
    }
    if (kind === "link") {
      const href = e.getAttribute("href") || "";
      if (href && !href.startsWith("javascript:")) item.href = href.slice(0, 160);
    }
    // Inside a form that asks for card details: the executor treats a submit
    // here as a payment, whatever the button happens to say.
    const form = e.closest("form");
    if (form && form.querySelector('[autocomplete^="cc-"],[name*="card" i],[id*="card" i]')) item.payment = true;
    if (r.bottom < 0 || r.top > innerHeight) item.offscreen = true;
    elements.push(item);
  }

  const words = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node, length = 0;
  while ((node = walker.nextNode()) && length < 8000) {
    const value = node.textContent.replace(/\s+/g, " ").trim();
    const parent = node.parentElement;
    if (!value || !parent || parent.closest("script,style,noscript,template") || !visible(parent)) continue;
    words.push(value);
    length += value.length + 1;
  }

  return {
    url: location.href,
    title: document.title,
    text: words.join("\n").slice(0, 8000),
    elements,
    omitted,
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, view: innerHeight },
  };
})()

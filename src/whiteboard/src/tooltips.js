import { platformShortcut } from "./context-menu.js";

// Styled tooltips for icon buttons, shown soon after a mouse rests on one and
// at once while moving along a toolbar, as in Miro: the name, and its
// shortcut set apart. The button's title is moved aside while the tooltip
// shows, so the browser's own slower one never doubles it, and put back
// after. Touch, pens and the keyboard keep what they had: buttons are named
// for assistive technology by their labels.
const DELAY = 300,
  WARM = 600;
const SELECTOR =
  ".icon-btn[title], .zoom-label[title], summary.icon-btn[aria-label]";

// "Find on board (Ctrl/Cmd F)" reads as a name and a shortcut.
export function tooltipParts(text) {
  const match = /^(.*\S)\s+\(([^()]+)\)$/.exec(text || "");
  if (!match || !/^(Ctrl|Cmd|Alt|Shift|Maj|[A-Z0-9?]$)/.test(match[2]))
    return { label: text || "", shortcut: "" };
  const keys = match[2]
    .replace(/\bMaj\b/g, "Shift")
    .replace(/\s*\+\s*|\s+/g, "+");
  return { label: match[1], shortcut: platformShortcut(keys) };
}

export function installTooltips(root = document) {
  let tip = null,
    target = null,
    timer = null,
    watch = null,
    pending = null,
    hidden = 0;
  const element = () => {
    if (tip?.isConnected) return tip;
    tip = document.createElement("div");
    tip.className = "ui-tooltip";
    tip.setAttribute("role", "presentation");
    tip.setAttribute("aria-hidden", "true");
    tip.innerHTML = "<span></span><kbd></kbd>";
    document.body.append(tip);
    return tip;
  };
  function hide() {
    clearTimeout(timer);
    clearInterval(watch);
    timer = watch = pending = null;
    if (!target) return;
    const el = target;
    target = null;
    // The title comes back unless something gave the button a new one.
    if (el.dataset.tooltipTitle !== undefined) {
      if (!el.hasAttribute("title"))
        el.setAttribute("title", el.dataset.tooltipTitle);
      delete el.dataset.tooltipTitle;
    }
    if (tip) tip.hidden = true;
    hidden = performance.now();
  }
  function show(el) {
    // An unavailable button says why only when it was given a reason.
    const reason = el.disabled ? el.dataset.disabledReason : "";
    if (!el.isConnected || (el.disabled && !reason)) return;
    const text = el.getAttribute("title") || el.getAttribute("aria-label");
    if (!text) return;
    target = el;
    if (el.hasAttribute("title")) {
      el.dataset.tooltipTitle = el.getAttribute("title");
      el.removeAttribute("title");
    }
    const { label, shortcut } = tooltipParts(text);
    const box = element();
    box.firstElementChild.textContent = reason ? `${label}. ${reason}` : label;
    box.lastElementChild.textContent = shortcut;
    box.lastElementChild.hidden = !shortcut || !!reason;
    box.hidden = false;
    const r = el.getBoundingClientRect(),
      size = box.getBoundingClientRect(),
      gap = 8,
      margin = 6;
    // Beside the tool rail, above the bottom bars, below everything else.
    // Undo and Redo stand under the tools on wider screens and in the
    // bottom bar on phones.
    const side =
      el.closest(".tools") ||
      (el.closest(".history-tools") && window.innerWidth > 760)
        ? "right"
        : el.closest(".canvas-bottom, .history-tools") ||
            r.bottom + gap + size.height > window.innerHeight
          ? "top"
          : "bottom";
    let x =
        side === "right"
          ? r.right + gap
          : r.left + r.width / 2 - size.width / 2,
      y =
        side === "right"
          ? r.top + r.height / 2 - size.height / 2
          : side === "top"
            ? r.top - gap - size.height
            : r.bottom + gap;
    x = Math.max(margin, Math.min(window.innerWidth - size.width - margin, x));
    y = Math.max(
      margin,
      Math.min(window.innerHeight - size.height - margin, y),
    );
    box.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    // A toolbar drawn again replaces its buttons; the tooltip goes with it.
    watch = setInterval(() => {
      if (!target?.isConnected) hide();
    }, 250);
  }
  root.addEventListener(
    "pointerover",
    (e) => {
      if (e.pointerType !== "mouse") return;
      const el = e.target.closest?.(SELECTOR);
      if (!el || el === target || el.closest("dialog")) return;
      hide();
      const warm = performance.now() - hidden < WARM;
      pending = el;
      timer = setTimeout(() => show(el), warm ? 0 : DELAY);
    },
    true,
  );
  root.addEventListener(
    "pointerout",
    (e) => {
      // The button lost its title while showing, so it is found by name.
      const el = target || pending;
      if (!el?.contains(e.target) || el.contains(e.relatedTarget)) return;
      hide();
    },
    true,
  );
  // Pressing, scrolling, typing or leaving the window ends it, as the
  // button may move or go.
  for (const type of ["pointerdown", "wheel", "keydown"])
    root.addEventListener(type, hide, true);
  window.addEventListener("blur", hide);
  return { hide };
}

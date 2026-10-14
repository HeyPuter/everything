// The Text Pane: a SmartArt graphic's text as a bulleted outline beside the
// slide. Enter starts a new item, Tab and Shift+Tab move an item in and out
// a level, Backspace at the start of an item joins it to the one before, and
// the graphic follows as you type.
import { el, icon } from "../ui.js";
import { fitToViewport } from "../charts/chart-sheet.js";
import {
  indentLine,
  joinWithPrevious,
  normalize,
  splitItem,
} from "./outline.js";

// `read()` gives the graphic's items now (null once it is gone), `write(items)`
// applies new ones; `onCurrent(index)` hears the item being edited.
export function openTextPane({ title, about, read, write, onCurrent }) {
  let items = read();
  if (!items) return null;
  if (!items.length) items = [{ text: "", level: 0 }];
  let current = 0;
  let timer = null;
  let disposed = false;
  let onClose = null;

  const list = el("ul", {
    class: "smartart-outline",
    role: "list",
    "aria-label": "Graphic text",
  });
  const panel = el(
    "section",
    {
      class: "chart-sheet smartart-pane",
      role: "dialog",
      "aria-modal": "false",
      "aria-labelledby": "smartart-pane-title",
      tabindex: -1,
    },
    el(
      "div",
      { class: "chart-sheet-head" },
      el(
        "h2",
        { class: "chart-sheet-title", id: "smartart-pane-title" },
        title,
      ),
      el(
        "button",
        {
          type: "button",
          class: "btn icon-btn",
          "aria-label": "Close Text Pane",
          title: "Close Text Pane",
          onclick: () => close(),
        },
        icon("X", 16),
      ),
    ),
    el("div", { class: "chart-sheet-scroll smartart-outline-scroll" }, list),
    el(
      "p",
      { class: "chart-sheet-hint helper" },
      "Enter adds an item. Tab and Shift+Tab move it in or out a level.",
    ),
    el("p", { class: "smartart-pane-about helper" }, about || ""),
  );
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
  dragBy(panel.querySelector(".chart-sheet-head"), panel);

  function draw() {
    list.replaceChildren(
      ...items.map((item, i) =>
        el(
          "li",
          {
            class: "smartart-outline-item",
            style: `--level:${item.level}`,
            "data-level": item.level,
          },
          el("span", { class: "smartart-bullet", "aria-hidden": "true" }),
          el("input", {
            class: "smartart-outline-input",
            value: item.text,
            placeholder: "[Text]",
            "aria-label": `Item ${i + 1}, level ${item.level + 1}`,
            "data-index": i,
            onfocus: () => {
              current = i;
              onCurrent?.(i);
            },
            oninput: (e) => {
              items[i] = { ...items[i], text: e.target.value };
              schedule();
            },
            onkeydown: (e) => key(e, i),
          }),
        ),
      ),
    );
  }
  function focusItem(i, caret = null) {
    const input = list.querySelector(`input[data-index="${i}"]`);
    if (!input) return;
    input.focus();
    const at = caret == null ? input.value.length : caret;
    input.setSelectionRange(at, at);
  }
  function change(result, { caret = null } = {}) {
    items = normalize(result.items);
    current = result.index;
    draw();
    focusItem(current, result.caret ?? caret);
    commitNow();
  }
  function key(e, i) {
    const input = e.currentTarget;
    const caret = input.selectionStart ?? input.value.length;
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      change(splitItem(items, i, caret));
    } else if (e.key === "Tab") {
      e.preventDefault();
      const before = items[i].level;
      const result = indentLine(items, i, e.shiftKey ? -1 : 1);
      if (result.items[i].level !== before) change(result, { caret });
    } else if (
      e.key === "Backspace" &&
      caret === 0 &&
      input.selectionEnd === 0 &&
      i > 0
    ) {
      e.preventDefault();
      change(joinWithPrevious(items, i));
    } else if (e.key === "ArrowUp" && i > 0) {
      e.preventDefault();
      focusItem(i - 1);
    } else if (e.key === "ArrowDown" && i < items.length - 1) {
      e.preventDefault();
      focusItem(i + 1);
    }
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => commitNow(), 250);
  }
  function commitNow() {
    clearTimeout(timer);
    timer = null;
    write(items.map((x) => ({ ...x })));
  }
  // The graphic changed elsewhere (the ribbon, undo): show its outline.
  function sync() {
    if (disposed || timer) return;
    const now = read();
    if (!now) {
      close();
      return;
    }
    if (JSON.stringify(now) === JSON.stringify(items)) return;
    const typing = panel.contains(document.activeElement);
    const caret = typing ? document.activeElement.selectionStart : null;
    items = now.length ? now : [{ text: "", level: 0 }];
    current = Math.min(current, items.length - 1);
    draw();
    if (typing) focusItem(current, caret);
  }
  function close() {
    if (disposed) return;
    if (timer) commitNow();
    disposed = true;
    panel.remove();
    onClose?.();
  }
  draw();
  document.body.append(panel);
  fitToViewport(panel);
  requestAnimationFrame(() => focusItem(0));
  return {
    panel,
    sync,
    close,
    focusItem,
    get current() {
      return current;
    },
    set current(i) {
      current = i;
    },
    set onClose(fn) {
      onClose = fn;
    },
    get open() {
      return !disposed;
    },
  };
}

function dragBy(handle, panel) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const rect = panel.getBoundingClientRect();
    const dx = e.clientX - rect.left,
      dy = e.clientY - rect.top;
    handle.setPointerCapture(e.pointerId);
    const moveTo = (ev) => {
      panel.style.left = `${Math.max(0, Math.min(window.innerWidth - rect.width, ev.clientX - dx))}px`;
      panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy))}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    };
    const up = () => {
      handle.removeEventListener("pointermove", moveTo);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", moveTo);
    handle.addEventListener("pointerup", up);
  });
}

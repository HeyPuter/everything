// Arrange and edit commands: the Size and Rotation dialog, Regroup, the
// align-to choice, the Selection Pane's list (rename, drag to reorder, show
// and hide all), Replace Fonts, and Paste Special.
import { el, icon } from "../ui.js";
import {
  IN,
  checkField,
  formatDialog,
  numberField,
  selectField,
} from "./controls.js";

/** The Size and Rotation dialog. Resolves to the new values or null. */
export async function sizeRotationDialog({ bounds, rotation, locked }) {
  let w = bounds.w / IN,
    h = bounds.h / IN,
    rot = rotation,
    lock = locked;
  const ratio = bounds.w / Math.max(1, bounds.h);
  let widthInput, heightInput;
  const body = el(
    "div",
    { class: "fmt-stack" },
    el(
      "div",
      { class: "fmt-row" },
      (heightInput = numberField({
        label: "Height",
        value: h,
        unit: "in",
        min: 0.01,
        max: 200,
        step: 0.1,
        onCommit: (n) => {
          h = n;
          if (lock) {
            w = n * ratio;
            widthInput.querySelector("input").value = String(
              Math.round(w * 100) / 100,
            );
          }
        },
      })),
      (widthInput = numberField({
        label: "Width",
        value: w,
        unit: "in",
        min: 0.01,
        max: 200,
        step: 0.1,
        onCommit: (n) => {
          w = n;
          if (lock) {
            h = n / ratio;
            heightInput.querySelector("input").value = String(
              Math.round(h * 100) / 100,
            );
          }
        },
      })),
    ),
    numberField({
      label: "Rotation",
      value: rot,
      unit: "°",
      min: -360,
      max: 360,
      step: 1,
      onCommit: (n) => (rot = n),
    }),
    checkField({
      label: "Lock aspect ratio",
      checked: lock,
      onChange: (on) => (lock = on),
    }),
  );
  const ok = await formatDialog({ title: "Size and Rotation", body });
  if (!ok) return null;
  const cx = bounds.x + bounds.w / 2,
    cy = bounds.y + bounds.h / 2;
  const nw = Math.round(w * IN),
    nh = Math.round(h * IN);
  return {
    bounds: {
      x: Math.round(cx - nw / 2),
      y: Math.round(cy - nh / 2),
      w: nw,
      h: nh,
    },
    rotation: ((rot % 360) + 360) % 360,
    locked: lock,
  };
}

/** The Replace Fonts dialog: resolves to { from, to } or null. */
export async function replaceFontsDialog({ used, fonts }) {
  if (!used.length) return null;
  let from = used[0];
  let to = fonts.find((f) => f !== from) || fonts[0];
  const listId = "fmt-replace-fonts-list";
  const input = el("input", {
    class: "input",
    list: listId,
    value: to,
    "aria-label": "With",
    oninput: (e) => (to = e.target.value),
  });
  const body = el(
    "div",
    { class: "fmt-stack" },
    selectField({
      label: "Replace",
      value: from,
      options: used.map((f) => [f, f]),
      onChange: (v) => (from = v),
    }),
    el(
      "label",
      { class: "fmt-field" },
      el("span", { class: "fmt-label" }, "With"),
      input,
      el(
        "datalist",
        { id: listId },
        ...fonts.map((f) => el("option", { value: f })),
      ),
    ),
  );
  const ok = await formatDialog({
    title: "Replace Fonts",
    body,
    okLabel: "Replace",
  });
  return ok && to.trim() && to.trim() !== from ? { from, to: to.trim() } : null;
}

export const PASTE_FORMATS = [
  ["destination", "Objects, using this presentation's theme"],
  ["source", "Objects, keeping their formatting"],
  ["picture", "Picture (PNG)"],
  ["text", "Unformatted text"],
  ["html", "Formatted text (HTML)"],
];

/** Paste Special: resolves to one of PASTE_FORMATS' ids, or null. */
export async function pasteSpecialDialog({ available }) {
  let choice = available[0];
  const group = el("div", {
    class: "fmt-radio-list",
    role: "radiogroup",
    "aria-label": "Paste as",
  });
  for (const [id, label] of PASTE_FORMATS) {
    const enabled = available.includes(id);
    group.append(
      el(
        "label",
        { class: `fmt-radio${enabled ? "" : " disabled"}` },
        el("input", {
          type: "radio",
          name: "paste-format",
          value: id,
          checked: id === choice,
          disabled: !enabled,
          onchange: () => (choice = id),
        }),
        el("span", {}, label),
      ),
    );
  }
  const ok = await formatDialog({
    title: "Paste Special",
    body: el(
      "div",
      { class: "fmt-stack" },
      el(
        "p",
        { class: "helper" },
        "Choose how the clipboard's contents arrive.",
      ),
      group,
    ),
    okLabel: "Paste",
  });
  return ok ? choice : null;
}

/** Paragraphs of formatted runs from clipboard HTML: [{ runs: [{ text, format }] }]. */
export function htmlParagraphs(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const paragraphs = [];
  let current = { runs: [] };
  const BLOCKS = new Set([
    "P",
    "DIV",
    "LI",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "TR",
    "BLOCKQUOTE",
    "PRE",
  ]);
  const flush = () => {
    if (current.runs.some((r) => r.text.trim())) paragraphs.push(current);
    current = { runs: [] };
  };
  const walk = (node, format) => {
    if (node.nodeType === 3) {
      const text = node.data.replace(/\s+/g, " ");
      if (text) current.runs.push({ text, format: { ...format } });
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (["SCRIPT", "STYLE", "HEAD", "TITLE"].includes(tag)) return;
    if (tag === "BR") return flush();
    const next = { ...format };
    if (tag === "B" || tag === "STRONG" || /^H\d$/.test(tag)) next.bold = true;
    if (tag === "I" || tag === "EM") next.italic = true;
    if (tag === "U") next.underline = true;
    if (tag === "S" || tag === "STRIKE" || tag === "DEL") next.strike = true;
    const style = node.getAttribute?.("style") || "";
    if (/font-weight:\s*(bold|[6-9]00)/i.test(style)) next.bold = true;
    if (/font-style:\s*italic/i.test(style)) next.italic = true;
    const color = /(?:^|;)\s*color:\s*(#[0-9a-f]{6}|#[0-9a-f]{3})\b/i.exec(
      style,
    );
    if (color) next.color = color[1].toUpperCase();
    const block = BLOCKS.has(tag);
    if (block) flush();
    for (const child of node.childNodes) walk(child, next);
    if (block) flush();
  };
  walk(doc.body, {});
  flush();
  for (const p of paragraphs) {
    p.runs[0].text = p.runs[0].text.replace(/^\s+/, "");
    p.runs.at(-1).text = p.runs.at(-1).text.replace(/\s+$/, "");
    p.runs = p.runs.filter((r) => r.text);
  }
  return paragraphs.filter((p) => p.runs.length);
}

/**
 * The Selection Pane's list: every object top of the stack first, with
 * show/hide, rename (double-click or F2), drag or Alt+arrow to reorder, and
 * Show All / Hide All. `ctx`: { items(): [{ id, label, hidden, selected }],
 * select(id, extend), setHidden(id, on), setAllHidden(on), rename(id, name),
 * moveTo(id, index) (index counted from the top), close() }.
 */
export function selectionPaneContent(ctx) {
  const items = ctx.items();
  const list = el("ul", {
    class: "selection-list",
    role: "listbox",
    "aria-label": "Objects on this slide",
    "aria-multiselectable": "true",
  });
  let dragId = null;
  items.forEach((item, index) => {
    const name = el(
      "button",
      {
        type: "button",
        class: "selection-name",
        title:
          "Double-click or press F2 to rename. Alt+Up and Alt+Down reorder.",
        onclick: (e) =>
          ctx.select(item.id, e.shiftKey || e.metaKey || e.ctrlKey),
        ondblclick: () => startRename(),
        onkeydown: (e) => {
          if (e.key === "F2") {
            e.preventDefault();
            startRename();
          } else if (
            e.altKey &&
            (e.key === "ArrowUp" || e.key === "ArrowDown")
          ) {
            e.preventDefault();
            ctx.moveTo(
              item.id,
              Math.max(
                0,
                Math.min(
                  items.length - 1,
                  index + (e.key === "ArrowUp" ? -1 : 1),
                ),
              ),
            );
          }
        },
      },
      item.label,
    );
    const row = el(
      "li",
      {
        role: "option",
        "aria-selected": String(item.selected),
        class: item.hidden ? "hidden-object" : "",
        draggable: "true",
        "data-id": item.id,
        ondragstart: (e) => {
          dragId = item.id;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(item.id));
        },
        ondragover: (e) => {
          if (dragId == null) return;
          e.preventDefault();
          row.classList.add("drop-target");
        },
        ondragleave: () => row.classList.remove("drop-target"),
        ondrop: (e) => {
          e.preventDefault();
          row.classList.remove("drop-target");
          if (dragId != null && dragId !== item.id) ctx.moveTo(dragId, index);
          dragId = null;
        },
      },
      el("span", { class: "selection-grip", "aria-hidden": "true" }),
      name,
      el(
        "button",
        {
          type: "button",
          class: "selection-eye",
          "aria-label": `${item.hidden ? "Show" : "Hide"} ${item.label}`,
          "aria-pressed": String(!item.hidden),
          onclick: () => ctx.setHidden(item.id, !item.hidden),
        },
        icon(item.hidden ? "EyeOff" : "Eye", 15),
      ),
    );
    function startRename() {
      const input = el("input", {
        class: "input selection-rename",
        value: item.label,
        "aria-label": `Rename ${item.label}`,
      });
      const finish = (save) => {
        const value = input.value.trim();
        input.replaceWith(name);
        if (save && value && value !== item.label) ctx.rename(item.id, value);
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => input.isConnected && finish(true));
      name.replaceWith(input);
      input.focus();
      input.select();
    }
    list.append(row);
  });
  return [
    el(
      "div",
      { class: "selection-actions" },
      el(
        "button",
        {
          type: "button",
          class: "btn secondary small",
          onclick: () => ctx.setAllHidden(false),
          disabled: !items.length,
        },
        "Show All",
      ),
      el(
        "button",
        {
          type: "button",
          class: "btn secondary small",
          onclick: () => ctx.setAllHidden(true),
          disabled: !items.length,
        },
        "Hide All",
      ),
    ),
    items.length
      ? list
      : el("p", { class: "helper" }, "There are no objects on this slide."),
  ];
}

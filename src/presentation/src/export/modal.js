// A modal dialog shell for the file dialogs (export, print, properties,
// pictures), and the small form controls they share. It follows the app's
// own dialogs: a heading with a close button, a body, and a row of actions.

import { el, iconButton, button } from "../ui.js";

let uid = 0;
export const nextId = (prefix) => `${prefix}-${++uid}`;

// actions: [{ label, kind, onClick, id }] — onClick returning true closes.
export function openModal({
  title,
  className = "",
  body,
  actions = [],
  onClose,
}) {
  const before = document.activeElement;
  const titleId = nextId("file-dialog-title");
  const d = el("dialog", {
    class: `dialog file-dialog ${className}`,
    "aria-labelledby": titleId,
  });
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    onClose?.(result);
    d.close();
    d.remove();
    if (before?.isConnected) before.focus?.();
  };
  const buttons = actions.map((a) => {
    const b = button(
      a.label,
      null,
      async () => {
        if (b.disabled) return;
        const result = await a.onClick?.();
        if (result === true) close(a.value ?? true);
      },
      a.kind || "secondary",
      a.id ? { id: a.id } : {},
    );
    return b;
  });
  d.append(
    el(
      "div",
      { class: "dialog-head" },
      el("h2", { id: titleId }, title),
      iconButton("Close", "X", () => close(null)),
    ),
    body,
    el("div", { class: "dialog-actions" }, ...buttons),
  );
  d.addEventListener("cancel", (e) => {
    e.preventDefault();
    close(null);
  });
  document.body.append(d);
  d.showModal();
  return { dialog: d, close, buttons };
}

export function selectField(label, options, value, attrs = {}) {
  const id = nextId("file-field");
  const select = el(
    "select",
    { class: "input", id, ...attrs },
    ...options.map(([v, text, disabled]) =>
      el("option", { value: v, disabled: !!disabled }, text),
    ),
  );
  select.value = String(value);
  const wrap = el(
    "div",
    { class: "file-field" },
    el("label", { for: id }, label),
    select,
  );
  return { wrap, input: select };
}

export function textField(label, value = "", attrs = {}) {
  const id = nextId("file-field");
  const input = el(attrs.multiline ? "textarea" : "input", {
    class: "input",
    id,
    value,
    ...(attrs.multiline ? { rows: 3 } : { type: attrs.type || "text" }),
    ...Object.fromEntries(
      Object.entries(attrs).filter(([k]) => !["multiline", "type"].includes(k)),
    ),
  });
  const wrap = el(
    "div",
    { class: "file-field" },
    el("label", { for: id }, label),
    input,
  );
  return { wrap, input };
}

export function checkField(label, checked = false, attrs = {}) {
  const input = el("input", { type: "checkbox", checked, ...attrs });
  const wrap = el(
    "label",
    { class: "check-field file-check" },
    input,
    el("span", {}, label),
  );
  return { wrap, input };
}

// A group of radio buttons; `value()` reads the choice.
export function radioGroup(label, name, options, value) {
  const inputs = [];
  const group = el(
    "fieldset",
    { class: "file-radios" },
    el("legend", {}, label),
    ...options.map(([v, text, extra]) => {
      const input = el("input", {
        type: "radio",
        name,
        value: v,
        checked: String(v) === String(value),
      });
      inputs.push(input);
      return el(
        "label",
        { class: "file-radio" },
        input,
        el("span", {}, text),
        extra || null,
      );
    }),
  );
  return {
    wrap: group,
    inputs,
    value: () => inputs.find((i) => i.checked)?.value ?? null,
    set: (v) => inputs.forEach((i) => (i.checked = i.value === String(v))),
  };
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

// A progress line for long exports: a bar and a message read out politely.
export function progressLine() {
  const bar = el("progress", { max: 1, value: 0, "aria-label": "Progress" });
  const text = el("span", { class: "file-progress-text", role: "status" });
  const wrap = el("div", { class: "file-progress", hidden: true }, bar, text);
  return {
    wrap,
    show(message) {
      wrap.hidden = false;
      bar.value = 0;
      text.textContent = message;
    },
    set(fraction, message) {
      bar.value = Math.max(0, Math.min(1, fraction || 0));
      if (message) text.textContent = message;
    },
    hide() {
      wrap.hidden = true;
    },
  };
}

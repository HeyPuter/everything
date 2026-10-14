import { t } from "./i18n.js";

// The commands a right-click offers, in sections. Entries come from the
// command list, so labels, shortcuts and availability match the command
// palette; whatever the selection cannot do is left out, not greyed.
const OBJECT_MENU = [
  ["open-link"],
  ["clipboard:copy", "clipboard:cut", "clipboard:paste", "duplicate", "delete"],
  ["front", "forward", "backward", "back"],
  ["arrange:group", "arrange:ungroup", "lock"],
  ["copy-style", "paste-style", "copy-image", "copy-object-link"],
  ["save-snippet", "hide-objects", "show-objects"],
  ["add-comment"],
  // Offered while frames are selected, as Miro's frame menu does.
  ["frames:present", "frames:export"],
];
// Align and distribute, from the selection toolbar's Align button.
export const ALIGN_MENU = [
  ["arrange:left", "arrange:center", "arrange:right"],
  ["arrange:top", "arrange:middle", "arrange:bottom"],
  ["arrange:horizontal", "arrange:vertical"],
];
const CANVAS_MENU = [
  ["clipboard:paste", "select-all"],
  ["undo", "redo"],
  ["unlock-all"],
];
const ICONS = {
  "open-link": "external-link",
  "clipboard:copy": "copy",
  "clipboard:cut": "scissors",
  "clipboard:paste": "clipboard-paste",
  duplicate: "copy-plus",
  delete: "trash-2",
  front: "bring-to-front",
  forward: "arrow-up",
  backward: "arrow-down",
  back: "send-to-back",
  "arrange:group": "group",
  "arrange:ungroup": "ungroup",
  lock: "lock-keyhole",
  "copy-style": "copy-check",
  "paste-style": "paint-roller",
  "copy-image": "image",
  "copy-object-link": "link",
  "add-comment": "message-square",
  "frames:present": "presentation",
  "frames:export": "download",
  "save-snippet": "layout-template",
  "hide-objects": "eye-off",
  "show-objects": "eye",
  "select-all": "scan",
  undo: "undo-2",
  redo: "redo-2",
  "unlock-all": "unlock",
  "arrange:left": "align-start-vertical",
  "arrange:center": "align-center-vertical",
  "arrange:right": "align-end-vertical",
  "arrange:top": "align-start-horizontal",
  "arrange:middle": "align-center-horizontal",
  "arrange:bottom": "align-end-horizontal",
  "arrange:horizontal": "align-horizontal-distribute-center",
  "arrange:vertical": "align-vertical-distribute-center",
};

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const mac = () =>
  /mac|iphone|ipad/i.test(
    globalThis.navigator?.userAgentData?.platform ||
      globalThis.navigator?.platform ||
      "",
  );
// Named keys as the interface language writes them, as the keyboard
// shortcuts list does: "Maj" and "Entrée" in French.
const NAMED_KEYS = new Set([
  "Shift",
  "Enter",
  "Backspace",
  "Delete",
  "Minus",
  "Up",
  "Down",
]);
const keyName = (key) => (NAMED_KEYS.has(key) ? t(key, "key") : key);
export const shortcutKeys = (shortcut) =>
  shortcut.split("+").map(keyName).join("+");
// "Ctrl/Cmd+Shift+]" reads ⇧⌘] on a Mac and Ctrl+Shift+] elsewhere.
export function platformShortcut(shortcut, apple = mac()) {
  if (!shortcut) return "";
  const parts = shortcut.split("+"),
    key = parts.pop() || "+";
  if (!apple)
    return [
      ...parts.map((part) =>
        part === "Ctrl/Cmd"
          ? "Ctrl"
          : part === "Alt/Option"
            ? "Alt"
            : keyName(part),
      ),
      keyName(key),
    ].join("+");
  const symbols = { "Alt/Option": "⌥", Shift: "⇧", "Ctrl/Cmd": "⌘" };
  return (
    ["Alt/Option", "Shift", "Ctrl/Cmd"]
      .filter((part) => parts.includes(part))
      .map((part) => symbols[part])
      .join("") + (key === "Delete" ? "⌫" : keyName(key))
  );
}

export function contextMenuSections(entries, scope) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return (
    Array.isArray(scope)
      ? scope
      : scope === "object"
        ? OBJECT_MENU
        : CANVAS_MENU
  )
    .map((section) =>
      section
        .map((id) => byId.get(id))
        .filter((entry) => entry && !entry.disabled),
    )
    .filter((section) => section.length);
}

export function createContextMenu(api) {
  let menu = null,
    restore = null,
    anchor = null;
  const items = () => [...(menu?.querySelectorAll('[role="menuitem"]') || [])];
  function close(focus = false) {
    if (!menu) return;
    const open = menu;
    menu = null;
    open.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("wheel", outside, true);
    window.removeEventListener("resize", dismiss);
    window.removeEventListener("blur", dismiss);
    if (focus) (restore || api.focusCanvas)();
    restore = anchor = null;
  }
  const dismiss = () => close();
  // A press on the button that opened the menu is left to that button,
  // which closes it.
  const outside = (e) => {
    if (!menu?.contains(e.target) && !anchor?.contains(e.target)) close();
  };
  function move(step, from) {
    const list = items();
    if (!list.length) return;
    const at = list.indexOf(from ?? document.activeElement);
    const next =
      step === "first"
        ? 0
        : step === "last"
          ? list.length - 1
          : (Math.max(at, step > 0 ? -1 : 0) + step + list.length) %
            list.length;
    list[next].focus({ preventScroll: true });
  }
  function open({ x, y, scope, focus = false, from = null }) {
    close();
    const sections = contextMenuSections(api.entries(), scope);
    if (!sections.length) return false;
    const host = api.host();
    if (!host) return false;
    anchor = from;
    restore = from
      ? () =>
          from.isConnected
            ? from.focus({ preventScroll: true })
            : api.focusCanvas()
      : api.focusCanvas;
    menu = document.createElement("div");
    menu.id = "context-menu";
    menu.className = "context-menu";
    menu.tabIndex = -1;
    menu.setAttribute("role", "menu");
    menu.setAttribute(
      "aria-label",
      t(
        Array.isArray(scope)
          ? "Align and distribute"
          : scope === "object"
            ? "Object actions"
            : "Board actions",
      ),
    );
    menu.innerHTML = sections
      .map((section) =>
        section
          .map((entry) => {
            const keys = platformShortcut(entry.shortcut);
            return `<button type="button" class="menu-item" role="menuitem" tabindex="-1" data-command="${escape(entry.id)}">${api.icon(ICONS[entry.id] || "circle")}<span>${escape(entry.label)}</span>${keys ? `<kbd aria-hidden="true">${escape(keys)}</kbd>` : ""}</button>`;
          })
          .join(""),
      )
      .join('<div class="context-menu-separator" role="separator"></div>');
    menu.addEventListener("click", (e) => {
      const button = e.target.closest("[data-command]");
      if (!button) return;
      const entry = api
        .entries()
        .find((candidate) => candidate.id === button.dataset.command);
      close(true);
      if (entry && !entry.disabled) api.run(entry, { x, y });
    });
    menu.addEventListener("contextmenu", (e) => e.preventDefault());
    menu.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") move(1);
      else if (e.key === "ArrowUp") move(-1);
      else if (e.key === "Home") move("first");
      else if (e.key === "End") move("last");
      else if (e.key === "Escape") close(true);
      else if (e.key === "Tab") close(true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    // The menu opens down and to the right of the press, as menus do, and
    // stays inside the board: it opens to the left where the right side is
    // too narrow, and moves up only as far as it must.
    menu.style.left = "0px";
    menu.style.top = "0px";
    host.append(menu);
    api.refresh?.();
    const frame = host.getBoundingClientRect(),
      size = menu.getBoundingClientRect(),
      margin = 8,
      width = size.width || 224,
      height = size.height || 0,
      right = (frame.right || window.innerWidth) - margin,
      bottom = (frame.bottom || window.innerHeight) - margin,
      left = x + width > right ? x - width : x,
      top = Math.min(y, bottom - height);
    menu.style.left = `${Math.max(frame.left + margin, left) - frame.left}px`;
    menu.style.top = `${Math.max(frame.top + margin, top) - frame.top}px`;
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("wheel", outside, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    // A pointer leaves the menu itself focused, so arrow keys work at once;
    // the keyboard starts on the first command.
    if (focus) move("first");
    else menu.focus?.({ preventScroll: true });
    return true;
  }
  return { open, close, isOpen: () => !!menu?.isConnected };
}

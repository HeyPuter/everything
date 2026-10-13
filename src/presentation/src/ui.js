import {
  createElement,
  Presentation,
  Plus,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Upload,
  FolderOpen,
  Search,
  Cloud,
  CloudOff,
  Check,
  X,
  MoreHorizontal,
  Copy,
  Trash2,
  Download,
  Play,
  Undo2,
  Redo2,
  Type,
  Image,
  Square,
  Circle,
  Bold,
  Italic,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Settings2,
  Moon,
  Sun,
  Monitor,
  Pointer,
  LogOut,
  User,
  LayoutTemplate,
  ArrowUp,
  ArrowDown,
  PanelLeft,
  PanelRight,
  FileText,
  Maximize,
  Minimize,
  Grip,
  Keyboard,
  Palette,
  Pencil,
  Save,
  Printer,
  HelpCircle,
  Eye,
  EyeOff,
  Scissors,
  ClipboardPaste,
  CopyPlus,
  BringToFront,
  SendToBack,
  FilePlus,
  Info,
  Layers,
  Blend,
  IndentIncrease,
  IndentDecrease,
  Underline,
  Strikethrough,
  TextAlignJustify,
  List,
  ListOrdered,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalSpaceAround,
  Baseline,
  ALargeSmall,
  Triangle,
  Diamond,
  Pentagon,
  Hexagon,
  Octagon,
  Star,
  Heart,
  MessageSquare,
  SquareRoundCorner,
  ArrowLeftRight,
  Minus,
  MoveRight,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  Group,
  Ungroup,
  SquareDashedMousePointer,
  Timer,
  ZoomIn,
  ZoomOut,
  Link,
  Replace,
  FlipHorizontal2,
  FlipVertical2,
  Table,
  Film,
  CaseSensitive,
  ChevronUp,
  ChartColumn,
  Sparkles,
  SquarePen,
  LoaderCircle,
  Clock,
  CircleAlert,
  Ban,
  EllipsisVertical,
} from "lucide";
import { commandIcon } from "./chrome/icons.js";
const icons = {
  Presentation,
  Plus,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Upload,
  FolderOpen,
  Search,
  Cloud,
  CloudOff,
  Check,
  X,
  MoreHorizontal,
  Copy,
  Trash2,
  Download,
  Play,
  Undo2,
  Redo2,
  Type,
  Image,
  Square,
  Circle,
  Bold,
  Italic,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Settings2,
  Moon,
  Sun,
  Monitor,
  Pointer,
  LogOut,
  User,
  LayoutTemplate,
  ArrowUp,
  ArrowDown,
  PanelLeft,
  PanelRight,
  FileText,
  Maximize,
  Minimize,
  Grip,
  Keyboard,
  Palette,
  Pencil,
  Save,
  Printer,
  HelpCircle,
  Eye,
  EyeOff,
  Scissors,
  ClipboardPaste,
  CopyPlus,
  BringToFront,
  SendToBack,
  FilePlus,
  Info,
  Layers,
  Blend,
  IndentIncrease,
  IndentDecrease,
  Underline,
  Strikethrough,
  TextAlignJustify,
  List,
  ListOrdered,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalSpaceAround,
  Baseline,
  ALargeSmall,
  Triangle,
  Diamond,
  Pentagon,
  Hexagon,
  Octagon,
  Star,
  Heart,
  MessageSquare,
  SquareRoundCorner,
  ArrowLeftRight,
  Minus,
  MoveRight,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  Group,
  Ungroup,
  SquareDashedMousePointer,
  Timer,
  ZoomIn,
  ZoomOut,
  Link,
  Replace,
  FlipHorizontal2,
  FlipVertical2,
  Table,
  Film,
  CaseSensitive,
  ChevronUp,
  ChartColumn,
  Sparkles,
  SquarePen,
  LoaderCircle,
  Clock,
  CircleAlert,
  Ban,
  EllipsisVertical,
};
// A name prefixed "o:" is one of the app's own command icons
// (src/chrome/icons.js); any other is a Lucide icon.
export function icon(name, size = 18) {
  if (typeof name === "string" && name.startsWith("o:")) {
    const own = commandIcon(name.slice(2), size);
    if (own) return own;
  }
  const svg = createElement(icons[name] || Presentation, {
    width: size,
    height: size,
    "stroke-width": 1.7,
    "aria-hidden": "true",
    focusable: "false",
  });
  return svg;
}
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on"))
      node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "text") node.textContent = value;
    else if (key === "value") {
      if (tag === "textarea") node.defaultValue = value;
      else node.value = value;
    } else if (key === "checked") node.checked = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false)
      node.append(
        child instanceof Node ? child : document.createTextNode(String(child)),
      );
  }
  return node;
}
export const button = (label, ic, handler, cls = "", attrs = {}) =>
  el(
    "button",
    {
      type: "button",
      class: `btn ${cls}`,
      onclick: handler,
      "aria-label": label || null,
      ...attrs,
    },
    ic && icon(ic),
    label && el("span", {}, label),
  );
export const iconButton = (label, ic, handler, attrs = {}) =>
  button("", ic, handler, "icon-btn", {
    "aria-label": label,
    title: label,
    ...attrs,
  });
let toastTimer;
// As a popover the message joins the top layer, so it shows above an open
// dialog or the slideshow rather than behind them.
const popover = (node, method) => {
  try {
    node[method]?.();
  } catch {}
};
// Browsers without popovers reject the pseudo-class; there the message stays
// an ordinary element.
const popoverOpen = (node) => {
  try {
    return node.matches(":popover-open");
  } catch {
    return false;
  }
};
export function toast(message) {
  const node = document.querySelector("#toast");
  node.textContent = message;
  node.classList.add("visible");
  // Re-entering the top layer puts the message above a dialog or slideshow
  // opened since it last showed.
  if (popoverOpen(node)) popover(node, "hidePopover");
  popover(node, "showPopover");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.remove("visible");
    popover(node, "hidePopover");
  }, 5000);
}
// `actions`, when given, replaces the cancel and confirm buttons with a
// choice of several: [{ label, value, kind }] where kind is "primary",
// "secondary", or "danger". The dialog then resolves to the chosen value,
// and to null when it is closed without a choice.
export async function dialog({
  title,
  body,
  confirm = "Done",
  cancel = "Cancel",
  danger = false,
  returnFocus,
  actions = null,
}) {
  return new Promise((resolve) => {
    const before = document.activeElement;
    const d = el("dialog", {
      class: "dialog",
      "aria-labelledby": "dialog-title",
    });
    const dismissed = actions ? null : false;
    const finish = (result) => {
      d.close();
      d.remove();
      (returnFocus ? returnFocus() : before)?.focus();
      resolve(result);
    };
    d.append(
      el(
        "div",
        { class: "dialog-head" },
        el("h2", { id: "dialog-title" }, title),
        iconButton("Close", "X", () => finish(dismissed)),
      ),
      body,
      el(
        "div",
        { class: "dialog-actions" },
        ...(actions
          ? actions.map(({ label, value, kind = "secondary" }) =>
              button(label, null, () => finish(value), kind),
            )
          : [
              cancel && button(cancel, null, () => finish(false), "secondary"),
              confirm &&
                button(
                  confirm,
                  null,
                  () => finish(true),
                  danger ? "danger" : "primary",
                ),
            ]),
      ),
    );
    d.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(dismissed);
    });
    d.addEventListener("submit", (e) => {
      e.preventDefault();
      if (confirm && !actions) finish(true);
    });
    // Enter in a field confirms the dialog. A form with more than one text or
    // number field submits on Enter only through a submit button, and the
    // confirm button sits outside the form, so the form gets one of its own.
    if (confirm && !actions && body instanceof HTMLFormElement)
      body.append(
        el("button", {
          type: "submit",
          hidden: true,
          tabindex: -1,
          "aria-hidden": "true",
        }),
      );
    document.body.append(d);
    d.showModal();
  });
}
export async function promptName(
  title,
  value,
  returnFocus,
  { keep = false, confirm = "Save" } = {},
) {
  const input = el("input", {
    class: "input",
    autofocus: true,
    value,
    maxlength: 180,
    "aria-label": "Presentation name",
  });
  const response = dialog({
    title,
    body: el("form", { class: "dialog-body" }, el("label", {}, "Name", input)),
    confirm,
    returnFocus,
  });
  input.select();
  const ok = await response;
  // A blank name is no name: the prompt ends as if cancelled.
  const name = input.value.trim();
  return ok && name && (keep || name !== value) ? name : null;
}
/* ---------- Menus ----------
 * Popover menus: the menu bar's menus, the toolbar's pickers, per-file and
 * per-slide options, and context menus. A menu can open another beside it,
 * and the two stay open together as one chain: Escape or Left closes the
 * innermost, an outside press or a chosen item closes them all, and focus
 * returns to whatever opened the outermost.
 *
 * items: [{ label, icon?, shortcut?, hint?, onSelect, disabled?, checked?, danger? },
 *         { label, icon?, items: [...] },   // a submenu
 *         { separator: true }, { header: "Label" }, { custom: HTMLElement }]
 */
const HOVER_OPEN_MS = 90;
const HOVER_CLOSE_MS = 220;
let chain = []; // the open menus, the outermost first
let hoverTimer = null;
let hoveredItem = null;
let listening = false;
export const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || "");
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";
/** Which open menu holds this node, or -1 for none. */
const panelAt = (node) =>
  node instanceof Node
    ? chain.findIndex((entry) => entry.panel.contains(node))
    : -1;
export function closeMenu() {
  closeFrom(0);
}
function closeFrom(index, { focus = true } = {}) {
  clearTimeout(hoverTimer);
  for (let i = chain.length - 1; i > index; i--)
    chain[i].dispose({ focus: false });
  if (index >= 0 && index < chain.length) chain[index].dispose({ focus });
}
export const isMenuOpen = () => chain.length > 0;
/** The element the outermost open menu is anchored to, or null. */
export const menuAnchor = () => chain[0]?.anchor || null;
export function dismissMenuWithin(container) {
  const anchor = menuAnchor();
  if (anchor && container.contains(anchor)) closeMenu();
}
const focusables = (panel) => [
  ...panel.querySelectorAll("button:not(:disabled), input, select"),
];
function focusIn(panel, i) {
  const enabled = focusables(panel);
  if (!enabled.length) return;
  enabled[((i % enabled.length) + enabled.length) % enabled.length].focus();
}
export function openMenu({
  anchor = null,
  items,
  x = null,
  y = null,
  align = "start",
  label = "Options",
  minWidth = null,
  onClose = null,
  contextual = false,
  focusFirst = true,
}) {
  // An anchor inside an open menu makes this a submenu of it; anything else
  // starts again from one menu.
  const parent = panelAt(anchor);
  if (parent === -1) closeMenu();
  else closeFrom(parent + 1, { focus: false });
  const panel = el("div", {
    class: `menu ${parent >= 0 ? "menu-sub" : ""}`,
    role: "menu",
    "aria-label": label,
    tabindex: -1,
  });
  if (minWidth) panel.style.minWidth = `${minWidth}px`;
  const depth = () => chain.findIndex((entry) => entry.panel === panel);
  function openChild(button, item, { focus }) {
    const at = depth();
    if (at === -1 || item.disabled) return;
    if (chain[at + 1]?.anchor === button) {
      // Already open from a hover: the keyboard steps into it.
      if (focus) focusIn(chain[at + 1].panel, 0);
      return;
    }
    closeFrom(at + 1, { focus: false });
    openMenu({
      anchor: button,
      items: item.items,
      label: String(item.label),
      minWidth: item.minWidth || null,
      focusFirst: focus,
    });
  }
  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      panel.append(el("div", { class: "menu-sep", role: "separator" }));
      continue;
    }
    if (item.header) {
      panel.append(
        el("div", { class: "menu-header", role: "presentation" }, item.header),
      );
      continue;
    }
    if (item.custom) {
      panel.append(item.custom);
      continue;
    }
    const isCheck = item.checked !== undefined;
    const opensChild = !!item.items?.length;
    const select = item.onSelect || item.action;
    const node = el(
      "button",
      {
        type: "button",
        role: isCheck ? "menuitemcheckbox" : "menuitem",
        "aria-checked": isCheck ? String(!!item.checked) : null,
        "aria-haspopup": opensChild ? "menu" : null,
        "aria-expanded": opensChild ? "false" : null,
        // A hint is a description, not part of the name.
        "aria-label": item.hint ? item.label : null,
        disabled: !!item.disabled,
        tabindex: -1,
        class: `menu-item ${item.danger ? "danger" : ""} ${item.checked ? "checked" : ""}`,
        onclick: () => {
          if (item.disabled) return;
          if (opensChild) {
            openChild(node, item, { focus: true });
            return;
          }
          closeFrom(0);
          select?.();
        },
        // Follow actual mouse movement. Boundary events also fire when a menu
        // appears or scrolls underneath a stationary pointer and must not take
        // over keyboard focus or open a submenu.
        onpointermove: (e) => {
          if (e.pointerType && e.pointerType !== "mouse") return;
          const at = depth();
          if (at === -1 || hoveredItem === node) return;
          clearTimeout(hoverTimer);
          hoveredItem = node;
          node.focus({ preventScroll: true });
          if (opensChild)
            hoverTimer = setTimeout(() => {
              if (node.isConnected) openChild(node, item, { focus: false });
            }, HOVER_OPEN_MS);
          else if (chain.length > at + 1)
            hoverTimer = setTimeout(
              () => closeFrom(at + 1, { focus: false }),
              HOVER_CLOSE_MS,
            );
        },
        onpointerleave: (e) => {
          if (e.pointerType && e.pointerType !== "mouse") return;
          if (hoveredItem !== node) return;
          // Cancel an unopened child. A previously scheduled close still
          // applies unless another item or the keyboard takes over.
          if (opensChild) clearTimeout(hoverTimer);
          hoveredItem = null;
        },
      },
      el(
        "span",
        { class: "menu-icon" },
        isCheck
          ? item.checked && icon("Check", 16)
          : item.icon && icon(item.icon, 17),
      ),
      el(
        "span",
        {
          class: "menu-label",
          // A font list shows each name in its own face.
          style: item.labelStyle || null,
        },
        item.label,
        item.hint && el("span", { class: "menu-hint" }, item.hint),
      ),
      item.shortcut &&
        el(
          "span",
          { class: "menu-shortcut", "aria-hidden": "true" },
          item.shortcut,
        ),
      opensChild &&
        el(
          "span",
          { class: "menu-arrow", "aria-hidden": "true" },
          icon("ChevronRight", 15),
        ),
    );
    panel.append(node);
  }
  // A submenu hands focus back to the item it opened from; any other menu
  // hands it back to whatever had it.
  const opener =
    parent >= 0 || contextual
      ? anchor
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : anchor;
  document.body.append(panel);
  const parentPanel = parent >= 0 ? chain[parent].panel : null;
  let anchorRect = anchor?.getBoundingClientRect();
  const reposition = () => {
    anchorRect = anchor?.getBoundingClientRect();
    position(panel, anchor, x, y, align, parentPanel);
  };
  reposition();
  function dispose({ focus = true } = {}) {
    const at = depth();
    if (at === -1) return;
    chain.splice(at, 1);
    if (panel.contains(hoveredItem)) hoveredItem = null;
    panel.remove();
    if (!contextual) anchor?.setAttribute?.("aria-expanded", "false");
    if (!chain.length) stopListening();
    if (focus && opener?.isConnected) opener.focus({ preventScroll: true });
    onClose?.();
  }
  if (!contextual && anchor) {
    anchor.setAttribute("aria-haspopup", "menu");
    anchor.setAttribute("aria-expanded", "true");
  }
  chain.push({
    panel,
    anchor,
    contextual,
    dispose,
    reposition,
    anchorRect: () => anchorRect,
  });
  startListening();
  if (focusFirst && focusables(panel).length) focusIn(panel, 0);
  else if (focusFirst) panel.focus();
  return {
    close: () => {
      const at = depth();
      if (at !== -1) closeFrom(at);
    },
    menu: panel,
  };
}
/* One set of listeners for the whole chain. */
function startListening() {
  if (listening) return;
  listening = true;
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);
}
function stopListening() {
  listening = false;
  clearTimeout(hoverTimer);
  hoveredItem = null;
  document.removeEventListener("pointerdown", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
  document.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", onResize);
}
function onOutside(e) {
  clearTimeout(hoverTimer);
  hoveredItem = null;
  if (panelAt(e.target) !== -1) return;
  // A press on the button that opened the menu is a request to close it;
  // the click that follows must not open it again. A context menu's anchor
  // is the surface it was asked for on, and a click there is its own.
  const anchor = chain[0]?.contextual ? null : chain[0]?.anchor;
  if (anchor && e.target instanceof Node && anchor.contains(e.target)) {
    const swallow = (event) => {
      event.stopImmediatePropagation();
      event.preventDefault();
    };
    anchor.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(
      () => anchor.removeEventListener("click", swallow, { capture: true }),
      600,
    );
  }
  closeMenu();
}
// The menus follow their anchors through a resize; a scroll that carries the
// anchor away closes them instead, leaving the scroll position alone.
function onResize() {
  for (const entry of chain) entry.reposition();
}
function onScroll(e) {
  if (panelAt(e.target) !== -1) return;
  const outer = chain[0];
  if (!outer?.anchor) return;
  const before = outer.anchorRect();
  const rect = outer.anchor.getBoundingClientRect();
  if (before && rect.top === before.top && rect.left === before.left) return;
  const restoreFocus = panelAt(document.activeElement) !== -1;
  const anchor = outer.anchor;
  closeFrom(0, { focus: false });
  if (restoreFocus) anchor.focus({ preventScroll: true });
}
function onKey(e) {
  if (e.isComposing || !chain.length) return;
  clearTimeout(hoverTimer);
  hoveredItem = null;
  // Keys belong to the menu the focus is in, and to the innermost one when
  // focus has gone elsewhere.
  const focused = panelAt(document.activeElement);
  const at = focused === -1 ? chain.length - 1 : focused;
  const panel = chain[at].panel;
  const enabled = focusables(panel);
  const index = enabled.indexOf(document.activeElement);
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    // The innermost menu closes first, even one a hover opened while the
    // focus stayed in its parent.
    closeFrom(Math.max(at, chain.length - 1));
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    closeMenu();
    return;
  }
  if (document.activeElement?.matches?.("input, select")) return;
  const parentItem = document.activeElement?.closest?.(
    '.menu-item[aria-haspopup="menu"]',
  );
  if (e.key === "ArrowRight" && parentItem) {
    e.preventDefault();
    e.stopPropagation();
    parentItem.click();
    return;
  }
  if (e.key === "ArrowLeft" && at > 0) {
    e.preventDefault();
    e.stopPropagation();
    closeFrom(at);
    return;
  }
  // Moving along a menu leaves behind a submenu its previous item opened.
  if (
    ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) &&
    chain.length > at + 1
  )
    closeFrom(at + 1, { focus: false });
  if (e.key === "ArrowDown") {
    e.preventDefault();
    focusIn(panel, index + 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    // From the panel itself, Up lands on the last item.
    focusIn(panel, index < 0 ? -1 : index - 1);
  } else if (e.key === "Home") {
    e.preventDefault();
    focusIn(panel, 0);
  } else if (e.key === "End") {
    e.preventDefault();
    focusIn(panel, -1);
  } else if (
    e.key.length === 1 &&
    /\S/.test(e.key) &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey
  ) {
    const ch = e.key.toLowerCase();
    for (let k = 0; k < enabled.length; k++) {
      const node = enabled[(index + 1 + k) % enabled.length];
      if (
        (node.getAttribute("aria-label") || node.textContent)
          .trim()
          .toLowerCase()
          .startsWith(ch)
      ) {
        node.focus();
        break;
      }
    }
  }
}
/**
 * Below the anchor, left edges aligned, by default. A menu that does not fit
 * below goes above when there is room there; otherwise it stays on the side
 * with more room and scrolls, so it never slides up over its own anchor (a
 * menu bar's other names must stay reachable while one menu is open). A
 * submenu opens beside its item instead, on whichever side it fits. A menu
 * opened at a point flips to the other side of the point when it would run
 * off the window, as native context menus do.
 */
function position(panel, anchor, x, y, align, parentPanel) {
  const pad = 8;
  const vw = document.documentElement.clientWidth;
  // A phone's toolbars can cover the bottom of the layout viewport; the
  // menu fits the part that shows.
  const vh = Math.min(
    window.innerHeight,
    window.visualViewport?.height || window.innerHeight,
  );
  panel.style.maxHeight = "";
  panel.style.overflowY = "";
  const rect = panel.getBoundingClientRect();
  let height = rect.height;
  let left, top;
  const cap = (h) => {
    height = Math.max(0, Math.floor(h));
    panel.style.maxHeight = `${height}px`;
    panel.style.overflowY = "auto";
  };
  if (parentPanel && anchor) {
    const a = anchor.getBoundingClientRect();
    const p = parentPanel.getBoundingClientRect();
    left = p.right - 1;
    if (left + rect.width > vw - pad) {
      const other = p.left - rect.width + 1;
      left = other >= pad ? other : p.left;
    }
    top = a.top - 6;
    if (height > vh - 2 * pad) cap(vh - 2 * pad);
  } else if (x != null && y != null) {
    left = x;
    top = y;
    if (top + height > vh - pad && y - height >= pad) top = y - height;
    if (left + rect.width > vw - pad && x - rect.width >= pad)
      left = x - rect.width;
  } else if (anchor) {
    const a = anchor.getBoundingClientRect();
    if (align === "auto")
      align = a.left + a.width / 2 > vw / 2 ? "end" : "start";
    left = align === "end" ? a.right - rect.width : a.left;
    top = a.bottom + 4;
    const below = vh - pad - top;
    const above = a.top - 4 - pad;
    if (height > below) {
      if (height <= above) top = a.top - 4 - height;
      else if (above > below) {
        cap(above);
        top = a.top - 4 - height;
      } else cap(below);
    }
  } else {
    left = (vw - rect.width) / 2;
    top = (vh - height) / 2;
  }
  if (height > vh - 2 * pad) cap(vh - 2 * pad);
  if (left + rect.width > vw - pad) left = Math.max(pad, vw - pad - rect.width);
  if (left < pad) left = pad;
  if (top + height > vh - pad) top = Math.max(pad, vh - pad - height);
  if (top < pad) top = pad;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}
// A menu below its button, or at a point (`at`) for a context menu. A context
// menu's anchor only takes the focus back when the menu closes; it is not a
// button that opens the menu, so it is not announced as one.
export function menu(
  anchor,
  items,
  { at = null, contextual = false, label = "Options" } = {},
) {
  return openMenu({
    anchor,
    items,
    x: at?.x ?? null,
    y: at?.y ?? null,
    label,
    contextual,
  }).menu;
}
/**
 * The menu bar under the presentation's title. Each name opens its menu
 * through the function given for it; the bar adds what a menu bar is expected
 * to do on its own. It is one tab stop, with Left and Right (or Home and End)
 * moving between the names and Down or Enter opening one. While a menu is
 * open, Left and Right switch to the neighboring menu, and so does sliding
 * the mouse along the bar.
 */
let menubarKeys = null;
export function createMenubar(entries, { label = "Menu bar" } = {}) {
  const bar = el("nav", {
    class: "menubar",
    role: "menubar",
    "aria-label": label,
  });
  const buttons = [];
  const wrap = (i) => ((i % buttons.length) + buttons.length) % buttons.length;
  const openIndex = () => buttons.indexOf(menuAnchor());
  const setTabStop = (i) =>
    buttons.forEach((b, k) => b.setAttribute("tabindex", k === i ? "0" : "-1"));
  const focusAt = (i) => buttons[wrap(i)].focus({ preventScroll: true });
  function open(i) {
    closeMenu();
    focusAt(i);
    entries[wrap(i)].open(buttons[wrap(i)]);
  }
  entries.forEach((entry, i) => {
    const btn = el(
      "button",
      {
        type: "button",
        class: "menu-btn",
        role: "menuitem",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        tabindex: i === 0 ? 0 : -1,
        onclick: () => open(i),
        onfocus: () => setTabStop(i),
        // A tap raises pointerenter before the press that would close the
        // menu again, so only the mouse sweeps between menus.
        onpointerenter: (e) => {
          if (e.pointerType !== "mouse" && e.pointerType) return;
          const at = openIndex();
          if (at !== -1 && at !== i) open(i);
        },
        onkeydown: (e) => {
          if (e.altKey || e.ctrlKey || e.metaKey) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            open(i);
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            focusAt(i + 1);
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            focusAt(i - 1);
          } else if (e.key === "Home") {
            e.preventDefault();
            focusAt(0);
          } else if (e.key === "End") {
            e.preventDefault();
            focusAt(-1);
          }
        },
      },
      entry.label,
    );
    buttons.push(btn);
    bar.append(btn);
  });
  // With a menu open, focus is in the popup; Left and Right there move along
  // the bar unless a submenu takes them. One bar exists at a time, so the
  // previous bar's listener goes when the next bar is built.
  if (menubarKeys) document.removeEventListener("keydown", menubarKeys, true);
  menubarKeys = (e) => {
    if (!bar.isConnected) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = openIndex();
    if (at === -1) return;
    if (document.activeElement?.matches?.("input, select, textarea")) return;
    const active = document.activeElement;
    if (e.key === "ArrowLeft" && panelAt(active) > 0) return;
    if (
      e.key === "ArrowRight" &&
      active?.closest?.('.menu-item[aria-haspopup="menu"]')
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    open(at + (e.key === "ArrowRight" ? 1 : -1));
  };
  document.addEventListener("keydown", menubarKeys, true);
  return { el: bar, buttons, open };
}

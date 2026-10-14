// The review panes beside the slide: comments, spelling, thesaurus,
// translation, accessibility, reading order and revisions. One is open at a
// time, in a column at the right of the editor (a sheet over the lower part
// of the screen on a phone). Each pane renders its body afresh when the deck
// changes; the field that had the focus, its text and its selection come
// back afterwards, so a refresh never interrupts typing.
import { el, iconButton } from "../ui.js";

export function createPaneHost({ onChange = () => {} } = {}) {
  const panes = new Map();
  let current = null;
  const title = el("h2", {
    class: "review-pane-title",
    id: "review-pane-title",
  });
  const tools = el("div", { class: "review-pane-tools" });
  const body = el("div", { class: "review-pane-body" });
  const node = el(
    "aside",
    {
      class: "review-pane",
      id: "review-pane",
      hidden: true,
      role: "complementary",
      "aria-labelledby": "review-pane-title",
      tabindex: -1,
      onkeydown: (e) => {
        if (
          e.key === "Escape" &&
          !e.defaultPrevented &&
          !e.target.closest(".menu")
        ) {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      },
    },
    el(
      "div",
      { class: "review-pane-head" },
      title,
      tools,
      iconButton("Close pane", "X", () => close(), {
        class: "btn icon-btn review-pane-close",
      }),
    ),
    body,
  );

  function register(id, pane) {
    panes.set(id, pane);
  }
  function render({ keepFocus = true } = {}) {
    const pane = panes.get(current);
    if (!pane) return;
    title.textContent =
      typeof pane.title === "function" ? pane.title() : pane.title;
    tools.replaceChildren(...(pane.tools?.() || []));
    // What had the focus, to give it back after the redraw.
    const active = document.activeElement;
    const key =
      keepFocus && node.contains(active) ? active?.dataset?.focusKey : null;
    const field =
      key && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")
        ? {
            value: active.value,
            start: active.selectionStart,
            end: active.selectionEnd,
          }
        : null;
    const scroll = body.scrollTop;
    const content = pane.render();
    body.replaceChildren(content);
    body.scrollTop = scroll;
    if (key) {
      const again = body.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
      if (again) {
        // The pane keeps unsent text itself; the caret comes back.
        if (field && again.value === field.value) {
          try {
            again.setSelectionRange(field.start, field.end);
          } catch {}
        }
        again.focus({ preventScroll: true });
      }
    }
  }
  // On a phone the pane is a sheet across the screen. A page wider than the
  // screen widens the layout a fixed sheet is measured against, so the sheet
  // takes the visible width.
  const phone = matchMedia("(max-width: 760px)");
  function fitWidth() {
    node.style.width = phone.matches
      ? `${document.documentElement.clientWidth}px`
      : "";
  }
  window.addEventListener("resize", fitWidth);
  function open(id, { focus = true } = {}) {
    if (!panes.has(id)) return;
    const was = current;
    current = id;
    fitWidth();
    node.hidden = false;
    node.dataset.pane = id;
    if (was && was !== id) panes.get(was)?.onClose?.();
    render({ keepFocus: was === id });
    panes.get(id)?.onOpen?.();
    if (focus) {
      const target =
        node.querySelector("[data-autofocus]") ||
        node.querySelector(
          ".review-pane-body button, .review-pane-body input, .review-pane-body textarea, .review-pane-body select",
        ) ||
        node;
      target.focus({ preventScroll: true });
    }
    onChange(current);
  }
  function close() {
    if (!current) return;
    const was = current;
    current = null;
    node.hidden = true;
    delete node.dataset.pane;
    panes.get(was)?.onClose?.();
    onChange(null);
    document.querySelector("#main")?.focus({ preventScroll: true });
  }
  return {
    el: node,
    register,
    open,
    close,
    toggle: (id) => (current === id ? close() : open(id)),
    isOpen: (id) => (id ? current === id : current !== null),
    current: () => current,
    refresh: (id = null) => {
      if (current && (!id || id === current)) render();
    },
    mount(container) {
      if (container && node.parentNode !== container) container.append(node);
    },
  };
}

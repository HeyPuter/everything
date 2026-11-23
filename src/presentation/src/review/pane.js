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
    // What had the focus, to give it back after the redraw.
    const active = document.activeElement;
    const inPane = keepFocus && active !== node && node.contains(active);
    const tool = inPane && tools.contains(active) ? active : null;
    tools.replaceChildren(...(pane.tools?.() || []));
    // A tool button drawn again (a filter just chosen from its menu) keeps
    // the focus.
    if (tool && !tool.isConnected) {
      const label = tool.getAttribute("aria-label");
      const again =
        label &&
        [...tools.querySelectorAll("button")].find(
          (b) => b.getAttribute("aria-label") === label,
        );
      (again || node).focus({ preventScroll: true });
    }
    const key =
      inPane && body.contains(active) ? active?.dataset?.focusKey : null;
    // A control inside a keyed item (a comment's Resolve or options button)
    // falls back to its item, and an item that is gone (a comment deleted, an
    // issue fixed) to the one that takes its place in the list.
    const item =
      inPane && body.contains(active)
        ? active.closest("[data-focus-key]")
        : null;
    const kind = (k) => k.split(":")[0];
    const sameKind = (k) =>
      [...body.querySelectorAll("[data-focus-key]")].filter(
        (n) => kind(n.dataset.focusKey) === kind(k),
      );
    const place = item ? sameKind(item.dataset.focusKey).indexOf(item) : -1;
    const strayed = inPane && body.contains(active);
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
    // Whatever had the focus is gone with the redraw: it stays in the pane
    // rather than dropping out of the page.
    if (strayed && !node.contains(document.activeElement)) {
      const itemKey = item?.dataset.focusKey;
      const others = itemKey ? sameKind(itemKey) : [];
      const again =
        (itemKey &&
          body.querySelector(`[data-focus-key="${CSS.escape(itemKey)}"]`)) ||
        others[Math.min(place, others.length - 1)] ||
        node;
      again.focus({ preventScroll: true });
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

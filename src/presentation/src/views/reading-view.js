// Reading View: the slide show played inside the window rather than full
// screen, under the window's own title bar, with a status bar at the bottom
// for moving through the slides and switching views. Escape returns to the
// view it was opened from.
import { el, icon, openMenu } from "../ui.js";

// The bar that replaces the show's controls. `show` goes to a slide index,
// `close` ends the reading view, `switchTo` closes it into another view.
export function readingBar({
  previous,
  next,
  counter,
  count,
  current,
  show,
  close,
  switchTo,
  titleOf,
}) {
  counter.classList.add("reading-counter");
  const menuButton = el(
    "button",
    {
      type: "button",
      class: "reading-menu btn icon-btn",
      "aria-label": "Reading View menu",
      "aria-haspopup": "menu",
      title: "Menu",
      onclick: (e) =>
        openMenu({
          anchor: e.currentTarget,
          label: "Reading View",
          align: "center",
          items: [
            {
              label: "Next",
              icon: "ChevronRight",
              onSelect: () => show(current() + 1),
            },
            {
              label: "Previous",
              icon: "ChevronLeft",
              disabled: current() <= 0,
              onSelect: () => show(current() - 1),
            },
            {
              label: "Go to Slide",
              icon: "o:seeAllSlides",
              items: Array.from({ length: count }, (_, i) => ({
                label: `${i + 1}. ${titleOf(i) || "Untitled"}`,
                checked: i === current(),
                onSelect: () => show(i),
              })),
            },
            { separator: true },
            {
              label: "Edit Slides",
              icon: "o:normalView",
              onSelect: () => switchTo("normal"),
            },
            { label: "End Reading View", icon: "X", onSelect: close },
          ],
        }),
    },
    icon("o:more", 16),
  );
  const viewButton = (id, label, name) =>
    el(
      "button",
      {
        type: "button",
        class: "status-view",
        "aria-label": label,
        title: label,
        "aria-pressed": String(id === "reading"),
        onclick: () => (id === "reading" ? null : switchTo(id)),
      },
      icon(`o:${name}`, 16),
    );
  return el(
    "div",
    {
      class: "presenter-controls reading-bar",
      role: "toolbar",
      "aria-label": "Reading View",
    },
    el("div", { class: "reading-left" }, counter),
    el("div", { class: "reading-center" }, previous, menuButton, next),
    el(
      "div",
      { class: "reading-right" },
      viewButton("normal", "Normal", "normalViewSmall"),
      viewButton("sorter", "Slide Sorter", "slideSorter"),
      viewButton("reading", "Reading View", "readingViewSmall"),
      viewButton("show", "Slide Show", "slideShowSmall"),
    ),
  );
}

// The reading view's dialog covers the window below its title bar.
export function placeReadingDialog(dialog) {
  const header = document.querySelector(".editor-header");
  const top = header ? Math.round(header.getBoundingClientRect().bottom) : 0;
  dialog.classList.add("reading-view");
  dialog.setAttribute("aria-label", "Reading View");
  dialog.style.setProperty("--reading-top", `${top}px`);
}

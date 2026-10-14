// Choose a SmartArt graphic: categories down the side, the layouts of the
// chosen category as pictures, and a larger picture with a description of
// the layout picked.
import { el, dialog } from "../ui.js";

export const svgUrl = (markup) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

// Resolves to the layout id chosen, or null.
export async function chooseSmartArtLayout({
  P,
  title = "Choose a SmartArt Graphic",
  confirm = "Insert",
  current = null,
  palette = null,
  items = null,
}) {
  const layouts = P.SMARTART_LAYOUTS;
  const categories = [
    { id: "all", label: "All" },
    ...P.SMARTART_CATEGORIES.filter((c) =>
      layouts.some((l) => l.category === c.id),
    ),
  ];
  let layoutId =
    current && layouts.some((l) => l.id === current) ? current : layouts[0].id;
  let category = "all";
  const preview = (id, width, height, sample = null) => {
    const text = items?.length ? items : sample;
    try {
      return svgUrl(
        P.smartArtPreviewSvg(id, {
          width,
          height,
          ...(palette ? { palette } : {}),
          ...(text?.length ? { items: text } : {}),
        }),
      );
    } catch {
      return "";
    }
  };
  const thumbs = new Map();
  const thumb = (id) => {
    if (!thumbs.has(id)) thumbs.set(id, preview(id, 120, 90));
    return thumbs.get(id);
  };

  const side = el("div", {
    class: "chart-families smartart-categories",
    role: "tablist",
    "aria-orientation": "vertical",
    "aria-label": "SmartArt categories",
  });
  const grid = el("div", {
    class: "smartart-layout-grid",
    role: "listbox",
    "aria-label": "Layouts",
  });
  const big = el("img", { class: "smartart-big-preview", alt: "" });
  const name = el("h3", { class: "smartart-layout-name" });
  const about = el("p", { class: "smartart-layout-about" });
  const body = el(
    "form",
    { class: "dialog-body smartart-picker" },
    side,
    grid,
    el(
      "div",
      { class: "smartart-detail", "aria-live": "polite" },
      el("div", { class: "smartart-big-stage" }, big),
      name,
      about,
    ),
  );
  const visible = () =>
    layouts.filter((l) => category === "all" || l.category === category);
  function drawSide() {
    side.replaceChildren(
      ...categories.map((c) =>
        el(
          "button",
          {
            type: "button",
            role: "tab",
            class: "chart-family",
            "aria-selected": String(c.id === category),
            tabindex: c.id === category ? 0 : -1,
            "data-category": c.id,
            onclick: () => pickCategory(c.id),
          },
          el("span", {}, c.label),
        ),
      ),
    );
  }
  function pickCategory(id, focus = false) {
    category = id;
    if (!visible().some((l) => l.id === layoutId)) layoutId = visible()[0].id;
    drawSide();
    drawGrid();
    if (focus) side.querySelector('[aria-selected="true"]')?.focus();
  }
  function drawGrid() {
    grid.replaceChildren(
      ...visible().map((l) =>
        el(
          "button",
          {
            type: "button",
            role: "option",
            class: "smartart-layout-choice",
            "aria-selected": String(l.id === layoutId),
            "aria-label": l.name,
            title: l.name,
            tabindex: l.id === layoutId ? 0 : -1,
            "data-layout": l.id,
            onclick: () => pick(l.id),
            ondblclick: () => {
              pick(l.id);
              body
                .closest("dialog")
                ?.querySelector(".dialog-actions .primary")
                ?.click();
            },
          },
          el("img", { src: thumb(l.id), alt: "", "aria-hidden": "true" }),
        ),
      ),
    );
    drawDetail();
  }
  function pick(id, focus = false) {
    layoutId = id;
    for (const b of grid.children) {
      const on = b.dataset.layout === id;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) {
        b.focus();
        b.scrollIntoView({ block: "nearest" });
      }
    }
    drawDetail();
  }
  function drawDetail() {
    const l = layouts.find((x) => x.id === layoutId);
    big.src = preview(l.id, 320, 220, l.sample);
    big.alt = `Preview of the ${l.name} layout`;
    name.textContent = l.name;
    about.textContent = l.description;
  }
  side.addEventListener("keydown", (e) => {
    const ids = categories.map((c) => c.id);
    const at = ids.indexOf(category);
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[
      e.key
    ];
    if (!step) return;
    e.preventDefault();
    pickCategory(ids[(at + step + ids.length) % ids.length], true);
  });
  grid.addEventListener("keydown", (e) => {
    const ids = visible().map((l) => l.id);
    const at = ids.indexOf(layoutId);
    const cols = Math.max(
      1,
      Math.round(grid.clientWidth / (grid.firstChild?.offsetWidth + 8 || 1)),
    );
    const step = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: cols,
      ArrowUp: -cols,
    }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = ids[Math.max(0, Math.min(ids.length - 1, at + step))];
    pick(next, true);
  });
  drawSide();
  drawGrid();
  const result = dialog({ title, body, confirm });
  body.closest("dialog")?.classList.add("smartart-dialog");
  requestAnimationFrame(() =>
    grid.querySelector('[aria-selected="true"]')?.focus(),
  );
  return (await result) ? layoutId : null;
}

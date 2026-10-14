// Pictures of slide layouts, drawn from the presentation's own masters, and
// the galleries that offer them: New Slide (add a slide on a layout) and
// Layout (change the layout of the selected slides). Imported decks show
// their own layouts; every master gets a section of its own.
import { el, closeMenu } from "../ui.js";
import { P, preview, templateStamp } from "../model.js";
import "./layouts.css";

// Renders keyed by the layout part and the buffers it is drawn from, so a
// gallery opens instantly after the first time and redraws only what an
// edit in master view changed.
const pictures = new WeakMap();

function layoutKey(pres, partName) {
  const pkg = P._internalPackageOf(pres);
  const part = pkg.getPart(partName);
  const size = P.getSlideSize(pres);
  return `${partName}|${partBufferStamp(part)}|${templateStampForLayout(pres, partName)}|${size?.width}x${size?.height}`;
}
const bufferIds = new WeakMap();
let nextBufferId = 0;
function partBufferStamp(part) {
  if (!part) return 0;
  let id = bufferIds.get(part.data);
  if (!id) bufferIds.set(part.data, (id = ++nextBufferId));
  return id;
}
// A layout's picture also changes with its master and the master's theme.
function templateStampForLayout(pres, partName) {
  const pkg = P._internalPackageOf(pres);
  const master = P.getLayoutMasterPartName(pres, partName) || partName;
  const rel = pkg.getRels(master)?.items.find((r) => r.type.endsWith("/theme"));
  const theme = rel && new URL(rel.target, `file://${master}`).pathname;
  return [master, theme]
    .map((name) => partBufferStamp(name && pkg.getPart(name)))
    .join(":");
}

/**
 * A picture of a layout or master as an image source plus the outlines of
 * its placeholders (fractions of the page), for drawing at any size.
 */
export function templatePicture(pres, partName) {
  let cache = pictures.get(pres);
  if (!cache) pictures.set(pres, (cache = new Map()));
  const key = layoutKey(pres, partName);
  const hit = cache.get(partName);
  if (hit?.key === key) return hit.value;
  const view = P.getTemplateSlide(pres, partName);
  const page = P.getTemplatePageSize(pres, view);
  const frames = [];
  for (const shape of P.getSlideShapes(view)) {
    if (!P.isShapePlaceholder(shape)) continue;
    const b = P.getShapeBoundsResolved(pres, shape);
    if (!b) continue;
    frames.push({
      x: b.x / page.cx,
      y: b.y / page.cy,
      w: b.w / page.cx,
      h: b.h / page.cy,
    });
  }
  const value = {
    src: preview(pres, view, { prompts: true }),
    frames,
    aspect: `${page.cx} / ${page.cy}`,
  };
  cache.set(partName, { key, value });
  return value;
}

/** The picture as an element: the render with dashed placeholder frames. */
export function templateThumb(pres, partName, { frames = true } = {}) {
  const picture = templatePicture(pres, partName);
  return el(
    "span",
    {
      class: "layout-thumb",
      style: `aspect-ratio:${picture.aspect}`,
      "aria-hidden": "true",
    },
    el("img", { src: picture.src, alt: "", draggable: "false" }),
    frames &&
      picture.frames.map((f) =>
        el("span", {
          class: "layout-thumb-frame",
          style: `left:${f.x * 100}%;top:${f.y * 100}%;width:${f.w * 100}%;height:${f.h * 100}%`,
        }),
      ),
  );
}

/** The layouts a slide can use, grouped by master, in gallery order. */
export function layoutSections(pres) {
  return P.getSlideMasters(pres)
    .map((master) => ({
      label: master.name,
      master: master.partName,
      layouts: master.layouts,
    }))
    .filter((section) => section.layouts.length);
}

/**
 * The layout a new slide after `target` takes: the same layout, except that
 * after a title slide comes the master's Title and Content layout.
 */
export function nextLayoutFor(pres, target) {
  const layout = target && P.getSlideLayout(target);
  const sections = layoutSections(pres);
  if (!layout) return sections[0]?.layouts[0]?.partName || null;
  const name = P.getSlideLayoutPartName(layout);
  const master = P.getLayoutMasterPartName(pres, name);
  const section = sections.find((s) => s.master === master) || sections[0];
  const type = P.getSlideLayoutType(layout);
  if (type === "title") {
    const content =
      section?.layouts.find((l) => l.type === "obj") ||
      section?.layouts.find((l) => l.type !== "title" && l.type !== "blank");
    if (content) return content.partName;
  }
  return name;
}

/**
 * A gallery of layout pictures for a menu: one section per master, a
 * button per layout. `selected` marks the current layout.
 */
export function layoutGallery(
  pres,
  { label, selected = null, onChoose, describe = null, radio = false },
) {
  const root = el("div", {
    class: "layout-gallery",
    role: "group",
    "aria-label": label,
  });
  const sections = layoutSections(pres);
  for (const section of sections) {
    if (sections.length > 1 || section.label)
      root.append(
        el("div", { class: "layout-gallery-heading" }, section.label),
      );
    const grid = el("div", {
      class: "layout-gallery-grid",
      role: "group",
      "aria-label": section.label || label,
    });
    for (const layout of section.layouts) {
      const name = layout.name || "Custom Layout";
      const isSelected = layout.partName === selected;
      grid.append(
        el(
          "button",
          {
            type: "button",
            class: `layout-gallery-item ${isSelected ? "selected" : ""}`,
            // The Layout gallery marks the current layout; New Slide has none.
            role: radio ? "menuitemradio" : "menuitem",
            "aria-checked": radio ? String(isSelected) : null,
            tabindex: -1,
            title: describe ? describe(layout) : name,
            "data-layout": layout.partName,
            onclick: () => {
              closeMenu();
              onChoose(layout.partName);
            },
          },
          templateThumb(pres, layout.partName),
          el("span", { class: "layout-gallery-label" }, name),
        ),
      );
    }
    root.append(grid);
  }
  // Left and right step along a row; the menu moves up and down.
  root.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const items = [...root.querySelectorAll(".layout-gallery-item")];
    const at = items.indexOf(document.activeElement);
    if (at < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const next = items[at + (e.key === "ArrowRight" ? 1 : -1)];
    next?.focus();
  });
  return root;
}

export { templateStamp };

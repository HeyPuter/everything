// Placeholders on the editing canvas. Empty placeholders get a dashed
// outline (in master view every placeholder does), and an empty content
// placeholder offers buttons that insert a table, picture, chart and the
// like in its place, as desktop editors do. None of this is part of the
// slide: thumbnails, slide shows and exported files never show it.
import { el, icon } from "../ui.js";
import { P } from "../model.js";
import "./icons.js";
import "./layouts.css";

// Every kind of insert a content placeholder may offer, in button order.
// `kinds` lists the placeholder kinds (from getPlaceholderContentKind) that
// offer it.
export const PLACEHOLDER_INSERTS = [
  {
    id: "table",
    label: "Insert Table",
    icon: "o:table",
    kinds: ["content", "table"],
  },
  {
    id: "chart",
    label: "Insert Chart",
    icon: "o:chartColumn",
    kinds: ["content", "chart"],
  },
  {
    id: "smartArt",
    label: "Insert a SmartArt Graphic",
    icon: "o:smartArt",
    kinds: ["content", "smartArt"],
  },
  {
    id: "picture",
    label: "Insert Picture",
    icon: "o:picture",
    kinds: ["content", "picture"],
  },
  {
    id: "icons",
    label: "Insert Icons",
    icon: "o:icons",
    kinds: ["content"],
  },
  {
    id: "video",
    label: "Insert Video",
    icon: "o:video",
    kinds: ["content", "media"],
  },
];

/**
 * Marks placeholder hit regions on `canvas` and adds quick-insert buttons.
 * `available(id)` says whether the app can insert that kind now;
 * `insert(id, shape)` does it in place of the placeholder.
 */
export function decoratePlaceholders({
  canvas,
  slide,
  masterView = false,
  available,
  insert,
}) {
  canvas.querySelectorAll(".placeholder-inserts").forEach((n) => n.remove());
  if (!slide) return;
  const byId = new Map(
    P.getSlideShapes(slide).map((s) => [String(P.getShapeId(s)), s]),
  );
  for (const hit of canvas.querySelectorAll(".object-hit")) {
    const shape = byId.get(hit.dataset.shapeId);
    if (!shape || !P.isShapePlaceholder(shape)) continue;
    const empty = P.isPlaceholderEmpty(shape);
    hit.classList.toggle("placeholder-frame", masterView || empty);
    if (masterView || !empty) continue;
    const kind = P.getPlaceholderContentKind(shape);
    if (!kind) continue;
    const offered = PLACEHOLDER_INSERTS.filter(
      (entry) => entry.kinds.includes(kind) && available(entry.id),
    );
    if (!offered.length) continue;
    const box = el("div", {
      class: "placeholder-inserts",
      role: "group",
      "aria-label": `Insert into ${P.getShapeName(shape) || "placeholder"}`,
      "data-shape-id": hit.dataset.shapeId,
    });
    for (const entry of offered)
      box.append(
        el(
          "button",
          {
            type: "button",
            "aria-label": entry.label,
            title: entry.label,
            "data-insert": entry.id,
            onpointerdown: (e) => e.stopPropagation(),
            onclick: (e) => {
              e.stopPropagation();
              insert(entry.id, shape);
            },
          },
          icon(entry.icon, 20),
        ),
      );
    // The buttons sit in the middle of the placeholder, below its prompt.
    for (const key of ["left", "top", "width", "height", "transform"])
      box.style[key] = hit.style[key];
    const small = hit.offsetWidth < 150 || hit.offsetHeight < 90;
    box.classList.toggle("compact", small);
    canvas.append(box);
  }
}

/**
 * The bounds an object inserted into a placeholder takes: the
 * placeholder's own, or for something with its own shape (a picture), the
 * largest box of that shape that fits, centered.
 */
export function fitInto(bounds, aspect = null) {
  if (!aspect) return { ...bounds };
  let w = bounds.w,
    h = w / aspect;
  if (h > bounds.h) {
    h = bounds.h;
    w = h * aspect;
  }
  return {
    x: Math.round(bounds.x + (bounds.w - w) / 2),
    y: Math.round(bounds.y + (bounds.h - h) / 2),
    w: Math.round(w),
    h: Math.round(h),
  };
}

import { bounds, clone } from "../model.js";
import { paint } from "../render.js";
import { sameObject } from "./restore.js";
import { addTranslations } from "../i18n.js";

// What changed between an earlier version and the board now: the objects
// the version holds that are gone now, those both hold that differ, and how
// many the board has gained since. Both lists leave out what is hidden from
// the person looking.
export function versionChanges(now, then) {
  const current = new Map(now.map((i) => [i.id, i])),
    removed = new Set(),
    changed = new Set();
  for (const i of then) {
    const other = current.get(i.id);
    if (!other) removed.add(i.id);
    else if (!sameObject(other, i)) changed.add(i.id);
  }
  const held = new Set(then.map((i) => i.id));
  return {
    removed,
    changed,
    added: now.filter((i) => !held.has(i.id)).length,
  };
}

const MIN_ZOOM = 0.01,
  MAX_ZOOM = 4;
// Outlines for what changed since: deleted objects dashed, changed ones
// solid, so the two are told apart without their colours.
const MARKS = {
  removed: { light: "#c42b1c", dark: "#ff9b8f", dash: [6, 4] },
  changed: { light: "#9a5b00", dark: "#f5c46b", dash: [] },
};

// A read-only view of one version of a board on its own canvas: it fits
// the version on showing it, and can be panned with a drag, the wheel or
// the arrow keys, and zoomed with Ctrl/Cmd and the wheel, a pinch, the
// + and - keys or the zoom buttons. Objects that changed since are
// outlined, and the rest faded, while `highlight` is on.
export function createVersionPreview(stage) {
  const canvas = stage.querySelector("canvas");
  let shown = null,
    view = null,
    // Whether the person moved the view; until they do, it follows the
    // stage's size.
    moved = false,
    frame = 0;
  const size = () => {
    const r = stage.getBoundingClientRect();
    return { width: r.width || 560, height: r.height || 360 };
  };
  function fit() {
    const { width, height } = size(),
      a = bounds(shown.items),
      z = Math.max(
        MIN_ZOOM,
        Math.min(
          1.5,
          Math.min((width - 48) / (a.w || 1), (height - 48) / (a.h || 1)),
        ),
      );
    view = {
      x: width / 2 - (a.x + a.w / 2) * z,
      y: height / 2 - (a.y + a.h / 2) * z,
      z,
    };
    moved = false;
  }
  function draw() {
    frame = 0;
    if (!shown || !canvas.isConnected) return;
    const { width, height } = size(),
      dpr = Math.min(window.devicePixelRatio || 1, 2),
      dark = document.documentElement.dataset.theme === "dark",
      marked = shown.highlight
        ? new Set([...shown.changes.removed, ...shown.changes.changed])
        : null;
    paint(canvas, shown.items, view, {
      width,
      height,
      dpr,
      tags: shown.tags,
      coarse: true,
      frameLabels: true,
      mindBadges: false,
      emphasis: marked?.size ? marked : null,
      repaint: schedule,
    });
    const ctx = canvas.getContext("2d");
    if (!ctx || !marked?.size) return;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const i of shown.items) {
      const kind = shown.changes.removed.has(i.id)
        ? "removed"
        : shown.changes.changed.has(i.id)
          ? "changed"
          : null;
      if (!kind) continue;
      const b = bounds([i]),
        x = b.x * view.z + view.x,
        y = b.y * view.z + view.y,
        w = b.w * view.z,
        h = b.h * view.z;
      if (x + w < -8 || y + h < -8 || x > width + 8 || y > height + 8) continue;
      ctx.strokeStyle = MARKS[kind][dark ? "dark" : "light"];
      ctx.setLineDash(MARKS[kind].dash);
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 4, y - 4, w + 8, h + 8);
    }
    ctx.restore();
  }
  function schedule() {
    if (frame) return;
    frame = (window.requestAnimationFrame || setTimeout)(draw);
  }
  function zoom(factor, at = null) {
    if (!shown) return;
    const { width, height } = size(),
      p = at || { x: width / 2, y: height / 2 },
      z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.z * factor)),
      k = z / view.z;
    view = { x: p.x - (p.x - view.x) * k, y: p.y - (p.y - view.y) * k, z };
    moved = true;
    schedule();
  }
  function pan(dx, dy) {
    if (!shown) return;
    view = { ...view, x: view.x + dx, y: view.y + dy };
    moved = true;
    schedule();
  }
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!shown) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey)
        zoom(Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) / 100), local(e));
      else pan(-e.deltaX, -e.deltaY);
    },
    { passive: false },
  );
  // A drag pans; two fingers pinch to zoom.
  const pointers = new Map();
  let pinch = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (!shown || (e.pointerType === "mouse" && e.button !== 0)) return;
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, local(e));
    canvas.classList.add("dragging");
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    const last = pointers.get(e.pointerId);
    if (!last) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()],
        distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance > 0) {
        zoom(distance / pinch, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        pinch = distance;
      }
    } else if (pointers.size === 1) pan(p.x - last.x, p.y - last.y);
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) canvas.classList.remove("dragging");
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("keydown", (e) => {
    if (!shown || e.altKey || e.ctrlKey || e.metaKey) return;
    const step = e.shiftKey ? 160 : 40,
      moves = {
        ArrowLeft: [step, 0],
        ArrowRight: [-step, 0],
        ArrowUp: [0, step],
        ArrowDown: [0, -step],
      };
    if (moves[e.key]) pan(...moves[e.key]);
    else if (e.key === "+" || e.key === "=") zoom(1.25);
    else if (e.key === "-" || e.key === "_") zoom(0.8);
    else if (e.key === "0") {
      fit();
      schedule();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  const resized = window.ResizeObserver
    ? new ResizeObserver(() => {
        if (!shown) return;
        if (!moved) fit();
        schedule();
      })
    : null;
  resized?.observe(stage);
  return {
    // `items` are copied, so laying out their text for this canvas never
    // changes the version they came from.
    show({ items, tags, changes, highlight = true }) {
      shown = { items: clone(items), tags, changes, highlight };
      fit();
      draw();
    },
    highlight(on) {
      if (!shown) return;
      shown.highlight = on;
      schedule();
    },
    clear() {
      shown = null;
    },
    zoomIn: () => zoom(1.25),
    zoomOut: () => zoom(0.8),
    fit() {
      if (!shown) return;
      fit();
      schedule();
    },
    destroy() {
      resized?.disconnect();
      shown = null;
    },
  };
}

addTranslations({
  "Choose a version to see the board as it was then, with what has changed since.":
    "Choisissez une version pour voir le tableau tel qu’il était alors, avec ce qui a changé depuis.",
  "Preview of the version": "Aperçu de la version",
  "Zoom in on the preview": "Zoomer dans l’aperçu",
  "Zoom out of the preview": "Dézoomer l’aperçu",
  "Fit the version in the preview": "Ajuster la version dans l’aperçu",
  "Loading this version…": "Chargement de cette version…",
  "one|{count} deleted since": "{count} supprimé depuis",
  "{count} deleted since": "{count} supprimés depuis",
  "one|{count} changed since": "{count} modifié depuis",
  "{count} changed since": "{count} modifiés depuis",
  "one|{count} added since": "{count} ajouté depuis",
  "{count} added since": "{count} ajoutés depuis",
  "Same as the board now.": "Identique au tableau actuel.",
  "Highlight changes": "Surligner les changements",
  "Drag to move around this version. Ctrl/Cmd + scroll, a pinch or the + and - keys zoom.":
    "Faites glisser pour parcourir cette version. Ctrl/Cmd + défilement, un pincement ou les touches + et - zooment.",
});

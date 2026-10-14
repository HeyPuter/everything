// The Draw tab: pens, pencils and highlighters that ink on the slide, erasers
// that take ink away (whole strokes or just the part rubbed out), a lasso
// that selects what it rings, and the commands that turn ink into shapes,
// text or math, replay it, and lay it along a ruler.
//
// Each stroke becomes a freeform shape (draw/ink-model.js) with a smooth
// path and round ends, so it moves, recolours, copies and is saved in the
// .pptx like any other drawing; when it was drawn is kept with it for
// replay. The pens are the user's own collection (draw/pens.js), kept on
// this device.
import "./draw-tab.css";
import "./draw/draw-icons.js";
import { el, openMenu, toast } from "./ui.js";
import { colorMenuItems } from "./color-palette.js";
import {
  INK_NAME,
  MM,
  isInk,
  inkShapes,
  addInkStroke,
  addRecognizedShape,
  addArrowhead,
  strokePoints,
  strokeSamples,
  setStrokeGeometry,
} from "./draw/ink-model.js";
import {
  segmentDistance,
  pointInPolygon,
  boxCorners,
  densify,
  eraseFromStroke,
  followRuler,
  recognizeStroke,
  matchArrowHead,
} from "./draw/ink-geometry.js";
import {
  PEN_TYPES,
  TEXTURE_LABELS,
  MAX_PENS,
  loadPens,
  savePens,
  resetPens,
  addPen,
  removePen,
  movePen,
  penLabel,
} from "./draw/pens.js";
import {
  inkToPng,
  readInk,
  inkBounds,
  fittingFontSize,
} from "./draw/ink-ai.js";
import { playInkReplay } from "./draw/ink-replay.js";
import { createRuler } from "./draw/ruler.js";

export { INK_NAME };
const PT = 12700;
const ERASER_SIZES = {
  small: { label: "Small", px: 5 },
  medium: { label: "Medium", px: 12 },
  large: { label: "Large", px: 24 },
};
const PREFS = "presentation.drawPrefs.v1";
function loadPrefs() {
  try {
    const p = JSON.parse(globalThis.localStorage?.getItem(PREFS) || "null");
    if (p && typeof p === "object") return p;
  } catch {}
  return {};
}

/**
 * The Draw tab's tools for the editor. `env` gives what only the editor
 * knows: the canvas, the slide, edits (mutateSlide), the selection, a
 * slide's picture, and the AI.
 */
export function createDrawTools({
  P,
  canvas,
  slideSize,
  currentSlide,
  mutateSlide,
  onToolChange,
  theme,
  selectedShapes = () => [],
  selectShapes = () => {},
  renderSlide = null,
  chat = () => null,
  aiModel = undefined,
  shapeLabels = {},
  equation = null,
}) {
  let tool = null; // null (select) | pen id | "eraser" | "lasso"
  let pens = loadPens();
  const prefs = {
    eraser: "stroke",
    eraserSize: "medium",
    inkToShape: false,
    drawWithTouch: true,
    ...loadPrefs(),
  };
  let layer = null;
  let busy = false;
  let replay = null;
  // The line ink was last turned into, which a "V" drawn at one of its ends
  // makes an arrow.
  let lastLine = null;
  const ruler = createRuler({ canvas, slideSize });

  function savePrefs() {
    try {
      globalThis.localStorage?.setItem(PREFS, JSON.stringify(prefs));
    } catch {}
  }
  function changed() {
    onToolChange?.(tool);
  }
  function setTool(next) {
    tool = tool === next ? null : next;
    const node = canvas();
    node?.classList.toggle("inking", !!tool);
    node?.setAttribute("data-ink-tool", tool || "");
    attach();
    changed();
  }
  // A layer over the slide takes the pointer while a pen, the eraser or the
  // lasso is chosen, so drawing never moves the objects under it.
  function attach() {
    const node = canvas();
    ruler.attach();
    if (!node) return;
    if (!tool) {
      layer?.remove();
      layer = null;
      return;
    }
    if (!layer || !layer.isConnected) {
      layer = el("div", { class: "ink-layer", "aria-hidden": "true" });
      layer.addEventListener("pointerdown", down);
      node.append(layer);
      // The ruler stays over the ink layer, where it can be moved.
      ruler.attach();
    }
    layer.dataset.tool =
      tool === "eraser"
        ? `eraser-${prefs.eraser}`
        : tool === "lasso"
          ? "lasso"
          : pen()?.type || "pen";
    layer.classList.toggle("touch-pans", !prefs.drawWithTouch);
    if (tool === "eraser" && prefs.eraser === "point")
      layer.style.setProperty(
        "--eraser-size",
        `${ERASER_SIZES[prefs.eraserSize].px * 2}px`,
      );
  }
  const pen = () => pens.find((p) => p.id === tool);
  function toEmu(e) {
    const rect = canvas().getBoundingClientRect();
    const size = slideSize();
    return {
      x: ((e.clientX - rect.left) / rect.width) * size.cx,
      y: ((e.clientY - rect.top) / rect.height) * size.cy,
    };
  }
  // EMUs per screen pixel on the canvas as it is shown.
  const emuPerPx = () =>
    slideSize().cx / Math.max(1, canvas().getBoundingClientRect().width);

  // A live path in the layer, in screen pixels, drawn while the pointer is
  // down.
  function livePath(attrs) {
    const rect = canvas().getBoundingClientRect();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ink-live");
    svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    for (const [k, v] of Object.entries(attrs)) path.setAttribute(k, v);
    svg.append(path);
    layer.append(svg);
    return {
      svg,
      path,
      set(points, close = false) {
        const f = rect.width / slideSize().cx;
        path.setAttribute(
          "d",
          points.length
            ? `M${points.map((p) => `${p.x * f} ${p.y * f}`).join("L")}${close ? "Z" : ""}`
            : "",
        );
      },
    };
  }
  // Runs `step(event)` for each pointer move (coalesced points included)
  // until the pointer is let go, then `end()`.
  function track(step, end) {
    const move = (ev) => {
      for (const c of ev.getCoalescedEvents?.() || [ev]) step(c);
    };
    const up = () => {
      layer.removeEventListener("pointermove", move);
      layer.removeEventListener("pointerup", up);
      layer.removeEventListener("pointercancel", up);
      end();
    };
    layer.addEventListener("pointermove", move);
    layer.addEventListener("pointerup", up);
    layer.addEventListener("pointercancel", up);
  }
  function down(e) {
    if (e.button !== 0) return;
    // With drawing by touch off, a finger scrolls and zooms as usual.
    if (e.pointerType === "touch" && !prefs.drawWithTouch) return;
    e.preventDefault();
    e.stopPropagation();
    layer.setPointerCapture(e.pointerId);
    if (tool === "eraser") return erase(e);
    if (tool === "lasso") return lasso(e);
    const p = pen();
    if (p) draw(e, p);
  }

  /* ---------- Pens ---------- */

  function draw(e, p) {
    const rect = canvas().getBoundingClientRect();
    const pxPerEmu = rect.width / slideSize().cx;
    const live = livePath({
      stroke: p.color,
      "stroke-width": String(Math.max(1, p.width * MM * PT * pxPerEmu)),
      "stroke-opacity":
        p.type === "highlighter"
          ? "0.5"
          : p.texture === "graphite"
            ? "0.7"
            : "1",
      ...(p.texture === "dotted"
        ? {
            "stroke-dasharray": `0 ${Math.max(2, p.width * MM * PT * pxPerEmu * 2)}`,
          }
        : {}),
    });
    const t0 = performance.now();
    const start = Date.now();
    const raw = [toEmu(e)];
    const times = [0];
    const guide = ruler.geometry();
    const snap = 18 * emuPerPx();
    let shown = raw;
    track(
      (c) => {
        raw.push(toEmu(c));
        times.push(Math.round(performance.now() - t0));
        shown = (guide && followRuler(raw, guide, snap)) || raw;
        live.set(shown);
      },
      () => {
        live.svg.remove();
        commit(shown, p, { times, start }).catch(report);
      },
    );
  }
  async function commit(points, p, timing) {
    const size = slideSize();
    const tolerance = size.cx / 2000;
    const target = currentSlide();
    if (prefs.inkToShape && p.type !== "highlighter") {
      const part = P.getSlidePartName(target);
      // A V drawn at an end of the line just made gives it an arrowhead.
      if (
        lastLine &&
        lastLine.part === part &&
        Date.now() - lastLine.at < 15000
      ) {
        const end = matchArrowHead(points, lastLine);
        if (end) {
          const id = lastLine.id;
          lastLine = null;
          const applied = await mutateSlide(target, (s) => {
            const line = P.findShapeById(s, id);
            if (!line) return undefined;
            addArrowhead(P, line, end);
          });
          if (applied !== false) return;
        }
      }
      const found = recognizeStroke(points, { minSize: size.cx / 40 });
      if (found) {
        let made = null;
        await mutateSlide(target, (s) => {
          made = addRecognizedShape(P, s, found, p, shapeLabels);
        });
        lastLine =
          found.kind === "line" && made
            ? {
                id: P.getShapeId(made),
                part,
                from: found.from,
                to: found.to,
                at: Date.now(),
              }
            : null;
        return;
      }
    }
    lastLine = null;
    await mutateSlide(target, (s) => {
      addInkStroke(P, s, points, p, { tolerance, ...timing });
    });
  }

  /* ---------- Erasers ---------- */

  // The stroke eraser removes each stroke its path crosses; the point eraser
  // rubs out only what it passes over, leaving the rest of the stroke in
  // pieces.
  function erase(e) {
    const point = prefs.eraser === "point";
    const reach = point
      ? ERASER_SIZES[prefs.eraserSize].px * emuPerPx()
      : slideSize().cx / 250;
    const slide = currentSlide();
    const strokes = inkShapes(P, slide).map((shape) => ({
      shape,
      id: P.getShapeId(shape),
      width: (P.getShapeStrokeWidth?.(shape) || 0) / 2,
      line: strokePoints(P, shape),
    }));
    const hits = new Set();
    const path = [toEmu(e)];
    const live = point
      ? livePath({
          class: "ink-eraser-trail",
          "stroke-width": String(ERASER_SIZES[prefs.eraserSize].px * 2),
        })
      : null;
    const check = (from, to) => {
      for (const s of strokes) {
        if (hits.has(s.id)) continue;
        for (let i = 1; i < s.line.length; i++)
          if (
            segmentDistance(from, to, s.line[i - 1], s.line[i]) <=
            reach + s.width
          ) {
            hits.add(s.id);
            break;
          }
      }
    };
    check(path[0], path[0]);
    live?.set(path);
    track(
      (c) => {
        const at = toEmu(c);
        check(path.at(-1), at);
        path.push(at);
        live?.set(path);
      },
      () => {
        live?.svg.remove();
        if (!hits.size) return;
        const ids = [...hits];
        mutateSlide(slide, (s) => {
          for (const id of ids) {
            const shape = P.findShapeById(s, id);
            if (!shape) continue;
            if (point) rubOut(s, shape, path, reach);
            else P.removeShape(shape);
          }
        }).catch(report);
      },
    );
  }
  function rubOut(slide, shape, path, reach) {
    const width = (P.getShapeStrokeWidth?.(shape) || 0) / 2;
    const dense = densify(
      strokeSamples(P, shape, 8),
      Math.max(reach / 2, slideSize().cx / 4000),
    );
    const runs = eraseFromStroke(dense, path, reach + width);
    if (!runs) return;
    const timing = P.getShapeInkTiming?.(shape);
    const z = P.getShapeZIndex(shape);
    runs.forEach((run, i) => {
      const piece = P.copyShape(slide, shape);
      setStrokeGeometry(P, piece, run, slideSize().cx / 2000);
      P.renameShape(piece, `${INK_NAME} ${(Date.now() + i) % 100000}`);
      if (P.setShapeInkTiming)
        P.setShapeInkTiming(
          piece,
          timing ? { start: timing.start + i, times: [] } : null,
        );
      P.setShapeZIndex(piece, z + i);
    });
    const original = P.findShapeById(slide, P.getShapeId(shape));
    if (original) P.removeShape(original);
  }

  /* ---------- Lasso ---------- */

  // Everything wholly inside the drawn loop is selected: a stroke when all
  // of its line is, any other object when all of its corners are.
  function lasso(e) {
    const live = livePath({ class: "ink-lasso" });
    const loop = [toEmu(e)];
    track(
      (c) => {
        loop.push(toEmu(c));
        live.set(loop, true);
      },
      () => {
        live.svg.remove();
        const ids = lassoed(currentSlide(), loop);
        setTool(null);
        if (!ids.length) {
          toast("Nothing lies wholly inside the lasso.");
          return;
        }
        selectShapes(ids);
      },
    );
  }
  function lassoed(slide, loop) {
    if (loop.length < 3) return [];
    const inGroup = new Set();
    for (const s of P.getSlideShapes(slide))
      if (P.getShapeKind(s) === "group")
        for (const child of P.getGroupChildren?.(s) || [])
          inGroup.add(P.getShapeId(child));
    const ids = [];
    for (const s of P.getSlideShapes(slide)) {
      const id = P.getShapeId(s);
      if (inGroup.has(id) || P.isShapeHidden?.(s)) continue;
      let pts;
      if (isInk(P, s)) pts = strokePoints(P, s);
      else {
        const b = P.getShapeBounds(s);
        if (!b) continue;
        pts = boxCorners(b, P.getShapeRotation?.(s) || 0);
      }
      if (pts.length && pts.every((p) => pointInPolygon(p, loop))) ids.push(id);
    }
    return ids;
  }

  /* ---------- Converting ink ---------- */

  // The ink a command works on: the ink selected, or else all the slide's.
  function inkTargets() {
    const chosen = selectedShapes().filter((s) => isInk(P, s));
    return chosen.length ? chosen : inkShapes(P, currentSlide());
  }
  function report(e) {
    console.error(e);
    toast(e?.message || "Something went wrong.");
  }
  async function inkToWords(mode) {
    if (busy) return;
    const shapes = inkTargets();
    if (!shapes.length) {
      toast("There is no ink on this slide to convert.");
      return;
    }
    const ai = chat();
    if (!ai) {
      toast(
        "The AI service is not available. Check your connection and reload.",
      );
      return;
    }
    const picture = inkToPng(P, shapes);
    if (!picture) return;
    busy = true;
    canvas()?.classList.add("ink-reading");
    changed();
    toast(mode === "math" ? "Reading your math…" : "Reading your handwriting…");
    try {
      const value = await readInk(picture.dataUrl, mode, {
        chat: ai,
        model: aiModel,
      });
      if (!value) {
        toast("No writing could be read in that ink.");
        return;
      }
      await placeWords(shapes, value, mode, picture.bounds);
      toast(
        mode === "math" ? "Ink converted to math." : "Ink converted to text.",
      );
    } finally {
      busy = false;
      canvas()?.classList.remove("ink-reading");
      changed();
    }
  }
  async function placeWords(shapes, value, mode, box) {
    const target = currentSlide();
    const ids = shapes.map((s) => P.getShapeId(s));
    const color = (() => {
      try {
        const c = P.getShapeStroke(shapes[0]);
        return c.kind === "solid" && /^#/.test(c.color) ? c.color : "#000000";
      } catch {
        return "#000000";
      }
    })();
    const lines = value.split("\n").length;
    const size = fittingFontSize(box.h, lines);
    // An equation, where the editor can set one, from the LaTeX read.
    const prepared =
      mode === "math" && equation?.prepare
        ? await equation.prepare(value, color, size)
        : null;
    let made = null;
    await mutateSlide(target, (s) => {
      for (const id of ids) {
        const shape = P.findShapeById(s, id);
        if (shape) P.removeShape(shape);
      }
      if (prepared) {
        made = equation.place(s, prepared, { x: box.x, y: box.y });
        return;
      }
      const width = Math.max(box.w, (size * PT * value.length) / lines / 1.9);
      made = P.addSlideTextBox(s, {
        x: Math.round(box.x),
        y: Math.round(box.y),
        w: Math.round(Math.min(slideSize().cx - box.x, width)),
        h: Math.round(size * PT * 1.25 * lines),
        text: value,
        name:
          mode === "math"
            ? `Equation ${P.getSlideShapes(s).length + 1}`
            : undefined,
      });
      P.setShapeTextFormat(made, {
        size,
        color,
        ...(mode === "math" ? { font: "Cambria Math" } : {}),
      });
      P.setShapeTextMargins(made, { left: 0, right: 0, top: 0, bottom: 0 });
      P.setShapeTextAutoFit(made, "shape");
      if (mode === "math")
        P.setShapeDescription(made, `Equation (LaTeX): ${value}`);
    });
    if (made) selectShapes([P.getShapeId(made)]);
  }
  async function convertToShapes() {
    const shapes = inkTargets();
    if (!shapes.length) {
      toast("There is no ink on this slide to convert.");
      return;
    }
    const size = slideSize();
    const found = shapes
      .map((s) => {
        const pen = {
          color: P.getShapeStroke(s).color || "#000000",
          width: (P.getShapeStrokeWidth(s) || PT) / (MM * PT),
        };
        const shape = recognizeStroke(strokeSamples(P, s, 6), {
          minSize: size.cx / 40,
        });
        return shape && { id: P.getShapeId(s), shape, pen };
      })
      .filter(Boolean);
    if (!found.length) {
      toast("None of that ink looks like a shape.");
      return;
    }
    const made = [];
    await mutateSlide(currentSlide(), (s) => {
      for (const f of found) {
        const ink = P.findShapeById(s, f.id);
        if (!ink) continue;
        const z = P.getShapeZIndex(ink);
        const shape = addRecognizedShape(P, s, f.shape, f.pen, shapeLabels);
        P.removeShape(P.findShapeById(s, f.id));
        P.setShapeZIndex(shape, z);
        made.push(P.getShapeId(shape));
      }
    });
    selectShapes(made);
    toast(
      `${found.length} ink stroke${found.length === 1 ? "" : "s"} converted to shapes.`,
    );
  }

  /* ---------- Replay ---------- */

  function startReplay() {
    if (replay) return;
    const slide = currentSlide();
    const ink = inkShapes(P, slide);
    if (!ink.length) {
      toast("There is no ink on this slide to replay.");
      return;
    }
    if (tool) setTool(null);
    // The slide without its ink, drawn once for the replay to play over.
    let background = "";
    const hidden = ink.filter((s) => !P.isShapeHidden(s));
    try {
      for (const s of hidden) P.setShapeHidden(s, true);
      background = renderSlide?.(slide) || "";
    } finally {
      for (const s of hidden) P.setShapeHidden(s, false);
    }
    replay = playInkReplay({
      P,
      canvas: canvas(),
      slide,
      slideSize,
      background,
      autoplay: !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")
        .matches,
      onClose: () => {
        replay = null;
        changed();
      },
    });
    changed();
  }

  /* ---------- The ribbon ---------- */

  function persistPens() {
    savePens(pens);
    changed();
  }
  function penMenu(p) {
    const spec = PEN_TYPES[p.type];
    const i = pens.indexOf(p);
    const update = (fn) => () => {
      fn();
      if (tool !== p.id) setTool(p.id);
      persistPens();
    };
    return [
      { header: "Thickness" },
      ...spec.widths.map((w) => ({
        label: `${w} mm`,
        checked: p.width === w,
        onSelect: update(() => (p.width = w)),
      })),
      { separator: true },
      { header: "Color" },
      ...colorMenuItems({
        theme: theme(),
        current: p.color,
        onPick: (value, hex) => {
          const c = String(hex || value || "").toUpperCase();
          if (/^#[0-9A-F]{6}$/.test(c)) update(() => (p.color = c))();
        },
      }),
      ...(spec.textures.length > 1
        ? [
            { separator: true },
            {
              label: "Texture",
              items: spec.textures.map((t) => ({
                label: TEXTURE_LABELS[t],
                checked: p.texture === t,
                onSelect: update(() => (p.texture = t)),
              })),
            },
          ]
        : []),
      { separator: true },
      {
        label: "Move Left",
        disabled: i <= 0,
        onSelect: () => movePen(pens, p.id, -1) && persistPens(),
      },
      {
        label: "Move Right",
        disabled: i >= pens.length - 1,
        onSelect: () => movePen(pens, p.id, 1) && persistPens(),
      },
      {
        label: "Remove Pen",
        danger: true,
        disabled: pens.length <= 1,
        onSelect: () => {
          if (tool === p.id) setTool(null);
          removePen(pens, p.id);
          persistPens();
        },
      },
    ];
  }
  function penIcon(p) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 32");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "40");
    svg.setAttribute("aria-hidden", "true");
    const c = p.color;
    svg.innerHTML =
      p.type === "highlighter"
        ? `<path d="M6 2h8v14l-2 4H8l-2-4z" class="ink-pen-body"/><path d="M8 20h4l-1 6H9z" fill="${c}" class="ink-pen-edge"/><rect x="6" y="8" width="8" height="4" fill="${c}"/>`
        : p.type === "pencil"
          ? `<path d="M7 2h6v16H7z" class="ink-pen-body"/><path d="M7 18h6l-3 8z" fill="#e9d3a8" class="ink-pen-edge"/><path d="M9 23.3h2L10 26z" fill="${c}"/><path d="M8.5 2v16M11.5 2v16" class="ink-pen-edge"/><rect x="7" y="9" width="6" height="3" fill="${c}"/>`
          : `<path d="M7 2h6v16l-3 8-3-8z" class="ink-pen-body"/><path d="M8.2 21h3.6L10 26z" fill="${c}"/><rect x="7" y="9" width="6" height="4" fill="${c}"/>${p.texture === "dotted" ? `<path d="M10 28.5h0M13 28.5h0M7 28.5h0" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>` : ""}`;
    return svg;
  }
  function penButton(p) {
    const label = penLabel(p);
    const open = (anchor) => {
      anchor.setAttribute("aria-expanded", "true");
      openMenu({
        anchor,
        label,
        items: penMenu(p),
        minWidth: 240,
        onClose: () => anchor.setAttribute("aria-expanded", "false"),
      });
    };
    return el(
      "button",
      {
        type: "button",
        class: "ribbon-btn ink-pen",
        "aria-label": label,
        "aria-pressed": String(tool === p.id),
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "data-command": `draw-${p.id}`,
        "data-pen-type": p.type,
        "data-tip-title": label,
        "data-tip-text":
          "Click again to choose its colour, thickness and texture, move it or remove it.",
        onclick: (e) => {
          if (tool === p.id) open(e.currentTarget);
          else setTool(p.id);
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          open(e.currentTarget);
        },
        onkeydown: (e) => {
          if (e.key === "ArrowDown" && e.altKey) {
            e.preventDefault();
            open(e.currentTarget);
          }
        },
      },
      penIcon(p),
    );
  }
  // The pens sit in one strip that is redrawn whenever the collection or the
  // chosen pen changes.
  function penStrip() {
    const strip = el("div", {
      class: "ink-pens",
      role: "group",
      "aria-label": "Pens",
    });
    strip._stamp = "";
    return strip;
  }
  function syncStrip(strip) {
    const stamp = JSON.stringify([pens, tool]);
    if (strip._stamp === stamp) return;
    const focused = strip.contains(document.activeElement)
      ? document.activeElement.dataset.command
      : null;
    strip._stamp = stamp;
    strip.replaceChildren(...pens.map(penButton));
    if (focused)
      strip.querySelector(`[data-command="${CSS.escape(focused)}"]`)?.focus();
  }
  function addPenMenu() {
    const full = pens.length >= MAX_PENS;
    return [
      ...Object.entries(PEN_TYPES).map(([type, spec]) => ({
        label: `Add ${spec.label}`,
        disabled: full,
        onSelect: () => {
          const made = addPen(pens, type);
          if (!made) return;
          savePens(pens);
          setTool(made.id);
        },
      })),
      { separator: true },
      {
        label: "Reset Pens",
        onSelect: () => {
          if (pens.some((p) => p.id === tool)) setTool(null);
          pens = resetPens();
          changed();
        },
      },
    ];
  }
  function eraserMenu() {
    const pick = (fn) => () => {
      fn();
      savePrefs();
      if (tool !== "eraser") setTool("eraser");
      else {
        attach();
        changed();
      }
    };
    return [
      {
        label: "Stroke Eraser",
        checked: prefs.eraser === "stroke",
        onSelect: pick(() => (prefs.eraser = "stroke")),
      },
      {
        label: "Point Eraser",
        checked: prefs.eraser === "point",
        onSelect: pick(() => (prefs.eraser = "point")),
      },
      { separator: true },
      { header: "Point Eraser Size" },
      ...Object.entries(ERASER_SIZES).map(([key, s]) => ({
        label: s.label,
        checked: prefs.eraserSize === key,
        onSelect: pick(() => {
          prefs.eraser = "point";
          prefs.eraserSize = key;
        }),
      })),
    ];
  }
  function tab() {
    const hasInk = () => {
      try {
        return inkShapes(P, currentSlide()).length > 0;
      } catch {
        return false;
      }
    };
    return {
      id: "draw",
      label: "Draw",
      after: "insert",
      groups: [
        {
          id: "drawing-tools",
          label: "Tools",
          icon: "penTool",
          collapsible: false,
          items: [
            {
              type: "large",
              id: "draw-select",
              label: "Select",
              icon: "select",
              title: "Select Objects",
              description: "Stop drawing and select objects on the slide.",
              pressed: () => !tool,
              run: () => tool && setTool(tool),
            },
            {
              type: "large",
              id: "draw-eraser",
              label: "Eraser",
              icon: "eraserTool",
              dynamicIcon: () =>
                prefs.eraser === "point" ? "pointEraser" : "eraserTool",
              title: "Eraser",
              description:
                "Erase ink by drawing over it. Choose the stroke eraser to remove whole strokes, or the point eraser to rub out only what it passes over.",
              pressed: () => tool === "eraser",
              run: () => setTool("eraser"),
              split: true,
              menuLabel: "Eraser options",
              menu: eraserMenu,
            },
            {
              type: "large",
              id: "draw-lasso",
              label: "Lasso\nSelect",
              icon: "lassoSelect",
              title: "Lasso Select",
              description:
                "Draw a loop around ink and objects to select everything wholly inside it.",
              pressed: () => tool === "lasso",
              run: () => setTool("lasso"),
            },
          ],
        },
        {
          id: "drawing-pens",
          label: "Pens",
          icon: "penTool",
          collapsible: false,
          items: [
            { type: "custom", render: penStrip, sync: syncStrip },
            {
              type: "large",
              id: "draw-add-pen",
              label: "Add\nPen",
              icon: "addPen",
              title: "Add Pen",
              description:
                "Add a pen, pencil or highlighter to your pens. Your pens are kept on this device.",
              menu: addPenMenu,
            },
          ],
        },
        {
          id: "drawing-convert",
          label: "Convert",
          icon: "inkToShape",
          items: [
            {
              type: "large",
              id: "draw-ink-to-text",
              label: "Ink to\nText",
              icon: "inkToText",
              title: "Ink to Text",
              description:
                "Turn handwriting into a text box. Works on the selected ink, or all the ink on the slide. Uses the AI to read it.",
              enabled: () => !busy && hasInk(),
              run: () => inkToWords("text").catch(report),
            },
            {
              type: "large",
              id: "draw-ink-to-shape",
              label: "Ink to\nShape",
              icon: "inkToShape",
              title: "Ink to Shape",
              description:
                "While on, lines, arrows, rectangles, triangles, ellipses, diamonds, pentagons, hexagons and stars you draw become real shapes.",
              pressed: () => prefs.inkToShape,
              run: () => {
                prefs.inkToShape = !prefs.inkToShape;
                savePrefs();
                if (prefs.inkToShape && !pen())
                  setTool(pens.find((p) => p.type !== "highlighter")?.id);
                else changed();
              },
              split: true,
              menuLabel: "Ink to Shape options",
              menu: () => [
                {
                  label: "Convert Ink to Shapes",
                  icon: "o:convertInk",
                  disabled: !hasInk(),
                  onSelect: () => convertToShapes().catch(report),
                },
              ],
            },
            {
              type: "large",
              id: "draw-ink-to-math",
              label: "Ink to\nMath",
              icon: "inkToMath",
              title: "Ink to Math",
              description:
                "Turn a handwritten formula into an equation. Works on the selected ink, or all the ink on the slide. Uses the AI to read it.",
              enabled: () => !busy && hasInk(),
              run: () => inkToWords("math").catch(report),
            },
          ],
        },
        {
          id: "drawing-replay",
          label: "Replay",
          icon: "inkReplay",
          items: [
            {
              type: "large",
              id: "draw-ink-replay",
              label: "Ink\nReplay",
              icon: "inkReplay",
              title: "Ink Replay",
              description:
                "Play back the ink on this slide in the order and at the pace it was drawn.",
              enabled: () => hasInk(),
              pressed: () => !!replay,
              run: () => (replay ? replay.close() : startReplay()),
            },
          ],
        },
        {
          id: "drawing-stencils",
          label: "Stencils",
          icon: "ruler",
          items: [
            {
              type: "large",
              id: "draw-ruler",
              label: "Ruler",
              icon: "ruler",
              title: "Ruler",
              description:
                "Show a ruler on the slide. Drag it to move, turn it by its knob or the mouse wheel, and pens follow its edges.",
              pressed: () => ruler.visible,
              run: () => {
                ruler.setVisible(!ruler.visible);
                changed();
              },
            },
            {
              type: "large",
              id: "draw-touch",
              label: "Draw with\nTouch",
              icon: "drawWithTouch",
              title: "Draw with Touch",
              description:
                "When on, a finger draws with the chosen pen. When off, only a pen or mouse draws and a finger scrolls.",
              pressed: () => prefs.drawWithTouch,
              run: () => {
                prefs.drawWithTouch = !prefs.drawWithTouch;
                savePrefs();
                attach();
                changed();
              },
            },
          ],
        },
      ],
    };
  }
  return {
    tab,
    get tool() {
      return tool;
    },
    setTool,
    attach,
    stop: () => tool && setTool(tool),
    isInk: (shape) => isInk(P, shape),
    /** For tests and the menus: the pens as they are. */
    get pens() {
      return pens.map((p) => ({ ...p }));
    },
    get ruler() {
      return ruler;
    },
    get replaying() {
      return !!replay;
    },
    inkToText: () => inkToWords("text"),
    inkToMath: () => inkToWords("math"),
    convertToShapes,
    startReplay,
    lassoed,
  };
}

// Ink during a slide show: a pen the presenter writes on the slide with, and
// the ink kept per slide while the show runs. Nothing is written into the
// presentation here: when the show ends, the caller asks whether to keep the
// ink and adds it to the slides as ordinary ink strokes.
//
// Points are kept as fractions of the slide (0–1 each way), so the ink stays
// put whatever size the show is drawn at.

const SVG = "http://www.w3.org/2000/svg";
export const SHOW_PEN_COLORS = [
  ["Red", "#E81224"],
  ["Black", "#000000"],
  ["Blue", "#0063B1"],
  ["Green", "#00B050"],
  ["Yellow", "#FFFF00"],
];

/**
 * A pen over `frame` (the element the slide is drawn in). `slideKey()` says
 * which slide is showing; `width` is the pen's width as a fraction of the
 * slide's width.
 */
export function createShowInk(frame, { slideKey, width = 0.0035 } = {}) {
  const document = frame.ownerDocument;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "presenter-ink");
  svg.setAttribute("viewBox", "0 0 1000 1000");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  frame.append(svg);
  const controller = new AbortController();
  const listen = (target, name, handler, options = {}) =>
    target.addEventListener(name, handler, {
      ...options,
      signal: controller.signal,
    });
  /** @type {Map<string, Array<{points: {x:number,y:number,t:number}[], color: string, width: number, start: number}>>} */
  const ink = new Map();
  let enabled = false;
  let color = SHOW_PEN_COLORS[0][1];
  let current = null;
  let suppressClick = false;

  function pathFor(stroke) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("stroke", stroke.color);
    path.setAttribute("vector-effect", "non-scaling-stroke");
    path.style.strokeWidth = `calc(${stroke.width} * var(--presenter-ink-w, 1000px))`;
    return path;
  }
  function d(points) {
    return points.length
      ? `M${points.map((p) => `${(p.x * 1000).toFixed(1)} ${(p.y * 1000).toFixed(1)}`).join("L")}${points.length === 1 ? "l0.5 0" : ""}`
      : "";
  }
  function redraw() {
    svg.replaceChildren();
    for (const stroke of ink.get(slideKey()) || []) {
      const path = pathFor(stroke);
      path.setAttribute("d", d(stroke.points));
      svg.append(path);
    }
    sizeStroke();
  }
  function sizeStroke() {
    svg.style.setProperty(
      "--presenter-ink-w",
      `${frame.getBoundingClientRect().width || 1000}px`,
    );
  }
  function at(e) {
    const box = frame.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - box.left) / (box.width || 1))),
      y: Math.min(1, Math.max(0, (e.clientY - box.top) / (box.height || 1))),
    };
  }
  listen(
    frame,
    "pointerdown",
    (e) => {
      if (!enabled || e.button !== 0) return;
      if (e.target.closest?.(".presenter-link")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      suppressClick = true;
      frame.setPointerCapture(e.pointerId);
      const t0 = performance.now();
      current = {
        id: e.pointerId,
        t0,
        stroke: {
          points: [{ ...at(e), t: 0 }],
          color,
          width,
          start: Date.now(),
        },
      };
      const key = slideKey();
      if (!ink.has(key)) ink.set(key, []);
      ink.get(key).push(current.stroke);
      current.path = pathFor(current.stroke);
      current.path.setAttribute("d", d(current.stroke.points));
      sizeStroke();
      svg.append(current.path);
    },
    { capture: true },
  );
  listen(frame, "pointermove", (e) => {
    if (!current || e.pointerId !== current.id) return;
    for (const c of e.getCoalescedEvents?.() || [e])
      current.stroke.points.push({
        ...at(c),
        t: Math.round(performance.now() - current.t0),
      });
    current.path.setAttribute("d", d(current.stroke.points));
  });
  const end = (e) => {
    if (!current || e.pointerId !== current.id) return;
    e.preventDefault?.();
    current = null;
  };
  listen(frame, "pointerup", end, { capture: true });
  listen(frame, "pointercancel", end);
  // A stroke is not a click: the show does not move on when one ends.
  listen(
    frame,
    "click",
    (e) => {
      if (!enabled && !suppressClick) return;
      suppressClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    { capture: true },
  );
  for (const name of ["touchstart", "touchmove", "touchend"])
    listen(
      frame,
      name,
      (e) => {
        if (!enabled) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      { capture: true, passive: false },
    );
  const resize = new ResizeObserver(sizeStroke);
  resize.observe(frame);

  return {
    get enabled() {
      return enabled;
    },
    setEnabled(on) {
      enabled = !!on;
      frame.classList.toggle("ink-mode", enabled);
    },
    get color() {
      return color;
    },
    setColor(value) {
      color = value;
    },
    /** The slide shown changed. */
    show: redraw,
    /** Takes the ink off the slide showing. */
    clearSlide() {
      ink.delete(slideKey());
      redraw();
    },
    /** Whether any slide has ink. */
    get hasInk() {
      return [...ink.values()].some((list) => list.length);
    },
    /** The ink drawn, by slide key: [{ points, color, width, start }]. */
    strokes() {
      return new Map([...ink].filter(([, list]) => list.length));
    },
    dispose() {
      controller.abort();
      resize.disconnect();
      svg.remove();
      frame.classList.remove("ink-mode");
    },
  };
}

/**
 * Adds ink drawn during a show to the slides it was drawn on, as ink
 * strokes with their timing. `strokes` is createShowInk().strokes(), keyed
 * by slide part name. Returns how many strokes were added.
 */
export function addShowInk(P, pres, strokes, addInkStroke, MM) {
  const size = P.getSlideSize(pres) || { width: 12192000, height: 6858000 };
  const byPart = new Map(
    P.getSlides(pres).map((s) => [P.getSlidePartName(s), s]),
  );
  let added = 0;
  for (const [part, list] of strokes) {
    const slide = byPart.get(part);
    if (!slide) continue;
    for (const stroke of list) {
      const points = stroke.points.map((p) => ({
        x: p.x * size.width,
        y: p.y * size.height,
      }));
      addInkStroke(
        P,
        slide,
        points,
        {
          type: "pen",
          color: stroke.color,
          width: (stroke.width * size.width) / (MM * 12700),
          texture: "solid",
        },
        {
          tolerance: size.width / 2000,
          times: stroke.points.map((p) => p.t),
          start: stroke.start,
        },
      );
      added++;
    }
  }
  return added;
}

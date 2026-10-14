// Ink during a slide show: a pen and a highlighter that draw over the slide,
// and an eraser that takes strokes away. Strokes are held per slide in slide
// coordinates (EMU), so going back to a slide shows its ink again, and the
// same strokes draw on every surface showing the slide (the audience's
// screen and the presenter's copy). At the end of the show they can become
// ink on the slides, as the Draw tab makes it (src/draw/ink-model.js).

const SVG = "http://www.w3.org/2000/svg";
const PT = 12700;
const MM = 2.835 * PT;
export const PEN_WIDTH = Math.round(0.8 * MM);
export const HIGHLIGHTER_WIDTH = Math.round(5 * MM);
export const INK_COLORS = [
  ["#E81224", "Red"],
  ["#FFB900", "Yellow"],
  ["#16C60C", "Green"],
  ["#0063B1", "Blue"],
  ["#886CE4", "Purple"],
  ["#000000", "Black"],
  ["#FFFFFF", "White"],
];

/**
 * size: slide size in EMU { width, height }.
 * onChange(): strokes were added or removed.
 */
export function createShowInk({ size, penColor = "#E81224", onChange } = {}) {
  const strokes = new Map(); // slide key -> stroke[]
  const surfaces = new Set();
  let key = null;
  let tool = null; // null | "pen" | "highlighter" | "eraser"
  let visible = true;
  const colors = { pen: penColor, highlighter: "#FFFF00" };

  function list(k = key) {
    if (!strokes.has(k)) strokes.set(k, []);
    return strokes.get(k);
  }
  function pathData(points) {
    if (!points.length) return "";
    const [first, ...rest] = points;
    if (!rest.length) return `M${first.x} ${first.y}l0.1 0`;
    return `M${first.x} ${first.y}${rest.map((p) => `L${p.x} ${p.y}`).join("")}`;
  }
  function strokeNode(stroke, doc = document) {
    const path = doc.createElementNS(SVG, "path");
    path.setAttribute("d", pathData(stroke.points));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", stroke.color);
    path.setAttribute("stroke-width", String(stroke.width));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    if (stroke.tool === "highlighter") {
      path.setAttribute("stroke-opacity", "0.5");
      path.setAttribute("class", "show-ink-highlight");
    }
    return path;
  }
  function render(surface) {
    const doc = surface.svg.ownerDocument;
    surface.svg.replaceChildren(
      ...list().map((stroke) => strokeNode(stroke, doc)),
    );
    surface.svg.style.visibility = visible ? "" : "hidden";
  }
  function renderAll() {
    surfaces.forEach(render);
  }
  function sync(surface) {
    const active = !!tool;
    surface.capture.hidden = !active;
    surface.capture.dataset.tool = tool || "";
    surface.host.classList.toggle("show-inking", active);
    surface.host.classList.toggle("ink-mode", active && tool !== "eraser");
  }

  /** Draws on `host` (an element laid over the slide, in its proportions). */
  function addSurface(host) {
    const doc = host.ownerDocument;
    const svg = doc.createElementNS(SVG, "svg");
    svg.setAttribute("class", "show-ink presenter-ink");
    svg.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    const capture = doc.createElement("div");
    capture.className = "show-ink-capture";
    capture.hidden = true;
    host.append(svg, capture);
    const surface = { host, svg, capture };
    const toSlide = (e) => {
      const box = capture.getBoundingClientRect();
      return {
        x: Math.round(((e.clientX - box.left) / (box.width || 1)) * size.width),
        y: Math.round(
          ((e.clientY - box.top) / (box.height || 1)) * size.height,
        ),
      };
    };
    capture.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !tool) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        capture.setPointerCapture(e.pointerId);
      } catch {}
      if (tool === "eraser") return erase(e, capture, toSlide);
      // When each point was drawn travels with the stroke, for replay.
      const t0 = performance.now();
      const stroke = {
        tool,
        color: colors[tool],
        width: tool === "highlighter" ? HIGHLIGHTER_WIDTH : PEN_WIDTH,
        start: Date.now(),
        points: [{ ...toSlide(e), t: 0 }],
      };
      const live = strokeNode(stroke, doc);
      svg.append(live);
      const move = (ev) => {
        for (const c of ev.getCoalescedEvents?.() || [ev])
          stroke.points.push({
            ...toSlide(c),
            t: Math.round(performance.now() - t0),
          });
        live.setAttribute("d", pathData(stroke.points));
      };
      const up = () => {
        capture.removeEventListener("pointermove", move);
        capture.removeEventListener("pointerup", up);
        capture.removeEventListener("pointercancel", up);
        list().push(stroke);
        renderAll();
        onChange?.();
      };
      capture.addEventListener("pointermove", move);
      capture.addEventListener("pointerup", up);
      capture.addEventListener("pointercancel", up);
    });
    // Drawing never advances the show.
    capture.addEventListener("click", (e) => e.stopPropagation());
    surfaces.add(surface);
    render(surface);
    sync(surface);
    return () => {
      surfaces.delete(surface);
      svg.remove();
      capture.remove();
    };
  }

  function erase(e, capture, toSlide) {
    const reach = size.width / 120;
    const sweep = (point) => {
      const before = list().length;
      strokes.set(
        key,
        list().filter(
          (stroke) =>
            !stroke.points.some(
              (p, i) =>
                Math.hypot(p.x - point.x, p.y - point.y) <=
                  reach + stroke.width / 2 ||
                (i > 0 &&
                  segmentDistance(point, stroke.points[i - 1], p) <=
                    reach + stroke.width / 2),
            ),
        ),
      );
      if (list().length !== before) {
        renderAll();
        onChange?.();
      }
    };
    sweep(toSlide(e));
    const move = (ev) => sweep(toSlide(ev));
    const up = () => {
      capture.removeEventListener("pointermove", move);
      capture.removeEventListener("pointerup", up);
      capture.removeEventListener("pointercancel", up);
    };
    capture.addEventListener("pointermove", move);
    capture.addEventListener("pointerup", up);
    capture.addEventListener("pointercancel", up);
  }

  return {
    get tool() {
      return tool;
    },
    get visible() {
      return visible;
    },
    colors,
    addSurface,
    /** The slide being shown, by any stable key (its part name). */
    setSlide(k) {
      key = k;
      renderAll();
    },
    setTool(next) {
      tool = next || null;
      surfaces.forEach(sync);
    },
    setColor(which, color) {
      colors[which] = color;
    },
    setVisible(on) {
      visible = !!on;
      renderAll();
    },
    /** Takes every stroke off the current slide. */
    clear() {
      if (!list().length) return false;
      strokes.set(key, []);
      renderAll();
      onChange?.();
      return true;
    },
    has: (k = key) => (strokes.get(k) || []).length > 0,
    /** Every slide's strokes: [[key, strokes]] for slides that have some. */
    all: () => [...strokes].filter(([, s]) => s.length),
    count: () => [...strokes.values()].reduce((n, s) => n + s.length, 0),
  };
}

// The distance from point p to segment ab.
function segmentDistance(p, a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len))
    : 0;
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}

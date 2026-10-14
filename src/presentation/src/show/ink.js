// Ink during a slide show: a pen and a highlighter that draw over the slide,
// and an eraser that takes strokes away. Strokes are held per slide in slide
// coordinates (EMU), so going back to a slide shows its ink again, and the
// same strokes draw on every surface showing the slide (the audience's
// screen and the presenter's copy). At the end of the show they can become
// ink shapes on the slides, the same freeform shapes the Draw tab makes.

const SVG = "http://www.w3.org/2000/svg";
const PT = 12700;
const MM = 2.835 * PT;
export const INK_NAME = "Ink";
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
  }

  /** Draws on `host` (an element laid over the slide, in its proportions). */
  function addSurface(host) {
    const doc = host.ownerDocument;
    const svg = doc.createElementNS(SVG, "svg");
    svg.setAttribute("class", "show-ink");
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
      const stroke = {
        tool,
        color: colors[tool],
        width: tool === "highlighter" ? HIGHLIGHTER_WIDTH : PEN_WIDTH,
        points: [toSlide(e)],
      };
      const live = strokeNode(stroke, doc);
      svg.append(live);
      const move = (ev) => {
        for (const c of ev.getCoalescedEvents?.() || [ev])
          stroke.points.push(toSlide(c));
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

// Ramer–Douglas–Peucker: the fewest points within `tolerance` of the line.
export function simplifyStroke(points, tolerance) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const sq = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1,
      far = sq;
    const ax = points[a].x,
      ay = points[a].y,
      dx = points[b].x - ax,
      dy = points[b].y - ay;
    const len = dx * dx + dy * dy || 1;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(
        0,
        Math.min(1, ((points[i].x - ax) * dx + (points[i].y - ay) * dy) / len),
      );
      const ex = ax + t * dx - points[i].x,
        ey = ay + t * dy - points[i].y;
      const d = ex * ex + ey * ey;
      if (d > far) {
        far = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** A stroke as the box and smooth path of a freeform shape. */
export function strokeGeometry(stroke, slideWidth) {
  const tolerance = slideWidth / 2000;
  const kept = simplifyStroke(stroke.points, tolerance);
  if (kept.length === 1) kept.push({ x: kept[0].x + tolerance, y: kept[0].y });
  const xs = kept.map((q) => q.x),
    ys = kept.map((q) => q.y);
  const minX = Math.min(...xs),
    minY = Math.min(...ys);
  const w = Math.max(1, Math.round(Math.max(...xs) - minX)),
    h = Math.max(1, Math.round(Math.max(...ys) - minY));
  const local = kept.map((q) => ({ x: q.x - minX, y: q.y - minY }));
  const commands = [{ type: "moveTo", ...local[0] }];
  for (let i = 0; i < local.length - 1; i++) {
    const p0 = local[i - 1] || local[i],
      p1 = local[i],
      p2 = local[i + 1],
      p3 = local[i + 2] || p2;
    // Catmull-Rom through the points, as cubic Bézier segments.
    commands.push({
      type: "cubicTo",
      x1: p1.x + (p2.x - p0.x) / 6,
      y1: p1.y + (p2.y - p0.y) / 6,
      x2: p2.x - (p3.x - p1.x) / 6,
      y2: p2.y - (p3.y - p1.y) / 6,
      x: p2.x,
      y: p2.y,
    });
  }
  return { x: Math.round(minX), y: Math.round(minY), w, h, commands };
}

/** Adds a stroke to a slide as an ink shape. */
export function addInkShape(P, slide, stroke, slideWidth) {
  const g = strokeGeometry(stroke, slideWidth);
  const shape = P.addSlideShape(slide, {
    preset: "rect",
    x: g.x,
    y: g.y,
    w: g.w,
    h: g.h,
    name: `${INK_NAME} ${Date.now() % 100000}`,
  });
  P.setShapeFreeformPaths(shape, [
    { w: g.w, h: g.h, fill: false, commands: g.commands },
  ]);
  P.setShapeNoFill(shape);
  P.setShapeStroke(shape, {
    color:
      stroke.tool === "highlighter"
        ? `${stroke.color}/alpha=50000`
        : stroke.color,
    widthEmu: stroke.width,
  });
  P.setShapeStrokeCap(shape, "rnd");
  P.setShapeStrokeJoin(shape, "round");
  return shape;
}

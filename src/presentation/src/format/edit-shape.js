// Edit Shape: Change Shape (every preset geometry, in groups, drawn from the
// same definitions the slide uses), Edit Points (drag a freeform's points and
// curve handles; a preset turns into a freeform first), and Merge Shapes
// (union, combine, fragment, intersect, subtract) computed on the shapes'
// outlines.
import { el } from "../ui.js";
import { galleryGrid } from "./controls.js";
import { parsePresetGeometry } from "../../lib/pptx/src/internal/drawingml/preset-geometry.ts";
import {
  flattenGeometry,
  transformRings,
  ringsToFreeformPaths,
} from "./geometry-flatten.js";
import {
  union,
  intersect,
  subtract,
  xor,
  fragment,
} from "./polygon-boolean.js";

// ---------------------------------------------------------------------------
// Preset shapes, by group

export const SHAPE_GROUPS = [
  [
    "Rectangles",
    "rect roundRect snip1Rect snip2SameRect snip2DiagRect snipRoundRect round1Rect round2SameRect round2DiagRect",
  ],
  [
    "Basic Shapes",
    "ellipse triangle rtTriangle parallelogram trapezoid nonIsoscelesTrapezoid diamond pentagon hexagon heptagon octagon decagon dodecagon pie chord teardrop frame halfFrame corner diagStripe plus plaque can cube bevel donut noSmoking blockArc foldedCorner smileyFace heart lightningBolt sun moon cloud arc bracketPair bracePair leftBracket rightBracket leftBrace rightBrace pieWedge funnel gear6 gear9 cornerTabs squareTabs plaqueTabs chartX chartStar chartPlus",
  ],
  [
    "Block Arrows",
    "rightArrow leftArrow upArrow downArrow leftRightArrow upDownArrow quadArrow leftRightUpArrow bentArrow uturnArrow leftUpArrow bentUpArrow curvedRightArrow curvedLeftArrow curvedUpArrow curvedDownArrow stripedRightArrow notchedRightArrow homePlate chevron rightArrowCallout downArrowCallout leftArrowCallout upArrowCallout leftRightArrowCallout upDownArrowCallout quadArrowCallout circularArrow leftCircularArrow leftRightCircularArrow swooshArrow",
  ],
  [
    "Equation Shapes",
    "mathPlus mathMinus mathMultiply mathDivide mathEqual mathNotEqual",
  ],
  [
    "Flowchart",
    "flowChartProcess flowChartAlternateProcess flowChartDecision flowChartInputOutput flowChartPredefinedProcess flowChartInternalStorage flowChartDocument flowChartMultidocument flowChartTerminator flowChartPreparation flowChartManualInput flowChartManualOperation flowChartConnector flowChartOffpageConnector flowChartPunchedCard flowChartPunchedTape flowChartSummingJunction flowChartOr flowChartCollate flowChartSort flowChartExtract flowChartMerge flowChartOnlineStorage flowChartDelay flowChartMagneticTape flowChartMagneticDisk flowChartMagneticDrum flowChartDisplay flowChartOfflineStorage",
  ],
  [
    "Stars and Banners",
    "irregularSeal1 irregularSeal2 star4 star5 star6 star7 star8 star10 star12 star16 star24 star32 ribbon2 ribbon ellipseRibbon2 ellipseRibbon leftRightRibbon verticalScroll horizontalScroll wave doubleWave",
  ],
  [
    "Callouts",
    "wedgeRectCallout wedgeRoundRectCallout wedgeEllipseCallout cloudCallout borderCallout1 borderCallout2 borderCallout3 accentCallout1 accentCallout2 accentCallout3 callout1 callout2 callout3 accentBorderCallout1 accentBorderCallout2 accentBorderCallout3",
  ],
  [
    "Action Buttons",
    "actionButtonBackPrevious actionButtonForwardNext actionButtonBeginning actionButtonEnd actionButtonHome actionButtonInformation actionButtonReturn actionButtonMovie actionButtonDocument actionButtonSound actionButtonHelp actionButtonBlank",
  ],
].map(([group, list]) => [group, list.split(" ")]);

const NAMES = {
  rect: "Rectangle",
  roundRect: "Rounded Rectangle",
  snip1Rect: "Snipped Corner Rectangle",
  snip2SameRect: "Snipped Same Side Corners",
  snip2DiagRect: "Snipped Diagonal Corners",
  snipRoundRect: "Snipped and Rounded Corners",
  round1Rect: "Rounded Corner Rectangle",
  round2SameRect: "Rounded Same Side Corners",
  round2DiagRect: "Rounded Diagonal Corners",
  ellipse: "Oval",
  rtTriangle: "Right Triangle",
  nonIsoscelesTrapezoid: "Uneven Trapezoid",
  diagStripe: "Diagonal Stripe",
  can: "Cylinder",
  noSmoking: "Prohibited Sign",
  blockArc: "Block Arc",
  foldedCorner: "Folded Corner",
  smileyFace: "Smiley Face",
  lightningBolt: "Lightning Bolt",
  bracketPair: "Double Bracket",
  bracePair: "Double Brace",
  pieWedge: "Quarter Circle",
  gear6: "Gear, Six Teeth",
  gear9: "Gear, Nine Teeth",
  chartX: "Chart Cross",
  chartStar: "Chart Star",
  chartPlus: "Chart Plus",
  homePlate: "Pentagon Arrow",
  uturnArrow: "U-Turn Arrow",
  irregularSeal1: "Explosion 1",
  irregularSeal2: "Explosion 2",
  ribbon2: "Ribbon, Tilted Up",
  ribbon: "Ribbon, Tilted Down",
  ellipseRibbon2: "Curved Ribbon Up",
  ellipseRibbon: "Curved Ribbon Down",
  wedgeRectCallout: "Speech Bubble, Rectangle",
  wedgeRoundRectCallout: "Speech Bubble, Rounded",
  wedgeEllipseCallout: "Speech Bubble, Oval",
  cloudCallout: "Thought Bubble",
  mathPlus: "Plus Sign",
  mathMinus: "Minus Sign",
  mathMultiply: "Multiplication Sign",
  mathDivide: "Division Sign",
  mathEqual: "Equal Sign",
  mathNotEqual: "Not Equal Sign",
};

/** A readable name for a preset geometry. */
export function presetName(preset) {
  if (NAMES[preset]) return NAMES[preset];
  let name = preset
    .replace(/^flowChart/, "Flowchart: ")
    .replace(/^actionButton/, "Action Button: ")
    .replace(/^star(\d+)/, "Star: $1 Points")
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2");
  name = name.charAt(0).toUpperCase() + name.slice(1);
  return name.replace(/\s+/g, " ").trim();
}

const previewCache = new Map();
/** SVG path data for a preset drawn in a 40×40 box. */
export function presetPath(preset, w = 40, h = 40) {
  const key = `${preset}|${w}|${h}`;
  if (previewCache.has(key)) return previewCache.get(key);
  let d = "";
  try {
    const geometry = parsePresetGeometry(preset, w, h);
    if (geometry)
      d = flattenGeometry(geometry, { tolerance: 0.15, w, h })
        .map(
          (ring) =>
            `M${ring.points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("L")}${ring.closed ? "Z" : ""}`,
        )
        .join("");
  } catch {}
  previewCache.set(key, d);
  return d;
}

export function presetPreview(preset) {
  const node = el("span", {
    class: "fmt-shape-preview",
    "aria-hidden": "true",
  });
  node.innerHTML = `<svg viewBox="-2 -2 44 44" width="26" height="26"><path d="${presetPath(preset)}" fill="var(--fmt-shape-fill)" stroke="var(--fmt-shape-line)" stroke-width="1.6" stroke-linejoin="round" fill-rule="evenodd"/></svg>`;
  return node;
}

/** The Change Shape menu: every preset in its group. */
export function changeShapeItems({ current, choose }) {
  return SHAPE_GROUPS.map(([group, presets]) => ({
    custom: el(
      "div",
      { class: "fmt-gallery-group" },
      el("div", { class: "menu-header" }, group),
      galleryGrid(
        presets.map((preset) => ({
          label: presetName(preset),
          checked: preset === current,
          render: () => presetPreview(preset),
          onSelect: () => choose(preset),
        })),
        { label: group, columns: 8, cellClass: "fmt-shape-cell" },
      ),
    ),
  }));
}

// ---------------------------------------------------------------------------
// Editable paths: geometry as nodes with optional curve handles

const TURN = 21600000;

// Cubic Bézier pieces for a DrawingML arc that starts at (x, y).
function arcToCubics(x, y, wR, hR, stAng, swAng) {
  if (!swAng || (!wR && !hR)) return [];
  const sweep = Math.max(-TURN, Math.min(TURN, swAng));
  const rad = (a) => ((a % TURN) / TURN) * 2 * Math.PI;
  if (!wR || !hR) {
    const t = rad(stAng + sweep),
      s = rad(stAng);
    return [
      {
        line: {
          x: x + wR * (Math.cos(t) - Math.cos(s)),
          y: y + hR * (Math.sin(t) - Math.sin(s)),
        },
      },
    ];
  }
  const param = (a) => {
    const t = rad(a);
    return Math.atan2(wR * Math.sin(t), hR * Math.cos(t));
  };
  const start = param(stAng);
  let span = param((stAng % TURN) + sweep) - start;
  if (Math.abs(sweep) === TURN) span = Math.sign(sweep) * 2 * Math.PI;
  else if (sweep > 0 && span < 0) span += 2 * Math.PI;
  else if (sweep < 0 && span > 0) span -= 2 * Math.PI;
  const cx = x - wR * Math.cos(start),
    cy = y - hR * Math.sin(start);
  const pieces = Math.max(1, Math.ceil(Math.abs(span) / (Math.PI / 2) - 1e-9));
  const step = span / pieces;
  const k = (4 / 3) * Math.tan(step / 4);
  const out = [];
  for (let i = 0; i < pieces; i++) {
    const a0 = start + step * i,
      a1 = a0 + step;
    const p0 = { x: cx + wR * Math.cos(a0), y: cy + hR * Math.sin(a0) };
    const p1 = { x: cx + wR * Math.cos(a1), y: cy + hR * Math.sin(a1) };
    out.push({
      c1: { x: p0.x - k * wR * Math.sin(a0), y: p0.y + k * hR * Math.cos(a0) },
      c2: { x: p1.x + k * wR * Math.sin(a1), y: p1.y - k * hR * Math.cos(a1) },
      end: p1,
    });
  }
  return out;
}

/**
 * Turns resolved geometry into editable subpaths in the shape's own EMU
 * space: [{ closed, fill, nodes: [{ x, y, in?, out? }] }].
 */
export function editablePaths(geometry, w, h) {
  const out = [];
  for (const path of geometry?.paths || []) {
    const sx = path.w ? w / path.w : 1,
      sy = path.h ? h / path.h : 1;
    const P = (pt) => ({ x: pt.x * sx, y: pt.y * sy });
    let current = null;
    let pen = { x: 0, y: 0 };
    const start = (pt) => {
      current = {
        closed: false,
        fill: path.fill !== "none",
        nodes: [{ ...pt }],
      };
      out.push(current);
    };
    for (const cmd of path.commands) {
      if (cmd.kind === "moveTo") {
        pen = P(cmd.pt);
        start(pen);
      } else if (cmd.kind === "lnTo") {
        if (!current) start(pen);
        pen = P(cmd.pt);
        current.nodes.push({ ...pen });
      } else if (cmd.kind === "cubicBezTo" || cmd.kind === "quadBezTo") {
        if (!current) start(pen);
        let [c1, c2, end] =
          cmd.kind === "cubicBezTo"
            ? cmd.pts.map(P)
            : (() => {
                const [c, e] = cmd.pts.map(P);
                return [
                  {
                    x: pen.x + (2 / 3) * (c.x - pen.x),
                    y: pen.y + (2 / 3) * (c.y - pen.y),
                  },
                  {
                    x: e.x + (2 / 3) * (c.x - e.x),
                    y: e.y + (2 / 3) * (c.y - e.y),
                  },
                  e,
                ];
              })();
        current.nodes.at(-1).out = c1;
        current.nodes.push({ ...end, in: c2 });
        pen = end;
      } else if (cmd.kind === "arcTo") {
        if (!current) start(pen);
        // Arc radii are in path units too.
        for (const piece of arcToCubics(
          pen.x / sx,
          pen.y / sy,
          cmd.wR,
          cmd.hR,
          cmd.stAng,
          cmd.swAng,
        )) {
          if (piece.line) {
            pen = P(piece.line);
            current.nodes.push({ ...pen });
            continue;
          }
          current.nodes.at(-1).out = P(piece.c1);
          pen = P(piece.end);
          current.nodes.push({ ...pen, in: P(piece.c2) });
        }
      } else if (cmd.kind === "close") {
        if (current) {
          current.closed = true;
          // A last node on the first one folds into it.
          const first = current.nodes[0],
            last = current.nodes.at(-1);
          if (
            current.nodes.length > 1 &&
            Math.hypot(first.x - last.x, first.y - last.y) < 1
          ) {
            if (last.in) first.in = last.in;
            current.nodes.pop();
          }
          pen = { x: first.x, y: first.y };
        }
        current = null;
      }
    }
  }
  return out.filter((p) => p.nodes.length > 1);
}

/** Freeform paths (the engine's format) from editable subpaths. */
export function freeformFromEditable(paths, w, h) {
  const filled = paths.filter((p) => p.fill !== false);
  const open = paths.filter((p) => p.fill === false);
  const commandsOf = (list) =>
    list.flatMap((path) => {
      const cmds = [{ type: "moveTo", x: path.nodes[0].x, y: path.nodes[0].y }];
      const seg = (a, b) =>
        a.out || b.in
          ? {
              type: "cubicTo",
              x1: (a.out || a).x,
              y1: (a.out || a).y,
              x2: (b.in || b).x,
              y2: (b.in || b).y,
              x: b.x,
              y: b.y,
            }
          : { type: "lineTo", x: b.x, y: b.y };
      for (let i = 1; i < path.nodes.length; i++)
        cmds.push(seg(path.nodes[i - 1], path.nodes[i]));
      if (path.closed) {
        const last = path.nodes.at(-1),
          first = path.nodes[0];
        if (last.out || first.in) cmds.push(seg(last, first));
        cmds.push({ type: "close" });
      }
      return cmds;
    });
  const out = [];
  if (filled.length) out.push({ w, h, commands: commandsOf(filled) });
  if (open.length) out.push({ w, h, fill: false, commands: commandsOf(open) });
  return out;
}

/** Maps a point in the shape's box to the slide, and back. */
export function boxTransform({
  x,
  y,
  w,
  h,
  rot = 0,
  flipH = false,
  flipV = false,
}) {
  const cx = x + w / 2,
    cy = y + h / 2;
  const r = (rot * Math.PI) / 180,
    cos = Math.cos(r),
    sin = Math.sin(r);
  return {
    toSlide(p) {
      let lx = p.x - w / 2,
        ly = p.y - h / 2;
      if (flipH) lx = -lx;
      if (flipV) ly = -ly;
      return { x: cx + lx * cos - ly * sin, y: cy + lx * sin + ly * cos };
    },
    toBox(p) {
      const dx = p.x - cx,
        dy = p.y - cy;
      let lx = dx * cos + dy * sin,
        ly = -dx * sin + dy * cos;
      if (flipH) lx = -lx;
      if (flipV) ly = -ly;
      return { x: lx + w / 2, y: ly + h / 2 };
    },
  };
}

// ---------------------------------------------------------------------------
// Edit Points: an overlay over the slide with a handle per point

/**
 * Starts editing the points of a shape. `ctx`: { P, pres(), canvas(),
 * slideSize(), shape(), commit(paths, bounds), done() }. Returns a
 * controller with `stop()` and `refresh()`.
 */
export function startEditPoints(ctx) {
  const ns = "http://www.w3.org/2000/svg";
  let layer = null;
  let state = null;
  let active = null; // { path, node, part: "node"|"in"|"out" }

  function read() {
    const { P } = ctx;
    const shape = ctx.shape();
    if (!shape) return null;
    const b =
      P.getShapeBoundsResolved(ctx.pres(), shape) || P.getShapeBounds(shape);
    const geometry = P.getShapeGeometryResolved(ctx.pres(), shape)?.geometry;
    if (!b || !geometry) return null;
    const flip = P.getShapeFlip(shape) || {};
    return {
      b,
      transform: boxTransform({
        ...b,
        rot: P.getShapeRotation(shape) || 0,
        flipH: !!flip.horizontal,
        flipV: !!flip.vertical,
      }),
      paths: editablePaths(geometry, b.w, b.h),
    };
  }

  function draw() {
    if (!layer || !state) return;
    const size = ctx.slideSize();
    layer.setAttribute("viewBox", `0 0 ${size.cx} ${size.cy}`);
    const scale =
      size.cx / Math.max(1, layer.getBoundingClientRect().width || 1);
    const r = 4.5 * scale;
    const t = state.transform;
    const parts = [];
    let outline = "";
    for (const path of state.paths) {
      const s = path.nodes.map((n) => t.toSlide(n));
      outline += `M${s[0].x} ${s[0].y}`;
      const seg = (a, b, sa, sb) => {
        if (a.out || b.in) {
          const c1 = t.toSlide(a.out || a),
            c2 = t.toSlide(b.in || b);
          return `C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${sb.x} ${sb.y}`;
        }
        return `L${sb.x} ${sb.y}`;
      };
      for (let i = 1; i < path.nodes.length; i++)
        outline += seg(path.nodes[i - 1], path.nodes[i], s[i - 1], s[i]);
      if (path.closed)
        outline += `${seg(path.nodes.at(-1), path.nodes[0], s.at(-1), s[0])}Z`;
    }
    parts.push(
      `<path class="ep-outline" d="${outline}" stroke-width="${1.5 * scale}"/>`,
    );
    state.paths.forEach((path, pi) =>
      path.nodes.forEach((node, ni) => {
        const p = t.toSlide(node);
        const isActive = active && active.path === pi && active.node === ni;
        if (isActive)
          for (const part of ["in", "out"])
            if (node[part]) {
              const c = t.toSlide(node[part]);
              parts.push(
                `<line class="ep-arm" x1="${p.x}" y1="${p.y}" x2="${c.x}" y2="${c.y}" stroke-width="${scale}"/><circle class="ep-handle" data-path="${pi}" data-node="${ni}" data-part="${part}" cx="${c.x}" cy="${c.y}" r="${r * 0.85}" stroke-width="${scale}"/>`,
              );
            }
        parts.push(
          `<rect class="ep-node${isActive ? " active" : ""}" data-path="${pi}" data-node="${ni}" data-part="node" x="${p.x - r}" y="${p.y - r}" width="${2 * r}" height="${2 * r}" stroke-width="${scale}"/>`,
        );
      }),
    );
    layer.innerHTML = parts.join("");
  }

  function slidePoint(e) {
    const rect = layer.getBoundingClientRect();
    const size = ctx.slideSize();
    return {
      x: ((e.clientX - rect.left) / rect.width) * size.cx,
      y: ((e.clientY - rect.top) / rect.height) * size.cy,
    };
  }

  function commit() {
    // The new outline's own box becomes the shape's box.
    const pts = state.paths.flatMap((p) =>
      p.nodes.flatMap((n) => [n, n.in, n.out].filter(Boolean)),
    );
    const minX = Math.min(...pts.map((p) => p.x)),
      minY = Math.min(...pts.map((p) => p.y));
    const maxX = Math.max(...pts.map((p) => p.x)),
      maxY = Math.max(...pts.map((p) => p.y));
    const w = Math.max(1, maxX - minX),
      h = Math.max(1, maxY - minY);
    const shift = (p) =>
      p && { x: Math.round(p.x - minX), y: Math.round(p.y - minY) };
    const moved = state.paths.map((path) => ({
      ...path,
      nodes: path.nodes.map((n) => ({
        ...shift(n),
        ...(n.in ? { in: shift(n.in) } : {}),
        ...(n.out ? { out: shift(n.out) } : {}),
      })),
    }));
    // The box moves so the outline stays where it was drawn.
    const c0 = state.transform.toSlide({ x: minX + w / 2, y: minY + h / 2 });
    const bounds = {
      x: Math.round(c0.x - w / 2),
      y: Math.round(c0.y - h / 2),
      w: Math.round(w),
      h: Math.round(h),
    };
    ctx.commit(freeformFromEditable(moved, bounds.w, bounds.h), bounds);
  }

  function onDown(e) {
    const target = e.target.closest?.("[data-part]");
    if (!target) {
      // A press on the outline adds a point there; elsewhere ends editing.
      if (
        e.target.classList?.contains("ep-outline") &&
        (e.ctrlKey || e.metaKey || e.altKey)
      ) {
        addPoint(slidePoint(e));
        e.preventDefault();
        return;
      }
      if (e.target === layer) stop();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const pi = Number(target.dataset.path),
      ni = Number(target.dataset.node),
      part = target.dataset.part;
    active = { path: pi, node: ni, part };
    draw();
    const node = state.paths[pi].nodes[ni];
    const startNode = JSON.parse(JSON.stringify(node));
    const start = state.transform.toBox(slidePoint(e));
    let moved = false;
    const move = (ev) => {
      const p = state.transform.toBox(slidePoint(ev));
      const dx = p.x - start.x,
        dy = p.y - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 0) moved = true;
      if (part === "node") {
        node.x = startNode.x + dx;
        node.y = startNode.y + dy;
        if (startNode.in)
          node.in = { x: startNode.in.x + dx, y: startNode.in.y + dy };
        if (startNode.out)
          node.out = { x: startNode.out.x + dx, y: startNode.out.y + dy };
      } else {
        node[part] = { x: startNode[part].x + dx, y: startNode[part].y + dy };
        // A smooth point keeps its handles in line unless Alt is held.
        const other = part === "in" ? "out" : "in";
        if (node[other] && !ev.altKey) {
          const len = Math.hypot(
            startNode[other].x - node.x,
            startNode[other].y - node.y,
          );
          const vx = node.x - node[part].x,
            vy = node.y - node[part].y;
          const vl = Math.hypot(vx, vy) || 1;
          node[other] = {
            x: node.x + (vx / vl) * len,
            y: node.y + (vy / vl) * len,
          };
        }
      }
      draw();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) commit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function addPoint(at) {
    const p = state.transform.toBox(at);
    let best = null;
    state.paths.forEach((path, pi) => {
      const count = path.closed ? path.nodes.length : path.nodes.length - 1;
      for (let i = 0; i < count; i++) {
        const a = path.nodes[i],
          b = path.nodes[(i + 1) % path.nodes.length];
        const t = Math.max(
          0,
          Math.min(
            1,
            ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) /
              ((b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1),
          ),
        );
        const d = Math.hypot(
          a.x + t * (b.x - a.x) - p.x,
          a.y + t * (b.y - a.y) - p.y,
        );
        if (!best || d < best.d) best = { d, pi, i };
      }
    });
    if (!best) return;
    state.paths[best.pi].nodes.splice(best.i + 1, 0, { x: p.x, y: p.y });
    active = { path: best.pi, node: best.i + 1, part: "node" };
    commit();
  }

  function deleteActive() {
    if (!active) return;
    const path = state.paths[active.path];
    if (path.nodes.length <= (path.closed ? 3 : 2)) return;
    path.nodes.splice(active.node, 1);
    active = null;
    commit();
  }

  function toggleSmooth() {
    if (!active) return;
    const path = state.paths[active.path];
    const node = path.nodes[active.node];
    if (node.in || node.out) {
      delete node.in;
      delete node.out;
    } else {
      const prev =
        path.nodes[(active.node - 1 + path.nodes.length) % path.nodes.length];
      const next = path.nodes[(active.node + 1) % path.nodes.length];
      const vx = (next.x - prev.x) / 6,
        vy = (next.y - prev.y) / 6;
      node.in = { x: node.x - vx, y: node.y - vy };
      node.out = { x: node.x + vx, y: node.y + vy };
    }
    commit();
  }

  function onKey(e) {
    if (e.key === "Escape" || e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      stop();
    } else if ((e.key === "Delete" || e.key === "Backspace") && active) {
      e.preventDefault();
      e.stopPropagation();
      deleteActive();
    } else if (
      e.key.toLowerCase() === "s" &&
      active &&
      !e.metaKey &&
      !e.ctrlKey
    ) {
      e.preventDefault();
      e.stopPropagation();
      toggleSmooth();
    }
  }

  function attach() {
    const canvas = ctx.canvas();
    if (!canvas) return;
    if (!layer || !layer.isConnected) {
      layer = document.createElementNS(ns, "svg");
      layer.setAttribute("class", "edit-points-layer");
      layer.setAttribute("preserveAspectRatio", "none");
      layer.setAttribute("role", "application");
      layer.setAttribute(
        "aria-label",
        "Edit points: drag a point or a curve handle. Ctrl-click the outline to add a point, Delete removes the selected point, S makes it smooth or a corner, Escape finishes.",
      );
      layer.setAttribute("tabindex", "0");
      layer.addEventListener("pointerdown", onDown);
      layer.addEventListener("keydown", onKey);
      layer.addEventListener("dblclick", (e) => {
        const target = e.target.closest?.("[data-part=node]");
        if (!target) return;
        active = {
          path: Number(target.dataset.path),
          node: Number(target.dataset.node),
          part: "node",
        };
        deleteActive();
      });
      canvas.append(layer);
      layer.focus({ preventScroll: true });
    }
  }

  function refresh() {
    const next = read();
    if (!next) return stop();
    state = next;
    if (active && !state.paths[active.path]?.nodes[active.node]) active = null;
    attach();
    draw();
  }

  function stop() {
    layer?.remove();
    layer = null;
    state = null;
    ctx.done?.();
  }

  refresh();
  return { stop, refresh, active: () => !!layer };
}

// ---------------------------------------------------------------------------
// Merge Shapes

export const MERGE_OPERATIONS = [
  ["union", "Union", "o:mergeUnion"],
  ["combine", "Combine", "o:mergeCombine"],
  ["fragment", "Fragment", "o:mergeFragment"],
  ["intersect", "Intersect", "o:mergeIntersect"],
  ["subtract", "Subtract", "o:mergeSubtract"],
];

/** A shape's outline as rings in slide coordinates. */
export function shapeRings(P, pres, shape) {
  const b = P.getShapeBoundsResolved(pres, shape) || P.getShapeBounds(shape);
  const geometry = P.getShapeGeometryResolved(pres, shape)?.geometry;
  if (!b || !geometry) return [];
  const flip = P.getShapeFlip(shape) || {};
  const rings = flattenGeometry(geometry, {
    tolerance: 1500,
    w: b.w,
    h: b.h,
  }).filter((r) => r.fill && r.closed !== false);
  return transformRings(rings, {
    ...b,
    rot: P.getShapeRotation(shape) || 0,
    flipH: !!flip.horizontal,
    flipV: !!flip.vertical,
  }).map((r) => r.points);
}

/**
 * Merges shapes. Returns the pieces as freeform paths with their slide
 * bounds: [{ bounds, paths }]; empty when nothing remains.
 */
export function mergeOutlines(operands, operation) {
  if (operation === "fragment")
    return fragment(operands)
      .map(({ polygon }) => ringsToFreeformPaths([polygon]))
      .filter((piece) => piece.bounds.w > 0 && piece.bounds.h > 0);
  const op = { union, combine: xor, intersect, subtract }[operation];
  const result = op(operands);
  if (!result.length) return [];
  const piece = ringsToFreeformPaths(result);
  return piece.bounds.w > 0 && piece.bounds.h > 0 ? [piece] : [];
}

// SVG helpers for icons: build one from Lucide's drawing, recolour it, and
// turn its outlines into freeform geometry ("Convert to Shape").

const NS = "http://www.w3.org/2000/svg";

const attrs = (map) =>
  Object.entries(map)
    .map(
      ([k, v]) =>
        ` ${k}="${String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`,
    )
    .join("");

/** An SVG document for a Lucide icon node list. */
export function iconSvg(
  name,
  node,
  { stroke = "#000000", fill = "none", strokeWidth = 2, size = 96 } = {},
) {
  const body = node.map(([tag, a]) => `<${tag}${attrs(a)}/>`).join("");
  return `<svg xmlns="${NS}" width="${size}" height="${size}" viewBox="0 0 24 24"${attrs(
    {
      fill,
      stroke,
      color: stroke,
      "stroke-width": strokeWidth,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "data-icon": name,
    },
  )}>${body}</svg>`;
}

/** The same SVG with new line and fill colours and line weight. */
export function recolorSvg(svg, { stroke, fill, strokeWidth } = {}) {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName !== "svg") throw new Error("Not an SVG drawing.");
  if (stroke) {
    root.setAttribute("stroke", stroke);
    root.setAttribute("color", stroke);
  }
  if (fill) root.setAttribute("fill", fill);
  if (strokeWidth != null) root.setAttribute("stroke-width", strokeWidth);
  return new XMLSerializer().serializeToString(root);
}

export function svgStyle(svg) {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  return {
    stroke: root.getAttribute("stroke") || "#000000",
    fill: root.getAttribute("fill") || "none",
    strokeWidth: Number(root.getAttribute("stroke-width") || 2),
  };
}

// ---------------------------------------------------------------------------
// Path data → absolute moveTo / lineTo / cubicTo / close.

const TOKEN =
  /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

function arcToCubics(x1, y1, rx, ry, angle, large, sweep, x2, y2) {
  // Endpoint to centre parameterisation (SVG implementation notes F.6.5).
  if (!rx || !ry) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (angle * Math.PI) / 180;
  const cos = Math.cos(phi),
    sin = Math.sin(phi);
  const dx = (x1 - x2) / 2,
    dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy,
    yp = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const sign = large === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const coef = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * yp) / ry,
    cyp = (-coef * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angleOf = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = angleOf(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = angleOf(
    (xp - cxp) / rx,
    (yp - cyp) / ry,
    (-xp - cxp) / rx,
    (-yp - cyp) / ry,
  );
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const segments = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)));
  const step = dt / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  const out = [];
  let t = t1;
  const point = (a) => [
    cx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin,
    cy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos,
  ];
  const deriv = (a) => [
    -rx * Math.sin(a) * cos - ry * Math.cos(a) * sin,
    -rx * Math.sin(a) * sin + ry * Math.cos(a) * cos,
  ];
  for (let i = 0; i < segments; i++) {
    const [ax, ay] = point(t),
      [bx, by] = point(t + step);
    const [dax, day] = deriv(t),
      [dbx, dby] = deriv(t + step);
    out.push([ax + k * dax, ay + k * day, bx - k * dbx, by - k * dby, bx, by]);
    t += step;
  }
  return out;
}

/** Absolute commands for SVG path data. */
export function normalizePath(d) {
  const tokens = [...String(d).matchAll(TOKEN)].map(
    (m) => m[1] ?? Number(m[2]),
  );
  const out = [];
  let i = 0,
    cmd = null,
    x = 0,
    y = 0,
    sx = 0,
    sy = 0,
    lastControl = null,
    lastQuad = null;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (typeof tokens[i] === "string") cmd = tokens[i++];
    if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0,
      oy = rel ? y : 0;
    switch (C) {
      case "M":
        x = ox + num();
        y = oy + num();
        sx = x;
        sy = y;
        out.push({ type: "moveTo", x, y });
        cmd = rel ? "l" : "L";
        lastControl = lastQuad = null;
        break;
      case "L":
        x = ox + num();
        y = oy + num();
        out.push({ type: "lineTo", x, y });
        lastControl = lastQuad = null;
        break;
      case "H":
        x = ox + num();
        out.push({ type: "lineTo", x, y });
        lastControl = lastQuad = null;
        break;
      case "V":
        y = oy + num();
        out.push({ type: "lineTo", x, y });
        lastControl = lastQuad = null;
        break;
      case "C": {
        const x1 = ox + num(),
          y1 = oy + num(),
          x2 = ox + num(),
          y2 = oy + num();
        x = ox + num();
        y = oy + num();
        out.push({ type: "cubicTo", x1, y1, x2, y2, x, y });
        lastControl = [x2, y2];
        lastQuad = null;
        break;
      }
      case "S": {
        const [x1, y1] = lastControl
          ? [2 * x - lastControl[0], 2 * y - lastControl[1]]
          : [x, y];
        const x2 = ox + num(),
          y2 = oy + num();
        x = ox + num();
        y = oy + num();
        out.push({ type: "cubicTo", x1, y1, x2, y2, x, y });
        lastControl = [x2, y2];
        lastQuad = null;
        break;
      }
      case "Q":
      case "T": {
        const [qx, qy] =
          C === "Q"
            ? [ox + num(), oy + num()]
            : lastQuad
              ? [2 * x - lastQuad[0], 2 * y - lastQuad[1]]
              : [x, y];
        const ex = ox + num(),
          ey = oy + num();
        out.push({
          type: "cubicTo",
          x1: x + (2 / 3) * (qx - x),
          y1: y + (2 / 3) * (qy - y),
          x2: ex + (2 / 3) * (qx - ex),
          y2: ey + (2 / 3) * (qy - ey),
          x: ex,
          y: ey,
        });
        x = ex;
        y = ey;
        lastQuad = [qx, qy];
        lastControl = null;
        break;
      }
      case "A": {
        const rx = num(),
          ry = num(),
          angle = num(),
          large = num(),
          sweep = num();
        const ex = ox + num(),
          ey = oy + num();
        for (const [x1, y1, x2, y2, bx, by] of arcToCubics(
          x,
          y,
          rx,
          ry,
          angle,
          !!large,
          !!sweep,
          ex,
          ey,
        ))
          out.push({ type: "cubicTo", x1, y1, x2, y2, x: bx, y: by });
        x = ex;
        y = ey;
        lastControl = lastQuad = null;
        break;
      }
      case "Z":
        out.push({ type: "close" });
        x = sx;
        y = sy;
        lastControl = lastQuad = null;
        cmd = null;
        break;
      default:
        i++;
    }
  }
  return out;
}

const K = 0.5522847498;
function ellipsePath(cx, cy, rx, ry) {
  return [
    { type: "moveTo", x: cx + rx, y: cy },
    {
      type: "cubicTo",
      x1: cx + rx,
      y1: cy + K * ry,
      x2: cx + K * rx,
      y2: cy + ry,
      x: cx,
      y: cy + ry,
    },
    {
      type: "cubicTo",
      x1: cx - K * rx,
      y1: cy + ry,
      x2: cx - rx,
      y2: cy + K * ry,
      x: cx - rx,
      y: cy,
    },
    {
      type: "cubicTo",
      x1: cx - rx,
      y1: cy - K * ry,
      x2: cx - K * rx,
      y2: cy - ry,
      x: cx,
      y: cy - ry,
    },
    {
      type: "cubicTo",
      x1: cx + K * rx,
      y1: cy - ry,
      x2: cx + rx,
      y2: cy - K * ry,
      x: cx + rx,
      y: cy,
    },
    { type: "close" },
  ];
}

/** Each drawable element of an SVG as absolute path commands. */
export function svgOutlines(svg) {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  const [vx, vy, vw, vh] = (root.getAttribute("viewBox") || "0 0 24 24")
    .split(/[\s,]+/)
    .map(Number);
  const g = (e, name, fallback = 0) =>
    Number(e.getAttribute(name) ?? fallback) || 0;
  const paths = [];
  for (const e of root.querySelectorAll(
    "path,circle,ellipse,rect,line,polyline,polygon",
  )) {
    let commands = [];
    switch (e.localName) {
      case "path":
        commands = normalizePath(e.getAttribute("d") || "");
        break;
      case "circle":
        commands = ellipsePath(g(e, "cx"), g(e, "cy"), g(e, "r"), g(e, "r"));
        break;
      case "ellipse":
        commands = ellipsePath(g(e, "cx"), g(e, "cy"), g(e, "rx"), g(e, "ry"));
        break;
      case "rect": {
        const x = g(e, "x"),
          y = g(e, "y"),
          w = g(e, "width"),
          h = g(e, "height");
        const r = Math.min(g(e, "rx", e.getAttribute("ry") ?? 0), w / 2, h / 2);
        commands = r
          ? normalizePath(
              `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`,
            )
          : normalizePath(`M${x} ${y}H${x + w}V${y + h}H${x}Z`);
        break;
      }
      case "line":
        commands = normalizePath(
          `M${g(e, "x1")} ${g(e, "y1")}L${g(e, "x2")} ${g(e, "y2")}`,
        );
        break;
      default: {
        const pts = (e.getAttribute("points") || "").trim();
        commands = normalizePath(
          `M${pts}${e.localName === "polygon" ? "Z" : ""}`,
        );
      }
    }
    if (commands.length) paths.push(commands);
  }
  return { viewBox: [vx || 0, vy || 0, vw || 24, vh || 24], paths };
}

/** Freeform paths (see setShapeFreeformPaths) for an SVG's outlines. */
export function svgFreeformPaths(svg, scale = 1000) {
  const { viewBox, paths } = svgOutlines(svg);
  const [vx, vy, vw, vh] = viewBox;
  const X = (v) => Math.round((v - vx) * scale);
  const Y = (v) => Math.round((v - vy) * scale);
  return paths.map((commands) => ({
    w: Math.round(vw * scale),
    h: Math.round(vh * scale),
    fill: commands.some((c) => c.type === "close"),
    commands: commands.map((c) =>
      c.type === "close"
        ? c
        : c.type === "cubicTo"
          ? {
              type: "cubicTo",
              x1: X(c.x1),
              y1: Y(c.y1),
              x2: X(c.x2),
              y2: Y(c.y2),
              x: X(c.x),
              y: Y(c.y),
            }
          : { type: c.type, x: X(c.x), y: Y(c.y) },
    ),
  }));
}

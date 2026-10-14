// Small schematic drawings of each chart type, for the chart type pickers.
// They are drawn here from the type's shape (bars, lines, slices...) in the
// deck's accent colours; the large preview beside them is a real render.

const W = 64,
  H = 48;
const DEFAULT_ACCENTS = ["#4E79A7", "#F28E2B", "#76B7B2", "#E15759"];

const rect = (x, y, w, h, fill) =>
  `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" fill="${fill}"/>`;
const path = (d, stroke, fill = "none", width = 1.6) =>
  `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`;
const dot = (x, y, r, fill) =>
  `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${fill}"/>`;
const axes = `<path d="M8 6V42H58" fill="none" stroke="currentColor" stroke-opacity=".45" stroke-width="1"/>`;

// Three series over four categories, shaped differently enough that every
// grouping reads at a glance.
const DATA = [
  [3, 5, 4, 6],
  [4, 2, 5, 3],
  [2, 3, 2, 4],
];

function columns(grouping, horizontal, c) {
  let out = "";
  const n = 4,
    span = 48 / n;
  for (let i = 0; i < n; i++) {
    const vals = DATA.map((s) => s[i]);
    const total = vals.reduce((a, b) => a + b, 0);
    let acc = 0;
    vals.forEach((v, s) => {
      if (grouping === "clustered") {
        const bw = (span * 0.7) / 3;
        const len = (v / 7) * 34;
        const at = 10 + i * span + span * 0.15 + s * bw;
        out += horizontal
          ? rect(8, 42 - (at - 6) - bw - 2, len * 1.4, bw, c[s])
          : rect(at, 42 - len, bw - 0.4, len, c[s]);
      } else {
        const len =
          grouping === "percentStacked" ? (v / total) * 34 : (v / 16) * 34;
        const bw = span * 0.6;
        const at = 10 + i * span + span * 0.2;
        out += horizontal
          ? rect(8 + acc * 1.4, 42 - (at - 6) - bw - 2, len * 1.4, bw, c[s])
          : rect(at, 42 - acc - len, bw, len, c[s]);
        acc += len;
      }
    });
  }
  return out;
}
function lines(grouping, withMarkers, c, area = false) {
  let out = "";
  const xs = [10, 25, 40, 55];
  const totals = xs.map((_, i) => DATA.reduce((a, s) => a + s[i], 0));
  let base = xs.map(() => 0);
  const series = DATA.map((s) => {
    const ys = s.map((v, i) => {
      const val =
        grouping === "stacked"
          ? base[i] + v
          : grouping === "percentStacked"
            ? base[i] + (v / totals[i]) * 16
            : v;
      return val;
    });
    if (grouping !== "standard") base = ys;
    return ys;
  });
  const scale = grouping === "standard" ? 34 / 7 : 34 / 16;
  const order = area ? [...series.keys()].reverse() : [...series.keys()];
  for (const s of order) {
    const pts = series[s].map((v, i) => [xs[i], 42 - v * scale]);
    const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join("");
    if (area) {
      const prev =
        grouping === "standard" || s === 0
          ? xs.map((x) => [x, 42])
          : series[s - 1].map((v, i) => [xs[i], 42 - v * scale]);
      const back = prev
        .reverse()
        .map(([x, y]) => `L${x} ${y}`)
        .join("");
      out += `<path d="${d}${back}Z" fill="${c[s]}" fill-opacity="${grouping === "standard" ? 0.75 : 1}"/>`;
    } else {
      out += path(d, c[s]);
      if (withMarkers) for (const [x, y] of pts) out += dot(x, y, 1.8, c[s]);
    }
  }
  return out;
}
function pie(c, { hole = 0, explode = false } = {}) {
  const vals = [42, 23, 20, 15];
  const total = 100;
  let a0 = -Math.PI / 2,
    out = "";
  const cx = 32,
    cy = 24,
    r = 18;
  vals.forEach((v, i) => {
    const a1 = a0 + (v / total) * Math.PI * 2;
    const mid = (a0 + a1) / 2;
    const ox = explode ? Math.cos(mid) * 2.5 : 0,
      oy = explode ? Math.sin(mid) * 2.5 : 0;
    const p = (a, rad) => [
      cx + ox + Math.cos(a) * rad,
      cy + oy + Math.sin(a) * rad,
    ];
    const [x0, y0] = p(a0, r),
      [x1, y1] = p(a1, r);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    let d = `M${x0} ${y0}A${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
    if (hole) {
      const [x2, y2] = p(a1, r * hole),
        [x3, y3] = p(a0, r * hole);
      d += `L${x2} ${y2}A${r * hole} ${r * hole} 0 ${large} 0 ${x3} ${y3}Z`;
    } else d += `L${cx + ox} ${cy + oy}Z`;
    out += `<path d="${d}" fill="${c[i % c.length]}" stroke="var(--surface, #fff)" stroke-width="0.8"/>`;
    a0 = a1;
  });
  return out;
}
function scatter(c, { line = false, smooth = false, markers = true }) {
  const pts = [
    [12, 34],
    [21, 27],
    [30, 30],
    [40, 18],
    [52, 12],
  ];
  const pts2 = [
    [14, 24],
    [24, 36],
    [34, 22],
    [45, 28],
    [54, 20],
  ];
  let out = "";
  [pts, pts2].forEach((p, s) => {
    if (line) {
      const d = smooth
        ? `M${p[0][0]} ${p[0][1]}` +
          p
            .slice(1)
            .map(([x, y], i) => {
              const [px, py] = p[i];
              const mx = (px + x) / 2;
              return `C${mx} ${py} ${mx} ${y} ${x} ${y}`;
            })
            .join("")
        : p.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join("");
      out += path(d, c[s]);
    }
    if (markers) for (const [x, y] of p) out += dot(x, y, 2, c[s]);
  });
  return out;
}
function bubbles(c) {
  return (
    `<circle cx="18" cy="30" r="7" fill="${c[0]}" fill-opacity=".8"/>` +
    `<circle cx="34" cy="18" r="5" fill="${c[0]}" fill-opacity=".8"/>` +
    `<circle cx="48" cy="28" r="9" fill="${c[1]}" fill-opacity=".8"/>`
  );
}
function radar(c, { filled = false, markers = false }) {
  const cx = 32,
    cy = 25,
    r = 18,
    n = 5;
  const at = (i, k) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k];
  };
  let grid = "";
  for (const k of [0.5, 1])
    grid += `<path d="${Array.from({ length: n }, (_, i) => `${i ? "L" : "M"}${at(i, k).join(" ")}`).join("")}Z" fill="none" stroke="currentColor" stroke-opacity=".3" stroke-width=".8"/>`;
  let out = grid;
  [
    [0.9, 0.6, 0.8, 0.5, 0.7],
    [0.5, 0.9, 0.4, 0.8, 0.45],
  ].forEach((vals, s) => {
    const pts = vals.map((v, i) => at(i, v));
    const d =
      pts.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join("") + "Z";
    out += filled
      ? `<path d="${d}" fill="${c[s]}" fill-opacity=".7"/>`
      : path(d, c[s]);
    if (markers) for (const [x, y] of pts) out += dot(x, y, 1.6, c[s]);
  });
  return out;
}
function combo(c, kind) {
  let out = "";
  [3, 5, 4, 6].forEach((v, i) => {
    out += rect(12 + i * 12, 42 - v * 4.5, 5, v * 4.5, c[0]);
    out += rect(
      17 + i * 12,
      42 - [4, 2, 5, 3][i] * 4.5,
      5,
      [4, 2, 5, 3][i] * 4.5,
      c[1],
    );
  });
  const ys = kind === "secondary" ? [10, 20, 14, 8] : [24, 16, 20, 12];
  out += path(
    ys.map((y, i) => `${i ? "L" : "M"}${17 + i * 12} ${y}`).join(""),
    c[2],
    "none",
    2,
  );
  if (kind === "secondary")
    out += `<path d="M58 6V42" stroke="currentColor" stroke-opacity=".45" stroke-width="1"/>`;
  return out;
}

const DRAW = {
  "column-clustered": (c) => axes + columns("clustered", false, c),
  "column-stacked": (c) => axes + columns("stacked", false, c),
  "column-percent": (c) => axes + columns("percentStacked", false, c),
  "bar-clustered": (c) => axes + columns("clustered", true, c),
  "bar-stacked": (c) => axes + columns("stacked", true, c),
  "bar-percent": (c) => axes + columns("percentStacked", true, c),
  line: (c) => axes + lines("standard", false, c),
  "line-stacked": (c) => axes + lines("stacked", false, c),
  "line-percent": (c) => axes + lines("percentStacked", false, c),
  "line-markers": (c) => axes + lines("standard", true, c),
  "line-stacked-markers": (c) => axes + lines("stacked", true, c),
  "line-percent-markers": (c) => axes + lines("percentStacked", true, c),
  area: (c) => axes + lines("standard", false, c, true),
  "area-stacked": (c) => axes + lines("stacked", false, c, true),
  "area-percent": (c) => axes + lines("percentStacked", false, c, true),
  pie: (c) => pie(c),
  "pie-exploded": (c) => pie(c, { explode: true }),
  doughnut: (c) => pie(c, { hole: 0.5 }),
  scatter: (c) => axes + scatter(c, {}),
  "scatter-smooth-markers": (c) =>
    axes + scatter(c, { line: true, smooth: true }),
  "scatter-smooth": (c) =>
    axes + scatter(c, { line: true, smooth: true, markers: false }),
  "scatter-lines-markers": (c) => axes + scatter(c, { line: true }),
  "scatter-lines": (c) => axes + scatter(c, { line: true, markers: false }),
  bubble: (c) => axes + bubbles(c),
  radar: (c) => radar(c, {}),
  "radar-markers": (c) => radar(c, { markers: true }),
  "radar-filled": (c) => radar(c, { filled: true }),
  "combo-column-line": (c) => axes + combo(c, "plain"),
  "combo-column-line-secondary": (c) => axes + combo(c, "secondary"),
  "combo-area-column": (c) =>
    axes +
    lines("standard", false, [c[0], c[0], c[0]], true) +
    columns("clustered", false, [c[1], c[1], c[1]]),
  "combo-custom": (c) => axes + combo(c, "plain"),
};

// The drawing for a chart type, as SVG markup (decorative: the control that
// shows it carries the type's name).
export function chartThumbSvg(typeId, accents = DEFAULT_ACCENTS) {
  const c = accents.length >= 3 ? accents : DEFAULT_ACCENTS;
  const body = (DRAW[typeId] || DRAW["column-clustered"])(c);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true" focusable="false">${body}</svg>`;
}

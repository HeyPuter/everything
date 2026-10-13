// The app's command icons, drawn for this project in a glass idiom: thin ink
// outlines and softly rounded frames over top-lit gradient fills, vivid solid
// marks, see-through overlapping layers, and round badges for what a command
// adds, removes or plays. They are original drawings (no third-party artwork
// is copied or traced) on a 20-unit grid. Strokes do not scale, so a 32px
// ribbon command keeps 1px lines as a 16px one does. Colours come from the
// --ico-* tokens in icons.css (the gradients from index.html's #ico-g-*), so
// every theme can tune them.
//
// Classes: o outline, of outline on paper, s solid ink, and per accent
// x ∈ {b, g, r, y, n, p, k}: x stroke only, xf soft fill with a hairline,
// xs solid fill, xw soft fill without stroke. `k` is the slide accent.
// Modifiers: thick, grip, dash, ln (faint), glassy (see-through), knock (the
// surface colour, cutting a badge out of the drawing), wh (white stroke),
// glint (a white highlight).
import "./icons.css";
import { ICON_GLYPHS } from "./glyphs.js";

const p = (d, c = "o") => `<path class="${c}" d="${d}"/>`;
// Outlined rectangles (frames, slides, tiles) get softly rounded corners
// unless `rx` says otherwise; fills laid inside a frame stay square.
const ROUND = 1.6;
const rounds = (c) =>
  /(^| )(o|of|[bgrynpk]f)( |$)/.test(c) && !c.includes("dash");
const r = (
  x,
  y,
  w,
  h,
  c = "o",
  rx = rounds(c) ? +Math.min(ROUND, w / 4, h / 4).toFixed(2) : 0,
) =>
  `<rect class="${c}" x="${x}" y="${y}" width="${w}" height="${h}"${rx ? ` rx="${rx}"` : ""}/>`;
const ci = (cx, cy, rad, c = "o") =>
  `<circle class="${c}" cx="${cx}" cy="${cy}" r="${rad}"/>`;
const el = (cx, cy, rx, ry, c = "o") =>
  `<ellipse class="${c}" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/>`;
// Lettering as outlines from the bundled fonts (glyphs.js), never SVG text:
// text would be read out as part of a button's name, and would depend on the
// fonts installed. dev/generate-icon-glyphs.py adds letters used here.
const t = (
  x,
  y,
  text,
  size,
  {
    weight = 400,
    italic = false,
    serif = false,
    anchor = "middle",
    c = "tx",
  } = {},
) => {
  const font =
    ICON_GLYPHS[
      serif
        ? italic
          ? "serifItalic"
          : "serif"
        : weight >= 600
          ? "sansBold"
          : "sans"
    ];
  const scale = size / 1000;
  const chars = [...text].map((ch) => font[ch]);
  if (chars.some((g) => !g))
    throw new Error(
      `command icons: no outline for "${text}"; run dev/generate-icon-glyphs.py`,
    );
  const width = chars.reduce((sum, [adv]) => sum + adv, 0) * scale;
  const x0 =
    anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
  let at = 0;
  const parts = chars.map(([adv, d]) => {
    const part = `<path d="${d}" transform="translate(${at} 0)"/>`;
    at += adv;
    return part;
  });
  return `<g class="${c}" transform="translate(${+x0.toFixed(2)} ${y}) scale(${+scale.toFixed(5)})">${parts.join("")}</g>`;
};
const g = (transform, body) => `<g transform="${transform}">${body}</g>`;

// ---- Shared pieces ----
const lines = (x, y, w, n, gap = 2.5, c = "o ln") =>
  p(
    Array.from({ length: n }, (_, i) => `M${x} ${y + i * gap}h${w}`).join(""),
    c,
  );
const textLines = (x, y, w, n, gap = 2.5) => lines(x, y, w, n, gap, "o");
// A sheet of paper with a blue glass folded corner.
const page = (x = 4.5, y = 2.5, w = 11, h = 15, fold = 3, k = 1.2) =>
  p(
    `M${x + k} ${y}h${w - fold - k}l${fold} ${fold}v${h - fold - k}a${k} ${k} 0 0 1-${k} ${k}h-${w - 2 * k}a${k} ${k} 0 0 1-${k}-${k}v-${h - 2 * k}a${k} ${k} 0 0 1 ${k}-${k}z`,
    "of",
  ) + (fold ? p(`M${x + w - fold} ${y}v${fold}h${fold}z`, "bf") : "");
// A landscape slide: the shape most presentation commands are drawn around,
// with the slide accent's title bar and faint body lines when `content`.
const slideBox = (x = 2.5, y = 4.5, w = 15, h = 11, c = "of") =>
  r(x, y, w, h, c, +Math.min(1.4, w / 6, h / 6).toFixed(2));
const titleBar = (x, y, w, c = "ks") => r(x, y, w, 1.6, c, 0.8);
const slide = (x, y, w, h, c = "of") =>
  slideBox(x, y, w, h, c) +
  titleBar(x + w * 0.14, y + h * 0.17, w * 0.55) +
  lines(x + w * 0.14, y + h * 0.5, w * 0.6, h >= 9 ? 2 : 1, h * 0.2);
// Signs drawn in white on a badge: each a path about (x, y), half-size k.
const SIGNS = {
  plus: (x, y, k) => `M${x - k} ${y}h${2 * k}M${x} ${y - k}v${2 * k}`,
  minus: (x, y, k) => `M${x - k} ${y}h${2 * k}`,
  x: (x, y, k) =>
    `M${x - k * 0.8} ${y - k * 0.8}l${k * 1.6} ${k * 1.6}M${x + k * 0.8} ${y - k * 0.8}l-${k * 1.6} ${k * 1.6}`,
  check: (x, y, k) =>
    `M${x - k} ${y + 0.1}l${k * 0.7} ${k * 0.7} ${k * 1.3}-${k * 1.5}`,
};
const playMark = (x, y, k, dx = 0) => {
  const d = `M${+(x - k * 0.55 + dx).toFixed(2)} ${+(y - k * 0.95).toFixed(2)}L${+(x + k * 1.05 + dx).toFixed(2)} ${y}L${+(x - k * 0.55 + dx).toFixed(2)} ${+(y + k * 0.95).toFixed(2)}z`;
  return p(d, "txw") + p(d, "wh");
};
// A round solid badge carrying a white sign, cut out of the drawing under it
// by a ring of the surface colour. Signs: plus, minus, x, check, play, first
// (play from the start), or none.
const badge = (cx, cy, sign, hue = "g", rad = 3.4) => {
  const k = rad * 0.48;
  let mark = "";
  if (sign === "play") mark = playMark(cx, cy, k, k * 0.1);
  else if (sign === "first")
    mark =
      p(`M${cx - k * 0.75} ${cy - k * 0.85}v${k * 1.7}`, "wh thick") +
      playMark(cx, cy, k * 0.85, k * 0.45);
  else if (sign) mark = p(SIGNS[sign](cx, cy, k), "wh thick");
  return (
    ci(cx, cy, rad + 0.9, "knock") +
    ci(cx, cy, rad, `${hue}s`) +
    (sign ? "" : ci(cx - rad * 0.3, cy - rad * 0.35, rad * 0.28, "glint")) +
    mark
  );
};
const arrowDown = (x, y, len, c = "b") =>
  p(`M${x} ${y}v${len}M${x - 2.5} ${y + len - 2.5}l2.5 2.5 2.5-2.5`, c);
const arrowUp = (x, y, len, c = "b") =>
  p(`M${x} ${y + len}v-${len}M${x - 2.5} ${y + 2.5}l2.5-2.5 2.5 2.5`, c);
const arrowRight = (x, y, len, c = "b") =>
  p(`M${x} ${y}h${len}M${x + len - 2.5} ${y - 2.5}l2.5 2.5-2.5 2.5`, c);
// A circular arrow turning back (anticlockwise) about (cx, cy).
const turnBack = (cx, cy, rad, c = "g thick") =>
  p(`M${cx} ${cy - rad}a${rad} ${rad} 0 1 0 ${rad} ${rad}`, c) +
  p(
    `M${cx + rad - 1.7} ${cy + 0.9}L${cx + rad} ${cy - 0.8}L${cx + rad + 1.7} ${cy + 0.9}`,
    c,
  );
// The spreadsheet's small brush, laid over a table's corner (Table Styles).
const brush = (dx = 0, dy = 0) =>
  `<g transform="translate(${dx} ${dy})">${p("M17.5 8.5 13 13", "o")}${p("M11.6 12.4l1.9 1.9-1.4 1.4-1.9-1.9z", "bs")}${p("M10.2 13.8l1.9 1.9c-.8 1.8-2.6 2.6-4.6 2.3.6-1.7 1.4-3.2 2.7-4.2z", "ys")}</g>`;
// Format Painter's brush, bristles down to the left, at (cx, cy) and scale s.
const painter = (cx = 10, cy = 10, s = 1) =>
  g(
    `translate(${cx} ${cy}) scale(${s}) rotate(45) translate(-10 -10)`,
    p("M9 9.5V2.5a1 1 0 0 1 2 0v7", "of") +
      p("M7.6 9.5h4.8V12H7.6z", "bs") +
      p("M7.6 12h4.8v1.5c0 2.2-1 3.8-2.4 5-1.4-1.2-2.4-2.8-2.4-5z", "ys"),
  );
const magnifier = (cx, cy, rad, fill = "bw") =>
  ci(cx, cy, rad, fill) +
  ci(cx, cy, rad, "o") +
  p(
    `M${cx + rad * 0.78} ${cy + rad * 0.78}l${rad * 0.85} ${rad * 0.85}`,
    "o grip",
  );
const starPath = (cx, cy, s = 1) => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const rad = (i % 2 ? 2.4 : 5.4) * s;
    pts.push(
      `${+(cx + rad * Math.cos(a)).toFixed(2)} ${+(cy + rad * Math.sin(a)).toFixed(2)}`,
    );
  }
  return `M${pts.join("L")}z`;
};
// A solid star with rounded points and a glint.
const star = (cx, cy, s = 1, hue = "y") => {
  const d = starPath(cx, cy, s);
  return (
    p(d, `${hue}s`) +
    p(d, hue === "y" ? "n" : hue) +
    ci(cx - 1 * s, cy - 0.6 * s, 0.75 * s, "glint")
  );
};
const sparkle = (x, y, s = 1, c = "ys") =>
  p(
    `M${x} ${y - 3 * s}l${0.8 * s} ${2.2 * s} ${2.2 * s} ${0.8 * s}-${2.2 * s} ${0.8 * s}-${0.8 * s} ${2.2 * s}-${0.8 * s}-${2.2 * s}-${2.2 * s}-${0.8 * s} ${2.2 * s}-${0.8 * s}z`,
    c,
  );
const speaker = (x = 2.5, y = 7.5, c = "bs") =>
  p(
    `M${x + 1} ${y}h2.5l4-3.5v12l-4-3.5h-2.5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z`,
    c,
  );
const waves = (x, y, n = 2, c = "b thick") =>
  p(
    `M${x} ${y - 2}a3 3 0 0 1 0 4` +
      (n > 1 ? `M${x + 2.2} ${y - 4.2}a6.2 6.2 0 0 1 0 8.4` : ""),
    c,
  );
const monitor = (x, y, w, h, c = "of") =>
  r(x, y, w, h, c, 1.6) +
  p(`M${x + w / 2} ${y + h}v${17.5 - y - h}M${x + w / 2 - 3} 17.5h6`, "o");
// A sheet of cells: a frame with cols × rows cells, optionally a header row
// that follows the frame's rounded top corners.
const cells = (x, y, w, h, cols, rows, { head = null, frame = "of" } = {}) => {
  let out = r(x, y, w, h, frame);
  const k = +Math.min(ROUND, w / 4, h / 4).toFixed(2);
  if (head)
    out += p(
      `M${x} ${y + h / rows}V${y + k}a${k} ${k} 0 0 1 ${k}-${k}H${x + w - k}a${k} ${k} 0 0 1 ${k} ${k}V${y + h / rows}z`,
      head,
    );
  let d = "";
  for (let i = 1; i < cols; i++) d += `M${x + (w * i) / cols} ${y}v${h}`;
  for (let j = 1; j < rows; j++) d += `M${x} ${y + (h * j) / rows}h${w}`;
  return out + p(d, "o ln");
};
// A table with a band laid under its lines (insert/delete rows and columns).
const banded = (x, y, w, h, cols, rows, band) =>
  cells(x, y, w, h, cols, rows) +
  band +
  cells(x, y, w, h, cols, rows, { frame: "o" });
const chartAxes = p("M3.5 3v13.5H17", "o ln");
// Chart marks are solid glass: a soft class (bf) is drawn as its solid (bs),
// with rounded ends.
const solid = (c) => c.replace(/^([bgrynpk])f$/, "$1s");
const columns = (bars, x0 = 5, w = 2.6, gap = 1.4, base = 16.5) =>
  bars
    .map(([h, c], i) => r(x0 + i * (w + gap), base - h, w, h, solid(c), 0.7))
    .join("");
const alignBars = (xs, ws) =>
  p(xs.map((x, i) => `M${x} ${4.5 + i * 4}h${ws[i]}`).join(""), "o");
const orgChart = () =>
  p("M10 6.5v3.5M5 13v-3h10v3", "o") +
  r(6.5, 2.5, 7, 4.2, "bs", 1.2) +
  r(1.5, 12.8, 7, 4.2, "bf", 1.2) +
  r(11.5, 12.8, 7, 4.2, "gf", 1.2);
// A pencil, its point at the lower left: a blue glass body, paper cone and
// an amber cap.
const pen = (dx = 0, dy = 0) =>
  g(
    `translate(${dx} ${dy})`,
    p("M12.6 3.4l3 3-7.4 7.4-3-3z", "bs") +
      p("M13.6 2.4a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2l-1 1-3-3z", "ns") +
      p("M5.2 10.8l3 3-4.2 1.2z", "of") +
      p("M4.4 13.6l.8.8-1.2.4z", "s"),
  );
const checker = (x, y, w, h, n = 4) => {
  let out = r(x, y, w, h, "of", 0.8);
  const cw = w / n,
    chh = h / n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if ((i + j) % 2 === 0)
        out += r(x + i * cw, y + j * chh, cw, chh, "s ln", 0);
  return out + r(x, y, w, h, "o", 0.8);
};
// A picture: blue sky, green hills, a sun, in a rounded frame.
const pic = (x = 2.5, y = 3.5, w = 15, h = 13) => {
  const k = +Math.min(2, w / 5, h / 5).toFixed(2);
  const f = (n) => +n.toFixed(2);
  return (
    r(x, y, w, h, "bf", k) +
    p(
      `M${x} ${f(y + h * 0.81)}l${f(w * 0.3)} ${f(-h * 0.385)} ${f(w * 0.233)} ${f(h * 0.27)} ${f(w * 0.167)} ${f(-h * 0.19)} ${f(w * 0.3)} ${f(h * 0.31)}V${f(y + h - k)}a${k} ${k} 0 0 1-${k} ${k}H${f(x + k)}a${k} ${k} 0 0 1-${k}-${k}z`,
      "gs",
    ) +
    ci(f(x + w * 0.7), f(y + h * 0.31), f(Math.min(w, h) * 0.13), "ys")
  );
};
const clock = (cx, cy, rad, c = "bs") =>
  ci(cx, cy, rad, c) +
  p(`M${cx} ${cy - rad * 0.6}V${cy}l${rad * 0.45} ${rad * 0.35}`, "wh thick");
const stopwatch = (cx, cy, rad) =>
  p(
    `M${cx - 1.2} ${cy - rad - 1.3}h2.4M${cx} ${cy - rad - 1.3}v1.3`,
    "o thick",
  ) +
  p(`M${cx + rad * 0.72} ${cy - rad * 0.72}l1 -1`, "o thick") +
  ci(cx, cy, rad, "of") +
  p(
    `M${cx} ${cy}V${cy - rad * 0.78}A${rad * 0.78} ${rad * 0.78} 0 0 1 ${+(cx + rad * 0.78).toFixed(2)} ${cy}z`,
    "bs",
  ) +
  ci(cx, cy, 0.6, "s");
const gear = (cx, cy, R = 3.4, c = "ns") => {
  const n = 8,
    w = (2 * Math.PI) / n,
    ri = R * 0.74,
    pts = [];
  const at = (rad, a) =>
    `${+(cx + rad * Math.cos(a)).toFixed(2)} ${+(cy + rad * Math.sin(a)).toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const a = i * w;
    pts.push(
      at(ri, a - 0.3 * w),
      at(R, a - 0.17 * w),
      at(R, a + 0.17 * w),
      at(ri, a + 0.3 * w),
    );
  }
  return p(`M${pts.join("L")}z`, c) + ci(cx, cy, R * 0.32, "knock");
};
const lock = (x, y) =>
  r(x - 1, y - 4.5, 10, 11.5, "knock", 2.5) +
  p(`M${x + 1.5} ${y}v-2a2.5 2.5 0 0 1 5 0v2`, "o thick") +
  r(x, y, 8, 6, "ns", 1.4) +
  ci(x + 4, y + 3, 0.9, "glint");
const borderIcon = (on) => {
  const edges = {
    top: "M3.5 3.5h13",
    bottom: "M3.5 16.5h13",
    left: "M3.5 3.5v13",
    right: "M16.5 3.5v13",
    h: "M3.5 10h13",
    v: "M10 3.5v13",
  };
  const dashed = Object.keys(edges)
    .filter((k) => !on.includes(k))
    .map((k) => edges[k])
    .join("");
  return (
    (dashed ? p(dashed, "o dash ln") : "") +
    (on.length ? p(on.map((k) => edges[k]).join(""), "b thick") : "")
  );
};
const bubble = (c = "bs") =>
  p(
    "M3 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H9.5l-4 3v-3H5a2 2 0 0 1-2-2z",
    c,
  );
const smallBubble = (c = "of") =>
  p(
    "M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7.5L5 13v-2H4a1.5 1.5 0 0 1-1.5-1.5z",
    c,
  );
const cursor = (x, y, s = 1, c = "of") =>
  g(
    `translate(${x} ${y}) scale(${s})`,
    p("M0 0v9.5l2.4-2.3 1.7 3.8 1.6-.7-1.7-3.7H7.4z", c),
  );
const eye = (cx, cy, s = 1) =>
  g(
    `translate(${cx} ${cy}) scale(${s})`,
    p("M-8.5 0s3-5.5 8.5-5.5S8.5 0 8.5 0 5.5 5.5 0 5.5-8.5 0-8.5 0z", "of") +
      ci(0, 0, 3, "bs") +
      ci(1, -1, 0.9, "glint"),
  );

// ---- The icons, keyed by the names the ribbon, menus and toolbar use ----
export const COMMAND_ICONS = {
  // Quick access
  home:
    p(
      "M4.5 8.6V16a1.2 1.2 0 0 0 1.2 1.2h8.6a1.2 1.2 0 0 0 1.2-1.2V8.6L10 3.8z",
      "of",
    ) +
    r(8.2, 11.2, 3.6, 6, "bs", 1) +
    p("M2.5 10 10 3.5l7.5 6.5", "o thick"),
  save:
    p(
      "M5 3.5h9l2.5 2.5V15a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 15V5A1.5 1.5 0 0 1 5 3.5z",
      "bs",
    ) +
    r(6, 3.5, 7, 4.5, "of", 0.6) +
    r(6, 11, 8, 5.5, "of", 0.6),
  undo:
    p("M7 4.5 3.5 8 7 11.5", "o thick") +
    p("M3.5 8h8.5a4.5 4.5 0 0 1 0 9H8", "o thick"),
  redo:
    p("M13 4.5 16.5 8 13 11.5", "o thick") +
    p("M16.5 8H8a4.5 4.5 0 0 0 0 9h4", "o thick"),
  more: ci(4.5, 10, 1.3, "s") + ci(10, 10, 1.3, "s") + ci(15.5, 10, 1.3, "s"),
  search: magnifier(8.5, 8.5, 5.5, "of"),
  share:
    p("M3.5 9.5v7h13v-7", "o") + p("M10 12.5v-10M7 5.5l3-3 3 3", "b thick"),
  present: monitor(2.5, 3, 15, 10.5) + badge(10, 8.25, "play", "g", 3.3),
  folderOpen:
    p("M2.5 15.5v-10a1 1 0 0 1 1-1h4l1.5 1.5h7a1 1 0 0 1 1 1v2", "bf") +
    p("M2.5 15.5l2.3-6.2a1 1 0 0 1 .9-.6h12l-2.3 6.2a1 1 0 0 1-.9.6z", "bs"),
  filePlus: page(4.5, 2.5, 11, 15) + badge(14.5, 14.5, "plus"),
  download: p("M3.5 13.5v3h13v-3", "o") + arrowDown(10, 3, 10),
  printer:
    r(5.5, 2.5, 9, 5, "of") +
    r(2.5, 7, 15, 7.5, "bs", 2) +
    r(5.5, 11.5, 9, 6, "of", 0.8) +
    lines(7, 14, 6, 2, 2) +
    ci(15, 9.3, 0.7, "glint"),
  pdf:
    page(4.5, 2.5, 11, 15) +
    r(2.5, 10.5, 10, 5, "rs", 1) +
    t(7.5, 14.5, "PDF", 4.6, { weight: 700, c: "txw" }),
  imageFile: page(4.5, 2.5, 11, 15) + pic(6.5, 7.5, 7, 7.5),

  // Clipboard
  paste:
    r(3, 3.5, 11, 14, "nf", 2) +
    r(5.5, 2, 6, 3.2, "of", 1.2) +
    page(8.5, 7, 9, 11, 2.5) +
    lines(10.3, 11.5, 5, 3, 2),
  cut:
    p("M7.4 11.8 14 2.5M12.6 11.8 6 2.5", "o") +
    ci(10, 8.6, 0.7, "s") +
    ci(6.2, 14.6, 2.7, "bs") +
    ci(6.2, 14.6, 1.2, "knock") +
    ci(13.8, 14.6, 2.7, "bs") +
    ci(13.8, 14.6, 1.2, "knock"),
  copy:
    r(2.5, 2.5, 10, 12, "bf glassy", 2) +
    r(7.5, 5.5, 10, 12, "of", 2) +
    lines(9.7, 9.5, 5.6, 4, 2),
  formatPainter: `<g transform="rotate(45 10 10)">${p("M9 9.5V2.5a1 1 0 0 1 2 0v7", "of") + p("M7.6 9.5h4.8V12H7.6z", "bs") + p("M7.6 12h4.8v1.5c0 2.2-1 3.8-2.4 5-1.4-1.2-2.4-2.8-2.4-5z", "ys")}</g>`,
  duplicate:
    slideBox(2.5, 2.5, 11, 8, "kf glassy") +
    slide(5.5, 6.5, 11, 8) +
    badge(15.5, 15, "plus"),

  // Slides
  newSlide: slide(2.5, 3, 14, 10.5) + badge(15, 14.5, "plus", "g", 3.6),
  layout:
    slideBox(2.5, 3.5, 15, 13) +
    r(4.2, 5.2, 11.6, 2.6, "ks", 1) +
    r(4.2, 9.2, 5.3, 5.6, "bs glassy", 1) +
    r(10.5, 9.2, 5.3, 5.6, "bf", 1),
  resetSlide:
    slide(6, 6.5, 11.5, 9) + ci(6, 6.5, 4.7, "knock") + turnBack(6, 6.5, 3.3),
  section:
    r(2.5, 2.5, 15, 3.8, "ns", 1.4) +
    p("M4.5 4.4h5", "wh thick") +
    slide(2.5, 8, 7, 5.5) +
    slide(10.5, 8, 7, 5.5) +
    p("M2.5 16.5h15", "o ln"),
  hideSlide:
    slide(2.5, 3, 13, 10) +
    ci(14, 14.5, 4.9, "knock") +
    eye(14, 14.5, 0.48) +
    p("M10.6 17.9 17.4 11.1", "r thick"),
  deleteSlide: slide(2.5, 3, 13, 10) + badge(15, 14.5, "x", "r", 3.6),
  slideNumber:
    slideBox(2.5, 4, 15, 12) + t(10, 14.4, "#", 11, { weight: 700, c: "txk" }),

  // Font
  fontGrow: t(7.5, 17.5, "A", 21) + p("M14.5 6l2.5-3 2.5 3", "o thick"),
  fontShrink: t(7.5, 17.5, "A", 16) + p("M14.5 3l2.5 3 2.5-3", "o thick"),
  clearFormat:
    t(7.5, 16, "A", 19) +
    `<g transform="rotate(-40 15 15.5)">${r(10.6, 12.1, 8.8, 6.8, "knock", 2.4) + r(11.5, 13, 7, 5, "ps", 1.4) + r(11.5, 13, 2.8, 5, "of", 1.2)}</g>`,
  bold: t(10, 16.2, "B", 17, { weight: 700 }),
  italic: t(10, 16.2, "I", 18, { italic: true, serif: true }),
  underline: t(10, 14, "U", 15) + p("M4.5 17.2h11", "o thick"),
  strike: t(10, 15.5, "S", 16) + p("M4 10.5h12", "o"),
  superscript: t(7.5, 17.5, "x", 19) + t(15.8, 9, "2", 10, { c: "txb" }),
  subscript: t(7.5, 13.5, "x", 19) + t(15.8, 18.5, "2", 10, { c: "txb" }),
  charSpacing:
    t(10, 11.5, "AV", 14) +
    p("M2 15.5h16M4 13.5l-2 2 2 2M16 13.5l2 2-2 2", "b thick"),
  changeCase: t(6.2, 17.5, "A", 18) + t(15.8, 17.5, "a", 13, { c: "txb" }),
  // Colour commands leave the bottom clear for the ribbon's colour bar.
  highlight: g(
    "rotate(45 10 9)",
    r(7.6, 1.5, 4.8, 9, "of", 1.2) +
      p("M7.6 10.5h4.8v1.4l-1.2 1.2v2.4h-2.4v-2.4l-1.2-1.2z", "ys") +
      p("M7.6 10.5h4.8v1.4l-1.2 1.2v2.4h-2.4v-2.4l-1.2-1.2z", "n"),
  ),
  textColor: t(10, 14.5, "A", 16),
  textHighlightBar: r(2.5, 16, 15, 2.5, "ys", 1),

  // Paragraph
  bullets:
    ci(4, 5, 1.5, "bs") +
    ci(4, 10, 1.5, "bs") +
    ci(4, 15, 1.5, "bs") +
    p("M7.5 5h9.5M7.5 10h9.5M7.5 15h9.5", "o"),
  numbering:
    t(4, 7, "1", 5.5, { weight: 700, c: "txb" }) +
    t(4, 12, "2", 5.5, { weight: 700, c: "txb" }) +
    t(4, 17, "3", 5.5, { weight: 700, c: "txb" }) +
    p("M7.5 5h9.5M7.5 10h9.5M7.5 15h9.5", "o"),
  indentLess:
    p("M3 3.5h14M9.5 7.5h7.5M9.5 11.5h7.5M3 16.5h14", "o") +
    p("M7.5 9.5h-5M4.5 7.5l-2 2 2 2", "b"),
  indentMore:
    p("M3 3.5h14M9.5 7.5h7.5M9.5 11.5h7.5M3 16.5h14", "o") +
    p("M2.5 9.5h5M5.5 7.5l2 2-2 2", "b"),
  lineSpacing:
    p("M8.5 4.5h9M8.5 8.5h9M8.5 12.5h9M8.5 16.5h9", "o") +
    p("M4 3v14M2 5l2-2 2 2M2 15l2 2 2-2", "b thick"),
  columns:
    p("M2.5 4.5h6.5M2.5 8h6.5M2.5 11.5h6.5M2.5 15h6.5", "o") +
    p("M11 4.5h6.5M11 8h6.5M11 11.5h6.5M11 15h4", "o") +
    p("M10 3v13.5", "b ln"),
  alignLeft: p("M3 4.5h14M3 8.5h9M3 12.5h14M3 16.5h9", "o"),
  alignCenter: p("M3 4.5h14M5.5 8.5h9M3 12.5h14M5.5 16.5h9", "o"),
  alignRight: p("M3 4.5h14M8 8.5h9M3 12.5h14M8 16.5h9", "o"),
  justify: p("M3 4.5h14M3 8.5h14M3 12.5h14M3 16.5h9", "o"),
  textDirection:
    `<g transform="rotate(-90 7.5 10)">${t(7.5, 15, "A", 14)}</g>` +
    p("M15 4v12M13 14l2 2 2-2", "b thick"),
  alignText:
    r(2.5, 2.5, 15, 15, "of", 2) +
    p("M5.5 8.5h9M5.5 11.5h9", "o") +
    p("M10 2.5v3M10 14.5v3", "b thick"),
  valignTop: p("M3 3.5h14", "o thick") + lines(6, 7, 8, 2, 3),
  valignMiddle: lines(6, 8.5, 8, 2, 3) + p("M3 3.5h14M3 16.5h14", "o dash"),
  valignBottom: lines(6, 10, 8, 2, 3) + p("M3 16.5h14", "o thick"),
  smartArtConvert:
    r(1.5, 1.5, 7, 5, "of", 1.2) +
    p("M3 3.4h4M3 5h2.5", "o ln") +
    p("M9.5 4h2M10.6 2.9 11.7 4l-1.1 1.1", "b") +
    p("M15 6.5V10M10 13v-3h10M10 10v3", "o") +
    r(12.5, 2.5, 5, 4, "bs", 1) +
    r(7.5, 13, 5, 4, "bf", 1) +
    r(14.5, 13, 4, 4, "gf", 1),

  // Drawing
  picture:
    r(2.5, 3.5, 15, 13, "bf", 2) +
    p(
      "M2.5 14l4.5-5 3.5 3.5 2.5-2.5 4.5 4.5v.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z",
      "gs",
    ) +
    ci(13, 7.5, 1.7, "ys"),
  shapes: ci(7.5, 7.5, 5, "bs") + r(8.5, 8.5, 9, 9, "nf glassy", 2),
  textBox:
    r(3.5, 4.5, 13, 11, "of", 1.6) +
    ci(3.5, 4.5, 1.2, "bs") +
    ci(16.5, 4.5, 1.2, "bs") +
    ci(3.5, 15.5, 1.2, "bs") +
    ci(16.5, 15.5, 1.2, "bs") +
    t(10, 14, "A", 9),
  arrange:
    r(2.5, 2.5, 8, 8, "of", 1.6) +
    r(6, 6, 8, 8, "bs glassy", 1.6) +
    r(9.5, 9.5, 8, 8, "nf glassy", 1.6),
  quickStyles:
    r(2.5, 2.5, 15, 4.2, "bs", 1.4) +
    ci(5, 4.6, 1, "glint") +
    r(2.5, 7.9, 15, 4.2, "nf", 1.4) +
    r(2.5, 13.3, 15, 4.2, "of", 1.4) +
    p("M7 4.6h8", "wh") +
    p("M7 10h8", "n") +
    p("M7 15.4h8", "o ln"),
  shapeFill:
    p("M4 9l5-5 6 6-5 5z", "of") +
    p("M4 9h11", "o ln") +
    p(
      "M16.5 11.5c.9 1.4 1.4 2.2 1.4 2.9a1.4 1.4 0 0 1-2.8 0c0-.7.5-1.5 1.4-2.9z",
      "bs",
    ) +
    r(2.5, 16.5, 15, 2, "ys"),
  shapeOutline: r(4.5, 3.5, 11, 10, "o thick", 1) + p("M3 17.5h14", "b thick"),
  shapeEffects: r(5.5, 5.5, 10, 10, "nw") + r(3.5, 3.5, 10, 10, "bf", 1),
  editShape:
    p("M3.5 15.5 6 4.5l9 2 2 9z", "bf") +
    ci(3.5, 15.5, 1.4, "knock") +
    ci(3.5, 15.5, 1.1, "bs") +
    ci(6, 4.5, 1.4, "knock") +
    ci(6, 4.5, 1.1, "bs") +
    ci(15, 6.5, 1.4, "knock") +
    ci(15, 6.5, 1.1, "bs") +
    ci(17, 15.5, 1.4, "knock") +
    ci(17, 15.5, 1.1, "bs"),
  mergeShapes:
    ci(7.5, 10, 5, "bs glassy") +
    ci(12.5, 10, 5, "ns glassy") +
    p("M10 5.7a5 5 0 1 0 0 8.6 5 5 0 1 0 0-8.6z", "o"),
  textFill: t(10, 16, "A", 19, { c: "txb" }),
  textOutline: t(10, 16, "A", 19, { c: "txo" }),
  textEffects:
    ci(9, 10, 7.5, "bw") +
    t(9, 16, "A", 18, { c: "txb" }) +
    sparkle(16, 4, 0.9),
  wordArt: t(10, 16, "A", 16, { italic: true, serif: true, c: "txb" }),

  // Arrange
  bringForward:
    r(2.5, 2.5, 9, 9, "of", 1.6) +
    r(8.5, 8.5, 9, 9, "bs", 1.6) +
    p("M13 15.5v-4.5M11 13l2-2 2 2", "wh thick"),
  sendBackward:
    r(8.5, 8.5, 9, 9, "bs", 1.6) +
    r(2.5, 2.5, 9, 9, "of glassy", 1.6) +
    p("M14.5 12v4M13 14.7l1.5 1.5 1.5-1.5", "wh thick"),
  bringToFront:
    r(2.5, 2.5, 8, 8, "of", 1.6) +
    r(9.5, 9.5, 8, 8, "of", 1.6) +
    r(6, 6, 8, 8, "bs", 1.6) +
    ci(8, 8, 0.9, "glint"),
  sendToBack:
    r(6, 6, 8, 8, "bs", 1.6) +
    r(2.5, 2.5, 8, 8, "of glassy", 1.6) +
    r(9.5, 9.5, 8, 8, "of glassy", 1.6),
  selectionPane:
    r(2.5, 2.5, 15, 15, "of", 2) +
    p("M9.5 2.5v15", "o ln") +
    r(10.8, 5, 5.4, 2.4, "bs", 1) +
    lines(11, 10.5, 5, 3, 2.5, "o") +
    cursor(4, 5, 0.75, "bs"),
  align:
    p("M3.5 2.5v15", "o thick") +
    r(5, 4.5, 11, 4, "bs", 1) +
    r(5, 11.5, 7, 4, "bf", 1),
  alignObjLeft:
    p("M3.5 2.5v15", "o thick") +
    r(5, 4.5, 11, 4, "bs", 1) +
    r(5, 11.5, 7, 4, "bf", 1),
  alignObjCenter:
    r(4, 4.5, 12, 4, "bs", 1) +
    r(6, 11.5, 8, 4, "bf", 1) +
    p("M10 2.5v15", "o thick"),
  alignObjRight:
    p("M16.5 2.5v15", "o thick") +
    r(4, 4.5, 11, 4, "bs", 1) +
    r(8, 11.5, 7, 4, "bf", 1),
  alignObjTop:
    p("M2.5 3.5h15", "o thick") +
    r(4.5, 5, 4, 11, "bs", 1) +
    r(11.5, 5, 4, 7, "bf", 1),
  alignObjMiddle:
    r(4.5, 4, 4, 12, "bs", 1) +
    r(11.5, 6, 4, 8, "bf", 1) +
    p("M2.5 10h15", "o thick"),
  alignObjBottom:
    p("M2.5 16.5h15", "o thick") +
    r(4.5, 4, 4, 11, "bs", 1) +
    r(11.5, 8, 4, 7, "bf", 1),
  distributeH:
    p("M2.5 3v14M17.5 3v14", "o ln") +
    r(4.5, 6, 3, 8, "bs", 1) +
    r(8.5, 7, 3, 6, "bs", 1) +
    r(12.5, 6, 3, 8, "bs", 1),
  distributeV:
    p("M3 2.5h14M3 17.5h14", "o ln") +
    r(6, 4.5, 8, 3, "bs", 1) +
    r(7, 8.5, 6, 3, "bs", 1) +
    r(6, 12.5, 8, 3, "bs", 1),
  group:
    r(2.5, 2.5, 15, 15, "o dash", 2) +
    r(4.5, 4.5, 6.5, 6.5, "bs", 1.4) +
    ci(12.5, 12.5, 3.5, "ns glassy"),
  ungroup:
    r(2.5, 2.5, 8, 8, "o dash", 1.6) +
    r(4, 4, 5, 5, "bs", 1.2) +
    r(9.5, 9.5, 8, 8, "o dash", 1.6) +
    ci(13.5, 13.5, 2.5, "ns"),
  rotate:
    r(6.5, 6.5, 10, 10, "bs glassy", 1.8) +
    p("M3 9.5a7 7 0 0 1 8-6.5", "b thick") +
    p("M9 1.3l2 1.7-1.6 2", "b thick"),
  flipH:
    p("M10 2v16", "o dash") +
    p("M8 4.5v11l-5.5-5.5z", "bs") +
    p("M12 4.5v11l5.5-5.5z", "bf"),
  flipV:
    p("M2 10h16", "o dash") +
    p("M4.5 8h11L10 2.5z", "bs") +
    p("M4.5 12h11l-5.5 5.5z", "bf"),
  crop:
    r(5.5, 5.5, 9, 9, "bw", 0) +
    p("M5.5 1.5v13h13", "o thick") +
    p("M1.5 5.5h13v13", "o thick"),
  altText:
    r(2.5, 4.5, 9, 8, "bw") +
    r(2.5, 4.5, 9, 8, "o") +
    p("M3.5 11.5l2.6-3 2 2 1.4-1.4 1.5 2.4", "g") +
    ci(8.6, 7, 0.9, "yf") +
    lines(13.5, 6, 4, 3, 2.5),
  size:
    r(4.5, 4.5, 11, 11, "bf", 1.6) +
    p("M2 4.5v11M18 4.5v11M4.5 2h11", "b thick"),
  sizeHeight:
    p("M4 2.5h12M4 17.5h12", "o") +
    p("M10 3.5v13M8 5.5l2-2 2 2M8 14.5l2 2 2-2", "b thick"),
  sizeWidth:
    p("M2.5 4v12M17.5 4v12", "o") +
    p("M3.5 10h13M5.5 8l-2 2 2 2M14.5 8l2 2-2 2", "b thick"),

  // Editing
  find: magnifier(8.5, 8.5, 5.5),
  replace:
    t(5.5, 8, "a", 8, { c: "txb" }) +
    p("M9.5 5h4.5a2 2 0 0 1 2 2v1.5M14.5 7.5l1.5 1.5 1.5-1.5", "b") +
    t(13, 17, "b", 8) +
    p("M10 14H6a2 2 0 0 1-2-2v-1", "o"),
  select: p("M5.5 2.5v13.2l3.3-3.2 2.3 5 2.3-1.1-2.3-4.9h4.6z", "of"),
  selectAll: r(2.5, 2.5, 15, 15, "b dash") + cursor(7, 5.5, 1.05, "bs"),
  dictate:
    r(7.5, 2.5, 5, 9.5, "bs", 2.5) +
    ci(9.2, 4.6, 0.8, "glint") +
    p("M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5M7 17.5h6", "o"),

  // Insert
  table:
    cells(2.5, 3.5, 15, 13, 3, 4, { head: "bf" }) +
    cells(2.5, 3.5, 15, 13, 3, 4, { frame: "o" }),
  pictures:
    r(2.5, 3.5, 15, 13, "bf", 2) +
    p(
      "M2.5 14l4.5-5 3.5 3.5 2.5-2.5 4.5 4.5v.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z",
      "gs",
    ) +
    ci(13, 7.5, 1.7, "ys"),
  icons:
    ci(10, 6.8, 3.6, "bs") +
    p("M3.5 17.5a6.5 6.5 0 0 1 13 0z", "bs") +
    ci(9, 5.8, 1, "glint"),
  smartArt: orgChart(),
  chart:
    chartAxes +
    columns([
      [6, "bf"],
      [11, "bf"],
      [8, "nf"],
    ]),
  chartColumn:
    chartAxes +
    columns([
      [6, "bf"],
      [11, "bf"],
      [8, "nf"],
    ]),
  chartBar:
    chartAxes +
    r(3.5, 4.5, 7, 2.6, "bs", 0.7) +
    r(3.5, 8.5, 12, 2.6, "bs", 0.7) +
    r(3.5, 12.5, 9, 2.6, "ns", 0.7),
  chartLine:
    chartAxes +
    p("M4 13l3.5-4.5 3 2.5L16.5 5", "b thick") +
    p("M4 15.5l3.5-2 3 1 6-4", "n"),
  chartPie:
    p("M10 3.5a7 7 0 1 0 7 7h-7z", "bs") + p("M11.5 2a7 7 0 0 1 7 7h-7z", "ns"),
  chartArea:
    chartAxes +
    p("M3.5 16.5V12l3.5-4 3.5 3 3-4 3.5 2.5v7z", "bf") +
    p("M3.5 12l3.5-4 3.5 3 3-4 3.5 2.5", "b thick"),
  chartScatter:
    chartAxes +
    ci(7, 12, 1.4, "bs") +
    ci(9.5, 8.5, 1.4, "bs") +
    ci(12, 10.5, 1.4, "ns") +
    ci(14.5, 5.5, 1.4, "bs") +
    ci(6.5, 7, 1.4, "ns"),
  chartDoughnut:
    p("M10 2.5a7.5 7.5 0 1 1-7.5 7.5H6a4 4 0 1 0 4-4z", "bs") +
    p("M10 2.5V6a4 4 0 0 0-4 4H2.5A7.5 7.5 0 0 1 10 2.5z", "ns"),
  chartRadar:
    p("M10 2.5l7 5-2.7 8.5H5.7L3 7.5z", "o ln") +
    p("M10 5.5l4.5 3.2-1.8 5.3H7.3L5.5 8.7z", "bs glassy"),
  chartCombo:
    chartAxes +
    columns([
      [5, "bf"],
      [9, "bf"],
      [7, "bf"],
    ]) +
    p("M5.5 9.5l4-4 4 3 3.5-4", "n thick"),
  link:
    p("M8.5 11.5a3 3 0 0 0 4.2 0l3-3a3 3 0 0 0-4.2-4.2l-1 1", "b thick") +
    p("M11.5 8.5a3 3 0 0 0-4.2 0l-3 3a3 3 0 0 0 4.2 4.2l1-1", "o thick"),
  unlink:
    p(
      "M12 6.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M8 13.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1",
      "o thick",
    ) + p("M4 4l2 2M16 16l-2-2M7.5 2.5v2M12.5 17.5v-2", "r"),
  action:
    r(2.5, 4, 12.5, 8.5, "bs", 2.4) +
    p("M4.5 5.6h8.5", "wh ln") +
    playMark(8.75, 8.25, 2) +
    cursor(11.5, 9.5, 0.85),
  comment: bubble() + p("M6.5 7h7M6.5 10.2h4.5", "wh thick"),
  newComment:
    p(
      "M3 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H9.5l-4 3v-3H5a2 2 0 0 1-2-2z",
      "bs",
    ) + p("M10 6v5.5M7.25 8.75h5.5", "wh thick"),
  deleteComment:
    p(
      "M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5l-2.5 2v-2H3.5a1 1 0 0 1-1-1z",
      "of",
    ) + badge(15, 15, "x", "r"),
  previousComment:
    p(
      "M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5l-2.5 2v-2H3.5a1 1 0 0 1-1-1z",
      "of",
    ) + p("M17.5 15h-7M13.5 12l-3 3 3 3", "p thick"),
  nextComment:
    p(
      "M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5l-2.5 2v-2H3.5a1 1 0 0 1-1-1z",
      "of",
    ) + p("M10.5 15h7M14.5 12l3 3-3 3", "p thick"),
  showComments:
    r(11.5, 2.5, 6, 15, "of", 1) +
    p("M13 6h3M13 9h3M13 12h3", "p") +
    p(
      "M2.5 5.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H6l-2 1.5v-1.5h-.5a1 1 0 0 1-1-1z",
      "pf",
    ),
  headerFooter:
    page(4.5, 2.5, 11, 15) +
    r(6, 4.5, 8, 2.5, "bw") +
    r(6, 13.5, 8, 2, "bw") +
    lines(6.5, 9, 7, 2, 2),
  dateTime:
    r(2.5, 4.5, 12, 11.5, "of", 1) +
    r(2.5, 4.5, 12, 3, "bf", 1) +
    p("M5.5 3v3M11.5 3v3", "o") +
    ci(14, 14, 4, "of") +
    p("M14 11.5V14l1.6 1", "b"),
  object:
    page(6.5, 2.5, 10, 13) +
    lines(8.5, 8, 5.5, 2, 2) +
    r(2.5, 9.5, 8, 8, "knock", 2) +
    r(3, 10, 7, 7, "bs", 1.6) +
    r(4.6, 11.6, 3.8, 3.8, "wh", 0.6),
  equation: t(10, 15.5, "π", 15),
  symbol: t(10, 15.5, "Ω", 14),
  video:
    r(2.5, 5, 11.5, 10, "bs", 2.2) +
    p("M14.8 9 18 7v6l-3.2-2z", "bs") +
    playMark(8.25, 10, 2.4),
  audio: speaker(2.5, 7.5) + waves(12.5, 10, 2),
  screenRecording:
    monitor(2.5, 3, 15, 10.5) +
    ci(10, 8.25, 3, "rs") +
    ci(9, 7.25, 0.8, "glint"),
  screenshot:
    monitor(2.5, 3, 15, 10.5) +
    r(6, 6, 8, 4.5, "bw", 0.6) +
    p("M4.5 6.5v-2h2M15.5 6.5v-2h-2M4.5 10v2h2M15.5 10v2h-2", "b thick"),
  photoAlbum:
    r(3.5, 2.5, 13, 15, "rs", 2) +
    p("M6 2.5v15", "wh ln") +
    r(7.8, 5.5, 6.7, 6.5, "knock", 0.8) +
    pic(8.3, 6, 5.7, 5.5),
  model3d:
    p("M10 2.5l6.5 3.5L10 9.5 3.5 6z", "bf") +
    p("M3.5 6 10 9.5v8L3.5 14z", "bs") +
    p("M16.5 6 10 9.5v8l6.5-3.5z", "bs glassy") +
    p("M10 2.5l6.5 3.5v8L10 17.5 3.5 14V6z", "o ln"),

  // Design
  themes:
    slideBox(2.5, 3.5, 15, 13) +
    t(7.5, 12.5, "Aa", 8, { serif: true }) +
    r(12.5, 6, 3, 2.2, "bs", 0.8) +
    r(12.5, 9, 3, 2.2, "gs", 0.8) +
    r(12.5, 12, 3, 2.2, "ks", 0.8),
  variants:
    r(2.5, 3.5, 7, 6, "bs", 1.2) +
    r(10.5, 3.5, 7, 6, "gs", 1.2) +
    r(2.5, 10.5, 7, 6, "ks", 1.2) +
    r(10.5, 10.5, 7, 6, "ps", 1.2) +
    p("M3.8 5.3h3.5M11.8 5.3h3.5M3.8 12.3h3.5M11.8 12.3h3.5", "wh thick"),
  slideSize:
    slide(4.5, 7, 11, 8.5) + p("M2 4.5h16M2 2.8v3.4M18 2.8v3.4", "b thick"),
  formatBackground:
    slideBox(2.5, 3, 14, 10.5, "kf") +
    ci(14.5, 14, 4.8, "knock") +
    g(
      "translate(9.5 8.8) scale(.6)",
      p("M3.5 9.5 9 4l6.5 6.5L10 16z", "of") +
        p("M3.5 9.5h12L10 16z", "ks") +
        p("M9 4 6.5 1.5", "o"),
    ) +
    p("M18.4 15.2c.5.8.8 1.3.8 1.7a.8.8 0 0 1-1.6 0c0-.4.3-.9.8-1.7z", "ks"),
  designer:
    slideBox(2.5, 6, 13, 10.5) +
    r(4, 7.8, 5, 7, "bs", 0.8) +
    ci(5.5, 9.4, 0.7, "glint") +
    lines(10, 9, 4, 3, 2) +
    sparkle(15.5, 4.5, 1.15) +
    sparkle(10.5, 3, 0.55),
  colors:
    ci(7.2, 7.2, 4.2, "bs glassy") +
    ci(12.8, 7.2, 4.2, "rs glassy") +
    ci(7.2, 12.8, 4.2, "gs glassy") +
    ci(12.8, 12.8, 4.2, "ys glassy"),
  fonts:
    t(7, 15.5, "A", 13, { serif: true }) + t(14.5, 15.5, "a", 10, { c: "txb" }),
  effects: ci(11.5, 11.5, 5, "ns glassy") + ci(8.5, 8.5, 5, "bf glassy"),
  backgroundStyles:
    slideBox(2.5, 3.5, 15, 13, "ks") +
    r(5.5, 6.5, 9, 7, "of", 1.2) +
    ci(4.3, 5.1, 0.8, "glint"),

  // Transitions and animations
  previewTransition:
    slideBox(2.5, 2.5, 11, 8, "of") +
    slide(6, 6, 11, 8.5, "kf glassy") +
    badge(15, 15, "play", "g", 3.4),
  previewAnimation: star(9, 9, 1.2) + badge(15, 15, "play", "g", 3.4),
  effectOptions:
    slide(6, 4.5, 11.5, 11) + p("M1.5 10h6.5M5.5 7.5 8 10l-2.5 2.5", "b thick"),
  transitionSound:
    slide(2.5, 2.5, 11, 8) +
    r(7.5, 9, 11, 9.5, "knock", 2) +
    g("translate(7 7.5) scale(.6)", speaker(2.5, 7.5) + waves(12.5, 10, 2)),
  duration: stopwatch(10, 11, 6.5),
  delay:
    p(
      "M5.5 2.5h9M5.5 17.5h9M7 2.5c0 4.2 6 4.6 6 7.5s-6 3.3-6 7.5M13 2.5c0 4.2-6 4.6-6 7.5s6 3.3 6 7.5",
      "o",
    ) + p("M8 16.2h4L10 13.6z", "ys"),
  applyToAll:
    slideBox(2.5, 2.5, 10, 7.5, "kf glassy") +
    slideBox(4.5, 5, 10, 7.5, "kf glassy") +
    slide(6.5, 7.5, 10, 7.5) +
    badge(15.5, 15, "check"),
  addAnimation: star(9, 9, 1.25) + badge(15, 15, "plus"),
  animationPane:
    r(2.5, 2.5, 15, 15, "of", 2) +
    p("M8.5 2.5v15", "o ln") +
    star(5.5, 6.5, 0.48) +
    p("M10 6h6M10 9.5h6M10 13h6", "o ln") +
    r(10, 5, 4.5, 2, "gs", 1) +
    r(12, 8.5, 4, 2, "ys", 1) +
    r(11, 12, 5, 2, "rs", 1),
  trigger:
    p("M11.5 1.5 4.5 11h5l-1.5 7.5L15.5 9h-5z", "ns") +
    p("M11.5 1.5 4.5 11h5l-1.5 7.5L15.5 9h-5z", "n"),
  animationPainter: painter(12, 11, 0.9) + star(5.5, 5.5, 0.75),
  moveEarlier:
    r(8, 3, 9.5, 3.4, "of", 1.2) +
    r(8, 8.3, 9.5, 3.4, "bs", 1.2) +
    r(8, 13.6, 9.5, 3.4, "of", 1.2) +
    arrowUp(4, 4, 11, "b thick"),
  moveLater:
    r(8, 3, 9.5, 3.4, "of", 1.2) +
    r(8, 8.3, 9.5, 3.4, "bs", 1.2) +
    r(8, 13.6, 9.5, 3.4, "of", 1.2) +
    arrowDown(4, 5, 11, "b thick"),
  entrance: star(10, 10.5, 1.45, "g"),
  emphasis: star(10, 10.5, 1.45, "y"),
  exit: star(10, 10.5, 1.45, "r"),
  motionPath:
    p("M3.5 15.5C6 4 14 16 16.5 4.5", "o dash") +
    ci(3.5, 15.5, 2.3, "knock") +
    ci(3.5, 15.5, 1.7, "gs") +
    ci(16.5, 4.5, 2.3, "knock") +
    ci(16.5, 4.5, 1.7, "rs"),
  noAnimation: p(starPath(10, 10.5, 1.45), "of") + p("M3 17 17 3", "r thick"),

  // Slide show
  playFromStart: slide(2.5, 3, 14, 10.5) + badge(15, 14.5, "first", "g", 3.6),
  playFromCurrent:
    slideBox(2.5, 2.5, 12, 9, "kf glassy") +
    slide(4.5, 5, 12.5, 9.5) +
    badge(15, 14.5, "play", "g", 3.6),
  presenterView:
    monitor(2.5, 3, 15, 11) +
    r(4, 4.5, 7.5, 5.5, "ks", 0.8) +
    ci(5.3, 5.7, 0.7, "glint") +
    r(12.5, 4.5, 3.5, 2.6, "bf", 0.6) +
    lines(12.5, 9.2, 3.5, 2, 1.6, "o") +
    p("M4 12h7.5", "o ln"),
  rehearse:
    slide(2.5, 2.5, 12, 9) +
    ci(14, 13.5, 5.2, "knock") +
    stopwatch(14, 13.8, 3.8),
  setUpShow:
    slide(2.5, 2.5, 12, 9) + ci(14, 13.5, 5, "knock") + gear(14, 13.5, 4.2),
  customShow:
    slide(2.5, 2.5, 9, 7) +
    slide(8.5, 10, 9, 7, "kf") +
    p("M6 10.5v3.5h1.5", "b thick"),
  recordShow:
    slide(2.5, 3, 14, 10.5) +
    ci(15, 14.5, 4.5, "knock") +
    ci(15, 14.5, 3.6, "rs") +
    ci(15, 14.5, 1.5, "wh") +
    ci(14, 13.4, 0.7, "glint"),
  laser:
    ci(6, 14, 3.6, "rw") +
    ci(6, 14, 2, "rs") +
    ci(5.4, 13.4, 0.6, "glint") +
    p("M8.5 11.5l8-8", "r thick"),
  penTool: pen(0, 0) + p("M2.5 17.5c3-1 5 1 8-.5", "b thick"),
  highlighterTool:
    g(
      "rotate(45 10 9)",
      r(7.6, 1.5, 4.8, 9, "of", 1.2) +
        p("M7.6 10.5h4.8v1.4l-1.2 1.2v2.4h-2.4v-2.4l-1.2-1.2z", "ys") +
        p("M7.6 10.5h4.8v1.4l-1.2 1.2v2.4h-2.4v-2.4l-1.2-1.2z", "n"),
    ) + p("M2.5 17.5h8", "y"),
  eraserTool:
    p(
      "M7 16.5 2.8 12.3a1 1 0 0 1 0-1.4l7.4-7.4a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-7.1 7.1z",
      "pf",
    ) +
    p("M2.8 12.3a1 1 0 0 1 0-1.4l3-3 6.4 6.4-2.5 2.5H7z", "of") +
    p("M11 18.5h6.5", "o"),
  seeAllSlides:
    slideBox(2.5, 3.5, 6.5, 5, "of") +
    slideBox(11, 3.5, 6.5, 5, "of") +
    slideBox(2.5, 11.5, 6.5, 5, "of") +
    slideBox(11, 11.5, 6.5, 5, "ks") +
    p("M4 5.3h3M12.5 5.3h3M4 13.3h3", "k thick") +
    p("M12.5 13.3h3", "wh thick"),
  zoomSlide:
    magnifier(8.5, 8.5, 5.5, "of") +
    r(5.5, 6.2, 6, 4.6, "kf", 0.8) +
    p("M8.5 7v3M7 8.5h3", "k"),
  // An unclassed rect fills black in every theme: the screen goes dark.
  blackScreen:
    monitor(2.5, 3, 15, 10.5) +
    `<rect x="3.7" y="4.2" width="12.6" height="8.1" rx="0.8"/>` +
    p("M5 5.6h3", "wh ln"),

  // Review
  spelling: t(8.5, 10, "abc", 8.5) + p("M7 14l2.5 2.5 6-6", "g thick"),
  thesaurus:
    p(
      "M3 4a1 1 0 0 1 1-1h4.5a1.5 1.5 0 0 1 1.5 1v13a2 2 0 0 0-1.5-.5H3z",
      "of",
    ) +
    p(
      "M17 4a1 1 0 0 0-1-1h-4.5a1.5 1.5 0 0 0-1.5 1v13a2 2 0 0 1 1.5-.5H17z",
      "bs",
    ) +
    lines(4.5, 6.5, 3.5, 3, 2.2) +
    p("M12 6.5h3.5M12 8.7h3.5M12 10.9h2.5", "wh ln"),
  accessibility:
    ci(8, 4, 1.8, "bs") +
    p("M3 7.5h10M8 7.5v5M8 12.5l-3 5M8 12.5l3 5", "o thick") +
    badge(15, 15, "check"),
  translate:
    r(2.5, 2.5, 9, 9, "bs", 1.6) +
    t(7, 9.8, "A", 7, { weight: 700, c: "txw" }) +
    r(8.5, 8.5, 9, 9, "of glassy", 1.6) +
    p(
      "M10.5 11.5h5M13 10.5v1M11.5 11.5c.5 2.5 2.5 4 4 4.5M14.5 11.5c-.5 2.5-2.5 4-4 4.5",
      "o",
    ),
  language:
    ci(10, 10, 7, "bf") +
    p(
      "M3 10h14M10 3c-2.5 2-3.5 4.5-3.5 7s1 5 3.5 7c2.5-2 3.5-4.5 3.5-7s-1-5-3.5-7z",
      "b",
    ),
  wordCount:
    page(4.5, 2.5, 11, 15) + t(10, 12.5, "123", 5.5, { weight: 700, c: "txb" }),
  compare:
    page(2.5, 5.5, 8, 12, 2) +
    page(9.5, 2.5, 8, 12, 2) +
    p("M8 10.5h4M10.5 9l1.5 1.5-1.5 1.5", "b thick"),

  // View
  normalView:
    r(2.5, 3.5, 15, 13, "of", 2) +
    p("M6.5 3.5v13", "o ln") +
    r(3.5, 5, 2, 1.5, "ks", 0.4) +
    r(3.5, 8, 2, 1.5, "o ln", 0.4) +
    r(8, 5, 8, 6, "kf", 0.8) +
    p("M6.5 13h11", "o ln"),
  outlineView:
    r(2.5, 3.5, 15, 13, "of", 2) +
    p("M7.5 3.5v13", "o ln") +
    lines(3.5, 6, 3, 4, 2.5, "o") +
    r(9, 5.5, 7, 5, "kf", 0.8),
  slideSorter:
    slideBox(2.5, 3.5, 4.2, 3.2) +
    slideBox(7.9, 3.5, 4.2, 3.2) +
    slideBox(13.3, 3.5, 4.2, 3.2) +
    slideBox(2.5, 8.4, 4.2, 3.2) +
    slideBox(7.9, 8.4, 4.2, 3.2, "ks") +
    slideBox(13.3, 8.4, 4.2, 3.2) +
    slideBox(2.5, 13.3, 4.2, 3.2) +
    slideBox(7.9, 13.3, 4.2, 3.2),
  notesPage:
    page(4.5, 2.5, 11, 15, 0) +
    r(6, 4, 8, 5.5, "ks", 0.8) +
    ci(7.2, 5.2, 0.6, "glint") +
    lines(6.5, 12, 7, 3, 1.8, "o"),
  readingView:
    p("M2.5 4.5c2.5-1 5-1 7.5.5v12c-2.5-1.5-5-1.5-7.5-.5z", "of") +
    p("M17.5 4.5c-2.5-1-5-1-7.5.5v12c2.5-1.5 5-1.5 7.5-.5z", "bs"),
  slideMaster:
    slideBox(5.5, 2.5, 12, 8.5, "ks") +
    p("M7 4.3h5", "wh thick") +
    slide(2.5, 7.5, 12, 8.5),
  handoutMaster:
    page(4.5, 2.5, 11, 15, 0) +
    r(6, 4, 3.5, 3, "ks", 0.5) +
    r(10.5, 4, 3.5, 3, "kf", 0.5) +
    r(6, 8.5, 3.5, 3, "kf", 0.5) +
    r(10.5, 8.5, 3.5, 3, "kf", 0.5) +
    r(6, 13, 3.5, 3, "kf", 0.5) +
    r(10.5, 13, 3.5, 3, "kf", 0.5),
  notesMaster:
    page(4.5, 2.5, 11, 15, 0) +
    r(6, 4, 8, 5.5, "kf", 0.8) +
    lines(6.5, 12, 7, 3, 1.8, "o") +
    p("M7 5.4h4", "k thick"),
  ruler:
    r(1.5, 6.5, 17, 7, "ns", 1.4) +
    p("M4 6.5v2.5M7 6.5v1.5M10 6.5v2.5M13 6.5v1.5M16 6.5v2.5", "wh thick"),
  gridlines:
    r(2.5, 3.5, 15, 13, "of") +
    p("M2.5 7.83h15M2.5 12.17h15M7.5 3.5v13M12.5 3.5v13", "b"),
  guides: r(2.5, 3.5, 15, 13, "of") + p("M10 3.5v13M2.5 10h15", "n thick dash"),
  notesPane:
    p("M3.5 3.5h13v9l-4 4h-9z", "yf") +
    p("M16.5 12.5h-4v4", "o") +
    lines(6, 7, 7, 2, 2.5),
  zoom: magnifier(8.5, 8.5, 5.5, "of"),
  zoomIn: magnifier(8.5, 8.5, 5.5) + p("M6 8.5h5M8.5 6v5", "o"),
  zoomOut: magnifier(8.5, 8.5, 5.5) + p("M6 8.5h5", "o"),
  fitWindow:
    r(5.5, 6.5, 9, 7, "ks", 1.2) +
    p("M2.5 6.5v-4h4M13.5 2.5h4v4M17.5 13.5v4h-4M6.5 17.5h-4v-4", "o thick"),
  color:
    p("M10 10V3a7 7 0 0 1 7 7z", "rs") +
    p("M10 10h7a7 7 0 0 1-7 7z", "ys") +
    p("M10 10v7a7 7 0 0 1-7-7z", "gs") +
    p("M10 10H3a7 7 0 0 1 7-7z", "bs"),
  grayscale:
    ci(10, 10, 7, "of") + p("M10 3a7 7 0 0 1 0 14z", "s") + ci(10, 10, 7, "o"),
  newWindow:
    r(2.5, 3.5, 11, 9, "of", 1.6) +
    r(6.5, 7.5, 11, 9, "bf glassy", 1.6) +
    p("M6.5 10.5h11", "b"),
  macros:
    r(2.5, 3.5, 15, 13, "of", 2) +
    p("M6 8l-2.5 2L6 12M14 8l2.5 2-2.5 2M11.5 6.5l-3 7", "b thick"),
  fullscreen:
    r(2.5, 3.5, 15, 10, "of", 1.6) +
    r(3.8, 4.8, 12.4, 7.4, "bs", 0.8) +
    p("M7 17.5h6M10 13.5v4", "o"),

  // Picture
  removeBackground:
    checker(2.5, 3.5, 15, 13) +
    ci(10, 8, 2.6, "bs") +
    p("M5 16.5a5 5 0 0 1 10 0z", "bs"),
  corrections:
    ci(10, 10, 3.6, "ys") +
    p(
      "M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4",
      "n thick",
    ),
  pictureColor:
    r(2.5, 3.5, 5, 13, "rs", 0) +
    r(7.5, 3.5, 5, 13, "gs", 0) +
    r(12.5, 3.5, 5, 13, "bs", 0) +
    r(2.5, 3.5, 15, 13, "o", 2) +
    p("M2.5 16a2 2 0 0 0 .5 0", "o ln"),
  artisticEffects: pic() + p("M4.5 13.5c2-4 4-6 6-3s3 1 5-4", "wh grip"),
  transparency:
    checker(2.5, 3.5, 15, 13) + r(5.5, 6.5, 12, 10, "bs glassy", 1.6),
  compress:
    r(5, 5, 10, 10, "bf", 1.6) +
    p("M2 2l3.5 3.5M18 2l-3.5 3.5M2 18l3.5-3.5M18 18l-3.5-3.5", "b thick") +
    p("M2.5 5.5h3v-3M17.5 5.5h-3v-3M2.5 14.5h3v3M17.5 14.5h-3v3", "b thick"),
  changePicture:
    pic(2.5, 6, 11, 10) + ci(15, 6, 3.8, "knock") + turnBack(15, 6, 2.6),
  resetPicture:
    pic(6, 6, 11.5, 10.5) +
    ci(5, 5.5, 4.2, "knock") +
    turnBack(5, 5.5, 2.8, "b thick"),
  pictureBorder:
    pic(2.5, 4, 11, 10.5) +
    r(2.5, 4, 11, 10.5, "o thick", 2.2) +
    pen(2.5, -1.5),
  pictureEffects:
    r(5.5, 5.5, 12, 11, "s ln", 2) + pic(3, 3, 12, 11) + sparkle(16, 4.5, 0.9),
  pictureLayout:
    pic(2.5, 3, 6, 6) +
    pic(2.5, 11, 6, 6) +
    lines(10.5, 5, 7, 2, 2, "o") +
    lines(10.5, 13, 7, 2, 2, "o"),

  // Table
  tableStyles:
    cells(1.5, 2.5, 14, 12, 3, 4, { head: "bs" }) +
    r(1.5, 8.5, 14, 3, "bw") +
    cells(1.5, 2.5, 14, 12, 3, 4, { frame: "o" }) +
    brush(1.5, 1.5),
  shading:
    p("M3.5 9.5 9 4l6.5 6.5L10 16z", "bf") +
    p("M3.5 9.5h12", "b") +
    p("M9 4 6.5 1.5", "o") +
    p(
      "M16.5 11.5c1 1.6 1.6 2.6 1.6 3.3a1.6 1.6 0 0 1-3.2 0c0-.7.6-1.7 1.6-3.3z",
      "ys",
    ),
  borders: borderIcon(["bottom"]),
  insertAbove:
    banded(2.5, 3.5, 15, 13, 3, 3, r(2.5, 3.5, 15, 4.33, "bw")) +
    badge(15.5, 4.5, "plus", "g", 3),
  insertBelow:
    banded(2.5, 3.5, 15, 13, 3, 3, r(2.5, 12.17, 15, 4.33, "bw")) +
    badge(15.5, 15.5, "plus", "g", 3),
  insertLeft:
    banded(2.5, 3.5, 15, 13, 3, 3, r(2.5, 3.5, 5, 13, "bw")) +
    badge(4.5, 15.5, "plus", "g", 3),
  insertRight:
    banded(2.5, 3.5, 15, 13, 3, 3, r(12.5, 3.5, 5, 13, "bw")) +
    badge(15.5, 15.5, "plus", "g", 3),
  deleteTable:
    cells(2.5, 3.5, 12.5, 11, 3, 3, { head: "bw" }) +
    cells(2.5, 3.5, 12.5, 11, 3, 3, { frame: "o" }) +
    badge(15, 15, "x", "r"),
  deleteRows:
    cells(2.5, 3.5, 15, 13, 2, 3) +
    r(2.5, 7.83, 15, 4.33, "rw") +
    cells(2.5, 3.5, 15, 13, 2, 3, { frame: "o" }) +
    badge(15.5, 15.5, "minus", "r"),
  deleteColumns:
    cells(2.5, 3.5, 15, 13, 3, 2) +
    r(7.5, 3.5, 5, 13, "rw") +
    cells(2.5, 3.5, 15, 13, 3, 2, { frame: "o" }) +
    badge(15.5, 15.5, "minus", "r"),
  mergeCells:
    r(2.5, 4.5, 15, 11, "bs", 2.4) +
    p("M5.5 10h9M7.5 8l-2 2 2 2M12.5 8l2 2-2 2", "wh thick"),
  splitCells:
    r(2.5, 4.5, 7, 11, "bf", 2) +
    r(10.5, 4.5, 7, 11, "bf", 2) +
    p("M8 10H4.5M6 8.5 4.5 10 6 11.5M12 10h3.5M14 8.5l1.5 1.5-1.5 1.5", "b"),
  distributeRows:
    cells(2.5, 3.5, 12, 13, 1, 3) +
    p("M17 4.5v11M15.5 6 17 4.5 18.5 6M15.5 14 17 15.5l1.5-1.5", "b thick"),
  distributeColumns:
    cells(2.5, 2.5, 15, 12, 3, 1) +
    p("M3.5 17h13M5 15.5 3.5 17 5 18.5M15 15.5l1.5 1.5-1.5 1.5", "b thick"),
  cellMargins:
    r(2.5, 2.5, 15, 15, "of", 2) +
    r(5.5, 5.5, 9, 9, "bw", 0) +
    r(5.5, 5.5, 9, 9, "b dash"),
  eraser:
    p(
      "M7 16.5 2.8 12.3a1 1 0 0 1 0-1.4l7.4-7.4a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-7.1 7.1z",
      "pf",
    ) +
    p("M2.8 12.3a1 1 0 0 1 0-1.4l3-3 6.4 6.4-2.5 2.5H7z", "of") +
    p("M11 18.5h6.5", "o"),
  drawTable:
    cells(2.5, 6.5, 11, 11, 2, 2, { frame: "o dash" }) + pen(2.5, -1.5),

  // Panes and status bar
  formatPane:
    r(2.5, 2.5, 15, 15, "of", 2) +
    r(11.5, 2.5, 6, 15, "bw", 0) +
    p("M11.5 2.5v15", "o ln") +
    p("M13 6h3M13 8.5h3M13 11h3M13 13.5h2", "b") +
    r(2.5, 2.5, 15, 15, "o", 2),
  normalViewSmall:
    r(2.5, 4, 15, 12, "of", 1.6) +
    r(3.5, 5, 3.5, 10, "bw", 0.6) +
    r(8, 6.5, 8.5, 6, "ks", 0.6),
  readingViewSmall:
    r(2.5, 4, 15, 12, "of", 1.6) +
    r(3.5, 5, 6, 10, "bw", 0.6) +
    p("M10 4v12", "o"),
  slideShowSmall: monitor(2.5, 3, 15, 10.5) + r(5, 5.5, 10, 5.5, "ks", 0.6),
  // A page with an arrow leaving it.
  exportFile:
    r(3, 2.5, 10, 15, "of") +
    p("M6 7h4M6 10h2.5M6 13h4", "o ln") +
    p("M9.5 10h8M15 7.2l2.8 2.8-2.8 2.8", "b thick"),
  // A picture with its corners drawn in.
  compressPictures:
    r(4.5, 5, 11, 10, "gf") +
    p("M6.5 13l2.6-3 2 2 1.6-1.6 1.8 2.6", "g") +
    p("M1.8 2l3 3M4.8 2.6V5H2.4M18.2 18l-3-3M15.2 17.4V15h2.4", "b thick"),
  // A drive with a level of how full it is.
  fileSize:
    r(2.5, 6, 15, 9, "of", 2) +
    r(4.5, 8.5, 7, 4, "bs", 0.8) +
    ci(14.5, 10.5, 1, "gs"),
  info:
    ci(10, 10, 7.5, "bs") + p("M10 9v5", "wh grip") + ci(10, 6.1, 1.1, "txw"),
  help:
    ci(10, 10, 7.5, "bs") +
    p("M7.8 7.8a2.3 2.3 0 1 1 3.3 2.1c-.7.4-1.1.9-1.1 1.6v.5", "wh thick") +
    ci(10, 14.3, 1, "txw"),
  keyboard:
    r(1.5, 5.5, 17, 9.5, "of", 2) +
    p(
      "M4 8.5h1M7 8.5h1M10 8.5h1M13 8.5h1M16 8.5h0M4 11.5h1M7 11.5h6M15.5 11.5h0",
      "o thick",
    ),
  settings: gear(10, 10, 7.5, "bs"),
};

// An icon as an SVG element: the drawing named, at `size` CSS pixels.
const cache = new Map();
export function commandIcon(name, size = 20) {
  const body = COMMAND_ICONS[name];
  if (body == null) return null;
  let template = cache.get(name);
  if (!template) {
    template = document.createElement("template");
    template.innerHTML = `<svg class="ico" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" aria-hidden="true" focusable="false">${body}</svg>`;
    cache.set(name, template);
  }
  const svg = template.content.firstChild.cloneNode(true);
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.dataset.icon = name;
  return svg;
}
export const hasCommandIcon = (name) => name in COMMAND_ICONS;

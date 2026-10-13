// Command icons for the format features, drawn in the app's icon idiom
// (see src/chrome/icons.js): a 20-unit grid, outlines over soft fills, solid
// accent marks. They join the shared registry so `icon("o:name")` finds them.
import { COMMAND_ICONS } from "../chrome/icons.js";

const p = (d, c = "o") => `<path class="${c}" d="${d}"/>`;
const r = (x, y, w, h, c = "o", rx = 1.6) =>
  `<rect class="${c}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`;
const ci = (cx, cy, rad, c = "o") =>
  `<circle class="${c}" cx="${cx}" cy="${cy}" r="${rad}"/>`;

const ICONS = {
  shadow: r(6.5, 6.5, 11, 11, "nf", 1.8) + r(2.5, 2.5, 11, 11, "bs", 1.8),
  reflection:
    r(4, 2.5, 12, 8, "bs", 1.6) +
    p("M2.5 12h15", "o") +
    r(4, 13.5, 12, 4, "bf glassy", 1.2),
  glow: ci(10, 10, 7.5, "yw") + ci(10, 10, 4.5, "bs"),
  softEdges: r(2.5, 2.5, 15, 15, "o dash", 3.5) + r(5, 5, 10, 10, "bf", 2.6),
  bevel:
    r(2.5, 2.5, 15, 15, "bs", 1.8) +
    r(6, 6, 8, 8, "bf", 1) +
    p("M2.5 2.5 6 6M17.5 2.5 14 6M2.5 17.5 6 14M17.5 17.5 14 14", "wh"),
  rotate3d:
    p("M4 6.5 13 3.5v10l-9 3z", "bs glassy") +
    p("M15 4.5a6.5 6.5 0 0 1 0 11", "b thick") +
    p("M13.4 15.6l1.8.1-.2-1.8", "b thick"),
  format3d:
    p("M3 6.5 10 3l7 3.5v7L10 17l-7-3.5z", "bf") +
    p("M3 6.5 10 10l7-3.5M10 10v7", "o"),
  pasteSpecial:
    r(3, 3.5, 11, 14, "nf", 2) +
    r(5.5, 2, 6, 3.2, "of", 1.2) +
    p(
      "M14.5 9.5l1 2.2 2.3.3-1.7 1.6.4 2.3-2-1.1-2 1.1.4-2.3-1.7-1.6 2.3-.3z",
      "ys",
    ),
  replaceFonts:
    p("M2.5 12 5.5 3.5h1L9.5 12M3.6 9h4.8", "o thick") +
    p("M11 7.5h6M14.5 5.5l2.5 2-2.5 2", "b thick") +
    p("M11.5 17.5V12h3a1.6 1.6 0 0 1 0 3.2h-3m3 0a1.7 1.7 0 0 1 0 2.3h-3", "o"),
  paragraph:
    p("M15.5 3.5h-7a3.5 3.5 0 0 0 0 7h2v6M12.5 3.5v13", "o thick") +
    p("M15.5 3.5v13", "b thick"),
  fontDialog:
    p("M3 16 7.5 3.5h1L13 16M4.5 11.5h7", "o thick") +
    r(12.5, 11.5, 5, 5, "bs", 1),
  editPoints:
    p("M3.5 15.5C5 8 8 4 12 4.5s4.5 5.5 4 11", "o") +
    r(2.3, 14.3, 2.4, 2.4, "bs", 0.4) +
    r(10.8, 3.3, 2.4, 2.4, "bs", 0.4) +
    r(15.3, 14.3, 2.4, 2.4, "bs", 0.4) +
    p("M8 5.5l7.5-2", "b") +
    ci(8, 5.5, 1, "bs") +
    ci(15.5, 3.5, 1, "bs"),
  mergeUnion: p(
    "M8 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 4-1.7 5.5 5.5 0 1 0 0-7.6A5.5 5.5 0 0 0 8 3.5z",
    "bs",
  ),
  mergeCombine:
    ci(7.5, 9, 5, "bs") +
    ci(12.5, 11, 5, "bs") +
    p("M10 5.6a5 5 0 0 1 0 8.8 5 5 0 0 1 0-8.8z", "knock"),
  mergeFragment:
    ci(7.5, 9, 5, "bf") +
    ci(12.5, 11, 5, "nf") +
    p("M10 5.6a5 5 0 0 1 0 8.8 5 5 0 0 1 0-8.8z", "bs") +
    p("M7.5 4v10M12.5 6v10", "wh"),
  mergeIntersect:
    ci(7.5, 9, 5, "o dash") +
    ci(12.5, 11, 5, "o dash") +
    p("M10 5.6a5 5 0 0 1 0 8.8 5 5 0 0 1 0-8.8z", "bs"),
  mergeSubtract:
    p("M7.5 4a5 5 0 1 0 2.5 9.4 5 5 0 0 1 0-7.8A5 5 0 0 0 7.5 4z", "bs") +
    ci(12.5, 11, 5, "o dash"),
  rotateLeft:
    r(3.5, 6.5, 10, 10, "bs glassy", 1.8) +
    p("M17 9.5a7 7 0 0 0-8-6.5", "b thick") +
    p("M11 1.3 9 3l1.6 2", "b thick"),
  rotateRight:
    r(6.5, 6.5, 10, 10, "bs glassy", 1.8) +
    p("M3 9.5a7 7 0 0 1 8-6.5", "b thick") +
    p("M9 1.3l2 1.7-1.6 2", "b thick"),
  regroup:
    r(2.5, 2.5, 15, 15, "o dash", 2) +
    r(4.5, 4.5, 6.5, 6.5, "bs", 1.4) +
    ci(12.5, 12.5, 3.5, "ns glassy") +
    p("M13.5 3.5a3 3 0 0 1 2.5 3", "g thick"),
  pictureStyles:
    r(2.5, 3.5, 15, 13, "nf", 1.2) +
    r(4.5, 5.5, 11, 9, "bs", 0.6) +
    p("M4.5 12.5l3-3 2.5 2.5 2-2 3.5 3.5", "wh"),
  cropShape:
    ci(10, 10, 6.5, "bf") + p("M5 1.5V15h13.5M1.5 5H15v13.5", "o thick"),
  aspectRatio: r(2.5, 5, 15, 10, "o dash", 1.2) + r(5.5, 5, 9, 10, "bs", 1),
};

for (const [name, body] of Object.entries(ICONS))
  if (!(name in COMMAND_ICONS)) COMMAND_ICONS[name] = body;

export const FORMAT_ICONS = Object.keys(ICONS);

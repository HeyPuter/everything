// Command icons for layouts and the master views, drawn for this project in
// the same idiom as src/chrome/icons.js (a 20-unit grid, outline and accent
// classes from icons.css). They join the shared icon table so the ribbon and
// menus find them by name.
import { COMMAND_ICONS } from "../chrome/icons.js";

const p = (d, c = "o") => `<path class="${c}" d="${d}"/>`;
const r = (x, y, w, h, c = "o", rx = 1.2) =>
  `<rect class="${c}" x="${x}" y="${y}" width="${w}" height="${h}"${rx ? ` rx="${rx}"` : ""}/>`;
const ci = (cx, cy, rad, c = "o") =>
  `<circle class="${c}" cx="${cx}" cy="${cy}" r="${rad}"/>`;
const slide = (x, y, w, h, c = "of") =>
  r(x, y, w, h, c, 1.2) +
  r(x + w * 0.14, y + h * 0.17, w * 0.55, 1.4, "ks", 0.7);
const SIGNS = {
  plus: (x, y, k) => `M${x - k} ${y}h${2 * k}M${x} ${y - k}v${2 * k}`,
  x: (x, y, k) =>
    `M${x - k * 0.8} ${y - k * 0.8}l${k * 1.6} ${k * 1.6}M${x + k * 0.8} ${y - k * 0.8}l-${k * 1.6} ${k * 1.6}`,
  check: (x, y, k) =>
    `M${x - k} ${y + 0.1}l${k * 0.7} ${k * 0.7} ${k * 1.3}-${k * 1.5}`,
};
const badge = (cx, cy, sign, hue = "g", rad = 3.4) =>
  ci(cx, cy, rad + 0.9, "knock") +
  ci(cx, cy, rad, `${hue}s`) +
  p(SIGNS[sign](cx, cy, rad * 0.48), "wh thick");
// A dashed placeholder box.
const frame = (x, y, w, h) => r(x, y, w, h, "n dash", 0.6);

const ICONS = {
  // A master with its layouts tucked under it, and a new one arriving.
  insertSlideMaster:
    r(2.5, 2.5, 11, 8, "kf", 1.2) +
    p("M4 4.3h5", "k thick") +
    p("M5 11.5v4h3M5 13.5h3", "o ln") +
    r(8.5, 12, 5, 3.5, "of", 0.8) +
    badge(15, 14.5, "plus", "g", 3.4),
  // A layout: title bar and two content frames, with a plus badge.
  insertLayout:
    slide(2.5, 3, 13, 10) +
    frame(4.3, 8, 4, 3.4) +
    frame(9.5, 8, 4, 3.4) +
    badge(15, 14.5, "plus", "g", 3.4),
  // A dashed frame with a plus: a new placeholder on the layout.
  insertPlaceholder:
    r(2.5, 3, 15, 12, "of", 1.2) +
    frame(4.5, 5, 9, 7) +
    p("M7 8.5h4M9 6.5v4", "b thick") +
    badge(15, 14.5, "plus", "g", 3.4),
  // The master's own placeholders switched on and off.
  masterLayout:
    r(2.5, 3, 15, 12, "of", 1.2) +
    frame(4.2, 4.6, 11.6, 2.4) +
    frame(4.2, 8.2, 11.6, 4.4) +
    p("M4.2 13.7h3M8.6 13.7h3M13 13.7h2.8", "n"),
  // A pencil writing a name under a slide.
  renameLayout:
    slide(2.5, 2.5, 13, 9) +
    p("M4 15.5h5", "o ln") +
    p("M11 17.2l.4-2.2 5.2-5.2 1.8 1.8-5.2 5.2z", "bf") +
    p("M15.5 10.9l1.8 1.8", "b"),
  // A pin holding a layout in the file.
  preserveLayout:
    slide(2.5, 4, 12.5, 9.5) +
    ci(15.5, 6, 2.6, "rs") +
    p("M15.5 8.6v8", "o thick"),
  deleteLayout: slide(2.5, 3, 13, 10) + badge(15, 14.5, "x", "r", 3.4),
  duplicateLayout:
    r(5.5, 2.5, 12, 8.5, "of", 1.2) +
    slide(2.5, 7.5, 12, 8.5) +
    badge(15, 15, "plus", "g", 3),
  // Leaving master view: a master slide with a red close badge.
  closeMasterView:
    r(2.5, 3, 13, 10, "kf", 1.2) +
    p("M4.2 5h5.5", "k thick") +
    badge(15, 14.5, "x", "r", 3.6),
  // Portrait and landscape pages for the notes and handout orientation.
  pageOrientation:
    r(3, 2.5, 8, 11, "of", 1) +
    r(7.5, 9.5, 10, 7.5, "bf", 1) +
    p("M5 16.5a4 4 0 0 0 3-1.2", "o") +
    p("M7 14.2l1 1.1-1.4.5", "o"),
  hideBackgroundGraphics:
    r(2.5, 3.5, 15, 12, "of", 1.2) +
    ci(13.5, 7.5, 2, "ys") +
    p("M2.5 13l4-4 3 3 2-2 6 5.5", "g") +
    p("M3.5 17 16.5 2.5", "r thick"),
};

for (const [name, body] of Object.entries(ICONS))
  if (!(name in COMMAND_ICONS)) COMMAND_ICONS[name] = body;

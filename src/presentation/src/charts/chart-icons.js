// Command icons for the chart and SmartArt tabs, drawn for this project in
// the same idiom as src/chrome/icons.js (20-unit grid, the o/b/n/g/y/r
// classes from icons.css). They join the app's icon set when this module
// loads.
import { COMMAND_ICONS } from "../chrome/icons.js";

const p = (d, c = "o") => `<path class="${c}" d="${d}"/>`;
const r = (x, y, w, h, c = "o", rx = 1.2) =>
  `<rect class="${c}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`;
const ci = (cx, cy, rad, c = "o") =>
  `<circle class="${c}" cx="${cx}" cy="${cy}" r="${rad}"/>`;
const axes = p("M3.5 3v13.5H17", "o ln");
const bars =
  r(5, 10, 2.6, 6.5, "bs", 0.6) +
  r(9, 6, 2.6, 10.5, "bs", 0.6) +
  r(13, 8.5, 2.6, 8, "ns", 0.6);
// A round badge with a plus, as the app's "add" commands carry.
const plusBadge = (x, y) =>
  ci(x, y, 3.6, "gs") + p(`M${x} ${y - 2}v4M${x - 2} ${y}h4`, "wh thick");
const grid = (x, y, w, h, cols, rows, c = "of") => {
  let d = "";
  for (let i = 1; i < cols; i++) d += `M${x + (w * i) / cols} ${y}v${h}`;
  for (let j = 1; j < rows; j++) d += `M${x} ${y + (h * j) / rows}h${w}`;
  return r(x, y, w, h, c, 1.4) + p(d, "o ln");
};

Object.assign(COMMAND_ICONS, {
  chartElement: axes + bars + plusBadge(15.5, 5),
  quickLayout:
    r(2.5, 3, 15, 14, "of", 1.6) +
    r(4.5, 5, 7, 1.6, "bs", 0.5) +
    r(4.5, 8, 7, 7, "bf", 0.8) +
    r(13, 8, 2.8, 1.4, "ns", 0.4) +
    r(13, 10.5, 2.8, 1.4, "gs", 0.4) +
    r(13, 13, 2.8, 1.4, "ys", 0.4),
  chartColors:
    ci(6, 6.5, 3.2, "bs") +
    ci(13.5, 6.5, 3.2, "ns") +
    ci(6, 13.5, 3.2, "gs") +
    ci(13.5, 13.5, 3.2, "ys"),
  chartStyles:
    r(2.5, 3, 15, 14, "of", 1.6) +
    r(5, 10.5, 2.4, 4.5, "bs", 0.5) +
    r(8.8, 7, 2.4, 8, "bs", 0.5) +
    r(12.6, 9, 2.4, 6, "ns", 0.5) +
    p("M4.5 6h11", "o ln"),
  switchRowColumn:
    grid(2.5, 2.5, 9, 9, 3, 3) +
    p("M14.5 4.5h1a2 2 0 0 1 2 2v6", "b thick") +
    p("M15.5 10.5l2 2.2 2-2.2", "b thick") +
    p("M4.5 14.5v1a2 2 0 0 0 2 2h6", "n thick") +
    p("M10.5 15.5l2.2 2-2.2 2", "n thick"),
  selectData:
    grid(2.5, 3, 12, 11, 3, 3) +
    r(6.5, 6.7, 4, 3.6, "bf", 0) +
    p("M12 11l5.5 2-2.3.9-.9 2.3z", "s"),
  editData:
    grid(2.5, 3, 12, 11, 3, 3) +
    p("M11.5 16.5l.6-2.6 5-5a1.4 1.4 0 0 1 2 2l-5 5z", "ys") +
    p("M11.5 16.5l.6-2.6 5-5a1.4 1.4 0 0 1 2 2l-5 5z", "o"),
  changeChartType:
    axes +
    r(5, 11, 2.4, 5.5, "bs", 0.5) +
    r(8.6, 8, 2.4, 8.5, "bs", 0.5) +
    p("M11.5 4.5h4.5l-1.6-1.6M16 4.5l-1.6 1.6", "n thick") +
    p("M12.5 13l2-3 2 1.5", "n thick"),
  chartElementsPane:
    axes + bars + p("M15 2.5l1 2 2 1-2 1-1 2-1-2-2-1 2-1z", "ys"),
  // SmartArt commands.
  textPane:
    r(2.5, 3, 7, 14, "of", 1.4) +
    p("M4.3 6h3.4M5.3 9h2.4M5.3 12h2.4M4.3 15h3.4", "o") +
    r(11, 4, 6.5, 4, "bs", 1) +
    r(11, 12, 6.5, 4, "bf", 1),
  addShape: r(2.5, 6, 10, 8, "bf", 1.6) + plusBadge(15, 13.5),
  promote:
    p("M8 6.5h9.5M8 10h9.5M8 13.5h9.5", "o") +
    p("M6 7l-3.5 3 3.5 3", "b thick"),
  demote:
    p("M2.5 6.5h9.5M8 10h9.5M8 13.5h9.5", "o") +
    p("M2.5 8l3.5 2-3.5 2", "b thick"),
  moveUp: r(3, 11, 10, 6, "of", 1.2) + p("M15 15V4M12 7l3-3 3 3", "b thick"),
  moveDown: r(3, 3, 10, 6, "of", 1.2) + p("M15 5v11M12 13l3 3 3-3", "b thick"),
  rightToLeft:
    r(10.5, 3.5, 7, 5, "bs", 1) +
    r(2.5, 3.5, 5, 5, "of", 1) +
    p("M16 13.5H4.5M7.5 10.5l-3 3 3 3", "n thick"),
  smartArtLayout:
    r(7, 2.5, 6, 4, "bs", 1) +
    p("M10 6.5v2.5M4.5 11.5V9h11v2.5", "o") +
    r(2, 11.5, 5, 4, "bf", 1) +
    r(13, 11.5, 5, 4, "bf", 1),
  resetGraphic:
    r(6, 6, 11.5, 11, "bf", 1.6) +
    p("M3.5 9.5a6 6 0 0 1 6-6h2", "n thick") +
    p("M9.5 1.5l2 2-2 2", "n thick"),
  convertToText:
    r(2.5, 3, 15, 14, "of", 1.6) +
    ci(5.5, 7, 0.9, "s") +
    ci(5.5, 10.5, 0.9, "s") +
    ci(5.5, 14, 0.9, "s") +
    p("M8 7h7M8 10.5h6M8 14h7", "o"),
  convertToShapes:
    r(2.5, 3, 7, 6, "bs", 1.2) +
    ci(14, 6, 3.3, "ns") +
    p("M2.5 17.5l4-6 4 6z", "gs") +
    r(11, 12, 6.5, 5.5, "yf", 1.2),
});

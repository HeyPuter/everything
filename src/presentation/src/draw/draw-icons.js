// The Draw tab's own command icons, drawn for this project in the same idiom
// and classes as src/chrome/icons.js (20-unit grid, thin outlines, glass
// fills), and added to the app's command icons when this module loads.
// Lucide icons the module needs beyond the app's set come from here too.
import {
  createElement,
  Pause,
  RotateCcw,
  Pin,
  PinOff,
  House,
  Clock,
  Users,
  FolderOpen,
  FilePlus,
  Sparkles,
  ArrowUp,
  Play,
} from "lucide";
import { COMMAND_ICONS } from "../chrome/icons.js";

const p = (d, c = "o") => `<path class="${c}" d="${d}"/>`;
const ci = (cx, cy, r, c = "o") =>
  `<circle class="${c}" cx="${cx}" cy="${cy}" r="${r}"/>`;
const r = (x, y, w, h, c = "o", rx = 1.2) =>
  `<rect class="${c}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`;
const g = (t, body) => `<g transform="${t}">${body}</g>`;
// A pen nib drawn diagonally, writing at its lower left.
const nib = (dx = 0, dy = 0, hue = "b") =>
  g(
    `translate(${dx} ${dy})`,
    p("M12.6 3.4l3 3-7.4 7.4-3-3z", `${hue}s`) +
      p("M13.6 2.4a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2l-1 1-3-3z", "ns") +
      p("M5.2 10.8l3 3-4.2 1.2z", "of") +
      p("M4.4 13.6l.8.8-1.2.4z", "s"),
  );
const badge = (cx, cy, sign, hue = "g", rad = 3.2) =>
  ci(cx, cy, rad + 0.9, "knock") +
  ci(cx, cy, rad, `${hue}s`) +
  p(
    sign === "plus"
      ? `M${cx - 1.6} ${cy}h3.2M${cx} ${cy - 1.6}v3.2`
      : `M${cx - 1.4} ${cy - 1.6}l3 1.6-3 1.6z`,
    "wh thick",
  );

Object.assign(COMMAND_ICONS, {
  lassoSelect:
    p(
      "M10 3.5c4.4 0 7.5 2 7.5 4.6S14.4 12.7 10 12.7 2.5 10.7 2.5 8.1 5.6 3.5 10 3.5z",
      "o dash",
    ) +
    p("M5.5 11.6c-1.2 1.4-1 3 .4 3.4 1.6.5 2.2 1.6 1.2 3", "o") +
    p("M12 9.5v8l2-2 1.4 3 1.4-.6-1.4-3h2.8z", "of"),
  strokeEraser:
    p(
      "M7 16.5 2.8 12.3a1 1 0 0 1 0-1.4l7.4-7.4a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-7.1 7.1z",
      "pf",
    ) +
    p("M2.8 12.3a1 1 0 0 1 0-1.4l3-3 6.4 6.4-2.5 2.5H7z", "of") +
    p("M11 18.5c2-1.5 4-1.5 6.5 0", "r thick"),
  pointEraser:
    p(
      "M7 16.5 2.8 12.3a1 1 0 0 1 0-1.4l7.4-7.4a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-7.1 7.1z",
      "pf",
    ) +
    p("M2.8 12.3a1 1 0 0 1 0-1.4l3-3 6.4 6.4-2.5 2.5H7z", "of") +
    ci(15.5, 17.5, 1.3, "rs"),
  addPen: nib(-1, 1) + badge(14.8, 14.8, "plus"),
  inkToText:
    p(
      "M3 9.5c1.5-4 3-5 3.6-3.6.6 1.5-1.6 5.3-.4 5.4 1 .1 2.2-3.4 3.2-3.3.8.1-.4 3 .5 3.1",
      "b thick",
    ) +
    p("M11.5 13.5h6", "o") +
    p("M12.5 16.5l2.2-6.5 2.3 6.5M13.2 14.8h3", "s thick") +
    p("M7.5 13.5l2 2-2 2", "k"),
  inkToShape:
    p(
      "M3 8c.5-3 2.6-4.6 5-4.3 2.6.3 3.4 3 2.6 5-1 2.3-4 2.7-6 1.7",
      "b thick",
    ) +
    r(10.5, 10.5, 7, 7, "kf", 1) +
    p("M5 12.5v3.5h3.5", "k"),
  inkToMath:
    p(
      "M3 4.5h6.5M4.6 4.5c0 3-.6 5.6-1.6 7M7.6 4.5c-.3 3 0 5.8 1.6 6.4",
      "b thick",
    ) +
    p("M11.5 11h6M13 11v6.5M16 11v6.5", "s thick") +
    p("M6 14.5l2 2-2 2", "k"),
  inkReplay:
    p(
      "M3 13c1.5-6 3.5-8.5 5-7.5s-1 7 .6 7.6c1.5.6 3.2-5 4.6-4.8 1.2.2.2 3.2 1.3 3.4",
      "b thick",
    ) + badge(14.5, 15, "play"),
  ruler: g(
    "rotate(-30 10 10)",
    r(1.5, 7, 17, 6, "yf", 1) +
      p("M4 7v2.5M6.5 7v1.5M9 7v2.5M11.5 7v1.5M14 7v2.5M16.5 7v1.5", "o"),
  ),
  drawWithTouch:
    p(
      "M8 10V4.5a1.3 1.3 0 0 1 2.6 0V10l3.8.8a1.8 1.8 0 0 1 1.4 2l-.6 4.7H9.4L6 13.4a1.2 1.2 0 0 1 1.7-1.7L8 12",
      "of",
    ) + p("M3 17.5c1.8-1.2 3-1.2 4.5 0", "b thick"),
  convertInk:
    p("M3 15c1-4 3-6 4.5-5", "b thick") +
    ci(13.5, 8, 4.5, "kf") +
    p("M7 4.5h3.5V8", "k"),
  pinItem:
    p("M7.5 2.5h5l-1 4.5 3 3v1.5h-9V10l3-3z", "bf") +
    p("M10 11.5v6", "o thick"),
  unpinItem:
    p("M7.5 2.5h5l-1 4.5 3 3v1.5h-9V10l3-3z", "of") +
    p("M10 11.5v6", "o thick") +
    p("M3.5 3.5l13 13", "r thick"),
  newSlidePrompt:
    r(2.5, 5, 13, 10, "of", 1.4) +
    p("M5 8.5h6M5 11h4", "o ln") +
    p("M16 2.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z", "ys") +
    badge(15, 15, "plus"),
});

const LUCIDE = {
  Pause,
  RotateCcw,
  Pin,
  PinOff,
  House,
  Clock,
  Users,
  FolderOpen,
  FilePlus,
  Sparkles,
  ArrowUp,
  Play,
};
/** A Lucide icon this module brought in, as an SVG element. */
export function lucide(name, size = 18) {
  return createElement(LUCIDE[name] || Sparkles, {
    width: size,
    height: size,
    "stroke-width": 1.7,
    "aria-hidden": "true",
    focusable: "false",
  });
}

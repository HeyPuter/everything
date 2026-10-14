// Icons for the Format pane's tabs, drawn for this project in the app's icon
// idiom (see src/chrome/icons.js): a 20-unit grid, outlines over soft fills,
// solid accent marks. They join the shared registry under "pane…" names, so
// `icon("o:paneFillLine")` finds them.
import { COMMAND_ICONS } from "../chrome/icons.js";

const p = (d, c = "o") => `<path class="${c}" d="${d}"/>`;
const r = (x, y, w, h, c = "o", rx = 1.6) =>
  `<rect class="${c}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`;
const ci = (cx, cy, rad, c = "o") =>
  `<circle class="${c}" cx="${cx}" cy="${cy}" r="${rad}"/>`;
// A letter A drawn as strokes, its feet on `base`.
const letterA = (x, base, h, c = "o thick") =>
  p(
    `M${x} ${base} ${x + h * 0.38} ${base - h}h.8L${x + h * 0.84} ${base}M${x + h * 0.16} ${base - h * 0.34}h${h * 0.52}`,
    c,
  );

const ICONS = {
  // A tipped pail pouring paint, over a stroke of line.
  paneFillLine:
    p(
      "M4 8.5 9.5 3l6 6-5.5 5.5a1.5 1.5 0 0 1-2.1 0L4 10.6a1.5 1.5 0 0 1 0-2.1z",
      "bf",
    ) +
    p("M4.2 9.5h11", "bs") +
    p("M16.5 10.5s1.5 2 1.5 3a1.5 1.5 0 0 1-3 0c0-1 1.5-3 1.5-3z", "bs") +
    p("M2.5 18h15", "o thick"),
  // A pentagon lifted off its shadow, with a glint.
  paneEffects:
    p("M10.5 5.2 16.8 9.6l-2.4 7.4H6.6L4.2 9.6z", "nf") +
    p("M9 3 15.3 7.4 12.9 14.8H5.1L2.7 7.4z", "bs glassy") +
    p("M6 6.8 9 4.7", "wh"),
  // A frame with arrows out to two of its edges.
  paneSize:
    r(3, 5.5, 10, 10, "bf", 1.4) +
    p("M15.5 5.5v10M14 7l1.5-1.5L17 7M14 14l1.5 1.5L17 14", "b thick") +
    p("M3 2.5h10M4.5 1 3 2.5 4.5 4M11.5 1 13 2.5 11.5 4", "o"),
  // A landscape in a frame.
  panePicture:
    r(2.5, 3.5, 15, 13, "of", 1.6) +
    p(
      "M2.5 14 7 9.5l3.5 3.5 2.5-2.5 4.5 4.5V15a1.5 1.5 0 0 1-1.5 1.5H4z",
      "gs",
    ) +
    ci(13, 7.5, 1.7, "ys"),
  // A capital T over lines of text.
  paneText:
    p("M3 4h9M7.5 4v9", "o thick") + p("M11 10h6.5M11 13h6.5M3 16.5h14.5", "b"),
  // A letter over a bar of colour: its fill and its outline.
  paneTextFill:
    letterA(4, 13.5, 11, "o thick") + r(2.5, 15.5, 15, 2.5, "bs", 0.8),
  // A letter with a glow and a spark.
  paneTextEffects:
    ci(9, 9.5, 7, "yw") +
    letterA(4.5, 14.5, 10, "o thick") +
    p("M16 1.5v4M14 3.5h4", "b thick"),
  // A text box: a frame with handles round lines of text.
  paneTextBox:
    r(3, 3.5, 14, 13, "o dash", 1) +
    p("M6 7.5h8M6 10.5h8M6 13.5h5", "b thick") +
    r(1.8, 2.3, 2.4, 2.4, "of", 0.4) +
    r(15.8, 15.3, 2.4, 2.4, "of", 0.4),
  // Bars on an axis.
  paneChart:
    p("M3 2.5v15h14.5", "o") +
    r(5, 10, 3, 7.5, "bs", 0.6) +
    r(9.5, 5.5, 3, 12, "gs", 0.6) +
    r(14, 8, 3, 9.5, "ys", 0.6),
  // A grid with a shaded header row.
  paneTable:
    r(2.5, 3.5, 15, 13, "of", 1.4) +
    r(2.5, 3.5, 15, 3.5, "bs", 1.4) +
    p("M2.5 10.5h15M2.5 13.5h15M7.5 7v9.5M12.5 7v9.5", "o"),
  // Three linked boxes.
  paneDiagram:
    r(7, 2.5, 6, 4.5, "bs", 1) +
    r(2.5, 13, 6, 4.5, "gf", 1) +
    r(11.5, 13, 6, 4.5, "gf", 1) +
    p("M10 7v3M5.5 13v-3h9v3", "o"),
  // A slide with a play mark: what the slide does.
  paneSlide:
    r(2.5, 4, 15, 10.5, "of", 1.4) +
    p("M8.5 6.8v5l4.2-2.5z", "rs") +
    p("M7 17.5h6", "o thick"),
  // A slide whose background is filled.
  paneBackground:
    r(2.5, 4, 15, 11, "bf", 1.4) +
    p("M2.5 12 7 8.5l4 3 3-2 3.5 2.5", "wh") +
    p("M6.5 18h7", "o thick"),
  // Rows of a list: the objects on a slide.
  paneObjects:
    r(2.5, 3, 4, 4, "bs", 0.8) +
    ci(4.5, 13.5, 2, "gs") +
    p("M9 5h8.5M9 13.5h8.5", "o thick"),
  // Arrows lining up to an edge: the arrangement of several objects.
  paneArrange:
    p("M3 2.5v15", "o thick") +
    r(5, 4.5, 11, 4, "bs", 1) +
    r(5, 11.5, 7, 4, "gf", 1),
};

for (const [name, body] of Object.entries(ICONS))
  if (!(name in COMMAND_ICONS)) COMMAND_ICONS[name] = body;

export const PANE_ICONS = Object.keys(ICONS);

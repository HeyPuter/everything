// Command icons for the Insert features, drawn for this project on the
// 20-unit grid of src/chrome/icons.js with its classes (o outline, of
// outline on paper, xs / xf solid and soft accent fills, wh white strokes).
import { registerCommandIcons } from "../chrome/icons.js";

const p = (d, c = "o") => `<path class="${c}" d="${d}"/>`;
const r = (x, y, w, h, c = "o", rx = 1.4) =>
  `<rect class="${c}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`;
const ci = (cx, cy, rad, c = "o") =>
  `<circle class="${c}" cx="${cx}" cy="${cy}" r="${rad}"/>`;
const slide = (x, y, w, h, c = "of") => r(x, y, w, h, c, 1.2);

registerCommandIcons({
  mediaPlay: ci(10, 10, 7.5, "bs") + p("M8 6.5v7l5.5-3.5z", "wh"),
  mediaPause: ci(10, 10, 7.5, "bs") + p("M8 6.5v7M12 6.5v7", "wh thick"),
  trim:
    r(2.5, 6.5, 15, 7, "bf", 1.2) +
    p("M6 4.5v11M14 4.5v11", "o thick") +
    p("M6 4.5h-1.5M6 15.5h-1.5M14 4.5h1.5M14 15.5h1.5", "o"),
  bookmark: p("M5.5 2.5h9v15l-4.5-3.5-4.5 3.5z", "bf"),
  bookmarkAdd:
    p("M4.5 2.5h8v14l-4-3-4 3z", "bf") +
    ci(14.5, 13.5, 3.4, "gs") +
    p("M14.5 11.8v3.4M12.8 13.5h3.4", "wh thick"),
  bookmarkRemove:
    p("M4.5 2.5h8v14l-4-3-4 3z", "bf") +
    ci(14.5, 13.5, 3.4, "rs") +
    p("M12.8 13.5h3.4", "wh thick"),
  posterFrame:
    r(2.5, 4, 15, 12, "of", 1.6) +
    p("M2.5 13l4.5-4.5 3.5 3.5 2.5-2.5 5 5", "g") +
    ci(13.5, 7.5, 1.5, "ys"),
  zoomSummary:
    slide(2.5, 3, 15, 14) +
    slide(4.5, 6, 5, 3.6, "kf") +
    slide(10.5, 6, 5, 3.6, "kf") +
    slide(4.5, 11, 5, 3.6, "kf") +
    slide(10.5, 11, 5, 3.6, "kf"),
  zoomSection:
    slide(2.5, 3.5, 9.5, 7, "of") +
    slide(8, 9.5, 9.5, 7, "kf") +
    p("M5 6h4.5", "k thick"),
  actionButtons: r(2.5, 4, 15, 12, "bs", 2.2) + p("M8.5 7v6l5-3z", "wh"),
  volume:
    p("M3.5 7.5h2.5l4-3.5v12l-4-3.5H3.5z", "bs") +
    p("M13 7.5a3.5 3.5 0 0 1 0 5M15.2 5.3a6.6 6.6 0 0 1 0 9.4", "b thick"),
  mute:
    p("M3.5 7.5h2.5l4-3.5v12l-4-3.5H3.5z", "bs") +
    p("M12.5 7.5l5 5M17.5 7.5l-5 5", "r thick"),
  recordAudio:
    r(7, 2.5, 6, 9.5, "rs", 3) +
    p("M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5", "o"),
});

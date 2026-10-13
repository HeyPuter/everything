// A chart drawn on its own, as an image: the chart is placed on a scratch
// slide that takes the deck's theme colours and fonts, and rendered by the
// same renderer as the slides, so previews match what will be inserted.
import { P, createDeck, preview } from "../model.js";

const THEME_SLOTS = [
  "dark1",
  "light1",
  "dark2",
  "light2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
];
const cache = new Map();
const MAX_CACHE = 60;

// `theme` is the deck's (P.getPresentationTheme), `aspect` the width over
// the height of the image. Returns an image URL, or null when the chart can
// not be drawn.
export function chartImage(
  spec,
  { theme = null, aspect = 16 / 9, width = 9144000 } = {},
) {
  const key = JSON.stringify([spec, theme, aspect, width]);
  if (cache.has(key)) return cache.get(key);
  let url = null;
  try {
    const pres = createDeck("blank");
    const height = Math.round(width / aspect);
    P.setSlideSize(pres, { width, height });
    const slide = P.getSlides(pres)[0];
    for (const shape of [...P.getSlideShapes(slide)]) P.removeShape(shape);
    P.setSlideBackground(slide, "#FFFFFF");
    if (theme) {
      const colors = {};
      for (const slot of THEME_SLOTS)
        if (
          typeof theme[slot] === "string" &&
          /^#?[0-9a-f]{6}$/i.test(theme[slot])
        )
          colors[slot] = theme[slot].startsWith("#")
            ? theme[slot]
            : `#${theme[slot]}`;
      try {
        P.setPresentationTheme(pres, colors);
      } catch {}
    }
    P.addSlideChart(slide, { spec, x: 0, y: 0, w: width, h: height });
    url = preview(pres, slide);
  } catch {
    url = null;
  }
  cache.set(key, url);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  return url;
}

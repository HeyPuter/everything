// Theme greys for canvas-drawn editors: the same ramps the style sheets use (--g-XX for
// surfaces, --t-XX for text), so a theme restyles canvases too. Defaults are the plain greys.
const surface = new Map<number, string>();
const text = new Map<number, string>();
const hex = (l: number) => {
  const x = Math.max(0, Math.min(255, Math.round(l))).toString(16).padStart(2, '0');
  return `#${x}${x}${x}`;
};

/** Background / line grey of the default theme at `level` (0–255), mapped through the active theme. */
export function canvasGrey(level: number): string {
  return surface.get(level) ?? hex(level);
}

/** Text grey of the default theme at `level`, mapped through the active theme. */
export function canvasTextGrey(level: number): string {
  return text.get(level) ?? hex(level);
}

/** Set by Preferences ▸ Themes whenever a theme is applied. */
export function setCanvasGreys(s: Map<number, string>, t: Map<number, string>) {
  surface.clear();
  text.clear();
  for (const [k, v] of s) surface.set(k, v);
  for (const [k, v] of t) text.set(k, v);
}

// Theme greys for canvas-drawn editors: the same ramps the style sheets use (--g-XX for
// surfaces, --t-XX for text), so a theme restyles canvases too. Without a theme the default palette's greys are used.
const surface = new Map<number, string>();
const text = new Map<number, string>();
const c8 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
/** The default palette's grey for a style-sheet grey level: a touch further from mid-grey, with a
 *  faint cool tint (black and white stay pure). Used until a theme provides its own ramps. */
export function paletteGrey(level: number): string {
  if (level <= 1 || level >= 254) return `#${c8(level)}${c8(level)}${c8(level)}`;
  const l = level < 128 ? level - (128 - level) / 40 : level + (level - 128) / 40;
  if (l < 4 || l > 251) return `#${c8(l)}${c8(l)}${c8(l)}`;
  return `#${c8(l - 1)}${c8(l)}${c8(l + 1.6)}`;
}
const hex = paletteGrey;

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

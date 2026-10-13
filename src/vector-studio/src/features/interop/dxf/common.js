/**
 * DXF shared pieces: the color index (ACI) palette, drawing units and
 * lineweights.
 */

/** ACI index -> '#rrggbb' (7 is black/white; drawn black on light artboards). */
export function aciColor(i) {
  const fixed = { 1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff', 7: '#000000', 8: '#808080', 9: '#c0c0c0', 250: '#333333', 251: '#505050', 252: '#696969', 253: '#828282', 254: '#bebebe', 255: '#ffffff' };
  if (fixed[i]) return fixed[i];
  if (i < 10 || i > 249) return '#000000';
  const hue = Math.floor((i - 10) / 10) * 15;
  const v = [1, 0.8, 0.6, 0.5, 0.3][Math.floor((i % 10) / 2)];
  const s = i % 2 ? 0.5 : 1;
  const c = v * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  const h = (t) => Math.round((t + m) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

let ACI = null;
/** Nearest ACI index (1-255) for a color. */
export function nearestAci(hex) {
  if (!ACI) ACI = Array.from({ length: 256 }, (_, i) => (i ? aciColor(i) : null));
  const n = parseInt(String(hex || '#000000').slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  let best = 7;
  let bd = Infinity;
  for (let i = 1; i < 256; i++) {
    const m = parseInt(ACI[i].slice(1), 16);
    const d = (r - ((m >> 16) & 255)) ** 2 + (g - ((m >> 8) & 255)) ** 2 + (b - (m & 255)) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  // Black and white both map to 7 (it shows black on light, white on dark backgrounds).
  if (best === 255 || (r < 16 && g < 16 && b < 16)) return 7;
  return best;
}

/** $INSUNITS code -> points per unit (0 when unitless). */
export const UNITS = {
  0: { label: 'Unitless', pt: 0 },
  1: { label: 'Inches', pt: 72 },
  2: { label: 'Feet', pt: 864 },
  4: { label: 'Millimeters', pt: 72 / 25.4 },
  5: { label: 'Centimeters', pt: 72 / 2.54 },
  6: { label: 'Meters', pt: 72 / 0.0254 },
  8: { label: 'Microinches', pt: 72e-6 },
  9: { label: 'Mils', pt: 0.072 },
  10: { label: 'Yards', pt: 2592 },
};

/** Units offered in the import and export dialogs: key -> points per unit. */
export const UNIT_CHOICES = [
  { value: 'mm', label: 'Millimeters', pt: 72 / 25.4, code: 4 },
  { value: 'cm', label: 'Centimeters', pt: 72 / 2.54, code: 5 },
  { value: 'm', label: 'Meters', pt: 72 / 0.0254, code: 6 },
  { value: 'in', label: 'Inches', pt: 72, code: 1 },
  { value: 'ft', label: 'Feet', pt: 864, code: 2 },
  { value: 'pt', label: 'Points', pt: 1, code: 0 },
  { value: 'px', label: 'Pixels', pt: 0.75, code: 0 },
];

export const LINEWEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

/** Nearest standard lineweight (hundredths of a millimeter) for a width in points. */
export function nearestLineweight(pt) {
  const mm100 = (pt * 25.4 * 100) / 72;
  let best = LINEWEIGHTS[0];
  for (const w of LINEWEIGHTS) if (Math.abs(w - mm100) < Math.abs(best - mm100)) best = w;
  return best;
}

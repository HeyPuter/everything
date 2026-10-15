// Pure colour helpers for themes (no DOM): hex parsing / formatting and the grey ramps that
// map the style sheets' hard-coded greys through a theme's key colours.

export function parseHex(v: string): [number, number, number, number] {
  let h = v.trim().replace(/^#/, '');
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return [0, 0, 0, 1];
  return [n(0) / 255, n(2) / 255, n(4) / 255, h.length === 8 ? n(6) / 255 : 1];
}

export function toHex(r: number, g: number, b: number, a = 1): string {
  const c = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}${a < 1 ? c(a) : ''}`;
}

export const cssColor = (v: string) => {
  const [r, g, b, a] = parseHex(v);
  return a < 1 ? `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${Math.round(a * 1000) / 1000})` : toHex(r, g, b);
};

export const lerp = (a: number[], b: number[], t: number) => a.map((x, i) => x + (b[i] - x) * t);

export const SURFACE_REFS: [number, string][] = [
  [0x16, 'border'],
  [0x18, 'topbar'],
  [0x1d, 'field'],
  [0x28, 'outliner'],
  [0x30, 'region'],
  [0x3d, 'panel'],
  [0x54, 'button'],
  [0x65, 'button_hover'],
  // light greys of the style sheets are foreground (icon / text) shades
  [0xe6, 'text'],
  [0xff, 'text_hi'],
];
export const TEXT_REFS: [number, string][] = [
  [0x30, 'region'],
  [0x99, 'text_dim'],
  [0xe6, 'text'],
  [0xff, 'text_hi'],
];

/** Map a grey level of the default style sheets through a theme's key colours. */
export function ramp(level: number, refs: [number, string][], get: (id: string) => string): string {
  const col = (id: string) => parseHex(get(id)).slice(0, 3);
  if (level <= refs[0][0]) return toHex(...(col(refs[0][1]).map((x) => (x * level) / refs[0][0]) as [number, number, number]));
  for (let i = 1; i < refs.length; i++) {
    const [l0, a] = refs[i - 1];
    const [l1, b] = refs[i];
    if (level <= l1) return toHex(...(lerp(col(a), col(b), (level - l0) / (l1 - l0)) as [number, number, number]));
  }
  return toHex(...(col(refs[refs.length - 1][1]) as [number, number, number]));
}


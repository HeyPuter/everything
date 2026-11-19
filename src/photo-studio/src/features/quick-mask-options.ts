// Quick Mask Options: whether the colored film marks the masked (unselected)
// or the selected areas, and its color and opacity. Opened by double-clicking
// the Quick Mask button or from Select → Quick Mask Options. Kept for this
// browser like other workspace choices.
//
// The quick mask channel stores what the film shows as dark paint: with
// "Masked Areas" its values are the selection, with "Selected Areas" their
// inverse. Painting black always adds film, whichever it means.

export type QuickMaskIndicates = 'masked' | 'selected';
export type QuickMaskOptions = { indicates: QuickMaskIndicates; color: string; opacity: number };
export const DEFAULT_QUICK_MASK: QuickMaskOptions = {
  indicates: 'masked',
  color: '#ff0000',
  opacity: 0.5,
};
const KEY = 'photo-studio-quick-mask';

export function sanitizeQuickMaskOptions(v: unknown): QuickMaskOptions {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<QuickMaskOptions>;
  const opacity = Number(o.opacity);
  return {
    indicates: o.indicates === 'selected' ? 'selected' : 'masked',
    color:
      typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color)
        ? o.color.toLowerCase()
        : DEFAULT_QUICK_MASK.color,
    opacity: Number.isFinite(opacity)
      ? Math.max(0, Math.min(1, opacity))
      : DEFAULT_QUICK_MASK.opacity,
  };
}

let current: QuickMaskOptions = (() => {
  try {
    return sanitizeQuickMaskOptions(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return { ...DEFAULT_QUICK_MASK };
  }
})();
export const quickMaskOptions = (): QuickMaskOptions => ({ ...current });
export function setQuickMaskOptions(o: QuickMaskOptions) {
  current = sanitizeQuickMaskOptions(o);
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* Optional. */
  }
}

/** Channel values from selection coverage (and back: the mapping is its own inverse). */
export function channelFromSelection(data: Uint8Array, indicates: QuickMaskIndicates): Uint8Array {
  if (indicates === 'masked') return data;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = 255 - data[i];
  return out;
}

/** Film color as RGB and the alpha for a channel value. */
export function filmColor(o: QuickMaskOptions): [number, number, number] {
  const n = parseInt(o.color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const filmAlpha = (value: number, o: QuickMaskOptions) =>
  Math.round((255 - value) * o.opacity);

/** A short description for tooltips and the status message. */
export function quickMaskHint(o: QuickMaskOptions) {
  return o.indicates === 'masked'
    ? 'Quick Mask: paint with black to remove from the selection, white to add. Press Q to exit.'
    : 'Quick Mask: paint with black to add to the selection, white to remove. Press Q to exit.';
}

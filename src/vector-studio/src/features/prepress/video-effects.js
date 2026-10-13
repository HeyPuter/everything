/**
 * Effect > Video: NTSC Colors and De-Interlace, live raster effects that
 * run in document space at the document's raster effects resolution (the
 * pixel pipeline of features/pxfx).
 *
 *   ntscColors   { }  pulls colors into the range an analog composite video
 *                     signal carries: luminance stays at or below white and
 *                     luminance plus/minus chroma within the signal limits
 *   deinterlace  { eliminate: 'odd'|'even', create: 'duplication'|'interpolation' }
 *                     replaces every other line (of the document raster grid)
 */
import { registerEffectType, EFFECTS } from '../paint/effects-model.js';
import { registerContentEffect } from '../../render/effects.js';
import { pixelEffect } from '../pxfx/core.js';
import { cloneImg } from '../pxfx/img.js';
import { addEffectNow, openEffectDialog, choiceField } from '../effects/dialog-kit.js';

/** Composite signal limits, relative to white = 1. */
export const NTSC_LIMITS = Object.freeze({ high: 1.1, low: -0.15, white: 1 });

/** One color (0..1 channels) made broadcast safe. Returns [r, g, b]. */
export function ntscSafe(r, g, b, limits = NTSC_LIMITS) {
  let y = 0.299 * r + 0.587 * g + 0.114 * b;
  let i = 0.596 * r - 0.274 * g - 0.322 * b;
  let q = 0.211 * r - 0.523 * g + 0.312 * b;
  if (y > limits.white) y = limits.white;
  const c = Math.hypot(i, q);
  const max = Math.max(0, Math.min(limits.high - y, y - limits.low));
  if (c > max && c > 0) {
    const s = max / c;
    i *= s;
    q *= s;
  }
  const cl = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  return [cl(y + 0.956 * i + 0.621 * q), cl(y - 0.272 * i - 0.647 * q), cl(y - 1.106 * i + 1.703 * q)];
}

export function ntscImage(img) {
  const out = cloneImg(img);
  for (let p = 0; p < img.r.length; p++) {
    if (img.a[p] <= 0) continue;
    const [r, g, b] = ntscSafe(img.r[p], img.g[p], img.b[p]);
    out.r[p] = r;
    out.g[p] = g;
    out.b[p] = b;
  }
  return out;
}

/** Replace the odd or even lines; `oy` is the image's first row on the document grid (keeps lines put while objects move). */
export function deinterlaceImage(img, { eliminate = 'odd', create = 'interpolation' } = {}, oy = 0) {
  const out = cloneImg(img);
  const { w, h } = img;
  const drop = eliminate === 'even' ? 0 : 1;
  for (let y = 0; y < h; y++) {
    if ((((y + oy) % 2) + 2) % 2 !== drop) continue;
    const up = y - 1 >= 0 ? y - 1 : y + 1 < h ? y + 1 : -1;
    const down = y + 1 < h ? y + 1 : up;
    if (up < 0) continue;
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const a = up * w + x;
      const b = down * w + x;
      for (const ch of ['r', 'g', 'b', 'a']) out[ch][p] = create === 'duplication' ? img[ch][a] : (img[ch][a] + img[ch][b]) / 2;
    }
  }
  return out;
}

registerEffectType('ntscColors', {
  label: 'NTSC Colors',
  command: 'effect.video.ntsc',
  defaults: {},
});

registerEffectType('deinterlace', {
  label: 'De-Interlace',
  command: 'effect.video.deinterlace',
  defaults: { eliminate: 'odd', create: 'interpolation' },
  enums: { eliminate: ['odd', 'even'], create: ['duplication', 'interpolation'] },
  describe: (e) => `De-Interlace (${e.eliminate === 'even' ? 'even' : 'odd'} lines)`,
});

registerContentEffect('ntscColors', pixelEffect({ key: () => 'ntsc', process: (img) => ntscImage(img) }));
registerContentEffect('deinterlace', pixelEffect({ key: (e) => `di:${e.eliminate}:${e.create}`, process: (img, e, ctx) => deinterlaceImage(img, e, ctx.oy || 0) }), { margin: () => 2 });

/** NTSC Colors has no options: the command (and Apply Last Effect) adds it directly. */
EFFECTS.ntscColors.openDialog = (app, { edit } = {}) => {
  if (edit) {
    app.notify('NTSC Colors has no options.', { polite: true });
    return false;
  }
  return addEffectNow(app, 'ntscColors');
};

EFFECTS.deinterlace.openDialog = (app, { params, edit } = {}) =>
  openEffectDialog(app, 'deinterlace', {
    params,
    edit,
    build: (ctx) => {
      const eliminate = choiceField({ label: 'Eliminate', value: ctx.start.eliminate, options: [{ value: 'odd', label: 'Odd lines' }, { value: 'even', label: 'Even lines' }], onChange: ctx.changed });
      const create = choiceField({ label: 'Create new lines by', value: ctx.start.create, options: [{ value: 'duplication', label: 'Duplication' }, { value: 'interpolation', label: 'Interpolation' }], onChange: ctx.changed });
      return { body: [eliminate.el, create.el], read: () => ({ eliminate: eliminate.get(), create: create.get() }) };
    },
  });

export function videoEffectCommands() {
  const hasSel = (a) => Boolean(a.editor && a.editor.selection.size);
  return [
    { id: 'effect.video.deinterlace', label: 'De-Interlace...', enabled: hasSel, run: (a) => EFFECTS.deinterlace.openDialog(a) },
    { id: 'effect.video.ntsc', label: 'NTSC Colors', enabled: hasSel, run: (a) => EFFECTS.ntscColors.openDialog(a) },
  ];
}

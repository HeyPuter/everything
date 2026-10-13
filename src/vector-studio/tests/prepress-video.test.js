import { describe, it, expect } from 'vitest';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { bootAppWithFeatures } from './helpers.js';
import { ntscSafe, ntscImage, deinterlaceImage, NTSC_LIMITS } from '../src/features/prepress/video-effects.js';
import { createImg } from '../src/features/pxfx/img.js';
import { RASTER_EFFECTS } from '../src/render/effects.js';
import { effectLabel } from '../src/features/paint/effects-model.js';
import { MENUS } from '../src/ui/menus.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const yiq = ([r, g, b]) => {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const i = 0.596 * r - 0.274 * g - 0.322 * b;
  const q = 0.211 * r - 0.523 * g + 0.312 * b;
  return { y, c: Math.hypot(i, q) };
};

describe('NTSC Colors', () => {
  it('keeps the composite signal within its limits', () => {
    for (const rgb of [[1, 1, 0], [0, 1, 1], [1, 0, 1], [0, 0, 1], [1, 0, 0], [0.2, 0.9, 0.1]]) {
      const out = ntscSafe(...rgb);
      const { y, c } = yiq(out);
      expect(y + c).toBeLessThanOrEqual(NTSC_LIMITS.high + 0.02);
      expect(y - c).toBeGreaterThanOrEqual(NTSC_LIMITS.low - 0.02);
    }
    // Yellow is too hot for broadcast: it loses saturation, keeping its hue and brightness.
    const yellow = ntscSafe(1, 1, 0);
    expect(yellow[2]).toBeGreaterThan(0.2);
    expect(yiq(yellow).y).toBeCloseTo(yiq([1, 1, 0]).y, 1);
  });

  it('leaves safe colors and grays alone', () => {
    for (const rgb of [[0.5, 0.5, 0.5], [0.4, 0.3, 0.25], [1, 1, 1], [0, 0, 0]]) {
      const out = ntscSafe(...rgb);
      for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(rgb[i], 3);
    }
  });

  it('processes images, skipping transparent pixels', () => {
    const img = createImg(2, 1);
    img.r.set([1, 1]);
    img.g.set([1, 1]);
    img.a.set([1, 0]);
    const out = ntscImage(img);
    expect(out.b[0]).toBeGreaterThan(0.2);
    expect(out.b[1]).toBe(0);
  });
});

describe('De-Interlace', () => {
  const stripes = () => {
    const img = createImg(1, 4);
    img.r.set([0, 1, 0, 1]);
    img.a.fill(1);
    return img;
  };

  it('replaces odd lines by duplication or interpolation', () => {
    expect([...deinterlaceImage(stripes(), { eliminate: 'odd', create: 'duplication' }).r]).toEqual([0, 0, 0, 0]);
    expect([...deinterlaceImage(stripes(), { eliminate: 'even', create: 'duplication' }).r]).toEqual([1, 1, 1, 1]);
    expect([...deinterlaceImage(stripes(), { eliminate: 'odd', create: 'interpolation' }).r]).toEqual([0, 0, 0, 0]);
  });

  it('keeps lines on the document grid', () => {
    // Starting one row further down swaps which rows are odd.
    expect([...deinterlaceImage(stripes(), { eliminate: 'odd', create: 'duplication' }, 1).r]).toEqual([1, 1, 1, 1]);
  });
});

describe('Effect > Video', () => {
  it('applies the effects from the menu', async () => {
    const app = await bootAppWithFeatures();
    const ed = app.newDocument();
    const doc = ed.doc;
    const p = createPath(rectangle(0, 0, 10, 10), true, {});
    doc.transact('Add', () => doc.insert(p, ed.targetLayer().id));
    ed.select([p.id]);
    const effect = MENUS.find((m) => m.label === 'Effect').submenu.find((i) => i.label === 'Video');
    expect(effect.submenu).toEqual(['effect.video.deinterlace', 'effect.video.ntsc']);
    expect(RASTER_EFFECTS.has('ntscColors')).toBe(true);
    await app.commands.run('effect.video.ntsc');
    expect(doc.get(p.id).effects.map((e) => e.type)).toEqual(['ntscColors']);
    const run = app.commands.run('effect.video.deinterlace');
    await tick();
    const dlg = document.querySelector('dialog[open]');
    dlg.querySelector('input[value="even"]').click();
    [...dlg.querySelectorAll('.dialog-footer button')].find((b) => b.textContent === 'OK').click();
    await run;
    const fx = doc.get(p.id).effects;
    expect(fx[1]).toMatchObject({ type: 'deinterlace', eliminate: 'even', create: 'interpolation' });
    expect(effectLabel(fx[1])).toBe('De-Interlace (even lines)');
    // Apply Last Effect repeats it.
    expect(app.commands.label('effect.applyLast')).toBe('Apply De-Interlace (even lines)');
  });
});

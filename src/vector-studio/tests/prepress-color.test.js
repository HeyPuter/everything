import { describe, it, expect } from 'vitest';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { bootAppWithFeatures } from './helpers.js';
import {
  separate, simulate, proofCmyk, convertRgb, platesFor, separatePixel, compensateGain, dotGain, normalizeColorSettings,
  presetSettings, documentCmykProfile, documentRgbSpace, CMYK_PROFILES, DEFAULT_COLOR_SETTINGS, buildLut,
} from '../src/features/prepress/color-management.js';
import { fitColorTransform, rgbProofBody, cmykProofBody, proofBody } from '../src/features/prepress/proof.js';
import { proofFilterMarkup, PROOFS } from '../src/features/workspace/view.js';
import { quantizeCmyk } from '../src/features/panels/edit-commands.js';
import { MENUS } from '../src/ui/menus.js';
import { applyOpenPolicy, mismatchAction } from '../src/features/prepress/color-policies.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const dlg = () => document.querySelector('dialog[open]');
const button = (label) => [...dlg().querySelectorAll('.dialog-footer button')].find((b) => b.textContent === label);

async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const doc = ed.doc;
  const add = (style) => {
    const p = createPath(rectangle(0, 0, 10, 10), true, style);
    doc.transact('Add', () => doc.insert(p, ed.targetLayer().id));
    return p.id;
  };
  return { app, ed, doc, add };
}

const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

describe('press models', () => {
  it('separates neutrals gray-balanced and prints them back neutral', () => {
    for (const id of Object.keys(CMYK_PROFILES)) {
      const out = proofCmyk([0.5, 0.5, 0.5], id);
      expect(Math.max(...out) - Math.min(...out)).toBeLessThan(0.02);
      expect(near(proofCmyk([1, 1, 1], id), [1, 1, 1], 0.01)).toBe(true);
      expect(near(proofCmyk([0, 0, 0], id), [0, 0, 0], 0.02)).toBe(true);
    }
  });

  it('keeps the total ink and black limits', () => {
    for (const [id, p] of Object.entries(CMYK_PROFILES)) {
      for (const rgb of [[0, 0, 0], [0.1, 0.05, 0.2], [0.2, 0, 0], [0, 0, 0.3]]) {
        const c = separate(rgb, id);
        expect(c.c + c.m + c.y + c.k).toBeLessThanOrEqual(p.til + 0.5);
        expect(c.k).toBeLessThanOrEqual(p.kmax * 100 + 0.01);
      }
    }
    const black = separate([0, 0, 0], 'coatedWeb');
    expect(black.k).toBeCloseTo(95, 0);
    expect(black.c).toBeGreaterThan(50);
  });

  it('round-trips in-gamut colors and clips the rest', () => {
    const inGamut = [0.55, 0.45, 0.35];
    expect(near(proofCmyk(inGamut, 'coatedWeb'), inGamut, 0.02)).toBe(true);
    // Screen blue is outside every press gamut.
    const blue = proofCmyk([0, 0, 1], 'coatedWeb');
    expect(blue[2]).toBeLessThan(0.9);
  });

  it('is exact for the ideal-ink model', () => {
    const c = separate([0.2, 0.5, 0.8], 'basic');
    expect(near([c.c, c.m, c.y, c.k], [75, 37.5, 0, 20], 0.5)).toBe(true);
    expect(near(simulate(c, 'basic'), [0.2, 0.5, 0.8], 0.005)).toBe(true);
  });

  it('compensates dot gain', () => {
    for (const g of [0.1, 0.2, 0.3]) for (const a of [0.1, 0.5, 0.9]) expect(dotGain(compensateGain(a, g), g)).toBeCloseTo(a, 5);
  });

  it('reads plates from the lookup table close to the exact separation', () => {
    const out = new Float32Array(4);
    for (const [r, g, b] of [[200, 30, 90], [12, 200, 180], [128, 128, 128], [250, 250, 5]]) {
      separatePixel('coatedWeb', r, g, b, out);
      const exact = platesFor([r / 255, g / 255, b / 255], 'coatedWeb');
      for (let i = 0; i < 4; i++) expect(Math.abs(out[i] - exact[i])).toBeLessThan(0.05);
    }
  });

  it('builds GPU lookup tables red-fastest', () => {
    const lut = buildLut(null, 3, (rgb) => rgb);
    expect(lut.data.length).toBe(27 * 4);
    expect([...lut.data.slice(4, 8)]).toEqual([128, 0, 0, 255]);
    expect([...lut.data.slice(3 * 4, 3 * 4 + 4)]).toEqual([0, 128, 0, 255]);
  });
});

describe('RGB spaces and proof filters', () => {
  it('converts between RGB spaces', () => {
    expect(near(convertRgb([0.3, 0.6, 0.9], 'srgb', 'srgb'), [0.3, 0.6, 0.9], 1e-9)).toBe(true);
    // Gamma 1.8 numbers look lighter on an sRGB display.
    expect(convertRgb([0.5, 0.5, 0.5], 'mac18', 'srgb')[0]).toBeGreaterThan(0.55);
    // P3 red is outside sRGB: it clips.
    expect(convertRgb([1, 0, 0], 'p3', 'srgb')[0]).toBeCloseTo(1, 6);
  });

  it('fits a filter to a press simulation', () => {
    const fn = (rgb) => proofCmyk(rgb, 'coatedWeb');
    const fit = fitColorTransform(fn);
    let err = 0;
    let n = 0;
    for (let i = 0; i < 200; i++) {
      const x = [((i * 37) % 101) / 100, ((i * 53) % 101) / 100, ((i * 71) % 101) / 100];
      const a = fn(x);
      const b = fit.apply(x);
      for (let c = 0; c < 3; c++) err += Math.abs(a[c] - b[c]);
      n += 3;
    }
    expect(err / n).toBeLessThan(0.06);
    expect(cmykProofBody('coatedWeb', {})).toContain('feComponentTransfer');
  });

  it('builds exact filters for RGB device proofs', () => {
    expect(rgbProofBody('srgb')).toContain('identity');
    const mac = rgbProofBody('mac18');
    expect(mac).toContain('tableValues');
    expect(mac).toContain('feColorMatrix');
  });

  it('adds the device proofs and Customize to Proof Setup', async () => {
    const { app, ed } = await setup();
    const proof = MENUS.find((m) => m.label === 'View').submenu.find((i) => i.label === 'Proof Setup').submenu;
    for (const id of ['view.proof.mac18', 'view.proof.srgb', 'view.proof.monitor', 'view.proof.customize']) {
      expect(proof).toContain(id);
      expect(app.commands.get(id)).toBeTruthy();
    }
    expect(app.commands.label('view.proof.cmyk')).toMatch(/^Document CMYK: Coated Web Press/);
    await app.commands.run('view.proof.mac18');
    expect(ed.viewOptions.proof).toBe('mac18');
    expect(ed.viewOptions.proofColors).toBe(true);
    expect(document.querySelector('#vs-proof-mac18 feComponentTransfer')).toBeTruthy();
    for (const k of Object.keys(PROOFS)) expect(proofFilterMarkup(`t-${k}`, k)).toContain(`id="t-${k}"`);
    expect(proofBody(app, 'cmyk')).toContain('feColorMatrix');
  });

  it('customizes the proof condition', async () => {
    const { app, ed } = await setup();
    const run = app.commands.run('view.proof.customize');
    await tick();
    const sel = dlg().querySelector('select');
    sel.value = 'cmyk:newsprint';
    sel.dispatchEvent(new Event('change'));
    const paper = [...dlg().querySelectorAll('label')].find((l) => l.textContent === 'Simulate paper color');
    const box = dlg().querySelector(`#${paper.getAttribute('for')}`);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    button('OK').click();
    await run;
    expect(app.prefs.get('proofCustom')).toMatchObject({ device: 'cmyk:newsprint', paper: true, black: true });
    expect(ed.viewOptions.proof).toBe('custom');
    expect(app.commands.isChecked('view.proof.customize')).toBe(true);
    // Paper simulation shows the newsprint tint in place of white.
    const white = proofCmyk([1, 1, 1], 'newsprint', { paper: true, black: true });
    expect(white[2]).toBeLessThan(0.9);
  });
});

describe('Color Settings', () => {
  it('normalizes settings and recognizes presets', () => {
    expect(normalizeColorSettings({}).preset).toBe('general');
    expect(normalizeColorSettings({ cmyk: 'newsprint' }).preset).toBe('custom');
    expect(normalizeColorSettings(presetSettings('news')).preset).toBe('news');
    expect(normalizeColorSettings({ cmyk: 'nope', intent: 'x' })).toMatchObject({ cmyk: DEFAULT_COLOR_SETTINGS.cmyk, intent: 'relative' });
  });

  it('edits and saves the color settings', async () => {
    const { app, doc } = await setup();
    expect(MENUS.find((m) => m.label === 'Edit').submenu).toEqual(expect.arrayContaining(['edit.colorSettings', 'edit.assignProfile']));
    expect(app.commands.get('edit.colorSettings').shortcut).toBe('Shift+Mod+K');
    const run = app.commands.run('edit.colorSettings');
    await tick();
    expect(dlg().querySelector('.dialog-title').textContent).toBe('Color Settings');
    const [preset] = dlg().querySelectorAll('select');
    preset.value = 'prepress';
    preset.dispatchEvent(new Event('change'));
    button('OK').click();
    await run;
    expect(app.prefs.get('colorSettings')).toMatchObject({ preset: 'prepress', cmyk: 'coatedSheet', askOpen: true });
    expect(documentCmykProfile(app, doc)).toBe('coatedSheet');
  });

  it('assigns a document profile (undoable)', async () => {
    const { app, doc } = await setup();
    const run = app.commands.run('edit.assignProfile');
    await tick();
    const radios = dlg().querySelectorAll('input[type="radio"]');
    expect(radios.length).toBe(3);
    const sel = dlg().querySelector('select');
    sel.value = 'p3';
    sel.dispatchEvent(new Event('change'));
    button('OK').click();
    await run;
    expect(doc.root.colorProfile).toBe('p3');
    expect(documentRgbSpace(app, doc)).toBe('p3');
    doc.undo();
    expect(doc.root.colorProfile).toBeUndefined();
  });

  it('converts to CMYK with the document press model', async () => {
    const { app, ed, doc, add } = await setup();
    doc.transact('Profile', () => doc.updateRoot({ colorMode: 'CMYK', colorProfile: 'newsprint' }));
    const id = add({ fill: { type: 'solid', color: '#000000' } });
    ed.select([id]);
    await app.commands.run('color.toCMYK');
    const fill = doc.get(id).fill;
    // Black separates to the press's rich black (black ink near its 90% limit).
    expect(fill.cmyk.k).toBeGreaterThanOrEqual(84);
    expect(fill.cmyk.k).toBeLessThanOrEqual(90);
    expect(fill.cmyk.c + fill.cmyk.m + fill.cmyk.y + fill.cmyk.k).toBeLessThanOrEqual(241);
    expect(quantizeCmyk('#000000').cmyk).toEqual(fill.cmyk);
  });
});

describe('color management policies', () => {
  it('maps policies to actions', () => {
    expect(['off', 'preserve', 'convert', 'preserveNumbers'].map(mismatchAction)).toEqual(['discard', 'keep', 'convert', 'discard']);
  });

  it('converts a mismatched document to the working space as it opens', async () => {
    const { app, ed, doc, add } = await setup();
    app.prefs.set('colorSettings', { policyRgb: 'convert' });
    const id = add({ fill: { type: 'solid', color: '#808080' } });
    doc.transact('Profile', () => doc.updateRoot({ colorProfile: 'mac18' }));
    expect(await applyOpenPolicy(app, ed)).toBe('convert');
    expect(doc.root.colorProfile).toBeUndefined();
    // Gamma 1.8 gray converts to a lighter sRGB gray.
    expect(parseInt(doc.get(id).fill.color.slice(1, 3), 16)).toBeGreaterThan(0x90);
  });

  it('asks when told to, and applies on open', async () => {
    const { app, doc } = await setup();
    app.prefs.set('colorSettings', { askOpen: true });
    doc.transact('Profile', () => doc.updateRoot({ colorProfile: 'p3' }));
    const ed2 = app.addDocument(doc, { file: { name: 'opened.vstudio' } });
    await tick();
    await tick();
    expect(dlg().querySelector('.dialog-title').textContent).toBe('Profile Mismatch');
    dlg().querySelector('input[value="discard"]').click();
    button('OK').click();
    await tick();
    expect(ed2.doc.root.colorProfile).toBeUndefined();
  });
});

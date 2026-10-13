import { describe, it, expect } from 'vitest';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { VDocument } from '../src/model/document.js';
import { bootAppWithFeatures } from './helpers.js';
import { writeProfile, sampleClut, identityCurve } from '../src/features/icc/write.js';
import { rgbToPcsMatrix, srgbToPcs, pcsToSrgb, xyzToLab, labToXyz } from '../src/features/icc/math.js';
import { profileEntry, unregisterProfile, listProfiles } from '../src/features/icc/profiles.js';
import { docRgbProfile, docCmykProfile, inkView, rgbToCmyk } from '../src/features/icc/cms.js';
import { documentProfileBytes, registerDocumentProfiles } from '../src/features/icc/store.js';
import { applyOpenPolicy } from '../src/features/prepress/color-policies.js';
import { cmykEngine } from '../src/lib/color.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const dlg = () => document.querySelector('dialog[open]');
const button = (label) => [...dlg().querySelectorAll('.dialog-footer button')].find((b) => b.textContent === label);

// Linear-light RGB with sRGB primaries: 50% gray is much lighter than in sRGB.
function linearRgbProfile(name = 'Linear Test RGB') {
  const M = rgbToPcsMatrix([[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], [0.3127, 0.329]);
  const col = (i) => ({ kind: 'XYZ', values: [[M[i], M[3 + i], M[6 + i]]] });
  const lin = { kind: 'curve', curve: { kind: 'identity' } };
  return writeProfile({ version: 4, deviceClass: 'mntr', colorSpace: 'RGB ', pcs: 'XYZ ', tags: [['desc', { kind: 'text', text: name }], ['rXYZ', col(0)], ['gXYZ', col(1)], ['bXYZ', col(2)], ['rTRC', lin], ['gTRC', lin], ['bTRC', lin]] });
}

// A CMYK printer whose CMY are sRGB's complement (no black), as lut16 tables.
function simpleCmykProfile() {
  const L = 65535 / 65280;
  const AB = 65535 / 256;
  const enc = (x) => { const l = xyzToLab(x); return [l[0] / 100 / L, (l[1] + 128) / AB, (l[2] + 128) / AB]; };
  const dec = (v) => labToXyz([v[0] * L * 100, v[1] * AB - 128, v[2] * AB - 128]);
  const lut = (i, o, clut) => ({ kind: 'lut', bits: 16, inputs: i, outputs: o, inCurves: new Array(i).fill(identityCurve), clut, outCurves: new Array(o).fill(identityCurve) });
  const a2b = lut(4, 3, sampleClut(4, 3, 9, (v) => enc(srgbToPcs([0, 1, 2].map((i) => (1 - v[i]) * (1 - v[3]))))));
  const b2a = lut(3, 4, sampleClut(3, 4, 17, (v) => { const rgb = pcsToSrgb(dec(v)); return [1 - rgb[0], 1 - rgb[1], 1 - rgb[2], 0]; }));
  return writeProfile({ version: 2, deviceClass: 'prtr', colorSpace: 'CMYK', pcs: 'Lab ', tags: [['desc', { kind: 'text', text: 'Simple Test Press' }], ['wtpt', { kind: 'XYZ', values: [[0.9642, 1, 0.8249]] }], ['A2B0', a2b], ['B2A0', b2a]] });
}

async function setup() {
  const app = await bootAppWithFeatures();
  await app.iccProfiles.load();
  const ed = app.newDocument();
  const add = (doc, layer, color) => {
    const p = createPath(rectangle(0, 0, 10, 10), true, { fill: { type: 'solid', color } });
    doc.transact('Add', () => doc.insert(p, layer));
    return p.id;
  };
  return { app, ed, doc: ed.doc, add: (color, e = ed) => add(e.doc, e.targetLayer().id, color) };
}

describe('user profiles', () => {
  it('loads profiles into the store and lists them by kind', async () => {
    const { app } = await setup();
    expect(app.iccProfiles.location).toBe('memory');
    const rgb = await app.iccProfiles.add(linearRgbProfile());
    const cmyk = await app.iccProfiles.add(simpleCmykProfile());
    expect(rgb).toMatchObject({ kind: 'RGB', source: 'user', name: 'Linear Test RGB' });
    expect(cmyk.kind).toBe('CMYK');
    expect(listProfiles('CMYK').map((e) => e.id)).toContain(cmyk.id);
    // A second store over the same storage finds them again.
    const files = await app.iccProfiles.backend.list('');
    expect(files.map((f) => f.name)).toContain(`${rgb.id.slice(4)}.icc`);
    await expect(app.iccProfiles.add(new Uint8Array(200))).rejects.toThrow();
    expect(await app.iccProfiles.remove(rgb.id)).toBe(true);
    expect(profileEntry(rgb.id)).toBeNull();
  });

  it('uses an ICC working CMYK profile for conversions and separations', async () => {
    const { app, ed, doc, add } = await setup();
    const cmyk = await app.iccProfiles.add(simpleCmykProfile());
    app.prefs.set('colorSettings', { cmyk: cmyk.id, bpc: false });
    expect(docCmykProfile(app, doc)).toBe(cmyk.id);
    const c = rgbToCmyk(app, doc, [1, 0, 0]);
    expect(c.c).toBeLessThan(3);
    // Saturated colors sit at the edge of the table's gamut, where interpolation softens them a little.
    expect(c.m).toBeGreaterThan(90);
    expect(c.y).toBeGreaterThan(90);
    const id = add('#ff0000');
    ed.select([id]);
    await app.commands.run('color.toCMYK');
    const fill = doc.get(id).fill.cmyk;
    expect(fill.m).toBeGreaterThan(90);
    expect(fill.y).toBeGreaterThan(90);
    expect(fill.k).toBe(0);
    // The Color panel's CMYK numbers come from the same transform.
    const teal = cmykEngine.toCmyk({ r: 51, g: 204, b: 204 });
    expect(teal.c).toBeCloseTo(80, -0.5);
    expect(teal.m).toBeCloseTo(20, -0.5);
    const inks = inkView(cmyk.id);
    expect(inks.inks[0][0]).toBeLessThan(0.05);
    expect(inks.inks[0][1]).toBeGreaterThan(0.95);
    expect(inks.label).toBe('Simple Test Press');
  });
});

describe('document profiles', () => {
  it('assigns an ICC profile, carries it in the document and converts on open', async () => {
    const { app, ed, doc, add } = await setup();
    const entry = await app.iccProfiles.add(linearRgbProfile('Linear Assign RGB'));
    const id = add('#808080');
    const run = app.commands.run('edit.assignProfile');
    await tick();
    const sel = dlg().querySelector('select');
    expect([...sel.querySelectorAll('option')].map((o) => o.value)).toContain(entry.id);
    sel.value = entry.id;
    sel.dispatchEvent(new Event('change'));
    button('OK').click();
    await run;
    expect(doc.root.colorProfile).toBe(entry.id);
    expect(docRgbProfile(app, doc)).toBe(entry.id);
    expect(documentProfileBytes(doc, entry.id)?.length).toBeGreaterThan(128);
    // Reopen in a session that does not know the profile: the document brings it.
    const json = JSON.parse(JSON.stringify(doc.toJSON()));
    await app.iccProfiles.remove(entry.id);
    unregisterProfile(entry.id);
    const doc2 = VDocument.fromJSON(json);
    app.prefs.set('colorSettings', { policyRgb: 'convert' });
    const ed2 = app.addDocument(doc2, {});
    expect(profileEntry(entry.id)?.source).toBe('embedded');
    expect(await applyOpenPolicy(app, ed2)).toBe('convert');
    // Linear 50% gray is sRGB #bcbcbc.
    expect(doc2.get(id).fill.color).toBe('#bcbcbc');
    expect(doc2.root.colorProfile).toBeUndefined();
    ed.doc.undo?.();
  });

  it('treats a profile the document names but does not carry as missing', async () => {
    const { app, doc } = await setup();
    app.prefs.set('colorSettings', { askMissing: true });
    doc.transact('Profile', () => doc.updateRoot({ colorProfile: 'icc:00000000deadbeef' }));
    expect(registerDocumentProfiles(doc)).toEqual([]);
    const ed2 = app.addDocument(doc, { file: { name: 'missing.vstudio' } });
    await tick();
    await tick();
    expect(dlg().querySelector('.dialog-title').textContent).toBe('Missing Profile');
    expect(dlg().textContent).toMatch(/not available/);
    button('OK').click();
    await tick();
    expect(docRgbProfile(app, ed2.doc)).toBe('srgb');
  });
});

describe('paste policy', () => {
  async function twoDocs() {
    const s = await setup();
    const entry = await s.app.iccProfiles.add(linearRgbProfile('Linear Paste RGB'));
    s.doc.transact('Profile', () => s.doc.updateRoot({ colorProfile: entry.id }));
    const id = s.add('#808080');
    s.ed.select([id]);
    await s.app.commands.run('edit.copy');
    const ed2 = s.app.newDocument();
    return { ...s, ed2 };
  }

  it('keeps the appearance of pasted colors by default', async () => {
    const { app, ed2 } = await twoDocs();
    await app.commands.run('edit.paste', { internal: true });
    const [id] = ed2.topSelection();
    expect(ed2.doc.get(id).fill.color).toBe('#bcbcbc');
  });

  it('asks when told to, and can keep the numbers', async () => {
    const { app, ed2 } = await twoDocs();
    app.prefs.set('colorSettings', { askPaste: true });
    const run = app.commands.run('edit.paste', { internal: true });
    await tick();
    expect(dlg().querySelector('.dialog-title').textContent).toBe('Paste Profile Mismatch');
    dlg().querySelector('input[value="numbers"]').click();
    button('OK').click();
    await run;
    const [id] = ed2.topSelection();
    expect(ed2.doc.get(id).fill.color).toBe('#808080');
  });

  it('offers Ask When Pasting in Color Settings', async () => {
    const { app } = await setup();
    const run = app.commands.run('edit.colorSettings');
    await tick();
    const label = [...dlg().querySelectorAll('label')].find((l) => l.textContent === 'Ask when pasting');
    const box = dlg().querySelector(`#${label.getAttribute('for')}`);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    button('OK').click();
    await run;
    expect(app.prefs.get('colorSettings').askPaste).toBe(true);
  });
});

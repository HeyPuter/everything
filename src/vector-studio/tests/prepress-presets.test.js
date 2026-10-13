import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setGeomSource, loadGeom } from '../src/features/geometry/engine/index.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { bootAppWithFeatures } from './helpers.js';
import { listPresets, savePreset, deletePreset, exportPresetsData, parsePresetsData, uniqueName, getPreset } from '../src/features/prepress/presets.js';
import { normalizeFlattener, FLATTENER_BUILTINS, flattenOptions } from '../src/features/prepress/flattener-presets.js';
import { flattenSelection } from '../src/features/effects/flatten.js';
import { MENUS } from '../src/ui/menus.js';

beforeAll(async () => {
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
  await loadGeom();
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const dialogs = () => [...document.querySelectorAll('dialog[open]')];
const top = () => dialogs().at(-1);
const button = (label, d = top()) => [...d.querySelectorAll('button')].find((b) => b.textContent.trim().replace('…', '...') === label || b.textContent.trim() === label);
const solid = (color) => ({ type: 'solid', color });

async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const doc = ed.doc;
  const add = (x, style) => {
    const p = createPath(rectangle(x, 0, 100, 100), true, style);
    doc.transact('Add', () => doc.insert(p, ed.targetLayer().id));
    return p.id;
  };
  return { app, ed, doc, add };
}

describe('preset storage', () => {
  it('lists built-ins first and keeps them read-only', async () => {
    const { app } = await setup();
    const names = listPresets(app, 'flattener').map((p) => p.name);
    expect(names.slice(0, 4)).toEqual(Object.keys(FLATTENER_BUILTINS));
    expect(() => savePreset(app, 'flattener', 'High Resolution', {})).toThrow(/built-in/);
    savePreset(app, 'flattener', 'Mine', { balance: 30 });
    expect(getPreset(app, 'flattener', 'Mine')).toMatchObject({ builtin: false, values: { balance: 30, lineArtPpi: 300 } });
    deletePreset(app, 'flattener', 'Mine');
    expect(getPreset(app, 'flattener', 'Mine')).toBeNull();
  });

  it('exports and imports preset files', () => {
    const data = exportPresetsData('flattener', { A: { balance: 20 } });
    expect(parsePresetsData('flattener', JSON.parse(JSON.stringify(data)))).toEqual({ A: normalizeFlattener({ balance: 20 }) });
    expect(() => parsePresetsData('print', data)).toThrow();
    expect(uniqueName(['Preset 1'], 'Preset', true)).toBe('Preset 2');
    expect(uniqueName(['A'], 'B')).toBe('B');
  });

  it('reads settings saved before presets', () => {
    expect(normalizeFlattener({ balance: 40, resolution: 600 })).toMatchObject({ balance: 40, lineArtPpi: 600 });
  });
});

describe('presets manager', () => {
  it('creates, edits and deletes presets, applying them on OK', async () => {
    const { app } = await setup();
    expect(MENUS.find((m) => m.label === 'Edit').submenu).toEqual(expect.arrayContaining(['edit.flattenerPresets', 'edit.printPresets', 'edit.pdfPresets']));
    const run = app.commands.run('edit.flattenerPresets');
    await tick();
    const mgr = top();
    expect(mgr.querySelector('.dialog-title').textContent).toBe('Transparency Flattener Presets');
    // Built-ins cannot be edited or deleted.
    expect(button('Edit…', mgr).disabled).toBe(true);
    expect(button('Delete', mgr).disabled).toBe(true);
    expect(mgr.querySelector('.pp-summary').textContent).toMatch(/1200 ppi/);
    button('New…', mgr).click();
    await tick();
    const ed = top();
    expect(ed).not.toBe(mgr);
    expect(ed.querySelector('#pp-flat-name').value).toBe('Flattener Preset 1');
    button('OK', ed).click();
    await tick();
    await tick();
    expect([...mgr.querySelectorAll('.pp-preset')].map((li) => li.firstChild.textContent)).toContain('Flattener Preset 1');
    expect(button('Delete', mgr).disabled).toBe(false);
    button('OK', mgr).click();
    await run;
    expect(Object.keys(app.prefs.get('flattenerPresets'))).toEqual(['Flattener Preset 1']);
    // Cancel discards changes.
    const run2 = app.commands.run('edit.flattenerPresets');
    await tick();
    button('Delete', top()).click();
    button('Cancel', top()).click();
    await run2;
    expect(Object.keys(app.prefs.get('flattenerPresets'))).toEqual(['Flattener Preset 1']);
  });
});

describe('flattener presets in Flatten Transparency', () => {
  it('flattens with a chosen preset', async () => {
    const { app, ed, doc, add } = await setup();
    const a = add(0, { fill: solid('#0000ff'), stroke: null });
    const b = add(50, { fill: solid('#ff0000'), stroke: null, opacity: 0.5 });
    ed.select([a, b]);
    const run = app.commands.run('object.flatten');
    await tick();
    const d = top();
    const sel = d.querySelector('.pp-preset-select');
    expect([...sel.options].map((o) => o.value)).toEqual([...Object.keys(FLATTENER_BUILTINS), '']);
    sel.value = 'High Resolution';
    sel.dispatchEvent(new Event('change'));
    expect(d.querySelectorAll('.fx-num')[0].value).toBe('100');
    button('OK', d).click();
    await run;
    await new Promise((r) => setTimeout(r, 50));
    expect(app.prefs.get('flattenTransparency')).toMatchObject(FLATTENER_BUILTINS['High Resolution']);
    expect(doc.get(a)).toBeUndefined();
  });

  it('keeps strokes nothing covers and clips complex regions to boxes when asked', async () => {
    const { app, ed, doc, add } = await setup();
    const a = add(0, { fill: solid('#0000ff'), stroke: solid('#000000'), strokeWidth: 2 });
    const grad = { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 0.5 }] };
    const b = add(300, { fill: grad, stroke: null });
    ed.select([a, b]);
    const sizes = [];
    const render = async (d, ids, rect, o) => {
      sizes.push(o.ppi);
      return { data: 'data:image/png;base64,AAAA', width: 4, height: 4 };
    };
    const opts = await flattenOptions(app, ed, { balance: 100, lineArtPpi: 600, gradientPpi: 100, strokesToOutlines: false, clipComplex: false });
    const r = await flattenSelection(ed, opts, { render });
    expect(r.error).toBeUndefined();
    // Only a gradient needed the image: it used the gradient resolution.
    expect(sizes).toEqual([100]);
    const kids = doc.get(r.id).children.map((c) => doc.get(c));
    const stroke = kids.find((k) => k.type === 'path' && !k.fill && k.stroke);
    expect(stroke).toMatchObject({ strokeWidth: 2, stroke: { color: '#000000' } });
    const clipGroup = kids.find((k) => k.clip);
    const clipShape = doc.get(clipGroup.children[1]);
    const sub = doc.get(clipShape.children[0]);
    // A box: four corners.
    expect(sub.anchors.length).toBe(4);
  });
});

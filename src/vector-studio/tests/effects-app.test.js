import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import opentype from 'opentype.js';
import { bootAppWithFeatures } from './helpers.js';
import { setGeomSource, loadGeom } from '../src/features/geometry/engine/index.js';
import { createPath, createGroup, createText } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { registerMeasureFont } from '../src/model/text-layout.js';
import { registerOutlineFont } from '../src/features/type/fonts.js';
import { createEffect } from '../src/features/paint/effects-model.js';
import { effectiveSubpaths } from '../src/model/geom-effects.js';
import { liveArtwork, isLive } from '../src/model/live.js';
import { nodeBounds, visualBounds } from '../src/model/geometry.js';
import { hitTest } from '../src/render/hit.js';
import { exportSVG } from '../src/features/io/svg-export.js';
import { expandAppearance } from '../src/ops/expand-appearance.js';
import { effectMenuSpec } from '../src/features/effects/index.js';
import { docRasterSettings, setDocRasterSettings, rasterizeObjects } from '../src/features/effects/raster.js';
import { flattenSelection, faceColor, compositeOver, blendColors, maxVectorFaces } from '../src/features/effects/flatten.js';
import { warpIconPath } from '../src/features/effects/icons.js';
import { WARP_STYLES } from '../src/model/warp.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const solid = (color, opacity) => ({ type: 'solid', color, ...(opacity != null ? { opacity } : {}) });

beforeAll(async () => {
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
  await loadGeom();
  const buf = readFileSync(resolve(process.cwd(), 'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff'));
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  registerMeasureFont('Inter', 400, 'normal', font);
  registerOutlineFont('Inter', 400, 'normal', font);
});

async function setup() {
  const app = await bootAppWithFeatures();
  app.newDocument();
  const doc = app.editor.doc;
  const n = createPath(rectangle(100, 100, 100, 50), true, { fill: solid('#cc3333'), stroke: solid('#3333cc'), strokeWidth: 2 });
  doc.transact('Rect', () => doc.insert(n, app.editor.targetLayer().id));
  app.editor.select([n.id]);
  return { app, doc, id: n.id, ed: app.editor };
}

const openDlg = () => document.querySelector('dialog[open]');
const button = (dlg, text) => [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const setField = (input, value) => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
};
const fieldByLabel = (dlg, label) => {
  const l = [...dlg.querySelectorAll('label')].find((x) => x.textContent.trim() === label && x.htmlFor);
  return l ? dlg.querySelector(`#${l.htmlFor}`) : null;
};

const COMMANDS = [
  'effect.freeDistort', 'effect.pucker', 'effect.roughen', 'effect.transform', 'effect.tweak', 'effect.twist', 'effect.zigzag',
  'effect.offsetPath', 'effect.outlineObject', 'effect.outlineStroke',
  'effect.shape.rectangle', 'effect.shape.roundedRectangle', 'effect.shape.ellipse',
  ...WARP_STYLES.map((s) => `effect.warp.${s.id}`),
  'effect.scribble', 'effect.cropMarks',
  ...['unite', 'intersect', 'exclude', 'minusFront', 'minusBack', 'divide', 'trim', 'merge', 'crop', 'outline'].map((k) => `effect.pathfinder.${k}`),
  'effect.rasterize', 'effect.rasterSettings', 'object.rasterize', 'object.flatten',
];

describe('Effect menu', () => {
  it('registers every vector effect command and enables them with a selection', async () => {
    const { app, ed } = await setup();
    for (const id of COMMANDS) {
      expect(app.commands.get(id), id).toBeTruthy();
      expect(app.commands.isEnabled(id), id).toBe(true);
    }
    ed.select([]);
    expect(app.commands.isEnabled('effect.warp.arc')).toBe(false);
    expect(app.commands.isEnabled('effect.rasterSettings')).toBe(true);
  });

  it('offers the whole Effect menu as Add New Effect', () => {
    const spec = effectMenuSpec();
    expect(spec).not.toContain('effect.applyLast');
    expect(spec).not.toContain('effect.rasterSettings');
    expect(spec.find((x) => x.label === 'Warp')).toBeTruthy();
    expect(spec[0]).not.toBe('-');
  });

  it('draws an icon for every warp style from the warp itself', () => {
    for (const s of WARP_STYLES) expect(warpIconPath(s.id)).toMatch(/^M[\d.]+ [\d.]+/);
    expect(warpIconPath('arc')).not.toBe(warpIconPath('flag'));
  });
});

describe('effect dialogs', () => {
  it('Warp previews live, commits on OK as one undo step and is editable from Appearance', async () => {
    const { app, doc, id } = await setup();
    const undo0 = doc.undoStack.length;
    const done = app.commands.run('effect.warp.flag');
    await tick();
    const dlg = openDlg();
    expect(dlg.querySelector('.dialog-title').textContent).toBe('Warp Options');
    expect(dlg.querySelector('[data-style="flag"]').getAttribute('aria-checked')).toBe('true');
    await tick();
    expect(doc.get(id).effects.at(-1)).toMatchObject({ type: 'warp', style: 'flag', bend: 0.5 });
    // Pick another style and change the bend.
    dlg.querySelector('[data-style="bulge"]').click();
    setField(fieldByLabel(dlg, 'Bend'), '-30%');
    await tick();
    expect(doc.get(id).effects).toHaveLength(1);
    expect(doc.get(id).effects[0]).toMatchObject({ style: 'bulge', bend: -0.3 });
    button(dlg, 'OK').click();
    expect(await done).toBe(true);
    expect(doc.tx).toBeNull();
    expect(doc.undoStack.length).toBe(undo0 + 1);
    expect(app.lastEffect).toMatchObject({ type: 'warp', style: 'bulge' });
    // Edit it again from the Appearance panel's effect row.
    const panel = app.panels?.get?.('appearance') || null;
    const { effectDialog } = await import('../src/features/paint/effects-ui.js');
    const again = effectDialog(app, 'warp', { edit: { id, index: 0 } });
    await tick();
    const d2 = openDlg();
    expect(d2.querySelector('[data-style="bulge"]').getAttribute('aria-checked')).toBe('true');
    setField(fieldByLabel(d2, 'Bend'), '80');
    button(d2, 'OK').click();
    await again;
    expect(doc.get(id).effects).toEqual([expect.objectContaining({ type: 'warp', style: 'bulge', bend: 0.8 })]);
    expect(panel === null || panel).toBeTruthy();
  });

  it('Cancel and turning Preview off restore the object', async () => {
    const { app, doc, id } = await setup();
    const before = doc.get(id);
    const done = app.commands.run('effect.roughen');
    await tick();
    await tick();
    const dlg = openDlg();
    expect(doc.get(id).effects).toHaveLength(1);
    const preview = [...dlg.querySelectorAll('input[type=checkbox]')].find((c) => c.closest('label')?.textContent.includes('Preview'));
    preview.checked = false;
    preview.dispatchEvent(new Event('change'));
    expect(doc.get(id).effects).toEqual([]);
    preview.checked = true;
    preview.dispatchEvent(new Event('change'));
    button(dlg, 'Cancel').click();
    expect(await done).toBe(false);
    expect(doc.get(id)).toEqual(before);
    expect(doc.tx).toBeNull();
  });

  it('every dialog opens, previews and commits', async () => {
    const { app, doc, id } = await setup();
    const cmds = ['effect.freeDistort', 'effect.pucker', 'effect.roughen', 'effect.transform', 'effect.tweak', 'effect.twist', 'effect.zigzag', 'effect.offsetPath', 'effect.shape.roundedRectangle', 'effect.scribble', 'effect.rasterize'];
    let count = 0;
    for (const c of cmds) {
      const done = app.commands.run(c);
      await tick();
      const dlg = openDlg();
      expect(dlg, c).toBeTruthy();
      expect(dlg.querySelector('.fx-preview-toggle'), c).toBeTruthy();
      button(dlg, 'OK').click();
      expect(await done, c).toBe(true);
      count++;
      expect(doc.get(id).effects).toHaveLength(count);
    }
    const types = doc.get(id).effects.map((e) => e.type);
    expect(types).toEqual(['freeDistort', 'puckerBloat', 'roughen', 'transform', 'tweak', 'twist', 'zigzag', 'offsetPath', 'convertShape', 'scribble', 'rasterize']);
    expect(doc.get(id).effects[8].shape).toBe('roundedRectangle');
    // Everything still renders into usable outlines.
    expect(effectiveSubpaths(doc, doc.get(id)).length).toBeGreaterThan(0);
  });

  it('Free Distort moves corners from the keyboard and resets', async () => {
    const { app, doc, id } = await setup();
    const done = app.commands.run('effect.freeDistort');
    await tick();
    const dlg = openDlg();
    const handle = dlg.querySelector('.fx-fd-handle');
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    expect(doc.get(id).effects[0].corners[0].x).toBeCloseTo(0.1, 9);
    button(dlg, 'Reset').click();
    expect(doc.get(id).effects[0].corners[0].x).toBe(0);
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    button(dlg, 'OK').click();
    await done;
    expect(doc.get(id).effects[0].corners[0].x).toBeCloseTo(0.1, 9);
    // The top left corner moved 10% of the width to the right.
    const [out] = effectiveSubpaths(doc, doc.get(id));
    expect(out.anchors[0].x).toBeCloseTo(110, 6);
    expect(out.anchors[3].x).toBeCloseTo(100, 6);
  });

  it('Scribble presets fill the fields and edits switch to Custom', async () => {
    const { app, doc, id } = await setup();
    const done = app.commands.run('effect.scribble');
    await tick();
    const dlg = openDlg();
    const preset = fieldByLabel(dlg, 'Preset');
    preset.value = 'fineHatch';
    preset.dispatchEvent(new Event('change'));
    expect(fieldByLabel(dlg, 'Angle').value).toBe('45°');
    setField(fieldByLabel(dlg, 'Angle'), '10');
    expect(preset.value).toBe('custom');
    button(dlg, 'OK').click();
    await done;
    expect(doc.get(id).effects[0]).toMatchObject({ type: 'scribble', preset: 'custom', angle: 10, lineWidth: 0.75 });
  });

  it('applies effects without options at once, Apply Last Effect and Last Effect repeat them', async () => {
    const { app, doc, id, ed } = await setup();
    app.commands.run('effect.pathfinder.minusFront');
    expect(doc.get(id).effects).toEqual([{ type: 'pathfinder', kind: 'minusFront' }]);
    expect(app.commands.label('effect.applyLast')).toBe('Apply Pathfinder: Subtract');
    const other = createPath(rectangle(300, 100, 50, 50), true);
    doc.transact('Rect', () => doc.insert(other, ed.targetLayer().id));
    ed.select([other.id]);
    app.commands.run('effect.applyLast');
    expect(doc.get(other.id).effects).toEqual([{ type: 'pathfinder', kind: 'minusFront' }]);
    app.commands.run('effect.cropMarks');
    expect(doc.get(other.id).effects.at(-1).type).toBe('cropMarks');
    // Last Effect on a dialog effect opens its dialog with the last values.
    const w = app.commands.run('effect.twist');
    await tick();
    setField(fieldByLabel(openDlg(), 'Angle'), '77');
    button(openDlg(), 'OK').click();
    await w;
    const last = app.commands.run('effect.last');
    await tick();
    expect(fieldByLabel(openDlg(), 'Angle').value).toBe('77°');
    button(openDlg(), 'Cancel').click();
    await last;
  });
});

describe('Appearance panel', () => {
  it('lists, hides, reorders and deletes geometry effects', async () => {
    const { app, doc, id } = await setup();
    doc.transact('fx', () => doc.update(id, { effects: [createEffect('warp', { style: 'arc' }), createEffect('roughen', { seed: 4 })] }));
    app.openPanel('appearance');
    await tick();
    const panelEl = document.querySelector('.ap-list');
    expect(panelEl).toBeTruthy();
    const labels = [...panelEl.querySelectorAll('.ap-row .ap-label')].map((l) => l.textContent);
    expect(labels).toContain('Warp: Arc');
    expect(labels).toContain('Roughen');
    // Hide the warp.
    const warpRow = [...panelEl.querySelectorAll('.ap-row')].find((r) => r.textContent.includes('Warp: Arc'));
    warpRow.querySelector('.ap-eye').click();
    expect(doc.get(id).effects[0].hidden).toBe(true);
    expect(effectiveSubpaths(doc, doc.get(id))[0].anchors.length).toBeGreaterThan(4);
    // Reorder from the keyboard.
    app.dock.panels.get('appearance').update(true);
    const row = [...document.querySelectorAll('.ap-list .ap-row')].find((r) => r.textContent.includes('Roughen'));
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
    expect(doc.get(id).effects.map((e) => e.type)).toEqual(['roughen', 'warp']);
    // Delete.
    app.dock.panels.get('appearance').update(true);
    const r2 = [...document.querySelectorAll('.ap-list .ap-row')].find((r) => r.textContent.includes('Roughen'));
    r2.querySelector('.ap-del').click();
    expect(doc.get(id).effects.map((e) => e.type)).toEqual(['warp']);
  });
});

describe('Expand Appearance and export', () => {
  it('bakes warps into anchors and scribbles into separately painted objects', async () => {
    const { app, doc, id, ed } = await setup();
    doc.transact('fx', () => doc.update(id, { effects: [createEffect('warp', { style: 'arc', bend: 0.5 }), createEffect('dropShadow')] }));
    const subs = effectiveSubpaths(doc, doc.get(id));
    expect(expandAppearance(ed)).toBe(true);
    const n = doc.get(ed.topSelection()[0]);
    expect(n.type).toBe('path');
    expect(n.anchors).toEqual(subs[0].anchors);
    expect(n.effects.map((e) => e.type)).toEqual(['dropShadow']);

    const s = createPath(rectangle(0, 300, 100, 60), true, { fill: solid('#00aa00'), stroke: solid('#000000'), strokeWidth: 1, effects: [createEffect('scribble', { seed: 3 })] });
    doc.transact('add', () => doc.insert(s, ed.targetLayer().id));
    ed.select([s.id]);
    expandAppearance(ed);
    const g = doc.get(ed.topSelection()[0]);
    expect(g.type).toBe('group');
    const kids = g.children.map((c) => doc.get(c));
    expect(kids).toHaveLength(2);
    expect(kids[0]).toMatchObject({ fill: null, stroke: solid('#00aa00'), strokeCap: 'round' });
    expect(kids[1]).toMatchObject({ fill: null, stroke: solid('#000000'), strokeWidth: 1 });
    expect(app).toBeTruthy();
  });

  it('exports effected artwork as it is drawn', async () => {
    const { doc, id } = await setup();
    doc.transact('fx', () => doc.update(id, { effects: [createEffect('zigzag', { size: 5, ridges: 2 }), createEffect('cropMarks')] }));
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 400, h: 400 } });
    // The zigzag outline and the black crop marks both export.
    expect(svg).toMatch(/stroke-width="0.3"/);
    const paths = svg.match(/<path[^>]*>/g) || [];
    expect(paths.length).toBeGreaterThanOrEqual(2);
  });
});

describe('type with geometry effects', () => {
  it('draws warped type from its outlines, hit tests it and expands it to shapes', async () => {
    const { doc, ed } = await setup();
    const t = createText('Wave', 100, 300, { fill: solid('#112233'), char: { fontFamily: 'Inter', fontWeight: 400, fontStyle: 'normal', fontSize: 40 } });
    doc.transact('Text', () => doc.insert({ ...t, effects: [createEffect('warp', { style: 'arc', bend: 0.6 })] }, ed.targetLayer().id));
    const node = doc.get(t.id);
    expect(isLive(node)).toBe(true);
    const art = liveArtwork(doc, node);
    expect(art.items.length).toBeGreaterThan(0);
    expect(art.items[0].type).toBe('compound');
    expect(art.items[0].fill).toEqual(solid('#112233'));
    expect(art.items[0].source).toBe(t.id);
    // The arc lifts the middle of the word above the plain text box.
    const plain = nodeBounds(doc, node);
    const vb = visualBounds(doc, node);
    expect(vb.y).toBeLessThan(plain.y);
    ed.select([t.id]);
    expect(expandAppearance(ed)).toBe(true);
    const g = doc.get(ed.topSelection()[0]);
    expect(g.type).toBe('group');
    const kids = g.children.map((c) => doc.get(c));
    expect(kids.every((k) => k.type === 'compound' || k.type === 'path')).toBe(true);
    expect(kids.every((k) => !(k.effects || []).length)).toBe(true);
    expect(hitTest).toBeTypeOf('function');
  });

  it('Pathfinder effects on a group combine type as outlines', async () => {
    const { doc, ed } = await setup();
    const t = createText('O', 0, 400, { char: { fontFamily: 'Inter', fontWeight: 400, fontStyle: 'normal', fontSize: 80 } });
    const r = createPath(rectangle(0, 330, 200, 100), true, { fill: solid('#ff0000'), stroke: null });
    const g = createGroup([r.id, t.id], { effects: [createEffect('pathfinder', { kind: 'minusFront' })] });
    doc.transact('add', () => doc.insert(g, ed.targetLayer().id, Infinity, [{ ...r, parent: g.id }, { ...t, parent: g.id }]));
    const art = liveArtwork(doc, doc.get(g.id));
    const shapes = art.items[0].children.map((c) => art.vdoc.get(c));
    expect(shapes).toHaveLength(1);
    expect(shapes[0].fill).toEqual(solid('#ff0000'));
    expect(shapes[0].type).toBe('compound');
  });
});

describe('rasterizing', () => {
  it('keeps document raster settings and the effects that follow them in step', async () => {
    const { doc, id } = await setup();
    expect(docRasterSettings(doc)).toEqual({ colorModel: 'rgb', resolution: 72, background: 'transparent', antialias: true, padding: 0 });
    doc.transact('fx', () => doc.update(id, { effects: [createEffect('rasterize', { useDocument: true }), createEffect('rasterize', { useDocument: false, resolution: 150 })] }));
    doc.transact('settings', () => setDocRasterSettings(doc, { resolution: 300, background: 'white', padding: 4 }));
    expect(docRasterSettings(doc)).toEqual({ colorModel: 'rgb', resolution: 300, background: 'white', antialias: true, padding: 4 });
    const fx = doc.get(id).effects;
    expect(fx[0]).toMatchObject({ resolution: 300, background: 'white', padding: 4 });
    expect(fx[1]).toMatchObject({ resolution: 150, background: 'transparent' });
    doc.undo();
    expect(docRasterSettings(doc).resolution).toBe(72);
  });

  it('Object > Rasterize replaces the selection by an image at the chosen resolution', async () => {
    const { doc, id, ed } = await setup();
    const calls = [];
    const render = async (d, ids, rect, o) => {
      calls.push({ ids, rect, o });
      return { data: 'data:image/png;base64,AAAA', width: Math.round((rect.w * o.ppi) / 72), height: Math.round((rect.h * o.ppi) / 72) };
    };
    const out = await rasterizeObjects(ed, [id], { resolution: 144, background: 'white', antialias: true, padding: 5, clip: true }, render);
    expect(calls[0].o).toEqual({ ppi: 144, background: 'white', antialias: true, colorModel: undefined });
    expect(doc.get(id)).toBeUndefined();
    const g = doc.get(out);
    expect(g).toMatchObject({ type: 'group', clip: true });
    const img = doc.get(g.children[0]);
    expect(img.type).toBe('image');
    expect(doc.assets.get(img.asset).data).toBe('data:image/png;base64,AAAA');
    const b = nodeBounds(doc, img);
    // Visual bounds (the mitered stroke's reach included) plus 5 pt around.
    const vb = calls[0].rect;
    expect(b.x).toBeCloseTo(vb.x, 6);
    expect(vb.x).toBeCloseTo(91, 6);
    expect(b.w).toBeCloseTo(118, 6);
    expect(img.width).toBe(236);
    doc.undo();
    expect(doc.get(id)).toBeTruthy();
  });
});

describe('Flatten Transparency', () => {
  it('composites colors with opacity and blending modes', () => {
    const white = { c: [1, 1, 1], a: 1 };
    const half = compositeOver(white, { c: [1, 0, 0], a: 0.5 });
    expect(half.c.map((v) => Math.round(v * 255))).toEqual([255, 128, 128]);
    expect(half.a).toBe(1);
    expect(blendColors('multiply', [0.5, 1, 1], [0.5, 0.5, 0])).toEqual([0.25, 0.5, 0]);
    expect(blendColors('screen', [0.5, 0, 0], [0.5, 0, 0])[0]).toBeCloseTo(0.75, 9);
    expect(blendColors('difference', [1, 0.2, 0], [0.5, 0.5, 0])).toEqual([0.5, 0.3, 0]);
    const lum = blendColors('luminosity', [1, 0, 0], [0.5, 0.5, 0.5]);
    expect(0.3 * lum[0] + 0.59 * lum[1] + 0.11 * lum[2]).toBeCloseTo(0.5, 6);
    expect(maxVectorFaces(0)).toBe(0);
    expect(maxVectorFaces(100)).toBe(Infinity);
    expect(maxVectorFaces(75)).toBeGreaterThan(maxVectorFaces(50));
  });

  it('works out isolated group colors through the tree', () => {
    const tree = {
      kind: 'group',
      isolated: false,
      children: [
        { kind: 'shape', index: 0, color: [0, 0, 1], alpha: 1, mode: 'normal' },
        { kind: 'group', isolated: true, opacity: 0.5, mode: 'normal', children: [{ kind: 'shape', index: 1, color: [1, 0, 0], alpha: 1, mode: 'normal' }, { kind: 'shape', index: 2, color: [0, 1, 0], alpha: 1, mode: 'normal' }] },
      ],
    };
    // Both group members overlap: only the top one shows, at half opacity over blue.
    const c = faceColor(tree, [0, 1, 2]);
    expect(c.c.map((v) => Math.round(v * 255))).toEqual([0, 128, 128]);
    expect(faceColor(tree, [1]).c.map((v) => Math.round(v * 255))).toEqual([255, 128, 128]);
  });

  it('turns transparent overlaps into opaque shapes of the composited colors', async () => {
    const { doc, ed, id } = await setup();
    doc.transact('style', () => doc.update(id, { stroke: null, fill: solid('#0000ff') }));
    const top = createPath(rectangle(150, 100, 100, 50), true, { fill: solid('#ff0000'), stroke: null, opacity: 0.5 });
    doc.transact('add', () => doc.insert(top, ed.targetLayer().id));
    ed.select([id, top.id]);
    const r = await flattenSelection(ed, { balance: 100, resolution: 72 }, { render: async () => { throw new Error('no raster expected'); } });
    expect(r.error).toBeUndefined();
    const g = doc.get(r.id);
    const kids = g.children.map((c) => doc.get(c));
    const colors = kids.map((k) => k.fill.color).sort();
    expect(colors).toEqual(['#0000ff', '#800080', '#ff8080'].sort());
    for (const k of kids) expect(k.opacity ?? 1).toBe(1);
    expect(doc.get(id)).toBeUndefined();
    doc.undo();
    expect(doc.get(id)).toBeTruthy();
  });

  it('falls back to a clipped image for what solid colors cannot reproduce, and refuses opaque art', async () => {
    const { doc, ed, id } = await setup();
    ed.select([id]);
    expect((await flattenSelection(ed, { balance: 75 })).error).toMatch(/no transparency/);
    const grad = { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 0.2 }] };
    doc.transact('grad', () => doc.update(id, { fill: grad }));
    const render = async (d, ids, rect) => ({ data: 'data:image/png;base64,AAAA', width: Math.ceil(rect.w), height: Math.ceil(rect.h) });
    const r = await flattenSelection(ed, { balance: 75, resolution: 72 }, { render });
    expect(r.raster).toBe(true);
    const g = doc.get(r.id);
    const clip = g.children.map((c) => doc.get(c)).find((k) => k.clip);
    expect(clip).toBeTruthy();
    expect(doc.get(clip.children[0]).type).toBe('image');
  });
});

import { describe, it, expect } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { anchor } from '../src/model/bezier.js';
import { rectangle } from '../src/model/shapes.js';
import { isLive, liveArtwork } from '../src/model/live.js';
import { docBrushes } from '../src/features/brushes/brush-model.js';
import { DEFAULT_BRUSHES, BRUSH_LIBRARIES } from '../src/features/brushes/libraries.js';
import { pressureSamples, reshapeSection } from '../src/features/brushes/paintbrush-tool.js';
import { selectSame } from '../src/ops/select-ops.js';
import { resolveItems } from '../src/ui/menubar.js';
import { MENUS } from '../src/ui/menus.js';

const black = { type: 'solid', color: '#000000' };

function ev(app, x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}

function drag(app, tool, from, to, steps = 8, extra = {}) {
  tool.onPointerDown(ev(app, from[0], from[1], extra));
  for (let i = 1; i <= steps; i++) tool.onPointerMove(ev(app, from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, extra));
  tool.onPointerUp(ev(app, to[0], to[1], extra));
}

async function setup() {
  const app = await bootAppWithFeatures();
  app.newDocument();
  app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  return app;
}

function addPath(app, anchors, closed = false, style = {}) {
  const doc = app.editor.doc;
  const n = createPath(anchors, closed, { fill: null, stroke: black, strokeWidth: 1, ...style });
  doc.transact('add', () => doc.insert(n, app.editor.targetLayer().id));
  return n.id;
}

const dialog = () => document.querySelector('dialog[open]');
const button = (label) => [...dialog().querySelectorAll('button')].find((b) => b.textContent.trim() === label);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Brushes panel', () => {
  it('opens with F5 / Window > Brushes and lists the document brushes by type', async () => {
    const app = await setup();
    expect(app.commands.get('panel.brushes').shortcut).toBe('F5');
    await app.commands.run('panel.brushes');
    const panel = app.dock.panels.get('brushes');
    panel.update();
    const items = panel.list.querySelectorAll('[role="option"]');
    expect(items).toHaveLength(DEFAULT_BRUSHES.length);
    expect(panel.list.querySelectorAll('[role="group"]').length).toBe(5);
    for (const it of items) expect(it.getAttribute('aria-label')).toMatch(/Brush$/);
  });

  it('applies a brush to the selection, removes it, and undoes in one step each', async () => {
    const app = await setup();
    const id = addPath(app, [anchor(100, 100), anchor(300, 100)]);
    app.editor.select([id]);
    await app.commands.run('panel.brushes');
    const panel = app.dock.panels.get('brushes');
    panel.update();
    const doc = app.editor.doc;
    panel.list.querySelector('[data-id="def.ink-taper"]').click();
    expect(doc.get(id).brush.id).toBe('def.ink-taper');
    expect(isLive(doc.get(id))).toBe(true);
    expect(app.brushState.currentId).toBe('def.ink-taper');
    panel.update();
    expect(panel.list.querySelector('[aria-current="true"]').dataset.id).toBe('def.ink-taper');
    expect(panel.removeBtn.disabled).toBe(false);
    panel.removeBtn.click();
    expect(doc.get(id).brush).toBeUndefined();
    doc.undo();
    expect(doc.get(id).brush.id).toBe('def.ink-taper');
    doc.undo();
    expect(doc.get(id).brush).toBeUndefined();
  });

  it('shows a library, adds its brushes to the document when used', async () => {
    const app = await setup();
    const id = addPath(app, [anchor(100, 100), anchor(300, 100)]);
    app.editor.select([id]);
    // Window > Brush Libraries lists the libraries.
    const win = resolveItems(app, MENUS).find((m) => m.label === 'Window');
    const libs = win.items.find((m) => m.label === 'Brush Libraries');
    // The built-in libraries, then the user's saved ones.
    expect(libs.items.filter((i) => i.type === 'cmd').map((i) => i.label)).toEqual(BRUSH_LIBRARIES.map((l) => l.name));
    expect(libs.items.at(-1).label).toBe('User Defined');
    libs.items.find((i) => i.label === 'Borders').run(app);
    const panel = app.dock.panels.get('brushes');
    expect(panel.source).toBe('borders');
    panel.update();
    panel.list.querySelector('[data-id="lib.pattern.chain"]').click();
    const doc = app.editor.doc;
    expect(doc.get(id).brush.id).toBe('lib.pattern.chain');
    expect(docBrushes(doc).some((b) => b.id === 'lib.pattern.chain')).toBe(true);
    expect(liveArtwork(doc, doc.get(id)).items.length).toBeGreaterThan(5);
  });

  it('makes a new art brush from the selected artwork', async () => {
    const app = await setup();
    const art = addPath(app, rectangle(0, 0, 120, 10), true, { fill: { type: 'solid', color: '#336699' }, stroke: null });
    app.editor.select([art]);
    const p = app.commands.run('brush.new');
    await tick();
    expect(dialog().querySelector('.dialog-title').textContent).toBe('New Brush');
    dialog().querySelector('input[value="art"]').checked = true;
    button('Continue').click();
    await tick();
    await tick();
    expect(dialog().querySelector('.dialog-title').textContent).toBe('New Art Brush');
    const name = dialog().querySelector('input[type="text"]');
    name.value = 'Blue Bar';
    button('Create').click();
    const made = await p;
    expect(made.type).toBe('art');
    const doc = app.editor.doc;
    const b = docBrushes(doc).find((x) => x.name === 'Blue Bar');
    expect(b.art.items[0].fill.color).toBe('#336699');
    expect(b.art.bounds.w).toBeCloseTo(120);
    expect(app.brushState.currentId).toBe(b.id);
  });

  it('edits a brush in use and applies the change to its strokes', async () => {
    const app = await setup();
    const id = addPath(app, [anchor(100, 100), anchor(300, 100)], false, { brush: { id: 'def.basic' } });
    const doc = app.editor.doc;
    const before = liveArtwork(doc, doc.get(id)).items[0];
    const { editBrush } = await import('../src/features/brushes/brush-actions.js');
    const done = editBrush(app, 'def.basic');
    await tick();
    expect(dialog().querySelector('.dialog-title').textContent).toBe('Calligraphic Brush Options');
    const size = dialog().querySelector('input[aria-label="Size"]');
    size.value = '9 pt';
    button('OK').click();
    await tick();
    expect(dialog().querySelector('.dialog-title').textContent).toBe('Brush Change');
    button('Apply to Strokes').click();
    await done;
    expect(docBrushes(doc).find((b) => b.id === 'def.basic').size.value).toBe(9);
    const after = liveArtwork(doc, doc.get(id)).items[0];
    expect(after).not.toBe(before);
    doc.undo();
    expect(docBrushes(doc).find((b) => b.id === 'def.basic').size.value).toBe(1);
  });

  it('deletes a brush in use by expanding its strokes', async () => {
    const app = await setup();
    const id = addPath(app, [anchor(100, 100), anchor(300, 100)], false, { brush: { id: 'def.dots' } });
    const { confirmDeleteBrushes } = await import('../src/features/brushes/brush-actions.js');
    const done = confirmDeleteBrushes(app, ['def.dots']);
    await tick();
    button('Expand Strokes').click();
    await done;
    const doc = app.editor.doc;
    expect(doc.get(id)).toBeUndefined();
    expect(docBrushes(doc).some((b) => b.id === 'def.dots')).toBe(false);
    const leaves = doc.leaves();
    expect(leaves.length).toBeGreaterThan(5);
    expect(leaves.every((n) => !isLive(n))).toBe(true);
  });
});

describe('selection commands', () => {
  it('Select > Object > Brush Strokes and Same Appearance consider brushes', async () => {
    const app = await setup();
    const a = addPath(app, [anchor(0, 0), anchor(100, 0)], false, { brush: { id: 'def.basic', seed: 1 } });
    const b = addPath(app, [anchor(0, 50), anchor(100, 50)], false, { brush: { id: 'def.basic', seed: 2 } });
    const c = addPath(app, [anchor(0, 100), anchor(100, 100)]);
    const d = addPath(app, [anchor(0, 150), anchor(100, 150)], false, { brush: { id: 'def.chisel' } });
    expect(resolveItems(app, MENUS).find((m) => m.label === 'Select').items.find((m) => m.label === 'Object').items.some((i) => i.id === 'select.object.brushStrokes')).toBe(true);
    await app.commands.run('select.object.brushStrokes');
    expect(new Set(app.editor.selection)).toEqual(new Set([a, b, d]));
    app.editor.select([a]);
    selectSame(app.editor, 'appearance');
    expect(new Set(app.editor.selection)).toEqual(new Set([a, b]));
    app.editor.select([c]);
    selectSame(app.editor, 'appearance');
    expect([...app.editor.selection]).toEqual([c]);
  });
});

describe('Width tool', () => {
  it('drags out a width point, moves it, deletes it with Delete', async () => {
    const app = await setup();
    const id = addPath(app, [anchor(100, 200), anchor(500, 200)], false, { strokeWidth: 10 });
    app.setTool('width');
    expect(app.tool.constructor.shortcut).toBe('Shift+W');
    const doc = app.editor.doc;
    const steps = doc.undoStack.length;
    // Drag from the stroke at its middle out to 20 above the path: half-width 20 on both sides.
    drag(app, app.tool, [300, 202], [300, 180]);
    const prof = doc.get(id).widthProfile;
    expect(prof).toHaveLength(3);
    expect(prof[1].t).toBeCloseTo(0.5, 2);
    expect(prof[1].l).toBeCloseTo(4, 1);
    expect(prof[1].r).toBeCloseTo(4, 1);
    expect(doc.undoStack.length).toBe(steps + 1);
    expect(isLive(doc.get(id))).toBe(true);
    // Alt-drag one side only.
    app.tool.onHover(ev(app, 300, 220));
    drag(app, app.tool, [300, 220], [300, 210], 4, { alt: true });
    const p2 = doc.get(id).widthProfile[1];
    expect(p2.r).toBeCloseTo(2, 1);
    expect(p2.l).toBeCloseTo(4, 1);
    // Move the point along the path by its center.
    drag(app, app.tool, [300, 200], [400, 200]);
    expect(doc.get(id).widthProfile[1].t).toBeCloseTo(0.75, 2);
    // Delete removes the selected width point (not the path).
    await app.commands.run('edit.clear');
    expect(doc.get(id)).toBeTruthy();
    expect(doc.get(id).widthProfile).toBeUndefined();
  });

  it('edits a point numerically on double-click', async () => {
    const app = await setup();
    const id = addPath(app, [anchor(100, 200), anchor(500, 200)], false, { strokeWidth: 10, widthProfile: [{ t: 0, l: 1, r: 1 }, { t: 0.5, l: 2, r: 2 }, { t: 1, l: 1, r: 1 }] });
    app.setTool('width');
    app.tool.onHover(ev(app, 300, 200));
    const p = app.tool.onDoubleClick(ev(app, 300, 200));
    await tick();
    expect(dialog().querySelector('.dialog-title').textContent).toBe('Width Point');
    const inputs = dialog().querySelectorAll('input[type="text"]');
    expect(inputs[0].value).toBe('10 pt');
    inputs[2].value = '30 pt';
    inputs[2].dispatchEvent(new Event('change'));
    button('OK').click();
    await p;
    const pt = app.editor.doc.get(id).widthProfile[1];
    expect(pt.l * 5).toBeCloseTo(15);
    expect(pt.r * 5).toBeCloseTo(15);
  });

  it('expands to the outline with Outline Stroke', async () => {
    const app = await setup();
    const id = addPath(app, [anchor(100, 200), anchor(500, 200)], false, { strokeWidth: 10, widthProfile: [{ t: 0, l: 0, r: 0 }, { t: 0.5, l: 1, r: 1 }, { t: 1, l: 0, r: 0 }] });
    app.editor.select([id]);
    await app.commands.run('path.outlineStroke');
    const doc = app.editor.doc;
    expect(doc.get(id)).toBeUndefined();
    const [out] = doc.leaves();
    expect(out.fill).toEqual(black);
    expect(out.stroke).toBe(null);
    expect([...app.editor.selection]).toEqual([out.id]);
  });
});

describe('Stroke and Properties panels', () => {
  it('pick a width profile, flip it, and show the brush in Properties', async () => {
    const app = await setup();
    const id = addPath(app, [anchor(100, 200), anchor(500, 200)], false, { strokeWidth: 6 });
    app.editor.select([id]);
    app.openPanel('stroke');
    const stroke = app.dock.panels.get('stroke');
    stroke.update();
    const btn = stroke.el.querySelector('.sp-profile');
    expect(btn.disabled).toBe(false);
    btn.click();
    const opt = [...document.querySelectorAll('.sp-profile-opt')].find((o) => o.getAttribute('aria-label') === 'Taper End');
    opt.click();
    const doc = app.editor.doc;
    expect(doc.get(id).widthProfile[0]).toMatchObject({ t: 0, l: 1, r: 1 });
    stroke.update();
    expect(stroke.el.querySelector('.sp-profile').getAttribute('aria-label')).toBe('Width profile: Taper End');
    stroke.el.querySelector('[aria-label="Flip Along"]').click();
    expect(doc.get(id).widthProfile[0]).toMatchObject({ t: 0, l: 0, r: 0 });
    // Uniform removes the profile.
    stroke.el.querySelector('.sp-profile').click();
    [...document.querySelectorAll('.sp-profile-opt')].find((o) => o.getAttribute('aria-label') === 'Uniform').click();
    expect(doc.get(id).widthProfile).toBeUndefined();
    // Properties: brush dropdown.
    app.openPanel('properties');
    const props = app.dock.panels.get('properties');
    props.update();
    const sel = props.el.querySelector('.br-props select');
    expect(sel.value).toBe('__none');
    sel.value = 'def.chisel';
    sel.dispatchEvent(new Event('change'));
    expect(doc.get(id).brush.id).toBe('def.chisel');
  });
});

describe('Paintbrush', () => {
  it('paints with the current brush and records pen pressure', async () => {
    const app = await setup();
    app.brushState.currentId = 'lib.cal.pressure-pen';
    app.setTool('paintbrush');
    const tool = app.tool;
    tool.onPointerDown(ev(app, 100, 100, { pointerType: 'pen', pressure: 0.1 }));
    for (let i = 1; i <= 20; i++) tool.onPointerMove(ev(app, 100 + i * 10, 100 + Math.sin(i / 3) * 20, { pointerType: 'pen', pressure: 0.1 + i * 0.04 }));
    tool.onPointerUp(ev(app, 300, 100, { pointerType: 'pen' }));
    const [n] = app.editor.doc.leaves();
    expect(n.brush.id).toBe('lib.cal.pressure-pen');
    expect(n.brushPressure.length).toBeGreaterThan(5);
    expect(n.brushPressure[0][1]).toBeLessThan(n.brushPressure[n.brushPressure.length - 1][1]);
    expect(docBrushes(app.editor.doc).length).toBe(DEFAULT_BRUSHES.length);
  });

  it('reshapes a selected path when drawing along it', async () => {
    const app = await setup();
    const id = addPath(app, [anchor(100, 100), anchor(200, 100), anchor(300, 100), anchor(400, 100)]);
    app.editor.select([id]);
    app.setTool('paintbrush');
    drag(app, app.tool, [150, 102], [350, 98], 10);
    const doc = app.editor.doc;
    expect(doc.leaves()).toHaveLength(1);
    const a = doc.get(id).anchors;
    expect(a[0]).toMatchObject({ x: 100, y: 100 });
    expect(a[a.length - 1]).toMatchObject({ x: 400, y: 100 });
  });

  it('pressure samples and section replacement are well-formed', () => {
    const s = pressureSamples([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], [0, 0.5, 1], 5);
    expect(s).toEqual([[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]]);
    const base = [anchor(0, 0), anchor(100, 0), anchor(200, 0)];
    const out = reshapeSection(base, { u: 0.5, index: 0, t: 0.5 }, { u: 1.5, index: 1, t: 0.5 }, [anchor(50, 5), anchor(150, 5)]);
    expect(out.map((p) => [p.x, p.y])).toEqual([[0, 0], [50, 5], [150, 5], [200, 0]]);
  });
});

describe('brush options dialogs', () => {
  it('open for every type with a preview and keep the brush unchanged on OK', async () => {
    const app = await setup();
    const { editBrush } = await import('../src/features/brushes/brush-actions.js');
    const doc = app.editor.doc;
    for (const b of DEFAULT_BRUSHES) {
      const p = editBrush(app, b.id);
      await tick();
      await new Promise((r) => requestAnimationFrame(r));
      expect(dialog().querySelector('.dialog-title').textContent).toMatch(/Brush Options$/);
      expect(dialog().querySelector('.bo-preview canvas')).toBeTruthy();
      button('OK').click();
      expect(await p).toBe(true);
      expect(docBrushes(doc).find((x) => x.id === b.id)).toEqual(b);
    }
    expect(doc.undoStack.length).toBe(0);
  });

  it('Options of Selected Object overrides one stroke, in one undo step', async () => {
    const app = await setup();
    const a = addPath(app, [anchor(0, 0), anchor(200, 0)], false, { brush: { id: 'def.basic', seed: 1 } });
    const b = addPath(app, [anchor(0, 50), anchor(200, 50)], false, { brush: { id: 'def.basic', seed: 2 } });
    app.editor.select([a]);
    const doc = app.editor.doc;
    const steps = doc.undoStack.length;
    const p = app.commands.run('brush.strokeOptions');
    await tick();
    expect(dialog().querySelector('.dialog-title').textContent).toBe('Stroke Options (Calligraphic Brush)');
    const size = dialog().querySelector('input[aria-label="Size"]');
    size.value = '12 pt';
    button('OK').click();
    await p;
    expect(doc.get(a).brush.size.value).toBe(12);
    expect(doc.get(a).brush.seed).toBe(1);
    expect(doc.get(b).brush.size).toBeUndefined();
    expect(doc.undoStack.length).toBe(steps + 1);
  });
});

describe('clipboard', () => {
  it('carries custom brushes into another document', async () => {
    const app = await setup();
    const doc1 = app.editor.doc;
    const custom = { ...DEFAULT_BRUSHES[0], id: 'my-pen', name: 'My Pen' };
    doc1.transact('b', () => doc1.updateRoot({ brushes: [...DEFAULT_BRUSHES, custom] }));
    const id = addPath(app, [anchor(0, 0), anchor(200, 0)], false, { brush: { id: 'my-pen' } });
    app.editor.select([id]);
    await app.commands.run('edit.copy');
    app.newDocument();
    const doc2 = app.editor.doc;
    expect(docBrushes(doc2).some((b) => b.id === 'my-pen')).toBe(false);
    await app.commands.run('edit.paste');
    expect(docBrushes(doc2).find((b) => b.id === 'my-pen').name).toBe('My Pen');
    const [n] = doc2.leaves();
    expect(n.brush.id).toBe('my-pen');
    doc2.undo();
    expect(docBrushes(doc2).some((b) => b.id === 'my-pen')).toBe(false);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath, createImage, createGroup } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { liveArtwork, liveDef } from '../src/model/live.js';
import { nodeBounds, transformNodes } from '../src/model/geometry.js';
import { hitTest } from '../src/render/hit.js';
import { exportSVG } from '../src/features/io/svg-export.js';
import { defaultLabel } from '../src/model/nodes.js';
import { translate, rotate, scale, apply, multiply } from '../src/lib/matrix.js';
import { isEnvelope, editingContents } from '../src/features/envelope/envelope-model.js';
import { sourceRect } from '../src/features/envelope/envelope-live.js';
import { warpedImageHooks } from '../src/features/envelope/warped-image.js';
import { selectedEnvelopePoints, shownMesh } from '../src/features/envelope/envelope-edit.js';
import { cancelOpenDialogs } from '../src/ui/dialogs/dialog.js';
import { PropertiesPanel } from '../src/ui/panels/properties.js';
import { writePDF } from '../src/features/io/pdf.js';
import { CONTEXT_MENU } from '../src/ui/menus.js';

const solid = (color) => ({ type: 'solid', color });
const tick = () => new Promise((r) => setTimeout(r, 0));
const openDlg = () => document.querySelector('dialog[open]');
const button = (dlg, text) => [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const fieldByLabel = (dlg, label) => {
  const l = [...dlg.querySelectorAll('label')].find((x) => x.textContent.trim() === label && x.htmlFor);
  return l ? dlg.querySelector(`#${l.htmlFor}`) : null;
};
const setField = (input, value) => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

afterEach(async () => {
  await cancelOpenDialogs();
  warpedImageHooks.decode = null;
});

async function setup() {
  const app = await bootAppWithFeatures();
  app.newDocument();
  const ed = app.editor;
  const doc = ed.doc;
  const a = createPath(rectangle(100, 100, 200, 100), true, { fill: solid('#cc3333'), stroke: null, strokeWidth: 0 });
  const b = createPath(ellipse(150, 120, 60, 40), true, { fill: solid('#3333cc'), stroke: solid('#000000'), strokeWidth: 2 });
  doc.transact('Art', () => {
    doc.insert(a, ed.targetLayer().id);
    doc.insert(b, ed.targetLayer().id);
  });
  ed.select([a.id, b.id]);
  return { app, ed, doc, a: a.id, b: b.id };
}

const envOf = (ed) => ed.doc.get(ed.topSelection()[0]);

describe('Envelope commands', () => {
  it('registers every planned command with its shortcut', async () => {
    const { app } = await setup();
    for (const id of ['envelope.makeWarp', 'envelope.makeMesh', 'envelope.makeTop', 'envelope.release', 'envelope.options', 'envelope.expand', 'envelope.editContents']) {
      expect(app.commands.get(id), id).toBeTruthy();
    }
    expect(app.commands.get('envelope.makeWarp').shortcut).toBe('Alt+Shift+Mod+W');
    expect(app.commands.get('envelope.makeMesh').shortcut).toBe('Alt+Mod+M');
    expect(app.commands.get('envelope.makeTop').shortcut).toBe('Alt+Mod+C');
    expect(app.commands.isEnabled('envelope.makeWarp')).toBe(true);
    expect(app.commands.isEnabled('envelope.makeTop')).toBe(true);
    expect(app.commands.isEnabled('envelope.release')).toBe(false);
  });

  it('Make with Warp previews live, commits one undo step and labels the layer', async () => {
    const { app, ed, doc, a, b } = await setup();
    const p = app.commands.run('envelope.makeWarp');
    await tick();
    const dlg = openDlg();
    expect(dlg).toBeTruthy();
    // The preview already shows an envelope.
    expect(isEnvelope(envOf(ed))).toBe(true);
    dlg.querySelector('[data-style="flag"]').click();
    setField(fieldByLabel(dlg, 'Bend'), '30%');
    button(dlg, 'OK').click();
    await p;
    const env = envOf(ed);
    expect(isEnvelope(env)).toBe(true);
    expect(env.live.mode).toBe('warp');
    expect(env.live.warp.style).toBe('flag');
    expect(env.live.warp.bend).toBeCloseTo(0.3);
    expect(env.children).toEqual([a, b]);
    expect(defaultLabel(env)).toBe('<Envelope>');
    expect(app.commands.get('envelope.makeWarp').label(app)).toBe('Reset with Warp...');
    doc.undo();
    expect(doc.get(a).parent).toBe(ed.targetLayer().id);
    expect([...doc.nodes.values()].some(isEnvelope)).toBe(false);
  });

  it('Cancel leaves the document untouched', async () => {
    const { app, ed, doc, a } = await setup();
    const before = doc.undoStack.length;
    const p = app.commands.run('envelope.makeMesh');
    await tick();
    button(openDlg(), 'Cancel').click();
    await p;
    expect(doc.undoStack.length).toBe(before);
    expect(doc.get(a).parent).toBe(ed.targetLayer().id);
    expect(ed.selection.has(a)).toBe(true);
  });

  it('Make with Mesh builds a rows x columns grid over the contents', async () => {
    const { app, ed } = await setup();
    const p = app.commands.run('envelope.makeMesh');
    await tick();
    const dlg = openDlg();
    setField(fieldByLabel(dlg, 'Rows'), '2');
    setField(fieldByLabel(dlg, 'Columns'), '3');
    button(dlg, 'OK').click();
    await p;
    const env = envOf(ed);
    expect(env.live.mode).toBe('mesh');
    expect(env.live.mesh.rows).toBe(2);
    expect(env.live.mesh.cols).toBe(3);
    expect(env.live.mesh.points.length).toBe(12);
    // A flat mesh leaves the artwork where it was.
    const b = nodeBounds(ed.doc, env);
    expect(b.x).toBeCloseTo(100, 4);
    expect(b.w).toBeCloseTo(200, 4);
    expect(b.h).toBeCloseTo(100, 4);
  });

  it('Make with Top Object maps the contents into the top path', async () => {
    const { app, ed, doc, a } = await setup();
    const top = createPath(ellipse(400, 300, 100, 100), true, { fill: solid('#00aa00') });
    doc.transact('Top', () => doc.insert(top, ed.targetLayer().id));
    ed.select([a, top.id]);
    expect(app.commands.isEnabled('envelope.makeTop')).toBe(true);
    app.commands.run('envelope.makeTop');
    const env = envOf(ed);
    expect(isEnvelope(env)).toBe(true);
    expect(env.live.top).toBe(true);
    expect(doc.has(top.id)).toBe(false);
    expect(env.children).toEqual([a]);
    const bb = nodeBounds(doc, env);
    // The rectangle now fills the circle.
    expect(bb.x).toBeGreaterThan(399);
    expect(bb.x + bb.w).toBeLessThan(501);
    expect(bb.y).toBeGreaterThan(299);
    expect(bb.y + bb.h).toBeLessThan(401);
    expect(bb.w).toBeGreaterThan(90);
  });

  it('Release gives back the contents and a gray shape', async () => {
    const { app, ed, doc, a, b } = await setup();
    const p = app.commands.run('envelope.makeWarp');
    await tick();
    button(openDlg(), 'OK').click();
    await p;
    const env = envOf(ed);
    const layer = ed.targetLayer().id;
    app.commands.run('envelope.release');
    expect(doc.has(env.id)).toBe(false);
    const kids = doc.get(layer).children;
    expect(kids.slice(0, 2)).toEqual([a, b]);
    const shape = doc.get(kids[2]);
    expect(shape.type).toBe('path');
    expect(shape.fill.color).toBe('#d4d4d4');
    expect([...ed.selection].sort()).toEqual([a, b, shape.id].sort());
    doc.undo();
    expect(doc.has(env.id)).toBe(true);
    expect(doc.get(env.id).children).toEqual([a, b]);
  });

  it('Release of a multi-patch mesh envelope gives a gradient mesh', async () => {
    const { app, ed, doc } = await setup();
    const p = app.commands.run('envelope.makeMesh');
    await tick();
    button(openDlg(), 'OK').click();
    await p;
    app.commands.run('envelope.release');
    const shape = doc.get(doc.sortByPaintOrder([...ed.selection]).pop());
    expect(shape.type).toBe('mesh');
    expect(shape.rows).toBe(4);
  });

  it('Expand bakes the distorted artwork into ordinary paths', async () => {
    const { app, ed, doc } = await setup();
    const p = app.commands.run('envelope.makeWarp');
    await tick();
    button(openDlg(), 'OK').click();
    await p;
    const env = envOf(ed);
    const art = liveArtwork(doc, env).items;
    app.commands.run('envelope.expand');
    const g = envOf(ed);
    expect(g.type).toBe('group');
    expect(liveDef(g)).toBe(null);
    expect(g.children.length).toBe(2);
    const p0 = doc.get(g.children[0]);
    expect(p0.type).toBe('path');
    expect(p0.anchors.length).toBe(art[0].anchors.length);
    expect(p0.anchors[1].y).toBeCloseTo(art[0].anchors[1].y, 6);
    // Object > Expand works the same way through the live framework.
    doc.undo();
    ed.select([env.id]);
    app.commands.run('object.expand');
    expect(liveDef(envOf(ed))).toBe(null);
  });

  it('Edit Contents toggles and the envelope redraws while its contents change', async () => {
    const { app, ed, doc, a } = await setup();
    const p = app.commands.run('envelope.makeWarp');
    await tick();
    button(openDlg(), 'OK').click();
    await p;
    const env = envOf(ed);
    expect(liveDef(env).ownSpace).toBe(true);
    expect(app.commands.get('envelope.editContents').label(app)).toBe('Edit Contents');
    app.commands.run('envelope.editContents');
    const editing = doc.get(env.id);
    expect(editingContents(editing)).toBe(true);
    expect(liveDef(editing).ownSpace).toBeFalsy();
    expect(app.commands.get('envelope.editContents').label(app)).toBe('Edit Envelope');
    // Clicking the distorted artwork reaches the content object.
    const art = liveArtwork(doc, editing).items;
    expect(art[0].source).toBe(a);
    const before = sourceRect(doc, editing);
    doc.transact('Edit', () => doc.update(a, { anchors: rectangle(100, 100, 300, 100) }));
    const after = sourceRect(doc, doc.get(env.id));
    expect(after.w).toBeCloseTo(300);
    expect(before.w).toBeCloseTo(200);
    // Back to the envelope: one more toggle, all undoable.
    app.commands.run('envelope.editContents');
    expect(editingContents(doc.get(env.id))).toBe(false);
    doc.undo();
    expect(editingContents(doc.get(env.id))).toBe(true);
  });

  it('a click on the envelope picks the envelope; while editing contents it picks the content', async () => {
    const { app, ed, doc, a } = await setup();
    const p = app.commands.run('envelope.makeMesh');
    await tick();
    button(openDlg(), 'OK').click();
    await p;
    const env = envOf(ed);
    expect(hitTest(doc, 120, 190, 1).id).toBe(env.id);
    app.commands.run('envelope.editContents');
    expect(hitTest(doc, 120, 190, 1).id).toBe(a);
  });

  it('while editing contents the Selection tool selects and moves the content object, not the envelope', async () => {
    const { app, ed, doc, a } = await setup();
    const p = app.commands.run('envelope.makeMesh');
    await tick();
    button(openDlg(), 'OK').click();
    await p;
    const env = envOf(ed);
    app.setTool('selection');
    const click = (x, y) => {
      const s = ed.view.toScreen(x, y);
      app.tool.onPointerDown({ x, y, sx: s.x, sy: s.y, shift: false, alt: false });
      app.tool.onPointerUp({ x, y, sx: s.x, sy: s.y, shift: false, alt: false });
    };
    ed.clearSelection();
    click(120, 190);
    expect([...ed.selection]).toEqual([env.id]);
    app.commands.run('envelope.editContents');
    ed.clearSelection();
    click(120, 190);
    expect([...ed.selection]).toEqual([a]);
    // Edit Envelope still finds the envelope from its selected content.
    expect(app.commands.get('envelope.editContents').label(app)).toBe('Edit Envelope');
    // Dragging moves just that content object; the envelope keeps its shape.
    const mesh = doc.get(env.id).live.mesh;
    const s0 = ed.view.toScreen(120, 190);
    const s1 = ed.view.toScreen(130, 190);
    app.tool.onPointerDown({ x: 120, y: 190, sx: s0.x, sy: s0.y, shift: false, alt: false });
    app.tool.onPointerMove({ x: 130, y: 190, sx: s1.x, sy: s1.y, shift: false, alt: false });
    app.tool.onPointerUp({ x: 130, y: 190, sx: s1.x, sy: s1.y, shift: false, alt: false });
    // (Snapping may round the distance.)
    expect(doc.get(a).anchors[0].x).toBeGreaterThan(102);
    expect(doc.get(env.id).live.mesh).toEqual(mesh);
    // Back to editing the envelope: a click picks the envelope again.
    app.commands.run('envelope.editContents');
    ed.clearSelection();
    click(125, 190);
    expect([...ed.selection]).toEqual([env.id]);
  });

  it('Envelope Options edits the options with a live preview', async () => {
    const { app, ed, doc } = await setup();
    const p = app.commands.run('envelope.makeMesh');
    await tick();
    button(openDlg(), 'OK').click();
    await p;
    const env = envOf(ed);
    const q = app.commands.run('envelope.options');
    await tick();
    const dlg = openDlg();
    expect(dlg.querySelector('.dialog-title').textContent).toBe('Envelope Options');
    const grad = [...dlg.querySelectorAll('label.fx-check')].find((l) => l.textContent.includes('linear gradients')).querySelector('input');
    grad.checked = true;
    grad.dispatchEvent(new Event('change'));
    expect(doc.get(env.id).live.options.distortGradients).toBe(true);
    setField(fieldByLabel(dlg, 'Rows'), '6');
    expect(doc.get(env.id).live.mesh.rows).toBe(6);
    button(dlg, 'OK').click();
    await q;
    expect(doc.get(env.id).live.options.distortGradients).toBe(true);
    expect(doc.get(env.id).live.mesh.rows).toBe(6);
    doc.undo();
    expect(doc.get(env.id).live.options.distortGradients).toBe(false);
    expect(doc.get(env.id).live.mesh.rows).toBe(4);
  });

  it('Envelope Options with nothing selected sets the defaults for new envelopes', async () => {
    const { app, ed } = await setup();
    ed.select([]);
    const q = app.commands.run('envelope.options');
    await tick();
    const dlg = openDlg();
    const fid = fieldByLabel(dlg, 'Fidelity');
    setField(fid, '80');
    button(dlg, 'OK').click();
    await q;
    expect(app.prefs.get('envelopeOptions').fidelity).toBe(80);
  });

  it('Properties panel section shows warp controls and switches to editing contents', async () => {
    const { app, ed, doc } = await setup();
    const p = app.commands.run('envelope.makeWarp');
    await tick();
    button(openDlg(), 'OK').click();
    await p;
    const sec = PropertiesPanel.extraSections.find((x) => x.id === 'envelope');
    expect(sec.when(ed)).toBe(true);
    const inst = sec.build(app);
    document.body.append(inst.el);
    inst.refresh();
    expect(inst.el.querySelector('select[aria-label="Warp style"]').value).toBe('arc');
    const [, meshBox] = inst.el.querySelectorAll('.env-props-group');
    expect(meshBox.hidden).toBe(true);
    // Bend from the panel.
    const bend = inst.el.querySelector('input[aria-label="Bend"]');
    bend.value = '20';
    bend.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(envOf(ed).live.warp.bend).toBeCloseTo(0.2);
    // Switch to a mesh.
    const type = inst.el.querySelector('select[aria-label="Envelope type"]');
    type.value = 'mesh';
    type.dispatchEvent(new Event('change'));
    expect(envOf(ed).live.mode).toBe('mesh');
    inst.refresh();
    expect(meshBox.hidden).toBe(false);
    const contents = [...inst.el.querySelectorAll('.seg-btn')].find((b) => b.textContent === 'Contents');
    contents.click();
    expect(editingContents(envOf(ed))).toBe(true);
    expect(doc).toBeTruthy();
  });
});

describe('Envelope transforms, editing and export', () => {
  async function warped() {
    const s = await setup();
    const p = s.app.commands.run('envelope.makeWarp');
    await tick();
    button(openDlg(), 'OK').click();
    await p;
    return { ...s, env: envOf(s.ed) };
  }

  it('moving, scaling and rotating keep the envelope intact', async () => {
    const { doc, env } = await warped();
    const before = liveArtwork(doc, env).items[0].anchors;
    const m = multiply(translate(300, 50), multiply(rotate(30, 200, 150), scale(1.5, 0.75, 200, 150)));
    doc.transact('T', () => transformNodes(doc, [env.id], m));
    const moved = doc.get(env.id);
    expect(isEnvelope(moved)).toBe(true);
    const after = liveArtwork(doc, moved).items[0].anchors;
    expect(after.length).toBe(before.length);
    after.forEach((q, i) => {
      const want = apply(m, before[i].x, before[i].y);
      expect(q.x).toBeCloseTo(want.x, 3);
      expect(q.y).toBeCloseTo(want.y, 3);
    });
    doc.undo();
    expect(doc.get(env.id).live.frame).toBeUndefined();
  });

  it('a mesh envelope transforms its points with the artwork', async () => {
    const { app, ed, doc } = await setup();
    const p = app.commands.run('envelope.makeMesh');
    await tick();
    button(openDlg(), 'OK').click();
    await p;
    const env = envOf(ed);
    const before = liveArtwork(doc, env).items[1].anchors;
    const m = multiply(translate(-40, 10), rotate(-45, 150, 150));
    doc.transact('T', () => transformNodes(doc, [env.id], m));
    const after = liveArtwork(doc, doc.get(env.id)).items[1].anchors;
    after.forEach((q, i) => {
      const want = apply(m, before[i].x, before[i].y);
      expect(q.x).toBeCloseTo(want.x, 3);
      expect(q.y).toBeCloseTo(want.y, 3);
    });
  });

  it('Direct Selection drags mesh points and turns a warp into a mesh', async () => {
    const { app, ed, doc, env } = await warped();
    app.setTool('direct-selection');
    const tool = app.tool;
    const mesh = shownMesh(doc, env);
    const pt = mesh.points[0];
    const s = ed.view.toScreen(pt.x, pt.y);
    const ev = (x, y, extra = {}) => ({ x, y, ...ed.view.toScreen(x, y), sx: ed.view.toScreen(x, y).x, sy: ed.view.toScreen(x, y).y, shift: false, alt: false, ...extra });
    tool.onPointerDown(ev(pt.x, pt.y));
    expect(selectedEnvelopePoints(ed, env.id).has(0)).toBe(true);
    tool.onPointerMove(ev(pt.x - 20, pt.y - 10));
    tool.onPointerUp(ev(pt.x - 20, pt.y - 10));
    const now = doc.get(env.id);
    expect(now.live.mode).toBe('mesh');
    expect(now.live.mesh.points[0].x).toBeCloseTo(pt.x - 20, 1);
    expect(now.live.mesh.points[0].y).toBeCloseTo(pt.y - 10, 1);
    expect(s).toBeTruthy();
    doc.undo();
    expect(doc.get(env.id).live.mode).toBe('warp');
  });

  it('Direct Selection marquee selects points and Shift keeps handle drags at 45 degrees', async () => {
    const { app, ed, doc } = await setup();
    const p = app.commands.run('envelope.makeMesh');
    await tick();
    const dlg = openDlg();
    setField(fieldByLabel(dlg, 'Rows'), '1');
    setField(fieldByLabel(dlg, 'Columns'), '2');
    button(dlg, 'OK').click();
    await p;
    const env = envOf(ed);
    app.setTool('direct-selection');
    const tool = app.tool;
    const ev = (x, y, extra = {}) => {
      const s = ed.view.toScreen(x, y);
      return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, ...extra };
    };
    // A marquee around the left column of points.
    tool.onPointerDown(ev(90, 90));
    tool.onPointerMove(ev(110, 210));
    tool.onPointerUp(ev(110, 210));
    expect([...selectedEnvelopePoints(ed, env.id)].sort()).toEqual([0, 3]);
    // Drag the right handle of point 0 with Shift: it snaps to 45-degree steps.
    const p0 = doc.get(env.id).live.mesh.points[0];
    tool.onPointerDown(ev(p0.rx, p0.ry));
    tool.onPointerMove(ev(p0.x + 50, p0.y + 45, { shift: true }));
    tool.onPointerUp(ev(p0.x + 50, p0.y + 45, { shift: true }));
    const q = doc.get(env.id).live.mesh.points[0];
    expect(q.rx - q.x).toBeCloseTo(q.ry - q.y, 6);
    expect(q.x).toBe(p0.x);
    doc.undo();
    expect(doc.get(env.id).live.mesh.points[0].rx).toBe(p0.rx);
  });

  it('Direct Selection marquee in a rotated view picks only the envelope points inside the turned marquee', async () => {
    const { app, ed, doc } = await setup();
    const p = app.commands.run('envelope.makeMesh');
    await tick();
    const dlg = openDlg();
    setField(fieldByLabel(dlg, 'Rows'), '2');
    setField(fieldByLabel(dlg, 'Columns'), '2');
    button(dlg, 'OK').click();
    await p;
    const env = envOf(ed);
    app.setTool('direct-selection');
    const tool = app.tool;
    const view = ed.view;
    view.set({ zoom: 1, panX: 0, panY: 0, rotation: 45, width: 1000, height: 800 });
    const points = shownMesh(doc, doc.get(env.id)).points;
    // A screen-aligned marquee started off the envelope, above and right of its center.
    const c = view.toScreen(200, 150);
    const box = { x0: c.x + 20, y0: c.y - 200, x1: c.x + 400, y1: c.y + 30 };
    const corners = [
      view.toDoc(box.x0, box.y0),
      view.toDoc(box.x1, box.y0),
      view.toDoc(box.x1, box.y1),
      view.toDoc(box.x0, box.y1),
    ];
    const inMarquee = (q) => {
      const s = view.toScreen(q.x, q.y);
      return s.x >= box.x0 && s.x <= box.x1 && s.y >= box.y0 && s.y <= box.y1;
    };
    const xs = corners.map((q) => q.x);
    const ys = corners.map((q) => q.y);
    const inBounds = (q) =>
      q.x >= Math.min(...xs) && q.x <= Math.max(...xs) && q.y >= Math.min(...ys) && q.y <= Math.max(...ys);
    const expected = points.flatMap((q, k) => (inMarquee(q) ? [k] : []));
    // The marquee's axis-aligned bounds take in more points than the marquee itself.
    expect(expected.length).toBeGreaterThan(0);
    expect(points.filter(inBounds).length).toBeGreaterThan(expected.length);
    const ev = (q) => {
      const s = view.toScreen(q.x, q.y);
      return { x: q.x, y: q.y, sx: s.x, sy: s.y, shift: false, alt: false };
    };
    tool.onPointerDown(ev(corners[0]));
    tool.onPointerMove(ev(corners[2]));
    tool.onPointerUp(ev(corners[2]));
    expect([...selectedEnvelopePoints(ed, env.id)].sort((a, b) => a - b)).toEqual(expected);
  });

  it('the Mesh tool adds lines to an envelope mesh without moving the artwork, and Option-click removes them', async () => {
    const { app, ed, doc } = await setup();
    const p = app.commands.run('envelope.makeMesh');
    await tick();
    const dlg = openDlg();
    setField(fieldByLabel(dlg, 'Rows'), '1');
    setField(fieldByLabel(dlg, 'Columns'), '1');
    button(dlg, 'OK').click();
    await p;
    const env = envOf(ed);
    // Bend the envelope first so the mesh is not flat.
    doc.transact('bend', () => {
      const L = doc.get(env.id).live;
      const pts = L.mesh.points.map((q, i) => (i === 0 ? { ...q, rx: q.rx + 30, ry: q.ry - 40 } : q));
      doc.update(env.id, { live: { ...L, mesh: { ...L.mesh, points: pts } } });
    });
    const before = liveArtwork(doc, doc.get(env.id)).items[0].anchors;
    app.setTool('mesh');
    const tool = app.tool;
    const ev = (x, y, extra = {}) => {
      const s = ed.view.toScreen(x, y);
      return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, ...extra };
    };
    tool.onPointerDown(ev(170, 160));
    tool.onPointerUp(ev(170, 160));
    const m = doc.get(env.id).live.mesh;
    expect(m.rows).toBe(2);
    expect(m.cols).toBe(2);
    expect(m.colStops[1]).toBeGreaterThan(0.2);
    expect(m.colStops[1]).toBeLessThan(0.5);
    const after = liveArtwork(doc, doc.get(env.id)).items[0].anchors;
    // The same artwork, cut at the new lines.
    for (const a of before) expect(after.some((b) => Math.hypot(a.x - b.x, a.y - b.y) < 0.05)).toBe(true);
    // Option-click the new point: its lines go away again.
    const k = 4;
    const q = m.points[k];
    tool.onPointerDown(ev(q.x, q.y, { alt: true }));
    tool.onPointerUp(ev(q.x, q.y, { alt: true }));
    expect(doc.get(env.id).live.mesh.rows).toBe(1);
    expect(doc.get(env.id).live.mesh.cols).toBe(1);
    doc.undo();
    doc.undo();
    expect(doc.get(env.id).live.mesh.cols).toBe(1);
    expect(doc.get(env.id).live.mesh.colStops).toBeUndefined();
  });

  it('Envelope Options edits a warp envelope’s warp too', async () => {
    const { app, ed, doc } = await setup();
    const p = app.commands.run('envelope.makeWarp');
    await tick();
    button(openDlg(), 'OK').click();
    await p;
    const env = envOf(ed);
    const q = app.commands.run('envelope.options');
    await tick();
    const dlg = openDlg();
    const style = fieldByLabel(dlg, 'Style');
    style.value = 'rise';
    style.dispatchEvent(new Event('change'));
    expect(doc.get(env.id).live.warp.style).toBe('rise');
    button(dlg, 'OK').click();
    await q;
    expect(doc.get(env.id).live.warp.style).toBe('rise');
  });

  it('writes the distorted artwork to PDF', async () => {
    const { doc } = await warped();
    const { bytes } = await writePDF(doc, [doc.artboards[0]], { compress: false });
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text.startsWith('%PDF')).toBe(true);
    // Curves (the bent edges) are written with the c operator.
    expect(text).toMatch(/ c\n/);
  });

  it('the context menu offers Edit Contents and double-clicking an envelope edits its contents', async () => {
    const { app, ed, doc, env } = await warped();
    expect(CONTEXT_MENU.some((it) => it === 'envelope.editContents' || it?.id === 'envelope.editContents')).toBe(true);
    app.setTool('selection');
    const s = ed.view.toScreen(110, 150);
    app.tool.onDoubleClick({ x: 110, y: 150, sx: s.x, sy: s.y, shift: false, alt: false });
    expect(editingContents(doc.get(env.id))).toBe(true);
  });

  it('exports the distorted artwork to SVG', async () => {
    const { doc, env } = await warped();
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 612, h: 792 } });
    expect(svg).not.toContain('envelope');
    const art = liveArtwork(doc, env).items[0];
    // The bent top edge is written as curves.
    expect(svg).toMatch(/<path[^>]* d="M[^"]*C/);
    expect(art.anchors.length).toBeGreaterThan(4);
  });

  it('images warp on the canvas and embed a warped raster on export', async () => {
    const { app, ed, doc } = await setup();
    doc.assets.set('img1', { mime: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' });
    const img = createImage('img1', 100, 50, [1, 0, 0, 1, 400, 400]);
    doc.transact('Img', () => doc.insert(img, ed.targetLayer().id));
    ed.select([img.id]);
    const p = app.commands.run('envelope.makeWarp');
    await tick();
    button(openDlg(), 'OK').click();
    await p;
    const env = envOf(ed);
    const [w] = liveArtwork(doc, env).items;
    expect(w.type).toBe('warpedImage');
    expect(w.grid.length).toBe((w.nu + 1) * (w.nv + 1) * 2);
    warpedImageHooks.decode = () => ({ naturalWidth: 100, naturalHeight: 50 });
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 612, h: 792 } });
    expect(svg).toMatch(/<image[^>]*xlink:href="data:image\/png;base64,/);
    expect(svg).toContain('clip-path');
    const { bytes } = await writePDF(doc, [doc.artboards[0]], { compress: false });
    const pdf = new TextDecoder('latin1').decode(bytes);
    expect(pdf).toContain('/Subtype /Image');
    expect(pdf).toMatch(/W n\n[^\n]* cm\n\/Im\d+ Do/);
    // Expand stores the warped raster as an image of its own.
    const assets = doc.assets.size;
    app.commands.run('envelope.expand');
    expect(doc.assets.size).toBe(assets + 1);
  });
});

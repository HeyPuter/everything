import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath, createGroup, createImage } from '../src/model/nodes.js';
import { rectangle, shapeAnchors } from '../src/model/shapes.js';
import { taskbarContext } from '../src/features/artboards/taskbar.js';

let app;
beforeEach(async () => {
  app = await bootAppWithFeatures();
  app.newDocument();
  app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
});

const settle = () => new Promise((r) => setTimeout(r, 40));

function add(node, descendants = []) {
  const doc = app.editor.doc;
  doc.transact('Add', () => doc.insert(node, app.editor.targetLayer().id, Infinity, descendants));
  return node.id;
}

const path = () => createPath(rectangle(0, 0, 50, 50), true, { fill: { type: 'solid', color: '#ff0000' } });
const shape = () => {
  const s = { kind: 'rect', cx: 100, cy: 100, w: 80, h: 40, radii: [0, 0, 0, 0], angle: 0 };
  return createPath(shapeAnchors(s), true, { fill: { type: 'solid', color: '#00ff00' } }, { shape: s });
};

async function barLabels() {
  await settle();
  return [...app.taskbar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim());
}

async function quickLabels() {
  app.openPanel('properties');
  const props = app.dock.panels.get('properties');
  props.update();
  return [...props.el.querySelectorAll('.quick-actions button')].filter((b) => !b.closest('[hidden]')).map((b) => b.textContent.trim());
}

describe('task bar', () => {
  it('names its context per selection type', () => {
    const p = add(path());
    const s = add(shape());
    const kid = path();
    const g = createGroup([kid.id], { clip: true });
    kid.parent = g.id;
    add(g, [kid]);
    const img = add(createImage('data:image/png;base64,iVBORw0KGgo=', 10, 10));
    const ctx = (ids) => {
      app.editor.select(ids);
      return taskbarContext(app.editor);
    };
    expect(ctx([])).toBe('none');
    expect(ctx([p])).toBe('path');
    expect(ctx([s])).toBe('shape');
    expect(ctx([g.id])).toBe('clip');
    expect(ctx([img])).toBe('image');
    expect(ctx([p, s])).toBe('multiple');
  });

  it('offers shape actions for a live shape and Place Image with nothing selected', async () => {
    expect(await barLabels()).toEqual(expect.arrayContaining(['Place Image', 'Select All']));
    const s = add(shape());
    app.editor.select([s]);
    const labels = await barLabels();
    expect(labels).toEqual(expect.arrayContaining(['Edit Path', 'Shape Properties', 'Expand Shape', 'Fill', 'Stroke', 'Lock']));
    app.taskbar.querySelector('[aria-label="Shape Properties"]').click();
    expect(app.dock.panels.get('properties')).toBeTruthy();
  });

  it('lists Show Properties Panel, Hide, Pin and Reset in its options menu', async () => {
    await settle();
    app.taskbar.querySelector('[aria-label="More options"]').click();
    const items = [...document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')].map((i) => i.textContent);
    for (const label of ['Show Properties Panel', 'Hide Bar', 'Pin Bar Position', 'Reset Bar Position']) expect(items.some((t) => t.includes(label)), label).toBe(true);
  });
});

describe('Properties panel quick actions', () => {
  it('match the selection type', async () => {
    const p = add(path());
    const s = add(shape());
    app.editor.select([p]);
    let q = await quickLabels();
    expect(q).toEqual(expect.arrayContaining(['Offset Path', 'Recolor', 'Arrange']));
    expect(q).not.toContain('Expand Shape');
    app.editor.select([s]);
    q = await quickLabels();
    expect(q).toContain('Expand Shape');
    app.editor.select([p, s]);
    q = await quickLabels();
    expect(q).toEqual(expect.arrayContaining(['Group', 'Make Clipping Mask', 'Arrange']));
    const img = add(createImage('data:image/png;base64,iVBORw0KGgo=', 10, 10));
    app.editor.select([img]);
    q = await quickLabels();
    expect(q).toContain('Crop Image');
    expect(q).not.toContain('Recolor');
  });

  it('opens the snapping preferences from the document properties', async () => {
    app.editor.clearSelection();
    app.openPanel('properties');
    const props = app.dock.panels.get('properties');
    props.update();
    let args = null;
    const run = app.commands.run.bind(app.commands);
    app.commands.run = (id, a) => {
      if (id === 'edit.preferences') {
        args = a;
        return null;
      }
      return run(id, a);
    };
    [...props.el.querySelectorAll('button')].find((b) => b.textContent === 'Snapping Preferences...').click();
    expect(args).toEqual({ section: 'alignment' });
  });
});

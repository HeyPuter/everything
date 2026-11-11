// Paste in Front and Paste in Back next to objects inside compound paths and clipping masks.
import { describe, it, expect, beforeEach } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

describe('Paste in Front / in Back inside containers', () => {
  let app;
  let ed;
  let doc;
  let copied;
  const add = (x, size) => {
    const p = createPath(rectangle(x, x, size, size), true);
    doc.transact('Rect', () => doc.insert(p, ed.targetLayer().id));
    return p.id;
  };
  beforeEach(async () => {
    app = bootApp();
    ed = app.newDocument();
    doc = ed.doc;
    copied = add(200, 10);
    ed.select([copied]);
    await app.commands.run('object.group');
    await app.commands.run('edit.copy');
  });

  it('pastes next to a compound path, never into it, when one of its subpaths is selected', async () => {
    const outer = add(0, 100);
    const inner = add(25, 50);
    ed.select([outer, inner]);
    await app.commands.run('object.compoundMake');
    const [compound] = ed.selection;
    const layer = ed.targetLayer().id;
    ed.selectAnchors(outer, [0]);
    await app.commands.run('edit.pasteFront');
    const [front] = ed.selection;
    ed.selectAnchors(inner, [0]);
    await app.commands.run('edit.pasteBack');
    const [back] = ed.selection;
    expect(doc.get(compound).children).toEqual([outer, inner]);
    const kids = doc.get(layer).children;
    expect(kids.slice(-3)).toEqual([back, compound, front]);
    expect(doc.get(front).type).toBe('group');
  });

  it('keeps the clipping path clipping when pasting in front of it', async () => {
    const art = add(0, 100);
    const mask = add(25, 50);
    ed.select([art, mask]);
    await app.commands.run('object.clipMake');
    const [clip] = ed.selection;
    ed.selectAnchors(mask, [0]);
    await app.commands.run('edit.pasteFront');
    const [pasted] = ed.selection;
    expect(doc.get(clip).children).toEqual([art, pasted, mask]);
  });
});

describe('new artwork in an isolated clip group', () => {
  it('goes below the clipping path when drawn or pasted', async () => {
    const app = bootApp();
    const ed = app.newDocument();
    ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    const doc = ed.doc;
    const add = (x, size) => {
      const p = createPath(rectangle(x, x, size, size), true);
      doc.transact('Rect', () => doc.insert(p, ed.targetLayer().id));
      return p.id;
    };
    const art = add(0, 100);
    const mask = add(25, 50);
    ed.select([art, mask]);
    await app.commands.run('object.clipMake');
    const [clip] = ed.selection;
    await app.commands.run('edit.copy');
    await app.commands.run('object.isolate');
    const ev = (x, y) => ({ x, y, sx: x, sy: y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {} });
    app.setTool('rectangle');
    app.tool.onPointerDown(ev(30, 30));
    app.tool.onPointerMove(ev(45, 45));
    app.tool.onPointerUp(ev(60, 60));
    const [drawn] = ed.selection;
    expect(doc.get(clip).children).toEqual([art, drawn, mask]);
    for (const cmd of ['edit.pasteInPlace', 'edit.pasteAll']) {
      await app.commands.run(cmd);
      const kids = doc.get(clip).children;
      expect(kids[kids.length - 1]).toBe(mask);
      expect(kids).toContain([...ed.selection][0]);
    }
  });
});

describe('new artwork while a compound subpath is isolated', () => {
  it('wraps the whole compound path, never puts a group inside it', async () => {
    const app = bootApp();
    const ed = app.newDocument();
    ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    const doc = ed.doc;
    const add = (x, size) => {
      const p = createPath(rectangle(x, x, size, size), true);
      doc.transact('Rect', () => doc.insert(p, ed.targetLayer().id));
      return p.id;
    };
    const outer = add(0, 100);
    const inner = add(25, 50);
    ed.select([outer, inner]);
    await app.commands.run('object.compoundMake');
    const [compound] = ed.selection;
    ed.selectAnchors(outer, [0]);
    await app.commands.run('object.isolate');
    const ev = (x, y) => ({ x, y, sx: x, sy: y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {} });
    app.setTool('rectangle');
    app.tool.onPointerDown(ev(200, 200));
    app.tool.onPointerMove(ev(220, 220));
    app.tool.onPointerUp(ev(250, 250));
    const [drawn] = ed.selection;
    expect(doc.get(compound).children).toEqual([outer, inner]);
    const wrapper = doc.get(ed.isolation);
    expect(wrapper.type).toBe('group');
    expect(wrapper.children).toEqual([compound, drawn]);
    await app.commands.run('edit.undo');
    expect(doc.get(compound).parent).toBe(ed.targetLayer().id);
  });
});

// Several open documents: closing, switching and what stays with each one.
import { describe, it, expect } from 'vitest';
import { bootApp, bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { addPattern, findPattern, newPatternId, patternPaint } from '../src/features/patterns/model.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('closing documents', () => {
  it('a second close of the same unsaved document never closes another one', async () => {
    const app = bootApp();
    const a = app.newDocument();
    const b = app.newDocument();
    const c = app.newDocument();
    app.activate(a);
    a.doc.transact('Rect', () => a.doc.insert(createPath(rectangle(0, 0, 10, 10), true), a.targetLayer().id));
    // Two closes pending on the save prompt (a double click, or Close All while one is open).
    const first = app.closeDocument(a);
    const second = app.closeDocument(a);
    await tick();
    for (const dialog of document.querySelectorAll('dialog[open]')) {
      [...dialog.querySelectorAll('button')].find((x) => /Don.t Save/.test(x.textContent)).click();
      await tick();
    }
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(app.editors).toEqual([b, c]);
  });
});

describe('per-document state', () => {
  it('Reselect brings back what was deselected in this document, never another tab', async () => {
    const app = bootApp();
    const add = (ed) => {
      const p = createPath(rectangle(0, 0, 10, 10), true);
      ed.doc.transact('Rect', () => ed.doc.insert(p, ed.targetLayer().id));
      return p.id;
    };
    const a = app.newDocument();
    const inA = add(a);
    a.select([inA]);
    await app.commands.run('select.none');
    const b = app.newDocument();
    const inB = add(b);
    b.select([inB]);
    expect(app.commands.isEnabled('select.reselect')).toBe(false);
    await app.commands.run('select.reselect');
    expect([...b.selection]).toEqual([inB]);
    app.activate(a);
    await app.commands.run('select.reselect');
    expect([...a.selection]).toEqual([inA]);
  });
});

describe('pasting into another document', () => {
  it('brings along the pattern definitions the artwork is painted with', async () => {
    const app = await bootAppWithFeatures();
    const a = app.newDocument();
    const inner = newPatternId();
    const outer = newPatternId();
    const dot = createPath(rectangle(0, 0, 5, 5), true);
    const tile = createPath(rectangle(0, 0, 8, 8), true, { fill: patternPaint(inner) });
    a.doc.transact('Patterns', () => {
      addPattern(a.doc, { id: inner, name: 'Dots', width: 10, height: 10, art: { roots: [dot.id], nodes: [dot] } });
      addPattern(a.doc, { id: outer, name: 'Tiles', width: 10, height: 10, art: { roots: [tile.id], nodes: [tile] } });
    });
    const p = createPath(rectangle(0, 0, 50, 50), true, { fill: patternPaint(outer) });
    a.doc.transact('Rect', () => a.doc.insert(p, a.targetLayer().id));
    a.select([p.id]);
    await app.commands.run('edit.copy');
    const b = app.newDocument();
    await app.commands.run('edit.paste', { internal: true });
    expect(b.selectedNodes()[0].fill.id).toBe(outer);
    expect(findPattern(b.doc, outer)?.name).toBe('Tiles');
    expect(findPattern(b.doc, inner)?.name).toBe('Dots');
    // One undo takes the paste and the definitions it brought.
    await app.commands.run('edit.undo');
    expect(findPattern(b.doc, outer)).toBe(null);
  });
});

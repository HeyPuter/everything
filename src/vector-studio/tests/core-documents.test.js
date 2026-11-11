// Several open documents: closing, switching and what stays with each one.
import { describe, it, expect } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

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

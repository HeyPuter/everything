import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootApp } from './helpers.js';
import { ActionEngine } from '../src/features/panels/actions-model.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

let app, engine;
beforeAll(() => {
  app = bootApp();
  engine = new ActionEngine(app);
  engine.sets = [{ id: 'set', name: 'Test', actions: [{ id: 'action', name: 'Two edits', steps: [
    { id: 'one', kind: 'style', on: true, patch: { opacity: 0.5 } },
    { id: 'two', kind: 'style', on: true, patch: { opacity: 0.25 } },
  ] }] }];
});
beforeEach(async () => {
  vi.useFakeTimers();
  for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
  app.prefs.set('actionPlayback', { mode: 'pause', pause: 1 });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function drawing() {
  const ed = app.newDocument();
  const path = createPath(rectangle(0, 0, 40, 40), true);
  ed.doc.transact('Add', () => ed.doc.insert(path, ed.targetLayer().id));
  ed.select([path.id]);
  return { ed, path };
}

describe('Play on All Open Documents lifecycle', () => {
  it('skips documents closed while an earlier document is playing', async () => {
    const first = drawing();
    const queued = drawing();
    app.activate(first.ed);
    const pending = engine.playOnAll('action');
    await vi.advanceTimersByTimeAsync(0);
    await app.closeDocument(queued.ed, { force: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual([{ ok: true, done: 2 }]);
    expect(app.views.has(queued.ed)).toBe(false);
    expect(app.editor === first.ed).toBe(true);
  });

  it('keeps the document the user chose when they interrupt a batch', async () => {
    const first = drawing();
    const chosen = drawing();
    app.activate(first.ed);
    const pending = engine.playOnAll('action');
    await vi.advanceTimersByTimeAsync(0);
    app.activate(chosen.ed);
    await vi.advanceTimersByTimeAsync(1000);
    const results = await pending;
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(app.editor === chosen.ed).toBe(true);
    expect(chosen.ed.doc.get(chosen.path.id).opacity).toBe(1);
  });

  it('does not resume a batch after switching away and back', async () => {
    const first = drawing();
    const second = drawing();
    const pending = engine.playOnAll('action');
    await vi.advanceTimersByTimeAsync(0);
    app.activate(second.ed);
    app.activate(first.ed);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toHaveLength(1);
    expect(app.editor === first.ed).toBe(true);
    expect(first.ed.doc.get(first.path.id).opacity).toBe(0.5);
    expect(second.ed.doc.get(second.path.id).opacity).toBe(1);
  });

  it('still visits every open document and restores the original active document on completion', async () => {
    const first = drawing();
    const second = drawing();
    const pending = engine.playOnAll('action');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual([{ ok: true, done: 2 }, { ok: true, done: 2 }]);
    expect(app.editor === second.ed).toBe(true);
    for (const { ed, path } of [first, second]) expect(ed.doc.get(path.id).opacity).toBe(0.25);
  });
});

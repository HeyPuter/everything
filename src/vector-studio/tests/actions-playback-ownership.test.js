import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootApp } from './helpers.js';
import { ActionEngine } from '../src/features/panels/actions-model.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

let app, engine;
beforeAll(() => {
  app = bootApp();
  engine = new ActionEngine(app);
  app.notify = vi.fn();
  engine.sets = [{ id: 'set', name: 'Test', actions: [{ id: 'action', name: 'Two edits', steps: [
    { id: 'one', kind: 'style', on: true, patch: { opacity: 0.5 } },
    { id: 'two', kind: 'style', on: true, patch: { opacity: 0.25 } },
  ] }] }];
});
beforeEach(() => {
  vi.useFakeTimers();
  app.prefs.set('actionPlayback', { mode: 'pause', pause: 1 });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
function drawing() {
  const ed = app.newDocument();
  const path = createPath(rectangle(0, 0, 40, 40), true);
  ed.doc.transact('Add', () => ed.doc.insert(path, ed.targetLayer().id));
  ed.select([path.id]);
  return { ed, path };
}

describe('action playback document ownership', () => {
  it.each(['switch', 'switch back', 'close'])('stops remaining edits after a document %s during a pause', async (change) => {
    const first = drawing();
    const other = drawing();
    app.activate(first.ed);
    const pending = engine.play('action');
    await vi.advanceTimersByTimeAsync(0);
    expect(first.ed.doc.get(first.path.id).opacity).toBe(0.5);
    if (change === 'close') await app.closeDocument(first.ed, { force: true });
    else {
      app.activate(other.ed);
      if (change === 'switch back') app.activate(first.ed);
    }
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.done).toBe(1);
    expect(first.ed.doc.get(first.path.id).opacity).toBe(0.5);
    expect(other.ed.doc.get(other.path.id).opacity).toBe(1);
    expect(engine.playing).toBe(false);
  });

  it('plays both edits and permits undo when the document stays active', async () => {
    const { ed, path } = drawing();
    const pending = engine.play('action');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ ok: true, done: 2 });
    expect(ed.doc.get(path.id).opacity).toBe(0.25);
    ed.doc.undo();
    expect(ed.doc.get(path.id).opacity).toBe(0.5);
  });
});

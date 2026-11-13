import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootApp } from './helpers.js';
import { ActionEngine } from '../src/features/panels/actions-model.js';
import { UserError } from '../src/lib/errors.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

let app, engine;
beforeAll(() => {
  app = bootApp();
  engine = new ActionEngine(app);
  app.notify = vi.fn();
  app.commands.register({ id: 'test.failure', label: 'Failed operation', run: () => { throw new UserError('Cannot complete this operation.'); } });
  engine.sets = [{ id: 'set', name: 'Test', actions: [{ id: 'action', name: 'Fail then edit', steps: [
    { id: 'one', kind: 'command', cmd: 'test.failure', label: 'Failed operation', on: true },
    { id: 'two', kind: 'style', on: true, patch: { opacity: 0.25 } },
  ] }] }];
});
beforeEach(() => {
  app.prefs.set('actionPlayback', { mode: 'accelerated' });
  app.notify.mockClear();
});
function drawing() {
  const ed = app.newDocument();
  const path = createPath(rectangle(0, 0, 40, 40), true);
  ed.doc.transact('Add', () => ed.doc.insert(path, ed.targetLayer().id));
  ed.select([path.id]);
  return { ed, path };
}

describe('failed action steps', () => {
  it('stops after a command throws instead of editing with an incomplete preceding step', async () => {
    const { ed, path } = drawing();
    const result = await engine.play('action');
    expect(result).toMatchObject({ ok: false, done: 0, stoppedAt: 0, message: 'Cannot complete this operation.' });
    expect(ed.doc.get(path.id).opacity).toBe(1);
    expect(app.notify).toHaveBeenCalledTimes(1);
    expect(app.notify.mock.calls[0][0]).toContain('step 1');
    expect(engine.playing).toBe(false);
  });

  it('still reports ordinary menu command failures without rejecting', async () => {
    drawing();
    await expect(app.commands.run('test.failure')).resolves.toBeUndefined();
    expect(app.notify).toHaveBeenCalledExactlyOnceWith('Cannot complete this operation.', { error: true });
  });

  it('reports a read-only direct edit as a stopped action without rejecting', async () => {
    const { ed, path } = drawing();
    ed.doc.readOnly = true;
    const result = await engine.play('action', { from: 1 });
    expect(result).toMatchObject({ ok: false, done: 0, stoppedAt: 0 });
    expect(result.message).toContain('view only');
    expect(ed.doc.get(path.id).opacity).toBe(1);
    expect(engine.playing).toBe(false);
  });
});

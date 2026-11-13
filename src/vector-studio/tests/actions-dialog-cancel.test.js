import { beforeAll, describe, expect, it } from 'vitest';
import { bootApp } from './helpers.js';
import { ActionEngine } from '../src/features/panels/actions-model.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

let app, engine;
beforeAll(() => {
  app = bootApp();
  engine = new ActionEngine(app);
  app.commands.register({ id: 'test.dialog', label: 'Options', run: () => app.dialogs.form({ title: 'Step Options', fields: [{ key: 'value', label: 'Value', type: 'text', value: 'original' }] }) });
});
function setup(recorded, modal = true) {
  const ed = app.newDocument();
  const path = createPath(rectangle(0, 0, 40, 40), true);
  ed.doc.transact('Add', () => ed.doc.insert(path, ed.targetLayer().id));
  ed.select([path.id]);
  engine.sets = [{ id: 'set', name: 'Test', actions: [{ id: 'action', name: 'Options then edit', steps: [
    { id: 'one', kind: 'command', cmd: 'test.dialog', label: 'Options', on: true, modal, dialogs: recorded ? [{ title: 'Step Options', value: { value: 'recorded' } }] : [] },
    { id: 'two', kind: 'style', on: true, patch: { opacity: 0.25 } },
  ] }] }];
  return { ed, path };
}
function answer(label) {
  const dialog = document.querySelector('dialog[open]');
  expect(dialog).not.toBeNull();
  [...dialog.querySelectorAll('button')].find((button) => button.textContent === label).click();
}

describe('action playback dialog cancellation', () => {
  it.each([true, false])('stops after cancelling a command dialog (recorded values: %s)', async (recorded) => {
    const { ed, path } = setup(recorded);
    const pending = engine.play('action');
    answer('Cancel');
    expect(await pending).toEqual({ ok: false, done: 0, stoppedAt: 0 });
    expect(ed.doc.get(path.id).opacity).toBe(1);
    expect(engine.queue).toBeNull();
    expect(engine.playing).toBe(false);
  });

  it('continues after accepting a visible dialog', async () => {
    const { ed, path } = setup(true);
    const pending = engine.play('action');
    answer('OK');
    expect(await pending).toEqual({ ok: true, done: 2 });
    expect(ed.doc.get(path.id).opacity).toBe(0.25);
  });

  it('still replays stored values without showing a dialog', async () => {
    const { ed, path } = setup(true, false);
    expect(await engine.play('action')).toEqual({ ok: true, done: 2 });
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(ed.doc.get(path.id).opacity).toBe(0.25);
  });
});

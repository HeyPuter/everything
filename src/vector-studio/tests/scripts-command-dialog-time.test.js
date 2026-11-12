import { describe, it, expect, beforeAll } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { runScript } from '../src/features/scripts/runner.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

let app;
beforeAll(async () => {
  app = await bootAppWithFeatures();
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function openDialogEl() {
  for (let i = 0; i < 100; i++) {
    const d = document.querySelector('dialog[open]');
    if (d) return d;
    await tick(10);
  }
  return null;
}

function start(source, timeoutMs) {
  const ed = app.newDocument();
  const r = createPath(rectangle(0, 0, 50, 50), true, { fill: { type: 'solid', color: '#f00' } });
  ed.doc.transact('r', () => ed.doc.insert(r, ed.targetLayer().id));
  ed.select([r.id]);
  const run = runScript(app, source, { name: 'Nudge', timeoutMs });
  const frame = document.querySelector('iframe[sandbox]');
  // The script side (the sandboxed frame in a browser) is played by the test.
  const send = (data) =>
    window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));
  let settled = false;
  run.then(() => (settled = true));
  return { run, send, isSettled: () => settled, ed, id: r.id };
}

describe('script time limit and command dialogs', () => {
  it('does not count the time a command waits on its own dialog', async () => {
    const { run, send, isSettled, ed, id } = start(
      'await vs.command("object.transform.move");',
      400,
    );
    send({ __vs: 'call', id: 1, method: 'command', args: ['object.transform.move'] });
    const dlg = await openDialogEl();
    expect(dlg).toBeTruthy();
    // The user takes longer than the time limit to fill in the dialog.
    await tick(800);
    expect(isSettled()).toBe(false);
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await tick(20);
    send({ __vs: 'done', value: 'moved' });
    expect(await run).toMatchObject({ ok: true, value: 'moved' });
    expect(ed.doc.get(id)).toBeTruthy();
  });

  it('still stops a script that runs too long after the dialog closes', async () => {
    const { run, send } = start('await vs.command("object.transform.move"); for (;;);', 300);
    send({ __vs: 'call', id: 1, method: 'command', args: ['object.transform.move'] });
    const dlg = await openDialogEl();
    await tick(500);
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
    // The script side never reports done: the limit stops it.
    const res = await run;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/longer than/);
  });
});

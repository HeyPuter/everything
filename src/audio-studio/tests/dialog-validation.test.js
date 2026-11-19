import { afterEach, expect, it } from 'vitest';
import { App } from '../src/app.js';
import { installCore } from '../src/features/core.js';
import { installMultitrack } from '../src/features/multitrack.js';
import { Session } from '../src/model/session.js';

afterEach(() => document.querySelectorAll('.dialog-backdrop').forEach((d) => d.remove()));

function setup() {
  HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  localStorage.clear();
  const app = new App();
  installCore(app);
  installMultitrack(app);
  app.syncGraph = () => {};
  const doc = app.addDocument(new Session({ name: 'S.asesx', sampleRate: 48000, tracks: 1 }));
  return { app, doc };
}
const dialog = () => [...document.querySelectorAll('.dialog')].pop();
const ok = () => dialog().querySelector('.dialog-foot .btn.primary').click();
const tick = () => new Promise((r) => setTimeout(r, 0));

it('Add Tracks needs something to add and remembers the last choice', async () => {
  const { app, doc } = setup();
  const run = app.commands.run('mt.addTracks');
  await tick();
  const audio = dialog().querySelector('[aria-label="Number of audio tracks"]');
  const add = dialog().querySelector('.dialog-foot .btn.primary');
  audio.value = '0';
  audio.dispatchEvent(new Event('input'));
  expect(add.disabled).toBe(true);
  audio.value = '2';
  audio.dispatchEvent(new Event('input'));
  expect(add.disabled).toBe(false);
  dialog().querySelector('[aria-label="Audio track channels"]').value = '1';
  ok();
  await run;
  expect(doc.state.tracks).toHaveLength(3);
  expect(doc.state.tracks.at(-1).channels).toBe(1);
  const again = app.commands.run('mt.addTracks');
  expect(dialog().querySelector('[aria-label="Number of audio tracks"]').value).toBe('2');
  expect(dialog().querySelector('[aria-label="Audio track channels"]').value).toBe('1');
  [...dialog().querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Cancel').click();
  await again;
});

it('Session Properties refuses an empty or out-of-range tempo instead of guessing', async () => {
  const { app, doc } = setup();
  const run = app.commands.run('mt.sessionProperties');
  const tempo = dialog().querySelector('[aria-label="Tempo"]');
  tempo.value = '';
  ok();
  await tick();
  expect(dialog().querySelector('.dlg-error').textContent).toContain('tempo');
  expect(document.activeElement).toBe(tempo);
  tempo.value = '96';
  ok();
  await run;
  expect(doc.state.tempo).toBe(96);
});

it('Edit Workspaces puts keyboard focus in the workspace list', async () => {
  const { app } = setup();
  app.layoutMode = 'desktop';
  app.dock = { layout: () => ({}) };
  app.setWorkspace = () => {};
  app.workspaceNames ??= () => ['Default'];
  const done = app.commands.run('workspace.edit');
  await tick();
  expect(document.activeElement?.classList.contains('ws-list')).toBe(true);
  [...dialog().querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Cancel').click();
  await done;
});

import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { addClips, createClip } from '../src/model/session-edits.js';
import { SessionBackupStore, installSessionBackup, sessionRestoreDialog } from '../src/storage/session-backup.js';
import { MemDir } from './helpers/mem-opfs.js';

const controllers = [];
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('Blob', NodeBlob);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  controllers.splice(0).forEach((c) => c.destroy());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
const click = (label) => [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === label).click();
function app() {
  const result = new App();
  result.syncGraph = vi.fn();
  result.notify = vi.fn();
  return result;
}
async function setup() {
  const original = app();
  for (const [name, value] of [['A', 0.25], ['B', -0.5]]) {
    const doc = new Session({ name: `${name}.asesx`, sampleRate: 8000, tracks: 1 });
    const sourceId = doc.addSource({ name: `${name}.wav`, channels: [Channel.fromSamples(new Float32Array(32).fill(value))] });
    doc.apply('Insert', addClips(doc.state, [createClip({ sourceId, trackId: doc.state.tracks[0].id, length: 32 })]));
    original.addDocument(doc);
  }
  const root = new MemDir();
  const store = new SessionBackupStore(async () => root);
  let time = Date.now();
  const prior = installSessionBackup(original, { store, tab: 'ended', now: () => time++ });
  controllers.push(prior);
  await prior.run();
  prior.destroy();
  const current = app();
  const ctl = installSessionBackup(current, { store, tab: 'current' });
  controllers.push(ctl);
  return { current, ctl, store };
}
function expectRestored(docs) {
  for (const doc of docs) {
    expect(doc.dirty).toBe(true);
    expect(doc.sampleRate).toBe(8000);
    const value = doc.name.startsWith('A') ? 0.25 : -0.5;
    expect([...doc.pool.get(doc.state.clips[0].sourceId).channels[0].toArray()]).toEqual(Array(32).fill(value));
  }
}

it.each(['unchecked', 'none checked', 'Not Now', 'Escape', 'Close', 'failed', 'all'])('keeps unfinished session recovery available after %s', async (choice) => {
  const { current, ctl, store } = await setup();
  const original = (await store.list()).find((m) => m.name === 'B.asesx');
  if (choice === 'failed') await store.writeManifest({ ...original, text: '{' });
  const offered = await ctl.check();
  expect(offered).toHaveLength(2);
  const pending = sessionRestoreDialog(current, ctl, offered);
  if (choice === 'unchecked') document.querySelector('[aria-label="Restore B.asesx"]').click();
  if (choice === 'none checked') document.querySelectorAll('input[type=checkbox]').forEach((el) => el.click());
  if (choice === 'Not Now') click('Not Now');
  else if (choice === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  else if (choice === 'Close') document.querySelector('button[aria-label="Close"]').click();
  else click('Restore');
  const restored = await pending;
  const expected = choice === 'all' ? [] : ['unchecked', 'failed'].includes(choice) ? ['B.asesx'] : ['A.asesx', 'B.asesx'];
  expect(restored).toHaveLength(2 - expected.length);
  expectRestored(restored);
  expect((await ctl.check()).map((m) => m.name).sort()).toEqual(expected);
  expect(await store.list()).toHaveLength(2);
  expect(current.notify.mock.calls.filter(([, options]) => options?.error)).toHaveLength(choice === 'failed' ? 1 : 0);

  // Deferred sessions and a repaired failed session can be restored next time.
  if (choice === 'failed') await store.writeManifest(original);
  const remaining = await ctl.check();
  if (remaining.length) {
    const retry = sessionRestoreDialog(current, ctl, remaining);
    click('Restore');
    const retried = await retry;
    expect(retried).toHaveLength(expected.length);
    expectRestored(retried);
  }
  expect(await ctl.check()).toEqual([]);
  // Successfully restored backups remain available in manual backup history.
  expect(await store.list()).toHaveLength(2);
});

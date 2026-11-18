import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { installEffectCommands } from '../src/effects/commands.js';
import { registerEffect } from '../src/effects/registry.js';
import { applyFavorite } from '../src/effects/favorites.js';

let release;
registerEffect({
  id: 'pendingFavoriteGain', name: 'Pending Favorite Gain', group: 'Special', kind: null, params: [],
  process: ({ channels }) => new Promise((resolve) => {
    release = () => resolve(channels.map((c) => c.map((x) => x * 2)));
  }),
});
registerEffect({
  id: 'nextFavoriteGain', name: 'Next Favorite Gain', group: 'Special', kind: null, params: [],
  process: async ({ channels }) => channels.map((c) => c.map((x) => x * 2)),
});
const file = (name) => new AudioFile({ name, sampleRate: 1000, channels: [Channel.fromSamples(new Float32Array(32).fill(0.25))] });
const select = { start: 8, end: 16, length: 32, rate: 1000, mode: 'relative' };
const favorite = (type) => ({ name: 'Two steps', action: { type: 'sequence', steps: [
  { type: 'effect', effect: 'pendingFavoriteGain', values: {} },
  type === 'command' ? { type, command: 'fx.normalizePeak', args: { peak: 0 }, select } : { type, effect: 'nextFavoriteGain', values: {}, select },
] } });
function setup() {
  localStorage.clear();
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installEffectCommands(app);
  const doc = app.addDocument(file('First.wav'));
  const other = app.addDocument(file('Other.wav'), { activate: false });
  release = null;
  return { app, doc, other };
}
afterEach(() => document.body.replaceChildren());

it.each(['command', 'effect'])('does not redirect a later %s step to another file after a tab switch', async (type) => {
  const { app, doc, other } = setup();
  const before = other.state;
  const selection = { ...other.selection };
  const done = applyFavorite(app, favorite(type));
  expect(release).toBeTypeOf('function');
  app.activate(other);
  release();
  const result = await done;
  expect(other.state === before).toBe(true);
  expect(other.selection).toEqual(selection);
  expect(app.active === other).toBe(true);
  expect(result).toBe(false);
  expect(app.notify).toHaveBeenCalledWith('The favorite stopped because the active file changed. Completed steps were kept.', { error: true });
  expect(doc.state.channels[0].toArray(0, 1)[0]).toBe(0.5);
});

it('does not apply the remaining steps to the next tab when the original file closes', async () => {
  const { app, doc, other } = setup();
  const before = other.state;
  const done = applyFavorite(app, favorite('command'));
  expect(await app.closeDocument(doc)).toBe(true);
  expect(app.active === other).toBe(true);
  release();
  const result = await done;
  expect(other.state === before).toBe(true);
  expect(other.hasSelection).toBe(false);
  expect(result).toBe(false);
});

it('still applies all steps to the original file and retains one Undo step per edit', async () => {
  const { app, doc } = setup();
  const before = doc.state;
  const done = applyFavorite(app, favorite('command'));
  release();
  expect(await done).toBe(true);
  expect(doc.state.channels[0].toArray(8, 9)[0]).toBe(1);
  expect(doc.state.channels[0].toArray(0, 1)[0]).toBe(0.5);
  doc.history.undo();
  expect(doc.state.channels[0].toArray(8, 9)[0]).toBe(0.5);
  doc.history.undo();
  expect(doc.state === before).toBe(true);
  expect(app.notify).not.toHaveBeenCalled();
});

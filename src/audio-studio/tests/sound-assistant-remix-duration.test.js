// Sound Assistant Duration for music clips: the Remix method hands the target
// length to the clip remixer instead of stretching.
import { it, expect, vi } from 'vitest';
import './fx-wasm.js';
import '../src/effects/index.js';
import { fakeApp } from './fx-helpers.js';
import { Channel } from '../src/audio/channel.js';
import { Session } from '../src/model/session.js';
import { createClip, addClips, findClip, updateClips } from '../src/model/session-edits.js';
import { soundAssistantPanel } from '../src/sound-assistant/panel.js';
import { revertDurationClips, clipPatch } from '../src/sound-assistant/ops.js';
import { defaultSettings, setPath } from '../src/sound-assistant/model.js';

const remixCalls = vi.hoisted(() => []);
vi.mock('../src/multitrack/remix-commands.js', () => ({ runRemix: async (app, doc, label, id, patch) => remixCalls.push({ label, id, patch }) }));
vi.mock('../src/multitrack/remix.js', () => ({ remixBlocker: () => null }));

const RATE = 8000;

function setup() {
  const s = new Session({ name: 'P.asesx', sampleRate: RATE, tracks: 1 });
  const src = s.addSource({ name: 'song', channels: [Channel.fromSamples(new Float32Array(RATE * 10))] });
  const a = createClip({ trackId: s.state.tracks[0].id, sourceId: src, start: 0, length: RATE * 10, name: 'Song' });
  s.apply('Add', addClips(s.state, [a]));
  const app = fakeApp();
  app.formatTime = (f) => String(f);
  app.documents = [s];
  app.active = s;
  s.on('change', (e) => app.emit('doc-change', s, e));
  return { s, a, app };
}

it('offers Stretch and Remix, and remixes to the target duration', async () => {
  const { s, a, app } = setup();
  const settings = setPath(setPath(setPath(defaultSettings('music'), ['duration', 'on'], true), ['duration', 'seconds'], 6), ['duration', 'method'], 'remix');
  s.apply('Type', updateClips(s.state, [a.id], clipPatch(findClip(s.state, a.id), settings)));
  const panel = soundAssistantPanel(app);
  document.body.append(panel.el);
  s.selectClips([a.id]);
  const method = panel.el.querySelector('select[aria-label="Duration method"]');
  expect([...method.options].map((o) => o.textContent)).toEqual(['Stretch', 'Remix']);
  expect(method.value).toBe('remix');
  expect(panel.el.querySelector('.sa-duration').textContent).toMatch(/rearranged at its beats/);
  panel.el.querySelector('.sa-duration .sa-action').click();
  await vi.waitFor(() => expect(remixCalls).toHaveLength(1));
  expect(remixCalls[0]).toMatchObject({ id: a.id, patch: { target: 6 * RATE } });
  panel.el.remove();
});

it('puts a stretched clip back on its own audio', () => {
  const { s, a } = setup();
  const settings = setPath(setPath(defaultSettings('music'), ['duration', 'on'], true), ['duration', 'orig'], { sourceId: a.sourceId, offset: 0, length: RATE * 10 });
  const other = s.addSource({ name: 'stretched', channels: [Channel.fromSamples(new Float32Array(RATE * 6))] });
  s.apply('Stretch', updateClips(s.state, [a.id], { ...clipPatch(findClip(s.state, a.id), settings), sourceId: other, offset: 0, length: RATE * 6 }));
  const next = revertDurationClips(s.state, [a.id]);
  const c = findClip(next, a.id);
  expect([c.sourceId, c.length]).toEqual([a.sourceId, RATE * 10]);
  expect(c.soundAssistant.duration.orig).toBe(null);
  expect(revertDurationClips(next, [a.id])).toBe(next);
});

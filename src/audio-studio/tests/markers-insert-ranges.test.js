// Markers panel: Insert Ranges into Multitrack puts one clip per range marker,
// end to end on one track, named after the markers, in one undo step.
import { it, expect, vi } from 'vitest';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';

const RATE = 1000;

it('inserts the selected range markers (or all of them) as clips', async () => {
  HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  localStorage.clear();
  const { App } = await import('../src/app.js');
  const { installCore } = await import('../src/features/core.js');
  const { installMultitrack } = await import('../src/features/multitrack.js');
  const app = new App();
  installCore(app);
  installMultitrack(app);
  app.syncGraph = () => {};
  const data = new Float32Array(RATE * 6).map((_, i) => i / (RATE * 6));
  const doc = new AudioFile({ name: 'take.wav', sampleRate: RATE, channels: [Channel.fromSamples(data)] });
  const mk = (id, name, start, duration) => ({ id, name, start, duration, type: 'cue', description: '' });
  doc.apply('Markers', { ...doc.state, markers: [mk('a', 'Intro', 0, 1000), mk('c', 'Cue', 1500, 0), mk('b', '', 3000, 500)] });
  app.addDocument(doc);
  const panel = app.panels.get('markers').create(app);
  document.body.replaceChildren(panel.el);
  const btn = panel.el.querySelector('[aria-label="Insert Ranges into Multitrack"]');
  expect(btn.disabled).toBe(false);
  btn.click();
  await vi.waitFor(() => expect(app.documents.some((d) => d.kind === 'session' && d.state.clips.length === 2)).toBe(true));
  const session = app.documents.find((d) => d.kind === 'session');
  const clips = [...session.state.clips].sort((x, y) => x.start - y.start);
  expect(clips.map((c) => c.name)).toEqual(['Intro', 'Range 2']);
  expect(clips.map((c) => [c.offset, c.length])).toEqual([[0, 1000], [3000, 500]]);
  // End to end on one track.
  expect(clips[0].trackId).toBe(clips[1].trackId);
  expect(clips[1].start).toBe(clips[0].start + 1000);
  expect(session.history.entries.at(-1).label).toBe('Insert Files');
});

it('plays a range marker\'s range from its row', async () => {
  HTMLCanvasElement.prototype.getContext = () => null;
  localStorage.clear();
  const { App } = await import('../src/app.js');
  const { installCore } = await import('../src/features/core.js');
  const app = new App();
  installCore(app);
  app.syncGraph = () => {};
  const doc = new AudioFile({ name: 't.wav', sampleRate: RATE, channels: [Channel.fromSamples(new Float32Array(RATE * 4))] });
  doc.apply('Markers', { ...doc.state, markers: [{ id: 'r', name: 'Verse', start: 1000, duration: 500, type: 'cue', description: '' }] });
  app.addDocument(doc);
  const calls = [];
  app.play = (o) => calls.push(o);
  const panel = app.panels.get('markers').create(app);
  document.body.replaceChildren(panel.el);
  panel.el.querySelector('.marker-play').click();
  expect(calls).toEqual([{ from: 1000, to: 1500, loop: false }]);
  const row = panel.el.querySelector('tr[data-id="r"]');
  row.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
  expect(calls).toHaveLength(2);
});

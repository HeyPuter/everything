// Batch Process with Export off: the favorite changes the files in the
// editor (one undoable step each) and Undo reverts the run.
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { batchPanel } from '../src/batch/panel.js';
import { processInPlace } from '../src/batch/process.js';

const NORMALIZE = { id: 'fav-norm', name: 'Normalize -6', action: { type: 'command', command: 'fx.normalizePeak', args: { peak: -6.0206 } } };

afterEach(() => document.body.replaceChildren());

function setup(count = 2) {
  localStorage.clear();
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  app.prefs.set('favorites', [NORMALIZE]);
  app.prefs.set('batchExport', { favorite: NORMALIZE.id, export: false });
  const docs = [];
  for (let i = 0; i < count; i++) {
    const d = new AudioFile({ name: `File ${i + 1}.wav`, sampleRate: 8000, channels: [Channel.fromSamples(new Float32Array(32).fill(0.25))] });
    app.addDocument(d);
    docs.push(d);
  }
  const panel = batchPanel(app);
  document.body.append(panel.el);
  panel.el.querySelector('[aria-label="Add Open Files"]').click();
  return { app, panel, docs, undo: panel.el.querySelector('.batch-undo') };
}

const sample = (doc) => doc.state.channels[0].toArray()[0];

it('applies the favorite to each open file as one undoable edit', async () => {
  const { panel, docs, undo } = setup();
  expect(panel.el.querySelector('.batch-export-check input').checked).toBe(false);
  expect(panel.el.querySelector('.batch-out').textContent).toBe('In place');
  expect(undo.hidden).toBe(true);
  await panel.api.run();
  for (const d of docs) {
    expect(sample(d)).toBeCloseTo(0.5, 3);
    expect(d.history.entries.at(-1).label).toBe('Batch Process: Normalize -6');
  }
  expect(panel.api.items.every((i) => i.status === 'done')).toBe(true);
  expect(undo.hidden).toBe(false);
  undo.click();
  for (const d of docs) expect(sample(d)).toBe(0.25);
  expect(undo.hidden).toBe(true);
});

it('leaves files edited after the run alone when undoing', async () => {
  const { panel, docs, undo } = setup();
  await panel.api.run();
  docs[1].apply('Later Edit', { ...docs[1].state, meta: { title: 'x' } });
  undo.click();
  expect(sample(docs[0])).toBe(0.25);
  expect(sample(docs[1])).toBeCloseTo(0.5, 3);
  expect(panel.el.querySelector('.batch-summary').textContent).toMatch(/1 changed since or closed/);
});

it('needs a favorite when Export is off', async () => {
  const { app, panel, docs } = setup(1);
  app.prefs.set('batchExport', { favorite: '', export: false });
  await panel.api.run();
  expect(app.notify).toHaveBeenCalledWith(expect.stringMatching(/Choose a favorite/), { error: true });
  expect(sample(docs[0])).toBe(0.25);
});

it('processes only the range of a range item and keeps the rest', async () => {
  const doc = new AudioFile({ name: 'r.wav', sampleRate: 8000, channels: [Channel.fromSamples(new Float32Array(32).fill(0.25))] });
  const r = await processInPlace({ source: { type: 'range', doc, start: 8, end: 16 } }, { favorite: NORMALIZE });
  const out = r.state.channels[0].toArray();
  expect(out.length).toBe(32);
  expect(out[0]).toBe(0.25);
  expect(out[10]).toBeCloseTo(0.5, 3);
  expect(out[20]).toBe(0.25);
  expect(r.before).toBe(doc.state);
});

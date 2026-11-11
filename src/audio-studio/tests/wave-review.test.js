// Regression tests for the Waveform editor review: data model, edits, view.
import { describe, it, expect, beforeAll } from 'vitest';
import { createMarker, markerOptions } from '../src/model/markers.js';
import * as E from '../src/model/edits.js';

/** A 2D context stand-in: every method is a no-op, every property settable. */
function fakeContext() {
  return new Proxy(
    {},
    { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) },
  );
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
});

async function makeView({ frames = 48000, channels = 2 } = {}) {
  const { App } = await import('../src/app.js');
  const { installCore } = await import('../src/features/core.js');
  const { AudioFile } = await import('../src/model/audio-file.js');
  const { Channel } = await import('../src/audio/channel.js');
  const { WaveformView } = await import('../src/editor/waveform-view.js');
  HTMLCanvasElement.prototype.getContext = (type) => (type === '2d' ? fakeContext() : null);
  localStorage.clear();
  const app = new App();
  installCore(app);
  app.syncGraph = () => {};
  const ramp = () => Float32Array.from({ length: frames }, (_, i) => (i % 100) / 100);
  const doc = new AudioFile({
    name: 'r.wav',
    sampleRate: 48000,
    channels: Array.from({ length: channels }, () => Channel.fromSamples(ramp())),
  });
  app.addDocument(doc);
  const view = new WaveformView(app, doc);
  document.body.replaceChildren(view.el);
  view.layout();
  view.width = 400;
  view.height = 200;
  view.frame();
  app.currentView = () => view;
  return { app, doc, view };
}

describe('marker dragging', () => {
  it('keeps cue and range markers inside the file when dragged past its end', async () => {
    const { doc, view } = await makeView();
    const cue = createMarker({ start: 100 });
    const range = createMarker({ start: 200, duration: 1000 });
    doc.apply('Markers', { ...doc.state, markers: [cue, range] });
    view.moveMarker(cue.id, 60000, true);
    expect(view.markers().find((m) => m.id === cue.id).start).toBe(48000);
    view.moveMarker(cue.id, 60000, false);
    view.moveMarker(range.id, 47900, false);
    view.moveMarker(range.id, -50, false);
    const byId = (id) => doc.state.markers.find((m) => m.id === id);
    expect(byId(cue.id).start).toBe(48000);
    view.moveMarker(range.id, 47900, false);
    expect(byId(range.id).start).toBe(47000);
  });
});

describe('File > Revert', () => {
  async function revert(app) {
    const p = app.commands.run('file.revert');
    await new Promise((r) => setTimeout(r, 0));
    document.querySelector('.dialog .btn.danger').click();
    await p;
  }

  it('returns to the saved audio after the history was cleared', async () => {
    const { app, doc } = await makeView();
    doc.apply('Gain', E.gainRange(doc.state, 0, 100, 0.5));
    doc.markSaved();
    const saved = doc.state;
    doc.apply('Gain', E.gainRange(doc.state, 0, 100, 0.5));
    doc.history.clear();
    await revert(app);
    expect(doc.state).toBe(saved);
    expect(doc.dirty).toBe(false);
  });

  it('returns to the saved audio, not the opened one, after a marker change kept out of the undo history', async () => {
    const { app, doc } = await makeView();
    doc.apply('Gain', E.gainRange(doc.state, 0, 100, 0.5));
    doc.markSaved();
    const saved = doc.state;
    markerOptions.undo = false;
    try {
      doc.apply('Add Marker', { ...doc.state, markers: [createMarker({ start: 5 })] });
      expect(doc.dirty).toBe(true);
      await revert(app);
    } finally {
      markerOptions.undo = true;
    }
    expect(doc.state.channels[0]).toBe(saved.channels[0]);
    expect(doc.state.markers).toEqual([]);
    expect(doc.dirty).toBe(false);
  });
});

describe('marker navigation', () => {
  it('reaches markers one frame from the playhead', async () => {
    const { app, doc } = await makeView();
    doc.apply('Markers', {
      ...doc.state,
      markers: [createMarker({ start: 999 }), createMarker({ start: 1001 })],
    });
    doc.setCursor(1000);
    await app.commands.run('marker.previous');
    expect(doc.cursor).toBe(999);
    doc.setCursor(1000);
    await app.commands.run('marker.next');
    expect(doc.cursor).toBe(1001);
    await app.commands.run('marker.next');
    expect(doc.cursor).toBe(48000);
  });
});

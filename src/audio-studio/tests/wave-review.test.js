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

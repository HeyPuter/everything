// Regression tests for the Waveform editor review: data model, edits, view.
import { describe, it, expect, beforeAll, vi } from 'vitest';
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

describe('waveform keyboard', () => {
  it('steps the playhead from its live position while the file plays', async () => {
    const { app, doc, view } = await makeView();
    doc.setCursor(1000);
    const playing = vi.spyOn(app.engine, 'playing', 'get').mockReturnValue(true);
    const position = vi.spyOn(app.engine, 'position', 'get').mockReturnValue(30000);
    const seek = vi.spyOn(app.engine, 'seek').mockImplementation(() => {});
    try {
      view.surface.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
      const step = Math.round(view.fpp * 10);
      expect(seek).toHaveBeenCalledWith(30000 + step);
      expect(doc.cursor).toBe(30000 + step);
    } finally {
      playing.mockRestore();
      position.mockRestore();
      seek.mockRestore();
    }
  });
});

describe('overview navigator edge drags', () => {
  function drag(o, from, to) {
    const ev = (type, x) => {
      const e = new MouseEvent(type, { clientX: x, button: 0, bubbles: true });
      Object.defineProperty(e, 'offsetX', { value: x });
      Object.defineProperty(e, 'pointerId', { value: 1 });
      return e;
    };
    o.el.setPointerCapture = () => {};
    o.el.dispatchEvent(ev('pointerdown', from));
    o.el.dispatchEvent(ev('pointermove', to));
    o.el.dispatchEvent(ev('pointerup', to));
  }

  it('stops at the file ends instead of moving the opposite edge', async () => {
    const { doc, view } = await makeView({ frames: 100000 });
    const o = view.overview;
    o.resize(1000, 20);
    doc.setView(20000, 60000);
    drag(o, 200, -100); // left grip far past the start
    expect(doc.view).toMatchObject({ start: 0, end: 60000 });
    doc.setView(20000, 60000);
    drag(o, 600, 1300); // right grip far past the end
    expect(doc.view).toMatchObject({ start: 20000, end: 100000 });
  });
});

describe('pasting into some channels', () => {
  it('grows the file instead of cutting off a clip that runs past the end', async () => {
    const { Channel } = await import('../src/audio/channel.js');
    const ch = (a) => Channel.fromSamples(Float32Array.from(a));
    const state = { sampleRate: 1000, channels: [ch([1, 2, 3, 4]), ch([5, 6, 7, 8])], markers: [] };
    const clip = { channels: [ch([-1, -2, -3])] };
    const out = E.insertClip(state, 3, clip, [false, true]);
    expect(Array.from(out.channels[0].toArray())).toEqual([1, 2, 3, 4, 0, 0]);
    expect(Array.from(out.channels[1].toArray())).toEqual([5, 6, 7, -1, -2, -3]);
    // Inside the file the clip still overwrites without changing the length.
    const mid = E.insertClip(state, 1, clip, [true, false]);
    expect(Array.from(mid.channels[0].toArray())).toEqual([1, -1, -2, -3]);
    expect(Array.from(mid.channels[1].toArray())).toEqual([5, 6, 7, 8]);
  });
});

describe('time ruler at sample-level zoom', () => {
  it('still labels ticks when the view spans less than a millisecond', async () => {
    const { rulerTicks } = await import('../src/editor/time-ruler.js');
    const { rulerLabel } = await import('../src/lib/time.js');
    // 16 frames at 48 kHz (the deepest zoom) across 657 px.
    const t0 = 204576 / 48000;
    const { step, ticks } = rulerTicks(t0, t0 + 16 / 48000, 657);
    expect(ticks.length).toBeGreaterThan(2);
    const labels = ticks.map((s) => rulerLabel(s, step));
    expect(new Set(labels).size).toBe(labels.length);
    expect(rulerLabel(3599.50005, 0.00005)).toBe('59:59.50005');
    // Coarser steps keep their labels.
    expect(rulerLabel(12.25, 0.01)).toBe('12.25');
    expect(rulerLabel(1.5, 1)).toBe('1.5');
  });
});

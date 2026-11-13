// Regression tests for the third Waveform editor review.
import { describe, it, expect, beforeAll } from 'vitest';

/** A 2D context stand-in: every method is a no-op, every property settable. */
function fakeContext() {
  return new Proxy(
    {},
    {
      get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 10 }) : () => {}),
      set: (t, k, v) => ((t[k] = v), true),
    },
  );
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
});

async function makeView({ frames = 48000, channels = 2, silent = false } = {}) {
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
    channels: Array.from({ length: channels }, () =>
      silent ? Channel.silence(frames) : Channel.fromSamples(ramp()),
    ),
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

/** A pointer event at (x, y) with offset coordinates (jsdom has no layout). */
function pointer(type, x, y = 10) {
  const e = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
  Object.defineProperty(e, 'offsetX', { value: x });
  Object.defineProperty(e, 'offsetY', { value: y });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  return e;
}

describe('overview navigator on a long file', () => {
  it('scrolls when the narrow frame of a zoomed-in view is dragged, and zooms from just outside it', async () => {
    const { doc, view } = await makeView({ frames: 48000 * 3600, channels: 1, silent: true });
    const o = view.overview;
    o.resize(1000, 20);
    o.el.setPointerCapture = () => {};
    const drag = (from, to) => {
      o.el.dispatchEvent(pointer('pointerdown', from));
      o.el.dispatchEvent(pointer('pointermove', to));
      o.el.dispatchEvent(pointer('pointerup', to));
    };
    // Two seconds of an hour: the frame is drawn 6 px wide at x = 500.
    doc.setView(48000 * 1800, 48000 * 1802);
    drag(501, 601);
    expect(doc.view.end - doc.view.start).toBe(96000);
    expect(doc.view.start).toBeCloseTo(48000 * 2160, -3);
    // Just left of the frame is its left edge, which zooms out.
    doc.setView(48000 * 1800, 48000 * 1802);
    drag(494, 394);
    expect(doc.view.end).toBe(48000 * 1802);
    expect(doc.view.start).toBeCloseTo(48000 * 1440, -3);
  });
});

describe('time ruler marker drags', () => {
  it('leaves the marker where it was when the drag is cancelled', async () => {
    const { createMarker } = await import('../src/model/markers.js');
    const { doc, view } = await makeView();
    const m = createMarker({ start: 24000 });
    doc.apply('Add Marker', { ...doc.state, markers: [m] });
    const r = view.ruler;
    r.resize(400, 30);
    r.el.setPointerCapture = () => {};
    const steps = doc.history.entries.length;
    const x = r.xOf(24000);
    r.el.dispatchEvent(pointer('pointerdown', x, 25));
    r.el.dispatchEvent(pointer('pointermove', x + 50, 25));
    expect(view.markers()[0].start).not.toBe(24000);
    // The system took the touch (Chromium reports the last position).
    r.el.dispatchEvent(pointer('pointercancel', x + 50, 25));
    expect(doc.history.entries.length).toBe(steps);
    expect(doc.state.markers[0].start).toBe(24000);
    expect(view.markers()[0].start).toBe(24000);
    // A drag that ends normally still moves it.
    r.el.dispatchEvent(pointer('pointerdown', x, 25));
    r.el.dispatchEvent(pointer('pointermove', x + 50, 25));
    r.el.dispatchEvent(pointer('pointerup', x + 50, 25));
    expect(doc.history.entries.length).toBe(steps + 1);
    expect(doc.state.markers[0].start).toBe(Math.round(view.ruler.frameAt(x + 50)));
  });
});

describe('Copy to New and Paste to New', () => {
  it('make a file with the bit depth of the file the audio came from', async () => {
    const { app, doc } = await makeView();
    doc.info.bitDepth = 16;
    doc.setSelection(0, 1000);
    await app.commands.run('edit.copyToNew');
    expect(app.active).not.toBe(doc);
    expect(app.active.info.bitDepth).toBe(16);
    app.activate(doc);
    await app.commands.run('edit.copy');
    await app.commands.run('edit.pasteToNew');
    expect(app.active.info.bitDepth).toBe(16);
    expect(app.active.length).toBe(1000);
  });
});

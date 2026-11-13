// Regression tests for the third Waveform editor review.
import { describe, it, expect, beforeAll, vi } from 'vitest';

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

describe('touch long press on the waveform', () => {
  it('keeps the release of the press that opened the context menu from clicking an item', async () => {
    const { view } = await makeView();
    const s = view.surface;
    s.setPointerCapture = () => {};
    const touch = (type, x) => {
      const e = pointer(type, x, 50);
      Object.defineProperty(e, 'pointerType', { value: 'touch' });
      return e;
    };
    const touchEnd = () => {
      const e = new Event('touchend', { bubbles: true, cancelable: true });
      s.dispatchEvent(e);
      return e.defaultPrevented;
    };
    vi.useFakeTimers();
    try {
      s.dispatchEvent(touch('pointerdown', 300));
      vi.advanceTimersByTime(600);
    } finally {
      vi.useRealTimers();
    }
    expect(document.querySelector('[role=menu]')).not.toBe(null);
    s.dispatchEvent(touch('pointerup', 300));
    expect(touchEnd()).toBe(true);
    document.querySelector('[role=menu]').remove();
    // A plain tap still ends as usual.
    s.dispatchEvent(touch('pointerdown', 100));
    s.dispatchEvent(touch('pointerup', 100));
    expect(touchEnd()).toBe(false);
  });
});

describe('selection edges on touch', () => {
  it('grabs a selection edge a finger-width away; a mouse there starts a new selection', async () => {
    const { doc, view } = await makeView();
    const s = view.surface;
    s.setPointerCapture = () => {};
    const press = (pointerType, from, to) => {
      const ev = (type, x) => {
        const e = pointer(type, x, 100);
        Object.defineProperty(e, 'pointerType', { value: pointerType });
        return e;
      };
      s.dispatchEvent(ev('pointerdown', from));
      s.dispatchEvent(ev('pointermove', to));
      s.dispatchEvent(ev('pointerup', to));
    };
    // 400 px show 48000 frames: 120 frames per pixel.
    const select = () => doc.setSelection(view.frameAt(100), view.frameAt(200));
    select();
    press('touch', 210, 260);
    expect(doc.selection.start).toBe(Math.round(view.frameAt(100)));
    expect(doc.selection.end).toBe(Math.round(view.frameAt(260)));
    select();
    // Long enough after the first press not to count as a double-click.
    const now = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1000);
    try {
      press('mouse', 210, 260);
    } finally {
      now.mockRestore();
    }
    expect(doc.selection.start).toBe(Math.round(view.frameAt(210)));
    // A tap in the middle of a short selection places the playhead, as with a mouse.
    doc.setSelection(view.frameAt(100), view.frameAt(120));
    const later = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 2000);
    try {
      press('touch', 110, 110);
    } finally {
      later.mockRestore();
    }
    expect(doc.hasSelection).toBe(false);
    expect(doc.cursor).toBe(Math.round(view.frameAt(110)));
  });
});

describe('time ruler markers on touch', () => {
  it('grab a marker a finger-width away, the nearest one when two are close', async () => {
    const { createMarker } = await import('../src/model/markers.js');
    const { doc, view } = await makeView();
    const a = createMarker({ start: 24000 });
    const b = createMarker({ start: 24000 + 120 * 15 });
    doc.apply('Add Markers', { ...doc.state, markers: [a, b] });
    const r = view.ruler;
    r.resize(400, 30);
    r.el.setPointerCapture = () => {};
    const press = (pointerType, x) => {
      const e = pointer('pointerdown', x, 25);
      Object.defineProperty(e, 'pointerType', { value: pointerType });
      r.el.dispatchEvent(e);
      r.el.dispatchEvent(pointer('pointerup', x, 25));
    };
    const x = r.xOf(24000);
    // 10 px right of the first marker, 5 px left of the second: the second is nearer.
    press('touch', x + 10);
    expect([...view.selectedMarkers]).toEqual([b.id]);
    press('touch', x - 10);
    expect([...view.selectedMarkers]).toEqual([a.id]);
    // A mouse press 10 px away misses it and moves the playhead.
    view.selectMarker(null);
    press('mouse', x - 10);
    expect(view.selectedMarkers.size).toBe(0);
    expect(doc.cursor).toBe(Math.round(r.frameAt(x - 10)));
  });
});

describe('5.1 channel names', () => {
  it('Edit > Enable Channels and Extract Channels name the centre, LFE and surrounds', async () => {
    const { app, doc } = await makeView({ channels: 6, frames: 1000 });
    expect(app.channelMenuItems().map((i) => i.label)).toEqual([
      'Left',
      'Right',
      'Center',
      'LFE',
      'Left Surround',
      'Right Surround',
    ]);
    doc.setChannelEnabled(0, false);
    await app.commands.run('edit.extractChannels');
    const names = app.documents.filter((d) => d !== doc).map((d) => d.name);
    expect(names).toEqual(['r Right', 'r Center', 'r LFE', 'r Left Surround', 'r Right Surround']);
  });
});

describe('zooming in at the deepest zoom', () => {
  it('keeps the view in place instead of scrolling it', async () => {
    const { wheelZoom } = await import('../src/editor/view-prefs.js');
    const { app, doc } = await makeView({ frames: 480000, channels: 1 });
    doc.setView(100000, 100016);
    for (let i = 0; i < 5; i++) wheelZoom(app, doc, { deltaY: -100 }, 200, 400);
    expect(doc.view).toMatchObject({ start: 100000, end: 100016 });
    // Zoom In (Time) around the playhead.
    doc.setCursor(100004);
    for (let i = 0; i < 5; i++) await app.commands.run('view.zoomInTime');
    expect(doc.view).toMatchObject({ start: 100000, end: 100016 });
  });
});

describe('fade handle preview', () => {
  it('draws the fade curve only on the channels the fade applies to', async () => {
    const { doc, view } = await makeView({ channels: 6 });
    doc.setChannelEnabled(2, false);
    doc.setChannelEnabled(3, false);
    let strokes = 0;
    const ctx = fakeContext();
    ctx.stroke = () => strokes++;
    view.overlay.getContext = () => ctx;
    view.fadeDrag = { dir: 'in', frames: 4800, curve: 0 };
    view.invalidate('overlay');
    view.frame();
    expect(strokes).toBe(4);
  });
});

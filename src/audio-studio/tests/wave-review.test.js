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

describe('Convert Sample Type with surround files', () => {
  it('keeps every channel of a 5.1 file unless asked for mono or stereo', async () => {
    const { app, doc } = await makeView({ frames: 100, channels: 6 });
    const { convertSampleTypeDialog } = await import('../src/commands/edit-dialogs.js');
    const p = convertSampleTypeDialog(app, doc);
    const dlg = document.querySelector('.dialog');
    expect(dlg.querySelector('select[aria-label="Channels"]').value).toBe('6');
    expect(dlg.textContent).toContain('5.1');
    dlg.querySelector('.btn.primary').click();
    const state = await p;
    expect(state.channels.length).toBe(6);
  });

  it('folds a 5.1 file down to stereo with the centre and surrounds', async () => {
    const { convertChannelData } = await import('../src/commands/edit-dialogs.js');
    const one = (v) => Float32Array.of(v);
    const [l, r] = convertChannelData([one(1), one(2), one(3), one(100), one(4), one(5)], 2);
    expect(l[0]).toBeCloseTo(1 + Math.SQRT1_2 * (3 + 4));
    expect(r[0]).toBeCloseTo(2 + Math.SQRT1_2 * (3 + 5));
  });
});

describe('pasting stereo into a 5.1 file', () => {
  const six = async () => {
    const { Channel } = await import('../src/audio/channel.js');
    const ch = (v) => Channel.fromSamples(new Float32Array(4).fill(v));
    return { sampleRate: 1000, channels: [1, 2, 3, 4, 5, 6].map((v) => ch(v / 10)), markers: [] };
  };
  const stereo = async () => {
    const { Channel } = await import('../src/audio/channel.js');
    return {
      channels: [
        Channel.fromSamples(Float32Array.of(-1, -1)),
        Channel.fromSamples(Float32Array.of(-2, -2)),
      ],
    };
  };
  const at = (s, c) => Array.from(s.channels[c].toArray());

  it('puts the clip on the front pair and silence in the other channels', async () => {
    const out = E.insertClip(await six(), 1, await stereo());
    expect(at(out, 0)).toEqual([0.1, -1, -1, 0.1, 0.1, 0.1].map(Math.fround));
    expect(at(out, 1)).toEqual([0.2, -2, -2, 0.2, 0.2, 0.2].map(Math.fround));
    for (const c of [2, 3, 4, 5]) expect(at(out, c).slice(1, 3)).toEqual([0, 0]);
    // Into channels the user picked, the clip's last channel still fills the rest.
    const picked = E.insertClip(await six(), 1, await stereo(), [
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(at(picked, 2)).toEqual([0.3, -2, -2, 0.3].map(Math.fround));
  });

  it('mixes only into the front pair with Mix Paste', async () => {
    const { mixPasteState } = await import('../src/commands/edit-dialogs.js');
    const state = await six();
    const out = mixPasteState(state, 1, [Float32Array.of(1, 1), Float32Array.of(1, 1)], {
      type: 'overwrite',
    });
    expect(at(out, 0)).toEqual([0.1, 1, 1, 0.1].map(Math.fround));
    for (const c of [2, 3, 4, 5]) expect(out.channels[c]).toBe(state.channels[c]);
    const ins = mixPasteState(state, 1, [Float32Array.of(1, 1), Float32Array.of(1, 1)], {
      type: 'insert',
    });
    expect(at(ins, 3)).toEqual([0.4, 0, 0, 0.4, 0.4, 0.4].map(Math.fround));
  });
});

describe('overview scale for short files', () => {
  it('keeps the same scale while zooming', async () => {
    const { doc, view } = await makeView({ frames: 24000 });
    const o = view.overview;
    o.resize(1000, 20);
    const endX = () => {
      o.placePlayhead(doc.length);
      return o.playhead.style.transform;
    };
    const zoomedOut = endX();
    expect(zoomedOut).toBe('translateX(500px)');
    doc.setView(0, 12000);
    expect(endX()).toBe(zoomedOut);
  });
});

describe('undo across a sample rate conversion', () => {
  it('keeps the view and playhead at the same times', async () => {
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { Channel } = await import('../src/audio/channel.js');
    const doc = new AudioFile({
      name: 'c.wav',
      sampleRate: 48000,
      channels: [Channel.silence(480000)],
    });
    doc.setView(96000, 144000); // 2 s to 3 s
    doc.setCursor(120000);
    // Convert to 96 kHz the way the command does: the view and playhead are scaled with it.
    doc.view = { ...doc.view, start: 192000, end: 288000 };
    doc.apply(
      'Convert Sample Type',
      { ...doc.state, sampleRate: 96000, channels: [Channel.silence(960000)] },
      { cursor: 240000 },
    );
    expect(doc.view).toMatchObject({ start: 192000, end: 288000 });
    doc.history.undo();
    expect(doc.view).toMatchObject({ start: 96000, end: 144000 });
    expect(doc.cursor).toBe(120000);
    doc.history.redo();
    expect(doc.view).toMatchObject({ start: 192000, end: 288000 });
    expect(doc.cursor).toBe(240000);
    // Interpret Sample Rate keeps the frames, so undoing it leaves the view alone.
    doc.apply('Interpret Sample Rate', { ...doc.state, sampleRate: 44100 });
    doc.history.undo();
    expect(doc.view).toMatchObject({ start: 192000, end: 288000 });
  });
});

describe('Move Playhead to Previous/Next', () => {
  it('stops at markers and selection edges next to the playhead', async () => {
    const { app, doc } = await makeView();
    doc.apply('Markers', {
      ...doc.state,
      markers: [createMarker({ start: 1000 }), createMarker({ start: 1001 })],
    });
    doc.setCursor(1000);
    await app.commands.run('transport.next');
    expect(doc.cursor).toBe(1001);
    // Stopped: a stop 10 ms behind the playhead is not skipped.
    doc.setCursor(1480);
    await app.commands.run('transport.previous');
    expect(doc.cursor).toBe(1001);
    await app.commands.run('transport.previous');
    expect(doc.cursor).toBe(1000);
  });

  it('skips a stop just passed while playing', async () => {
    const { app, doc } = await makeView();
    doc.apply('Markers', { ...doc.state, markers: [createMarker({ start: 1000 })] });
    const playing = vi.spyOn(app.engine, 'playing', 'get').mockReturnValue(true);
    const position = vi.spyOn(app.engine, 'position', 'get').mockReturnValue(1480);
    const seek = vi.spyOn(app.engine, 'seek').mockImplementation(() => {});
    try {
      await app.commands.run('transport.previous');
      expect(seek).toHaveBeenCalledWith(0);
    } finally {
      playing.mockRestore();
      position.mockRestore();
      seek.mockRestore();
    }
  });
});

describe('locked markers', () => {
  it('are dropped or cut when the audio under them is deleted from the end', async () => {
    const { Channel } = await import('../src/audio/channel.js');
    const state = {
      sampleRate: 1000,
      channels: [Channel.silence(1000)],
      markers: [
        createMarker({ start: 100 }),
        createMarker({ start: 700 }),
        createMarker({ start: 500, duration: 400 }),
        createMarker({ start: 900, duration: 50 }),
      ],
    };
    markerOptions.lock = true;
    try {
      const out = E.deleteRange(state, 600, 1000);
      expect(out.markers.map((m) => [m.start, m.duration])).toEqual([
        [100, 0],
        [500, 100],
      ]);
      // Markers inside the file stay exactly where they were.
      expect(E.deleteRange(state, 0, 50).markers).toBe(state.markers);
    } finally {
      markerOptions.lock = false;
    }
  });
});

describe('WebGL context restore', () => {
  /** A WebGL2 stand-in: every call succeeds and returns a placeholder. */
  function stubGL() {
    return new Proxy(
      {},
      {
        get: (t, k) => {
          if (k in t) return t[k];
          if (k === 'getShaderParameter' || k === 'getProgramParameter')
            return (_, p) => (p === 'ACTIVE_UNIFORMS' ? 0 : true);
          if (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k)) return k;
          return () => ({});
        },
      },
    );
  }

  it('rebuilds resources without adding listeners each time', async () => {
    const { WaveformRenderer } = await import('../src/render/waveform-gl.js');
    const { ClipWaveRenderer } = await import('../src/render/clips-gl.js');
    for (const R of [WaveformRenderer, ClipWaveRenderer]) {
      const canvas = document.createElement('canvas');
      canvas.getContext = () => stubGL();
      const add = vi.spyOn(canvas, 'addEventListener');
      const r = new R(canvas);
      const restored = vi.fn();
      r.onRestore = restored;
      const listeners = add.mock.calls.length;
      for (let i = 0; i < 3; i++) {
        canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
        expect(r.lost).toBe(true);
        canvas.dispatchEvent(new Event('webglcontextrestored'));
        expect(r.lost).toBe(false);
      }
      expect(add.mock.calls.length).toBe(listeners);
      expect(restored).toHaveBeenCalledTimes(3);
    }
  });
});

describe('deferred peak levels', () => {
  it('fills in over several calls and ends up identical to a full build', async () => {
    const { Channel } = await import('../src/audio/channel.js');
    const { channelColumns } = await import('../src/audio/peaks.js');
    const make = () => {
      let s = 7;
      const data = Float32Array.from(
        { length: 1 << 20 },
        () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1,
      );
      return Channel.fromSamples(data);
    };
    const expected = channelColumns(make(), -1000, 2500, 500);
    const ch = make();
    let calls = 0;
    let out;
    for (;;) {
      const defer = { deadline: -Infinity, pending: new Set() };
      out = channelColumns(ch, -1000, 2500, 500, undefined, defer);
      calls++;
      if (!defer.pending.size) break;
      // Columns over blocks still waiting are blank, never wrong.
      for (let c = 0; c < 500; c++)
        if (!Number.isNaN(out[2 * c])) expect(out[2 * c]).toBe(expected[2 * c]);
      expect(calls).toBeLessThan(40);
    }
    expect(calls).toBe(16); // 16 blocks, at least one built per call
    expect(Array.from(out)).toEqual(Array.from(expected));
  });

  it('draws the view in one frame once levels exist', async () => {
    const { doc, view } = await makeView({ frames: 48000 * 30 });
    const draw = vi.spyOn(view.renderer, 'draw');
    doc.setView(0, doc.length);
    view.frame();
    for (let i = 0; i < 40 && view.dirty.wave; i++) view.frame();
    expect(view.dirty.wave).toBe(false);
    const n = draw.mock.calls.length;
    doc.setView(48000, 96000);
    view.frame();
    expect(draw.mock.calls.length).toBe(n + 1);
    expect(view.dirty.wave).toBe(false);
  });
});

describe('Markers panel during playback', () => {
  it('moves playback to a clicked marker', async () => {
    const { app, doc } = await makeView();
    const { markersPanel } = await import('../src/panels/markers.js');
    const m = createMarker({ start: 30000, name: 'Here' });
    doc.apply('Markers', { ...doc.state, markers: [m] });
    const panel = markersPanel(app);
    document.body.append(panel.el);
    const playing = vi.spyOn(app.engine, 'playing', 'get').mockReturnValue(true);
    const position = vi.spyOn(app.engine, 'position', 'get').mockReturnValue(1000);
    const seek = vi.spyOn(app.engine, 'seek').mockImplementation(() => {});
    try {
      panel.el.querySelector(`tr[data-id="${m.id}"]`).click();
      expect(seek).toHaveBeenCalledWith(30000);
      expect(doc.cursor).toBe(30000);
    } finally {
      playing.mockRestore();
      position.mockRestore();
      seek.mockRestore();
    }
  });
});

describe('selection drag past the edge', () => {
  it('keeps scrolling and extending the selection while the pointer is held there', async () => {
    vi.useFakeTimers();
    try {
      const { doc, view } = await makeView({ frames: 48000 * 60 });
      doc.setView(0, 48000 * 5);
      const s = view.surface;
      s.setPointerCapture = () => {};
      const ev = (type, x) =>
        new MouseEvent(type, { clientX: x, clientY: 100, button: 0, bubbles: true });
      const withId = (e) => Object.defineProperty(e, 'pointerId', { value: 1 });
      s.dispatchEvent(withId(ev('pointerdown', 100)));
      s.dispatchEvent(withId(ev('pointermove', 200)));
      s.dispatchEvent(withId(ev('pointermove', 440))); // 40 px past the right edge
      const first = doc.view.start;
      expect(first).toBeGreaterThan(0);
      vi.advanceTimersByTime(160);
      expect(doc.view.start).toBeGreaterThan(first);
      expect(doc.selection.end).toBeGreaterThan(doc.view.end - 1);
      s.dispatchEvent(withId(ev('pointerup', 440)));
      const stopped = doc.view.start;
      vi.advanceTimersByTime(160);
      expect(doc.view.start).toBe(stopped);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Paste while another clipboard is chosen', () => {
  it('pastes the clip and markers of the clipboard it started with', async () => {
    const { app, doc } = await makeView();
    const { Channel } = await import('../src/audio/channel.js');
    app.prefs.set('markersWithClipboard', true);
    app.clipboardIndex = 0;
    app.clipboard = {
      type: 'audio',
      sampleRate: 48000,
      channels: [Channel.silence(100)],
      markers: [createMarker({ start: 10, name: 'In clip' })],
    };
    doc.setCursor(500);
    const run = app.commands.run('edit.paste');
    app.clipboardIndex = 1; // empty
    await run;
    expect(doc.length).toBe(48100);
    expect(doc.state.markers.map((m) => [m.name, m.start])).toEqual([['In clip', 510]]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { previewRange, installPreviewEditor, zoomViewAt } from '../src/editor/preview-editor.js';
import { WaveformRenderer } from '../src/render/waveform-gl.js';
import { Emitter } from '../src/lib/emitter.js';
import { Channel } from '../src/audio/channel.js';

// The preview renders its effect through renderEffect; here it returns the audio unchanged.
vi.mock('../src/effects/apply.js', () => ({
  renderEffect: async ({ state, start, end }) => ({ state, length: end - start }),
  isAbort: () => false,
}));

const doc = (o) => ({ length: 48000 * 600, sampleRate: 48000, view: { start: 0, end: 48000 * 10 }, hasSelection: false, selection: { start: 0, end: 0 }, ...o });

describe('preview editor range', () => {
  it('previews the visible range, or the selection within it', () => {
    expect(previewRange(doc())).toEqual({ view: [0, 480000], range: [0, 480000] });
    expect(previewRange(doc({ hasSelection: true, selection: { start: 96000, end: 960000 } })).range).toEqual([96000, 480000]);
  });

  it('declines selections out of view and ranges that are too long', () => {
    expect(previewRange(doc({ hasSelection: true, selection: { start: 900000, end: 960000 } })).range).toBe(null);
    const wide = previewRange(doc({ view: { start: 0, end: 48000 * 300 } }));
    expect(wide.range).toBe(null);
    expect(wide.tooLong).toBe(true);
    expect(previewRange(doc({ length: 0 }))).toBe(null);
  });
});

describe('preview editor drawing', () => {
  it('draws at the main editor scale when the view runs past the end of the file', async () => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      disconnect() {}
    };
    HTMLCanvasElement.prototype.getContext = () => null;
    const draw = vi.spyOn(WaveformRenderer.prototype, 'draw');
    const prefs = new Emitter();
    prefs.get = (k) => k === 'previewEditor';
    const app = new Emitter();
    Object.assign(app, { prefs, commands: { register() {} }, formatTime: String });
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    installPreviewEditor(app, host);
    // Half a second of audio in a one-second view: the waveform fills the left half.
    const channels = [Channel.fromSamples(new Float32Array(24000))];
    const doc = {
      kind: 'audio',
      length: 24000,
      sampleRate: 48000,
      view: { start: 0, end: 48000, amp: 1 },
      hasSelection: false,
      selection: { start: 0, end: 0 },
      channelMask: null,
      state: { sampleRate: 48000, channels, markers: [] },
    };
    vi.useFakeTimers();
    try {
      app.emit('effect-values', { def: { name: 'Amplify' }, values: {}, doc });
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
    const call = draw.mock.calls.at(-1)[0];
    expect(call.channels[0].length).toBe(24000);
    const W = Math.max(1, host.querySelector('.preview-surface').getBoundingClientRect().width);
    expect(call.fpp * W * (window.devicePixelRatio || 1)).toBeCloseTo(48000);
    expect(call.start).toBe(0);
    draw.mockRestore();
  });
});

describe('preview editor zoom', () => {
  it('zooms a view around a point, kept inside the file', () => {
    expect(zoomViewAt({ start: 0, end: 1000 }, 0.5, 0.5, 1000)).toEqual({ start: 250, end: 750 });
    expect(zoomViewAt({ start: 0, end: 1000 }, 0.5, 0, 1000)).toEqual({ start: 0, end: 500 });
    expect(zoomViewAt({ start: 500, end: 1000 }, 4, 0.5, 1000)).toEqual({ start: 0, end: 1000 });
    expect(zoomViewAt({ start: 0, end: 20 }, 0.1, 0.5, 1000).end).toBeGreaterThanOrEqual(16);
  });

  it('previews a range of the given view', () => {
    expect(previewRange(doc(), 120, { start: 48000, end: 96000 }).range).toEqual([48000, 96000]);
  });
});

describe('preview editor without an effect', () => {
  function setup(values = {}) {
    globalThis.ResizeObserver ??= class {
      observe() {}
      disconnect() {}
    };
    HTMLCanvasElement.prototype.getContext = () => null;
    const store = { previewEditor: true, previewZoom: 'sync', ...values };
    const prefs = new Emitter();
    prefs.get = (k) => store[k];
    prefs.set = (k, v) => {
      store[k] = v;
      prefs.emit('change', k);
    };
    const channels = [Channel.fromSamples(new Float32Array(48000))];
    const active = {
      kind: 'audio',
      name: 'tone.wav',
      length: 48000,
      sampleRate: 48000,
      view: { start: 0, end: 48000, amp: 1 },
      state: { channels },
      setView(a, b) {
        this.view = { ...this.view, start: a, end: b };
      },
    };
    const app = new Emitter();
    Object.assign(app, { prefs, active, commands: { register() {} }, formatTime: String });
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    installPreviewEditor(app, host);
    return { app, host, active, prefs };
  }

  it('shows the active file as it is when turned on from the View menu', () => {
    const draw = vi.spyOn(WaveformRenderer.prototype, 'draw');
    const { app, host, active } = setup();
    app.prefs.emit('change', 'previewEditor');
    const el = host.querySelector('.preview-editor');
    expect(el.hidden).toBe(false);
    expect(el.querySelector('.preview-label').textContent).toBe('tone.wav');
    expect(el.querySelector('.preview-status').textContent).toMatch(/Open an effect/);
    expect(draw.mock.calls.at(-1)[0].channels).toBe(active.state.channels);
    draw.mockRestore();
  });

  it('stays hidden while turned off', () => {
    const { app, host } = setup({ previewEditor: false });
    app.prefs.emit('change', 'previewEditor');
    expect(host.querySelector('.preview-editor').hidden).toBe(true);
  });

  it('zooms the main editor in Synchronized mode and only itself in Independent mode', () => {
    const { app, host, active } = setup();
    app.prefs.emit('change', 'previewEditor');
    const surface = host.querySelector('.preview-surface');
    surface.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, clientX: 0, bubbles: true, cancelable: true }));
    expect(active.view.end - active.view.start).toBeLessThan(48000);
    active.view = { start: 0, end: 48000, amp: 1 };
    const select = host.querySelector('.preview-zoom');
    select.value = 'independent';
    select.dispatchEvent(new Event('change'));
    expect(app.prefs.get('previewZoom')).toBe('independent');
    surface.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, clientX: 0, bubbles: true, cancelable: true }));
    expect(active.view).toEqual({ start: 0, end: 48000, amp: 1 });
  });
});

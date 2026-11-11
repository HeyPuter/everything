import { describe, it, expect, vi } from 'vitest';
import { previewRange, installPreviewEditor } from '../src/editor/preview-editor.js';
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

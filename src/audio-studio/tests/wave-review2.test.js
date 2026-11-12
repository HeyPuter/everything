// Regression tests for the second Waveform editor review: model, edits, commands, view.
import { describe, it, expect, beforeAll } from 'vitest';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
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
  const { WaveformView } = await import('../src/editor/waveform-view.js');
  HTMLCanvasElement.prototype.getContext = (type) => (type === '2d' ? fakeContext() : null);
  localStorage.clear();
  const app = new App();
  installCore(app);
  app.syncGraph = () => {};
  const doc = new AudioFile({
    name: 'r.wav',
    sampleRate: 48000,
    channels: Array.from({ length: channels }, () => Channel.fromSamples(ramp(frames))),
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

const ramp = (n) => Float32Array.from({ length: n }, (_, i) => ((i % 1000) + 1) / 1000);

describe('channel enables', () => {
  it('keeps a channel enabled when undo returns to fewer channels', () => {
    const doc = new AudioFile({
      name: 'a.wav',
      sampleRate: 48000,
      channels: [Channel.fromSamples(ramp(1000))],
    });
    doc.apply('Convert to Stereo', E.convertChannels(doc.state, 2));
    doc.setChannelEnabled(0, false);
    expect(doc.selection.channels).toEqual([false, true]);
    doc.history.undo();
    expect(doc.selection.channels).toEqual([true]);
    expect(doc.channelMask).toBe(null);
    // Edits act on the mono channel again.
    doc.setSelection(0, 10);
    doc.apply('Silence', E.silenceRange(doc.state, 0, 10, doc.channelMask));
    expect(doc.state.channels[0].toArray(0, 10).every((v) => v === 0)).toBe(true);
  });
});

describe('waveform keys', () => {
  it('leaves Alt+Left/Right to Move Playhead to Previous/Next', async () => {
    const { doc, view } = await makeView();
    doc.setCursor(1000);
    const key = (init) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      view.surface.dispatchEvent(e);
      return e;
    };
    const alt = key({ key: 'ArrowRight', altKey: true });
    expect(alt.defaultPrevented).toBe(false);
    expect(doc.cursor).toBe(1000);
    const plain = key({ key: 'ArrowRight' });
    expect(plain.defaultPrevented).toBe(true);
    expect(doc.cursor).toBeGreaterThan(1000);
  });
});

describe('typed times', () => {
  it('reads timecode and bars as the first sample of the frame they name', async () => {
    const { formatTime, parseTime } = await import('../src/lib/time.js');
    const music = { tempo: 97, beatsPerBar: 3, beatNote: 4, subdivisions: 16, fps: 12 };
    const formats = [
      'smpte30',
      'smpte2997',
      'smpte2997df',
      'smpte5994df',
      'smpte2398',
      'frames',
      'bars',
    ];
    for (const rate of [8000, 44100, 48000, 192000]) {
      for (const format of formats) {
        // Every frame (or subdivision) step across a stretch an hour in.
        const step = rate / 61;
        for (let k = 0; k < 400; k++) {
          const at = Math.round(rate * 3600 + k * step);
          const text = formatTime(at, rate, format, music);
          const frame = parseTime(text, rate, format, music);
          expect(formatTime(frame, rate, format, music), `${format} ${rate} ${text}`).toBe(text);
          expect(formatTime(frame - 1, rate, format, music)).not.toBe(text);
        }
      }
    }
    expect(parseTime('00:00:01:00', 48000, 'smpte30')).toBe(48000);
    expect(parseTime('-00:00:01:00', 48000, 'smpte30')).toBe(-48000);
    expect(parseTime('1.5', 48000, 'smpte30')).toBe(72000);
  });
});

describe('grid snapping', () => {
  it('snaps to the first sample of a video frame or beat, which shows as that frame', async () => {
    const { formatTime } = await import('../src/lib/time.js');
    const { app, view } = await makeView({ frames: 48000 * 4 });
    app.prefs.set('snapping', true);
    app.prefs.set('snap', { frames: true });
    for (const format of ['smpte2997', 'smpte2398', 'smpte5994df']) {
      app.prefs.set('timeFormat', format);
      for (let k = 1; k < 120; k++) {
        const boundary =
          (k * 48000 * 1001) /
          (format === 'smpte2398' ? 24000 : format === 'smpte2997' ? 30000 : 60000);
        const f = view.snap(boundary + 0.3);
        expect(f).toBe(Math.ceil(boundary - 1e-4));
        expect(formatTime(f, 48000, format)).not.toBe(formatTime(f - 1, 48000, format));
      }
    }
    app.prefs.set('snap', { ruler: true });
    app.prefs.set('timeFormat', 'bars');
    app.prefs.set('tempo', 103);
    const f = view.snap(27900);
    expect(f).toBe(27962);
    expect(formatTime(f, 48000, 'bars', app.timeOptions())).not.toBe(
      formatTime(f - 1, 48000, 'bars', app.timeOptions()),
    );
  });
});

describe('gain HUD', () => {
  it('drops an unapplied adjustment when another file becomes active', async () => {
    const { app, doc, view } = await makeView();
    const other = new AudioFile({
      name: 'b.wav',
      sampleRate: 48000,
      channels: [Channel.fromSamples(ramp(100))],
    });
    const knob = view.el.querySelector('.hud-knob');
    knob.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }),
    );
    expect(view.hudGain).toBe(3);
    expect(app.previewFx?.[0].key).toBe('hud');
    app.addDocument(other);
    expect(app.previewFx).toBe(null);
    expect(view.hudGain).toBe(0);
    expect(knob.getAttribute('aria-valuenow')).toBe('0');
    app.activate(doc);
    knob.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(doc.history.entries.length).toBe(1);
    view.destroy();
  });
});

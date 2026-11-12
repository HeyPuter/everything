// Regression tests for the second Waveform editor review: model, edits, commands, view.
import { describe, it, expect, beforeAll } from 'vitest';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import * as E from '../src/model/edits.js';

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

describe('markers selected on the ruler', () => {
  it('are what the marker commands act on when the Markers panel is not open', async () => {
    const { createMarker } = await import('../src/model/markers.js');
    const { app, doc, view } = await makeView();
    const a = createMarker({ start: 100, name: 'A' });
    const b = createMarker({ start: 200, name: 'B' });
    doc.apply('Markers', { ...doc.state, markers: [a, b] });
    expect(app.selectedMarkerIds).toBe(undefined);
    expect(app.commands.isEnabled('marker.deleteSelected')).toBe(false);
    view.selectMarker(a.id);
    expect(app.commands.isEnabled('marker.deleteSelected')).toBe(true);
    await app.commands.run('marker.deleteSelected');
    expect(doc.state.markers.map((m) => m.name)).toEqual(['B']);
    view.destroy();
  });
});

describe('history jumps across a sample rate conversion', () => {
  it('keep the view, playhead and selection at the same times', () => {
    const n = 480000;
    const doc = new AudioFile({
      name: 'a.wav',
      sampleRate: 48000,
      channels: [Channel.fromSamples(ramp(n))],
    });
    // Convert to 24 kHz, as Convert Sample Type does, then crop to the first second.
    doc.view = { ...doc.view, start: 24000, end: 48000 };
    doc.apply('Convert Sample Type', {
      ...doc.state,
      sampleRate: 24000,
      channels: [Channel.fromSamples(ramp(n / 2))],
    });
    doc.apply('Crop', E.cropRange(doc.state, 0, 48000));
    doc.setView(24000, 48000);
    doc.setCursor(36000);
    doc.setSelection(30000, 42000);
    // The History panel jumps back past both steps: 1.5 s stays 1.5 s.
    doc.history.goTo(0);
    expect([doc.view.start, doc.view.end, doc.cursor]).toEqual([48000, 96000, 72000]);
    expect([doc.selection.start, doc.selection.end]).toEqual([60000, 84000]);
    doc.history.goTo(2);
    expect([doc.view.start, doc.view.end, doc.cursor]).toEqual([24000, 48000, 36000]);
    // Single steps scale as before.
    doc.history.undo();
    doc.history.undo();
    expect(doc.cursor).toBe(72000);
  });
});

describe('time ruler with many markers', () => {
  it('asks the host for the timeline once per draw and hover, not once per marker', async () => {
    const { TimeRuler } = await import('../src/editor/time-ruler.js');
    const { App } = await import('../src/app.js');
    HTMLCanvasElement.prototype.getContext = (type) => (type === '2d' ? fakeContext() : null);
    const app = new App();
    let calls = 0;
    const markers = Array.from({ length: 500 }, (_, i) => ({
      id: `m${i}`,
      start: i * 90,
      duration: i % 2 ? 40 : 0,
      type: 'cue',
    }));
    const host = {
      timeline: () => {
        calls++;
        return {
          rate: 48000,
          length: 48000,
          view: { start: 0, end: 48000 },
          cursor: 0,
          selection: { start: 10, end: 900 },
          markers,
        };
      },
      seek: () => {},
    };
    const ruler = new TimeRuler(app, host);
    ruler.resize(800, 24);
    ruler.draw();
    expect(calls).toBeLessThanOrEqual(2);
    calls = 0;
    ruler.el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
    expect(calls).toBeLessThanOrEqual(2);
  });
});

describe('Markers panel', () => {
  async function panelWith(count = 6) {
    const { createMarker } = await import('../src/model/markers.js');
    const { markersPanel } = await import('../src/panels/markers.js');
    const env = await makeView({ frames: 48000 * 4 });
    const ms = Array.from({ length: count }, (_, i) =>
      createMarker({ start: i * 4800, name: `M${i}` }),
    );
    env.doc.apply('Markers', { ...env.doc.state, markers: ms });
    const panel = markersPanel(env.app);
    env.view.el.after(panel.el);
    const rows = () => [...panel.el.querySelectorAll('tbody tr[data-id]')];
    return { ...env, panel, rows, ms };
  }

  it('selects a Shift-click range and toggles with Ctrl/Cmd-click, on the ruler too', async () => {
    const { app, rows, view, ms } = await panelWith();
    const click = (i, init = {}) =>
      rows()[i].dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
    click(1);
    click(4, { shiftKey: true });
    const ids = (from, to) => ms.slice(from, to + 1).map((m) => m.id);
    expect(app.selectedMarkerIds()).toEqual(ids(1, 4));
    expect([...view.selectedMarkers]).toEqual(ids(1, 4));
    click(2, { metaKey: true });
    expect(app.selectedMarkerIds()).toEqual([ms[1].id, ms[3].id, ms[4].id]);
    expect([...view.selectedMarkers]).toEqual([ms[1].id, ms[3].id, ms[4].id]);
    expect(rows().filter((r) => r.getAttribute('aria-selected') === 'true')).toHaveLength(3);
    view.destroy();
  });

  it('marks a new selection without rebuilding the rows', async () => {
    const { rows, view } = await panelWith();
    const before = rows();
    rows()[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    rows()[2].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }),
    );
    expect(rows()).toEqual(before);
    expect(rows().map((r) => r.getAttribute('aria-selected'))).toEqual([
      'false',
      'false',
      'true',
      'true',
      'false',
      'false',
    ]);
    expect(rows().map((r) => r.tabIndex)).toEqual([-1, -1, 0, 0, -1, -1]);
    view.destroy();
  });

  it('keeps its rows through edits that leave the markers alone', async () => {
    const { doc, rows, view } = await panelWith();
    const first = rows()[0];
    doc.apply('Fade In', E.fadeRange(doc.state, 0, 4800, 'in'));
    doc.history.undo();
    expect(rows()[0]).toBe(first);
    doc.apply('Delete', E.deleteRange(doc.state, 0, 2400));
    expect(rows()[0]).not.toBe(first);
    expect(rows()[1].querySelector('[data-field="start"]').textContent).toBe('0:00.050');
    view.destroy();
  });
});

describe('timecode ruler ticks', () => {
  it('fall on whole frames, evenly apart, when closer than a second', async () => {
    const { rulerTicks } = await import('../src/editor/time-ruler.js');
    const { formatTime, timecodeToFrames, frameRateOf } = await import('../src/lib/time.js');
    for (const format of ['smpte30', 'smpte2997', 'smpte25', 'smpte2398']) {
      const fr = frameRateOf(format);
      for (const [t0, t1] of [
        [1, 1.2],
        [10.05, 10.9],
        [61.3, 63],
      ]) {
        const { ticks } = rulerTicks(t0, t1, 300, 70, fr.real);
        expect(ticks.length).toBeGreaterThan(1);
        const frames = ticks.map((s) => {
          const text = formatTime(Math.ceil(s * 48000 - 1e-4), 48000, format);
          const [h, m, sec, f] = text.split(/[:;]/).map(Number);
          expect(Math.abs(s * fr.real - Math.round(s * fr.real))).toBeLessThan(1e-6);
          return timecodeToFrames(h, m, sec, f, fr);
        });
        const gaps = new Set(frames.slice(1).map((f, i) => f - frames[i]));
        expect(gaps.size).toBe(1);
        expect([...gaps][0]).toBeGreaterThan(0);
      }
    }
  });
});

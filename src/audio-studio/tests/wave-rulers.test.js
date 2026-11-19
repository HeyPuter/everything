// Waveform editor rulers: amplitude ruler units, its menu, wheel and drag zoom;
// the time ruler's right-click menu, wheel zoom and selection handles; sample point editing.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { linearTicks, ampFullScale, ampDragZoom, WaveformView } from '../src/editor/waveform-view.js';

function fakeContext() {
  return new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => (k === 'measureText' ? { width: 10 } : undefined)), set: (t, k, v) => ((t[k] = v), true) });
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  HTMLCanvasElement.prototype.getContext = (type) => (type === '2d' ? fakeContext() : null);
});

async function makeView({ bitDepth = 16 } = {}) {
  const { App } = await import('../src/app.js');
  const { installCore } = await import('../src/features/core.js');
  const { AudioFile } = await import('../src/model/audio-file.js');
  const { Channel } = await import('../src/audio/channel.js');
  localStorage.clear();
  const app = new App();
  installCore(app);
  app.syncGraph = () => {};
  const doc = new AudioFile({ name: 's.wav', sampleRate: 48000, channels: [Channel.fromSamples(new Float32Array(48000)), Channel.fromSamples(new Float32Array(48000))], info: { bitDepth } });
  app.addDocument(doc);
  const view = new WaveformView(app, doc);
  document.body.replaceChildren(view.el);
  view.width = 1000;
  view.height = 400;
  view.ruler.width = 1000;
  view.ruler.height = 24;
  return { app, doc, view };
}

describe('linear amplitude ticks', () => {
  const lane = { top: 0, bottom: 400 };

  it('labels percent at round steps up to full scale, mirrored below', () => {
    const t = linearTicks(lane, 1, 'percent');
    expect(t.map((x) => x.label)).toEqual(['20', '40', '60', '80']);
    expect(t[0].y).toBeCloseTo(160);
    expect(t[0].y2).toBeCloseTo(240);
    expect(linearTicks({ top: 0, bottom: 600 }, 1, 'percent')[0].label).toBe('10');
  });

  it('labels normalized values with the decimals the step needs', () => {
    const t = linearTicks(lane, 1, 'normalized');
    expect(t[0].label).toBe('0.2');
    const z = linearTicks(lane, 10, 'normalized');
    expect(z[0].label).toBe('0.02');
    const q = linearTicks({ top: 0, bottom: 200 }, 4, 'normalized');
    expect(q[0].label).toBe('0.1');
  });

  it('uses integer sample values for fixed-point files and normalized for float', () => {
    expect(ampFullScale('samples', 16)).toBe(32768);
    expect(ampFullScale('samples', 24)).toBe(8388608);
    expect(ampFullScale('samples', 32)).toBe(1);
    const t = linearTicks(lane, 1, 'samples', 16);
    expect(t[0].label).toBe('5000');
    expect(t.some((x) => x.label === '20k')).toBe(true);
  });

  it('never labels past full scale when zoomed out', () => {
    const t = linearTicks(lane, 0.2, 'percent');
    expect(Math.max(...t.map((x) => x.value))).toBeLessThanOrEqual(100);
  });

  it('zooms in when the ruler is dragged up', () => {
    expect(ampDragZoom(1, -50)).toBeGreaterThan(1.5);
    expect(ampDragZoom(1, 50)).toBeLessThan(1);
    expect(ampDragZoom(2, 0)).toBe(2);
  });
});

describe('amplitude ruler', () => {
  beforeEach(() => localStorage.clear());

  it('switches units from its right-click menu', async () => {
    const { app, view } = await makeView();
    expect(view.ampUnit()).toBe('db');
    const items = view.ampMenuItems();
    expect(items.slice(0, 4).map((i) => i.label)).toEqual(['Decibels', 'Percentage', 'Normalized Values', 'Samples']);
    expect(items[0].checked).toBe(true);
    items[1].run();
    expect(app.prefs.get('ampUnits')).toBe('percent');
    expect(view.ampUnit()).toBe('percent');
    expect(view.ampMenuItems()[1].checked).toBe(true);
    expect(view.amp.title).toContain('Percentage');
    // An unknown stored unit falls back to decibels.
    app.prefs.set('ampUnits', 'bogus');
    expect(view.ampUnit()).toBe('db');
  });

  it('zooms amplitude with the wheel and resets on double-click', async () => {
    const { doc, view } = await makeView();
    view.amp.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true }));
    expect(doc.view.amp).toBeGreaterThan(1);
    const reset = view.ampMenuItems().find((i) => i.label === 'Reset Amplitude Zoom');
    expect(reset.enabled).toBe(true);
    view.amp.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(doc.view.amp).toBe(1);
  });

  it('does not zoom when a channel button is double-clicked', async () => {
    const { doc, view } = await makeView();
    doc.setAmp(2);
    view.layout();
    const btn = view.amp.querySelector('.channel-btn');
    btn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(doc.view.amp).toBe(2);
  });
});

describe('time ruler', () => {
  beforeEach(() => localStorage.clear());

  it('offers the time formats and time zoom on right-click', async () => {
    const { view } = await makeView();
    const labels = view.rulerMenuItems().map((i) => i.label);
    expect(labels).toContain('Zoom In (Time)');
    expect(labels).toContain('Zoom Out Full (All Axes)');
  });

  it('finds the selection edge under the pointer', async () => {
    const { doc, view } = await makeView();
    doc.setView(0, 48000);
    doc.setSelection(12000, 24000);
    expect(view.ruler.selectionEdgeAt(250)).toBe('start');
    expect(view.ruler.selectionEdgeAt(503)).toBe('end');
    expect(view.ruler.selectionEdgeAt(400)).toBe(null);
    doc.setSelection(0, 0);
    expect(view.ruler.selectionEdgeAt(0)).toBe(null);
  });

  it('drags a selection edge, keeping the channels; a click without moving seeks', async () => {
    const { app, doc, view } = await makeView();
    app.prefs.set('snapping', false);
    doc.setView(0, 48000);
    doc.setSelection(12000, 24000, { channels: [true, false] });
    const el = view.ruler.el;
    el.setPointerCapture = () => {};
    const ev = (type, x) => {
      const e = new MouseEvent(type, { bubbles: true, button: 0 });
      Object.defineProperties(e, { offsetX: { value: x }, offsetY: { value: 20 }, pointerId: { value: 1 }, pointerType: { value: 'mouse' } });
      return e;
    };
    el.dispatchEvent(ev('pointerdown', 500));
    el.dispatchEvent(ev('pointermove', 600));
    el.dispatchEvent(ev('pointerup', 600));
    expect(doc.selection.start).toBe(12000);
    expect(doc.selection.end).toBe(28800);
    expect(doc.selection.channels).toEqual([true, false]);
    el.dispatchEvent(ev('pointerdown', 250));
    el.dispatchEvent(ev('pointerup', 250));
    expect(doc.cursor).toBe(12000);
    expect(doc.selection.end).toBe(28800);
  });

  it('zooms time with the wheel over the ruler', async () => {
    const { doc, view } = await makeView();
    view.ruler.el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 24 });
    const before = doc.view.end - doc.view.start;
    view.ruler.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, clientX: 500, bubbles: true, cancelable: true }));
    expect(doc.view.end - doc.view.start).toBeLessThan(before);
  });
});

describe('sample point editing', () => {
  beforeEach(() => localStorage.clear());

  async function zoomedView() {
    const ctx = await makeView();
    const { doc, view } = ctx;
    // 10 px per sample: a ramp in the left channel, silence in the right.
    const { Channel } = await import('../src/audio/channel.js');
    const ramp = new Float32Array(48000);
    for (let i = 0; i < 200; i++) ramp[i] = (i % 10) / 20;
    doc.apply('Setup', { ...doc.state, channels: [Channel.fromSamples(ramp), doc.state.channels[1]] });
    doc.setView(0, 100);
    view.waveHeight = 400;
    view.surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 400 });
    view.surface.setPointerCapture = () => {};
    return ctx;
  }

  const pe = (type, x, y, extra = {}) => {
    const e = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, ...extra });
    Object.defineProperties(e, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } });
    return e;
  };
  // Lanes: L 0..199.5, R 200.5..400 (1 px gap); y of value v in the left lane.
  const yL = (v) => 99.75 - v * 99.75;

  it('finds sample points only when zoomed in to single samples', async () => {
    const { doc, view } = await zoomedView();
    expect(view.samplesEditable()).toBe(true);
    expect(view.sampleAt(40, yL(0.2))).toEqual({ ch: 0, frame: 4 });
    expect(view.sampleAt(48, yL(0.25))).toEqual({ ch: 0, frame: 5 });
    expect(view.sampleAt(40, yL(0.2) + 20)).toBe(null);
    doc.setView(0, 48000);
    expect(view.samplesEditable()).toBe(false);
    expect(view.sampleAt(0, yL(0))).toBe(null);
  });

  it('ignores channels disabled for editing', async () => {
    const { doc, view } = await zoomedView();
    doc.setChannelEnabled(0, false);
    expect(view.sampleAt(40, yL(0.2))).toBe(null);
  });

  it('drags a sample to a new value as one undoable edit', async () => {
    const { doc, view } = await zoomedView();
    const s = view.surface;
    s.dispatchEvent(pe('pointerdown', 40, yL(0.2)));
    s.dispatchEvent(pe('pointermove', 40, yL(0.8)));
    // Moving across to sample 6 fills in sample 5 on the way.
    s.dispatchEvent(pe('pointermove', 60, yL(0.4)));
    s.dispatchEvent(pe('pointerup', 60, yL(0.4)));
    const out = doc.state.channels[0].toArray(3, 8);
    expect(out[0]).toBeCloseTo(0.15);
    expect(out[1]).toBeCloseTo(0.8, 2);
    expect(out[2]).toBeCloseTo(0.6, 2);
    expect(out[3]).toBeCloseTo(0.4, 2);
    expect(out[4]).toBeCloseTo(0.35);
    expect(doc.history.undoLabel).toBe('Edit Samples');
    expect(doc.state.channels[1].toArray(0, 10).every((v) => v === 0)).toBe(true);
  });

  it('a click on a sample point without dragging places the playhead', async () => {
    const { doc, view } = await zoomedView();
    const before = doc.state;
    view.surface.dispatchEvent(pe('pointerdown', 40, yL(0.2)));
    view.surface.dispatchEvent(pe('pointerup', 40, yL(0.2)));
    expect(doc.state).toBe(before);
    expect(doc.cursor).toBe(4);
  });

  it('Escape during the drag puts the samples back', async () => {
    const { doc, view } = await zoomedView();
    const before = doc.state;
    const s = view.surface;
    s.dispatchEvent(pe('pointerdown', 40, yL(0.2)));
    s.dispatchEvent(pe('pointermove', 40, yL(0.9)));
    s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    s.dispatchEvent(pe('pointerup', 40, yL(0.9)));
    expect(doc.state).toBe(before);
    expect(view.sampleDrag).toBe(null);
  });
});

describe('half-channel hint', () => {
  it('labels the cursor with the channel a drag near the top or bottom edge selects', async () => {
    const { view } = await makeView();
    view.waveHeight = 400;
    view.surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 400 });
    const move = (y) => {
      view.surface.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: y }));
      return view.surface.style.cursor;
    };
    expect(move(10)).toContain('data:image/svg+xml');
    expect(move(10)).toContain(encodeURIComponent('>L</text>'));
    expect(move(390)).toContain(encodeURIComponent('>R</text>'));
    expect(move(200)).toBe('text');
  });
});

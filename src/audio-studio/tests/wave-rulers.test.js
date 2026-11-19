// Waveform editor rulers: amplitude ruler units, its menu, wheel and drag zoom;
// the time ruler's right-click menu, wheel zoom and selection handles.
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

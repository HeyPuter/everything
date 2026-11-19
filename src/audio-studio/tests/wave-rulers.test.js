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

  it('leaves events from other rulers in the same column (the spectral ruler) alone', async () => {
    const { doc, view } = await makeView();
    doc.setAmp(2);
    const other = document.createElement('div');
    view.amp.append(other);
    other.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    other.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true }));
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    other.dispatchEvent(menu);
    expect(doc.view.amp).toBe(2);
    expect(menu.defaultPrevented).toBe(false);
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

describe('snap indicator', () => {
  it('marks where a selection drag snapped and clears on release', async () => {
    const { app, doc, view } = await makeView();
    const { createMarker } = await import('../src/model/markers.js');
    app.prefs.set('snapping', true);
    app.prefs.set('snap', { ruler: false, rulerFine: false, markers: true, zero: false, frames: false });
    doc.apply('Add Marker', { ...doc.state, markers: [createMarker({ start: 24000, duration: 0, name: 'M' })] });
    doc.setView(0, 48000);
    view.waveHeight = 400;
    const s = view.surface;
    s.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 400 });
    s.setPointerCapture = () => {};
    const pe = (type, x) => {
      const e = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 200 });
      Object.defineProperties(e, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } });
      return e;
    };
    s.dispatchEvent(pe('pointerdown', 100));
    s.dispatchEvent(pe('pointermove', 300));
    expect(view.snapLine).toBe(null);
    // 503 px is 3 px from the marker at 500 px.
    s.dispatchEvent(pe('pointermove', 503));
    expect(doc.selection.end).toBe(24000);
    expect(view.snapLine).toBe(24000);
    s.dispatchEvent(pe('pointerup', 503));
    window.dispatchEvent(new MouseEvent('pointerup'));
    expect(view.snapLine).toBe(null);
  });
});

describe('waveform context menu', () => {
  it('offers Paste to New and the zero crossing adjustments', async () => {
    const { WAVEFORM_CONTEXT } = await import('../src/ui/menus.js');
    expect(WAVEFORM_CONTEXT).toContain('edit.pasteToNew');
    const zero = WAVEFORM_CONTEXT.find((i) => i.label === 'Zero Crossings');
    expect(zero.submenu).toContain('zero.inward');
    expect(zero.submenu).toContain('zero.outward');
  });
});

describe('overview wheel', () => {
  it('zooms around the frame under the pointer', async () => {
    const { overviewZoom } = await import('../src/editor/overview.js');
    expect(overviewZoom({ start: 0, end: 1000 }, 0.5, 500, 1000)).toEqual({ start: 250, end: 750 });
    expect(overviewZoom({ start: 0, end: 1000 }, 0.5, 0, 1000)).toEqual({ start: 0, end: 500 });
    // A point past the view zooms around the nearer edge.
    expect(overviewZoom({ start: 0, end: 500 }, 0.5, 900, 1000)).toEqual({ start: 250, end: 500 });
    expect(overviewZoom({ start: 0, end: 500 }, 4, 0, 1000)).toEqual({ start: 0, end: 1000 });
  });

  it('zooms and scrolls the editor view from the navigator', async () => {
    const { doc, view } = await makeView();
    const ov = view.overview;
    ov.width = 1000;
    ov.el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 20 });
    doc.setView(0, 48000);
    ov.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, clientX: 500, bubbles: true, cancelable: true }));
    const v = doc.view;
    expect(v.end - v.start).toBeLessThan(48000);
    expect((v.start + v.end) / 2).toBeCloseTo(24000, -2);
    ov.el.dispatchEvent(new WheelEvent('wheel', { deltaX: 100, bubbles: true, cancelable: true }));
    expect(doc.view.start).toBeGreaterThan(v.start);
  });
});

describe('right-drag zoom', () => {
  const pe = (type, x, y, button = 2) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, button, clientX: x, clientY: y });
    Object.defineProperties(e, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } });
    return e;
  };

  it('zooms the time ruler to the range dragged over and swallows the menu event after it', async () => {
    const { app, doc, view } = await makeView();
    const el = view.ruler.el;
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 24 });
    el.setPointerCapture = () => {};
    doc.setView(0, 48000);
    let menus = 0;
    app.openMenu = () => menus++;
    el.dispatchEvent(pe('pointerdown', 250, 10));
    el.dispatchEvent(pe('pointermove', 400, 10));
    el.dispatchEvent(pe('pointermove', 500, 10));
    el.dispatchEvent(pe('pointerup', 500, 10));
    el.dispatchEvent(pe('contextmenu', 500, 10));
    expect(doc.view.start).toBe(12000);
    expect(doc.view.end).toBe(24000);
    expect(menus).toBe(0);
  });

  it('opens the menu on release for a right-click without a drag (menu event on press)', async () => {
    const { app, view } = await makeView();
    const el = view.ruler.el;
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 24 });
    el.setPointerCapture = () => {};
    const opened = [];
    app.openMenu = (items, o) => opened.push(o.label);
    el.dispatchEvent(pe('pointerdown', 250, 10));
    el.dispatchEvent(pe('contextmenu', 250, 10));
    expect(opened).toEqual([]);
    el.dispatchEvent(pe('pointerup', 251, 10));
    expect(opened).toEqual(['Time ruler']);
    // Menu event on release (after the pointer events) opens it directly.
    el.dispatchEvent(pe('pointerdown', 250, 10));
    el.dispatchEvent(pe('pointerup', 250, 10));
    el.dispatchEvent(pe('contextmenu', 250, 10));
    expect(opened).toEqual(['Time ruler', 'Time ruler']);
  });

  it('zooms amplitude so a dragged range fills the lane', async () => {
    const { ampForRange } = await import('../src/editor/waveform-view.js');
    const lanes = [{ top: 0, bottom: 200 }];
    // 50..90 px covers values 0.5..0.1: zoom 5x centred on 0.3.
    expect(ampForRange(lanes, 50, 90, 1).amp).toBeCloseTo(5);
    expect(ampForRange(lanes, 50, 90, 1).offset).toBeCloseTo(0.3);
    expect(ampForRange(lanes, 0, 200, 1)).toEqual({ amp: 1, offset: 0 });
    expect(ampForRange(lanes, 300, 350, 1)).toBe(null);
    expect(ampForRange(lanes, 50, 51, 1)).toBe(null);
    const { app, doc, view } = await makeView();
    view.amp.getBoundingClientRect = () => ({ left: 0, top: 0, width: 54, height: 400 });
    view.amp.setPointerCapture = () => {};
    app.openMenu = () => {};
    // Left lane 0..199.5 (centre 99.75): 50..90 px is about 0.5..0.1.
    view.amp.dispatchEvent(pe('pointerdown', 10, 50));
    view.amp.dispatchEvent(pe('pointermove', 10, 90));
    view.amp.dispatchEvent(pe('pointerup', 10, 90));
    expect(doc.view.amp).toBeCloseTo(5, 0);
    expect(doc.view.ampOffset).toBeCloseTo(0.3, 1);
  });
});

describe('range marker ends', () => {
  it('drags the end of a range marker on the ruler as one undoable edit', async () => {
    const { app, doc, view } = await makeView();
    const { createMarker } = await import('../src/model/markers.js');
    app.prefs.set('snapping', false);
    doc.apply('Add Range Marker', { ...doc.state, markers: [createMarker({ start: 12000, duration: 12000, name: 'R' })] });
    doc.setView(0, 48000);
    const el = view.ruler.el;
    el.setPointerCapture = () => {};
    const ev = (type, x) => {
      const e = new MouseEvent(type, { bubbles: true, button: 0 });
      Object.defineProperties(e, { offsetX: { value: x }, offsetY: { value: 20 }, pointerId: { value: 1 }, pointerType: { value: 'mouse' } });
      return e;
    };
    el.dispatchEvent(ev('pointerdown', 501));
    el.dispatchEvent(ev('pointermove', 701));
    // While dragging, the preview shows the new length and the document is unchanged.
    expect(view.markers()[0].duration).toBe(21600);
    expect(doc.state.markers[0].duration).toBe(12000);
    el.dispatchEvent(ev('pointerup', 701));
    expect(doc.state.markers[0]).toMatchObject({ start: 12000, duration: 21600 });
    expect(doc.history.undoLabel).toBe('Resize Marker');
    // Never shorter than one sample.
    view.resizeMarker(doc.state.markers[0].id, 0, false);
    expect(doc.state.markers[0].duration).toBe(1);
  });
});

describe('vertical amplitude scroll', () => {
  it('keeps the scroll inside full scale and follows the zoom', async () => {
    const { clampAmpOffset } = await import('../src/model/audio-file.js');
    expect(clampAmpOffset(0.9, 2)).toBe(0.5);
    expect(clampAmpOffset(-0.9, 4)).toBe(-0.75);
    expect(clampAmpOffset(0.3, 1)).toBe(0);
    const { doc } = await makeView();
    doc.setAmp(4);
    doc.setAmpOffset(0.6);
    expect(doc.view.ampOffset).toBeCloseTo(0.6);
    // Zooming out pulls the scroll back inside full scale; back to 1x clears it.
    doc.setAmp(2);
    expect(doc.view.ampOffset).toBeCloseTo(0.5);
    doc.setAmp(1);
    expect(doc.view.ampOffset).toBe(0);
  });

  it('zooms around an anchor value', async () => {
    const { doc } = await makeView();
    doc.setAmp(4, { anchor: 0.5 });
    // 0.5 was 0.5 of the half-lane above the centre; it stays there: (0.5 - off) * 4 = 0.5.
    expect(doc.view.ampOffset).toBeCloseTo(0.375);
  });

  it('labels the levels in view when scrolled', async () => {
    const { dbTicks, linearTicks, dbMinorTicks } = await import('../src/editor/waveform-view.js');
    const lane = { top: 0, bottom: 400 };
    // 4x zoom scrolled to 0.5: values 0.25..0.75 in view, no negatives, no zero line.
    const t = dbTicks(lane, 4, 0.5);
    expect(t.length).toBeGreaterThan(0);
    expect(t.every((x) => x.y2 === null)).toBe(true);
    expect(t.map((x) => x.db)).toContain(-6);
    const lin = linearTicks(lane, 4, 'normalized', 16, 0.5);
    expect(lin.every((x) => x.value > 0.25 && x.value < 0.75)).toBe(true);
    expect(lin.find((x) => x.label === '0.5').y).toBeCloseTo(200);
    const neg = linearTicks(lane, 4, 'percent', 16, -0.5);
    expect(neg.every((x) => x.label.startsWith('-'))).toBe(true);
    expect(dbMinorTicks(lane, 4, 0.5).every((y) => y >= 0 && y <= 400)).toBe(true);
  });

  it('scrolls by dragging the ruler when zoomed in, and zooms with the wheel around the pointer', async () => {
    const { doc, view } = await makeView();
    view.amp.getBoundingClientRect = () => ({ left: 0, top: 0, width: 54, height: 400 });
    view.amp.setPointerCapture = () => {};
    doc.setAmp(4);
    const ev = (type, y, extra = {}) => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: y, ...extra });
      Object.defineProperties(e, { pointerId: { value: 1 } });
      return e;
    };
    view.amp.dispatchEvent(ev('pointerdown', 100));
    view.amp.dispatchEvent(ev('pointermove', 150));
    view.amp.dispatchEvent(ev('pointerup', 150));
    expect(doc.view.amp).toBe(4);
    // 50 px in a 99.75 px half-lane at 4x: about 0.125 of full scale.
    expect(doc.view.ampOffset).toBeCloseTo(0.125, 2);
    doc.setAmp(1);
    // Over the top of the left lane, a zoom in keeps the level there in place.
    view.amp.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, clientX: 10, clientY: 20, bubbles: true, cancelable: true }));
    expect(doc.view.amp).toBeGreaterThan(1);
    expect(doc.view.ampOffset).toBeGreaterThan(0);
  });
});

describe('Mix Paste dialog details', () => {
  it('shows the crossfade as a time and reads it back, with a 0-200 % scale under the sliders', async () => {
    const { app, doc } = await makeView();
    const { Channel } = await import('../src/audio/channel.js');
    const { mixPasteDialog } = await import('../src/commands/edit-dialogs.js');
    app.clipboards = [{ type: 'audio', sampleRate: 48000, channels: [Channel.silence(4800), Channel.silence(4800)] }, null, null, null, null];
    app.clipboardIndex = 0;
    app.prefs.set('mixPasteSettings', { crossfade: true, crossfadeMs: 50 });
    const p = mixPasteDialog(app, { doc, conformRate: async (c) => c });
    const xf = document.querySelector('.dialog input[aria-label="Crossfade length"]');
    expect(xf.value).toBe(app.formatTime(2400, 48000));
    expect([...document.querySelectorAll('.dialog .mixpaste-scale')][0].textContent).toBe('050100150200');
    const range = document.querySelector('.dialog input[aria-label="Copied Audio volume"]');
    range.value = '40';
    range.dispatchEvent(new MouseEvent('dblclick'));
    expect(range.value).toBe('100');
    xf.value = '0:00.120';
    xf.dispatchEvent(new Event('change'));
    [...document.querySelectorAll('.dialog button')].find((b) => b.textContent === 'Cancel').click();
    await p;
    // Cancel keeps the saved settings; the field itself normalised the typed time.
    expect(xf.value).toBe(app.formatTime(5760, 48000));
  });
});

describe('Repeat Previous Command for edits', () => {
  it('repeats Delete, Paste, Insert Silence and Mix Paste', async () => {
    const { app, doc } = await makeView();
    doc.setSelection(0, 4800);
    await app.commands.run('edit.delete');
    doc.setSelection(0, 4800);
    await app.commands.run('edit.repeat');
    expect(doc.length).toBe(48000 - 9600);
    expect(doc.history.undoLabel).toBe('Delete');

    // Insert Silence: the repeat without a dialog reuses the last duration.
    await app.commands.run('edit.insertSilence', { seconds: 0.5 });
    expect(app.lastCommand.id).toBe('edit.insertSilence');
    expect(app.lastSilenceSeconds).toBe(0.5);
    // As if the last one came from the dialog (no arguments) with a quarter second.
    app.lastCommand = { id: 'edit.insertSilence', args: undefined };
    app.lastSilenceSeconds = 0.25;
    const len = doc.length;
    await app.commands.run('edit.repeatNoDialog');
    expect(doc.length).toBe(len + 12000);

    // Mix Paste again from the clipboard with the saved settings.
    doc.setSelection(0, 2400);
    await app.commands.run('edit.copy');
    app.prefs.set('mixPasteSettings', { type: 'insert' });
    app.lastCommand = { id: 'edit.mixPaste', args: undefined };
    const before = doc.length;
    doc.setSelection(100, 100);
    await app.commands.run('edit.repeatNoDialog');
    expect(doc.length).toBe(before + 2400);
    expect(doc.history.undoLabel).toBe('Mix Paste');
  });
});

describe('markers on the ruler', () => {
  it('a click on a marker moves the playhead there; a double-click on a range bar selects it', async () => {
    const { app, doc, view } = await makeView();
    const { createMarker } = await import('../src/model/markers.js');
    app.prefs.set('snapping', false);
    const cue = createMarker({ start: 6000, name: 'C' });
    const range = createMarker({ start: 24000, duration: 12000, name: 'R' });
    doc.apply('Markers', { ...doc.state, markers: [cue, range] });
    doc.setView(0, 48000);
    const el = view.ruler.el;
    el.setPointerCapture = () => {};
    const ev = (type, x) => {
      const e = new MouseEvent(type, { bubbles: true, button: 0 });
      Object.defineProperties(e, { offsetX: { value: x }, offsetY: { value: 20 }, pointerId: { value: 1 }, pointerType: { value: 'mouse' } });
      return e;
    };
    el.dispatchEvent(ev('pointerdown', 126));
    el.dispatchEvent(ev('pointerup', 126));
    expect(doc.cursor).toBe(6000);
    expect(doc.state.markers[0].start).toBe(6000);
    el.dispatchEvent(ev('dblclick', 620));
    expect([doc.selection.start, doc.selection.end]).toEqual([24000, 36000]);
    expect(view.selectedMarkers.has(range.id)).toBe(true);
  });
});

describe('snap distances', () => {
  it('ruler ticks pull from 4 px, markers from 8 px', async () => {
    const { app, doc, view } = await makeView();
    const { createMarker } = await import('../src/model/markers.js');
    app.prefs.set('snapping', true);
    app.prefs.set('snap', { ruler: true, rulerFine: false, markers: true, zero: false, frames: false });
    doc.setView(0, 48000); // 48 frames per px
    // 6 px from the 0.5 s tick: kept; 3 px: snapped.
    expect(view.snap(24000 + 6 * 48)).toBe(24288);
    expect(view.snap(24000 + 3 * 48)).toBe(24000);
    doc.apply('Marker', { ...doc.state, markers: [createMarker({ start: 30000, name: 'M' })] });
    expect(view.snap(30000 + 6 * 48)).toBe(30000);
  });
});

describe('Export Audio within Range Markers', () => {
  it('starts on Download while signed out to Puter', async () => {
    const { app, doc } = await makeView();
    const { createMarker } = await import('../src/model/markers.js');
    window.puter = { auth: { isSignedIn: () => false } };
    try {
      doc.apply('Range', { ...doc.state, markers: [createMarker({ start: 0, duration: 4800, name: 'A' })] });
      app.prefs.set('batchExport', { location: 'puter' });
      app.commands.run('file.exportRanges');
      await new Promise((r) => setTimeout(r, 10));
      expect(document.querySelector('.dialog select[aria-label=Location]').value).toBe('download');
      [...document.querySelectorAll('.dialog-foot .btn')].find((b) => b.textContent === 'Cancel').click();
    } finally {
      delete window.puter;
    }
  });
});

// Spectral tool options in the toolbar (brush size and opacity, Invert) and inverted
// spectral selections.
import { describe, it, expect, beforeAll } from 'vitest';
import { weightAt, rasterize, selectionBounds } from '../src/spectral/mask.js';
import { toolOptionKinds, invertSelection, spectralToolOptions } from '../src/spectral/tool-options.js';

const rect = { type: 'rect', t0: 100, t1: 200, f0: 1000, f1: 2000 };

describe('inverted spectral selections', () => {
  const inv = { channels: [true], shapes: [rect], invert: true };

  it('cover everything in the time range except the shapes', () => {
    expect(weightAt(inv, 150, 1500)).toBe(0);
    expect(weightAt(inv, 150, 5000)).toBe(1);
    expect(weightAt(inv, 150, 100)).toBe(1);
    // Outside the time range nothing is selected.
    expect(weightAt(inv, 300, 5000)).toBe(0);
  });

  it('reach every frequency in their time range', () => {
    expect(selectionBounds(inv)).toEqual({ t0: 100, t1: 200, f0: 0, f1: Infinity });
  });

  it('rasterize to the complement inside the time range', () => {
    const n = 64;
    const rate = 6400; // 100 Hz bins
    const m = rasterize(inv, { first: 150, cols: 3, hop: 100, n, rate, growBins: 0, growCols: 0 });
    const bins = n / 2 + 1;
    // Column 0 (t = 150): bins 10..20 clear, the rest selected.
    expect(m[5]).toBe(1);
    expect(m[15]).toBe(0);
    expect(m[25]).toBe(1);
    // Columns at t = 250 and 350 are outside the range.
    expect(m[bins + 5]).toBe(0);
    expect(m[2 * bins + 25]).toBe(0);
  });

  it('flip back and forth, leaving no selection alone', () => {
    const sel = { channels: [true], shapes: [rect] };
    expect(invertSelection(sel).invert).toBe(true);
    expect(invertSelection(invertSelection(sel)).invert).toBe(false);
    expect(invertSelection(null)).toBe(null);
  });
});

describe('tool options', () => {
  it('shows size and opacity for the brush, size for healing and Invert for the selection tools', () => {
    expect(toolOptionKinds('brush')).toEqual(['size', 'opacity']);
    expect(toolOptionKinds('heal')).toEqual(['size']);
    expect(toolOptionKinds('marquee')).toEqual(['invert']);
    expect(toolOptionKinds('lasso')).toEqual(['invert']);
    expect(toolOptionKinds('time')).toEqual([]);
  });

  let app;
  let doc;
  beforeAll(async () => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      disconnect() {}
    };
    HTMLCanvasElement.prototype.getContext = () => null;
    localStorage.clear();
    const { App } = await import('../src/app.js');
    const { installCore } = await import('../src/features/core.js');
    const { installSpectralAnalysis } = await import('../src/features/spectral-analysis.js');
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { Channel } = await import('../src/audio/channel.js');
    app = new App();
    installCore(app);
    installSpectralAnalysis(app);
    doc = new AudioFile({ name: 't.wav', sampleRate: 48000, channels: [Channel.fromSamples(new Float32Array(48000))] });
    app.addDocument(doc);
  });

  it('follows the tool and edits the brush settings', async () => {
    const { settings, setSpectralSelection, docState } = await import('../src/spectral/state.js');
    const el = spectralToolOptions(app);
    document.body.replaceChildren(el);
    expect(el.hidden).toBe(true);
    app.prefs.set('spectralDisplay', true);
    app.commands.run('tool.brush');
    expect(el.hidden).toBe(false);
    const [size, opacity] = el.querySelectorAll('input');
    expect(size.closest('.tool-opt').hidden).toBe(false);
    expect(opacity.closest('.tool-opt').hidden).toBe(false);
    size.value = '500';
    size.dispatchEvent(new Event('change'));
    expect(settings(app).brushSize).toBe(200);
    expect(size.value).toBe('200');
    opacity.value = '40';
    opacity.dispatchEvent(new Event('change'));
    expect(settings(app).brushOpacity).toBeCloseTo(0.4);

    app.commands.run('tool.marquee');
    const invert = el.querySelector('.tool-opt-invert');
    expect(size.closest('.tool-opt').hidden).toBe(true);
    expect(invert.hidden).toBe(false);
    expect(invert.disabled).toBe(true);
    setSpectralSelection(app, doc, { channels: [true], shapes: [rect] });
    expect(invert.disabled).toBe(false);
    invert.click();
    expect(docState(doc).selection.invert).toBe(true);
    expect(invert.getAttribute('aria-pressed')).toBe('true');

    app.prefs.set('spectralDisplay', false);
    expect(el.hidden).toBe(true);
  });
});

describe('spectral right-click menu', () => {
  it('adds Invert, Clear and the display settings over the spectral display only', async () => {
    localStorage.clear();
    const { App } = await import('../src/app.js');
    const { installCore } = await import('../src/features/core.js');
    const { installSpectralAnalysis } = await import('../src/features/spectral-analysis.js');
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { Channel } = await import('../src/audio/channel.js');
    const app = new App();
    installCore(app);
    installSpectralAnalysis(app);
    const doc = new AudioFile({ name: 't.wav', sampleRate: 48000, channels: [Channel.fromSamples(new Float32Array(48000))] });
    app.addDocument(doc);
    const { WaveformView } = await import('../src/editor/waveform-view.js');
    const { setSpectralSelection, docState } = await import('../src/spectral/state.js');
    app.prefs.set('spectralDisplay', true);
    const view = new WaveformView(app, doc);
    document.body.replaceChildren(view.el);
    const layer = view.layers.find((l) => l.id === 'spectral');
    layer.layout({ x: 0, y: 100, width: 600, height: 200, dpr: 1 });
    view.surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 300 });
    expect(layer.menuItems({ clientX: 50, clientY: 40 })).toBe(null);
    const items = layer.menuItems({ clientX: 50, clientY: 200 });
    expect(items.map((i) => i.label)).toEqual(['Invert Spectral Selection', 'Clear Spectral Selection', 'Spectral Display']);
    expect(items[0].enabled).toBe(false);
    setSpectralSelection(app, doc, { channels: [true], shapes: [rect] });
    const [inv, clear] = layer.menuItems({ clientX: 50, clientY: 200 });
    inv.run();
    expect(docState(doc).selection.invert).toBe(true);
    expect(layer.menuItems({ clientX: 50, clientY: 200 })[0].label).toBe('Uninvert Spectral Selection');
    clear.run();
    expect(docState(doc).selection).toBe(null);
    view.destroy();
  });
});

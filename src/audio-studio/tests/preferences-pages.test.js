// Preferences pages added for channel mapping, devices, cache, memory, video
// and the extra appearance colors, plus OK/Cancel in the dialog.
import { describe, it, expect, vi } from 'vitest';
import { Prefs, DEFAULTS } from '../src/lib/prefs.js';
import { appearanceVars, brighten, BRIGHTNESS_TOKENS } from '../src/ui/appearance.js';
import { revertPrefs, colorSet, sameColors, openAudioBytes, CATEGORIES, pageKeys } from '../src/ui/preferences.js';
import { markerOptions, shiftMarkersForDelete, shiftMarkersForInsert, createMarker } from '../src/model/markers.js';
import { zoomInFactor } from '../src/editor/view-prefs.js';
import { pitchSettings } from '../src/spectral/state.js';
import { Engine, cleanMap } from '../src/engine/engine.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
}

async function makeApp() {
  HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  localStorage.clear();
  const { App } = await import('../src/app.js');
  const { FEATURES } = await import('../src/features.js');
  const app = new App();
  for (const install of FEATURES) install(app);
  app.syncGraph = () => {};
  return app;
}

const prefsOf = (values) => ({ get: (k) => (k in values ? values[k] : DEFAULTS[k]) });

describe('preference pages', () => {
  it('has a default for every key on the new pages', () => {
    for (const id of ['channelMap', 'audioHardware', 'cache', 'memory', 'video', 'spectral', 'clips', 'effects']) {
      const page = CATEGORIES.find((c) => c.id === id);
      for (const k of pageKeys(page)) if (k !== 'spectralSettings') expect(k in DEFAULTS, `${id}: ${k}`).toBe(true);
    }
  });

  it('puts preferences back on Cancel and keeps them on OK', async () => {
    const app = await makeApp();
    app.prefs.set('tempo', 100);
    let done = app.commands.run('prefs.time');
    app.prefs.set('tempo', 140);
    app.prefs.set('markerLock', true);
    [...document.querySelectorAll('.prefs-window .dialog-foot .btn')].find((b) => b.textContent === 'Cancel').click();
    await done;
    expect(app.prefs.get('tempo')).toBe(100);
    expect('markerLock' in app.prefs.values).toBe(false);
    expect(app.prefs.get('prefsCategory')).toBe('time');
    done = app.commands.run('prefs.time');
    app.prefs.set('tempo', 140);
    document.querySelector('.prefs-window .dialog-foot .btn.primary').click();
    await done;
    expect(app.prefs.get('tempo')).toBe(140);
  });

  it('turns Reset All Warning Dialogs off once used, keeping focus in the page', async () => {
    const app = await makeApp();
    app.prefs.set('dismissedNotices', ['batch-intro']);
    const done = app.commands.run('prefs.general');
    const btn = [...document.querySelectorAll('.prefs-window button')].find(
      (b) => b.textContent === 'Reset All Warning Dialogs',
    );
    expect(btn.disabled).toBe(false);
    btn.focus();
    btn.click();
    expect(app.prefs.get('dismissedNotices')).toEqual([]);
    expect(btn.disabled).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('.prefs-pane'));
    document.querySelector('.prefs-window .dialog-foot .btn.primary').click();
    await done;
  });

  it('opens notices with focus on their action, not on "Don\'t show this again"', async () => {
    const app = await makeApp();
    const { showNotice } = await import('../src/ui/notices.js');
    const shown = showNotice(app, { id: 'test-notice', title: 'Note', message: 'Hello' });
    expect(document.activeElement.textContent).toBe('OK');
    document.activeElement.click();
    expect(await shown).toBe(true);
  });

  it('reverts only keys that changed', () => {
    const p = new Prefs(memoryStorage());
    p.set('hud', false);
    const snap = structuredClone(p.values);
    p.set('hud', true);
    p.set('zoomStep', 25);
    p.set('prefsCategory', 'video');
    expect(revertPrefs(p, snap).sort()).toEqual(['hud', 'zoomStep']);
    expect(p.get('hud')).toBe(false);
    expect(p.get('zoomStep')).toBe(50);
    expect(p.get('prefsCategory')).toBe('video');
  });
});

describe('appearance colors and brightness', () => {
  it('maps playhead and marker colors to theme properties', () => {
    const vars = appearanceVars(prefsOf({ waveColors: { playhead: '#ff0000', cue: '#00ff00', subclip: '#0000ff' } }), 'dark');
    expect(vars['--playhead']).toBe('#ff0000');
    expect(vars['--cti']).toBe('#ff0000');
    expect(vars['--marker']).toBe('#00ff00');
    expect(vars['--marker-range']).toBe('rgba(0, 255, 0, 0.18)');
    expect(vars['--marker-subclip']).toBe('#0000ff');
    expect(vars['--marker-cart']).toBeUndefined();
  });

  it('lightens and darkens surfaces from the theme values', () => {
    const base = (name) => (name === '--bg-panel' ? '#202020' : '#101010');
    const lighter = appearanceVars(prefsOf({ uiBrightness: 100 }), 'dark', base);
    expect(Object.keys(lighter).sort()).toEqual([...BRIGHTNESS_TOKENS].sort());
    expect(lighter['--bg-panel']).toBe(brighten('#202020', 100));
    expect(parseInt(lighter['--bg-panel'].slice(1, 3), 16)).toBeGreaterThan(0x20);
    const darker = appearanceVars(prefsOf({ uiBrightness: -100 }), 'dark', base);
    expect(parseInt(darker['--bg-panel'].slice(1, 3), 16)).toBeLessThan(0x20);
    expect(appearanceVars(prefsOf({ uiBrightness: 0 }), 'dark', base)).toEqual({});
  });

  it('keeps text readable on the surfaces at any brightness, in both themes', async () => {
    const { contrastRatio, TEXT_TOKENS } = await import('../src/ui/appearance.js');
    const fs = await import('node:fs');
    const css = fs.readFileSync(`${import.meta.dirname}/../src/styles/tokens.css`, 'utf8');
    const surfaces = ['--bg-app', '--bg-panel', '--bg-panel-alt', '--bg-raised', '--bg-input'];
    for (const theme of ['dark', 'light']) {
      const sel = `:root[data-theme-resolved='${theme}']`;
      const block = css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
      const base = (name) => block.match(new RegExp(`${name}: (#[0-9a-f]{6});`))?.[1] || '';
      const worst = (text, of) => Math.min(...surfaces.map((n) => contrastRatio(text, of(n))));
      for (const bright of [-100, -50, 50, 100]) {
        const vars = appearanceVars(prefsOf({ uiBrightness: bright }), theme, base);
        for (const name of TEXT_TOKENS) {
          const before = worst(base(name), base);
          const after = worst(vars[name] || base(name), (n) => vars[n]);
          expect(after).toBeGreaterThanOrEqual(Math.min(4.5, before) - 0.01);
        }
      }
      // Main text in the dark theme at full brightness was 3.7:1 on raised surfaces.
      if (theme !== 'dark') continue;
      const v = appearanceVars(prefsOf({ uiBrightness: 100 }), 'dark', base);
      expect(contrastRatio(v['--text'], v['--bg-raised'])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('stores color sets without unset colors and compares them field by field', () => {
    expect(colorSet({ wave: '#ABC', playhead: 'nope' })).toEqual({ wave: '#abc' });
    expect(colorSet({})).toBeNull();
    expect(sameColors({ name: 'x' }, null)).toBe(true);
    expect(sameColors({ cue: '#ffffff' }, { cue: '#FFFFFF' })).toBe(true);
    expect(sameColors({ cue: '#ffffff' }, {})).toBe(false);
  });
});

describe('behavior behind the new options', () => {
  it('locks markers to the timeline', () => {
    const markers = [createMarker({ start: 100 }), createMarker({ start: 50, duration: 100 })];
    expect(shiftMarkersForDelete(markers, 0, 20).map((m) => m.start)).toEqual([80, 30]);
    markerOptions.lock = true;
    try {
      expect(shiftMarkersForDelete(markers, 0, 20)).toBe(markers);
      expect(shiftMarkersForInsert(markers, 0, 20)).toBe(markers);
    } finally {
      markerOptions.lock = false;
    }
  });

  it('follows the marker lock preference', async () => {
    const app = await makeApp();
    app.prefs.set('markerLock', true);
    expect(markerOptions.lock).toBe(true);
    app.prefs.reset(['markerLock']);
    expect(markerOptions.lock).toBe(false);
  });

  it('uses the zoom step for Zoom In and Zoom Out', async () => {
    const app = await makeApp();
    expect(zoomInFactor(app)).toBe(0.5);
    app.prefs.set('zoomStep', 20);
    expect(zoomInFactor(app)).toBeCloseTo(0.8);
    const doc = new AudioFile({ name: 'z.wav', sampleRate: 1000, channels: [Channel.fromSamples(new Float32Array(10000))] });
    app.addDocument(doc);
    doc.setView(0, 10000);
    app.commands.run('view.zoomInTime');
    expect(doc.view.end - doc.view.start).toBeCloseTo(8000, -1);
    app.commands.run('view.zoomOutTime');
    expect(doc.view.end - doc.view.start).toBeCloseTo(10000, -1);
  });

  it('reads pitch analysis settings', () => {
    expect(pitchSettings(prefsOf({}), 48000)).toEqual({ n: 2048, fmin: 50, fmax: 2000 });
    expect(pitchSettings(prefsOf({}), 96000).n).toBe(4096);
    // 192 kHz needs 8192 points for lags down to 50 Hz (a 4096 window stopped at 94 Hz).
    expect(pitchSettings(prefsOf({}), 192000).n).toBe(8192);
    expect(pitchSettings(prefsOf({ pitchWindow: 8192, pitchMinHz: 80, pitchMaxHz: 90 }), 48000)).toEqual({ n: 8192, fmin: 80, fmax: 160 });
  });

  it('warns once when open audio passes the memory limit', async () => {
    const app = await makeApp();
    const notify = vi.spyOn(app, 'notify').mockImplementation(() => {});
    app.prefs.set('memoryWarnMb', 1);
    const big = () => new AudioFile({ name: 'big.wav', sampleRate: 48000, channels: [Channel.fromSamples(new Float32Array(300000))] });
    app.addDocument(big());
    expect(openAudioBytes(app)).toBe(1200000);
    expect(notify).toHaveBeenCalledTimes(1);
    app.addDocument(big());
    expect(notify).toHaveBeenCalledTimes(1);
    notify.mockRestore();
  });
});

describe('engine channel maps and devices', () => {
  function fakeContext(maxChannelCount = 8) {
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    const ctx = {
      destination: { maxChannelCount, channelCount: 2 },
      createChannelSplitter: vi.fn(() => node()),
      createChannelMerger: vi.fn(() => node()),
    };
    return ctx;
  }

  it('cleans channel maps', () => {
    expect(cleanMap([1, 0])).toEqual([1, 0]);
    expect(cleanMap(['x', -1])).toEqual([0, -1]);
    expect(cleanMap(null)).toEqual([0, 1]);
  });

  it('routes the mix through a channel map and back to a direct connection', () => {
    const e = new Engine();
    e.ctx = fakeContext();
    e.node = { connect: vi.fn(), disconnect: vi.fn() };
    e.setOutputMap([1, 0]);
    const [split, merge] = e.outputRoute;
    expect(e.node.connect).toHaveBeenCalledWith(split);
    expect(split.connect).toHaveBeenCalledWith(merge, 0, 1);
    expect(split.connect).toHaveBeenCalledWith(merge, 1, 0);
    expect(merge.connect).toHaveBeenCalledWith(e.ctx.destination);
    e.setOutputMap([2, 3]);
    expect(e.ctx.destination.channelCount).toBe(4);
    e.setOutputMap([0, 1]);
    expect(e.outputRoute).toBeNull();
    expect(e.node.connect).toHaveBeenLastCalledWith(e.ctx.destination);
  });

  it('applies device preferences to the engine', async () => {
    const app = await makeApp();
    const sink = vi.spyOn(app.engine, 'setSink').mockResolvedValue();
    app.prefs.set('outputMap', [1, 0]);
    expect(app.engine.outputMap).toEqual([1, 0]);
    app.prefs.set('inputMap', [0, 0]);
    expect(app.engine.inputMap).toEqual([0, 0]);
    app.prefs.set('latencyHint', 'playback');
    expect(app.engine.latencyHint).toBe('playback');
    app.prefs.set('outputDevice', 'abc');
    expect(sink).toHaveBeenCalledWith('abc');
    sink.mockRestore();
    app.prefs.reset(['outputMap', 'inputMap', 'latencyHint', 'outputDevice']);
  });
});

// Preferences: the categorized dialog, settings import/export and the
// behavior behind the options.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prefs, DEFAULTS, exportSettings, validateSettings } from '../src/lib/prefs.js';
import { formatTime, parseTime, musicalStep, beatSeconds, TIME_FORMATS } from '../src/lib/time.js';
import * as E from '../src/model/edits.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { markerOptions, createMarker } from '../src/model/markers.js';
import { panGains, renderBlock, ChunkStore, createScratch } from '../src/engine/mixcore.js';
import { nextShuttleSpeed, shuttleJump } from '../src/commands/shuttle.js';
import { alphabeticalGroups, effectMenuSpec, EFFECT_GROUPS } from '../src/ui/menus.js';
import { freeTrackShift, placementOptions, newTrack } from '../src/multitrack/insert.js';
import * as S from '../src/model/session-edits.js';
import { appearanceVars } from '../src/ui/appearance.js';
import { slotSpecs, rackOptions } from '../src/effects/rack.js';
import { searchPreferences, preferencePages, pageKeys, CATEGORIES } from '../src/ui/preferences.js';

const RATE = 48000;

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

const ramp = (n, v = 1) => Channel.fromSamples(new Float32Array(n).fill(v));

describe('preference storage', () => {
  it('keeps current behavior as the default for new keys', () => {
    expect(DEFAULTS.returnToStart).toBe(true);
    expect(DEFAULTS.returnToStartOn).toBe('first');
    expect(DEFAULTS.stopAtSelectionEnd).toBe(true);
    expect(DEFAULTS.panLaw).toBe('balance');
    expect(DEFAULTS.markerUndo).toBe(true);
    expect(DEFAULTS.smoothDelete).toBe(false);
    expect(DEFAULTS.meterCaution).toBe(-12);
    expect(DEFAULTS.meterWarning).toBe(-3);
    expect(DEFAULTS.subdivisions).toBe(100);
  });

  it('resets chosen keys and emits changes', () => {
    const p = new Prefs(memoryStorage());
    p.set('tempo', 90);
    p.set('hud', false);
    const seen = [];
    p.on('change', (k) => seen.push(k));
    p.reset(['tempo']);
    expect(p.get('tempo')).toBe(120);
    expect(p.get('hud')).toBe(false);
    expect(seen).toEqual(['tempo']);
  });

  it('exports and validates settings, leaving out device-local keys', () => {
    const p = new Prefs(memoryStorage());
    p.set('tempo', 100);
    p.set('shortcuts', { 'edit.cut': ['Mod+K'] });
    p.set('recent', [{ name: 'a.wav', path: '/x/a.wav' }]);
    const data = exportSettings(p, new Date('2026-01-02T03:04:05Z'));
    expect(data.prefs.tempo).toBe(100);
    expect(data.prefs.shortcuts).toEqual({ 'edit.cut': ['Mod+K'] });
    expect('recent' in data.prefs).toBe(false);
    const { values, skipped } = validateSettings(JSON.parse(JSON.stringify(data)));
    expect(values.tempo).toBe(100);
    expect(skipped).toEqual([]);
  });

  it('rejects other files and skips values of the wrong type', () => {
    expect(() => validateSettings({ hello: 1 })).toThrow(/not an Audio Studio settings file/);
    expect(() => validateSettings([])).toThrow();
    const { values, skipped } = validateSettings({ kind: 'audio-studio-settings', version: 1, prefs: { tempo: 'fast', hud: false, 'bad key!': 1, recent: [], someEffectPresets: { a: 1 } } });
    expect(values).toEqual({ hud: false, someEffectPresets: { a: 1 } });
    expect(skipped.sort()).toEqual(['bad key!', 'recent', 'tempo']);
  });

  it('replaceAll keeps local-only keys', () => {
    const p = new Prefs(memoryStorage());
    p.set('recent', [{ name: 'r' }]);
    p.set('tempo', 99);
    p.replaceAll({ hud: false });
    expect(p.get('tempo')).toBe(120);
    expect(p.get('hud')).toBe(false);
    expect(p.get('recent')).toEqual([{ name: 'r' }]);
  });
});

describe('time display options', () => {
  it('formats and parses a custom frame rate', () => {
    expect(TIME_FORMATS.some((f) => f.id === 'frames')).toBe(true);
    expect(formatTime(RATE * 1.5, RATE, 'frames', { fps: 12 })).toBe('00:00:01:06');
    expect(parseTime('00:00:01:06', RATE, 'frames', { fps: 12 })).toBe(RATE * 1.5);
  });

  it('uses the beat note and subdivisions for bars and beats', () => {
    // 6/8 at 120 quarter notes per minute: an eighth-note beat lasts 0.25 s.
    const music = { tempo: 120, beatsPerBar: 6, beatNote: 8, subdivisions: 4 };
    expect(beatSeconds(music)).toBe(0.25);
    expect(formatTime(RATE * 1.5, RATE, 'bars', music)).toBe('2:1.00');
    expect(formatTime(RATE * 1.5 + RATE * 0.125, RATE, 'bars', music)).toBe('2:1.02');
    expect(parseTime('2:1.02', RATE, 'bars', music)).toBe(Math.round(RATE * 1.625));
    // The default (hundredths) reads as before.
    expect(formatTime(RATE * 0.75, RATE, 'bars', { tempo: 120, beatsPerBar: 4 })).toBe('1:2.50');
  });

  it('picks a grid step from subdivisions up to bars', () => {
    const music = { tempo: 120, beatsPerBar: 4, beatNote: 4, subdivisions: 4 };
    expect(musicalStep(1, RATE, music, 12)).toBe(RATE * 0.125); // a sixteenth at 1 frame per pixel
    expect(musicalStep(10000, RATE, music, 12)).toBe(RATE * 4); // two bars once beats get too narrow
  });
});

describe('edit smoothing', () => {
  it('crossfades a delete without changing the result length', () => {
    const state = { sampleRate: RATE, channels: [Channel.fromSamples(Float32Array.from({ length: 1000 }, (_, i) => (i < 400 ? 1 : i < 600 ? 0 : -1)))], markers: [] };
    const plain = E.deleteRange(state, 400, 600);
    const smooth = E.deleteRange(state, 400, 600, null, { smooth: 20 });
    expect(E.lengthOf(smooth)).toBe(E.lengthOf(plain));
    const a = plain.channels[0].toArray(390, 410);
    const b = smooth.channels[0].toArray(390, 410);
    expect(a[9]).toBe(1);
    expect(a[10]).toBe(-1);
    // The smoothed join ramps instead of jumping.
    expect(b[9]).toBeLessThan(1);
    expect(b[9]).toBeGreaterThan(0);
    expect(smooth.channels[0].toArray(0, 380)).toEqual(plain.channels[0].toArray(0, 380));
  });

  it('blends processed edges into the original', () => {
    const before = { sampleRate: RATE, channels: [ramp(1000, 1)], markers: [] };
    const after = E.gainRange(before, 200, 800, 0);
    const out = E.smoothBoundaries(before, after, 200, 800, 50);
    const s = out.channels[0].toArray();
    expect(s[199]).toBe(1);
    expect(s[200]).toBeGreaterThan(0.9);
    expect(s[249]).toBeLessThan(0.02);
    expect(s[500]).toBe(0);
    expect(s[799]).toBeGreaterThan(0.9);
    expect(s[800]).toBe(1);
  });

  it('copies markers inside a range for the clipboard', () => {
    const ms = [createMarker({ start: 50 }), createMarker({ start: 150, duration: 100 }), createMarker({ start: 400 })];
    const out = E.markersInRange(ms, 100, 200);
    expect(out.map((m) => [m.start, m.duration])).toEqual([[50, 50]]);
  });

  it('draws a cosine fade', () => {
    expect(E.fadeCurve(0.5, 2)).toBeCloseTo(0.5);
    expect(E.fadeCurve(0.25, 2)).toBeCloseTo(0.1464, 3);
  });
});

describe('marker undo', () => {
  beforeEach(() => {
    markerOptions.undo = true;
  });

  it('keeps marker-only edits out of the history when turned off', () => {
    const doc = new AudioFile({ name: 'a.wav', sampleRate: RATE, channels: [ramp(100)] });
    markerOptions.undo = false;
    doc.apply('Add Marker', { ...doc.state, markers: [createMarker({ start: 10 })] });
    expect(doc.history.entries.length).toBe(1);
    expect(doc.state.markers.length).toBe(1);
    doc.apply('Gain', E.gainRange(doc.state, 0, 50, 0.5));
    expect(doc.history.entries.length).toBe(2);
    markerOptions.undo = true;
    doc.apply('Add Marker', { ...doc.state, markers: [...doc.state.markers, createMarker({ start: 20 })] });
    expect(doc.history.entries.length).toBe(3);
  });

  it('keeps out-of-history markers through undo and redo of other edits', () => {
    const doc = new AudioFile({ name: 'a.wav', sampleRate: RATE, channels: [ramp(100)] });
    doc.apply('Gain', E.gainRange(doc.state, 0, 50, 0.5));
    markerOptions.undo = false;
    doc.apply('Add Marker', { ...doc.state, markers: [createMarker({ start: 10 }), createMarker({ start: 20 })] });
    doc.history.undo();
    expect(doc.state.markers.length).toBe(2);
    expect(doc.state.channels[0].toArray()[10]).toBeCloseTo(ramp(100).toArray()[10]);
    doc.history.redo();
    expect(doc.state.markers.length).toBe(2);
  });
});

describe('pan law', () => {
  it('keeps the balance law by default and supports equal power', () => {
    expect(panGains(0, null)).toEqual([1, 1]);
    expect(panGains(0.5, null)).toEqual([0.5, 1]);
    const [l, r] = panGains(0, { mode: 'equalPower', centerDb: -3 });
    expect(20 * Math.log10(l)).toBeCloseTo(-3.01, 1);
    expect(r).toBeCloseTo(l);
    const [l6] = panGains(0, { mode: 'equalPower', centerDb: -6 });
    expect(20 * Math.log10(l6)).toBeCloseTo(-6, 1);
    const hard = panGains(1, { mode: 'equalPower', centerDb: -3 });
    expect(hard[0]).toBeCloseTo(0);
    expect(hard[1]).toBeCloseTo(1);
  });

  it('applies the graph pan law when mixing', () => {
    const store = new ChunkStore();
    store.put('s', 0, [new Float32Array(128).fill(1)]);
    const clip = { id: 'c', source: 's', channels: 1, start: 0, offset: 0, length: 128, gain: 1, fadeIn: 0, fadeOut: 0 };
    const mix = (panLaw) => {
      const graph = { rate: RATE, tracks: [{ id: 't', gain: 1, pan: 0, mute: false, solo: false, clips: [clip] }], master: { gain: 1 }, panLaw };
      const out = [new Float32Array(128), new Float32Array(128)];
      renderBlock(graph, store, 0, 128, out, createScratch(128));
      return out[0][10];
    };
    expect(mix(undefined)).toBe(1);
    expect(mix({ mode: 'equalPower', centerDb: -3 })).toBeCloseTo(Math.pow(10, -3 / 20), 4);
  });
});

describe('J/K/L shuttle', () => {
  it('doubles up to 16x and switches direction', () => {
    expect(nextShuttleSpeed(0, 1)).toBe(1);
    expect(nextShuttleSpeed(1, 1)).toBe(2);
    expect(nextShuttleSpeed(16, 1)).toBe(16);
    expect(nextShuttleSpeed(4, -1)).toBe(-1);
    expect(nextShuttleSpeed(-1, -1)).toBe(-2);
    expect(nextShuttleSpeed(0, 1, 2)).toBe(2);
  });

  it('jumps ahead faster than 1x and steps back when reversing', () => {
    expect(shuttleJump(1, RATE)).toBe(0);
    expect(shuttleJump(2, RATE, 0.1)).toBe(RATE * 0.1);
    expect(shuttleJump(-1, RATE, 0.1)).toBe(-RATE * 0.2);
  });
});

describe('effect menu order', () => {
  it('groups names alphabetically into small submenus', () => {
    const items = ['Delay', 'Amplify', 'Chorus', 'Echo', 'Bass'].map((label) => ({ id: label, label }));
    const groups = alphabeticalGroups(items, 2);
    expect(groups.map((g) => g.label)).toEqual(['A–B', 'C–D', 'E']);
    expect(groups[0].items.map((i) => i.label)).toEqual(['Amplify', 'Bass']);
  });

  it('builds category or name submenus for the Effects menu', () => {
    expect(effectMenuSpec(null).map((g) => g.label)).toEqual(EFFECT_GROUPS.map((g) => g.label));
    const app = { prefs: { get: () => 'name' }, commands: { get: (id) => ['fx.amplify', 'fx.echo', 'fx.chorus'].includes(id), label: (id) => ({ 'fx.amplify': 'Amplify', 'fx.echo': 'Echo', 'fx.chorus': 'Chorus' })[id] } };
    const spec = effectMenuSpec(app);
    expect(spec.flatMap((g) => g.submenu)).toEqual(['fx.amplify', 'fx.chorus', 'fx.echo']);
  });
});

describe('clip placement', () => {
  it('finds the first track shift where pasted clips do not overlap', () => {
    let state = S.createSessionState({ tracks: 3 });
    const [t0, t1] = state.tracks;
    state = S.addClips(state, [S.createClip({ trackId: t0.id, sourceId: 'x', start: 0, length: 100 }), S.createClip({ trackId: t1.id, sourceId: 'x', start: 50, length: 100 })]);
    expect(freeTrackShift(state, 0, [{ trackOffset: 0, start: 10, end: 20 }])).toBe(1);
    expect(freeTrackShift(state, 0, [{ trackOffset: 0, start: 60, end: 70 }])).toBe(2);
    expect(freeTrackShift(state, 0, [{ trackOffset: 0, start: 200, end: 300 }])).toBe(0);
    expect(freeTrackShift(state, 2, [{ trackOffset: 0, start: 0, end: 10 }, { trackOffset: 1, start: 0, end: 10 }])).toBe(0);
  });

  it('gives new tracks a random color different from the previous track', () => {
    const state = S.createSessionState({ tracks: 1 });
    placementOptions.randomColor = true;
    placementOptions.random = () => 0;
    try {
      const { track } = newTrack(state, {});
      expect(track.color).not.toBe(state.tracks[0].color);
    } finally {
      placementOptions.randomColor = false;
      placementOptions.random = Math.random;
    }
  });
});

describe('appearance', () => {
  it('maps the accent and waveform colors to theme properties', () => {
    const prefs = { get: (k) => ({ accentColor: 'teal', waveColors: { wave: '#ff0000', selection: '#00ff00', background: '#000000' } })[k] };
    const vars = appearanceVars(prefs, 'dark');
    expect(vars['--accent']).toBe('#1fb5a5');
    expect(vars['--wave']).toBe('#ff0000');
    expect(vars['--bg-editor']).toBe('#000000');
    expect(vars['--sel-bg']).toBe('rgba(0, 255, 0, 0.24)');
    expect(appearanceVars({ get: (k) => DEFAULTS[k] }, 'dark')).toEqual({});
  });
});

describe('bypassed effects during playback', () => {
  it('sends switched-off slots as shadow specs only when asked', async () => {
    await import('../src/effects/index.js');
    const slots = [{ id: 'a', effect: 'amplify', values: {}, enabled: false }, { id: 'b', effect: 'amplify', values: {}, enabled: true }];
    expect(slotSpecs(slots).length).toBe(1);
    rackOptions.processBypassed = true;
    try {
      const specs = slotSpecs(slots);
      expect(specs.length).toBe(2);
      expect(specs[0]).toMatchObject({ enabled: false, shadow: true });
    } finally {
      rackOptions.processBypassed = false;
    }
  });
});

describe('preferences dialog', () => {
  it('lists every category and keeps keys per page for Reset', () => {
    const ids = CATEGORIES.map((c) => c.id);
    expect(ids).toEqual(['general', 'appearance', 'channelMap', 'audioHardware', 'autoSave', 'controlSurface', 'data', 'effects', 'cache', 'memory', 'markers', 'multitrack', 'clips', 'playback', 'spectral', 'time', 'video']);
    const keys = pageKeys(CATEGORIES.find((c) => c.id === 'data'));
    expect(keys).toEqual(['smoothDelete', 'smoothDeleteMs', 'smoothEdits', 'smoothEditsMs', 'srcQuality', 'srcFilter', 'batchConcurrency']);
    // Every declared key has a default (no option without a stored setting).
    // (Spectral display settings share one stored object with their own defaults.)
    for (const c of CATEGORIES) for (const k of pageKeys(c)) if (k !== 'spectralSettings') expect(k in DEFAULTS, k).toBe(true);
  });

  it('places extension sections on the category they name', () => {
    const app = { preferenceSections: [{ category: 'audioHardware', title: 'Devices', build: () => [] }, () => []] };
    const pages = preferencePages(app);
    expect(pages.find((p) => p.id === 'audioHardware').sections.map((s) => s.title)).toEqual(['Devices', undefined]);
    expect(pages.find((p) => p.id === 'general').sections.length).toBe(CATEGORIES[0].sections.length + 1);
  });

  it('searches options across pages', () => {
    const hits = searchPreferences(CATEGORIES, 'crossfade');
    const pages = new Set(hits.map((h) => h.page.id));
    expect(pages.has('data')).toBe(true);
    expect(pages.has('clips')).toBe(true);
    expect(searchPreferences(CATEGORIES, 'zzzz')).toEqual([]);
  });

  it('opens on the last page, navigates by keyboard, filters by search and resets a page', async () => {
    const app = await makeApp();
    app.prefs.set('prefsCategory', 'memory');
    const done = app.commands.run('edit.preferences');
    const dialog = document.querySelector('.prefs-window');
    expect(dialog).toBeTruthy();
    const selected = () => dialog.querySelector('.prefs-tab[aria-selected="true"]').dataset.page;
    expect(selected()).toBe('memory');
    expect(document.activeElement.dataset.page).toBe('memory');
    // Arrow keys move through the list.
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(selected()).toBe('markers');
    expect(app.prefs.get('prefsCategory')).toBe('markers');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(selected()).toBe('general');
    // Changing a control applies at once.
    const box = [...dialog.querySelectorAll('.prefs-row')].find((r) => r.dataset.key === 'syncFiles').querySelector('input');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(app.prefs.get('syncFiles')).toBe(true);
    // Search narrows the page list; Enter jumps to the first match.
    const search = dialog.querySelector('.prefs-search');
    search.value = 'pan law equal';
    search.dispatchEvent(new Event('input'));
    search.value = 'equal power';
    search.dispatchEvent(new Event('input'));
    const tabs = [...dialog.querySelectorAll('.prefs-tab')].map((t) => t.dataset.page);
    expect(tabs).toEqual(['multitrack']);
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(selected()).toBe('multitrack');
    expect(document.activeElement.closest('.prefs-row').dataset.key).toBe('panLaw');
    // Another command can switch the open dialog to a page.
    app.commands.run('prefs.general');
    expect(selected()).toBe('general');
    // Reset this page.
    [...dialog.querySelectorAll('.prefs-resets .btn')].find((b) => b.textContent === 'Reset Page').click();
    await Promise.resolve();
    expect(app.prefs.get('syncFiles')).toBe(false);
    expect(dialog.querySelector('.prefs-row[data-key="syncFiles"] input').checked).toBe(false);
    dialog.querySelector('.dialog-foot .btn.primary').click();
    await done;
    expect(document.querySelector('.prefs-window')).toBeNull();
  });

  it('builds the audio hardware page from its extension section', async () => {
    const app = await makeApp();
    const done = app.commands.run('prefs.audioHardware');
    const dialog = document.querySelector('.prefs-window');
    expect(dialog.querySelector('.prefs-pane').textContent).toContain('Default Input');
    dialog.querySelector('.dialog-foot .btn.primary').click();
    await done;
  });
});

describe('playback preferences', () => {
  it('returns to the start on the second stop when asked', async () => {
    const app = await makeApp();
    const doc = new AudioFile({ name: 'p.wav', sampleRate: RATE, channels: [ramp(RATE * 4)] });
    app.addDocument(doc);
    app.prefs.set('returnToStartOn', 'second');
    app.playStart = RATE;
    app.engine.emit('ended', RATE * 3);
    expect(doc.cursor).toBe(RATE * 3);
    expect(app.canReturn).toBe(true);
    expect(app.commands.isEnabled('transport.stop')).toBe(true);
    app.stop();
    expect(doc.cursor).toBe(RATE);
    expect(app.canReturn).toBe(false);
  });

  it('can keep playing past the end of the selection', async () => {
    const app = await makeApp();
    const doc = new AudioFile({ name: 'p.wav', sampleRate: RATE, channels: [ramp(RATE * 4)] });
    app.addDocument(doc);
    const play = vi.spyOn(app.engine, 'play').mockResolvedValue();
    doc.setSelection(RATE, RATE * 2);
    doc.setCursor(RATE);
    await app.play();
    expect(play.mock.calls[0][0].to).toBe(RATE * 2);
    app.prefs.set('stopAtSelectionEnd', false);
    await app.play();
    expect(play.mock.calls[1][0].to).toBe(RATE * 4);
    play.mockRestore();
  });

  it('crossfades delete edges and copies markers with the clipboard when enabled', async () => {
    const app = await makeApp();
    const samples = Float32Array.from({ length: 1000 }, (_, i) => (i < 500 ? 1 : -1));
    const doc = new AudioFile({ name: 'p.wav', sampleRate: 1000, channels: [Channel.fromSamples(samples)], markers: [createMarker({ start: 300 })] });
    app.addDocument(doc);
    app.prefs.set('smoothDelete', true);
    app.prefs.set('smoothDeleteMs', 10);
    app.prefs.set('markersWithClipboard', true);
    doc.setSelection(200, 500);
    await app.commands.run('edit.cut');
    expect(app.clipboard.markers.map((m) => m.start)).toEqual([100]);
    const s = doc.state.channels[0].toArray(195, 205);
    expect(s[6]).toBeGreaterThan(-1);
    expect(s[6]).toBeLessThan(1);
    doc.setSelection(0, 0);
    doc.setCursor(0);
    await app.commands.run('edit.paste');
    expect(doc.state.markers.map((m) => m.start)).toContain(100);
  });

  it('names new markers after the preference and keeps marker edits out of undo', async () => {
    const app = await makeApp();
    app.prefs.set('markerName', 'Cue');
    app.prefs.set('markerUndo', false);
    try {
      const doc = new AudioFile({ name: 'p.wav', sampleRate: RATE, channels: [ramp(RATE)] });
      app.addDocument(doc);
      const { nextMarkerName } = await import('../src/model/markers.js');
      expect(nextMarkerName([])).toBe('Cue 01');
      doc.apply('Add Marker', { ...doc.state, markers: [createMarker({ start: 1, name: nextMarkerName(doc.state.markers) })] });
      expect(doc.history.canUndo).toBe(false);
    } finally {
      app.prefs.reset(['markerName', 'markerUndo']);
    }
    expect(markerOptions.name).toBe('Marker');
    expect(markerOptions.undo).toBe(true);
  });

  it('keeps open files in step when synchronizing', async () => {
    const app = await makeApp();
    const a = new AudioFile({ name: 'a.wav', sampleRate: RATE, channels: [ramp(RATE * 4)] });
    const b = new AudioFile({ name: 'b.wav', sampleRate: RATE / 2, channels: [ramp(RATE * 2)] });
    app.addDocument(b);
    app.addDocument(a);
    app.prefs.set('syncFiles', true);
    a.setSelection(RATE, RATE * 2);
    expect([b.selection.start, b.selection.end]).toEqual([RATE / 2, RATE]);
    a.setCursor(RATE * 3);
    expect(b.cursor).toBe(RATE * 1.5);
  });

  it('makes solo exclusive when asked', async () => {
    const app = await makeApp();
    const { Session } = await import('../src/model/session.js');
    const doc = new Session({ name: 's.asesx', sampleRate: RATE, tracks: 3 });
    app.addDocument(doc);
    const [t0, t1] = doc.state.tracks;
    doc.controls.toggle(t0.id, 'solo');
    doc.controls.toggle(t1.id, 'solo');
    expect(doc.state.tracks.filter((t) => t.solo).length).toBe(2);
    app.prefs.set('soloExclusive', true);
    doc.controls.toggle(t0.id, 'solo', false);
    doc.controls.toggle(t0.id, 'solo', true);
    expect(doc.state.tracks.filter((t) => t.solo).map((t) => t.id)).toEqual([t0.id]);
  });

  it('extends a session loop to the end of the bar when not looping at the last clip', async () => {
    const app = await makeApp();
    const { Session } = await import('../src/model/session.js');
    const doc = new Session({ name: 's.asesx', sampleRate: RATE, tracks: 1 });
    const src = doc.addSource({ name: 'x', channels: [ramp(RATE * 3)] });
    doc.apply('Insert', S.addClips(doc.state, [S.createClip({ trackId: doc.state.tracks[0].id, sourceId: src, start: 0, length: RATE * 3 })]));
    app.addDocument(doc);
    expect(app.loopRange(doc).end).toBe(RATE * 3);
    app.prefs.set('loopToLastClip', false);
    expect(app.loopRange(doc).end).toBe(RATE * 4); // a 4/4 bar at 120 BPM lasts 2 s
  });
});

describe('settings import', () => {
  it('replaces preferences and reloads shortcuts', async () => {
    const app = await makeApp();
    const { importSettingsValues } = await import('../src/features/preferences.js');
    importSettingsValues(app, { tempo: 98, shortcuts: { 'edit.cut': ['Alt+Shift+Q'] } });
    expect(app.prefs.get('tempo')).toBe(98);
    expect(app.commands.commandFor('Alt+Shift+Q')).toBe('edit.cut');
  });

  it('registers the import and export commands in the File menu', async () => {
    const app = await makeApp();
    const { MENUS } = await import('../src/ui/menus.js');
    const file = MENUS.find((m) => m.label === 'File').submenu;
    expect(file.find((x) => x.label === 'Import').submenu).toContain('file.importSettings');
    expect(file.find((x) => x.label === 'Export').submenu).toContain('file.exportSettings');
    expect(app.commands.get('file.importSettings').label).toBe('Application Settings...');
  });
});

// Docked panels: Phase Analysis and Phase Meter, Frequency Analysis holds and
// display, Amplitude Statistics tabs, Metadata tabs, Properties sections,
// Level Meters orientation and the Files panel columns.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { App } from '../src/app.js';
import { installCore } from '../src/features/core.js';
import { installAnalysis } from '../src/analysis/install.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { correlationLabelStep, meterIsVertical, correlationText } from '../src/analysis/phase.js';
import { MENUS } from '../src/ui/menus.js';
import { HOLD_COLORS, spectrumBars } from '../src/analysis/frequency.js';
import { statsRows, histogramSeries } from '../src/analysis/amplitude.js';
import { accumulateRmsHistogram, HIST_BINS, HIST_FLOOR } from '../src/analysis/rms-histogram.js';
import { bextChunk, parseBext, cartChunk, parseCart, cleanMeta, id3v2Tag, parseId3v2, vorbisComment, parseVorbisComment } from '../src/audio/meta.js';
import { WavWriter } from '../src/export/pcm.js';
import { makeCollapsible } from '../src/panels/properties.js';
import { meterHorizontal } from '../src/panels/levels.js';
import { visibleFiles } from '../src/panels/files.js';
import { favoriteSettings } from '../src/effects/favorites.js';
import '../src/effects/defs/amplitude.js';
import { makeItem, sourceIdentity } from '../src/batch/queue.js';
import { loadItem } from '../src/batch/process.js';
import { parseWav } from '../src/audio/wav.js';
import { META_TABS, normalizeMetaValue, metadataPanel } from '../src/panels/metadata.js';
import { WORKSPACES } from '../src/ui/workspaces.js';

const RATE = 1000;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  HTMLCanvasElement.prototype.getContext = () => null;
});

function makeApp() {
  localStorage.clear();
  const app = new App();
  installCore(app);
  installAnalysis(app);
  return app;
}

function audioDoc(seconds = 2, channels = 2) {
  return new AudioFile({ name: 'a.wav', sampleRate: RATE, channels: Array.from({ length: channels }, () => Channel.fromSamples(new Float32Array(RATE * seconds))) });
}

const create = (app, id) => app.panels.get(id).create(app);

describe('Phase Analysis and Phase Meter', () => {
  it('registers both panels and lists them in the Window menu', () => {
    const app = makeApp();
    expect(app.panels.get('phaseAnalysis').title).toBe('Phase Analysis');
    expect(app.panels.get('phase').title).toBe('Phase Meter');
    const win = MENUS.find((m) => m.label === 'Window').submenu;
    expect(win.indexOf('window.phaseAnalysis')).toBeGreaterThan(-1);
    expect(win.indexOf('window.phaseAnalysis')).toBeLessThan(win.indexOf('window.phase'));
    expect(app.commands.label('window.phaseAnalysis')).toBe('Phase Analysis');
  });

  it('keeps the scope in the analysis workspaces next to the meter', () => {
    const ids = (n, out = []) => (n.t === 'group' ? out.push(...n.tabs) : n.c.forEach((c) => ids(c, out)), out);
    for (const name of ['Mastering and Analysis', 'Loudness']) {
      const tabs = ids(WORKSPACES[name]());
      expect(tabs, name).toContain('phaseAnalysis');
      expect(tabs, name).toContain('phase');
    }
  });

  it('builds the meter and scope panels', () => {
    const app = makeApp();
    const meter = create(app, 'phase');
    expect(meter.el.querySelector('[role=meter]').getAttribute('aria-valuemin')).toBe('-1');
    const scope = create(app, 'phaseAnalysis');
    expect(scope.el.querySelector('.phase-scope')).toBeTruthy();
    expect(scope.el.querySelector('[role=meter]')).toBeNull();
  });

  it('spaces correlation labels by the room available', () => {
    expect(correlationLabelStep(2000)).toBe(0.05);
    expect(correlationLabelStep(700)).toBe(0.1);
    expect(correlationLabelStep(300)).toBe(0.25);
    expect(correlationLabelStep(150)).toBe(0.5);
    expect(correlationLabelStep(40)).toBe(1);
    expect(meterIsVertical(60, 300)).toBe(true);
    expect(meterIsVertical(600, 80)).toBe(false);
    expect(correlationText(-0.8)).toMatch(/out of phase/);
    expect(correlationText(0.9)).toMatch(/mono/);
  });
});


describe('Frequency Analysis', () => {
  it('has eight colored hold slots and an Advanced section', () => {
    const app = makeApp();
    const p = create(app, 'frequency');
    const slots = p.el.querySelectorAll('.freq-hold');
    expect(slots.length).toBe(HOLD_COLORS.length);
    expect(slots.length).toBe(8);
    expect(new Set(HOLD_COLORS).size).toBe(8);
    // Nothing to hold yet: the slots stay empty.
    slots[0].click();
    expect(slots[0].getAttribute('aria-pressed')).toBe('false');
    const adv = p.el.querySelector('.freq-adv-toggle');
    expect(p.el.querySelector('.freq-advanced').hidden).toBe(true);
    adv.click();
    expect(app.prefs.get('frequencyAnalysis').advanced).toBe(true);
    expect(p.el.querySelector('.freq-advanced').hidden).toBe(false);
    expect(adv.getAttribute('aria-expanded')).toBe('true');
  });

  it('switches display and enables Scan for audio files', () => {
    // The spectrum itself needs the analysis workers, which tests do not run.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = makeApp();
    const p = create(app, 'frequency');
    const scan = [...p.el.querySelectorAll('button')].find((b) => b.textContent === 'Scan');
    expect(scan.disabled).toBe(true);
    app.addDocument(audioDoc());
    expect(scan.disabled).toBe(false);
    const display = p.el.querySelector('select[aria-label=Display]');
    display.value = 'bars';
    display.dispatchEvent(new Event('change'));
    expect(app.prefs.get('frequencyAnalysis').display).toBe('bars');
  });

  it('reduces a spectrum to bars of the loudest bin', () => {
    const db = Float32Array.from({ length: 513 }, (_, k) => (k === 100 ? -10 : -80));
    const bars = spectrumBars(db, 1024, 1024, (f) => f * 512, 8);
    expect(bars.length).toBe(8);
    expect(bars[1]).toBe(-10); // bin 100 (100 Hz) falls in the second slice of 0..512 Hz
    expect(bars[0]).toBe(-80);
    expect(bars[7]).toBe(-80);
  });
});

describe('Amplitude Statistics', () => {
  it('bins windowed RMS levels in 1 dB steps', () => {
    const hist = new Uint32Array(HIST_BINS);
    const x = new Float32Array(300);
    x.fill(1, 0, 100); // 0 dB
    x.fill(0.1, 100, 200); // -20 dB
    accumulateRmsHistogram(hist, x, 100); // last window silent
    expect(hist[-HIST_FLOOR]).toBe(1);
    expect(hist[-HIST_FLOOR - 20]).toBe(1);
    expect(hist[0]).toBe(1);
    const { lo, hi, series } = histogramSeries({ channels: [{ hist }] }, 1);
    expect(lo).toBe(0);
    expect(hi).toBe(HIST_BINS - 1);
    expect(series[0][-HIST_FLOOR]).toBeCloseTo(100 / 3);
  });

  it('shifts RMS rows by 3.01 dB for a sine-wave reference', () => {
    const ch = { min: -0.5, max: 0.5, sum: 0, sq: 0.25 * 100, clipped: 0, bits: 16, rmsMin: 0.5, rmsMax: 0.5, rmsSum: 0.5, rmsCount: 1, frames: 100 };
    const result = { channels: [ch], loudness: { truePeak: [0.5], integrated: -20, range: 0, maxMomentary: -20, maxShortTerm: -20 } };
    const row = (rows, label) => rows.find((r) => r[0] === label)[1][0];
    expect(row(statsRows(result, 1), 'Total RMS Amplitude')).toBe('-6.02 dB');
    expect(row(statsRows(result, 1, { ref: 'sine' }), 'Total RMS Amplitude')).toBe('-3.01 dB');
    expect(row(statsRows(result, 1, { ref: 'sine' }), 'Peak Amplitude')).toBe('-6.02 dB');
  });

  it('measures a range shorter than the RMS window as one window', () => {
    // 100 samples at 0.5: no whole 50 ms window, so the windowed stats are empty.
    const ch = { min: 0.5, max: 0.5, sum: 50, sq: 0.25 * 100, clipped: 0, bits: 32, rmsMin: Infinity, rmsMax: 0, rmsSum: 0, rmsCount: 0, frames: 100 };
    const result = { channels: [ch], loudness: { truePeak: [0.5], integrated: -Infinity, range: 0, maxMomentary: -Infinity, maxShortTerm: -Infinity } };
    const row = (label) => statsRows(result, 1).find((r) => r[0] === label)[1][0];
    for (const label of ['Minimum RMS Amplitude', 'Maximum RMS Amplitude', 'Average RMS Amplitude', 'Total RMS Amplitude']) expect(row(label), label).toBe('-6.02 dB');
    expect(row('Dynamic Range')).toBe('0.00 dB');
    // The RMS histogram shows that one window too.
    const { series } = histogramSeries(result, 1);
    expect(series[0][-HIST_FLOOR - 6]).toBe(100);
    // Silence keeps its minus-infinity levels.
    const silent = { ...ch, min: 0, max: 0, sum: 0, sq: 0 };
    const rows = statsRows({ ...result, channels: [silent] }, 1);
    expect(rows.find((r) => r[0] === 'Average RMS Amplitude')[1][0]).toBe('-∞ dB');
    expect(rows.find((r) => r[0] === 'Dynamic Range')[1][0]).toBe('∞ dB');
  });

  it('has General, RMS Histogram and RMS Settings tabs', () => {
    const app = makeApp();
    app.addDocument(audioDoc());
    const p = create(app, 'amplitude');
    const tabs = [...p.el.querySelectorAll('[role=tab]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['General', 'RMS Histogram', 'RMS Settings']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    tabs[2].click();
    expect(app.prefs.get('amplitudeTab')).toBe('settings');
    const pane = p.el.querySelector(`#${tabs[2].getAttribute('aria-controls')}`);
    expect(pane.hidden).toBe(false);
    const width = pane.querySelector('input[type=number]');
    width.value = '5000';
    width.dispatchEvent(new Event('change'));
    expect(app.prefs.get('amplitudeStats').windowMs).toBe(1000);
    const sine = pane.querySelector('input[value=sine]');
    sine.checked = true;
    sine.dispatchEvent(new Event('change'));
    expect(app.prefs.get('amplitudeStats').ref).toBe('sine');
    // Arrow keys move between tabs.
    tabs[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect([...p.el.querySelectorAll('button')].some((b) => b.textContent === 'Copy All')).toBe(true);
  });
});

describe('Metadata', () => {
  const bwf = { bextDescription: 'Interview, take 2', bextOriginator: 'Field Rec', bextOriginatorRef: 'REF-0042', bextDate: '2026-10-13', bextTime: '09:30:00', bextTimeRef: '5000000000', bextCodingHistory: 'A=PCM,F=48000,W=24,M=stereo\nA=PCM,F=48000,W=16' };
  const cart = { title: 'Spot', artist: 'Agency', cartCutId: '1234', cartClientId: 'ACME', cartCategory: 'COM', cartStartDate: '2026-11-01', cartStartTime: '06:00:00', cartUrl: 'https://example.com', cartTagText: 'Line one\nLine two' };

  it('round-trips bext and cart chunks', () => {
    const b = bextChunk(bwf);
    expect(String.fromCharCode(...b.subarray(0, 4))).toBe('bext');
    expect(parseBext(b.subarray(8))).toEqual(bwf);
    expect(bextChunk({ title: 'x' })).toBe(null);
    const c = cartChunk(cart);
    expect(String.fromCharCode(...c.subarray(0, 4))).toBe('cart');
    expect(String.fromCharCode(...c.subarray(8, 12))).toBe('0101');
    expect(parseCart(c.subarray(8))).toEqual(cart);
    expect(cartChunk({ title: 'x' })).toBe(null);
    // Fixed fields are cut on a character boundary.
    expect(parseBext(bextChunk({ bextOriginator: 'é'.repeat(40) }).subarray(8)).bextOriginator).toBe('é'.repeat(16));
  });

  it('writes and reads them in WAV exports, with the extra INFO and ID3 tags', async () => {
    const meta = { ...bwf, ...cart, copyright: '(c) 2026', engineer: 'NJ', track: '3' };
    const w = new WavWriter({ sampleRate: 8000, channels: 1, bitDepth: 16, dither: 'none', frames: 100, meta });
    w.write([new Float32Array(100)], 100);
    const buf = await w.finish().arrayBuffer();
    const parsed = parseWav(buf);
    expect(parsed.meta).toEqual(cleanMeta(meta));
    expect(parsed.channels[0].length).toBe(100);
    const tags = { title: 'T', track: '4/12', albumArtist: 'Various', composer: 'C', copyright: 'X', bpm: '120', key: 'Am' };
    expect(parseId3v2(id3v2Tag(tags))).toEqual(tags);
    expect(parseVorbisComment(vorbisComment(tags))).toEqual(tags);
  });

  it('checks dates, times and numbers', () => {
    expect(normalizeMetaValue('bextDate', '2026/1/5')).toEqual({ value: '2026-01-05' });
    expect(normalizeMetaValue('bextDate', '2026-13-01').error).toBeTruthy();
    expect(normalizeMetaValue('bextTime', '9:5')).toEqual({ value: '09:05:00' });
    expect(normalizeMetaValue('bextTime', '25:00:00').error).toBeTruthy();
    expect(normalizeMetaValue('bextTimeRef', '00480000')).toEqual({ value: '480000' });
    expect(normalizeMetaValue('bpm', 'fast').error).toBeTruthy();
    expect(normalizeMetaValue('bextOriginator', 'x'.repeat(33)).error).toBeTruthy();
    expect(normalizeMetaValue('title', '  Song  ')).toEqual({ value: 'Song' });
  });

  it('edits fields on BWF, ID3, RIFF and Cart tabs, sharing common ones', () => {
    const app = makeApp();
    const doc = audioDoc();
    app.addDocument(doc);
    const p = metadataPanel(app);
    expect([...p.el.querySelectorAll('[role=tab]')].map((t) => t.textContent)).toEqual(META_TABS.map((t) => t.label));
    const inputFor = (tab, label) => {
      const pane = p.el.querySelector(`#${p.el.querySelector(`[data-tab=${tab}]`).getAttribute('aria-controls')}`);
      const l = [...pane.querySelectorAll('label')].find((x) => x.textContent === `${label}:`);
      return pane.querySelector(`#${l.htmlFor}`);
    };
    const date = inputFor('bwf', 'Origination Date');
    date.value = '2026-2-3';
    date.dispatchEvent(new Event('change'));
    expect(doc.state.meta.bextDate).toBe('2026-02-03');
    date.value = 'soon';
    date.dispatchEvent(new Event('change'));
    expect(date.getAttribute('aria-invalid')).toBe('true');
    expect(doc.state.meta.bextDate).toBe('2026-02-03');
    const name = inputFor('riff', 'Name');
    name.value = 'Shared';
    name.dispatchEvent(new Event('change'));
    expect(doc.state.meta.title).toBe('Shared');
    expect(inputFor('id3', 'Title').value).toBe('Shared');
    expect(inputFor('cart', 'Title').value).toBe('Shared');
    expect(p.el.querySelector('[data-tab=riff]').classList.contains('has-data')).toBe(true);
    doc.history.undo();
    expect(inputFor('id3', 'Title').value).toBe('');
  });
});

describe('Properties', () => {
  it('names the file on top and collapses sections, remembering them', () => {
    const app = makeApp();
    app.addDocument(audioDoc());
    const p = create(app, 'properties');
    expect(p.el.querySelector('.prop-title').textContent).toBe('a.wav');
    const toggle = p.el.querySelector('.prop-toggle');
    expect(toggle.textContent).toBe('File');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(p.el.querySelector('.prop-body').hidden).toBe(true);
    expect(app.prefs.get('propertiesCollapsed')).toEqual(['File']);
    // A new panel (or a re-render) starts with the section closed.
    const again = create(app, 'properties');
    expect(again.el.querySelector('.prop-toggle').getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps keyboard focus on the same control when an edit or a rename rebuilds it', async () => {
    const app = makeApp();
    app.syncGraph = () => {};
    const doc = app.addDocument(audioDoc());
    const { Dock } = await import('../src/ui/dock.js');
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    // Only this panel: the editor's view would keep drawing after the test.
    app.dock = new Dock(app, root, new Map([['properties', app.panels.get('properties')]]));
    app.dock.setLayout({ t: 'group', tabs: ['properties'], a: 'properties' });
    const panel = () => root.querySelector('.properties-panel');
    panel().querySelector('.prop-toggle').focus();
    doc.apply('Gain', doc.state);
    expect(document.activeElement.className).toBe('prop-toggle');
    expect(panel().contains(document.activeElement)).toBe(true);
    // Renaming (Enter in the name field) also re-renders the dock to retitle the editor.
    const name = panel().querySelector('input[aria-label="File name"]');
    name.focus();
    name.value = 'b.wav';
    name.dispatchEvent(new Event('change'));
    expect(doc.name).toBe('b.wav');
    expect(document.activeElement.getAttribute('aria-label')).toBe('File name');
    expect(document.activeElement).not.toBe(name);
    root.remove();
  });

  it('gives the same uncompressed size as the status bar', async () => {
    const app = makeApp();
    const doc = audioDoc(3);
    doc.info.bitDepth = 16;
    app.addDocument(doc);
    const p = create(app, 'properties');
    const rows = [...p.el.querySelectorAll('.prop-row')];
    const size = rows.find((r) => r.textContent.startsWith('Uncompressed Size'));
    const { statusParts } = await import('../src/ui/status-fields.js');
    const status = statusParts(app, doc, {});
    // 3 s of 16-bit stereo at 1 kHz: 12,000 bytes.
    expect(size.querySelector('.prop-value').textContent).toBe('11.7 KB');
    expect(status).toContain('11.7 KB');
  });

  it('makes any section built by a feature collapsible', () => {
    const root = document.createElement('div');
    root.innerHTML = '<section class="prop-section"><h3 class="prop-heading">Track</h3><div class="prop-row">x</div></section>';
    const collapsed = new Set(['Track']);
    makeCollapsible(root, collapsed);
    expect(root.querySelector('.prop-body').hidden).toBe(true);
    root.querySelector('.prop-toggle').click();
    expect(collapsed.has('Track')).toBe(false);
    expect(root.querySelector('.prop-body').textContent).toBe('x');
  });
});

describe('Level Meters', () => {
  it('follows the panel shape or a fixed orientation from the panel menu', () => {
    expect(meterHorizontal(400, 80)).toBe(true);
    expect(meterHorizontal(80, 400)).toBe(false);
    expect(meterHorizontal(80, 400, 'horizontal')).toBe(true);
    expect(meterHorizontal(400, 80, 'vertical')).toBe(false);
    const app = makeApp();
    const labels = app.levelsMenu().filter((i) => i.type === 'cmd').map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['Automatic Orientation', 'Horizontal', 'Vertical', '60 dB Range']));
    app.commands.run('meter.orientVertical');
    expect(app.prefs.get('meterOrientation')).toBe('vertical');
    expect(app.commands.isChecked('meter.orientVertical')).toBe(true);
    expect(app.commands.isChecked('meter.orientAuto')).toBe(false);
  });
});

describe('Files panel', () => {
  it('sorts by any column and hides columns from the panel menu', () => {
    const app = makeApp();
    const a = audioDoc(3, 2);
    a.name = 'b.wav';
    const b = audioDoc(1, 1);
    b.name = 'a.wav';
    app.addDocument(a);
    app.addDocument(b);
    expect(visibleFiles([a, b]).map((d) => d.name)).toEqual(['a.wav', 'b.wav']);
    expect(visibleFiles([a, b], { sort: { col: 'duration', dir: -1 } }).map((d) => d.name)).toEqual(['b.wav', 'a.wav']);
    expect(visibleFiles([a, b], { sort: { col: null } }).map((d) => d.name)).toEqual(['b.wav', 'a.wav']);
    expect(visibleFiles([a, b], { query: 'B.W' }).map((d) => d.name)).toEqual(['b.wav']);
    const p = create(app, 'files');
    const names = () => [...p.el.querySelectorAll('tbody tr[data-id] td.name-cell span:last-child')].map((x) => x.textContent);
    expect(names()).toEqual(['b.wav', 'a.wav']);
    const header = (label) => [...p.el.querySelectorAll('th')].find((th) => th.textContent === label);
    header('Channels').querySelector('button').click();
    expect(names()).toEqual(['a.wav', 'b.wav']);
    expect(header('Channels').getAttribute('aria-sort')).toBe('ascending');
    expect(header('Bit Depth')).toBeTruthy();
    const menu = app.panels.get('files').menu(app);
    // menu() reads the panel created through the dock; use the instance's own menu here.
    expect(Array.isArray(menu)).toBe(true);
    const cols = p.menu().find((i) => i.label === 'Columns');
    cols.items.find((i) => i.label === 'Format').run();
    expect(header('Format')).toBeUndefined();
    expect(app.prefs.get('filesHiddenColumns')).toEqual(['format']);
    p.menu().find((i) => i.label === 'Show Preview Transport').run();
    expect(p.el.querySelector('.files-footer').hidden).toBe(true);
  });
});

describe('History panel menu', () => {
  it('deletes the states after the current one', () => {
    const app = makeApp();
    const doc = audioDoc();
    app.addDocument(doc);
    const p = create(app, 'history');
    doc.apply('One', { ...doc.state, meta: { title: '1' } });
    doc.apply('Two', { ...doc.state, meta: { title: '2' } });
    doc.history.undo();
    const del = p.menu().find((i) => i.label === 'Delete Later States');
    expect(del.enabled).toBe(true);
    del.run();
    expect(doc.history.entries.map((e) => e.label)).toEqual(['Open', 'One']);
    expect(doc.history.canRedo).toBe(false);
    expect(p.menu().find((i) => i.label === 'Delete Later States').enabled).toBe(false);
    expect(p.menu().some((i) => /Undo/.test(i.label || ''))).toBe(true);
  });
});

describe('Favorites details', () => {
  it('lists the settings a favorite applies', () => {
    const app = makeApp();
    const cmd = { name: 'Normalize', action: { type: 'command', command: 'fx.normalizePeak', args: { peak: -3 } } };
    expect(favoriteSettings(app, cmd)).toEqual([['Peak', '-3 dB']]);
    expect(favoriteSettings(app, { name: 'x', action: { type: 'command', command: 'fx.fadeIn' } })).toEqual([]);
    const eff = { name: 'Limit', action: { type: 'effect', effect: 'hardLimiter', values: { ceiling: -0.1, inputBoost: 0 } } };
    const rows = favoriteSettings(app, eff);
    expect(rows[0]).toEqual(['Maximum Amplitude', '-0.1 dB']);
    expect(rows.find((r) => r[0] === 'Link Channels')[1]).toBe('On');
  });
});

describe('Markers to Batch Process', () => {
  it('sends range markers as batch items that load only their range', async () => {
    const app = makeApp();
    const doc = audioDoc(4, 1);
    doc.name = 'take.wav';
    doc.apply('Markers', { ...doc.state, markers: [{ id: 'm1', start: 0, duration: 0, name: 'Cue', type: 'cue' }, { id: 'm2', start: 1000, duration: 500, name: 'Verse', type: 'cue' }] });
    app.addDocument(doc);
    const added = [];
    app.registerPanel({ id: 'batch', title: 'Batch Process', create: () => ({ el: document.createElement('div') }) });
    app.dock = { openPanel: () => {}, instances: new Map([['batch', { api: { add: (s) => added.push(...s) } }]]) };
    const p = create(app, 'markers');
    const btn = p.el.querySelector('[aria-label="Send Ranges to Batch Process"]');
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ type: 'range', start: 1000, end: 1500, name: 'take Verse' });
    const item = makeItem(added[0]);
    expect(item.name).toBe('take Verse');
    expect(sourceIdentity(added[0])).toBe(`range:${doc.id}:1000:1500`);
    const { state } = await loadItem(item);
    expect(state.channels[0].length).toBe(500);
    expect(doc.state.channels[0].length).toBe(4000);
  });
});

describe('Files panel focus', () => {
  it('keeps keyboard focus on the same file when the list re-renders', () => {
    const app = makeApp();
    app.syncGraph = () => {};
    const a = audioDoc(1);
    const b = audioDoc(2);
    b.name = 'b.wav';
    app.addDocument(a);
    app.addDocument(b);
    const panel = create(app, 'files');
    document.body.replaceChildren(panel.el);
    const row = (d) => panel.el.querySelector(`tr[data-id="${d.id}"]`);
    row(a).focus();
    expect(document.activeElement).toBe(row(a));
    // Playback starting or stopping re-renders every row.
    app.emit('transport', 'playing');
    expect(document.activeElement).toBe(row(a));
    expect(document.activeElement.isConnected).toBe(true);
  });
});

describe('Markers panel focus', () => {
  it('moves focus to the next row when the focused marker is deleted', async () => {
    const app = makeApp();
    app.syncGraph = () => {};
    const d = audioDoc(2);
    app.addDocument(d);
    for (const [id, start] of [['m1', 100], ['m2', 600], ['m3', 1200]]) d.apply('Add Marker', { ...d.state, markers: [...d.state.markers, { id, name: id, start, duration: 0, type: 'cue', description: '' }] });
    const panel = create(app, 'markers');
    document.body.replaceChildren(panel.el);
    panel.show();
    const row = (id) => panel.el.querySelector(`tr[data-id="${id}"]`);
    row('m2').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.activeElement).toBe(row('m2'));
    row('m2').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(d.state.markers.map((m) => m.id)).toEqual(['m1', 'm3']);
    // Focus stays in the list (on the marker now in that place), not on the page.
    expect(document.activeElement).toBe(row('m3'));
  });
});

describe('Playlist panel focus', () => {
  it('keeps focus in the list when entries are removed or playback changes', async () => {
    const { playlistPanel, setPlaylist } = await import('../src/panels/playlist.js');
    const app = makeApp();
    app.syncGraph = () => {};
    const d = audioDoc(2);
    app.addDocument(d);
    const markers = ['m1', 'm2', 'm3'].map((id, i) => ({ id, name: id, start: i * 500, duration: 200, type: 'cue', description: '' }));
    d.apply('Add Markers', { ...d.state, markers });
    setPlaylist(d, markers.map((m) => ({ id: `e-${m.id}`, markerId: m.id, loops: 1 })));
    const panel = playlistPanel(app);
    document.body.replaceChildren(panel.el);
    panel.render();
    const row = (id) => panel.el.querySelector(`tr[data-id="${id}"]`);
    row('e-m1').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.activeElement).toBe(row('e-m1'));
    // A re-render (e.g. the player moving on) keeps focus on the same entry.
    panel.render();
    expect(document.activeElement).toBe(row('e-m1'));
    // Delete removes it and focus moves to the entry now selected in its place.
    row('e-m1').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    expect(panel.el.querySelectorAll('tr[data-id]')).toHaveLength(2);
    expect(document.activeElement).toBe(row('e-m2'));
  });
});

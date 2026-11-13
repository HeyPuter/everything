// Click/Pop Eliminator: the effect (repairs every click with stored
// settings) and its scan / choose / repair dialog built on Diagnostics.
import { describe, it, expect, beforeAll } from 'vitest';
import './fx-wasm.js';
import { getEffect, defaults } from '../src/effects/index.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { setDiagnosticsWorker } from '../src/diagnostics/scan.js';
import { openClickPopDialog, classify } from '../src/diagnostics/click-pop.js';
import { thresholdPoints, thresholdAt, clickVerdict, autoThresholds, levelStats, strengthOf, thresholdMultiple } from '../src/effects/defs/click-thresholds.js';
import { installEffectCommands } from '../src/effects/commands.js';
import { installEffectsDsp } from '../src/features/effects-dsp.js';
import { EFFECT_GROUPS } from '../src/ui/menus.js';
import { fakeApp } from './fx-helpers.js';

const RATE = 48000;
const def = getEffect('clickPopEliminator');

function music(n) {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  return Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 330 * i) / RATE) + 0.15 * Math.sin((2 * Math.PI * 1210 * i) / RATE) + 0.02 * rnd());
}

/** Adds clicks at `at`, scaled by `amp` (weak and strong clicks). */
function withClicks(x, at, amp = 1) {
  const y = x.slice();
  for (const i of at) {
    y[i] += 0.6 * amp;
    y[i + 1] -= 0.4 * amp;
    y[i + 2] += 0.3 * amp;
  }
  return y;
}

const err = (a, b, lo = 0, hi = a.length) => {
  let s = 0;
  for (let i = lo; i < hi; i++) s += (a[i] - b[i]) ** 2;
  return s;
};

beforeAll(() => setDiagnosticsWorker(null));

function setup(samples) {
  const app = fakeApp();
  installEffectCommands(app);
  installEffectsDsp(app);
  const doc = new AudioFile({ name: 'a.wav', sampleRate: RATE, channels: [Channel.fromSamples(samples)] });
  app.active = doc;
  return { app, doc };
}

describe('Click/Pop Eliminator effect', () => {
  it('sits in Restoration with level-dependent thresholds', () => {
    expect(def.group).toBe('Noise Reduction / Restoration');
    expect(EFFECT_GROUPS.find((g) => g.label === def.group).ids).toContain('clickPopEliminator');
    for (const id of ['levelMax', 'levelAvg', 'levelMin', 'detectMax', 'detectAvg', 'detectMin', 'rejectMax', 'rejectAvg', 'rejectMin', 'verify', 'runSize', 'oversample', 'passes', 'bigPops', 'crackle']) {
      expect(def.params.find((p) => p.id === id), id).toBeTruthy();
    }
    expect(thresholdMultiple(strengthOf(9))).toBeCloseTo(9);
  });

  it('draws each threshold as straight lines between its three levels, flat beyond', () => {
    const v = defaults(def);
    const pts = thresholdPoints(v, 'detect');
    expect(pts.map((p) => p.db)).toEqual([-50, -24, -12]);
    expect(thresholdAt(pts, -80)).toBe(v.detectMin);
    expect(thresholdAt(pts, 0)).toBe(v.detectMax);
    expect(thresholdAt(pts, -37)).toBeCloseTo((v.detectMin + v.detectAvg) / 2);
  });

  it('detects at the Detect curve and repairs above the Reject curve when verifying', () => {
    const v = { ...defaults(def), detectMin: 20, detectAvg: 20, detectMax: 20, rejectMin: 40, rejectAvg: 40, rejectMax: 40 };
    expect(clickVerdict({ strength: 10, db: -20, core: 3 }, v)).toBe(0);
    expect(clickVerdict({ strength: 30, db: -20, core: 3 }, v)).toBe(1);
    expect(clickVerdict({ strength: 50, db: -20, core: 3 }, v)).toBe(2);
    expect(clickVerdict({ strength: 30, db: -20, core: 3 }, { ...v, verify: false })).toBe(2);
    // Ignore Light Crackle leaves short clicks that barely pass alone.
    expect(clickVerdict({ strength: 30, db: -20, core: 2 }, { ...v, verify: false, crackle: true })).toBe(0);
    expect(clickVerdict({ strength: 30, db: -20, core: 12 }, { ...v, verify: false, crackle: true })).toBe(2);
  });

  it('sets the curves from Sensitivity and Discrimination, and levels from the audio', () => {
    const t = autoThresholds({ sensitivity: 60, discrimination: 30 });
    const d = defaults(def);
    for (const k of Object.keys(t)) expect(t[k]).toBe(d[k]);
    const finer = autoThresholds({ sensitivity: 90, discrimination: 30 });
    expect(finer.detectAvg).toBeLessThan(t.detectAvg);
    expect(autoThresholds({ sensitivity: 60, discrimination: 100 }).rejectAvg).toBeGreaterThan(t.rejectAvg);
    const dbs = Array.from({ length: 100 }, (_, i) => -60 + i * 0.5);
    const s = levelStats([...dbs, -Infinity, -120]);
    expect(s.levelMax).toBeCloseTo(-10.5);
    expect(s.levelAvg).toBeCloseTo(-35.3, 0);
    expect(s.levelMin).toBeCloseTo(-55);
    expect(levelStats([-Infinity])).toBeNull();
  });

  it('repairs every click the thresholds pass when run with stored settings (favorites, batches)', async () => {
    const clean = music(RATE);
    const clicky = withClicks(clean, [5000, 15000, 30000]);
    const [out] = await def.process({ channels: [clicky], rate: RATE, values: defaults(def) });
    expect(err(out, clean)).toBeLessThan(err(clicky, clean) * 0.05);
    // Thresholds above every click leave the audio alone.
    const high = { ...defaults(def), detectMin: 150, detectAvg: 150, detectMax: 150 };
    const [kept] = await def.process({ channels: [withClicks(clean, [5000], 0.05)], rate: RATE, values: high });
    expect(err(kept, withClicks(clean, [5000], 0.05))).toBe(0);
  });

  it('classifies scanned clicks into the list and the ones to repair', () => {
    const v = { ...defaults(def), detectMin: 20, detectAvg: 20, detectMax: 20, rejectMin: 40, rejectAvg: 40, rejectMax: 40 };
    const found = [{ id: 'a', level: 10, db: -20, core: 3 }, { id: 'b', level: 30, db: -20, core: 3 }, { id: 'c', level: 80, db: -20, core: 3 }];
    const { list, chosen } = classify(found, v);
    expect(list.map((p) => p.id)).toEqual(['b', 'c']);
    expect([...chosen]).toEqual(['c']);
  });
});

describe('Click/Pop Eliminator dialog', () => {
  it('scans, lists with times and levels, follows the curves and repairs the ticked clicks', async () => {
    const clean = music(RATE);
    const strong = [8000, 30000];
    const weak = [18000];
    const clicky = withClicks(withClicks(clean, strong), weak, 0.08);
    const { app, doc } = setup(clicky);
    const dlg = openClickPopDialog(app, doc, { autoScan: false });
    const root = [...document.querySelectorAll('.cpe-dialog')].at(-1);
    expect(root.querySelector('.dialog-title').textContent).toBe('Click/Pop Eliminator');
    expect(root.querySelectorAll('.cpe-handle')).toHaveLength(6);
    // Low curves: the weak click is found too.
    dlg.set({ detectMin: 20, detectAvg: 20, detectMax: 20 });
    await dlg.scan();
    const { scan, list } = dlg.state();
    expect(list.length).toBeGreaterThanOrEqual(3);
    const rows = root.querySelectorAll('.cpe-table tbody tr');
    expect(rows).toHaveLength(list.length);
    expect(rows[0].children[2].textContent).toMatch(/0\.16|0:00/);
    expect(rows[0].children[4].textContent).toMatch(/-1\d dB/);
    const weakP = list.find((p) => p.start <= 18000 && p.end > 18000);
    expect(weakP).toBeTruthy();
    const strongP = list.find((p) => p.start <= 8000 && p.end > 8000);
    expect(weakP.level).toBeLessThan(strongP.level);
    // Raise the Reject curve between the two: only the strong clicks stay ticked.
    const mid = Math.round((weakP.level + strongP.level) / 2);
    dlg.set({ rejectMin: mid, rejectAvg: mid, rejectMax: mid });
    expect(dlg.state().chosen.has(weakP.id)).toBe(false);
    expect(dlg.state().chosen.has(strongP.id)).toBe(true);
    // Only the ticks changed: the same rows are restyled (thousands of clicks made every change rebuild them).
    const after = root.querySelectorAll('.cpe-table tbody tr');
    expect([...after].every((tr, i) => tr === rows[i])).toBe(true);
    expect([...after].map((tr) => tr.querySelector('input').checked)).toEqual(list.map((p) => dlg.state().chosen.has(p.id)));
    expect([...after].map((tr) => tr.getAttribute('aria-selected'))).toEqual(list.map((p) => String(dlg.state().chosen.has(p.id))));
    // Arrow keys move a curve point.
    const handle = root.querySelector('.cpe-handle.reject');
    const before = dlg.state().values.rejectMax;
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    expect(dlg.state().values.rejectMax).toBe(before - 10);
    // Without verification every detected click is ticked.
    root.querySelector('.cpe-detect-top input[type="checkbox"]').click();
    expect(dlg.state().values.verify).toBe(false);
    expect(dlg.state().chosen.size).toBe(dlg.state().list.length);
    const repairBtn = root.querySelector('.dialog-foot button[data-value="repair"]');
    expect(repairBtn.textContent).toBe(`Repair ${dlg.state().list.length} Clicks`);
    // Untick the weak click, then repair the rest.
    const weakRow = root.querySelectorAll('.cpe-table tbody tr')[dlg.state().list.indexOf(weakP)];
    weakRow.querySelector('input').click();
    expect(dlg.state().chosen.has(weakP.id)).toBe(false);
    await dlg.repair();
    expect(err(doc.state.channels[0].toArray(), clean, 7000, 9500)).toBeLessThan(err(clicky, clean, 7000, 9500) * 0.05);
    // The unticked one is untouched and still listed.
    expect(err(doc.state.channels[0].toArray(), clicky, 17000, 19500)).toBe(0);
    expect(dlg.state().list.map((p) => p.id)).toEqual([weakP.id]);
    expect(scan.found.length).toBeGreaterThanOrEqual(list.length);
    expect(doc.history.undoLabel).toMatch(/Click\/Pop Eliminator: Repair/);
    root.querySelector('.dialog-head .icon-btn').click();
    await dlg;
  });

  it('keeps keyboard focus in the dialog while its buttons are disabled', async () => {
    const { app, doc } = setup(withClicks(music(RATE / 2), [6000]));
    // Opens with focus on Find Clicks, which the automatic scan disables at once.
    const dlg = openClickPopDialog(app, doc);
    const root = [...document.querySelectorAll('.cpe-dialog')].at(-1);
    expect(document.activeElement.textContent).toBe('Cancel');
    expect(root.contains(document.activeElement)).toBe(true);
    const caption = () => root.querySelector('.cpe-caption').textContent;
    await expect.poll(caption, { timeout: 5000 }).toMatch(/detected/);
    expect(document.activeElement).toBe(root.querySelector('.cpe-toolbar .btn'));
    expect(document.activeElement.textContent).toBe('Scan Again');
    root.querySelector('.dialog-head .icon-btn').click();
    await dlg;
  });

  it('measures threshold levels and sets the curves from them', async () => {
    const { app, doc } = setup(withClicks(music(RATE / 2), [6000]));
    const dlg = openClickPopDialog(app, doc, { autoScan: false });
    const root = [...document.querySelectorAll('.cpe-dialog')].at(-1);
    dlg.set({ sensitivity: 80 });
    await dlg.scanLevels(true);
    const v = dlg.state().values;
    // About -12.5 dB RMS throughout.
    expect(v.levelMax).toBeGreaterThan(-14);
    expect(v.levelMax).toBeLessThan(-10);
    expect(v.levelMin).toBeLessThan(v.levelAvg);
    expect(v.detectAvg).toBe(autoThresholds({ sensitivity: 80, discrimination: 30 }).detectAvg);
    // Scan For All Levels also finds the clicks.
    expect(dlg.state().scan).toBeTruthy();
    expect(root.querySelector('.cpe-caption').textContent).toMatch(/detected/);
    root.querySelector('.dialog-head .icon-btn').click();
    await dlg;
  });

  it('fills a short selection as a single click', async () => {
    const clean = music(RATE / 2);
    const damaged = clean.slice();
    for (let i = 9000; i < 9030; i++) damaged[i] = 0.9;
    const { app, doc } = setup(damaged);
    const dlg = openClickPopDialog(app, doc, { autoScan: false });
    const root = [...document.querySelectorAll('.cpe-dialog')].at(-1);
    const fill = [...root.querySelectorAll('.btn')].find((b) => b.textContent === 'Fill Single Click');
    expect(fill.disabled).toBe(true);
    doc.setSelection(9000, 9030);
    expect(fill.disabled).toBe(false);
    await dlg.fill();
    expect(err(doc.state.channels[0].toArray(), clean, 9000, 9030)).toBeLessThan(err(damaged, clean, 9000, 9030) * 0.01);
    expect(doc.history.undoLabel).toBe('Click/Pop Eliminator: Fill Single Click');
    doc.setSelection(0, 10000);
    expect(fill.disabled).toBe(true);
    root.querySelector('.dialog-head .icon-btn').click();
    await dlg;
  });

  it('asks for a new scan when the file changed', async () => {
    const clicky = withClicks(music(RATE / 2), [6000]);
    const { app, doc } = setup(clicky);
    const dlg = openClickPopDialog(app, doc, { autoScan: false });
    const root = [...document.querySelectorAll('.cpe-dialog')].at(-1);
    await dlg.scan();
    doc.apply('Other edit', { ...doc.state });
    await dlg.repair();
    expect(root.querySelector('.cpe-caption').textContent).toMatch(/Scan again/);
    root.querySelector('.dialog-head .icon-btn').click();
    await dlg;
  });

  it('is what fx.clickPopEliminator opens; with values it applies directly', async () => {
    const clean = music(RATE / 2);
    const clicky = withClicks(clean, [6000, 16000]);
    const { app, doc } = setup(clicky);
    expect(app.commands.label('fx.clickPopEliminator')).toBe('Click/Pop Eliminator (process)...');
    app.runEffect = (id, args) => (id === 'clickPopEliminator' ? import('../src/effects/commands.js').then((m) => m.runEffect(app, id, args)) : null);
    await app.commands.run('fx.clickPopEliminator', { values: defaults(def) });
    expect(err(doc.state.channels[0].toArray(), clean)).toBeLessThan(err(clicky, clean) * 0.05);
    const p = app.commands.run('fx.clickPopEliminator');
    // The dialog's code loads on first use.
    for (let i = 0; i < 50 && !document.querySelector('.cpe-dialog'); i++) await new Promise((r) => setTimeout(r, 20));
    const root = [...document.querySelectorAll('.cpe-dialog')].at(-1);
    expect(root).toBeTruthy();
    root.querySelector('.dialog-head .icon-btn').click();
    await p;
  });
});

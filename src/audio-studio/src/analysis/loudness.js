// Match Loudness panel: measures open files with ITU-R BS.1770-4 (integrated
// loudness, loudness range, true peak, plus sample peak and total RMS) and matches them to a target with a
// true-peak ceiling, applying gain (and a look-ahead limiter when the gain
// would push peaks over the ceiling) as one undo step per file, or, with
// Export on, writing matched copies with the chosen export settings and
// leaving the open files as they are. While audio plays it also shows live
// momentary and short-term loudness.

import { h, announce } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { hotNumber, select } from '../ui/controls.js';
import { Channel } from '../audio/channel.js';
import { dsp } from '../audio/dsp.js';
import { analysisPool } from './pool.js';
import { loudnessMeter } from './dsp-ext.js';
import { fmtDb, gainToDb, masterTap } from './common.js';
import { exportAudio } from '../export/export.js';
import { batchSettings, exportOptionsFor, outputName, describeBatch } from '../batch/queue.js';
import { exportSettingsDialog, outputWriter, locationText } from '../batch/export-settings.js';

const CHUNK = 1 << 18;

export const LOUDNESS_PRESETS = [
  { id: 'ebu', label: 'EBU R128 (-23 LUFS)', target: -23, peak: -1 },
  { id: 'itu', label: 'ITU-R BS.1770-4 (-24 LUFS)', target: -24, peak: -2 },
  { id: 'atsc', label: 'ATSC A/85 (-24 LKFS)', target: -24, peak: -2 },
  { id: 'podcast', label: 'Podcast (-16 LUFS)', target: -16, peak: -1 },
  { id: 'streaming', label: 'Streaming (-14 LUFS)', target: -14, peak: -1 },
  { id: 'custom', label: 'Custom' },
];

export const MATCH_DEFAULTS = { preset: 'ebu', target: -23, tolerance: 0.5, peak: -1, limit: true, lookMs: 12, releaseMs: 200, export: false };

/** Export settings for matched copies (Batch Process fields; see batch/queue.js). */
export const MATCH_EXPORT_DEFAULTS = { suffix: ' (matched)' };
export const matchExportSettings = (saved) => batchSettings({ ...MATCH_EXPORT_DEFAULTS, ...(saved || {}) });

/**
 * Writes a matched copy of `doc`: its audio with the plan applied (unchanged
 * when the plan skips) encoded with `exportSettings`. Resolves the file name written.
 */
export async function exportMatched(doc, plan, s, exportSettings, { write, apply = applyMatch, encode = exportAudio, onProgress } = {}) {
  let state = doc.state;
  if (plan.action !== 'skip') state = (await apply(state, plan, s, (f) => onProgress?.(f * 0.5))).state;
  const options = exportOptionsFor(exportSettings, { sampleRate: state.sampleRate, channels: state.channels.length });
  const blob = await encode({ channels: state.channels, sampleRate: state.sampleRate, markers: state.markers || [], meta: state.meta || {} }, options, { onProgress: (f) => onProgress?.(0.5 + f * 0.5) });
  return write(outputName(doc.name, exportSettings), blob);
}

/**
 * What matching a measurement to the settings requires:
 * { action: 'skip' | 'gain' | 'limit', gainDb, note }.
 */
export function planMatch(measure, s) {
  const { integrated, truePeakDb } = measure;
  if (!Number.isFinite(integrated)) return { action: 'skip', gainDb: 0, note: 'Too quiet or too short to measure' };
  const gainDb = s.target - integrated;
  if (Math.abs(gainDb) <= s.tolerance && truePeakDb <= s.peak) return { action: 'skip', gainDb: 0, note: 'Already within tolerance' };
  if (truePeakDb + gainDb <= s.peak) return { action: 'gain', gainDb, note: '' };
  if (s.limit) return { action: 'limit', gainDb, note: 'Gain with limiting' };
  const capped = s.peak - truePeakDb;
  return { action: 'gain', gainDb: capped, note: `Limited to ${fmtDb(integrated + capped, 1)} LUFS by the true peak ceiling` };
}

/**
 * Status text after matching with `plan`, given the loudness measured
 * afterwards: { text, short } where `short` means the target was missed by
 * more than the tolerance (limiting held the level down).
 */
export function matchOutcome(plan, after, s) {
  const got = after?.integrated;
  if (plan.action === 'limit' && Number.isFinite(got) && Math.abs(got - s.target) > s.tolerance + 0.05) {
    return { text: `Gain with limiting: reached ${fmtDb(got, 1)} LUFS`, short: true };
  }
  return { text: plan.note || `Gain ${plan.gainDb >= 0 ? '+' : ''}${plan.gainDb.toFixed(1)} dB`, short: plan.action === 'gain' && Boolean(plan.note) };
}

/** Streams a document through a worker loudness session. */
export async function measureLoudness(state, onProgress) {
  const chans = state.channels;
  const len = chans[0]?.length || 0;
  const session = await analysisPool().session('loudness', { rate: state.sampleRate, channels: chans.length });
  let peak = 0;
  let sq = 0;
  try {
    for (let at = 0; at < len; at += CHUNK) {
      const n = Math.min(CHUNK, len - at);
      const block = chans.map((c) => c.toArray(at, at + n));
      // Sample peak and power here; the buffers move to the worker next.
      // NaN and infinite samples count as silence, as the loudness meter treats them.
      for (const x of block) {
        for (let i = 0; i < x.length; i++) {
          const v = x[i];
          if (!Number.isFinite(v)) continue;
          sq += v * v;
          if (v > peak) peak = v;
          else if (-v > peak) peak = -v;
        }
      }
      await session.push(block);
      onProgress?.((at + n) / len);
    }
  } catch (err) {
    session.close().catch(() => {});
    throw err;
  }
  const { loudness } = await session.close();
  const rms = len && chans.length ? Math.sqrt(sq / (len * chans.length)) : 0;
  return { ...loudness, truePeakDb: gainToDb(Math.max(0, ...loudness.truePeak)), peakDb: gainToDb(peak), rmsDb: gainToDb(rms) };
}

/** Applies gain (and the limiter) in a worker; returns the new state. */
export async function applyMatch(state, plan, s, onProgress) {
  const chans = state.channels;
  const len = chans[0]?.length || 0;
  const limit = plan.action === 'limit';
  const session = await analysisPool().session('limit', {
    rate: state.sampleRate,
    channels: chans.length,
    gain: Math.pow(10, plan.gainDb / 20),
    limit,
    ceiling: Math.pow(10, s.peak / 20),
    lookMs: s.lookMs,
    releaseMs: s.releaseMs,
  });
  const out = chans.map(() => []);
  let latency = 0;
  try {
    // The limiter delays its output: feed zeros at the end to flush it.
    const probe = limit ? Math.round((state.sampleRate * s.lookMs) / 1000) + 9 : 0;
    const total = len + probe;
    for (let at = 0; at < total; at += CHUNK) {
      const n = Math.min(CHUNK, total - at);
      const block = chans.map((c) => c.toArray(at, at + n));
      const res = await session.push(block);
      res.forEach((x, i) => out[i].push(x));
      onProgress?.((at + n) / total);
    }
  } catch (err) {
    session.close().catch(() => {});
    throw err;
  }
  const done = await session.close();
  latency = done.latency || 0;
  const channels = out.map((blocks) => {
    const all = blocks.reduce((ch, b) => ch.concat(Channel.fromSamples(b)), Channel.empty());
    return all.slice(latency, latency + len);
  });
  return { state: { ...state, channels }, result: done.loudness };
}

export function loudnessPanel(app) {
  const prefs = () => ({ ...MATCH_DEFAULTS, ...(app.prefs.get('matchLoudness') || {}) });
  const set = (patch, custom = true) => {
    const next = { ...prefs(), ...patch };
    if (custom && ('target' in patch || 'peak' in patch)) next.preset = 'custom';
    app.prefs.set('matchLoudness', next);
    syncControls();
    renderRows();
  };
  const entries = []; // { doc, measure, status, busy }
  let selected = null;
  let running = false;

  // Settings ------------------------------------------------------------------
  const p = prefs();
  const presetSel = select({
    label: 'Match to',
    value: p.preset,
    options: LOUDNESS_PRESETS.map((x) => ({ value: x.id, label: x.label })),
    onChange: (v) => {
      const pr = LOUDNESS_PRESETS.find((x) => x.id === v);
      set(pr.target !== undefined ? { preset: v, target: pr.target, peak: pr.peak } : { preset: v }, false);
    },
  });
  const target = hotNumber({ value: p.target, min: -60, max: 0, step: 0.1, label: 'Target loudness', format: (v) => `${v.toFixed(1)} LUFS`, onChange: (v) => set({ target: v }) });
  const tol = hotNumber({ value: p.tolerance, min: 0, max: 5, step: 0.1, label: 'Tolerance', format: (v) => `${v.toFixed(1)} LU`, onChange: (v) => set({ tolerance: v }) });
  const peak = hotNumber({ value: p.peak, min: -20, max: 0, step: 0.1, label: 'Maximum true peak level', format: (v) => `${v.toFixed(1)} dBTP`, onChange: (v) => set({ peak: v }) });
  const limitBox = h('input', { type: 'checkbox', checked: p.limit, onchange: () => set({ limit: limitBox.checked }) });
  const look = hotNumber({ value: p.lookMs, min: 1, max: 50, step: 1, label: 'Look-ahead time', format: (v) => `${v} ms`, onChange: (v) => set({ lookMs: v }) });
  const rel = hotNumber({ value: p.releaseMs, min: 10, max: 2000, step: 10, label: 'Release time', format: (v) => `${v} ms`, onChange: (v) => set({ releaseMs: v }) });
  const syncControls = () => {
    const s = prefs();
    presetSel.value = s.preset;
    target.setValue(s.target);
    tol.setValue(s.tolerance);
    peak.setValue(s.peak);
    limitBox.checked = s.limit;
    look.setValue(s.lookMs);
    rel.setValue(s.releaseMs);
    exportBox.checked = Boolean(s.export);
    exportBtn.disabled = !s.export;
    const x = exportSettings();
    exportNote.textContent = s.export ? `${describeBatch(x)}; ${locationText(x)}` : 'Off: Run changes the open files (one undo step each).';
    runBtn.textContent = s.export ? 'Export' : 'Run';
  };
  const settingsGrid = h(
    'div.match-settings',
    h('label.match-field', h('span', 'Match To'), presetSel),
    h('div.match-field', h('span', 'Target Loudness'), target),
    h('div.match-field', h('span', 'Tolerance'), tol),
    h('div.match-field', h('span', 'Max True Peak'), peak),
    h('label.check.match-field', limitBox, h('span', 'Use Limiting')),
    h('div.match-field', h('span', 'Look-ahead'), look),
    h('div.match-field', h('span', 'Release'), rel),
  );

  // Toolbar and list ------------------------------------------------------------
  const tbtn = (ic, label, run) => h('button.icon-btn', { type: 'button', 'aria-label': label, title: label, onclick: run }, icon(ic, 15));
  const addAll = tbtn('file-plus', 'Add all open files', () => addDocs(app.documents));
  const removeBtn = tbtn('minus', 'Remove the selected file', () => {
    removeSelected();
    if (removeBtn.disabled) addAll.focus();
  });
  const clearBtn = tbtn('trash-2', 'Clear the list', () => {
    entries.length = 0;
    selected = null;
    renderRows();
    // Clear is disabled now: move focus to Add rather than losing it.
    addAll.focus();
  });
  const scanBtn = h('button.btn', { type: 'button', onclick: () => scanAll() }, 'Scan');
  const runBtn = h('button.btn.primary', { type: 'button', onclick: () => runAll() }, 'Run');
  const toolbar = h('div.panel-toolbar.analysis-toolbar', addAll, removeBtn, clearBtn, h('div.spacer'), scanBtn, runBtn);
  const body = h('tbody');
  const table = h(
    'table.data-table.match-table',
    { role: 'grid', 'aria-label': 'Files to match' },
    h('thead', h('tr', ['File', 'Loudness', 'Total RMS', 'Peak', 'True Peak', 'LRA', 'Status'].map((c, i) => h(`th${i && i < 6 ? '.num' : ''}`, { scope: 'col' }, c)))),
    body,
  );
  const liveMeter = h('div.loudness-live', { 'aria-live': 'off' });
  const status = h('div.analysis-caption', { 'aria-live': 'polite' });
  // Export: write matched copies instead of changing the open files.
  const exportSettings = () => matchExportSettings(app.prefs.get('matchLoudnessExport'));
  const exportBox = h('input', { type: 'checkbox', checked: p.export, onchange: () => set({ export: exportBox.checked }, false) });
  const exportBtn = h('button.btn', {
    type: 'button',
    onclick: async () => {
      const patch = await exportSettingsDialog(app, exportSettings(), { title: 'Match Loudness Export Settings', example: 'Interview' });
      if (patch) app.prefs.set('matchLoudnessExport', { ...exportSettings(), ...patch });
      syncControls();
    },
  }, 'Export Settings...');
  const exportNote = h('span.match-export-note.faint');
  const exportBar = h('div.match-export', h('label.check', exportBox, h('span', 'Export')), exportBtn, exportNote);
  const el = h('div.analysis-panel.loudness-panel', toolbar, settingsGrid, h('div.table-scroll', table), exportBar, h('div.analysis-foot', status, liveMeter));

  const addDocs = (docs) => {
    for (const d of docs) {
      if (d.kind !== 'audio' || entries.some((e) => e.doc === d)) continue;
      entries.push({ doc: d, measure: null, status: 'Not scanned', state: null });
    }
    renderRows();
  };
  const removeSelected = () => {
    const i = entries.findIndex((e) => e.doc === selected);
    if (i >= 0) entries.splice(i, 1);
    selected = entries[Math.min(i, entries.length - 1)]?.doc || null;
    renderRows();
  };

  const renderRows = () => {
    const busy = running;
    scanBtn.disabled = busy || !entries.length;
    runBtn.disabled = busy || !entries.length;
    removeBtn.disabled = busy || !selected;
    clearBtn.disabled = busy || !entries.length;
    addAll.disabled = busy;
    body.replaceChildren();
    if (!entries.length) {
      body.append(h('tr', h('td.empty-row', { colspan: '7' }, h('span.empty-text', 'Add open files to measure their loudness and match them to a target.'))));
      return;
    }
    for (const e of entries) {
      const m = e.state === e.doc.state ? e.measure : null;
      const row = h(
        'tr',
        {
          tabindex: '0',
          'aria-selected': String(e.doc === selected),
          onclick: () => {
            selected = e.doc;
            renderRows();
            body.querySelector('[aria-selected=true]')?.focus();
          },
          ondblclick: () => app.activate(e.doc),
          onkeydown: (ev) => {
            if (ev.key === 'Delete' || ev.key === 'Backspace') {
              selected = e.doc;
              removeSelected();
              // The row is gone: keep focus on the row selected next (or Add when the list is empty).
              (body.querySelector('[aria-selected=true]') || addAll).focus();
            } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
              const i = entries.indexOf(e) + (ev.key === 'ArrowDown' ? 1 : -1);
              if (entries[i]) {
                selected = entries[i].doc;
                renderRows();
                body.querySelector('[aria-selected=true]')?.focus();
              }
            } else return;
            ev.preventDefault();
            ev.stopPropagation();
          },
        },
        h('td', e.doc.name),
        h('td.num', m ? `${fmtDb(m.integrated, 1)} LUFS` : ''),
        h('td.num', m && m.rmsDb !== undefined ? `${fmtDb(m.rmsDb, 1)} dB` : ''),
        h('td.num', m && m.peakDb !== undefined ? `${fmtDb(m.peakDb, 1)} dB` : ''),
        h('td.num', m ? `${fmtDb(m.truePeakDb, 1)} dBTP` : ''),
        h('td.num', m ? `${m.range.toFixed(1)} LU` : ''),
        h('td', e.state !== e.doc.state && e.measure ? 'Changed since scan' : e.status),
      );
      body.append(row);
    }
  };

  const scanOne = async (e) => {
    e.status = 'Scanning...';
    renderRows();
    const state = e.doc.state;
    e.measure = await measureLoudness(state, (f) => {
      e.status = `Scanning ${Math.round(f * 100)}%`;
      renderRows();
    });
    e.state = state;
    e.status = 'Scanned';
    renderRows();
    return e.measure;
  };

  /** Scan and Run are disabled while working: returns a function that refocuses the one used. */
  const holdFocus = () => {
    const focused = document.activeElement;
    const trigger = focused === scanBtn || focused === runBtn ? focused : null;
    return () => {
      const at = document.activeElement;
      if (trigger && (at === document.body || !at)) trigger.focus();
    };
  };

  const scanAll = async () => {
    if (running) return;
    const refocus = holdFocus();
    running = true;
    try {
      for (const e of entries) if (e.state !== e.doc.state || !e.measure) await scanOne(e);
      status.textContent = 'Scan complete.';
      announce('Loudness scan complete');
    } catch (err) {
      status.textContent = `Scan failed: ${err.message}`;
    } finally {
      running = false;
      renderRows();
      refocus();
    }
  };

  const runAll = async () => {
    if (running) return;
    if (prefs().export) return exportAll();
    const refocus = holdFocus();
    running = true;
    const s = prefs();
    let changed = 0;
    let short = 0;
    try {
      for (const e of entries) {
        if (!app.documents.includes(e.doc)) continue;
        const m = e.state === e.doc.state && e.measure ? e.measure : await scanOne(e);
        const plan = planMatch(m, s);
        if (plan.action === 'skip') {
          e.status = plan.note;
          renderRows();
          continue;
        }
        e.status = 'Processing...';
        renderRows();
        const base = e.state;
        const { state } = await applyMatch(base, plan, s, (f) => {
          e.status = `Processing ${Math.round(f * 100)}%`;
          renderRows();
        });
        if (e.doc.state !== base) {
          // Edited while measuring or processing: keep the edit (the row shows the change).
          renderRows();
          continue;
        }
        commitWhole(e.doc, 'Match Loudness', state);
        changed++;
        const outcome = matchOutcome(plan, await scanOne(e), s);
        if (outcome.short) short++;
        e.status = outcome.text;
        renderRows();
      }
      const missed = short ? ` ${short} of them stayed below the target to keep the true peak ceiling.` : '';
      status.textContent = changed ? `Matched ${changed} file${changed === 1 ? '' : 's'} to ${s.target.toFixed(1)} LUFS.${missed}` : 'Nothing needed to change.';
      announce(status.textContent);
    } catch (err) {
      status.textContent = `Matching failed: ${err.message}`;
    } finally {
      running = false;
      renderRows();
      refocus();
    }
  };

  const exportAll = async () => {
    const refocus = holdFocus();
    const s = prefs();
    const x = exportSettings();
    const out = await outputWriter(app, x);
    if (!out) return;
    running = true;
    let written = 0;
    try {
      for (const e of entries) {
        if (!app.documents.includes(e.doc)) continue;
        const m = e.state === e.doc.state && e.measure ? e.measure : await scanOne(e);
        const plan = planMatch(m, s);
        e.status = 'Exporting...';
        renderRows();
        const name = await exportMatched(e.doc, plan, s, x, {
          write: (n, blob) => out.write(n, blob),
          onProgress: (f) => {
            e.status = `Exporting ${Math.round(f * 100)}%`;
            renderRows();
          },
        });
        written++;
        e.status = `Exported ${name}${plan.action === 'skip' ? ' (unchanged)' : ` (${plan.gainDb >= 0 ? '+' : ''}${plan.gainDb.toFixed(1)} dB)`}`;
        renderRows();
      }
      await out.finish('Match Loudness.zip');
      status.textContent = `Exported ${written} matched file${written === 1 ? '' : 's'}${out.dir ? ` to ${out.dir}` : ''}.`;
      announce(status.textContent);
    } catch (err) {
      status.textContent = `Export failed: ${err.message}`;
    } finally {
      running = false;
      renderRows();
      refocus();
    }
  };

  /** Loudness matching applies to the whole file even with a spectral selection. */
  const commitWhole = (doc, label, state) => (app.spectral?.applyRaw ? app.spectral.applyRaw(doc, label, state) : doc.apply(label, state));

  // Live loudness while playing ----------------------------------------------------
  let meter = null;
  let lastFrame = null;
  let d = null;
  dsp().then((x) => (d = x)).catch(() => {});
  const tap = masterTap(app, (m) => {
    if (!d) return;
    if (!meter || meter.rate !== m.rate) {
      meter?.m.free();
      meter = { m: loudnessMeter(d, m.rate, 2), rate: m.rate };
      lastFrame = null;
    }
    // Feed only the frames that are new since the previous tap.
    const fresh = lastFrame === null ? Math.round(m.rate * 0.4) : Math.max(0, Math.min(m.L.length, Math.round(m.frame - lastFrame)));
    lastFrame = m.frame;
    if (fresh > 0) meter.m.push([m.L.subarray(m.L.length - fresh), m.R.subarray(m.R.length - fresh)]);
    const r = meter.m.result();
    liveMeter.textContent = `Momentary ${fmtDb(r.momentary, 1)}  Short-term ${fmtDb(r.shortTerm, 1)}  Integrated ${fmtDb(r.integrated, 1)} LUFS`;
  });
  app.on('transport', (s) => {
    if (s === 'playing') {
      meter?.m.free();
      meter = null;
    }
  });
  app.on('documents', () => {
    for (let i = entries.length - 1; i >= 0; i--) if (!app.documents.includes(entries[i].doc)) entries.splice(i, 1);
    if (selected && !app.documents.includes(selected)) selected = null;
    renderRows();
  });
  app.on('doc-change', (doc, e) => (e.kind === 'edit' || e.kind === 'history') && entries.some((x) => x.doc === doc) && renderRows());
  app.matchLoudnessAdd = (doc) => addDocs([doc]);
  app.prefs.on?.('change', (key) => key === 'matchLoudnessExport' && syncControls());
  syncControls();
  renderRows();

  return {
    el,
    show() {
      tap.start();
      if (!entries.length && app.active?.kind === 'audio') addDocs([app.active]);
    },
    hide() {
      tap.stop();
    },
    focus() {
      (entries.length ? runBtn : addAll).focus();
    },
  };
}

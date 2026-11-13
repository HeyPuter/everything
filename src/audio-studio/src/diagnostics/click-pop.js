// Click/Pop Eliminator dialog. A threshold graph plots the Detect and Reject
// curves over the level of the audio (drag their points), with every click a
// scan found drawn as a dot at its level and strength. The list beside it
// shows the detected clicks with times; the ones above the Reject curve are
// ticked for repair, and any can be ticked or unticked. Repair rebuilds the
// ticked clicks (least-squares AR fill) as one undo step and keeps the dialog
// open with what is left. Scan For Threshold Levels measures the minimum,
// average and maximum level of the audio; Scan For All Levels also sets the
// curves from Sensitivity and Discrimination and scans for clicks. Fill
// Single Click rebuilds a short selection by hand.
//
// Built on the Diagnostics scan and repair (scan.js), which run in the
// diagnostics worker. Thresholds and strengths share one 0..150 scale
// (defs/click-thresholds.js).

import { h, announce } from '../lib/dom.js';
import { cssVar } from '../ui/theme.js';
import { openDialog } from '../ui/dialog.js';
import { getEffect } from '../effects/registry.js';
import { normalizeValues } from '../effects/params.js';
import { lastValues, rememberValues, allPresets, matchPreset } from '../effects/presets.js';
import { plot, gridLines, labelText, draggable } from '../effects/editors.js';
import { controlsFor, groupBox, numberField, disclosure, checkbox } from '../effects/layout.js';
import { thresholdPoints, thresholdAt, clickVerdict, detectionFloor, autoThresholds, levelStats, LEVEL_FLOOR } from '../effects/defs/click-thresholds.js';
import { scanProblems, fillProblems } from './scan.js';

export const EFFECT_ID = 'clickPopEliminator';

/** Longest selection Fill Single Click rebuilds (samples; rs_fill_gap MAX_FILL). */
export const MAX_FILL = 4096;

/** Threshold-scale top of the graph; stronger clicks sit on the top edge. */
const T_MAX = 150;

/** Clicks the thresholds detect (verdict 1 or 2), and the ones they would repair. */
export function classify(found, values) {
  const list = [];
  const chosen = new Set();
  for (const p of found) {
    const v = clickVerdict({ strength: p.level, db: p.db, core: p.core }, values);
    if (!v) continue;
    list.push(p);
    if (v === 2) chosen.add(p.id);
  }
  return { list, chosen };
}

const THRESHOLD_IDS = /^(detect|reject|level)(Min|Avg|Max)$|^(verify|crackle)$/;
const SCAN_IDS = new Set(['runSize', 'oversample', 'bigPops']);

/**
 * Opens the dialog for `doc`. Resolves when it closes; `options.runner` and
 * `options.autoScan` exist for tests.
 */
export function openClickPopDialog(app, doc, { runner = null, autoScan = true } = {}) {
  const def = getEffect(EFFECT_ID);
  let values = normalizeValues(def, lastValues(app.prefs, def));
  let scan = null; // { state, range, found, floor, values }
  let list = [];
  let chosen = new Set();
  let busy = null;
  let focusIndex = 0;
  const subscribers = new Set();

  // A dialog context shaped like the effect dialog's, so the layout helpers work.
  const ctx = {
    def,
    app,
    doc,
    get values() {
      return values;
    },
    set: (id, v) => setValues({ [id]: v }, id),
    subscribe: (fn) => subscribers.add(fn),
  };
  function setValues(patch, from = null) {
    const next = normalizeValues(def, { ...values, ...patch });
    if (JSON.stringify(next) === JSON.stringify(values)) return;
    const changed = Object.keys(patch);
    values = next;
    subscribers.forEach((fn) => fn(values));
    if (scan && changed.some((id) => THRESHOLD_IDS.test(id))) reclassify();
    if (scan && changed.some((id) => SCAN_IDS.has(id))) caption.textContent = 'Settings changed: scan again to update the list.';
    else if (scan && detectionFloor(values) < scan.floor - 1e-9) caption.textContent = 'The Detect curve is below the last scan: scan again to find weaker clicks.';
    syncPresets();
    render(from);
  }
  function reclassify() {
    const next = classify(scan.found, values);
    // Moving the Reject curve often changes only which clicks are ticked: keep the list (and its rows).
    list = next.list.length === list.length && next.list.every((p, i) => p === list[i]) ? list : next.list;
    chosen = next.chosen;
    focusIndex = Math.min(focusIndex, Math.max(0, list.length - 1));
  }

  // -------------------------------------------------------------- presets
  const presetSel = h('select.select.fx-preset-select', { 'aria-label': 'Presets', onchange: () => {
    const p = allPresets(app.prefs, def).find((x) => x.name === presetSel.value);
    if (p) setValues(normalizeValues(def, p.values));
  } });
  function syncPresets() {
    const current = matchPreset(app.prefs, def, values);
    presetSel.replaceChildren(...(current ? [] : [h('option', { value: '' }, '(Custom)')]), ...allPresets(app.prefs, def).map((p) => h('option', { value: p.name }, p.name)));
    presetSel.value = current;
  }
  syncPresets();

  // ---------------------------------------------------------------- graph
  // x: level around a click (dB); y: threshold scale on a log-like axis
  // (residual multiples), so the low thresholds where most clicks sit get room.
  const fy = (t) => Math.log(1 + Math.min(T_MAX, Math.max(0, t)) / 10) / Math.log(1 + T_MAX / 10);
  const tOf = (f) => 10 * (Math.pow(1 + T_MAX / 10, f) - 1);
  const PAD = { l: 6, r: 34, t: 8, b: 18 };
  const xOf = (d, W) => PAD.l + ((Math.max(LEVEL_FLOOR, Math.min(0, d)) - LEVEL_FLOOR) / -LEVEL_FLOOR) * (W - PAD.l - PAD.r);
  const yOf = (t, H) => H - PAD.b - fy(t) * (H - PAD.t - PAD.b);
  const graph = plot('cpe-graph', 'Detection thresholds over level, with the clicks found', (g, W, H) => {
    const xs = [];
    for (let d = LEVEL_FLOOR; d <= 0; d += 10) xs.push(d);
    const ts = [0, 10, 20, 40, 70, 100, 150];
    gridLines(g, W, H, xs.map((d) => xOf(d, W)), ts.map((t) => yOf(t, H)));
    xs.forEach((d) => labelText(g, String(d), xOf(d, W), H - 14, d === 0 ? 'right' : d === LEVEL_FLOOR ? 'left' : 'center'));
    ts.forEach((t) => labelText(g, String(t), W - 3, yOf(t, H) - 6, 'right'));
    if (scan) {
      const listed = new Set(list);
      for (const p of scan.found) {
        const on = chosen.has(p.id);
        const shown = on || listed.has(p);
        g.fillStyle = on ? cssVar('--hot') : shown ? cssVar('--text-dim') : cssVar('--text-faint');
        const r = shown ? 2.5 : 1.5;
        g.beginPath();
        g.arc(xOf(p.db, W), Math.max(PAD.t, yOf(p.level, H)), r, 0, Math.PI * 2);
        g.fill();
      }
    }
    const curve = (which, color, dashed) => {
      const pts = thresholdPoints(values, which);
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.setLineDash(dashed ? [5, 3] : []);
      g.beginPath();
      g.moveTo(xOf(LEVEL_FLOOR, W), yOf(pts[0].t, H));
      for (const p of pts) g.lineTo(xOf(p.db, W), yOf(p.t, H));
      g.lineTo(xOf(0, W), yOf(pts[pts.length - 1].t, H));
      g.stroke();
      g.setLineDash([]);
    };
    curve('detect', cssVar('--meter-green'), false);
    curve('reject', cssVar('--meter-red'), !values.verify);
  });

  // Six handles: the Min, Avg and Max points of each curve. Up and down set
  // the threshold; left and right move that level for both curves.
  const handles = [];
  for (const which of ['detect', 'reject']) {
    for (const k of ['Max', 'Avg', 'Min']) {
      const id = `${which}${k}`;
      const levelId = `level${k}`;
      const name = `${which === 'detect' ? 'Detect' : 'Reject'} threshold at the ${k === 'Max' ? 'maximum' : k === 'Avg' ? 'average' : 'minimum'} level`;
      const btn = h(`button.fx-handle.cpe-handle.${which}`, { type: 'button', role: 'slider', 'aria-label': name, 'aria-valuemin': '0', 'aria-valuemax': String(T_MAX) });
      draggable(btn, graph.el, (fx, fyy) => {
        const W = graph.el.clientWidth || 1;
        const H = graph.el.clientHeight || 1;
        const d = LEVEL_FLOOR + ((fx * W - PAD.l) / (W - PAD.l - PAD.r)) * -LEVEL_FLOOR;
        const f = (H - PAD.b - fyy * H) / (H - PAD.t - PAD.b);
        setValues({ [id]: Math.round(tOf(Math.min(1, Math.max(0, f)))), [levelId]: Math.round(d * 10) / 10 }, id);
      });
      btn.addEventListener('keydown', (e) => {
        const big = e.shiftKey ? 10 : 1;
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') setValues({ [id]: values[id] + (e.key === 'ArrowUp' ? big : -big) }, id);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') setValues({ [levelId]: values[levelId] + (e.key === 'ArrowRight' ? big : -big) }, id);
        else return;
        e.preventDefault();
        e.stopPropagation();
      });
      graph.layer.append(btn);
      handles.push({ btn, id, levelId });
    }
  }
  const legend = h(
    'div.cpe-legend',
    h('span.cpe-key.detect', 'Detect'),
    h('span.cpe-key.reject', 'Reject'),
    h('span.cpe-key.click', 'Click to repair'),
    h('span.cpe-key.kept', 'Click left alone'),
  );

  // ----------------------------------------------------------------- list
  const body = h('tbody');
  const allBox = h('input', { type: 'checkbox', 'aria-label': 'Repair all detected clicks' });
  allBox.addEventListener('change', () => {
    if (!scan) return;
    chosen = allBox.checked ? new Set(list.map((p) => p.id)) : new Set();
    render();
  });
  const table = h(
    'table.data-table.cpe-table',
    { role: 'grid', 'aria-label': 'Detected clicks' },
    h('thead', h('tr', h('th.cpe-check', { scope: 'col' }, allBox), h('th.num', { scope: 'col' }, '#'), h('th', { scope: 'col' }, 'Time'), h('th', { scope: 'col' }, 'Channel'), h('th.num', { scope: 'col' }, 'Level'), h('th.num', { scope: 'col' }, 'Strength'))),
    body,
  );
  const progress = h('div.analysis-progress', { role: 'progressbar', 'aria-label': 'Click/Pop Eliminator progress', 'aria-valuemin': '0', 'aria-valuemax': '100', hidden: true }, h('div.analysis-progress-bar'));
  const caption = h('div.cpe-caption', { 'aria-live': 'polite' });
  const scanBtn = h('button.btn', { type: 'button', title: 'Find the clicks the Detect curve passes in the selection (or the file)', onclick: () => runScan() }, 'Find Clicks');
  const allLevelsBtn = h('button.btn', { type: 'button', title: 'Measure the levels, set both curves from Sensitivity and Discrimination, then find clicks', onclick: () => scanLevels(true) }, 'Scan For All Levels');
  const levelsBtn = h('button.btn', { type: 'button', title: 'Measure the minimum, average and maximum level of the selection (or the file)', onclick: () => scanLevels(false) }, 'Scan For Threshold Levels');
  const fillBtn = h('button.btn', { type: 'button', title: `Rebuild the selected audio from its surroundings (up to ${MAX_FILL} samples)`, onclick: () => fillSelection() }, 'Fill Single Click');
  const cancelBtn = h('button.btn', { type: 'button', hidden: true, onclick: () => busy?.abort() }, 'Cancel');

  const timeText = (f) => (app.formatTime ? app.formatTime(f, doc.sampleRate) : `${(f / doc.sampleRate).toFixed(3)} s`);
  const chanText = (p) => (doc.channelCount === 1 ? 'Mono' : p.channels.length >= doc.channelCount ? 'All' : p.channels.map((c) => (doc.channelCount === 2 ? (c === 0 ? 'L' : 'R') : String(c + 1))).join(', '));

  function show(p) {
    doc.setSelection(p.start, Math.max(p.end, p.start + 1));
    doc.setCursor?.(p.start);
    const want = Math.max((p.end - p.start) * 40, doc.sampleRate * 0.05);
    const mid = (p.start + p.end) / 2;
    doc.setView?.(mid - want / 2, mid + want / 2);
  }

  function toggle(p) {
    chosen = new Set(chosen);
    if (chosen.has(p.id)) chosen.delete(p.id);
    else chosen.add(p.id);
    render();
  }

  function rowKeys(e, i) {
    const n = list.length;
    const go = (j) => {
      focusIndex = Math.max(0, Math.min(n - 1, j));
      show(list[focusIndex]);
      renderRows();
      body.children[focusIndex]?.focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(n - 1);
    else if (e.key === ' ') toggle(list[i]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  let shown = null; // the rows on screen: { list, rows: [{ tr, box }] }

  function renderRows() {
    const empty = (text) => {
      shown = null;
      body.replaceChildren(h('tr', h('td.empty-row', { colspan: '6' }, h('span.empty-text', text))));
    };
    if (!scan) return empty('Find Clicks lists the clicks and pops in the selection, or the whole file.');
    if (!list.length) return empty(scan.found.length ? 'No clicks pass the Detect curve. Lower it and the list fills again.' : 'No clicks found. Lower the Detect curve and scan again.');
    if (shown?.list === list) {
      // The same clicks: only ticks and the tab stop change (thousands of rows are not rebuilt).
      shown.rows.forEach(({ tr, box }, i) => {
        const on = chosen.has(list[i].id);
        if (box.checked !== on) box.checked = on;
        if (tr.getAttribute('aria-selected') !== String(on)) tr.setAttribute('aria-selected', String(on));
        const tab = i === focusIndex ? '0' : '-1';
        if (tr.getAttribute('tabindex') !== tab) tr.setAttribute('tabindex', tab);
      });
      return;
    }
    const rows = list.map((p, i) => {
      const box = h('input', { type: 'checkbox', checked: chosen.has(p.id), tabindex: '-1', 'aria-label': `Repair click ${i + 1}`, onclick: (e) => e.stopPropagation(), onchange: () => toggle(p) });
      const tr = h(
        'tr',
        {
          tabindex: i === focusIndex ? '0' : '-1',
          'aria-selected': String(chosen.has(p.id)),
          onclick: () => {
            focusIndex = i;
            show(p);
            renderRows();
          },
          onkeydown: (e) => rowKeys(e, i),
        },
        h('td.cpe-check', box),
        h('td.num', String(i + 1)),
        h('td.tabular', timeText(p.start)),
        h('td', chanText(p)),
        h('td.num', `${Math.round(p.db)} dB`),
        h('td.num', p.level >= T_MAX ? `${T_MAX}+` : String(Math.round(p.level))),
      );
      return { tr, box };
    });
    body.replaceChildren(...rows.map((r) => r.tr));
    shown = { list, rows };
  }

  let repairBtn = null;
  function placeHandles() {
    for (const { btn, id, levelId } of handles) {
      const W = graph.el.clientWidth;
      const H = graph.el.clientHeight || 160;
      btn.style.left = W ? `${xOf(values[levelId], W)}px` : `${((values[levelId] - LEVEL_FLOOR) / -LEVEL_FLOOR) * 100}%`;
      btn.style.top = `${yOf(values[id], H)}px`;
      btn.setAttribute('aria-valuenow', String(values[id]));
      btn.setAttribute('aria-valuetext', `${values[id]} at ${values[levelId]} dB`);
      btn.classList.toggle('off', id.startsWith('reject') && !values.verify);
    }
  }
  function render(from = null) {
    if (from !== 'rows') renderRows();
    const n = list.length;
    const k = chosen.size;
    allBox.checked = n > 0 && k === n;
    allBox.indeterminate = k > 0 && k < n;
    allBox.disabled = !n || Boolean(busy);
    placeHandles();
    graph.redraw();
    scanBtn.textContent = scan ? 'Scan Again' : 'Find Clicks';
    for (const b of [scanBtn, allLevelsBtn, levelsBtn]) b.disabled = Boolean(busy);
    const sel = doc.selection;
    fillBtn.disabled = Boolean(busy) || !(sel.end > sel.start && sel.end - sel.start <= MAX_FILL);
    cancelBtn.hidden = !busy;
    if (repairBtn) {
      repairBtn.textContent = k ? `Repair ${k} Click${k === 1 ? '' : 's'}` : 'Repair';
      repairBtn.disabled = Boolean(busy) || !k;
    }
  }
  const offSel = doc.on?.('change', (e) => e?.kind === 'selection' && render('rows'));

  const setProgress = (f) => {
    const pct = Math.round(f * 100);
    progress.firstChild.style.width = `${pct}%`;
    progress.setAttribute('aria-valuenow', String(pct));
  };

  /** Runs `job(signal)` with the progress bar and Cancel; returns its result or null. */
  async function task(text, job) {
    if (busy) return null;
    busy = new AbortController();
    const signal = busy.signal;
    progress.hidden = false;
    setProgress(0);
    caption.textContent = text;
    // The buttons are disabled while working, which drops focus out of the dialog to the
    // page: keep it on Cancel, then give it back.
    const dlg = el.closest('.dialog');
    const before = document.activeElement;
    const inside = Boolean(dlg?.contains(before));
    render();
    if (inside && before.disabled) cancelBtn.focus();
    try {
      return await job(signal);
    } catch (err) {
      caption.textContent = signal.aborted || err?.name === 'AbortError' || err?.message === 'Cancelled' ? 'Cancelled. Nothing was changed.' : `Failed: ${err.message}`;
      return null;
    } finally {
      busy = null;
      progress.hidden = true;
      render();
      const at = document.activeElement;
      if (inside && dlg.isConnected && (at === cancelBtn || !dlg.contains(at))) {
        (before.isConnected && !before.disabled ? before : scanBtn).focus();
      }
    }
  }

  const where = () => (doc.hasSelection ? 'the selection' : 'the file');

  async function runScan() {
    const range = doc.editRange();
    if (range[1] <= range[0]) return;
    await task(`Scanning ${where()}...`, async (signal) => {
      const state = doc.state;
      const mask = doc.channelMask;
      const r = await scanProblems({ effect: 'clickPop', values, channels: state.channels, rate: doc.sampleRate, start: range[0], end: range[1], signal, onProgress: setProgress, runner });
      // Only channels that are enabled for editing are repaired.
      const found = r.problems.map((p) => ({ ...p, channels: p.channels.filter((c) => !mask || mask[c]) })).filter((p) => p.channels.length);
      scan = { state, range, found, floor: detectionFloor(values), values: { ...values } };
      focusIndex = 0;
      reclassify();
      caption.textContent = list.length ? `${list.length} click${list.length === 1 ? '' : 's'} detected; ${chosen.size} above the Reject curve.` : 'No clicks detected.';
      announce(caption.textContent);
    });
  }

  async function scanLevels(all) {
    const range = doc.editRange();
    if (range[1] <= range[0]) return;
    const stats = await task(`Measuring the levels of ${where()}...`, async (signal) => {
      const r = await scanProblems({ effect: 'levels', values, channels: doc.state.channels, rate: doc.sampleRate, start: range[0], end: range[1], signal, onProgress: setProgress, runner });
      return levelStats(r.info.dbs);
    });
    if (!stats) {
      if (!caption.textContent.startsWith('Cancelled') && !caption.textContent.startsWith('Failed')) caption.textContent = 'The audio is silent: no levels to measure.';
      return;
    }
    setValues(all ? { ...stats, ...autoThresholds(values) } : stats);
    caption.textContent = `Levels: maximum ${stats.levelMax} dB, average ${stats.levelAvg} dB, minimum ${stats.levelMin} dB.`;
    announce(caption.textContent);
    if (all) await runScan();
  }

  async function repair() {
    if (busy || !scan) return;
    if (doc.state !== scan.state) {
      caption.textContent = 'The file changed since the scan. Scan again before repairing.';
      return;
    }
    const picked = list.filter((p) => chosen.has(p.id));
    if (!picked.length) return;
    await task('Repairing...', async (signal) => {
      const next = await fillProblems(doc.state, picked, { runner, signal, onProgress: setProgress });
      if (signal.aborted) throw new Error('Cancelled');
      if (doc.state !== scan.state) {
        caption.textContent = 'The file changed while repairing. Nothing was changed.';
        return;
      }
      doc.apply(`${def.name.replace(/ \(process\)$/, '')}: Repair ${picked.length} click${picked.length === 1 ? '' : 's'}`, next);
      rememberValues(app.prefs, def, values);
      const done = new Set(picked.map((p) => p.id));
      scan = { ...scan, state: doc.state, found: scan.found.filter((p) => !done.has(p.id)) };
      list = list.filter((p) => !done.has(p.id));
      chosen = new Set();
      focusIndex = 0;
      caption.textContent = `Repaired ${picked.length} click${picked.length === 1 ? '' : 's'}.${list.length ? ` ${list.length} left unticked.` : ''}`;
      announce(caption.textContent);
      app.setStatus?.(caption.textContent);
    });
  }

  async function fillSelection() {
    const { start, end } = doc.selection;
    if (!(end > start) || end - start > MAX_FILL) return;
    const mask = doc.channelMask;
    const channels = doc.state.channels.map((_, c) => c).filter((c) => !mask || mask[c]);
    const before = doc.state;
    await task('Filling the selection...', async (signal) => {
      const next = await fillProblems(before, [{ start, end, channels }], { runner, signal });
      if (doc.state !== before) return;
      doc.apply(`${def.name.replace(/ \(process\)$/, '')}: Fill Single Click`, next);
      caption.textContent = `Filled ${end - start} sample${end - start === 1 ? '' : 's'}.${scan ? ' Scan again to update the list.' : ''}`;
      if (scan) scan = { ...scan, state: null };
      announce(caption.textContent);
    });
  }

  // ------------------------------------------------------------- settings
  const levelRow = (k, label) => [
    h('span.fx-label', `${label}:`),
    h('span.cpe-level', numberField(ctx, `level${k}`, { label: `${label} level` })),
    controlsFor(ctx, [`detect${k}`], { labels: { [`detect${k}`]: 'Detect' } }),
    controlsFor(ctx, [`reject${k}`], { labels: { [`reject${k}`]: 'Reject' } }),
  ];
  const detection = groupBox(
    'Detection',
    h('div.cpe-detect-top', h('div.cpe-buttons', allLevelsBtn, levelsBtn), controlsFor(ctx, ['sensitivity', 'discrimination']), checkbox(ctx, 'verify')),
    h('div.cpe-levels', levelRow('Max', 'Maximum'), levelRow('Avg', 'Average'), levelRow('Min', 'Minimum')),
  );
  const correction = groupBox('Correction', h('div.cpe-correction', h('div.cpe-buttons', fillBtn), controlsFor(ctx, ['runSize', 'oversample'])));
  const advanced = disclosure('Advanced', controlsFor(ctx, ['passes', 'bigPops', 'crackle']), { prefs: app.prefs, key: 'clickPop' });

  const el = h(
    'div.cpe-dialog-body',
    h('div.fx-presetbar', h('span.fx-label', 'Presets:'), presetSel),
    h('div.cpe-top', h('div.cpe-graph-wrap', graph.el, legend), h('div.table-scroll.cpe-list', table)),
    h('div.panel-toolbar.cpe-toolbar', scanBtn, cancelBtn, progress, caption),
    detection,
    correction,
    advanced,
  );

  const promise = openDialog({
    title: def.name.replace(/ \(process\)$/, ''),
    className: 'fx-dialog.fx-wide.cpe-dialog',
    wide: true,
    body: el,
    buttons: [
      { label: 'Close', value: null },
      { label: 'Repair', value: 'repair', primary: true },
    ],
    onSubmit: async (v) => {
      if (v === 'repair') await repair();
      return false; // stays open; Close (null) skips onSubmit
    },
    initialFocus: '.cpe-toolbar .btn',
  }).then(() => {
    busy?.abort();
    offSel?.();
    rememberValues(app.prefs, def, values);
  });
  repairBtn = el.closest('.dialog')?.querySelector('.dialog-foot button[data-value="repair"]') || null;
  render();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(placeHandles).observe(graph.el);
  if (autoScan) runScan();
  return Object.assign(promise, {
    scan: () => runScan(),
    scanLevels: (all = false) => scanLevels(all),
    repair: () => repair(),
    fill: () => fillSelection(),
    set: (patch) => setValues(patch),
    state: () => ({ scan, list, chosen, values }),
  });
}

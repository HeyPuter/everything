// Diagnostics panel: choose DeClicker, DeClipper, Delete Silence or Mark
// Audio, adjust its settings, scan the selection or the entire file, and get
// a table of what was found (start, length, channels, level). Clicking a row
// selects that range in the editor. Repair (selected or all) rebuilds clicks
// and clipped peaks, Delete shortens silences, Mark adds range markers (for
// any diagnostic, so problems can be reviewed later from the Markers panel);
// each action is one undo step. Scanning and repair run in a worker.

import { h, announce } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { getEffect } from '../effects/registry.js';
import { normalizeValues } from '../effects/params.js';
import { allPresets, matchPreset } from '../effects/presets.js';
import { paramControls } from '../effects/dialog.js';
import { scanProblems, repairClicks, repairClips, deleteSilences, shiftProblems, markAudio, markProblems, createRunner } from './scan.js';

const PREFS = 'diagnostics';

export const DIAGNOSTICS = [
  { id: 'declicker', label: 'DeClicker', action: 'Repair', noun: 'click' },
  { id: 'declipper', label: 'DeClipper', action: 'Repair', noun: 'clipped run' },
  { id: 'deleteSilence', label: 'Delete Silence', action: 'Delete', noun: 'silence' },
  { id: 'markAudio', label: 'Mark Audio', action: 'Mark', noun: 'audio region' },
];

const fmtLevel = (p) => {
  if (p.kind === 'click') return `${p.level.toFixed(1)}x`;
  return Number.isFinite(p.level) ? `${p.level.toFixed(1)} dB` : '-∞ dB';
};

export function diagnosticsPanel(app) {
  const saved = () => app.prefs.get(PREFS) || {};
  let effectId = DIAGNOSTICS.some((d) => d.id === saved().effect) ? saved().effect : 'declicker';
  let values = {};
  let result = null; // { docId, effect, values, problems, info, range, fileLength }
  let selected = new Set();
  let focusIndex = 0;
  let abort = null;
  let applying = false;

  const loadValues = () => {
    const def = getEffect(effectId);
    values = normalizeValues(def, saved().values?.[effectId] || def.presets?.[0]?.values || {});
  };
  const storeValues = () => {
    const s = saved();
    app.prefs.set(PREFS, { ...s, effect: effectId, values: { ...(s.values || {}), [effectId]: values } });
  };
  loadValues();

  // ------------------------------------------------------------ controls
  const effectSel = h('select.select.diag-effect', { 'aria-label': 'Diagnostic' }, DIAGNOSTICS.map((d) => h('option', { value: d.id }, d.label)));
  effectSel.value = effectId;
  const selectEffect = (id) => {
    if (!DIAGNOSTICS.some((d) => d.id === id) || abort) return;
    effectSel.value = id;
    if (id === effectId) return;
    effectId = id;
    loadValues();
    storeValues();
    result = null;
    selected = new Set();
    buildSettings();
    refresh();
  };
  effectSel.addEventListener('change', () => {
    effectId = effectSel.value;
    loadValues();
    storeValues();
    result = null;
    selected = new Set();
    buildSettings();
    refresh();
  });
  const presetSel = h('select.select.diag-preset', { 'aria-label': 'Preset' });
  presetSel.addEventListener('change', () => {
    const def = getEffect(effectId);
    const p = allPresets(app.prefs, def).find((x) => x.name === presetSel.value);
    if (!p) return;
    values = normalizeValues(def, p.values);
    storeValues();
    settings?.refresh(values);
    renderPreset();
    renderGainNote();
  });
  const settingsToggle = h('button.icon-btn.diag-settings-toggle', { type: 'button', 'aria-expanded': 'true', 'aria-controls': 'diag-settings', 'aria-label': 'Hide settings', title: 'Show or hide settings' }, icon('sliders-horizontal', 14));
  const settingsHost = h('div.diag-settings', { id: 'diag-settings' });
  settingsToggle.addEventListener('click', () => {
    const open = settingsHost.hidden;
    settingsHost.hidden = !open;
    settingsToggle.setAttribute('aria-expanded', String(open));
    settingsToggle.setAttribute('aria-label', open ? 'Hide settings' : 'Show settings');
  });
  let settings = null;
  const buildSettings = () => {
    const def = getEffect(effectId);
    settings = paramControls(def, () => values, (id, v) => {
      values = normalizeValues(def, { ...values, [id]: v });
      storeValues();
      settings.refresh(values, id);
      renderPreset();
      renderGainNote();
    });
    settingsHost.replaceChildren(settings.el);
    renderPreset();
  };
  const renderPreset = () => {
    const def = getEffect(effectId);
    const list = allPresets(app.prefs, def);
    const cur = matchPreset(app.prefs, def, values);
    presetSel.replaceChildren(h('option', { value: '', disabled: true }, '(Custom)'), ...list.map((p) => h('option', { value: p.name }, p.name)));
    presetSel.value = cur;
  };

  const scanSelBtn = h('button.btn', { type: 'button', onclick: () => scan(true) }, icon('search', 14), h('span', 'Scan Selection'));
  const scanAllBtn = h('button.btn.primary', { type: 'button', onclick: () => scan(false) }, icon('search', 14), h('span', 'Scan File'));
  const cancelBtn = h('button.btn', { type: 'button', hidden: true, onclick: () => abort?.abort() }, 'Cancel');
  const progress = h('div.analysis-progress', { role: 'progressbar', 'aria-label': 'Diagnostics progress', 'aria-valuemin': '0', 'aria-valuemax': '100', hidden: true }, h('div.analysis-progress-bar'));
  const caption = h('div.diag-caption', { 'aria-live': 'polite' });
  // DeClipper repairs the runs, then applies its Gain to the whole scanned
  // range so restored peaks have headroom; say so before anything changes.
  const gainNote = h('div.diag-note.faint', { id: 'diag-gain-note' });
  const declipGain = (v) => (effectId === 'declipper' && v?.gain ? v.gain : 0);
  const renderGainNote = () => {
    const g = declipGain(result?.effect === 'declipper' ? result.values : values);
    const where = result?.effect === 'declipper' && result.range && audioDoc()?.id === result.docId && (result.range[0] > 0 || result.range[1] < audioDoc().length) ? 'the scanned selection' : 'the whole scanned range';
    gainNote.textContent = g ? `Repair also changes the level of ${where} by ${g > 0 ? '+' : ''}${g.toFixed(1)} dB (Gain setting).` : '';
    gainNote.hidden = !g;
  };

  const body = h('tbody');
  const table = h(
    'table.data-table.diag-table',
    { role: 'grid', 'aria-label': 'Detected problems', 'aria-multiselectable': 'true' },
    h('thead', h('tr', h('th.num', { scope: 'col' }, '#'), h('th', { scope: 'col' }, 'Start'), h('th', { scope: 'col' }, 'Length'), h('th', { scope: 'col' }, 'Channel'), h('th.num', { scope: 'col' }, 'Level'))),
    body,
  );
  const actSelBtn = h('button.btn', { type: 'button', onclick: () => act(false), 'aria-describedby': 'diag-gain-note' });
  const actAllBtn = h('button.btn', { type: 'button', onclick: () => act(true), 'aria-describedby': 'diag-gain-note' });
  const markBtn = h('button.btn', { type: 'button', onclick: () => markFound(), title: 'Add a range marker for each selected result (all results when none is selected)' }, 'Mark');
  const actions = h('div.diag-actions', h('span.diag-count.faint'), h('div.spacer'), actSelBtn, actAllBtn, markBtn);

  const el = h(
    'div.diag-panel',
    h('div.diag-top', h('div.diag-row', h('label.diag-label', 'Effect'), effectSel, settingsToggle), h('div.diag-row', h('label.diag-label', 'Preset'), presetSel), settingsHost),
    h('div.panel-toolbar.diag-toolbar', scanSelBtn, scanAllBtn, cancelBtn),
    progress,
    caption,
    h('div.table-scroll.diag-list', table),
    gainNote,
    actions,
  );

  // ----------------------------------------------------------------- scan
  /** Results are acted on in full, even inside a spectral selection (which would mask the repairs). */
  const commit = (doc, label, state) => (app.spectral?.applyRaw ? app.spectral.applyRaw(doc, label, state) : doc.apply(label, state));
  const audioDoc = () => (app.active?.kind === 'audio' ? app.active : null);
  const meta = () => DIAGNOSTICS.find((d) => d.id === effectId);
  const setProgress = (f) => {
    const pct = Math.round(f * 100);
    progress.firstChild.style.width = `${pct}%`;
    progress.setAttribute('aria-valuenow', String(pct));
  };

  async function scan(selectionOnly) {
    const doc = audioDoc();
    if (!doc || abort) return;
    const range = selectionOnly && doc.hasSelection ? [doc.selection.start, doc.selection.end] : [0, doc.length];
    if (range[1] <= range[0]) return;
    abort = new AbortController();
    const signal = abort.signal;
    progress.hidden = false;
    setProgress(0);
    caption.textContent = `Scanning ${selectionOnly && doc.hasSelection ? 'the selection' : doc.name}...`;
    refresh();
    try {
      // Like the effects, clicks and clipping are only looked for (and repaired) in enabled channels.
      const mask = doc.channelMask;
      const state = doc.state;
      const r = await scanProblems({ effect: effectId, values, channels: state.channels, rate: doc.sampleRate, start: range[0], end: range[1], mask, signal, onProgress: setProgress });
      selected = new Set();
      focusIndex = 0;
      if (doc.state !== state) {
        // Edited during the scan: the problem positions no longer match the audio.
        result = null;
        caption.textContent = 'The file changed during the scan. Scan again to update the list.';
        return;
      }
      result = { docId: doc.id, state, effect: effectId, values: { ...values }, problems: r.problems, info: r.info, range, mask };
      const n = r.problems.length;
      caption.textContent = n ? `${n} ${meta().noun}${n === 1 ? '' : 's'} found.` : `No ${meta().noun}s found.`;
      announce(caption.textContent);
    } catch (err) {
      caption.textContent = signal.aborted || err?.name === 'AbortError' ? 'Scan cancelled.' : `Scan failed: ${err.message}`;
    } finally {
      abort = null;
      progress.hidden = true;
      refresh();
    }
  }

  // --------------------------------------------------------------- actions
  async function act(all) {
    const doc = audioDoc();
    if (!doc || !result || result.docId !== doc.id || abort) return;
    if (doc.state !== result.state) {
      caption.textContent = 'The file changed since the scan. Scan again before acting on the results.';
      return;
    }
    const list = all ? result.problems : result.problems.filter((p) => selected.has(p.id));
    if (!list.length) return;
    const effect = result.effect;
    const label = `${getEffect(effect).name}: ${meta().action} ${list.length} ${meta().noun}${list.length === 1 ? '' : 's'}`;
    abort = new AbortController();
    const signal = abort.signal;
    progress.hidden = false;
    setProgress(0);
    refresh();
    let runner = null;
    try {
      let next;
      let remaining;
      if (effect === 'declicker' || effect === 'declipper') {
        runner = await createRunner();
        signal.addEventListener('abort', () => runner.close(), { once: true });
        next =
          effect === 'declicker'
            ? await repairClicks(doc.state, list, result.values, { runner, signal, onProgress: setProgress })
            : await repairClips(doc.state, list, result.values, result.info.level, result.range, { mask: result.mask, runner, signal, onProgress: setProgress });
        const done = new Set(list.map((p) => p.id));
        remaining = result.problems.filter((p) => !done.has(p.id));
      } else if (effect === 'deleteSilence') {
        const r = deleteSilences(doc.state, list, result.values.keep);
        next = r.state;
        remaining = shiftProblems(result.problems, r.removed, list.map((p) => p.id));
      } else {
        next = markAudio(doc.state, list);
        const done = new Set(list.map((p) => p.id));
        remaining = result.problems.map((p) => (done.has(p.id) ? { ...p, marked: true } : p));
      }
      if (signal.aborted) throw new Error('Cancelled');
      if (doc.state !== result.state) {
        caption.textContent = 'The file changed while working. Nothing was changed.';
        return;
      }
      applying = true;
      try {
        commit(doc, label, next);
      } finally {
        applying = false;
      }
      result = { ...result, state: doc.state, problems: remaining };
      selected = new Set();
      focusIndex = Math.min(focusIndex, Math.max(0, remaining.length - 1));
      const g = effect === 'declipper' ? declipGain(result.values) : 0;
      caption.textContent = `${label.replace(/^[^:]+: /, '')}: done.${g ? ` The scanned range was changed by ${g > 0 ? '+' : ''}${g.toFixed(1)} dB.` : ''}`;
      announce(caption.textContent);
    } catch (err) {
      caption.textContent = signal.aborted || err?.message === 'Cancelled' ? 'Cancelled. Nothing was changed.' : `Failed: ${err.message}`;
    } finally {
      runner?.close();
      abort = null;
      progress.hidden = true;
      refresh();
    }
  }

  /** Marks the selected results (or all) as range markers without repairing them. */
  function markFound() {
    const doc = audioDoc();
    if (!doc || !result || result.docId !== doc.id || abort || doc.state !== result.state) return;
    const list = selected.size ? result.problems.filter((p) => selected.has(p.id)) : result.problems;
    if (!list.length) return;
    const m = meta();
    const noun = m.noun[0].toUpperCase() + m.noun.slice(1);
    applying = true;
    try {
      commit(doc, `${getEffect(result.effect).name}: Mark ${list.length} ${m.noun}${list.length === 1 ? '' : 's'}`, markProblems(doc.state, list, noun));
    } finally {
      applying = false;
    }
    const done = new Set(list.map((p) => p.id));
    result = { ...result, state: doc.state, problems: result.problems.map((p) => (done.has(p.id) ? { ...p, marked: true } : p)) };
    caption.textContent = `${list.length} marker${list.length === 1 ? '' : 's'} added.`;
    announce(caption.textContent);
    refresh();
  }

  // ------------------------------------------------------------- the list
  function show(p) {
    const doc = audioDoc();
    if (!doc || result?.docId !== doc.id) return;
    doc.setSelection(p.start, Math.max(p.end, p.start + 1));
    doc.setCursor?.(p.start);
    const span = doc.view.end - doc.view.start;
    const len = p.end - p.start;
    if (p.start < doc.view.start || p.end > doc.view.end || len < span / 400) {
      // Zoom so the problem is clearly visible with context on both sides.
      const want = p.kind === 'click' || p.kind === 'clip' ? Math.max(len * 40, doc.sampleRate * 0.05) : Math.max(len * 1.5, doc.sampleRate * 0.5);
      const mid = (p.start + p.end) / 2;
      doc.setView(mid - want / 2, mid + want / 2);
    }
  }

  function choose(i, e = {}) {
    const p = result?.problems[i];
    if (!p) return;
    if (e.shiftKey && selected.size) {
      const anchor = result.problems.findIndex((x) => selected.has(x.id));
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
      selected = new Set(result.problems.slice(a, b + 1).map((x) => x.id));
    } else if (e.ctrlKey || e.metaKey) {
      selected = new Set(selected);
      if (selected.has(p.id)) selected.delete(p.id);
      else selected.add(p.id);
    } else selected = new Set([p.id]);
    focusIndex = i;
    show(p);
    renderRows();
    body.children[i]?.focus();
  }

  function rowKeys(e, i) {
    const n = result?.problems.length || 0;
    if (e.key === 'ArrowDown') choose(Math.min(n - 1, i + 1), { shiftKey: e.shiftKey });
    else if (e.key === 'ArrowUp') choose(Math.max(0, i - 1), { shiftKey: e.shiftKey });
    else if (e.key === 'Home') choose(0);
    else if (e.key === 'End') choose(n - 1);
    else if (e.key === ' ') choose(i, { ctrlKey: true });
    else if (e.key === 'Enter') act(false);
    else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
      selected = new Set(result.problems.map((p) => p.id));
      renderRows();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  const chanLabel = (p, count) => (count === 1 ? 'Mono' : p.channels.length >= count ? 'All' : p.channels.map((c) => (count === 2 ? (c === 0 ? 'L' : 'R') : String(c + 1))).join(', '));

  function renderRows() {
    const doc = audioDoc();
    if (!result || !doc || result.docId !== doc.id) {
      body.replaceChildren(h('tr', h('td.empty-row', { colspan: '5' }, h('span.empty-text', doc ? 'Choose a diagnostic, then scan the selection or the whole file.' : 'Open an audio file to scan it for clicks, clipping and silence.'))));
      return;
    }
    if (!result.problems.length) {
      body.replaceChildren(h('tr', h('td.empty-row', { colspan: '5' }, h('span.empty-text', `No ${meta().noun}s found.`))));
      return;
    }
    const hadFocus = body.contains(document.activeElement);
    const rate = doc.sampleRate;
    const count = doc.channelCount;
    body.replaceChildren(
      ...result.problems.map((p, i) =>
        h(
          `tr${p.marked ? '.marked' : ''}`,
          { 'aria-selected': String(selected.has(p.id)), tabindex: i === focusIndex ? '0' : '-1', onclick: (e) => choose(i, e), onkeydown: (e) => rowKeys(e, i) },
          h('td.num', String(i + 1)),
          h('td.tabular', app.formatTime(p.start, rate)),
          h('td.tabular', p.kind === 'click' || p.kind === 'clip' ? `${p.end - p.start} smp` : app.formatTime(p.end - p.start, rate)),
          h('td', chanLabel(p, count)),
          h('td.num', p.marked ? `${fmtLevel(p)} (marked)` : fmtLevel(p)),
        ),
      ),
    );
    if (hadFocus) body.children[focusIndex]?.focus();
  }

  function refresh() {
    const doc = audioDoc();
    const busy = Boolean(abort);
    const m = meta();
    effectSel.disabled = busy;
    presetSel.disabled = busy;
    scanSelBtn.disabled = busy || !doc?.hasSelection;
    scanAllBtn.disabled = busy || !doc?.length;
    cancelBtn.hidden = !busy;
    const valid = Boolean(result && doc && result.docId === doc.id && result.effect === effectId);
    const n = valid ? result.problems.length : 0;
    renderGainNote();
    actSelBtn.textContent = `${m.action} Selected`;
    actAllBtn.textContent = `${m.action} All`;
    actSelBtn.disabled = busy || !valid || !selected.size;
    actAllBtn.disabled = busy || !valid || !n;
    // Mark Audio's own action already marks.
    markBtn.hidden = effectId === 'markAudio';
    markBtn.disabled = busy || !valid || !n;
    markBtn.textContent = selected.size ? 'Mark Selected' : 'Mark All';
    actions.querySelector('.diag-count').textContent = valid ? `${selected.size ? `${selected.size} of ` : ''}${n} ${m.noun}${n === 1 ? '' : 's'}` : '';
    if (!valid && result && doc && result.docId !== doc.id) caption.textContent = '';
    renderRows();
  }

  app.on('active', () => {
    selected = new Set();
    refresh();
  });
  app.on('doc-change', (doc, e) => {
    if (doc !== app.active) return;
    if (!applying && (e.kind === 'history' || e.kind === 'edit') && result && result.docId === doc.id && doc.state !== result.state) {
      result = null; // undo or redo: the list no longer matches the audio
      caption.textContent = 'The file changed. Scan again to update the list.';
    }
    if (e.kind === 'selection' || e.kind === 'edit' || e.kind === 'history') refresh();
  });
  buildSettings();
  refresh();

  return {
    el,
    show: refresh,
    focus: () => effectSel.focus(),
    /** Shows one diagnostic (Effects > Diagnostics opens the panel this way). */
    select: selectEffect,
  };
}

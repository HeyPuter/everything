// Small tool windows: undo history, tap tempo and purge unused.

import { h, announce } from '../lib/dom.js';
import { openDialog, confirmDialog } from '../ui/dialog.js';
import { openWindow } from '../ui/windows.js';
import * as E from '../model/edits.js';

// ------------------------------------------------------------------ undo history

/** History rows: the initial state, every undo step, then the redo steps (pure). */
export function historyEntries(store) {
  const rows = [{ index: 0, label: 'Opened project', state: store.undoStack.length === 0 ? 'current' : 'past' }];
  store.undoStack.forEach((s, i) => rows.push({ index: i + 1, label: s.label, state: i === store.undoStack.length - 1 ? 'current' : 'past' }));
  const n = store.undoStack.length;
  for (let j = store.redoStack.length - 1, k = 1; j >= 0; j--, k++) rows.push({ index: n + k, label: store.redoStack[j].label, state: 'future' });
  return rows;
}

export function openHistory(app) {
  const store = app.store;
  const list = h('div.history-list', { role: 'listbox', 'aria-label': 'Undo history', tabindex: '0' });
  let rows = [];
  const render = () => {
    rows = historyEntries(store);
    const current = rows.find((r) => r.state === 'current');
    list.replaceChildren(
      ...rows.map((r) =>
        h(
          `div.history-row.${r.state}`,
          { role: 'option', id: `hist-${r.index}`, 'aria-selected': String(r.state === 'current'), dataset: { index: String(r.index) } },
          h('span.history-label', r.label),
        ),
      ),
    );
    list.setAttribute('aria-activedescendant', `hist-${current.index}`);
    list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  };
  const jump = (index) => {
    store.jumpTo(index);
    const r = historyEntries(store).find((x) => x.state === 'current');
    announce(`Now at: ${r?.label}`);
  };
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.history-row');
    if (row) jump(Number(row.dataset.index));
  });
  list.addEventListener('keydown', (e) => {
    const cur = rows.findIndex((r) => r.state === 'current');
    const moves = { ArrowUp: -1, ArrowDown: 1, Home: -Infinity, End: Infinity };
    if (!(e.key in moves)) return;
    e.preventDefault();
    e.stopPropagation();
    const to = Math.max(0, Math.min(rows.length - 1, cur + moves[e.key]));
    if (to !== cur) jump(rows[to].index);
  });
  const offs = [store.on('change', render)];
  render();
  const win = openWindow({
    key: 'undo-history',
    title: 'Undo history',
    icon: 'history',
    width: 280,
    body: h('div.history', h('p.faint.history-note', 'Click a step to go back to it. Later steps stay available until you make a new change.'), list),
    onClose: () => offs.forEach((off) => off()),
  });
  requestAnimationFrame(() => list.focus());
  return win;
}

// ------------------------------------------------------------------ tap tempo

/** BPM from tap times in ms (the last taps within a 2 s gap), or null (pure). */
export function tapBpm(times) {
  const recent = [];
  for (let i = times.length - 1; i >= 0; i--) {
    if (recent.length && recent[0] - times[i] > 2000) break;
    recent.unshift(times[i]);
    if (recent.length >= 9) break;
  }
  if (recent.length < 2) return null;
  const avg = (recent.at(-1) - recent[0]) / (recent.length - 1);
  return Math.round((60000 / avg) * 10) / 10;
}

export async function openTapTempo(app) {
  const taps = [];
  const value = h('div.tap-value', { 'aria-live': 'polite' }, String(app.store.project.bpm));
  const unit = h('div.tap-unit.faint', 'Tap at least twice');
  let bpm = null;
  const tap = () => {
    const now = performance.now();
    if (taps.length && now - taps.at(-1) > 2000) taps.length = 0;
    taps.push(now);
    bpm = tapBpm(taps);
    pad.classList.remove('flash');
    void pad.offsetWidth;
    pad.classList.add('flash');
    if (bpm) {
      value.textContent = bpm.toFixed(1);
      unit.textContent = `BPM from ${Math.min(taps.length, 9)} taps`;
    }
    applyBtn().disabled = !bpm;
  };
  const pad = h('button.tap-pad', { type: 'button', onclick: tap, 'aria-label': 'Tap' }, 'Tap', h('span.faint', 'or press T'));
  const body = h('div.tap', pad, h('div.tap-readout', value, unit));
  const applyBtn = () => body.closest('.dialog')?.querySelector('.btn.primary') || { disabled: false };
  const done = openDialog({
    title: 'Tap tempo',
    className: 'dlg-tap',
    body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Apply tempo', value: 'apply', primary: true, disabled: true },
    ],
    onSubmit: () => Boolean(bpm),
    initialFocus: '.tap-pad',
  });
  // T taps anywhere in the dialog (the dialog is in the document once openDialog returns).
  body.closest('.dialog')?.addEventListener('keydown', (e) => {
    if ((e.key === 't' || e.key === 'T') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) {
      e.preventDefault();
      tap();
    }
  });
  const r = await done;
  if (r === 'apply' && bpm) {
    app.setTempo(bpm, 'Tap tempo');
    app.notify(`Tempo set to ${bpm} BPM`);
  }
}

// ------------------------------------------------------------------ purge unused

/**
 * Removes channels no pattern or audio clip uses, empty patterns not in the
 * playlist (one pattern always stays) and samples nothing refers to (pure).
 */
export function purgeUnused(project) {
  const used = new Set(project.patterns.flatMap((p) => Object.keys(p.notes).filter((k) => p.notes[k].length)));
  for (const c of project.clips) if (c.kind === 'audio') used.add(c.ref);
  const channels = project.channels.filter((c) => !used.has(c.id)).map((c) => c.id);
  let next = E.removeChannels(project, channels);
  const inPlaylist = new Set(next.clips.filter((c) => c.kind === 'pattern').map((c) => c.ref));
  const empty = next.patterns.filter((p) => !inPlaylist.has(p.id) && !Object.values(p.notes).some((l) => l.length)).map((p) => p.id);
  const keepOne = empty.length === next.patterns.length ? empty.slice(1) : empty;
  for (const id of keepOne) next = E.removePattern(next, id);
  const refs = new Set(next.channels.map((c) => c.sample).filter(Boolean));
  const samples = Object.keys(next.samples).filter((id) => !refs.has(id));
  if (samples.length) {
    const kept = { ...next.samples };
    for (const id of samples) delete kept[id];
    next = { ...next, samples: kept };
  }
  return { project: next, channels: channels.length, patterns: keepOne.length, samples: samples.length };
}

export async function purgeCommand(app) {
  const preview = purgeUnused(app.store.project);
  const parts = [];
  const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (preview.channels) parts.push(n(preview.channels, 'unused channel'));
  if (preview.patterns) parts.push(n(preview.patterns, 'empty pattern'));
  if (preview.samples) parts.push(n(preview.samples, 'unused sample'));
  if (!parts.length) {
    app.notify('Nothing to purge: every channel, pattern and sample is in use');
    return;
  }
  const ok = await confirmDialog({ title: 'Purge unused', message: `Remove ${parts.join(', ')}? You can undo this.`, confirm: 'Remove', danger: true });
  if (!ok) return;
  app.store.apply('Purge unused', (p) => purgeUnused(p).project);
  app.notify(`Removed ${parts.join(', ')}`);
}

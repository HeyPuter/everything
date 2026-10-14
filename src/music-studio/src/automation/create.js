// "Add automation clip": automates the last tweaked control (or one picked
// from a dialog) with a clip holding a flat line at the control's current
// value, placed on the first free playlist track at the playhead (one bar,
// or the loop region when one is set).

import { h } from '../lib/dom.js';
import * as E from '../model/edits.js';
import { ticksPerBar } from '../model/time.js';
import { openDialog } from '../ui/dialog.js';
import { flatLine } from './points.js';
import { resolveTarget, listTargets, sameTarget } from './targets.js';
import { firstFreeTrack, placeClip } from '../playlist/clips.js';

/** Asks which parameter to automate. Resolves a target or null. */
export async function chooseTarget(app) {
  const groups = listTargets(app.store.project);
  const select = h('select.select', { 'aria-label': 'Parameter to automate', style: { width: '100%' } });
  let n = 0;
  const targets = [];
  for (const g of groups) {
    const og = h('optgroup', { label: g.label });
    for (const it of g.items) {
      og.append(h('option', { value: String(n++) }, it.label));
      targets.push(it.target);
    }
    select.append(og);
  }
  const body = h(
    'div.field',
    { style: { minWidth: '320px' } },
    h('label', 'Parameter'),
    select,
    h('p.faint', { style: { margin: '6px 0 0', maxWidth: '360px' } }, 'Tip: move any knob first, then add an automation clip to automate it directly.'),
  );
  const r = await openDialog({
    title: 'Automate a parameter',
    body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Create clip', value: 'ok', primary: true },
    ],
    initialFocus: 'select',
  });
  return r === 'ok' ? targets[Number(select.value)] : null;
}

/**
 * Creates the automation and its clip in one undo step. `at` is the song
 * tick to place it at (defaults to the playhead). Resolves
 * { id, clipId, track } or null when cancelled.
 */
export async function addAutomationClip(app, { target, at } = {}) {
  const { store, engine } = app;
  let tgt = target ?? app.lastTweaked?.target ?? null;
  let info = tgt ? resolveTarget(store.project, tgt) : null;
  if (!info) {
    tgt = await chooseTarget(app);
    if (!tgt) return null;
    info = resolveTarget(store.project, tgt);
    if (!info) return null;
  }
  const p = store.project;
  const bar = ticksPerBar(p.sig);
  const pos = at ?? (engine.mode === 'song' ? engine.position : 0);
  const start = p.loop ? p.loop.start : Math.floor(pos / bar) * bar;
  const len = p.loop ? p.loop.end - p.loop.start : bar;
  const tweaked = app.lastTweaked && sameTarget(app.lastTweaked.target, tgt) ? app.lastTweaked.label : '';
  const name = (tweaked || info.label).replace(/^./, (c) => c.toUpperCase()).slice(0, 60);
  return store.apply('Add automation clip', (proj) => {
    const a = E.addAutomation(proj, { name, target: tgt, points: flatLine(info.norm, len) });
    const track = firstFreeTrack(a.project, start, start + len);
    const c = placeClip(a.project, { kind: 'auto', id: a.id }, track, start, len);
    return { project: c.project, id: a.id, clipId: c.id, track };
  });
}

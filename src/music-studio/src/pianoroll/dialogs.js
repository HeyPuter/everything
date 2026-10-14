// Piano roll dialogs: quantize, chords (chordize and the chord stamp), riff
// generator, transpose, and the note properties popover (double-click a note
// or press Enter with one note selected). Each applies its change as one undo
// step through the editor (pianoroll/editor.js).

import { h, announce } from '../lib/dom.js';
import { clamp, keyName } from '../lib/util.js';
import { openDialog, promptDialog } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { SNAPS, STEP, PPQ, formatBST, ticksPerBar, snapTicks } from '../model/time.js';
import { CHORDS, SCALES, ROOT_NAMES, scaleLabel, chordById } from './scales.js';
import { RIFF_STYLES, generateRiff } from './riff.js';
import * as N from './notes.js';
import { shared } from './state.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const select = (options, value, attrs = {}) => {
  const el = h('select.select', attrs);
  for (const [v, label] of options) el.append(h('option', { value: String(v), selected: String(v) === String(value) }, label));
  return el;
};

const row = (label, control, id) => {
  control.id = id;
  return [h('label', { for: id }, label), control];
};

function scopeText(ed) {
  const sel = ed.selIds().length;
  return sel ? `Applies to the ${plural(sel, 'selected note')}.` : `Applies to all ${plural(ed.notes.length, 'note')} of ${ed.channel?.name || 'this channel'} in ${ed.pattern?.name || 'this pattern'}.`;
}

// ------------------------------------------------------------------ quantize

export async function quantizeDialog(ed) {
  if (!ed.channel) return;
  if (!ed.notes.length) {
    ed.app.notify('There are no notes to quantize in this pattern');
    return;
  }
  const saved = ed.prefs.quantize || {};
  const choices = SNAPS.filter((s) => s.ticks !== null && s.ticks > 0);
  const current = choices.find((s) => s.id === ed.snapId) ? ed.snapId : saved.grid || 'step';
  const grid = select(choices.map((s) => [s.id, s.label]), current);
  const strength = h('input#pr-q-strength', { type: 'range', min: '0', max: '100', step: '5', value: String(saved.strength ?? 100), 'aria-describedby': 'pr-q-strength-out' });
  const out = h('output#pr-q-strength-out.pr-out', `${strength.value}%`);
  strength.addEventListener('input', () => (out.textContent = `${strength.value}%`));
  const starts = h('input', { type: 'checkbox', checked: saved.starts ?? true });
  const ends = h('input', { type: 'checkbox', checked: saved.ends ?? false });
  const body = h(
    'div.pr-dialog',
    h('div.form-grid', ...row('Grid', grid, 'pr-q-grid'), h('label', { for: 'pr-q-strength' }, 'Strength'), h('div.pr-range', strength, out), h('span', 'Move'), h('div.pr-checks', h('label.check', starts, 'Note starts'), h('label.check', ends, 'Note ends'))),
    h('p.pr-note', scopeText(ed)),
  );
  const r = await openDialog({ title: 'Quantize', body, buttons: [{ label: 'Cancel', value: null }, { label: 'Quantize', value: 'ok', primary: true }] });
  if (r !== 'ok') return;
  const opts = { grid: snapTicks(grid.value, 1, ed.sig), strength: Number(strength.value) / 100, starts: starts.checked, ends: ends.checked };
  ed.setPref({ quantize: { grid: grid.value, strength: Number(strength.value), starts: starts.checked, ends: ends.checked } });
  if (!opts.starts && !opts.ends) return;
  ed.runTool('Quantize', (list, ids) => N.quantizeNotes(list, ids, opts), `Quantized ${ed.selIds().length ? plural(ed.selIds().length, 'note') : 'all notes'} to ${grid.selectedOptions[0].textContent.toLowerCase()}`);
}

// ------------------------------------------------------------------ chords

const INVERSIONS = [
  [0, 'Root position'],
  [1, 'First inversion'],
  [2, 'Second inversion'],
  [3, 'Third inversion'],
];

export async function chordsDialog(ed) {
  if (!ed.channel) return;
  const stamp = shared.stamp;
  const saved = ed.prefs.chord || {};
  const chord = select(CHORDS.map((c) => [c.id, c.label]), stamp?.chord || saved.chord || (ed.prefs.scale ? 'scaleTriad' : 'major'));
  const inversion = select(INVERSIONS, stamp?.inversion ?? saved.inversion ?? 0);
  const p = ed.prefs;
  const hasSel = ed.selIds().length > 0;
  const body = h(
    'div.pr-dialog',
    h('div.form-grid', ...row('Chord', chord, 'pr-c-chord'), ...row('Voicing', inversion, 'pr-c-inv')),
    h('p.pr-note', `"In scale" chords stack thirds inside the scale highlight (${p.scale ? scaleLabel(p.scaleRoot, p.scale) : 'none set, so they use major chords'}).`),
    h('p.pr-note', hasSel ? `Chordize turns each of the ${plural(ed.selIds().length, 'selected note')} into a chord on its pitch.` : 'Select notes to chordize them, or use the chord as a stamp: the draw and paint tools then place whole chords.'),
  );
  const buttons = [];
  if (stamp) buttons.push({ label: 'Stamp off', value: 'off' });
  buttons.push({ label: 'Cancel', value: null }, { label: 'Use as stamp', value: 'stamp', primary: !hasSel });
  if (hasSel) buttons.push({ label: 'Chordize selection', value: 'chordize', primary: true });
  const r = await openDialog({ title: 'Chords', body, buttons });
  if (!r) return;
  const settings = { chord: chord.value, inversion: Number(inversion.value) };
  ed.setPref({ chord: settings });
  if (r === 'off') {
    shared.stamp = null;
    announce('Chord stamp off');
  } else if (r === 'stamp') {
    shared.stamp = settings;
    if (ed.tool !== 'draw' && ed.tool !== 'paint') ed.setTool('draw');
    ed.app.notify(`Chord stamp: ${chordById(settings.chord).label.toLowerCase()}. The draw tool now places chords.`);
  } else if (r === 'chordize') {
    const ids = new Set(ed.selIds());
    const res = ed.applyNotes('Chordize', (list) => N.chordize(list, ids, settings.chord, { inversion: settings.inversion, scaleRoot: p.scaleRoot, scaleId: p.scale }));
    if (res?.ids) ed.select(res.ids);
    announce(`${plural(ids.size, 'note')} turned into chords`);
  }
  ed.toolbar?.sync();
  ed.dirty = true;
}

// ------------------------------------------------------------------ riff

export async function riffDialog(ed) {
  if (!ed.channel) return;
  const p = ed.prefs;
  const saved = p.riff || {};
  const bar = ticksPerBar(ed.sig);
  const style = select(RIFF_STYLES.map((s) => [s.id, s.label]), saved.style || 'melody');
  const root = select(ROOT_NAMES.map((n, i) => [i, n]), p.scale ? p.scaleRoot : saved.root ?? 9);
  const scale = select(SCALES.filter((s) => s.id !== 'chromatic').map((s) => [s.id, s.label]), p.scale && p.scale !== 'chromatic' ? p.scale : saved.scale || 'minor');
  const octaves = [];
  for (let o = 2; o <= 8; o++) octaves.push([o * 12, `C${o}`]);
  const low = select(octaves, saved.low ?? 60);
  const range = select([[1, '1 octave'], [2, '2 octaves'], [3, '3 octaves']], saved.range ?? 1);
  const bars = select([[1, '1 bar'], [2, '2 bars'], [4, '4 bars'], [8, '8 bars']], saved.bars ?? Math.min(4, Math.max(1, Math.round(ed.patLen / bar))));
  const unit = select([[STEP / 2, '1/2 step'], [STEP, 'Step'], [PPQ / 2, '1/2 beat'], [PPQ, 'Beat']], saved.unit ?? STEP);
  const density = h('input#pr-r-density', { type: 'range', min: '0', max: '100', step: '5', value: String(saved.density ?? 50) });
  const densityOut = h('output.pr-out', `${density.value}%`);
  density.addEventListener('input', () => (densityOut.textContent = `${density.value}%`));
  const seed = h('input#pr-r-seed.input', { type: 'number', min: '1', max: '999999', value: String(Math.floor(Math.random() * 99999) + 1), style: { width: '110px' } });
  const reroll = h('button.icon-btn', { type: 'button', 'aria-label': 'New random seed', title: 'New random seed', onclick: () => (seed.value = String(Math.floor(Math.random() * 99999) + 1)) }, icon('dices', 16));
  const cursorBar = Math.floor(ed.cursor.tick / bar);
  const at = select([[0, 'Pattern start'], ...(cursorBar > 0 ? [[cursorBar, `Cursor (bar ${cursorBar + 1})`]] : [])], 0);
  const replace = h('input', { type: 'checkbox', checked: saved.replace ?? ed.notes.length === 0 });
  style.addEventListener('change', () => {
    if (style.value === 'bass' && Number(low.value) >= 60) low.value = '36';
    else if (style.value !== 'bass' && Number(low.value) < 48) low.value = '60';
  });
  const body = h(
    'div.pr-dialog',
    h(
      'div.form-grid',
      ...row('Style', style, 'pr-r-style'),
      h('label', { for: 'pr-r-root' }, 'Key'),
      h('div.pr-pair', Object.assign(root, { id: 'pr-r-root' }), Object.assign(scale, { 'aria-label': 'Scale' })),
      h('label', { for: 'pr-r-low' }, 'Lowest note'),
      h('div.pr-pair', Object.assign(low, { id: 'pr-r-low' }), Object.assign(range, { 'aria-label': 'Range' })),
      ...row('Length', bars, 'pr-r-bars'),
      ...row('Rhythm grid', unit, 'pr-r-unit'),
      h('label', { for: 'pr-r-density' }, 'Density'),
      h('div.pr-range', density, densityOut),
      h('label', { for: 'pr-r-seed' }, 'Seed'),
      h('div.pr-pair', seed, reroll),
      ...row('Start at', at, 'pr-r-at'),
      h('span'),
      h('label.check', replace, 'Replace the notes in that range'),
    ),
    h('p.pr-note', `Writes into ${ed.channel.name}. The same seed always gives the same riff; undo removes it.`),
  );
  const r = await openDialog({ title: 'Riff generator', body, buttons: [{ label: 'Cancel', value: null }, { label: 'Generate', value: 'ok', primary: true }] });
  if (r !== 'ok') return;
  const opts = {
    seed: clamp(Math.round(Number(seed.value) || 1), 1, 999999),
    style: style.value,
    root: Number(root.value),
    scale: scale.value,
    low: Number(low.value),
    range: Number(range.value),
    bars: Number(bars.value),
    density: Number(density.value) / 100,
    unit: Number(unit.value),
    sig: ed.sig,
    start: Number(at.value) * bar,
  };
  ed.setPref({ riff: { style: opts.style, root: opts.root, scale: opts.scale, low: opts.low, range: opts.range, bars: opts.bars, density: Number(density.value), unit: opts.unit, replace: replace.checked } });
  const made = generateRiff(opts);
  const end = opts.start + opts.bars * bar;
  ed.applyNotes('Generate riff', (list) => {
    const kept = replace.checked ? list.filter((n) => n.pos + n.len <= opts.start || n.pos >= end) : list;
    return [...kept, ...made];
  });
  ed.select(made.map((n) => n.id));
  ed.revealTick(opts.start);
  ed.revealNotes();
  announce(`${plural(made.length, 'note')} generated: ${RIFF_STYLES.find((s) => s.id === opts.style).label.toLowerCase()} in ${scaleLabel(opts.root, opts.scale)}`);
}

// ------------------------------------------------------------------ transpose

export async function transposeDialog(ed) {
  if (!ed.notes.length) {
    ed.app.notify('There are no notes to transpose');
    return;
  }
  const v = await promptDialog({
    title: 'Transpose notes',
    label: `Semitones (negative moves down). ${scopeText(ed)}`,
    value: '12',
    confirm: 'Transpose',
    validate: (s) => (Number.isInteger(Number(s)) && Math.abs(Number(s)) <= 96 ? '' : 'Enter a whole number between -96 and 96.'),
  });
  if (v === null) return;
  const st = Number(v);
  ed.runTool('Transpose', (list, ids) => N.transposeNotes(list, ids, st), `Transposed ${st > 0 ? 'up' : 'down'} ${plural(Math.abs(st), 'semitone')}`);
}

// ------------------------------------------------------------------ note properties

let popover = null;

export function closeNoteProps() {
  if (!popover) return false;
  popover.close();
  return true;
}

/** "C#5" or "61" to a MIDI key (null when invalid). */
export function parseKey(text) {
  const s = String(text).trim();
  if (/^\d+$/.test(s)) {
    const k = Number(s);
    return k >= 0 && k <= 127 ? k : null;
  }
  const m = s.match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
  const k = base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + Number(m[3]) * 12;
  return k >= 0 && k <= 127 ? k : null;
}

/** "bar:step:tick" (1-based bar and step) to ticks (null when invalid). */
export function parseBST(text, sig = [4, 4]) {
  const parts = String(text).trim().split(/[:.]/).map((x) => Number(x));
  if (!parts.length || parts.some((x) => !Number.isFinite(x))) return null;
  const [b = 1, s = 1, t = 0] = parts;
  if (b < 1 || s < 1 || t < 0) return null;
  return (b - 1) * ticksPerBar(sig) + (s - 1) * STEP + t;
}

export function openNoteProps(ed, note) {
  if (!note) return;
  closeNoteProps();
  const sig = ed.sig;
  const id = note.id;
  const field = (label, input, hint) => h('label.pr-pop-field', h('span', label), input, hint ? h('span.pr-pop-hint', hint) : null);
  const key = h('input.input.sm', { type: 'text', value: keyName(note.key), 'aria-label': 'Pitch', spellcheck: false });
  const pos = h('input.input.sm', { type: 'text', value: formatBST(note.pos, sig), 'aria-label': 'Start (bar:step:tick)', spellcheck: false });
  const len = h('input.input.sm', { type: 'number', min: '0.04', step: '0.25', value: String(Math.round((note.len / STEP) * 1000) / 1000), 'aria-label': 'Length in steps' });
  const vel = h('input.input.sm', { type: 'number', min: '1', max: '100', step: '1', value: String(Math.round(note.vel * 100)), 'aria-label': 'Velocity in percent' });
  const pan = h('input.input.sm', { type: 'number', min: '-100', max: '100', step: '1', value: String(Math.round((note.pan ?? 0) * 100)), 'aria-label': 'Pan in percent, negative is left' });
  const error = h('div.pr-pop-error', { role: 'alert' });
  const closeBtn = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Close note properties', title: 'Close (Escape)' }, icon('x', 14));
  const el = h(
    'div.pr-popover',
    { role: 'dialog', 'aria-label': 'Note properties' },
    h('div.pr-pop-head', h('span', 'Note'), closeBtn),
    h('div.pr-pop-grid', field('Pitch', key), field('Start', pos, 'bar:step:tick'), field('Length', len, 'steps'), field('Velocity', vel, '%'), field('Pan', pan, '%')),
    error,
  );
  const apply = () => {
    const current = ed.noteById(id);
    if (!current) {
      close();
      return;
    }
    const k = parseKey(key.value);
    const p = parseBST(pos.value, sig);
    const l = Math.round(Number(len.value) * STEP);
    const v = Number(vel.value);
    const pn = Number(pan.value);
    if (k === null) return (error.textContent = 'Pitch: enter a note such as C5 or F#4.');
    if (p === null) return (error.textContent = 'Start: use bar:step:tick, for example 2:01:00.');
    if (!(l >= 1)) return (error.textContent = 'Length: enter a positive number of steps.');
    if (!(v >= 1 && v <= 100)) return (error.textContent = 'Velocity: 1 to 100.');
    if (!(pn >= -100 && pn <= 100)) return (error.textContent = 'Pan: -100 (left) to 100 (right).');
    error.textContent = '';
    const changes = { key: k, pos: p, len: l, vel: Math.round(v) / 100, pan: Math.round(pn) / 100 };
    if (Object.keys(changes).every((f) => current[f] === changes[f] || (f === 'pan' && (current.pan ?? 0) === changes.pan))) return;
    ed.applyNotes('Edit note', (list) => N.patchNotes(list, { [id]: changes }));
    ed.remember({ len: l, vel: changes.vel });
    if (k !== current.key) ed.audition(k, changes.vel, { hold: false });
    announce(`${keyName(k)} updated`);
  };
  for (const input of [key, pos, len, vel, pan]) {
    input.addEventListener('change', apply);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        apply();
      }
    });
  }
  const outside = (e) => {
    if (!el.contains(e.target)) close(false);
  };
  const close = (refocus = true) => {
    if (!popover || popover.el !== el) return;
    popover = null;
    el.remove();
    document.removeEventListener('pointerdown', outside, true);
    if (refocus) ed.surface.focus({ preventScroll: true });
  };
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
    e.stopPropagation(); // keep shortcuts (Delete, letters) out of the form
  });
  closeBtn.addEventListener('click', () => close());
  ed.root.append(el);
  // Place next to the note, inside the editor.
  const L = ed.L;
  const x = L.gridX + ed.vp.x(note.pos);
  const y = L.gridY + (127 - note.key) * ed.keyH - ed.scrollY;
  const rw = ed.root.clientWidth;
  const rh = ed.root.clientHeight;
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  let left = x;
  let top = y + ed.keyH + 6;
  if (top + ht > rh - 8) top = Math.max(8, y - ht - 6);
  left = clamp(left, 8, Math.max(8, rw - w - 8));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  popover = { el, close };
  key.focus();
  key.select();
}

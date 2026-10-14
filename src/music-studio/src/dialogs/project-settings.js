// Project settings: name, tempo, time signature, swing and master pitch,
// applied as one undo step, plus read-only project information.

import { h } from '../lib/dom.js';
import { clamp } from '../lib/util.js';
import { openDialog } from '../ui/dialog.js';
import { songLength } from '../model/project.js';
import { ticksPerBar, formatTime } from '../model/time.js';
import { tempoMap } from '../engine/compile.js';

export const BEAT_UNITS = [1, 2, 4, 8, 16];

/** Validated settings applied to a project (pure). Returns the same project when nothing changed. */
export function applyProjectSettings(project, values) {
  const next = {};
  if (typeof values.name === 'string' && values.name.trim() && values.name.trim() !== project.name) next.name = values.name.trim().slice(0, 120);
  if (Number.isFinite(values.bpm)) {
    const bpm = clamp(Math.round(values.bpm * 1000) / 1000, 10, 522);
    if (bpm !== project.bpm) next.bpm = bpm;
  }
  if (Array.isArray(values.sig)) {
    const num = clamp(Math.round(values.sig[0]) || 4, 1, 16);
    const den = BEAT_UNITS.includes(values.sig[1]) ? values.sig[1] : 4;
    if (num !== project.sig[0] || den !== project.sig[1]) next.sig = [num, den];
  }
  if (Number.isFinite(values.swing)) {
    const swing = clamp(values.swing, 0, 1);
    if (swing !== project.swing) next.swing = swing;
  }
  if (Number.isFinite(values.masterPitch)) {
    const mp = clamp(Math.round(values.masterPitch), -1200, 1200);
    if (mp !== project.masterPitch) next.masterPitch = mp;
  }
  return Object.keys(next).length ? { ...project, ...next } : project;
}

/** Counts and length shown under "Project". */
export function projectInfo(project) {
  const notes = project.patterns.reduce((s, p) => s + Object.values(p.notes).reduce((a, l) => a + l.length, 0), 0);
  const len = songLength(project);
  const bars = len ? Math.ceil(len / ticksPerBar(project.sig)) : 0;
  return {
    channels: project.channels.length,
    patterns: project.patterns.length,
    notes,
    clips: project.clips.length,
    samples: Object.keys(project.samples).length,
    automation: Object.keys(project.automation).length,
    bars,
    duration: formatTime(len, tempoMap(project)).replace(/:\d\d$/, ''),
  };
}

export async function openProjectSettings(app) {
  const p = app.store.project;
  const field = (label, control, hint) => {
    const id = `ps-${Math.random().toString(36).slice(2, 8)}`;
    control.id = id;
    return [h('label', { for: id }, label), hint ? h('div.ps-control', control, h('span.faint', hint)) : control];
  };
  const name = h('input.input', { type: 'text', value: p.name, maxLength: 120, autocomplete: 'off', spellcheck: false });
  const bpm = h('input.input.num', { type: 'number', value: String(p.bpm), min: '10', max: '522', step: '0.01', inputMode: 'decimal' });
  const num = h('input.input.num', { type: 'number', value: String(p.sig[0]), min: '1', max: '16', step: '1', 'aria-label': 'Beats per bar' });
  const den = h('select.select', { 'aria-label': 'Beat unit' }, BEAT_UNITS.map((u) => h('option', { value: String(u), selected: u === p.sig[1] }, String(u))));
  const swingOut = h('output.ps-out');
  const swing = h('input', { type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(p.swing * 100)) });
  const syncSwing = () => {
    swingOut.textContent = `${swing.value}%`;
    swing.setAttribute('aria-valuetext', `${swing.value}%`);
  };
  swing.addEventListener('input', syncSwing);
  syncSwing();
  const pitch = h('input.input.num', { type: 'number', value: String(p.masterPitch), min: '-1200', max: '1200', step: '1' });
  const error = h('div.ps-error', { role: 'alert' });
  const info = projectInfo(p);
  const stat = (label, value) => h('div.ps-stat', h('span.faint', label), h('strong', String(value)));

  const body = h(
    'div.project-settings',
    h(
      'div.form-grid',
      ...field('Name', name),
      ...field('Tempo', bpm, 'BPM'),
      h('label', { for: 'ps-sig' }, 'Time signature'),
      h('div.ps-sig', { id: 'ps-sig', role: 'group', 'aria-label': 'Time signature' }, num, h('span.faint', '/'), den),
      ...field('Swing', h('div.ps-range', swing, swingOut)),
      ...field('Master pitch', pitch, 'cents'),
    ),
    error,
    h('h3.dlg-section', 'Project'),
    h(
      'div.ps-stats',
      stat('Channels', info.channels),
      stat('Patterns', info.patterns),
      stat('Notes', info.notes),
      stat('Playlist clips', info.clips),
      stat('Samples', info.samples),
      stat('Automation', info.automation),
      stat('Song length', info.bars ? `${info.bars} bar${info.bars === 1 ? '' : 's'} (${info.duration})` : 'Empty'),
    ),
  );
  // Swing's range input is inside a wrapper; label it directly.
  swing.setAttribute('aria-label', 'Swing');

  const read = () => ({
    name: name.value,
    bpm: Number(bpm.value),
    sig: [Number(num.value), Number(den.value)],
    swing: Number(swing.value) / 100,
    masterPitch: Number(pitch.value),
  });
  const r = await openDialog({
    title: 'Project settings',
    className: 'dlg-project',
    body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Apply', value: 'apply', primary: true },
    ],
    onSubmit: () => {
      const v = read();
      const msg = !v.name.trim() ? 'Enter a project name.' : !(v.bpm >= 10 && v.bpm <= 522) ? 'Tempo must be between 10 and 522 BPM.' : !(v.sig[0] >= 1 && v.sig[0] <= 16) ? 'Beats per bar must be between 1 and 16.' : !(Math.abs(v.masterPitch) <= 1200) ? 'Master pitch must be within 1200 cents.' : '';
      error.textContent = msg;
      return !msg;
    },
  });
  if (r !== 'apply') return false;
  const values = read();
  app.store.apply('Project settings', (proj) => applyProjectSettings(proj, values));
  return true;
}

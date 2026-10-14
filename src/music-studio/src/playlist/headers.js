// Playlist track headers: one list item per track with a color strip, the
// name (a button: click selects the track, double-click or F2 renames), a
// mute LED and a solo button, plus a bottom-edge handle that resizes the
// track. The list scrolls vertically with the clip canvas (transform only).

import { h, announce } from '../lib/dom.js';
import { clamp } from '../lib/util.js';
import * as E from '../model/edits.js';
import { soloTrack, MIN_TRACK_H, MAX_TRACK_H } from './clips.js';
import { DEFAULT_TRACK_H } from './constants.js';
import { isContextKey } from '../ui/menu.js';

export function createHeaders(V) {
  const { store } = V;
  const list = h('ol.pl-track-list', { role: 'list', 'aria-label': 'Playlist tracks' });
  const el = h('div.pl-headers', list);
  let rows = [];
  let renaming = -1;

  el.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      V.scrollBy(e.deltaX, e.deltaY);
    },
    { passive: false },
  );

  function row(i) {
    const strip = h('span.pl-track-color', { 'aria-hidden': 'true' });
    const num = h('span.pl-track-num', { 'aria-hidden': 'true' });
    const label = h('span.pl-track-label');
    const name = h('button.pl-track-name', { type: 'button' }, num, label);
    const mute = h('button.pl-led', { type: 'button' });
    const solo = h('button.pl-solo', { type: 'button' }, 'S');
    const grip = h('div.pl-track-resize', { 'aria-hidden': 'true' });
    const li = h('li.pl-track', { dataset: { index: String(i) } }, strip, name, mute, solo, grip);
    name.addEventListener('click', () => V.selectTrack(i, { announce: false }));
    name.addEventListener('dblclick', () => startRename(i));
    name.addEventListener('keydown', (e) => {
      if (e.key === 'F2') {
        e.preventDefault();
        e.stopPropagation();
        startRename(i);
      } else if (isContextKey(e)) {
        e.preventDefault();
        const r = name.getBoundingClientRect();
        V.trackMenu(i, { x: r.left + 12, y: r.bottom });
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const j = clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, store.project.tracks.length - 1);
        if (e.altKey && j !== i) {
          store.apply('Move track', (p) => E.moveTrack(p, i, j));
          V.selectTrack(j);
        } else V.selectTrack(j, { announce: false });
        focusTrack(j);
      }
    });
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      V.selectTrack(i, { announce: false });
      V.trackMenu(i, { x: e.clientX, y: e.clientY });
    });
    mute.addEventListener('click', () => {
      const t = store.project.tracks[i];
      store.apply(t.mute ? 'Unmute track' : 'Mute track', (p) => E.updateTrack(p, i, { mute: !t.mute }));
      announce(`${t.name} ${t.mute ? 'unmuted' : 'muted'}`);
    });
    solo.addEventListener('click', () => {
      store.apply('Solo track', (p) => soloTrack(p, i));
      const t = store.project.tracks[i];
      announce(`${t.name} ${t.solo ? 'soloed' : 'solo off'}`);
    });
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        grip.setPointerCapture(e.pointerId);
      } catch {
        // The pointer may already be gone.
      }
      const y0 = e.clientY;
      const h0 = store.project.tracks[i].height || DEFAULT_TRACK_H;
      store.begin('Resize track');
      grip.classList.add('dragging');
      const move = (ev) => {
        const hh = Math.round(clamp(h0 + ev.clientY - y0, MIN_TRACK_H, MAX_TRACK_H));
        store.preview((p) => (ev.altKey ? { ...p, tracks: p.tracks.map((t) => (t.height === hh ? t : { ...t, height: hh })) } : E.updateTrack(p, i, { height: hh })));
      };
      const up = () => {
        grip.classList.remove('dragging');
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        store.commit();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
    return { li, strip, num, label, name, mute, solo, track: null, selected: null };
  }

  function sync(r, i, t) {
    const sel = i === V.selectedTrack;
    if (r.track === t && r.selected === sel) return;
    r.track = t;
    r.selected = sel;
    r.li.style.height = `${t.height || DEFAULT_TRACK_H}px`;
    r.li.classList.toggle('selected', sel);
    r.li.classList.toggle('muted', t.mute);
    r.li.classList.toggle('short', (t.height || DEFAULT_TRACK_H) < 40);
    r.strip.style.background = t.color || '';
    r.strip.classList.toggle('none', !t.color);
    r.num.textContent = String(i + 1);
    r.label.textContent = t.name;
    r.name.setAttribute('aria-label', `Track ${i + 1}: ${t.name}${t.mute ? ', muted' : ''}${t.solo ? ', solo' : ''}`);
    r.name.setAttribute('aria-current', sel ? 'true' : 'false');
    r.name.title = `${t.name}: click to select, double-click to rename, right-click for options`;
    r.mute.setAttribute('aria-pressed', String(t.mute));
    r.mute.setAttribute('aria-label', `Mute ${t.name}`);
    r.mute.title = t.mute ? 'Unmute track' : 'Mute track';
    r.solo.setAttribute('aria-pressed', String(Boolean(t.solo)));
    r.solo.setAttribute('aria-label', `Solo ${t.name}`);
    r.solo.title = t.solo ? 'Clear solo' : 'Solo track';
  }

  function render() {
    const tracks = store.project.tracks;
    const active = document.activeElement;
    const focusIndex = list.contains(active) ? Number(active.closest('.pl-track')?.dataset.index) : -1;
    const focusPart = active?.className?.split?.(' ')[0];
    while (rows.length < tracks.length) {
      const r = row(rows.length);
      rows.push(r);
      list.append(r.li);
    }
    while (rows.length > tracks.length) rows.pop().li.remove();
    tracks.forEach((t, i) => {
      if (i !== renaming) sync(rows[i], i, t);
    });
    if (focusIndex >= 0 && rows[focusIndex] && !list.contains(document.activeElement)) rows[focusIndex].li.querySelector(`.${focusPart}`)?.focus();
    syncScroll();
  }

  function syncScroll() {
    list.style.transform = `translateY(${-V.scrollY}px)`;
  }

  function focusTrack(i) {
    rows[i]?.name.focus({ preventScroll: true });
    V.revealTrack(i);
  }

  function startRename(i) {
    const r = rows[i];
    const t = store.project.tracks[i];
    if (!r || !t) return;
    renaming = i;
    const input = h('input.input.sm.pl-track-input', { type: 'text', value: t.name, 'aria-label': `Rename track ${i + 1}`, maxlength: '60' });
    r.name.hidden = true;
    r.name.after(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      renaming = -1;
      input.remove();
      r.name.hidden = false;
      const v = input.value.trim();
      r.track = null;
      if (ok && v && v !== t.name) store.apply('Rename track', (p) => E.updateTrack(p, i, { name: v.slice(0, 60) }));
      else sync(r, i, store.project.tracks[i]);
      r.name.focus({ preventScroll: true });
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  return { el, render, syncScroll, focusTrack, startRename };
}

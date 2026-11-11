/**
 * Several clips selected: a summary plus the properties every selected
 * clip that has them can share (opacity, volume), and Delete.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { sliderField } from '../controls.js';
import { createScope, propSection } from './common.js';
import { DB_MIN, DB_MAX, gainToDb, dbToGain } from './audio.js';

const TYPE_NAMES = { video: 'video', image: 'image', audio: 'audio', text: 'text', sticker: 'graphic', effect: 'effect', filter: 'filter', adjust: 'color layer' };

export function multiView(ctx) {
  const { store, actions } = ctx;
  const scope = createScope();
  // One pass over the tracks, in selection order: a search per id is quadratic with thousands selected.
  const clips = () => {
    const sel = store.selection;
    const found = new Map();
    for (const t of store.project.tracks) for (const c of t.clips) if (sel.has(c.id)) found.set(c.id, c);
    const out = [];
    for (const id of sel) if (found.has(id)) out.push(found.get(id));
    return out;
  };
  /** The first selected clip that passes test. */
  const first = (test) => clips().find(test) || null;
  const list = clips();
  const counts = {};
  for (const c of list) counts[c.type] = (counts[c.type] || 0) + 1;
  const breakdown = Object.entries(counts).map(([t, n]) => `${n} ${TYPE_NAMES[t] || t}`).join(', ');

  const fields = [];
  const withOpacity = list.filter((c) => 'opacity' in c);
  if (withOpacity.length) {
    const f = sliderField({
      label: 'Opacity',
      min: 0,
      max: 100,
      value: Math.round(withOpacity[0].opacity * 100),
      onInput: (v, final) => {
        actions.editSelected('Opacity', (c) => {
          if (!('opacity' in c)) return false;
          c.opacity = v / 100;
          if (c.keyframes) delete c.keyframes.opacity;
        }, { coalesce: 'multi-opacity' });
        if (final) store.seal();
      },
    });
    f.el.querySelector('.num-input')?.after(h('span.num-unit', { 'aria-hidden': 'true' }, '%'));
    scope.bind(() => {
      const c = first((x) => 'opacity' in x);
      if (c) f.set(Math.round(c.opacity * 100));
    });
    fields.push(f.el);
  }
  const withVolume = list.filter((c) => 'volume' in c);
  if (withVolume.length) {
    const f = sliderField({
      label: 'Volume',
      min: DB_MIN,
      max: DB_MAX,
      step: 0.1,
      value: gainToDb(withVolume[0].volume),
      onInput: (v, final) => {
        actions.editSelected('Volume', (c) => {
          if (!('volume' in c)) return false;
          c.volume = dbToGain(v);
          if (c.keyframes) delete c.keyframes.volume;
        }, { coalesce: 'multi-volume' });
        if (final) store.seal();
      },
    });
    f.el.querySelector('.num-input')?.after(h('span.num-unit', { 'aria-hidden': 'true' }, 'dB'));
    scope.bind(() => {
      const c = first((x) => 'volume' in x);
      if (c) f.set(gainToDb(c.volume));
    });
    fields.push(f.el);
  }
  const del = h('button.btn.small.danger', { type: 'button' }, icon('trash', 14), `Delete ${list.length} clips`);
  del.addEventListener('click', () => actions.deleteSelected());

  const el = h('div.multi-view',
    h('div.multi-summary', icon('layers', 20), h('div', h('p.multi-count', `${list.length} clips selected`), h('p.muted', breakdown))),
    fields.length ? propSection('Shared settings', [...fields, h('p.insp-empty', 'Changes apply to every selected clip and replace their keyframes for that setting.')]) : null,
    h('div.insp-actions', del),
  );
  return { el, scope };
}

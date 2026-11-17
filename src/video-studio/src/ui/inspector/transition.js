/**
 * Transition details: shown when a cut's transition is selected on the
 * timeline (store.transition is the id of the clip before the cut).
 */
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { US } from '../../lib/time.js';
import { TRANSITIONS, TRANSITION_CATEGORIES } from '../../model/catalog.js';
import { maxTransition } from '../../model/timeline.js';
import { lookPreview, hoverAnimate } from '../panels/previews.js';
import { slider, propSection, choiceGrid } from './common.js';

const MIN = 100_000;
export const transitionLabel = (id) => TRANSITIONS.find((t) => t.id === id)?.label || 'Transition';

export function transitionView(view) {
  const { actions, store } = view;
  const name = h('span.tr-name');
  const range = h('span.tr-range');
  const header = h('div.tr-summary', icon('transition', 16), h('div.tr-text', name, range));

  const dur = slider(view, {
    label: 'Duration',
    min: 0.1,
    max: 5,
    step: 0.1,
    unit: 's',
    get: (c) => Math.round(((c.transition?.duration || 500_000) / US) * 10) / 10,
    set: (v, final) => view.edit('Transition duration', (c, _track, p) => {
      if (!c.transition) return false;
      c.transition.duration = Math.round(Math.max(MIN, Math.min(v * US, maxTransition(p, c))));
    }, { key: 'tr-duration', final }),
  });

  const groups = TRANSITION_CATEGORIES.map((cat) => {
    const items = TRANSITIONS.filter((t) => t.cat === cat.id);
    const grid = choiceGrid({
      label: `${cat.label} transitions`,
      className: 'tr-grid',
      items: items.map((t) => ({ id: t.id, label: t.label, preview: lookPreview('transition', t.id, { progress: 0.5 }) })),
      value: view.clip?.transition?.id,
      onPick: (id) => {
        actions.applyTransition(id, { clipId: view.id, duration: view.clip?.transition?.duration });
      },
    });
    grid.buttons.forEach((b, i) => hoverAnimate(b, 'transition', items[i].id));
    return { cat, grid };
  });

  const applyAll = h('button.btn.small', { type: 'button' }, icon('layers', 14), 'Apply to all');
  applyAll.addEventListener('click', () => {
    const c = view.clip;
    if (!c?.transition) return;
    if (actions.applyTransitionToAll(c.transition.id, c.transition.duration) === false) return;
    announce(`${transitionLabel(c.transition.id)} applied to every cut on the base track`);
  });
  const remove = h('button.btn.small', { type: 'button' }, icon('trash', 14), 'Remove');
  remove.addEventListener('click', () => {
    actions.applyTransition(null, { clipId: view.id });
    store.clearSelection();
  });

  const render = () => {
    const c = view.clip;
    if (!c?.transition) return;
    name.textContent = transitionLabel(c.transition.id);
    const max = maxTransition(view.project, c);
    range.textContent = `Up to ${(max / US).toFixed(1)}s at this cut`;
    dur.input.max = String(Math.max(0.1, Math.floor((max / US) * 10) / 10));
    dur.setLimits(0.1, Math.max(0.1, max / US));
    for (const g of groups) g.grid.set(c.transition.id);
  };
  render();
  view.bind(render);

  return h('div.transition-view',
    header,
    propSection('Duration', [dur.el, h('div.insp-actions', applyAll, remove)]),
    ...groups.map((g) => propSection(g.cat.label, g.grid.el)),
  );
}

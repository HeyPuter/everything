// More appearance controls: density, accent and the phone tab-bar order, each returning `{node, update(prefs)}` like
// the controls in ../ui.js.
import { createElement, ChevronDown, ChevronUp } from 'lucide';
import { el, uid } from '../../../ui/dom.js';
import { icon } from '../../../ui/icons.js';
import { button } from '../../../ui/bits.js';
import { choiceGroup } from '../../../ui/fields.js';
import { makeSortable } from '../../../ui/dnd.js';
import { t } from '../../../lib/i18n/index.js';
import { ACCENTS, orderTabs, prefs, setPrefs } from '../../../lib/prefs.js';
import { routes } from '../../registry/routes.js';
import { prefChoice, row } from '../ui.js';

const arrow = (shape) => createElement(shape, { width: 16, height: 16, 'stroke-width': 2, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });

export function densityControl() {
  return prefChoice('density', t('appearance.density'), [
    { value: 'comfortable', label: t('appearance.densityComfortable') },
    { value: 'compact', label: t('appearance.densityCompact') },
  ], { hint: t('appearance.densityHint') });
}

export function accentControl() {
  const control = choiceGroup({
    label: t('appearance.accent'), value: prefs().accent, onChange: (value) => setPrefs({ accent: value }),
    items: ACCENTS.map((id) => ({ value: id, label: t(`appearance.accent.${id}`) })),
  });
  control.element.classList.add('accent-choices');
  [...control.element.children].forEach((node, index) => node.prepend(el('span.accent-swatch', { 'aria-hidden': 'true', style: { '--swatch': `var(--swatch-${ACCENTS[index]})` } })));
  const parts = row({ label: t('appearance.accent'), hint: t('appearance.accentHint'), control: control.element, stacked: true });
  control.element.setAttribute('aria-labelledby', parts.labelId);
  if (parts.hintId) control.element.setAttribute('aria-describedby', parts.hintId);
  return { node: parts.node, update: (value) => control.setValue(value.accent) };
}

/** Reorders the primary routes for the phone tab bar: drag the grip, Alt+Arrow on it, or the move buttons. */
export function tabOrderControl({ items = routes } = {}) {
  const list = el('div.card.tab-order-list');
  const labelId = uid('tab-order');
  const hintId = uid('tab-order-hint');
  let sortable = null;
  let last = '';
  const save = (ids) => setPrefs({ tabOrder: ids });
  function move(id, delta) {
    const ids = orderTabs(items).map((item) => item.id);
    const index = ids.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    save(ids);
    draw();
    list.querySelector(`[data-tab="${id}"] [data-move="${delta < 0 ? 'up' : 'down'}"]:not(:disabled)`)?.focus()
      ?? list.querySelector(`[data-tab="${id}"] [data-sortable-handle]`)?.focus();
  }
  function draw() {
    sortable?.destroy();
    const ordered = orderTabs(items);
    last = JSON.stringify(prefs().tabOrder);
    list.replaceChildren(...ordered.map((item, index) => {
      const name = t(item.labelKey);
      return el('div.list-row.tab-order-row', { dataset: { sortableItem: '', tab: item.id, label: name } },
        el('button.icon-btn.icon-btn-sm.sortable-grip', { type: 'button', dataset: { sortableHandle: '' }, 'aria-label': t('appearance.tabMove', { name }) }, icon('grip', 16)),
        icon(item.icon, 18),
        el('span.tab-order-name', {}, name),
        el('span.tab-order-moves', {},
          el('button.icon-btn.icon-btn-sm', { type: 'button', dataset: { move: 'up' }, disabled: index === 0, 'aria-label': t('appearance.tabUp', { name }), onclick: () => move(item.id, -1) }, arrow(ChevronUp)),
          el('button.icon-btn.icon-btn-sm', { type: 'button', dataset: { move: 'down' }, disabled: index === ordered.length - 1, 'aria-label': t('appearance.tabDown', { name }), onclick: () => move(item.id, 1) }, arrow(ChevronDown))));
    }));
    // The list already shows the new order, so a drag saves without redrawing (keeps the move announcement).
    sortable = makeSortable(list, { onMove: () => save([...list.querySelectorAll('[data-tab]')].map((node) => node.dataset.tab)) });
  }
  draw();
  const reset = button(t('appearance.tabReset'), { size: 'sm', variant: 'outline', onclick: () => { save([]); draw(); } });
  const node = el('div.pref-row.stacked', {},
    el('div.pref-text', {}, el('span.pref-label', { id: labelId }, t('appearance.tabOrder')), el('span.pref-hint', { id: hintId }, t('appearance.tabOrderHint'))),
    list, el('div.settings-actions', {}, reset));
  list.setAttribute('role', 'group');
  list.setAttribute('aria-labelledby', labelId);
  list.setAttribute('aria-describedby', hintId);
  return {
    node,
    update(value) {
      if (JSON.stringify(value.tabOrder) === last || list.contains(document.activeElement)) return;
      draw();
    },
    destroy() { sortable?.destroy(); },
  };
}

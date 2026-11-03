// Plan B in the Plan tab: a day-menu item and a header chip open the alternatives of that day (dialog.js).
import './alternatives.css';
import { el } from '../../../../ui/dom.js';
import { t } from '../../../../lib/i18n/index.js';
import { dayLabel } from '../forms.js';
import { refreshPlanHooks, registerPlanHooks } from '../hooks.js';
import { flagCounts } from './model.js';
import { icon } from './icons.js';

/** Registers the plan hooks for `pane` (`{space, plan}`); returns the cleanup. */
export function mountAlternatives(pane) {
  const { space } = pane;
  if (!space?.select?.alt) return () => {};
  const open = (entry) => { void import('./dialog.js').then(({ openAlternatives }) => openAlternatives(pane, entry)); };
  let memo = null;
  // Selector results keep their identity until their type changes, so counts are computed once per change.
  const counts = () => {
    const inputs = [space.select.alt.all(), space.select.day.all(), space.select.visit.all()];
    if (!memo || memo.inputs.some((value, i) => value !== inputs[i])) {
      const map = flagCounts(...inputs);
      memo = { inputs, map, key: [...map].sort().map(([day, count]) => `${day}:${count}`).join(',') };
    }
    return memo;
  };
  let last = counts().key;
  const check = () => { const next = counts().key; if (next !== last) { last = next; refreshPlanHooks(); } };

  function headerChip(entry) {
    const count = counts().map.get(entry.day.id) ?? 0;
    if (!count) return null;
    return el('button.alt-chip', { type: 'button', 'aria-label': t('alternatives.chipLabel', { day: dayLabel(entry), count }), onclick: () => open(entry) },
      icon('split', 14), el('span', { 'aria-hidden': 'true' }, count === 1 ? t('alternatives.chip') : t('alternatives.chipMany', { count })));
  }

  const offs = [
    registerPlanHooks({
      dayActions: ({ entry, context }) => (context?.space === space ? [{ label: t('alternatives.open'), icon: 'copy', onSelect: () => open(entry) }] : null),
      dayHeader: ({ entry, context }) => (context?.space === space ? headerChip(entry) : null),
    }),
    ...['alt', 'visit', 'day'].map((type) => space.subscribe(type, check)),
  ];
  return () => { for (const off of offs) off(); };
}

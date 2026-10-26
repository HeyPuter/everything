import { el } from '../../../ui/dom.js';
import { avatarStack } from '../../../ui/avatar.js';
import { openMenu } from '../../../ui/menu.js';
import { makeSortable } from '../../../ui/dnd.js';
import { t } from '../../../lib/i18n/index.js';
import { formatWeight } from '../../../lib/format.js';
import { bagTotals } from './model.js';
import { btn, colorDot, iconBtn, personOf, plural } from './common.js';
import { icon } from './icons.js';

/** The bags panel: totals, fill bars against the limit, members, and the items not in any bag. */
export function renderBags({ items, bags, people, canEdit, selected, reorder, onSelect, onAdd, onEdit, onDelete, onMove, sortables }) {
  const totals = bagTotals(items, bags);
  const list = el('div.lists-bags-list');
  for (const bag of bags) {
    const total = totals.bags.get(bag.id) ?? { grams: 0, count: 0 };
    const limit = bag.limitGrams > 0 ? bag.limitGrams : null;
    const over = limit !== null && total.grams > limit;
    const members = (bag.people ?? []).map((id) => personOf(people, id));
    const weight = limit ? t('lists.bagWeightOf', { weight: formatWeight(total.grams), limit: formatWeight(limit) }) : formatWeight(total.grams);
    list.append(el(`div.lists-bag${selected === bag.id ? '.is-selected' : ''}`, { dataset: { sortableItem: '', label: bag.name } },
      el('div.lists-bag-head', {},
        reorder && canEdit && el('button.icon-btn.icon-btn-sm.sortable-grip', { type: 'button', 'data-sortable-handle': '', dataset: { focus: `bgrip:${bag.id}` } }, icon('grip', 16)),
        colorDot(bag.color),
        el('button.lists-bag-name', { type: 'button', 'aria-pressed': String(selected === bag.id), dataset: { focus: `bag:${bag.id}` }, onclick: () => onSelect(bag.id),
          title: t('lists.showBagItems', { name: bag.name }) }, bag.name),
        members.length > 0 && el('span.lists-bag-people', { title: members.map((person) => person.name).join(', ') },
          avatarStack(members.map((person) => ({ id: person.id, name: person.name, photo: person.avatar })), { size: 22 })),
        canEdit && iconBtn('more', t('lists.bagActions', { name: bag.name }), { dataset: { focus: `bmenu:${bag.id}` }, onclick: (event) => openMenu(event.currentTarget, [
          { label: t('lists.edit'), icon: 'pencil', onSelect: () => onEdit(bag) },
          { separator: true },
          { label: t('lists.delete'), icon: 'trash', danger: true, onSelect: () => onDelete(bag) },
        ]) })),
      el('div.lists-bag-stats', {}, el('span', {}, plural(total.count, 'lists.itemsOne', 'lists.itemsOther')),
        el(`span${over ? '.lists-over' : ''}`, {}, weight)),
      limit && el(`progress.meter.lists-bag-meter${over ? '.is-over' : ''}`, { max: limit, value: Math.min(total.grams, limit), 'aria-label': t('lists.bagFill', { name: bag.name }) }),
      over && el('p.lists-over', { role: 'note' }, icon('warning', 14), t('lists.bagOver', { weight: formatWeight(total.grams - limit) }))));
  }
  const none = el(`div.lists-bag.lists-bag-none${selected === 'none' ? '.is-selected' : ''}`, {},
    el('div.lists-bag-head', {}, icon('luggage', 16),
      el('button.lists-bag-name', { type: 'button', 'aria-pressed': String(selected === 'none'), dataset: { focus: 'bag:none' }, onclick: () => onSelect('none') }, t('lists.unbagged'))),
    el('div.lists-bag-stats', {}, el('span', {}, plural(totals.none.count, 'lists.itemsOne', 'lists.itemsOther')), el('span', {}, formatWeight(totals.none.grams))));
  const headingId = 'lists-bags-heading';
  const panel = el('section.lists-bags', { 'aria-labelledby': headingId },
    el('div.lists-bags-head', {}, el('h3', { id: headingId }, icon('luggage', 18), t('lists.bags')),
      canEdit && btn(t('lists.addBag'), { icon: 'plus', size: 'sm', variant: 'ghost', onclick: onAdd })),
    bags.length ? list : el('p.lists-hint', {}, t(canEdit ? 'lists.bagsEmpty' : 'lists.bagsEmptyViewer')),
    none);
  if (reorder && canEdit && bags.length > 1) sortables.push(makeSortable(list, { onMove: ({ from, to }) => onMove(from, to) }));
  return panel;
}

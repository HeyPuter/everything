import { el, uid } from '../../ui/dom.js';
import { t } from '../../lib/i18n/index.js';
import { formatWeight } from '../../lib/format.js';
import { groupLists, itemGrams } from '../trip/lists/model.js';
import { icon } from '../trip/plan/icons.js';

const count = (value) => new Intl.NumberFormat().format(value);

function itemRow(item, ctx, bags) {
  const meta = [];
  if (Number.isFinite(item.qty) && item.qty > 1) meta.push(el('span.num', {}, t('public.quantity', { count: count(item.qty) })));
  const grams = itemGrams(item);
  if (grams) meta.push(el('span.num', {}, formatWeight(grams)));
  const bag = item.bagId ? bags.get(item.bagId) : null;
  if (bag) meta.push(el('span', {}, bag.name));
  const who = item.vis === 'people' ? (item.for ?? []).map(ctx.people).filter(Boolean) : [];
  if (who.length) meta.push(el('span', {}, t('public.forPeople', { names: who.join(', ') })));
  return el('li.public-row.public-pack', { dataset: { done: item.done ? 'true' : 'false' } },
    el('span.public-check', { role: 'img', 'aria-label': t(item.done ? 'public.packed' : 'public.notPacked') }, item.done && icon('check', 14)),
    el('div.public-row-body', {}, el('span.public-row-title', {}, item.name), meta.length && el('span.public-row-meta', {}, meta)));
}

/** Packing lists in list order with shared checks; per-person checks are not part of the public view. */
export function renderPacking(ctx) {
  const { space } = ctx;
  const items = space.select.pack.all();
  if (!items.length) return el('p.public-empty', {}, t('public.packingEmpty'));
  const bags = new Map(space.select.bag.all().map((bag) => [bag.id, bag]));
  const done = items.filter((item) => item.done).length;
  return el('div.public-packing', {},
    el('p.public-hint', {}, t('public.packedCount', { done: count(done), total: count(items.length) })),
    groupLists(space.select.listMeta.all(), items, 'pack').map((group) => {
      const headingId = uid('public-list');
      return el('section.public-card', { 'aria-labelledby': headingId },
        el('h3.public-card-title', { id: headingId }, group.name || t('public.otherItems')),
        el('ul.public-rows', {}, group.items.map((item) => itemRow(item, ctx, bags))));
    }));
}

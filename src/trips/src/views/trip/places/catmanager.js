import { el, uid } from '../../../ui/dom.js';
import { button, iconButton } from '../../../ui/bits.js';
import { field, choiceGroup } from '../../../ui/fields.js';
import { openModal, confirmDialog } from '../../../ui/modal.js';
import { openMenu } from '../../../ui/menu.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { icon } from './icons.js';
import { BUILTIN_CATEGORIES, CAT_COLORS, CAT_ICONS, CAT_NAME_MAX, adoptPersonalCategory, categoryColor, categoryOf, tripCategories } from '../../../lib/categories.js';
import { removeCategoryOps } from './actions.js';

export function swatch(category, size = 18) {
  return el('span.pl-swatch', { style: { '--pl-cat': categoryColor(category.color) }, 'aria-hidden': 'true' }, icon(category.icon, size));
}

/** Create or edit one trip category. Resolves the saved category id, or null when cancelled. */
export function openCategoryEditor({ space, category = null, track }) {
  return new Promise((resolve) => {
    let saved = null;
    const creating = !category;
    const current = category ?? { name: '', color: 1, icon: 'map-pin' };
    let color = CAT_COLORS.includes(current.color) ? current.color : 1;
    let symbol = CAT_ICONS.includes(current.icon) ? current.icon : 'map-pin';
    const name = field({ label: t('places.catName'), value: current.name, maxLength: CAT_NAME_MAX, autocomplete: 'off', required: true });
    const preview = el('div.pl-cat-preview', { 'aria-hidden': 'true' });
    const draw = () => preview.replaceChildren(swatch({ color, icon: symbol }, 20), el('span', {}, name.input.value.trim() || t('places.catName')));
    const colors = choiceGroup({ label: t('places.catColor'), value: color, onChange: (value) => { color = value; draw(); },
      items: CAT_COLORS.map((value) => ({ value, label: t(`places.color${value}`) })) });
    colors.element.classList.add('pl-swatch-choices');
    [...colors.element.children].forEach((node, index) => node.prepend(el('span.pl-dot', { style: { '--pl-cat': categoryColor(CAT_COLORS[index]) } })));
    const icons = choiceGroup({ label: t('places.catIcon'), value: symbol, onChange: (value) => { symbol = value; draw(); },
      items: CAT_ICONS.map((value) => ({ value, label: t(`places.icon.${value}`) })) });
    icons.element.classList.add('pl-icon-choices');
    [...icons.element.children].forEach((node, index) => node.prepend(icon(CAT_ICONS[index], 18)));
    name.input.addEventListener('input', draw); draw();
    const error = el('p.pl-alert', { role: 'alert', hidden: true });
    const form = el('form', { noValidate: true, onsubmit: async (event) => {
      event.preventDefault();
      const value = name.input.value.replace(/\s+/g, ' ').trim();
      name.setError(value ? '' : t('places.catNameRequired'));
      if (!value) { name.input.focus(); return; }
      const fields = { name: value, color, icon: symbol };
      try {
        if (creating) {
          const op = space.ops.create('cat', fields);
          await space.apply([op], { history: t('places.historyCategoryAdd') });
          saved = op.id;
        } else {
          const set = Object.fromEntries(Object.entries(fields).filter(([key, next]) => category[key] !== next));
          if (Object.keys(set).length) await space.apply([space.ops.patch('cat', category.id, { set })], { history: t('places.historyCategoryEdit') });
          saved = category.id;
        }
        dialog.close('saved');
        toast(t(creating ? 'places.catAdded' : 'places.catSaved', { name: value }));
      } catch {
        error.textContent = t('places.saveFailed'); error.hidden = false;
      }
    } }, error, preview, name.element,
    el('div.field', {}, el('span.field-label', { 'aria-hidden': 'true' }, t('places.catColor')), colors.element),
    el('div.field', {}, el('span.field-label', { 'aria-hidden': 'true' }, t('places.catIcon')), icons.element),
    el('div.modal-actions', {}, button(t('places.cancel'), { onclick: () => dialog.close('cancel') }),
      button(t(creating ? 'places.catAdd' : 'places.save'), { type: 'submit', variant: 'primary' })));
    const dialog = openModal({ title: t(creating ? 'places.catNewTitle' : 'places.catEditTitle'), content: form, initialFocus: name.input, onClose: () => resolve(saved) });
    track?.(dialog);
  });
}

/** The trip's categories: add, edit, delete, or copy one of the caller's personal categories. */
export function openCategoryManager({ space, catalog, canEdit, track }) {
  const body = el('div.pl-cat-manager');
  const usage = () => {
    const counts = new Map();
    for (const place of space.select.place.all()) counts.set(place.cat, (counts.get(place.cat) ?? 0) + 1);
    return counts;
  };
  let personal = [];
  async function loadPersonal() {
    try { personal = catalog ? await catalog.categories() : []; } catch { personal = []; }
    render();
  }
  async function remove(category, count) {
    const ok = await confirmDialog({ title: t('places.catDeleteTitle', { name: category.name }),
      body: count ? t('places.catDeleteBodyUsed', { count }) : t('places.catDeleteBody'), confirmLabel: t('places.delete'), danger: true });
    if (!ok) return;
    try { await space.apply(removeCategoryOps(space, category.id)); toast(t('places.catDeleted', { name: category.name })); }
    catch { toast(t('places.saveFailed')); }
  }
  async function adopt(entry) {
    const { id, ops } = adoptPersonalCategory(space, entry);
    try {
      if (ops.length) await space.apply(ops, { history: t('places.historyCategoryAdd') });
      toast(ops.length ? t('places.catAdded', { name: entry.name }) : t('places.catExists', { name: categoryOf(space, id).name }));
    } catch { toast(t('places.saveFailed')); }
  }
  function render() {
    const counts = usage();
    const trip = tripCategories(space);
    const tripNames = new Set(trip.map((entry) => entry.name.trim().toLocaleLowerCase()));
    const fromMine = personal.filter((entry) => !tripNames.has(entry.name.trim().toLocaleLowerCase()));
    const tripTitle = uid('pl-cats');
    const builtTitle = uid('pl-cats');
    body.replaceChildren(
      el('section.pl-cat-section', { 'aria-labelledby': tripTitle },
        el('h3.pl-eyebrow', { id: tripTitle }, t('places.catTrip')),
        trip.length ? el('ul.card.pl-cat-list', {}, trip.map((entity) => {
          const category = categoryOf(space, entity.id);
          const count = counts.get(entity.id) ?? 0;
          return el('li.list-row', {}, swatch(category), el('span.pl-cat-name', {}, category.name, el('span.pl-muted', {}, t('places.catUsage', { count }))),
            canEdit && iconButton('pencil', t('places.catEditNamed', { name: category.name }), { onclick: () => openCategoryEditor({ space, category: entity, track }) }),
            canEdit && iconButton('trash', t('places.catDeleteNamed', { name: category.name }), { onclick: () => remove(entity, count) }));
        })) : el('p.pl-muted', {}, t('places.catTripEmpty')),
        canEdit && el('div.pl-row-actions', {},
          button(t('places.catAdd'), { icon: 'plus', size: 'sm', variant: 'outline', onclick: () => openCategoryEditor({ space, track }) }),
          fromMine.length > 0 && button(t('places.catFromMine'), { size: 'sm', variant: 'ghost', onclick: (event) => openMenu(event.currentTarget,
            fromMine.map((entry) => ({ label: entry.name, onSelect: () => adopt(entry) }))) }))),
      el('section.pl-cat-section', { 'aria-labelledby': builtTitle },
        el('h3.pl-eyebrow', { id: builtTitle }, t('places.catBuiltin')),
        el('ul.pl-cat-grid', {}, BUILTIN_CATEGORIES.map((entry) => {
          const category = categoryOf(space, entry.id);
          return el('li.pl-cat-chip', {}, swatch(category, 16), el('span', {}, category.name), el('span.pl-muted', {}, String(counts.get(entry.id) ?? 0)));
        }))),
    );
  }
  const off = space.subscribe((event) => { if (event.types.has('cat') || event.types.has('place')) render(); });
  render();
  void loadPersonal();
  const dialog = openModal({ title: t('places.catManagerTitle'), content: body, wide: true, onClose: off });
  track?.(dialog);
  return dialog;
}

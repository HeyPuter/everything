import { el, uid } from '../../../ui/dom.js';
import { button, iconButton, skeleton } from '../../../ui/bits.js';
import { field, choiceGroup } from '../../../ui/fields.js';
import { openModal, confirmDialog, promptDialog } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { createCatalogStore, CATEGORY_ICONS, CATEGORY_COLORS, CATALOG_LIMITS } from '../data/catalog.js';
import { icon } from '../icons.js';
import { alertRegion, busy, errorText, listFocus } from '../ui.js';

const COLOR_NAMES = ['settings.colorBlue', 'settings.colorGreen', 'settings.colorAmber', 'settings.colorPink', 'settings.colorIndigo', 'settings.colorRed', 'settings.colorOlive', 'settings.colorPurple'];
const ICON_NAMES = {
  'map-pin': 'settings.iconPin', utensils: 'settings.iconFood', coffee: 'settings.iconCafe', wine: 'settings.iconBar', 'bed-double': 'settings.iconStay',
  landmark: 'settings.iconSight', mountain: 'settings.iconMountain', trees: 'settings.iconNature', waves: 'settings.iconBeach', camera: 'settings.iconPhoto',
  ticket: 'settings.iconTicket', 'shopping-bag': 'settings.iconShopping', music: 'settings.iconMusic', baby: 'settings.iconKids', dumbbell: 'settings.iconSport', church: 'settings.iconWorship',
};
const CODES = {
  category_name_required: 'settings.categoryNameRequired', too_many_categories: 'settings.categoryLimit',
  tag_name_required: 'settings.tagNameRequired', tag_exists: 'settings.tagExists', too_many_tags: 'settings.tagLimit',
  catalog_unreadable: 'settings.catalogUnreadable',
};
const message = (error) => (Object.hasOwn(CODES, error?.code) ? t(CODES[error.code]) : errorText(error));
const swatch = (color, name) => el('span.cat-swatch', { style: { '--cat-color': `var(--day-${color})` } }, icon(name, 18));

export function render(container, { personal, signal }) {
  const store = createCatalogStore({ personal });
  const catAlert = alertRegion();
  const tagAlert = alertRegion();
  const cats = el('div.category-list', { 'aria-busy': 'true' }, skeleton(), skeleton('60%'));
  const tags = el('ul.tag-list', { 'aria-busy': 'true' });
  const catFocus = listFocus(cats, () => addCategory);
  const tagFocus = listFocus(tags, () => tagInput);
  let dialog = null;

  async function refresh() {
    try {
      const [categories, names] = await Promise.all([store.categories(), store.tags()]);
      if (signal.aborted) return;
      drawCategories(categories); drawTags(names);
    } catch (error) {
      if (signal.aborted) return;
      catFocus.redraw(() => cats.replaceChildren(el('div.settings-error', {}, el('p', {}, errorText(error)), button(t('settings.retry'), { size: 'sm', variant: 'outline', onclick: refresh }))));
      tagFocus.redraw(() => tags.replaceChildren());
    } finally { cats.removeAttribute('aria-busy'); tags.removeAttribute('aria-busy'); }
  }
  function drawCategories(categories) {
    catFocus.redraw(() => {
      if (!categories.length) { cats.replaceChildren(el('p.pref-hint.list-empty', {}, t('settings.categoriesEmpty'))); return; }
      cats.replaceChildren(el('div.card', {}, categories.map((category) => el('div.list-row', { dataset: { id: category.id } },
        swatch(category.color, category.icon), el('span.row-text', {}, el('span.pref-label', {}, category.name)),
        iconButton('pencil', t('settings.categoryEditNamed', { name: category.name }), { dataset: { focus: 'edit' }, onclick: (event) => edit(category, event.currentTarget) }),
        iconButton('trash', t('settings.categoryDeleteNamed', { name: category.name }), { dataset: { focus: 'delete' }, onclick: (event) => removeCategory(category, event.currentTarget) })))));
    });
  }
  function drawTags(names) {
    tagFocus.redraw(() => {
      if (!names.length) { tags.replaceChildren(el('li.pref-hint.list-empty', {}, t('settings.tagsEmpty'))); return; }
      tags.replaceChildren(...names.map((name) => el('li.chip.tag-chip', { dataset: { id: name } },
        el('button.tag-name', { type: 'button', title: t('settings.tagRenameNamed', { name }), 'aria-label': t('settings.tagRenameNamed', { name }), dataset: { focus: 'rename' },
          onclick: (event) => renameTag(name, event.currentTarget) }, icon('tag', 14), name),
        iconButton('close', t('settings.tagDeleteNamed', { name }), { dataset: { focus: 'delete' }, onclick: (event) => removeTag(name, event.currentTarget) }))));
    });
  }

  function edit(category, control) {
    catFocus.hold(control);
    let saved = false;
    const creating = !category;
    const current = category ?? { name: '', color: 1, icon: 'map-pin' };
    const dialogAlert = alertRegion();
    const name = field({ label: t('settings.categoryName'), value: current.name, maxLength: CATALOG_LIMITS.name, autocomplete: 'off' });
    let color = current.color; let symbol = current.icon;
    const colors = choiceGroup({ label: t('settings.categoryColor'), value: color, onChange: (value) => { color = value; preview(); },
      items: CATEGORY_COLORS.map((value, index) => ({ value, label: t(COLOR_NAMES[index]) })) });
    colors.element.classList.add('swatch-choices');
    [...colors.element.children].forEach((node, index) => node.prepend(el('span.cat-dot', { style: { '--cat-color': `var(--day-${CATEGORY_COLORS[index]})` } })));
    const icons = choiceGroup({ label: t('settings.categoryIcon'), value: symbol, onChange: (value) => { symbol = value; preview(); },
      items: CATEGORY_ICONS.map((value) => ({ value, label: t(ICON_NAMES[value]) })) });
    icons.element.classList.add('icon-choices');
    [...icons.element.children].forEach((node, index) => node.prepend(icon(CATEGORY_ICONS[index], 18)));
    const sample = el('div.cat-preview', { 'aria-hidden': 'true' });
    function preview() { sample.replaceChildren(swatch(color, symbol), el('span', {}, name.input.value.trim() || t('settings.categoryName'))); }
    name.input.addEventListener('input', preview); preview();
    const save = button(t(creating ? 'settings.categoryAdd' : 'settings.save'), { type: 'submit', variant: 'primary' });
    const form = el('form', { noValidate: true, onsubmit: async (event) => {
      event.preventDefault(); name.setError('');
      if (!name.input.value.trim()) { name.setError(t('settings.categoryNameRequired')); name.input.focus(); return; }
      const done = await busy(save, dialogAlert, async () => { await store.saveCategory({ ...(category ?? {}), name: name.input.value, color, icon: symbol }); return true; }, message);
      if (!done) return;
      saved = true;
      dialog?.close('saved'); toast(t(creating ? 'settings.categoryAdded' : 'settings.categorySaved', { name: name.input.value.trim() })); void refresh();
    } }, dialogAlert.node, sample, name.element,
    el('div.field', {}, el('span.field-label', {}, t('settings.categoryColor')), colors.element),
    el('div.field', {}, el('span.field-label', {}, t('settings.categoryIcon')), icons.element),
    el('div.modal-actions', {}, button(t('settings.cancel'), { onclick: () => dialog?.close('cancel') }), save));
    dialog = openModal({ title: t(creating ? 'settings.categoryNewTitle' : 'settings.categoryEditTitle'), content: form, initialFocus: name.input,
      onClose: () => { dialog = null; if (!saved) catFocus.release(); } });
  }
  async function removeCategory(category, control) {
    catFocus.hold(control);
    if (!await confirmDialog({ title: t('settings.categoryDeleteTitle', { name: category.name }), body: t('settings.categoryDeleteBody'), confirmLabel: t('settings.delete'), danger: true })) { catFocus.release(); return; }
    if (await busy(null, catAlert, async () => { await store.removeCategory(category.id); return true; }, message)) { toast(t('settings.categoryDeleted', { name: category.name })); void refresh(); }
    else catFocus.release();
  }
  async function renameTag(from, control) {
    tagFocus.hold(control);
    const value = await promptDialog({ title: t('settings.tagRenameTitle'), label: t('settings.tagName'), value: from, confirmLabel: t('settings.rename') });
    if (value == null || value.trim() === from) { tagFocus.release(); return; }
    if (await busy(null, tagAlert, async () => { await store.renameTag(from, value); return true; }, message)) void refresh();
    else tagFocus.release();
  }
  async function removeTag(name, control) {
    tagFocus.hold(control);
    if (await busy(null, tagAlert, async () => { await store.removeTag(name); return true; }, message)) { toast(t('settings.tagDeleted', { name })); void refresh(); }
    else tagFocus.release();
  }

  const tagInputId = uid('tag');
  const tagInput = el('input.input', { id: tagInputId, maxLength: CATALOG_LIMITS.name, autocomplete: 'off' });
  const addTag = button(t('settings.tagAdd'), { type: 'submit', variant: 'outline' });
  const tagForm = el('form.tag-form', { noValidate: true, onsubmit: async (event) => {
    event.preventDefault();
    if (!tagInput.value.trim()) { tagAlert.show(t('settings.tagNameRequired')); tagInput.focus(); return; }
    // Not marked busy: quick successive tags queue in the store instead of being dropped.
    const value = tagInput.value;
    if (await busy(null, tagAlert, async () => { await store.addTag(value); return true; }, message)) { if (tagInput.value === value) tagInput.value = ''; void refresh(); }
  } }, el('label.field-label', { htmlFor: tagInputId }, t('settings.tagNew')), el('div.tag-form-row', {}, tagInput, addTag));

  const addCategory = button(t('settings.categoryAdd'), { icon: 'plus', variant: 'primary', onclick: () => edit(null) });
  const off = store.subscribe(() => { void refresh(); });
  signal?.addEventListener('abort', () => { off(); dialog?.close('navigation'); }, { once: true });
  const catTitle = uid('cats'); const tagTitle = uid('tags');
  container.replaceChildren(el('div.settings-stack', {},
    el('p.pref-hint', {}, t('settings.categoriesHint')),
    el('section.pref-group', { 'aria-labelledby': catTitle }, el('h3.pref-group-title', { id: catTitle }, t('settings.categoriesTitle')),
      el('div.settings-actions', {}, addCategory), catAlert.node, cats),
    el('section.pref-group', { 'aria-labelledby': tagTitle }, el('h3.pref-group-title', { id: tagTitle }, t('settings.tagsTitle')),
      tagForm, tagAlert.node, tags)));
  void refresh();
}

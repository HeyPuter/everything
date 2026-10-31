import '../src/styles/base.css';
import '../src/styles/components.css';
import '../src/styles/kit.css';
import {
  el, icon, button, iconButton, field, switchField, checkbox, segmented, choiceGroup, dateField,
  dateRangePicker, avatar, avatarStack, tabs, openModal, openSheet, openDrawer,
  openMenu, toast, applyTheme, currentTheme, makeSortable, virtualList, markdown,
  chip, emptyState, spinner, skeleton,
} from '../src/ui/index.js';
import { t, locale } from '../src/lib/i18n/index.js';

document.title = t('kit.title');
const row = (...children) => el('div.kit-row', {}, children);
const stack = (...children) => el('div.kit-stack', {}, children);
function section(key, ...children) { return el('section.kit-section', {}, el('h2', {}, t(key)), ...children); }
const demoStatus = el('p.kit-demo-status', { role: 'status' });
const showSaved = () => toast(t('kit.saved'), { action: { label: t('kit.undo'), onClick: () => toast(t('kit.undone')) } });
const theme = segmented({ label: t('kit.theme'), value: currentTheme(), onChange: applyTheme,
  items: ['system', 'light', 'dark'].map((value, index) => ({ value, label: t(`kit.${value}`), icon: ['monitor', 'sun', 'moon'][index] })),
});
const people = ['alice', 'bob', 'carol', 'dan', 'eva'].map((id) => ({ id, name: t(`kit.${id}`) }));
function showDialog(kind = 'modal') {
  const formField = field({ label: t('kit.tripName'), value: t('kit.name') });
  const open = kind === 'sheet' ? openSheet : kind === 'drawer' ? openDrawer : openModal;
  const dialog = open({ title: t('kit.dialogTitle'), content: stack(
    el('p', {}, t('kit.dialogBody')), formField.element,
    button(t('kit.toast'), { onclick: showSaved }),
    button(t('kit.nested'), { onclick: () => openModal({ title: t('kit.nestedTitle'), content: el('p', {}, t('kit.dialogBody')) }) }),
  ), actions: [button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), button(t('ui.save'), { variant: 'primary', onclick: () => { dialog.close('save'); showSaved(); } })] });
}
let favorite = false;
const menuButton = button(t('kit.menu'), { icon: 'more', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => openMenu(menuButton, [
  { label: t('kit.rename'), icon: 'pencil', onSelect: () => { demoStatus.textContent = t('kit.rename'); } },
  { label: t('kit.duplicate'), icon: 'copy', onSelect: showSaved },
  { label: t('kit.favorite'), icon: 'heart', checked: favorite, onSelect: (value) => { favorite = value; demoStatus.textContent = t('kit.favorite'); } },
  { label: t('kit.menuDisabled'), disabled: true }, { separator: true },
  { label: t('kit.danger'), icon: 'trash', danger: true, onSelect: showSaved },
]) });
const stops = el('div.card', { id: 'sortable-demo' }, ['harbor', 'market', 'museum'].map((id) => {
  const label = t(`kit.${id}`);
  return el('div.list-row', { dataset: { sortableItem: id, label } },
    iconButton('grip', t('ui.reorder', { name: label }), { className: 'icon-btn sortable-grip', dataset: { sortableHandle: '' } }),
    icon('pin', 16), el('span', {}, label));
}));
const sortable = makeSortable(stops);
const virtual = virtualList({ label: t('kit.virtual'), items: Array.from({ length: 1000 }, (_, index) => index + 1),
  renderItem: (number) => el('span', {}, t('kit.virtualItem', { number: new Intl.NumberFormat(locale).format(number) })),
});
const dayChips = Array.from({ length: 8 }, (_, index) => el('span.chip.day-chip', { style: { '--day-color': `var(--day-${index + 1})` } }, el('span.day-dot', { 'aria-hidden': 'true' }), t('kit.day', { number: index + 1 })));
const tabset = tabs({ label: t('kit.tabs'), items: ['plan', 'bookings', 'costs'].map((id, index) => ({ id, label: t(`kit.${id}`), icon: ['map', 'plane', 'wallet'][index], content: el('p', {}, t(`kit.${id}Body`)) })) });
const main = el('main.kit', { id: 'components', tabIndex: -1 },
  el('header.kit-head', {}, el('div', {}, el('h1', {}, t('kit.title')), el('p', {}, t('kit.intro'))), theme.element),
  el('div.kit-grid', {},
    section('kit.buttons', stack(
      row(button(t('kit.primary'), { variant: 'primary', icon: 'plus', onclick: showSaved }), button(t('kit.secondary')), button(t('kit.outline'), { variant: 'outline' }), button(t('kit.ghost'), { variant: 'ghost' })),
      row(button(t('kit.danger'), { variant: 'danger', icon: 'trash' }), button(t('kit.disabled'), { disabled: true }), button(t('kit.busy'), { busy: true, icon: 'loading' }), iconButton('plus', t('kit.primary'), { onclick: showSaved })),
      row(button(t('kit.toast'), { onclick: showSaved })),
      el('div.offline-bar', {}, icon('offline', 16), t('kit.offline')),
    )),
    section('kit.fields',
      field({ label: t('kit.tripName'), value: t('kit.name'), hint: t('kit.hint') }).element,
      field({ label: t('kit.invalid'), error: t('kit.error'), required: true }).element,
      field({ label: t('kit.search'), type: 'search', prefix: 'search' }).element,
      field({ label: t('kit.notes'), type: 'textarea', placeholder: t('kit.notesPlaceholder') }).element,
      field({ label: t('kit.transport'), type: 'select', value: 'train', options: ['train', 'walk', 'car'].map((value) => ({ value, label: t(`kit.${value}`) })) }).element,
      switchField(t('kit.notifications'), { checked: true }), checkbox(t('kit.checklist')),
      choiceGroup({ label: t('kit.transport'), items: ['train', 'walk'].map((value) => ({ value, label: t(`kit.${value}`) })) }).element,
      segmented({ label: t('kit.view'), items: ['list', 'map'].map((value) => ({ value, label: t(`kit.${value}`) })) }).element,
    ),
    section('kit.dates', stack(dateField({ label: t('kit.departure'), value: '2026-11-09' }).element,
      dateRangePicker({ start: '2026-11-09', end: '2026-11-13' }).element)),
    section('kit.overlays', stack(row(
      button(t('kit.modal'), { onclick: () => showDialog() }), button(t('kit.sheet'), { onclick: () => showDialog('sheet') }),
      button(t('kit.drawer'), { onclick: () => showDialog('drawer') }), menuButton), demoStatus)),
    section('kit.people', stack(row(...people.slice(0, 3).map((person, index) => avatar({ ...person, presence: ['online', 'away', 'offline'][index] }))),
      avatarStack(people), row(...dayChips), row(chip(t('kit.confirmed'), { status: 'success' }), chip(t('kit.pending'), { status: 'warn' }), chip(t('kit.train'), { onRemove: (event) => event.currentTarget.closest('.chip').remove() })))),
    section('kit.tabs', tabset.element),
    section('kit.sorting', stack(el('p.field-hint', {}, t('ui.reorderHint')), stops)),
    section('kit.markdown', markdown(t('kit.markdownSample'))),
    section('kit.states', stack(emptyState({ title: t('kit.empty'), body: t('kit.emptyBody'), action: button(t('kit.primary'), { variant: 'primary', icon: 'plus', onclick: showSaved }) }),
      el('div.kit-loading', {}, spinner(), el('div.kit-loading-lines', {}, skeleton(), skeleton('70%'))))),
    section('kit.virtual', virtual.element),
    section('kit.stats', stack(el('div.stats', {}, [['days', 5], ['places', 18], ['budget', new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(840)]].map(([key, value]) => el('div.stat', {}, el('strong.num', {}, value), el('span', {}, t(`kit.${key}`))))),
      el('label.field', {}, el('span.field-label', {}, t('kit.progress')), el('progress.meter', { max: 100, value: 65, 'aria-label': t('kit.progress') })))),
  ));
document.body.append(el('a.skip-link', { href: '#components' }, t('kit.skip')), main);
applyTheme(currentTheme(), { persist: false });
document.documentElement.dataset.kit = 'ready';
window.addEventListener('pagehide', () => { sortable.destroy(); virtual.destroy(); }, { once: true });

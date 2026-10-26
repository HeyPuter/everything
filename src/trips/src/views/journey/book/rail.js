// The left rail: pages, content (journey photos and entries), elements, travel and layouts.
import { el, uid } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { tabs } from '../../../ui/tabs.js';
import { openMenu } from '../../../ui/menu.js';
import { makeDragSource, makeSortable } from '../../../ui/dnd.js';
import { t, locale } from '../../../lib/i18n/index.js';
import { formatDate, formatNumber } from '../../../lib/format.js';
import { COUNTRY_CODES, countryName } from '../../../lib/atlas/countries.js';
import { ICONS, STATS, TEXT_STYLES } from '../../../lib/book/constants.js';
import { layoutsFor } from '../../../lib/book/layouts.js';
import { fileOf, isImageFile, mediaTile } from '../media.js';
import { createSheet } from './sheet.js';
import { BOOK_ICONS, icon, withIcon } from './icons.js';

const SECTIONS = ['pages', 'content', 'elements', 'travel', 'layouts'];
const SECTION_ICONS = { pages: 'book', content: 'photos', elements: 'elements', travel: 'map', layouts: 'layouts' };

/** The page label for a sheet: Cover, Back cover, Page n, Pages n–m. */
export function sheetName(sheet) {
  const kind = sheet.page.kind;
  if (kind === 'cover') return t('book.page.cover');
  if (kind === 'back') return t('book.page.back');
  if (sheet.numbers.length === 2) return t('book.page.spread', { from: formatNumber(sheet.numbers[0]), to: formatNumber(sheet.numbers[1]) });
  return t('book.page.single', { number: formatNumber(sheet.numbers[0]) });
}

function layoutDiagram(layout) {
  return el('span.bk-diagram', { 'aria-hidden': 'true', dataset: { spread: String(layout.id.startsWith('spread')) } },
    layout.slots.map((slot) => el(`span.bk-slot.is-${slot.k}`, { style: {
      insetInlineStart: `${Math.max(0, slot.x) * 100}%`, insetBlockStart: `${Math.max(0, slot.y) * 100}%`, width: `${Math.min(1, slot.w) * 100}%`, height: `${Math.min(1, slot.h) * 100}%`,
    } })));
}

/**
 * `opts`: `{space, canEdit(), state() → {book, shape, sheetIndex, page, used, peersByPage, entries}, ctx(), palette(),
 * go(index), moveSpread(from, to), addSpread(), duplicate(page), remove(page), autoBook(), fill(), add(payload),
 * layout(id), auto(), upload()}`.
 */
export function createRail(opts) {
  const { space } = opts;
  const panes = Object.fromEntries(SECTIONS.map((id) => [id, el('div.bk-rail-pane', { dataset: { pane: id } })]));
  const items = SECTIONS.map((id) => ({ id, label: t(`book.rail.${id}`), content: el('div.bk-rail-section', {}, el('h3.bk-rail-title', {}, t(`book.rail.${id}`)), panes[id]) }));
  const set = tabs({ label: t('book.rail.label'), items, value: 'pages', onChange: () => render() });
  [...set.element.querySelectorAll('.tab')].forEach((node, index) => { node.prepend(icon(SECTION_ICONS[SECTIONS[index]], 18)); node.title = items[index].label; });
  const element = el('section.bk-rail', { 'aria-label': t('book.rail.label') }, set.element);
  const thumbs = new Map();
  const cleanups = [];
  let sortable = null;
  let hideUsed = false;
  let country = null;

  // ---- pages
  const singlesTop = el('ol.bk-pages');
  const spreadList = el('ol.bk-pages.bk-spreads');
  const singlesEnd = el('ol.bk-pages');
  const pageActions = el('div.bk-rail-actions');
  panes.pages.append(singlesTop, spreadList, singlesEnd, pageActions);

  function thumbFor(page) {
    let entry = thumbs.get(page.id);
    if (entry && entry.kind !== page.kind) { entry.sheet.destroy(); entry = null; }
    if (!entry) {
      const sheet = createSheet({ book: opts.state().book, page, mode: 'thumb', ctx: opts.ctx, palette: opts.palette() });
      entry = { sheet, page, kind: page.kind };
      thumbs.set(page.id, entry);
    } else if (entry.page !== page) { entry.page = page; entry.sheet.update(page); }
    return entry.sheet.element;
  }

  function pageItem(sheet, { sortableItem = false } = {}) {
    const { page } = sheet;
    const state = opts.state();
    const current = state.sheetIndex === sheet.index;
    const name = sheetName(sheet);
    const peers = state.peersByPage.get(page.id) ?? [];
    const open = el('button.bk-page-open', { type: 'button', 'aria-current': current ? 'page' : null, 'aria-label': peers.length ? t('book.page.withPeople', { name, people: peers.map((peer) => peer.name).join(', ') }) : name,
      onclick: () => opts.go(sheet.index) }, el('span.bk-page-thumb', { dataset: { kind: page.kind } }, thumbFor(page)), el('span.bk-page-name', {}, name),
    peers.length ? el('span.bk-page-peers', { 'aria-hidden': 'true' }, peers.slice(0, 3).map((peer) => el('span.bk-badge', { style: { '--peer': peer.color }, title: peer.name }, [...peer.name][0] ?? '?'))) : null);
    const row = el('li.bk-page', { dataset: { id: page.id, ...(sortableItem ? { sortableItem: '', label: name } : {}) }, 'aria-current': current ? 'true' : null }, open);
    if (sortableItem && opts.canEdit()) {
      row.prepend(el('button.bk-grip', { type: 'button', dataset: { sortableHandle: '' }, 'aria-label': t('book.page.reorder', { name }) }, icon('grip', 14)));
      const more = el('button.icon-btn.icon-btn-sm.bk-page-more', { type: 'button', 'aria-label': t('book.page.actions', { name }), title: t('book.page.actions', { name }), onclick: () => openMenu(more, [
        { label: t('book.page.duplicate'), icon: 'copy', onSelect: () => opts.duplicate(page) },
        { label: t('book.page.addAfter'), icon: 'plus', onSelect: () => opts.addSpread(page) },
        { separator: true },
        { label: t('book.page.delete'), icon: 'trash', danger: true, onSelect: () => opts.remove(page) },
      ]) }, icon('more', 16));
      row.append(more);
    }
    return row;
  }

  function renderPages() {
    const { shape } = opts.state();
    const singles = (kinds) => shape.sheets.filter((sheet) => kinds.includes(sheet.page.kind)).map((sheet) => pageItem(sheet));
    singlesTop.replaceChildren(...singles(['cover', 'first']));
    singlesEnd.replaceChildren(...singles(['last', 'back']));
    spreadList.replaceChildren(...shape.sheets.filter((sheet) => sheet.page.kind === 'spread').map((sheet) => pageItem(sheet, { sortableItem: true })));
    sortable?.destroy();
    sortable = opts.canEdit() ? makeSortable(spreadList, { onMove: ({ from, to }) => opts.moveSpread(from, to) }) : null;
    const live = new Set(shape.sheets.map((sheet) => sheet.page.id));
    for (const [id, entry] of thumbs) if (!live.has(id)) { entry.sheet.destroy(); thumbs.delete(id); }
    pageActions.replaceChildren(...(opts.canEdit() ? [
      button(t('book.page.add'), { icon: 'plus', size: 'sm', variant: 'outline', onclick: () => opts.addSpread(null) }),
      button(t('book.autoBook'), { size: 'sm', variant: 'ghost', onclick: () => opts.autoBook() }),
      button(t('book.fill'), { size: 'sm', variant: 'ghost', onclick: () => opts.fill() }),
    ] : []));
  }

  // ---- content
  const photoGroups = el('div.bk-content');
  const hideId = uid('bk-hide');
  const hideBox = el('input', { type: 'checkbox', id: hideId, onchange: () => { hideUsed = hideBox.checked; renderContent(); } });
  const uploadButton = button(t('book.upload'), { icon: 'plus', size: 'sm', variant: 'outline', onclick: () => opts.upload() });
  panes.content.append(el('div.bk-rail-actions', {}, uploadButton, el('label.check-field', { htmlFor: hideId }, hideBox, el('span', {}, t('book.hideUsed')))), photoGroups);
  cleanups.push(makeDragSource(photoGroups, { itemSelector: '[data-drag]', handle: null, longPress: true, data: (node) => JSON.parse(node.dataset.drag) }).destroy);

  function photoTile(fileId, used) {
    const file = fileOf(space, fileId) ?? space.get('file', fileId);
    const label = t(used ? 'book.addPhotoUsed' : 'book.addPhoto', { name: file?.desc || file?.name || '' });
    return el('li', {}, el('button.bk-photo-tile', { type: 'button', 'aria-label': label, title: label, disabled: !opts.canEdit(), dataset: { drag: JSON.stringify({ type: 'photo', fileId }) },
      onclick: () => opts.add({ type: 'photo', fileId }) }, mediaTile(space, fileId, { className: 'bk-tile' }), used ? el('span.bk-used', { 'aria-hidden': 'true' }, icon('check', 12)) : null));
  }

  function renderContent() {
    const { used, entries } = opts.state();
    const groups = [];
    const seen = new Set();
    for (const entry of entries) {
      const photos = (entry.media ?? []).filter((id) => !seen.has(id) && isImageFile(fileOf(space, id)));
      photos.forEach((id) => seen.add(id));
      const shown = hideUsed ? photos.filter((id) => !used.has(id)) : photos;
      const headingId = uid('bk-entry');
      groups.push(el('section.bk-group', { 'aria-labelledby': headingId },
        el('h3.bk-group-head', { id: headingId }, el('span', {}, entry.title), el('span.bk-muted', {}, formatDate(entry.date))),
        opts.canEdit() ? el('button.bk-entry-add', { type: 'button', dataset: { drag: JSON.stringify({ type: 'entry', entryId: entry.id }) }, onclick: () => opts.add({ type: 'entry', entryId: entry.id }) },
          icon('text', 14), t('book.addEntryText')) : null,
        shown.length ? el('ul.bk-photo-grid', {}, shown.map((id) => photoTile(id, used.has(id)))) : null));
    }
    const others = space.select.file.all().filter((file) => file.kind === 'user' && !file.trashed && !seen.has(file.id) && isImageFile(file) && !(hideUsed && used.has(file.id)));
    if (others.length) {
      const headingId = uid('bk-entry');
      groups.push(el('section.bk-group', { 'aria-labelledby': headingId }, el('h3.bk-group-head', { id: headingId }, t('book.otherPhotos')),
        el('ul.bk-photo-grid', {}, others.map((file) => photoTile(file.id, used.has(file.id))))));
    }
    photoGroups.replaceChildren(...(groups.length ? groups : [el('p.bk-muted', {}, t('book.noContent'))]));
    uploadButton.hidden = !opts.canEdit() || !space.can('files.upload');
  }

  // ---- elements
  const countryId = uid('bk-country');
  const countrySelect = el('select.select', { id: countryId, onchange: () => { country = countrySelect.value; } });
  const addButton = (label, payload, glyph) => el('button.bk-add', { type: 'button', dataset: { drag: JSON.stringify(payload) }, onclick: () => opts.add(payload) }, glyph && icon(glyph, 16), el('span', {}, label));
  function renderElements() {
    if (!countrySelect.options.length) {
      const codes = [...COUNTRY_CODES].map((code) => ({ code, name: countryName(code, locale) })).sort((a, b) => a.name.localeCompare(b.name, locale));
      for (const { code, name } of codes) countrySelect.append(el('option', { value: code }, name));
      const counts = new Map();
      for (const entry of opts.state().entries) if (entry.loc?.cc) counts.set(entry.loc.cc, (counts.get(entry.loc.cc) ?? 0) + 1);
      country = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? codes[0]?.code ?? 'PT';
      countrySelect.value = country;
    }
    const group = (key, ...children) => el('section.bk-group', {}, el('h3.bk-group-head', {}, t(key)), el('div.bk-adds', {}, children));
    panes.elements.replaceChildren(
      group('book.group.text', TEXT_STYLES.map((style) => addButton(t(`book.style.${style}`), { type: 'element', preset: { k: 'text', style } }, 'text'))),
      group('book.group.shapes', addButton(t('book.shape.rect'), { type: 'element', preset: { k: 'shape', shape: 'rect' } }, 'rect'),
        addButton(t('book.shape.ellipse'), { type: 'element', preset: { k: 'shape', shape: 'ellipse' } }, 'ellipse'),
        addButton(t('book.shape.line'), { type: 'element', preset: { k: 'line' } }, 'line')),
      group('book.group.grids', ...[[2, 2], [3, 2], [3, 3]].map(([cols, rows]) => addButton(t('book.grid', { cols, rows }), { type: 'grid', cols, rows }, 'grid'))),
      el('section.bk-group', {}, el('h3.bk-group-head', {}, t('book.group.icons')),
        el('div.bk-icons', {}, ICONS.filter((name) => BOOK_ICONS[name]).map((name) => el('button.bk-icon-add', { type: 'button', 'aria-label': t('book.addIcon', { name: t(`book.icon.${name}`) }), title: t(`book.icon.${name}`),
          dataset: { drag: JSON.stringify({ type: 'element', preset: { k: 'icon', icon: name } }) }, onclick: () => opts.add({ type: 'element', preset: { k: 'icon', icon: name } }) }, icon(name, 20))))),
      el('section.bk-group', {}, el('h3.bk-group-head', {}, t('book.group.countries')),
        el('div.field', {}, el('label.field-label', { htmlFor: countryId }, t('book.country')), countrySelect),
        el('div.bk-adds', {}, el('button.bk-add', { type: 'button', onclick: () => opts.add({ type: 'element', preset: { k: 'flag', cc: country } }) }, icon('flag', 16), el('span', {}, t('book.addFlag'))),
          el('button.bk-add', { type: 'button', onclick: () => opts.add({ type: 'element', preset: { k: 'country', cc: country } }) }, icon('map', 16), el('span', {}, t('book.addCountry'))))),
    );
  }
  cleanups.push(makeDragSource(panes.elements, { itemSelector: '[data-drag]', handle: null, longPress: true, data: (node) => JSON.parse(node.dataset.drag) }).destroy);

  // ---- travel
  function renderTravel() {
    const group = (key, ...children) => el('section.bk-group', {}, el('h3.bk-group-head', {}, t(key)), el('div.bk-adds', {}, children));
    panes.travel.replaceChildren(
      group('book.group.maps', addButton(t('book.map.book'), { type: 'element', preset: { k: 'map', scope: 'book' } }, 'map'),
        addButton(t('book.map.page'), { type: 'element', preset: { k: 'map', scope: 'page' } }, 'map'),
        addButton(t('book.route.book'), { type: 'element', preset: { k: 'route', scope: 'book' } }, 'route'),
        addButton(t('book.route.page'), { type: 'element', preset: { k: 'route', scope: 'page' } }, 'route')),
      group('book.group.stats', addButton(t('book.stat.summary'), { type: 'element', preset: { k: 'stats' } }, 'stats'),
        ...STATS.map((stat) => addButton(t(`book.statName.${stat}`), { type: 'element', preset: { k: 'stats', stat } }, 'stats'))),
      opts.state().entries.some((entry) => Number.isFinite(entry.loc?.lat)) ? null : el('p.bk-muted', {}, t('book.noLocations')),
    );
  }
  cleanups.push(makeDragSource(panes.travel, { itemSelector: '[data-drag]', handle: null, longPress: true, data: (node) => JSON.parse(node.dataset.drag) }).destroy);

  // ---- layouts
  function renderLayouts() {
    const { page } = opts.state();
    if (!page) { panes.layouts.replaceChildren(); return; }
    const list = layoutsFor(page.kind);
    panes.layouts.replaceChildren(
      el('div.bk-rail-actions', {}, withIcon(button(t('book.autoPage'), { size: 'sm', variant: 'outline', disabled: !opts.canEdit(), onclick: () => opts.auto() }), 'auto')),
      el('p.bk-muted', {}, t(page.kind === 'spread' ? 'book.layoutsSpread' : 'book.layoutsCover', { count: list.length })),
      el('ul.bk-layouts', {}, list.map((layout) => el('li', {}, el('button.bk-layout', { type: 'button', disabled: !opts.canEdit(), 'aria-pressed': String(page.layout === layout.id),
        'aria-label': t('book.applyLayout', { name: t(`book.layout.${layout.id}`) }), title: t(`book.layout.${layout.id}`), onclick: () => opts.layout(layout.id) },
      layoutDiagram(layout), el('span.bk-layout-name', {}, t(`book.layout.${layout.id}`)))))),
    );
  }

  function render() {
    const section = set.value;
    if (section === 'pages') renderPages();
    else if (section === 'content') renderContent();
    else if (section === 'elements') renderElements();
    else if (section === 'travel') renderTravel();
    else renderLayouts();
  }

  render();
  return {
    element,
    render,
    show(section) { set.select(section); },
    get section() { return set.value; },
    destroy() {
      sortable?.destroy();
      for (const cleanup of cleanups) cleanup();
      for (const entry of thumbs.values()) entry.sheet.destroy();
      thumbs.clear();
    },
  };
}

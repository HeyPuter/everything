// The photo-book editor: a bar, the rail, the stage and the properties panel over one book. Edits go through the
// journey space's ops (element fields as path writes, whole-page replacements with a base version); live cursors
// travel over puter.peer (lib/book/peer.js).
import { el } from '../../../ui/dom.js';
import { button, iconButton } from '../../../ui/bits.js';
import { openMenu } from '../../../ui/menu.js';
import { openModal, confirmDialog } from '../../../ui/modal.js';
import { openSheet } from '../../../ui/sheet.js';
import { toast } from '../../../ui/toast.js';
import { openConflictDialog } from '../../../ui/conflict.js';
import { t, strings } from '../../../lib/i18n/index.js';
import { saveBlob } from '../../../lib/download.js';
import { formatDateRange, formatDate, formatNumber } from '../../../lib/format.js';
import { chooseLocalFiles, IMAGE_ACCEPT, startUpload, errorKey } from '../../../lib/files/index.js';
import { createHistory } from '../../../lib/store/history.js';
import { loadFeatures } from '../../../lib/sync/features.js';
import { newId } from '../../../shared/ids.js';
import { can } from '../../../shared/perms.js';
import { BOOK_LIMITS } from '../../../lib/book/constants.js';
import { sheetSize } from '../../../lib/book/formats.js';
import { applyLayout, autoLayout, clampBox, elementsOf, missingKinds, restack, structure, topZ, usedEntries, usedPhotos } from '../../../lib/book/model.js';
import { duplicateFields, insertOrders, moveOrder, spreadRoom } from '../../../lib/book/order.js';
import { addElements, createBookOps, elementChange, elementsChange, pageFields, removeElements, replacePage, singleOps, withoutBase } from '../../../lib/book/ops.js';
import { autofillPlan, clip, plainText } from '../../../lib/book/autofill.js';
import { designFileName, exportDesign, parseDesign } from '../../../lib/book/design.js';
import { createPresence, kvRendezvous } from '../../../lib/book/peer.js';
import { roleIn } from '../../trip/members/logic.js';
import { personAvatar } from '../../trip/members/people.js';
import { errorText, personalOf, sameRef, uidOf } from '../spaces.js';
import { fileOf, isImageFile, mediaTile } from '../media.js';
import { icon } from './icons.js';
import { applyPalette, lightPalette } from './palette.js';
import { countryShapes } from './travel-svg.js';
import { bookStats, countText, storyEntries } from './stats.js';
import { createStage } from './stage.js';
import { createRail, sheetName } from './rail.js';
import { createProps } from './props.js';
import { openBookForm } from './create.js';

const storageKey = (sid) => `trips:book:${sid}`;
const label = (key, fallback) => (Object.hasOwn(strings, key) ? t(key) : fallback);
function readLocal(sid) { try { const value = JSON.parse(localStorage.getItem(storageKey(sid)) ?? '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }
function writeLocal(sid, value) { try { localStorage.setItem(storageKey(sid), JSON.stringify(value)); } catch { /* storage may be off */ } }
const colorSlot = (member, uid) => {
  if (Number.isInteger(member?.color) && member.color >= 1 && member.color <= 8) return member.color;
  let hash = 0;
  for (const char of String(uid)) hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0;
  return (hash % 8) + 1;
};

/** Books of the journey, oldest first. */
export const booksOf = (space) => space.select.book.all().filter((book) => !book.deleted);

/** Creates a book (filled from the journey when asked) and resolves to its id. */
export async function createBook(space, { title, fmt, w, h, fill }) {
  const fields = { title, fmt, ...(fmt === 'custom' ? { w, h } : {}) };
  let plan = {};
  if (fill) {
    const entries = storyEntries(space);
    const meta = space.get('meta', 'meta') ?? {};
    const isPhoto = (id) => isImageFile(fileOf(space, id));
    const dates = entries.map((entry) => entry.date);
    const range = dates.length ? formatDateRange(dates[0], dates.at(-1)) : '';
    const coverFile = typeof meta.cover === 'string' && isPhoto(meta.cover) ? meta.cover : null;
    const made = autofillPlan({ entries, meta: { title: title || meta.title, subtitle: meta.subtitle }, book: fields, makeId: newId, isPhoto, coverFile, formatDate: (date) => formatDate(date), range });
    plan = { singles: made.singles, spreads: made.spreads };
  } else plan = { spreads: [applyLayout({ kind: 'spread', els: {} }, 'spread-pair', { book: fields, makeId: newId })] };
  const { id, ops } = createBookOps(space.ops, fields, plan);
  await space.apply(ops);
  return id;
}

/** Mounts the editor for `bookId`. Returns `{destroy}`. */
export function mountEditor(container, { space, context, ref, bookId, onSwitch }) {
  const me = uidOf(context);
  const local = readLocal(ref.s);
  const state = { sheetIndex: local.book === bookId && Number.isInteger(local.sheet) ? local.sheet : 0, selected: null, palette: null, shapes: null, clipboard: null };
  const offs = [];
  let destroyed = false;
  let frame = 0;
  let presence = null;
  let peers = [];
  let drawerHome = null;
  let repairing = false;

  const role = () => roleIn(space, me);
  const canEdit = () => can(role(), 'plan.edit', space.get('meta', 'meta')?.perms ?? {});
  const book = () => space.get('book', bookId);
  const shapeNow = () => structure(space.select.bookPage.all(), bookId);
  let shape = shapeNow();
  let entries = storyEntries(space);
  let stats = bookStats(space);
  let travelVersion = 0;
  const currentSheet = () => shape.sheets[Math.min(state.sheetIndex, Math.max(0, shape.sheets.length - 1))] ?? null;
  const page = () => currentSheet()?.page ?? null;
  const ctx = () => ({ space, entries, stats, shapes: state.shapes, travelKey: String(travelVersion) });
  const history = createHistory({ apply: (ops) => space.apply(ops), get: (type, id) => space.get(type, id) });

  // ---- writing
  async function edit(list, historyLabel) {
    if (!list.length || !canEdit()) return false;
    const recorded = historyLabel ? history.record(historyLabel, withoutBase(list)) : false;
    try { await space.apply(list); return true; } catch (error) { if (recorded) history.forget(); toast(errorText(error)); return false; }
  }
  const changeElements = (changes, historyLabel) => { const target = page(); if (target) void edit([elementsChange(space.ops, target.id, changes)], historyLabel); };
  const changeElement = (id, fields, historyLabel) => { const target = page(); if (target) void edit([elementChange(space.ops, target.id, id, fields)], historyLabel); };
  async function undo() { if (!history.canUndo) return; try { const name = await history.undo(); stage.announce(t('book.undone', { action: name })); } catch (error) { toast(errorText(error)); } }
  async function redo() { if (!history.canRedo) return; try { const name = await history.redo(); stage.announce(t('book.redone', { action: name })); } catch (error) { toast(errorText(error)); } }

  // ---- adding content
  function defaultBox(target, wMm, hMm, at = null) {
    const size = sheetSize(book(), target.kind);
    const w = Math.min(0.9, wMm / size.w);
    const h = Math.min(0.9, hMm / size.h);
    const cx = at?.x ?? (target.kind === 'spread' ? 0.75 : 0.5);
    const cy = at?.y ?? 0.5;
    return clampBox({ x: cx - w / 2, y: cy - h / 2, w, h });
  }
  function presetElement(target, payload, at) {
    const z = topZ(target) + 1;
    const preset = payload.preset ?? {};
    if (payload.type === 'photo') return { k: 'photo', file: payload.fileId, fit: 'fill', z, ...defaultBox(target, 80, 60, at) };
    if (payload.type === 'entry') {
      const entry = space.get('entry', payload.entryId);
      if (!entry) return null;
      const story = clip(plainText(entry.story), 1200);
      return { k: 'text', text: story ? `${entry.title}\n\n${story}` : entry.title, style: 'body', size: 10, entry: entry.id, z, ...defaultBox(target, 80, 70, at) };
    }
    switch (preset.k) {
      case 'text': {
        const sizes = { title: 26, subtitle: 13, heading: 16, body: 10, caption: 8, quote: 18 };
        return { k: 'text', style: preset.style, text: t(`book.sample.${preset.style}`), size: sizes[preset.style] ?? 10, ...(preset.style === 'quote' ? { font: 'serif', italic: true, align: 'center' } : {}),
          z, ...defaultBox(target, preset.style === 'body' ? 80 : 100, preset.style === 'body' ? 50 : 18, at) };
      }
      case 'shape': return { k: 'shape', shape: preset.shape, fill: 'surface-2', z, ...defaultBox(target, 50, 50, at) };
      case 'line': return { k: 'line', stroke: 0.5, color: 'ink', z, ...defaultBox(target, 80, 4, at) };
      case 'icon': return { k: 'icon', icon: preset.icon, color: 'ink', z, ...defaultBox(target, 16, 16, at) };
      case 'flag': return { k: 'flag', cc: preset.cc, z, ...defaultBox(target, 24, 18, at) };
      case 'country': return { k: 'country', cc: preset.cc, fill: 'day-1', z, ...defaultBox(target, 60, 60, at) };
      case 'map': return { k: 'map', scope: preset.scope ?? 'book', fill: 'surface-2', color: 'day-1', z, ...defaultBox(target, 100, 75, at) };
      case 'route': return { k: 'route', scope: preset.scope ?? 'book', color: 'day-1', z, ...defaultBox(target, 100, 75, at) };
      case 'stats': return { k: 'stats', ...(preset.stat ? { stat: preset.stat } : {}), size: preset.stat ? 20 : 11, align: 'center', z, ...defaultBox(target, 120, preset.stat ? 16 : 24, at) };
      default: return null;
    }
  }
  function gridElements(target, cols, rows) {
    const size = sheetSize(book(), target.kind);
    const [left, width] = target.kind === 'spread' ? [0.5, 0.5] : [0, 1];
    const mx = (12 / size.w);
    const my = 12 / size.h;
    const gap = 4 / size.w;
    const gapY = 4 / size.h;
    const cellW = (width - mx * 2 - gap * (cols - 1)) / cols;
    const cellH = (1 - my * 2 - gapY * (rows - 1)) / rows;
    const els = {};
    let z = topZ(target);
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      z += 1;
      els[newId()] = { k: 'photo', fit: 'fill', z, x: left + mx + col * (cellW + gap), y: my + row * (cellH + gapY), w: cellW, h: cellH };
    }
    return els;
  }
  async function add(payload, at = null, targetId = null) {
    const target = page();
    if (!target || !canEdit()) return;
    if (payload.type === 'photo') {
      const items = elementsOf(target);
      const hit = targetId ? items.find((item) => item.id === targetId && item.k === 'photo') : null;
      const empty = hit ?? (at ? null : items.find((item) => item.id === state.selected && item.k === 'photo' && !item.file) ?? items.find((item) => item.k === 'photo' && !item.file));
      if (empty) { await edit([elementChange(space.ops, target.id, empty.id, { file: payload.fileId })], t('book.history.photo')); select(empty.id); return; }
    }
    if (Object.keys(target.els ?? {}).length >= BOOK_LIMITS.elements) { toast(t('book.tooManyElements', { count: BOOK_LIMITS.elements })); return; }
    if (payload.type === 'grid') { await edit([addElements(space.ops, target.id, gridElements(target, payload.cols, payload.rows))], t('book.history.add')); return; }
    const item = presetElement(target, payload, at);
    if (!item) return;
    const id = newId();
    if (await edit([addElements(space.ops, target.id, { [id]: item })], t('book.history.add'))) { select(id); stage.announce(t('book.added', { name: label(`book.el.${item.k}`, item.k) })); }
  }
  async function upload() {
    if (!space.can('files.upload')) return;
    const files = await chooseLocalFiles({ accept: IMAGE_ACCEPT, multiple: true });
    let added = 0;
    for (const file of files) {
      try { await startUpload(space, file, {}).run(); added += 1; } catch (error) { toast(`${file.name}: ${t(errorKey(error))}`); }
    }
    if (added) toast(countText('book.uploaded', added));
  }

  // ---- element actions
  function duplicate(id) {
    const target = page();
    const item = target?.els?.[id];
    if (!item) return;
    const copy = { ...structuredClone(item), ...clampBox({ x: item.x + 0.02, y: item.y + 0.02, w: item.w, h: item.h }), z: topZ(target) + 1 };
    delete copy.lock;
    const next = newId();
    void edit([addElements(space.ops, target.id, { [next]: copy })], t('book.history.duplicate')).then((done) => { if (done) select(next); });
  }
  function remove(id) {
    const target = page();
    if (!target?.els?.[id]) return;
    void edit([removeElements(space.ops, target.id, [id])], t('book.history.delete')).then((done) => { if (done) { select(null); stage.announce(t('book.deleted')); stage.viewport.focus({ preventScroll: true }); } });
  }
  function addCaption(id) {
    const target = page();
    const item = target?.els?.[id];
    if (!item) return;
    const size = sheetSize(book(), target.kind);
    const h = Math.min(0.12, 9 / size.h);
    const below = item.y + item.h + 2 / size.h;
    const y = below + h <= 1 ? below : Math.max(0, item.y - h - 2 / size.h);
    const desc = item.file ? space.get('file', item.file)?.desc?.trim() : '';
    const caption = { k: 'text', style: 'caption', size: 8, text: desc || t('book.sample.caption'), ...(item.entry ? { entry: item.entry } : {}),
      ...clampBox({ x: item.x, y, w: item.w, h }), z: topZ(target) + 1 };
    const next = newId();
    void edit([addElements(space.ops, target.id, { [next]: caption })], t('book.history.add')).then((done) => { if (done) select(next); });
  }
  function restackElement(id, where) {
    const target = page();
    const changes = restack(target, id, where);
    if (Object.keys(changes).length) changeElements(Object.fromEntries(Object.entries(changes).map(([eid, z]) => [eid, { z }])), t('book.history.order'));
  }
  function choosePhoto(id) {
    const photos = [];
    const seen = new Set();
    for (const entry of entries) for (const fileId of entry.media ?? []) if (!seen.has(fileId) && isImageFile(fileOf(space, fileId))) { seen.add(fileId); photos.push(fileId); }
    for (const file of space.select.file.all()) if (file.kind === 'user' && !file.trashed && !seen.has(file.id) && isImageFile(file)) photos.push(file.id);
    const grid = el('ul.bk-photo-grid.bk-photo-choose', {}, photos.map((fileId) => el('li', {}, el('button.bk-photo-tile', { type: 'button', 'aria-label': t('book.usePhoto', { name: fileOf(space, fileId)?.desc || fileOf(space, fileId)?.name || '' }),
      onclick: () => { dialog.close(); changeElement(id, { file: fileId }, t('book.history.photo')); } }, mediaTile(space, fileId, { className: 'bk-tile' })))));
    const dialog = openModal({ title: t('book.choosePhoto'), content: photos.length ? grid : el('p', {}, t('book.noPhotos')), wide: true });
  }

  // ---- page actions
  async function replaceWith(result, historyLabel) {
    const target = page();
    if (!target) return;
    await edit([replacePage(space.ops, target.id, result)], historyLabel);
  }
  function applyNamedLayout(id) {
    const target = page();
    if (!target || !canEdit()) return;
    void replaceWith(applyLayout(target, id, { book: book(), makeId: newId }), t('book.history.layout'));
  }
  function autoPage() {
    const target = page();
    if (!target || !canEdit()) return;
    void replaceWith(autoLayout(target, { book: book(), makeId: newId, variant: currentSheet().index }), t('book.history.auto'));
  }
  async function autoBook() {
    if (!canEdit()) return;
    const list = shape.sheets.map((sheet) => replacePage(space.ops, sheet.page.id, autoLayout(sheet.page, { book: book(), makeId: newId, variant: sheet.index })));
    if (await edit(list, t('book.history.autoBook'))) toast(t('book.autoBookDone'));
  }
  async function fill() {
    if (!canEdit()) return;
    const pages = shape.sheets.map((sheet) => sheet.page);
    const room = spreadRoom(shape.spreads);
    const plan = autofillPlan({ entries, book: book(), makeId: newId, isPhoto: (id) => isImageFile(fileOf(space, id)), used: usedPhotos(pages), usedEntries: usedEntries(pages),
      formatDate: (date) => formatDate(date), room, variant: shape.spreads.length, singles: false });
    if (!plan.spreads.length) { toast(t(room ? 'book.fillNothing' : 'book.fullBook')); return; }
    const orders = insertOrders(shape.spreads, shape.spreads.length, plan.spreads.length);
    const list = plan.spreads.map((item, index) => space.ops.create('bookPage', pageFields(bookId, 'spread', orders[index], item)));
    if (await edit(list, null)) toast(countText('book.filled', list.length));
  }
  async function addSpread(after) {
    if (!canEdit()) return;
    if (!spreadRoom(shape.spreads)) { toast(t('book.fullBook')); return; }
    const index = after ? shape.spreads.findIndex((item) => item.id === after.id) + 1 : (page()?.kind === 'spread' ? shape.spreads.findIndex((item) => item.id === page().id) + 1 : shape.spreads.length);
    const [order] = insertOrders(shape.spreads, index, 1);
    const create = space.ops.create('bookPage', pageFields(bookId, 'spread', order, applyLayout({ kind: 'spread', els: {} }, 'spread-pair', { book: book(), makeId: newId })));
    if (await edit([create], null)) goToPage(create.id);
  }
  async function duplicatePage(target) {
    if (!canEdit() || !spreadRoom(shape.spreads)) { if (canEdit()) toast(t('book.fullBook')); return; }
    const index = shape.spreads.findIndex((item) => item.id === target.id) + 1;
    const [order] = insertOrders(shape.spreads, index, 1);
    const create = space.ops.create('bookPage', duplicateFields(target, { makeId: newId, order }));
    if (await edit([create], null)) goToPage(create.id);
  }
  async function removePage(target) {
    if (!canEdit() || target.kind !== 'spread') return;
    const sheet = shape.sheets.find((item) => item.page.id === target.id);
    const ok = await confirmDialog({ title: t('book.page.deleteTitle', { name: sheet ? sheetName(sheet) : '' }), body: t('book.page.deleteBody'), confirmLabel: t('book.page.delete'), danger: true });
    if (!ok || destroyed) return;
    if (await edit([space.ops.remove('bookPage', target.id)], null)) { history.clear(); toast(t('book.page.deleted')); }
  }
  function moveSpread(from, to) {
    const order = moveOrder(shape.spreads, from, to);
    if (!order) return;
    const target = shape.spreads[from];
    void edit([space.ops.patch('bookPage', target.id, { set: { order } })], t('book.history.reorder'));
  }
  function pageChange(fields, historyLabel) {
    const target = page();
    if (!target) return;
    void edit([space.ops.patch('bookPage', target.id, { set: fields })], historyLabel);
  }
  function exportPageDesign() {
    const target = page();
    if (!target) return;
    const blob = new Blob([JSON.stringify(exportDesign(target, { book: book() }), null, 2)], { type: 'application/json' });
    saveBlob(blob, designFileName(book()?.title, currentSheet().index));
  }
  async function importPageDesign() {
    const target = page();
    if (!target || !canEdit()) return;
    const [file] = await chooseLocalFiles({ accept: '.json,application/json', multiple: false });
    if (!file) return;
    try {
      const parsed = parseDesign(await file.text(), { kind: target.kind, makeId: newId, hasFile: (id) => Boolean(space.get('file', id)) });
      await replaceWith({ layout: parsed.layout, els: parsed.els, bg: parsed.bg ?? null }, t('book.history.import'));
      toast(parsed.skipped ? countText('book.importedSkipped', parsed.skipped) : t('book.imported'));
    } catch (error) {
      toast(t(error?.message === 'design_kind' ? (target.kind === 'spread' ? 'book.designNotSpread' : 'book.designNotPage') : error?.message === 'design_large' ? 'book.designLarge' : 'book.designInvalid'));
    }
  }

  // ---- book actions
  async function settings() {
    const current = book();
    if (!current) return;
    const values = await openBookForm({ book: current, onDelete: canEdit() ? () => void deleteBook() : undefined });
    if (!values || destroyed) return;
    const set = { fmt: values.fmt, ...(values.title ? { title: values.title } : {}), ...(values.fmt === 'custom' ? { w: values.w, h: values.h } : {}) };
    const unset = [...(values.title ? [] : ['title']), ...(values.fmt === 'custom' ? [] : ['w', 'h'].filter((key) => current[key] !== undefined))];
    await edit([space.ops.patch('book', bookId, { set, unset })], null);
  }
  async function deleteBook() {
    const ok = await confirmDialog({ title: t('book.deleteTitle', { name: book()?.title || t('book.untitled') }), body: t('book.deleteBody'), confirmLabel: t('book.form.delete'), danger: true });
    if (!ok || destroyed) return;
    const pages = space.select.bookPage.all().filter((item) => item.book === bookId);
    if (await edit([...pages.map((item) => space.ops.remove('bookPage', item.id)), space.ops.remove('book', bookId)], null)) { toast(t('book.deleted')); onSwitch(null); }
  }
  async function newBook() {
    const values = await openBookForm({ title: space.get('meta', 'meta')?.title ?? '' });
    if (!values || destroyed) return;
    try { const id = await createBook(space, values); onSwitch(id); } catch (error) { toast(errorText(error)); }
  }

  // ---- navigation and selection
  function go(index) {
    const next = Math.max(0, Math.min(shape.sheets.length - 1, index));
    if (next === state.sheetIndex && page()) return;
    stage.flush();
    props.flush();
    state.sheetIndex = next;
    state.selected = null;
    writeLocal(ref.s, { book: bookId, sheet: next });
    presence?.update({ page: page()?.id ?? null, sel: null, x: null, y: null });
    schedule();
  }
  function goToPage(id) {
    shape = shapeNow();
    const index = shape.sheets.findIndex((sheet) => sheet.page.id === id);
    if (index >= 0) go(index);
  }
  function select(id) {
    if (state.selected === id) return;
    props.flush();
    state.selected = id;
    presence?.update({ sel: id });
    stage.refresh();
    props.render({ force: true });
    if (id) stage.announce(t('book.selected', { name: label(`book.el.${page()?.els?.[id]?.k}`, '') }));
  }

  // ---- DOM
  const titleButton = button('', { variant: 'ghost', size: 'sm', onclick: () => booksMenu(titleButton) });
  titleButton.classList.add('bk-title');
  const undoButton = iconButton('undo', t('book.undo'), { onclick: () => void undo() });
  const redoButton = iconButton('redo', t('book.redo'), { onclick: () => void redo() });
  for (const [node, glyph] of [[undoButton, 'undo'], [redoButton, 'redo']]) node.replaceChildren(icon(glyph, 18));
  const zoomOut = el('button.icon-btn', { type: 'button', 'aria-label': t('book.zoomOut'), title: t('book.zoomOut'), onclick: () => stage.zoomBy(1 / 1.25) }, icon('zoomOut', 18));
  const zoomFit = el('button.icon-btn', { type: 'button', 'aria-label': t('book.zoomFit'), title: t('book.zoomFit'), onclick: () => stage.zoomFit() }, icon('fit', 18));
  const zoomIn = el('button.icon-btn', { type: 'button', 'aria-label': t('book.zoomIn'), title: t('book.zoomIn'), onclick: () => stage.zoomBy(1.25) }, icon('zoomIn', 18));
  const pager = el('div.bk-pager', {},
    el('button.icon-btn', { type: 'button', 'aria-label': t('book.prevPage'), title: t('book.prevPage'), onclick: () => go(state.sheetIndex - 1) }, icon('chevronLeft', 18)),
    el('span.bk-pager-label', { 'aria-live': 'polite' }),
    el('button.icon-btn', { type: 'button', 'aria-label': t('book.nextPage'), title: t('book.nextPage'), onclick: () => go(state.sheetIndex + 1) }, icon('chevronRight', 18)));
  const people = el('div.bk-people');
  const syncNote = el('span.bk-sync', { role: 'status' });
  const printButton = button(t('book.printPdf'), { size: 'sm', variant: 'outline', onclick: () => void openPrint() });
  printButton.prepend(icon('print', 16));
  const moreButton = iconButton('more', t('book.more'), { onclick: () => moreMenu(moreButton) });
  const railButton = el('button.icon-btn.bk-phone-only', { type: 'button', 'aria-label': t('book.showRail'), title: t('book.showRail'), onclick: () => openDrawer('rail') }, icon('rail', 18));
  const propsButton = el('button.icon-btn.bk-phone-only', { type: 'button', 'aria-label': t('book.showProps'), title: t('book.showProps'), onclick: () => openDrawer('props') }, icon('props', 18));
  const conflictBar = el('div.bk-issue', { hidden: true });
  const bar = el('div.bk-bar', {}, el('div.bk-bar-group', {}, railButton, titleButton), el('div.bk-bar-group', {}, undoButton, redoButton), pager,
    el('div.bk-bar-group.bk-zoom', {}, zoomOut, zoomFit, zoomIn), el('div.bk-bar-group.bk-bar-end', {}, people, syncNote, printButton, propsButton, moreButton));

  const stage = createStage({
    book, canEdit, ctx, palette: () => state.palette, selected: () => state.selected, select,
    commit: (changes, historyLabel) => changeElements(changes, historyLabel),
    drop: (payload, point, targetId) => void add(payload, point, targetId),
    pointer: (point) => presence?.update(point ? { page: page()?.id ?? null, x: point.x, y: point.y } : { x: null, y: null }),
    dragging: (box) => presence?.update({ drag: box }),
    activate: (id) => { const item = page()?.els?.[id]; if (item?.k === 'text') { if (window.innerWidth < 900) openDrawer('props'); props.focusText(); } else if (item?.k === 'photo' && !item.file) choosePhoto(id); },
    remove,
    key: (event) => keys(event),
  });
  const rail = createRail({
    space, canEdit, ctx, palette: () => state.palette,
    state: () => ({ book: book(), shape, sheetIndex: state.sheetIndex, page: page(), used: usedPhotos(shape.sheets.map((sheet) => sheet.page)), peersByPage: peersByPage(), entries }),
    go, moveSpread, addSpread: (after) => void addSpread(after), duplicate: (target) => void duplicatePage(target), remove: (target) => void removePage(target),
    autoBook: () => void autoBook(), fill: () => void fill(), add: (payload) => void add(payload), layout: applyNamedLayout, auto: autoPage, upload: () => void upload(),
  });
  const props = createProps({
    canEdit, state: () => ({ book: book(), page: page(), selected: state.selected, size: page() ? sheetSize(book(), page().kind) : { w: 1, h: 1 } }),
    change: (id, fields, historyLabel) => changeElement(id, fields, historyLabel), preview: (id, fields) => stage.preview(id, fields), pageChange,
    duplicate, remove, restack: restackElement, replacePhoto: choosePhoto, caption: addCaption, auto: autoPage, exportDesign: exportPageDesign, importDesign: () => void importPageDesign(),
    layouts: () => { rail.show('layouts'); if (window.innerWidth < 900) openDrawer('rail'); },
  });
  const body = el('div.bk-body', {}, rail.element, stage.element, props.element);
  const root = el('section.bk-editor', { 'aria-label': t('book.editor') }, bar, conflictBar, body);
  container.replaceChildren(root);

  function openDrawer(which) {
    const node = which === 'rail' ? rail.element : props.element;
    drawerHome = { node, parent: node.parentElement, next: node.nextSibling };
    const sheet = openSheet({ title: t(which === 'rail' ? 'book.rail.label' : 'book.props.label'), content: node, onClose: () => {
      if (drawerHome?.node === node && !destroyed) drawerHome.parent.insertBefore(node, drawerHome.next?.parentElement === drawerHome.parent ? drawerHome.next : null);
      drawerHome = null;
    } });
    return sheet;
  }

  function booksMenu(anchor) {
    const books = booksOf(space);
    openMenu(anchor, [
      ...books.map((item) => ({ label: item.title || t('book.untitled'), checked: item.id === bookId, onSelect: () => { if (item.id !== bookId) onSwitch(item.id); } })),
      { separator: true },
      canEdit() && { label: t('book.newBook'), icon: 'plus', onSelect: () => void newBook() },
      { label: t('book.settings'), icon: 'pencil', disabled: !canEdit(), onSelect: () => void settings() },
    ].filter(Boolean));
  }
  function moreMenu(anchor) {
    const editable = canEdit();
    openMenu(anchor, [
      { label: t('book.exportImage'), icon: 'file', onSelect: () => void openExport() },
      { label: t('book.exportDesign'), icon: 'file', onSelect: () => exportPageDesign() },
      editable && { label: t('book.importDesign'), icon: 'file', onSelect: () => void importPageDesign() },
      { separator: true },
      editable && { label: t('book.autoBook'), onSelect: () => void autoBook() },
      editable && { label: t('book.fill'), onSelect: () => void fill() },
      { separator: true },
      editable && { label: t('book.settings'), icon: 'pencil', onSelect: () => void settings() },
      editable && { label: t('book.newBook'), icon: 'plus', onSelect: () => void newBook() },
      editable && { label: t('book.form.delete'), icon: 'trash', danger: true, onSelect: () => void deleteBook() },
    ].filter(Boolean));
  }
  async function openPrint() {
    const { openBookPrint } = await import('./print.js');
    await openBookPrint({ book: book(), shape, sheetIndex: currentSheet()?.index ?? 0, ctx, palette: state.palette, title: book()?.title || space.get('meta', 'meta')?.title || t('book.untitled') });
  }
  async function openExport() {
    const { openImageExport } = await import('./export.js');
    openImageExport({ space, book: book(), shape, sheetIndex: currentSheet()?.index ?? 0, ctx, palette: state.palette ?? new Map(), title: book()?.title || t('book.untitled') });
  }

  function keys(event) {
    const mod = event.ctrlKey || event.metaKey;
    if (event.target.closest?.('input, textarea, select, [contenteditable]')) return false;
    if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); void (event.shiftKey ? redo() : undo()); return true; }
    if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); void redo(); return true; }
    if (event.key === 'PageDown') { event.preventDefault(); go(state.sheetIndex + 1); return true; }
    if (event.key === 'PageUp') { event.preventDefault(); go(state.sheetIndex - 1); return true; }
    if (!canEdit() || !state.selected) return false;
    const item = page()?.els?.[state.selected];
    if (!item) return false;
    if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicate(state.selected); return true; }
    if (mod && event.key.toLowerCase() === 'c') { state.clipboard = structuredClone(item); stage.announce(t('book.copied')); return true; }
    if (event.key === ']') { event.preventDefault(); restackElement(state.selected, event.shiftKey ? 'front' : 'up'); return true; }
    if (event.key === '[') { event.preventDefault(); restackElement(state.selected, event.shiftKey ? 'back' : 'down'); return true; }
    return false;
  }
  function rootKeys(event) {
    const mod = event.ctrlKey || event.metaKey;
    if (stage.viewport.contains(event.target)) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); void (event.shiftKey ? redo() : undo()); }
    else if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); void redo(); }
  }
  function paste(event) {
    if (!state.clipboard || !canEdit() || event.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const target = page();
    if (!target) return;
    event.preventDefault();
    const item = { ...structuredClone(state.clipboard), z: topZ(target) + 1 };
    Object.assign(item, clampBox({ x: item.x + 0.02, y: item.y + 0.02, w: item.w, h: item.h }));
    const id = newId();
    void edit([addElements(space.ops, target.id, { [id]: item })], t('book.history.add')).then((done) => { if (done) select(id); });
  }
  root.addEventListener('keydown', rootKeys);
  stage.viewport.addEventListener('paste', paste);
  document.addEventListener('paste', paste);
  offs.push(() => document.removeEventListener('paste', paste));

  // ---- presence
  function peersByPage() {
    const map = new Map();
    for (const peer of peers) { if (!peer.page) continue; if (!map.has(peer.page)) map.set(peer.page, []); map.get(peer.page).push(peer); }
    return map;
  }
  function readPeers() {
    const members = new Map(space.select.member.all().map((member) => [member.id, member]));
    peers = (presence?.peers() ?? []).map((peer) => {
      const member = members.get(peer.uid);
      return { ...peer, name: member?.name || t('book.someone'), color: `var(--day-${colorSlot(member, peer.uid)})` };
    });
  }
  async function startPresence() {
    const peer = context.puter?.peer;
    if (!peer?.serve) { renderPeople(); return; }
    const owner = role() === 'owner';
    let handles = null;
    if (!owner) {
      const [features, entry] = await Promise.all([loadFeatures().catch(() => ({ pathA: false })), personalOf(context)?.spaces.list().then((list) => list.find((item) => sameRef(item.ref, ref))).catch(() => null)]);
      handles = features.pathA ? entry?.handles ?? null : null;
    }
    if (destroyed) return;
    const rendezvous = kvRendezvous({ puter: context.puter, space: ref.s, uid: me, owner, handles });
    presence = createPresence({ peer, rendezvous, uid: me, book: bookId, members: () => space.select.member.all().map((member) => member.id),
      onChange: () => { readPeers(); stage.setPeers(peers); renderPeople(); if (rail.section === 'pages') scheduleRail(); } });
    presence.start();
    presence.update({ page: page()?.id ?? null });
    renderPeople();
  }
  function renderPeople() {
    const here = peers.filter((peer, index, list) => list.findIndex((item) => item.uid === peer.uid) === index);
    const status = presence?.available ? (presence.status === 'live' ? 'live' : presence.status === 'failed' ? 'failed' : 'connecting') : 'off';
    people.replaceChildren(
      el('div.avatar-stack', { 'aria-hidden': 'true' }, here.slice(0, 4).map((peer) => {
        const node = personAvatar({ uid: peer.uid, name: peer.name }, { size: 26 });
        node.style.setProperty('box-shadow', `0 0 0 2px ${peer.color}`);
        return node;
      })),
      el('span.bk-live', { dataset: { status }, title: t(`book.live.${status}`) }, icon('people', 14), el('span.sr-only', {}, here.length ? t('book.live.with', { names: here.map((peer) => peer.name).join(', ') }) : t(`book.live.${status}`))));
  }

  // ---- rendering
  let railFrame = 0;
  function scheduleRail() { cancelAnimationFrame(railFrame); railFrame = requestAnimationFrame(() => { if (!destroyed) rail.render(); }); }
  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { if (!destroyed) render(); });
  }
  function render() {
    const current = book();
    if (!current) { onSwitch(null); return; }
    shape = shapeNow();
    if (state.sheetIndex >= shape.sheets.length) state.sheetIndex = Math.max(0, shape.sheets.length - 1);
    if (state.selected && !page()?.els?.[state.selected]) state.selected = null;
    titleButton.replaceChildren(icon('book', 16), el('span', {}, current.title || t('book.untitled')), icon('chevronDown', 14));
    titleButton.setAttribute('aria-label', t('book.switch', { name: current.title || t('book.untitled') }));
    undoButton.disabled = !history.canUndo || !canEdit();
    redoButton.disabled = !history.canRedo || !canEdit();
    const sheet = currentSheet();
    pager.querySelector('.bk-pager-label').textContent = sheet ? t('book.pager', { name: sheetName(sheet), index: formatNumber(sheet.index + 1), count: formatNumber(shape.sheets.length) }) : '';
    stage.setPage(page());
    rail.render();
    props.render();
    renderIssue();
    renderSync();
    // Older books may lack a single page another member deleted; editors restore it.
    const missing = missingKinds(shape);
    if (missing.length && shape.sheets.length && canEdit() && !repairing) {
      repairing = true;
      void space.apply(singleOps(space.ops, bookId, missing)).catch(() => {}).finally(() => { repairing = false; });
    }
  }
  function renderSync() {
    const value = space.state;
    const pending = Number(value.pending) || 0;
    syncNote.textContent = value.sync === 'offline' ? t('book.sync.offline') : pending ? t('book.sync.saving') : t('book.sync.saved');
    syncNote.dataset.state = value.sync === 'offline' ? 'offline' : pending ? 'saving' : 'saved';
  }
  function renderIssue() {
    const conflicts = space.conflicts().filter((conflict) => ['bookPage', 'book'].includes(conflict.op?.t));
    conflictBar.hidden = !conflicts.length;
    conflictBar.replaceChildren(...(conflicts.length ? [icon('warning', 16), el('span', {}, countText('book.conflicts', conflicts.length)),
      button(t('book.review'), { size: 'sm', variant: 'outline', onclick: () => review(conflicts[0]) })] : []));
  }
  function review(conflict) {
    openConflictDialog({ conflict,
      typeLabel: (type) => label(`book.type.${type}`, t('book.type.bookPage')),
      fieldLabel: (_type, field) => label(`book.field.${field.split('.')[0]}`, field),
      onResolve: async (choice) => { await space.resolveConflict(conflict.op.opId, choice); renderIssue(); } });
  }

  offs.push(
    space.subscribe((event) => {
      if (event.types?.has('presence')) return;
      if (['entry', 'file'].some((type) => event.types?.has(type))) { entries = storyEntries(space); stats = bookStats(space); travelVersion += 1; }
      schedule();
    }),
    space.onState(() => { renderSync(); renderIssue(); }),
    history.subscribe(() => { undoButton.disabled = !history.canUndo || !canEdit(); redoButton.disabled = !history.canRedo || !canEdit(); }),
  );
  void lightPalette().then((palette) => {
    if (destroyed) return;
    state.palette = palette;
    for (const node of [root, rail.element, props.element]) applyPalette(node, palette);
    stage.setPalette(palette);
    scheduleRail();
  });
  void countryShapes().then((shapes) => { if (destroyed || !shapes) return; state.shapes = shapes; stage.refresh(); scheduleRail(); });
  render();
  void startPresence();

  return {
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(railFrame);
      stage.flush();
      props.flush();
      for (const off of offs.splice(0)) off();
      presence?.stop();
      stage.destroy();
      rail.destroy();
      props.destroy();
      root.removeEventListener('keydown', rootKeys);
    },
  };
}

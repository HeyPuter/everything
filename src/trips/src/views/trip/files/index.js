import './files.css';
import { el, uid } from '../../../ui/dom.js';
import { button, emptyState, skeleton } from '../../../ui/bits.js';
import { segmented } from '../../../ui/fields.js';
import { openMenu } from '../../../ui/menu.js';
import { confirmDialog } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { formatInstant } from '../../../lib/format.js';
import {
  bindFiles, cachedFileUrl, canSaveToDrive, canUseDrive, chooseLocalFiles, emptyTrash, errorKey, fileUrl, formatBytes, groupOf,
  pickFromDrive, purgeFile, restoreFile, setStar, trashFile, trashedFiles, userFiles,
} from '../../../lib/files/index.js';
import { download, openPreview, saveCopy } from '../../../lib/files/preview.js';
import { fileIcon, icon, iconAction, linkIcon } from '../../../lib/files/icons.js';
import { linkLabel } from '../../../lib/files/labels.js';
import { fileLinks } from '../../../shared/file-links.js';
import { openDetails } from './details.js';
import { uploadQueue } from './queue.js';
import { createVideoSupport } from './video.js';
import { immichEntry } from '../../integrations/entry.js';
import { mountWithPhotos } from './photos/index.js';

const FILTERS = ['all', 'starred', 'pdf', 'image', 'document', 'notes'];
const TRASH_DAYS = 30;
const DAY = 86_400_000;
const RELEVANT = new Set(['file', 'meta', 'member', 'place', 'res', 'visit', 'exp', 'note', 'day']);
// Read once a minute: every row shows a date in it.
let zoneMemo = { at: -Infinity, value: 'UTC' };
const zone = () => {
  if (Date.now() - zoneMemo.at > 60_000) zoneMemo = { at: Date.now(), value: Intl.DateTimeFormat().resolvedOptions().timeZone };
  return zoneMemo.value;
};

/** Trip tab entry: the Files tab. Needs `context.space` and `context.session.api` (see src/lib/README.md). */
export async function mount(container, context) {
  const { space, session, puter, app } = context;
  if (!space) {
    container.replaceChildren(emptyState({ icon: 'file', title: t('files.unavailable'), body: t('files.unavailableBody') }));
    return undefined;
  }
  if (session?.api) bindFiles({ api: session.api, puter, account: session.account?.uuid });
  return mountWithPhotos(container, context, (host) => createFilesView({ container: host, space, app, puter, session }).destroy);
}

function matches(file, filter) {
  if (filter === 'starred') return Boolean(file.star);
  if (filter === 'notes') return fileLinks(file).some((link) => link.t === 'note');
  if (filter === 'all') return true;
  if (filter === 'image') return ['image', 'video'].includes(groupOf(file));
  return groupOf(file) === filter;
}

export function createFilesView({ container, space, app, puter, session, window: win = globalThis.window }) {
  const doc = container.ownerDocument;
  const cleanups = [];
  const busy = new Set();
  const queue = uploadQueue(space);
  const video = createVideoSupport(space, { onChange: () => schedule() });
  const rows = new Map();
  let filter = 'all';
  let query = '';
  let trash = false;
  let online = win.navigator?.onLine !== false && space.state?.sync !== 'offline';
  let frame = 0;
  let destroyed = false;

  const live = el('div.sr-only', { 'aria-live': 'polite' });
  const offline = el('div.offline-bar', { role: 'status', hidden: online }, icon('offline', 16), t('files.offlineBar'));
  const heading = el('h2.files-title', { tabIndex: -1 });
  const count = el('span.files-count');
  const uploadButton = button(t('files.action.upload'), { variant: 'primary', onclick: () => chooseLocalFiles({ accept: video.accept() }).then(addFiles) });
  uploadButton.prepend(icon('upload', 18));
  const driveButton = button(t('files.action.fromDrive'), { onclick: () => pickFromDrive().then(addFiles, (error) => toast(t(errorKey(error)))) });
  driveButton.prepend(icon('drive', 18));
  const immich = immichEntry({ space, app, puter, session }, { onFiles: (files) => addFiles(files) });
  cleanups.push(immich.destroy);
  const trashButton = button('', { variant: 'ghost', onclick: () => setTrash(!trash) });
  const emptyTrashButton = button(t('files.action.emptyTrash'), { variant: 'danger', size: 'sm', onclick: () => emptyAll() });
  const searchId = uid('files-search');
  const search = el('input.input', { id: searchId, type: 'search', autocomplete: 'off', placeholder: t('files.searchPlaceholder'),
    oninput: () => { query = search.value; render(); } });
  const filters = segmented({ label: t('files.filtersLabel'), items: FILTERS.map((id) => ({ value: id, label: t(`files.filter.${id}`) })), value: filter,
    onChange: (value) => { filter = value; render(); } });
  const trashHint = el('p.files-hint', {}, t('files.trashHint'));
  const videoHint = el('p.files-hint', { hidden: true }, t('files.videoHint'));
  const uploadList = el('ul.file-uploads', { 'aria-label': t('files.uploadsLabel'), hidden: true });
  heading.id = uid('files-heading');
  const list = el('ul.file-list', { 'aria-labelledby': heading.id });
  const listWrap = el('div.file-list-wrap', {}, list);
  const drop = el('div.file-drop', { hidden: true, 'aria-hidden': 'true' }, icon('upload', 28), el('p', {}, t('files.dropHint')));
  const toolbar = el('div.files-toolbar', {}, el('div.files-heading', {}, heading, count), el('div.files-actions', {}, uploadButton, driveButton, immich.element, trashButton, emptyTrashButton));
  const controls = el('div.files-controls', {},
    el('div.input-prefix.files-search', {}, el('label.sr-only', { htmlFor: searchId }, t('files.search')), icon('search', 16), search),
    el('div.files-filters', {}, filters.element));
  const root = el('section.files-view', { 'aria-labelledby': heading.id }, offline, toolbar, controls, trashHint, videoHint, uploadList, listWrap, drop, live);
  container.replaceChildren(root);

  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); loadThumb(entry.target); }
  }, { rootMargin: '200px' }) : null;

  function announce(text) { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 30); }

  function loadThumb(node) {
    const id = node.dataset.thumb;
    const file = space.get('file', id);
    if (!file?.thumb) return;
    fileUrl(space, id, { thumb: true }).then((url) => {
      if (url && node.isConnected) node.replaceChildren(el('img', { src: url, alt: '' }));
    }, () => {});
  }

  function thumbNode(file) {
    const node = el('span.file-thumb', { dataset: { thumb: file.id } }, fileIcon(file.mime, 22));
    const cached = file.thumb && cachedFileUrl(space, file.id, { thumb: true });
    if (cached) node.replaceChildren(el('img', { src: cached, alt: '' }));
    else if (file.thumb) { if (observer) observer.observe(node); else loadThumb(node); }
    return node;
  }

  const added = (file) => formatInstant(file.cr ?? Date.now(), zone(), { time: false, style: 'medium' });
  const daysLeft = (file) => Math.max(0, TRASH_DAYS - Math.floor((Date.now() - file.trashed) / DAY));
  const canUpload = () => space.can('files.upload');
  const canEdit = () => space.can('files.edit');
  const canDelete = () => space.can('files.delete');

  function visible() {
    const needle = query.trim().toLocaleLowerCase();
    const items = (trash ? trashedFiles(space) : userFiles(space))
      .filter((file) => (trash || matches(file, filter)) && (!needle || file.name.toLocaleLowerCase().includes(needle) || (file.desc ?? '').toLocaleLowerCase().includes(needle)));
    return [...items].sort(trash ? (a, b) => b.trashed - a.trashed : (a, b) => (b.cr ?? 0) - (a.cr ?? 0) || (a.id < b.id ? 1 : -1));
  }

  function preview(id, ids) { openPreview(space, id, { ids, onDetails: (fileId) => openDetails(space, fileId, { onTrash: trashOne }) }); }

  function menu(anchor, file, ids) {
    const items = [
      { label: t('files.action.preview'), onSelect: () => preview(file.id, ids) },
      { label: t('files.action.download'), onSelect: () => download(space, file.id) },
      canSaveToDrive() && { label: t('files.action.saveToDrive'), onSelect: () => saveCopy(space, file.id) },
      { label: t(canEdit() ? 'files.action.edit' : 'files.action.details'), icon: 'pencil', onSelect: () => openDetails(space, file.id, { onTrash: trashOne }) },
      canEdit() && { label: t(file.star ? 'files.action.unstar' : 'files.action.star'), onSelect: () => toggleStar(file) },
      canDelete() && { separator: true },
      canDelete() && { label: t('files.action.trash'), icon: 'trash', danger: true, disabled: !online, onSelect: () => trashOne(file.id) },
    ].filter(Boolean);
    openMenu(anchor, items);
  }

  function toggleStar(file) {
    setStar(space, file.id, !file.star).catch((error) => toast(t(errorKey(error))));
  }

  function linkChips(file) {
    const all = fileLinks(file);
    const links = all.filter((link) => link.t !== 'meta');
    const cover = all.length > links.length;
    if (!links.length && !cover) return null;
    return el('span.file-row-links', {},
      cover && el('span.chip.chip-accent.file-link-chip', {}, linkIcon('meta'), el('span', {}, t('files.link.cover'))),
      links.slice(0, 3).map((link) => el('span.chip.file-link-chip', {}, linkIcon(link.t), el('span', {}, linkLabel(space, link)))),
      links.length > 3 && el('span.chip.file-link-chip', {}, t('files.link.more', { count: links.length - 3 })));
  }

  function fileRow(file, ids) {
    const pending = busy.has(file.id);
    const meta = trash
      ? t('files.deletesIn', { count: daysLeft(file) })
      : [formatBytes(file.size), added(file), file.desc].filter(Boolean).join(' · ');
    const main = el('button.file-row-main', { type: 'button', dataset: { id: file.id, part: 'main' }, onclick: () => preview(file.id, ids),
      'aria-label': t('files.action.previewName', { name: file.name }) },
    thumbNode(file),
    el('span.file-row-text', {}, el('span.file-row-name', {}, file.name), el('span.file-row-meta', {}, meta), !trash && linkChips(file)));
    const tail = [];
    if (trash) {
      if (canDelete()) {
        tail.push(button(t('files.action.restore'), { size: 'sm', disabled: pending || !online, dataset: { id: file.id, part: 'restore' }, onclick: () => restoreOne(file.id) }),
          button(t('files.action.purge'), { size: 'sm', variant: 'danger', disabled: pending || !online, dataset: { id: file.id, part: 'purge' }, onclick: () => purgeOne(file.id) }));
      }
    } else {
      if (canEdit()) {
        tail.push(el('button.icon-btn.file-star', { type: 'button', 'aria-pressed': String(Boolean(file.star)), dataset: { id: file.id, part: 'star' },
          'aria-label': t('files.action.starName', { name: file.name }), title: t(file.star ? 'files.action.unstar' : 'files.action.star'), onclick: () => toggleStar(file) },
        icon('star', 18, { filled: Boolean(file.star) })));
      } else if (file.star) tail.push(el('span.file-star-static', { title: t('files.starred') }, icon('star', 16, { filled: true }), el('span.sr-only', {}, t('files.starred'))));
      const more = iconAction('more', t('files.action.moreName', { name: file.name }), { dataset: { id: file.id, part: 'more' }, onclick: () => menu(more, file, ids) });
      tail.push(more);
    }
    return el('li.file-row', { 'aria-busy': pending ? 'true' : null, dataset: { id: file.id } }, main, el('div.file-row-actions', {}, tail));
  }

  function render() {
    if (destroyed) return;
    const focused = doc.activeElement?.closest?.('.file-row [data-part]');
    const keep = focused && list.contains(focused) ? { id: focused.dataset.id, part: focused.dataset.part } : null;
    const all = trash ? trashedFiles(space) : userFiles(space);
    const items = visible();
    const ids = items.map((file) => file.id);
    const trashCount = trashedFiles(space).length;
    heading.textContent = t(trash ? 'files.trashTitle' : 'files.title');
    count.textContent = all.length ? t('files.count', { count: all.length }) : '';
    uploadButton.hidden = trash || !canUpload();
    driveButton.hidden = trash || !canUpload() || !canUseDrive();
    uploadButton.disabled = !online; driveButton.disabled = !online;
    immich.update({ visible: !trash && canUpload(), disabled: !online });
    trashButton.replaceChildren(icon(trash ? 'arrowLeft' : 'trash', 16), el('span', {}, trash ? t('files.action.backToFiles') : t('files.action.openTrash', { count: trashCount })));
    trashButton.hidden = !trash && trashCount === 0;
    emptyTrashButton.hidden = !trash || !trashCount || !canDelete();
    emptyTrashButton.disabled = !online;
    trashHint.hidden = !trash;
    videoHint.hidden = trash || !video.available || !canUpload();
    filters.element.closest('.files-filters').hidden = trash;
    observer?.disconnect();
    if (!items.length) {
      const loading = !all.length && space.state?.rev === 0 && ['idle', 'syncing'].includes(space.state?.sync);
      if (loading) { list.replaceChildren(...[0, 1, 2].map(() => el('li.file-row.file-row-skeleton', {}, skeleton('48px'), skeleton('60%')))); return; }
      const empty = trash ? emptyState({ icon: 'trash', title: t('files.empty.trash') })
        : all.length ? emptyState({ icon: 'search', title: t('files.empty.filtered'), body: t('files.empty.filteredBody') })
          : emptyState({ icon: 'file', title: t('files.empty.title'), body: t(canUpload() ? 'files.empty.body' : 'files.empty.viewer'),
            action: canUpload() && online && button(t('files.action.upload'), { variant: 'primary', onclick: () => chooseLocalFiles({ accept: video.accept() }).then(addFiles) }) });
      list.replaceChildren(el('li.file-empty', {}, empty));
      return;
    }
    list.replaceChildren(...items.map((file) => fileRow(file, ids)));
    if (keep) (list.querySelector(`[data-id="${keep.id}"][data-part="${keep.part}"]`) ?? list.querySelector(`[data-id="${keep.id}"][data-part="main"]`))?.focus({ preventScroll: true });
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); }); };

  function setTrash(next) {
    trash = next;
    render();
    heading.focus({ preventScroll: true });
  }

  // ---- Uploads ----

  // Rows update in place so focus on Cancel survives progress events; actions rebuild only when the status changes.
  function paint(entry) {
    const state = entry.task.state;
    let row = rows.get(entry);
    if (!row) {
      row = { name: el('span.file-upload-name'), status: el('span.file-upload-status'), icon: el('span.file-upload-icon'), actions: el('span.file-upload-actions'),
        progress: el('progress.meter', { max: 1, value: 0 }), shown: null };
      row.node = el('li.file-upload', {}, row.icon, el('span.file-upload-text', {}, row.name, row.status, row.progress), row.actions);
      rows.set(entry, row);
      uploadList.append(row.node);
    }
    const failed = state.status === 'error';
    const running = ['preparing', 'uploading', 'saving', 'thumbnail', 'queued'].includes(state.status);
    row.node.classList.toggle('is-error', failed);
    row.node.dataset.status = state.status;
    row.name.textContent = state.name;
    row.status.textContent = failed ? t(errorKey(state.error)) : state.status === 'uploading' && state.total
      ? t('files.upload.percent', { percent: Math.round((state.loaded / state.total) * 100), size: formatBytes(state.total) })
      : t(`files.status.${state.status}`, { name: state.name });
    row.progress.hidden = !running;
    row.progress.max = Math.max(1, state.total);
    row.progress.value = state.status === 'uploading' ? state.loaded : ['queued', 'preparing'].includes(state.status) ? 0 : state.total;
    row.progress.setAttribute('aria-label', t('files.upload.progressLabel', { name: state.name }));
    const shown = `${state.status}:${online}`;
    if (row.shown !== shown) {
      row.shown = shown;
      const hadFocus = row.actions.contains(doc.activeElement);
      row.icon.replaceChildren(icon(failed ? 'alert' : 'upload', 18));
      row.actions.replaceChildren(...[
        running && iconAction('close', t('files.action.cancelName', { name: state.name }), { small: true, onclick: () => queue.cancel(entry) }),
        failed && button(t('files.action.retry'), { size: 'sm', disabled: !online, onclick: () => queue.retry(entry) }),
        (failed || state.status === 'canceled') && iconAction('close', t('files.action.dismissName', { name: state.name }), { small: true, onclick: () => queue.remove(entry) }),
      ].filter(Boolean));
      if (hadFocus) (row.actions.querySelector('button') ?? heading).focus({ preventScroll: true });
    }
    uploadList.hidden = !queue.entries.length;
  }

  function onQueue(entry, event) {
    if (destroyed) return;
    if (event === 'removed') {
      const row = rows.get(entry);
      if (row?.node.contains(doc.activeElement)) heading.focus({ preventScroll: true });
      row?.node.remove(); rows.delete(entry); uploadList.hidden = !queue.entries.length;
      return;
    }
    paint(entry);
    if (event === 'done') {
      const name = entry.task.state.name;
      if (entry.result?.duplicate) toast(t('files.upload.duplicate', { name }));
      else announce(t('files.upload.done', { name }));
      if (entry.task.state.notice === 'heic_kept') toast(t('files.notice.heicKept', { name }));
    }
  }

  function addFiles(files) {
    if (destroyed || !files?.length) return;
    if (!canUpload()) { toast(t('files.error.forbidden')); return; }
    if (!online) { toast(t('files.error.offline')); return; }
    const { ok, refused } = video.split(files);
    if (refused.length) toast(t('files.error.video_direct'));
    if (ok.length) queue.add(ok);
  }

  // ---- Trash ----

  async function act(id, run) {
    if (!online) { toast(t('files.error.offline')); return false; }
    busy.add(id); render();
    try { await run(); return true; } catch (error) { toast(t(errorKey(error))); return false; } finally { busy.delete(id); schedule(); }
  }

  async function trashOne(id) {
    const name = space.get('file', id)?.name ?? '';
    if (await act(id, () => trashFile(space, id))) {
      toast(t('files.trashed', { name }), { action: { label: t('files.action.undo'), onClick: () => { void act(id, () => restoreFile(space, id)); } } });
    }
  }

  async function restoreOne(id) {
    const name = space.get('file', id)?.name ?? '';
    if (await act(id, () => restoreFile(space, id))) announce(t('files.restored', { name }));
  }

  async function purgeOne(id) {
    const name = space.get('file', id)?.name ?? '';
    const ok = await confirmDialog({ title: t('files.purgeTitle'), body: t('files.purgeBody', { name }), confirmLabel: t('files.action.purge'), danger: true });
    if (ok && await act(id, () => purgeFile(space, id))) announce(t('files.purged', { name }));
  }

  async function emptyAll() {
    const total = trashedFiles(space).length;
    if (!total || !online) return;
    const ok = await confirmDialog({ title: t('files.emptyTrashTitle'), body: t('files.emptyTrashBody', { count: total }), confirmLabel: t('files.action.emptyTrash'), danger: true });
    if (!ok) return;
    emptyTrashButton.setAttribute('aria-busy', 'true');
    try {
      const { purged, failures } = await emptyTrash(space, { onProgress: (done, all) => { emptyTrashButton.textContent = t('files.emptying', { done, all }); } });
      toast(failures.length ? t('files.emptyTrashPartial', { purged, failed: failures.length }) : t('files.emptyTrashDone', { count: purged }));
    } finally {
      emptyTrashButton.removeAttribute('aria-busy');
      emptyTrashButton.textContent = t('files.action.emptyTrash');
      render();
    }
  }

  // ---- Drop, paste, connectivity ----

  const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
  root.addEventListener('dragenter', (event) => { if (hasFiles(event) && canUpload() && !trash) { event.preventDefault(); drop.hidden = false; } });
  root.addEventListener('dragover', (event) => { if (hasFiles(event) && canUpload() && !trash) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; drop.hidden = false; } });
  root.addEventListener('dragleave', (event) => { if (!root.contains(event.relatedTarget)) drop.hidden = true; });
  root.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    drop.hidden = true;
    if (!trash) addFiles([...event.dataTransfer.files]);
  });
  const paste = (event) => {
    if (!root.isConnected || trash || doc.querySelector('[aria-modal="true"]') || event.target?.closest?.('input,textarea,[contenteditable]:not([contenteditable="false"])')) return;
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length || !canUpload()) return;
    event.preventDefault();
    addFiles(files);
  };
  doc.addEventListener('paste', paste);
  cleanups.push(() => doc.removeEventListener('paste', paste));

  const connectivity = () => {
    online = win.navigator?.onLine !== false && space.state?.sync !== 'offline';
    offline.hidden = online;
    render();
    for (const entry of queue.entries) paint(entry);
  };
  win.addEventListener('online', connectivity);
  win.addEventListener('offline', connectivity);
  cleanups.push(() => { win.removeEventListener('online', connectivity); win.removeEventListener('offline', connectivity); });
  if (typeof space.onState === 'function') cleanups.push(space.onState(() => { const next = win.navigator?.onLine !== false && space.state?.sync !== 'offline'; if (next !== online) connectivity(); }));
  cleanups.push(space.subscribe((event) => { if ([...event.types].some((type) => RELEVANT.has(type))) schedule(); }));
  cleanups.push(queue.subscribe(onQueue));
  cleanups.push(() => video.destroy());
  for (const entry of queue.entries) paint(entry);
  if (app?.commands?.register) {
    try { cleanups.push(app.commands.register({ id: 'files-upload', labelKey: 'files.command.upload', run: () => chooseLocalFiles({ accept: video.accept() }).then(addFiles) })); } catch { /* already registered */ }
  }

  render();
  return {
    root,
    addFiles,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* keep tearing down */ } }
    },
  };
}

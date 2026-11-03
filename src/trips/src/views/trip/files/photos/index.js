// Trip photos in the Files tab (spec §22 [3]): shared photos and the member's private ones from their drive, by day.
import './photos.css';
import { el, uid } from '../../../../ui/dom.js';
import { button, emptyState, iconButton } from '../../../../ui/bits.js';
import { segmented } from '../../../../ui/fields.js';
import { openMenu } from '../../../../ui/menu.js';
import { openModal } from '../../../../ui/modal.js';
import { toast } from '../../../../ui/toast.js';
import { t } from '../../../../lib/i18n/index.js';
import { formatDate, formatTime } from '../../../../lib/format.js';
import { canUseDrive, chooseLocalFiles, errorKey, fileUrl, trashFile, uploadFile } from '../../../../lib/files/index.js';
import { openPreview } from '../../../../lib/files/preview.js';
import { makeThumbnail } from '../../../../lib/files/image.js';
import { IMAGE_ACCEPT } from '../../../../lib/files/types.js';
import { EXIF_BYTES, blobBytes, createPhotoStore, folderImages, photoMeta, photoPool, photosByDay } from '../../../../lib/photos/index.js';
import { icon } from '../../../../lib/files/icons.js';

const viewKey = (spaceId) => `trips:files:view:${spaceId}`;
const count = (n) => t(n === 1 ? 'tripPhotos.countOne' : 'tripPhotos.count', { count: new Intl.NumberFormat().format(n) });

/**
 * The Files tab with a Files / Photos switch. `mountFiles(host)` mounts the regular Files view and returns its
 * cleanup; the photos view loads on first use. Returns the cleanup.
 */
export function mountWithPhotos(container, context, mountFiles) {
  const spaceId = context.space?.ref?.s ?? 'trip';
  let current = 'files';
  try { current = localStorage.getItem(viewKey(spaceId)) === 'photos' ? 'photos' : 'files'; } catch { current = 'files'; }
  const filesHost = el('div.photos-files-host');
  const photosHost = el('div.photos-host', { hidden: true });
  let stopPhotos = null;
  const switcher = segmented({ label: t('tripPhotos.switchLabel'), value: current,
    items: [{ value: 'files', label: t('tripPhotos.files') }, { value: 'photos', label: t('tripPhotos.photos') }], onChange: (value) => show(value) });
  container.replaceChildren(el('div.photos-switch', {}, switcher.element), filesHost, photosHost);
  const stopFiles = mountFiles(filesHost);
  function show(value) {
    current = value;
    filesHost.hidden = value !== 'files';
    photosHost.hidden = value !== 'photos';
    if (value === 'photos' && !stopPhotos) stopPhotos = mountTripPhotos(photosHost, context);
    try { localStorage.setItem(viewKey(spaceId), value); } catch { /* per device only */ }
  }
  show(current);
  return () => { stopFiles?.(); stopPhotos?.(); };
}

async function readDrive(puter, photo, options) {
  const blob = await puter.fs.read(photo.path || { uid: photo.uid }, options);
  return blob instanceof Blob ? blob : new Blob([blob]);
}

/** The photo pool for one open trip. Returns the cleanup. */
export function mountTripPhotos(host, context) {
  const { space } = context;
  const puter = context.puter ?? globalThis.puter;
  const personal = context.session?.personal ?? context.personal;
  const store = space?.ref?.s && personal?.get && puter?.kv ? createPhotoStore({ personal, puter, spaceId: space.ref.s }) : null;
  const urls = new Map();
  const live = el('div.sr-only', { role: 'status', 'aria-live': 'polite' });
  const body = el('div.photos-body');
  const toolbar = el('div.photos-toolbar');
  const titleId = uid('photos-title');
  host.replaceChildren(el('section.photos-view', { 'aria-labelledby': titleId }, el('h2.files-title', { id: titleId }, t('tripPhotos.title')),
    el('p.files-hint', {}, t('tripPhotos.intro')), toolbar, body, live));
  let mine = { folder: null, items: new Map() };
  let folderEntries = [];
  let destroyed = false;
  const folderMeta = new Map();
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); void loadThumb(entry.target); }
  }, { rootMargin: '200px' }) : null;
  const say = (message) => { live.textContent = ''; setTimeout(() => { live.textContent = message; }, 30); };
  const fail = (error) => toast(error?.code === 'photos_full' ? t('tripPhotos.full') : globalThis.navigator?.onLine === false ? t('tripPhotos.offline')
    : error?.code === 'read_failed' ? t('tripPhotos.readFailed') : errorKey(error) === 'files.error.generic' ? t('tripPhotos.failed') : t(errorKey(error)));

  async function privateUrl(photo, { full = false } = {}) {
    const key = `${full ? 'full' : 'thumb'}:${photo.uid}`;
    if (!urls.has(key)) {
      urls.set(key, (async () => {
        const blob = await readDrive(puter, photo);
        const thumb = full ? null : await makeThumbnail(blob).catch(() => null);
        return URL.createObjectURL(thumb ?? blob);
      })().catch((error) => { urls.delete(key); throw error; }));
    }
    return urls.get(key);
  }
  async function loadThumb(node) {
    const photo = node.photo;
    try {
      const url = photo.source === 'shared'
        ? (await fileUrl(space, photo.fileId, { thumb: true })) ?? (await fileUrl(space, photo.fileId))
        : await privateUrl(photo);
      if (url && node.isConnected) node.replaceChildren(el('img', { src: url, alt: '', decoding: 'async' }));
    } catch { node.classList.add('is-broken'); }
  }

  // EXIF of folder images, read lazily (first bytes only) so the pool can sort them by day.
  async function readFolderMeta(list) {
    let changed = false;
    for (const entry of list.slice(0, 60)) {
      if (destroyed || folderMeta.has(entry.uid) || !/\.jpe?g$/i.test(entry.name)) continue;
      try {
        const head = await readDrive(puter, entry, { offset: 0, byte_count: EXIF_BYTES });
        folderMeta.set(entry.uid, photoMeta(await blobBytes(head, EXIF_BYTES)));
        changed = true;
      } catch { folderMeta.set(entry.uid, {}); }
    }
    if (changed && !destroyed) render();
  }

  async function addFromDrive() {
    let picked;
    try { picked = await puter.ui.showOpenFilePicker({ multiple: true, accept: IMAGE_ACCEPT }); } catch { return; }
    const items = (Array.isArray(picked) ? picked : [picked]).filter((item) => item && !item.is_dir && typeof item.uid === 'string');
    if (!items.length) return;
    const list = [];
    for (const item of items) {
      let meta = {};
      try { meta = photoMeta(await blobBytes(await readDrive(puter, item, { offset: 0, byte_count: EXIF_BYTES }), EXIF_BYTES)); } catch { meta = {}; }
      list.push({ uid: item.uid, name: item.name, path: item.path, ...meta });
    }
    try { mine = await store.add(list); render(); toast(t(list.length === 1 ? 'tripPhotos.addedOne' : 'tripPhotos.added', { count: new Intl.NumberFormat().format(list.length) })); } catch (error) { fail(error); }
  }
  async function linkFolder() {
    let folder;
    try { folder = await puter.ui.showDirectoryPicker(); } catch { return; }
    if (!folder?.path) return;
    try { mine = await store.setFolder({ uid: folder.uid ?? folder.path, path: folder.path, name: folder.name ?? folder.path.split('/').pop() }); await loadFolder(); } catch (error) { fail(error); }
  }
  async function unlinkFolder() {
    try { mine = await store.setFolder(null); folderEntries = []; render(); } catch (error) { fail(error); }
  }
  async function uploadShared() {
    const files = await chooseLocalFiles({ accept: IMAGE_ACCEPT });
    for (const file of files) {
      let meta = {};
      try { meta = photoMeta(await blobBytes(file, EXIF_BYTES)); } catch { meta = {}; }
      try { await uploadFile(space, file, { kind: 'photo', fields: fieldsOf(meta) }); } catch (error) { fail(error); return; }
    }
    if (files.length) toast(t(files.length === 1 ? 'tripPhotos.addedOne' : 'tripPhotos.added', { count: new Intl.NumberFormat().format(files.length) }));
  }
  const fieldsOf = (photo) => ({ ...(photo.taken ? { taken: photo.taken } : {}), ...(Number.isFinite(photo.lat) ? { geo: { lat: photo.lat, lng: photo.lng } } : {}) });

  async function share(photo) {
    say(t('tripPhotos.sharing', { name: photo.name }));
    try {
      let blob;
      try { blob = await readDrive(puter, photo); } catch { throw Object.assign(new Error('read_failed'), { code: 'read_failed' }); }
      const { id } = await uploadFile(space, new File([blob], photo.name, { type: blob.type || 'image/jpeg' }), { kind: 'photo', fields: fieldsOf(photo) });
      if (photo.source === 'folder') mine = await store.add([{ uid: photo.uid, name: photo.name, path: photo.path, ...(photo.taken ? { taken: photo.taken } : {}), ...(Number.isFinite(photo.lat) ? { lat: photo.lat, lng: photo.lng } : {}) }]);
      const entry = [...mine.items].find(([, item]) => item.uid === photo.uid);
      if (entry) mine = await store.setShared(entry[0], id);
      render();
      toast(t('tripPhotos.sharedToast'));
    } catch (error) { fail(error); }
  }
  async function makePrivate(photo) {
    try { await trashFile(space, photo.fileId); mine = await store.setShared(photo.mine, null); render(); toast(t('tripPhotos.privateToast')); } catch (error) { fail(error); }
  }
  async function removeShared(photo) {
    try { await trashFile(space, photo.fileId); toast(t('tripPhotos.removed')); } catch (error) { fail(error); }
  }
  async function removePrivate(photo) {
    try { mine = await store.remove(photo.id); render(); toast(t('tripPhotos.removed')); } catch (error) { fail(error); }
  }
  function view(photo, pool) {
    if (photo.source === 'shared') { openPreview(space, photo.fileId, { ids: pool.filter((item) => item.source === 'shared').map((item) => item.fileId) }); return; }
    const image = el('img.photos-full', { alt: photo.name, decoding: 'async' });
    void privateUrl(photo, { full: true }).then((url) => { image.src = url; }, () => toast(t('tripPhotos.readFailed')));
    openModal({ title: photo.name, content: image, wide: true });
  }
  function menu(anchor, photo, pool) {
    const items = [{ label: t('tripPhotos.view'), onSelect: () => view(photo, pool) }];
    if (photo.source !== 'shared' && space.can('files.upload')) items.push({ label: t('tripPhotos.share'), onSelect: () => void share(photo) });
    if (photo.source === 'shared' && photo.mine && space.can('files.delete')) items.push({ label: t('tripPhotos.makePrivate'), onSelect: () => void makePrivate(photo) });
    if (photo.source === 'shared' && space.can('files.delete')) items.push({ separator: true }, { label: t('tripPhotos.removeFromTrip'), icon: 'trash', danger: true, onSelect: () => void removeShared(photo) });
    if (photo.source === 'private') items.push({ separator: true }, { label: t('tripPhotos.removeFromPool'), icon: 'trash', danger: true, onSelect: () => void removePrivate(photo) });
    openMenu(anchor, items);
  }

  function tile(photo, pool) {
    const thumb = el('span.photos-thumb', {}, icon('image', 22));
    thumb.photo = photo;
    if (observer) observer.observe(thumb); else void loadThumb(thumb);
    const when = photo.taken?.time ? formatTime(photo.taken.time) : '';
    const badge = photo.source === 'shared' ? t('tripPhotos.shared') : photo.source === 'folder' ? t('tripPhotos.inFolder', { name: mine.folder?.name ?? '' }) : t('tripPhotos.private');
    return el('li.photos-tile', { dataset: { source: photo.source, key: photo.key } },
      el('button.photos-open', { type: 'button', 'aria-label': `${photo.name}${when ? `, ${when}` : ''}, ${badge}`, onclick: () => view(photo, pool) }, thumb),
      el('span.photos-meta', {}, el('span.photos-badge', { dataset: { source: photo.source } }, badge), when ? el('span.num', {}, when) : null),
      iconButton('more', t('tripPhotos.actions', { name: photo.name }), { className: 'icon-btn icon-btn-sm photos-more', dataset: { focus: `photo:${photo.key}` }, onclick: (event) => menu(event.currentTarget, photo, pool) }));
  }

  function render() {
    if (destroyed) return;
    const files = space.select.file.all();
    const folderItems = folderEntries.map((entry) => ({ ...entry, ...(folderMeta.get(entry.uid) ?? {}) }));
    const pool = photoPool({ files, items: mine.items, folderItems });
    const fromDrive = store && canUseDrive(puter) ? button(t('tripPhotos.fromDrive'), { variant: 'primary', icon: 'plus', onclick: () => void addFromDrive() }) : null;
    const folder = store && typeof puter?.ui?.showDirectoryPicker === 'function'
      ? (mine.folder ? button(t('tripPhotos.unlinkFolder', { name: mine.folder.name }), { variant: 'ghost', onclick: () => void unlinkFolder() }) : button(t('tripPhotos.linkFolder'), { variant: 'outline', onclick: () => void linkFolder() }))
      : null;
    const upload = space.can('files.upload') ? button(t('tripPhotos.upload'), { variant: fromDrive ? 'outline' : 'primary', onclick: () => void uploadShared() }) : null;
    upload?.prepend(icon('upload', 18));
    toolbar.replaceChildren(...[fromDrive, folder, upload].filter(Boolean));
    if (!pool.length) {
      body.replaceChildren(emptyState({ icon: 'file', title: t('tripPhotos.empty'), body: t('tripPhotos.emptyBody') }), mine.folder ? el('p.files-hint', {}, t('tripPhotos.folderLinked', { name: mine.folder.name })) : '');
      return;
    }
    const days = space.select.day.all();
    body.replaceChildren(mine.folder ? el('p.files-hint', {}, t('tripPhotos.folderLinked', { name: mine.folder.name })) : '',
      ...photosByDay(pool, days).map((group) => {
        const headingId = uid('photos-day');
        const label = group.dayId === 'other' ? t('tripPhotos.otherDates') : group.dayId === 'none' ? t('tripPhotos.noDate')
          : group.date ? formatDate(group.date, { weekday: true }) : t('tripPhotos.dayNumber', { number: group.index + 1 });
        return el('section.photos-day', { 'aria-labelledby': headingId },
          el('h3.photos-day-title', { id: headingId }, el('span', {}, label), el('span.files-count', {}, count(group.photos.length))),
          el('ul.photos-grid', {}, group.photos.map((photo) => tile(photo, pool))));
      }));
  }

  async function loadFolder() {
    if (!mine.folder || typeof puter?.fs?.readdir !== 'function') { folderEntries = []; render(); return; }
    try { folderEntries = folderImages(await puter.fs.readdir(mine.folder.path)); } catch { folderEntries = []; }
    render();
    void readFolderMeta(folderEntries);
  }

  const off = space.subscribe((event) => { if (event.types.has('file') || event.types.has('day')) render(); });
  render();
  if (store) void store.load().then(async (value) => { if (destroyed) return; mine = value; render(); await loadFolder(); }, () => {});
  return () => {
    destroyed = true;
    off();
    observer?.disconnect();
    for (const promise of urls.values()) void promise.then((url) => URL.revokeObjectURL(url), () => {});
    urls.clear();
  };
}

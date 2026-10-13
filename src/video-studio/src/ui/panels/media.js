/**
 * Media tab: the project's media bin. Import local files or files from
 * Puter, record the camera or screen, generate pictures with AI, organize
 * media in folders, browse as a grid or a list (sorted and filtered, both
 * remembered per device), select several items and add them to the
 * timeline in order. Also offers backdrops generated on the fly.
 */
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { clock } from '../../lib/time.js';
import { allClips } from '../../model/timeline.js';
import { allClipsDeep, removeAssetClips } from '../../model/compound.js';
import {
  binsOf, childBins, binPath, findBin, assetsInBin, binItemCount, createBin, renameBin, deleteBin, moveAssets, moveBin,
  sortAssets, filterAssets, formatBytes, MEDIA_SORTS, MEDIA_TYPES,
} from '../../model/bins.js';
import { BACKDROPS, BACKDROP_GROUPS, drawBackdrop } from '../../media/backdrops.js';
import { tabLayout, tileGrid, tile, emptyState } from './common.js';
import { generatePanel } from './generate.js';
import { renderTimelines, timelinesSignature } from './timelines.js';
import { showMenu, menuButton } from '../menu.js';
import { confirmDialog, promptDialog, toast } from '../dialog.js';
import { prefs, setPref } from '../prefs.js';
import { openRecordDialog } from '../record-dialog.js';
import { canProxy, proxyMode, heavyReason, REASON_LABEL } from '../../model/proxy.js';
import '../../styles/proxy.css';

const ACCEPT = 'video/*,audio/*,image/*,.mkv,.mov,.m4v,.webm,.mp3,.wav,.m4a,.flac,.ogg,.opus';
const DRAG_MIME = 'application/x-video-studio';
const BIN_MIME = 'application/x-video-studio-bin';
const KIND_LABEL = { video: 'Video', image: 'Photo', audio: 'Audio' };
const KIND_ICON = { video: 'film', image: 'image', audio: 'music' };
const TYPE_CATS = new Set(['video', 'image', 'audio']);

const viewPref = () => (prefs().mediaView === 'list' ? 'list' : 'grid');
function sortPref() {
  const s = prefs().mediaSort || {};
  return { key: MEDIA_SORTS.some((x) => x.id === s.key) ? s.key : 'added', dir: s.dir === 'asc' ? 'asc' : 'desc' };
}
const typesPref = () => (Array.isArray(prefs().mediaTypes) ? prefs().mediaTypes.filter((t) => TYPE_CATS.has(t)) : []);

/** One-line facts for a media item: "Video · 0:12 · 1920×1080 · 12 MB". */
export function assetFacts(a) {
  return [
    KIND_LABEL[a.kind] || a.kind,
    a.kind === 'image' ? null : clock(a.duration),
    a.width && a.height && a.kind !== 'audio' ? `${a.width}×${a.height}` : null,
    a.size ? formatBytes(a.size) : null,
  ].filter(Boolean).join(' · ');
}

/**
 * Proxy status of a media item for its badge: { state, text, label } where
 * text is the short badge text and label the spoken/tooltip description.
 * state 'none' hides the badge.
 */
export function proxyBadgeState(asset, proxies, mode = 'auto') {
  if (!proxies || !canProxy(asset)) return { state: 'none', text: '', label: '' };
  const st = proxies.status(asset);
  const pct = Math.round(st.progress * 100);
  const reason = REASON_LABEL[proxies.isSlow?.(asset) ? 'slow' : heavyReason(asset)];
  const why = reason ? ` (${reason})` : '';
  switch (st.state) {
    case 'ready':
      return { state: 'ready', text: 'Proxy', label: mode === 'off' ? 'Proxy ready, not used while proxy media is off' : `Plays from a proxy in the preview${why}` };
    case 'generating':
      return { state: 'generating', text: `Proxy ${pct}%`, label: `Making a proxy${why}, ${pct}%`, progress: st.progress };
    case 'queued':
      return { state: 'queued', text: 'Proxy', label: `Waiting to make a proxy${why}` };
    case 'error':
      return { state: 'error', text: 'Proxy', label: `Proxy failed: ${st.error || 'unknown error'}` };
    default:
      return { state: 'none', text: '', label: '' };
  }
}

export function mediaTab(ctx) {
  const { store, actions, media } = ctx;
  const proxies = ctx.proxies || null;
  const fileInput = h('input', { type: 'file', multiple: true, accept: ACCEPT, hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (files.length) await importWithProgress(files);
  });
  let importing = 0;
  let folder = null; // open bin folder id (null: top level)
  const selection = new Set(); // asset ids
  let anchor = null; // last clicked asset id, for Shift ranges
  let visible = []; // assets in display order
  let gen = null;
  let layout = null;

  const currentFolder = () => (folder && findBin(store.project, folder) ? folder : null);

  async function importWithProgress(files) {
    importing += files.length;
    layout.refresh();
    try {
      await actions.importFiles(files, { folder: currentFolder() });
    } finally {
      importing -= files.length;
      layout.refresh();
    }
  }

  async function fromPuter() {
    if (typeof puter === 'undefined' || !puter.ui?.showOpenFilePicker) return;
    try {
      const picked = await puter.ui.showOpenFilePicker({ multiple: true, accept: ['video/*', 'audio/*', 'image/*'] });
      const items = Array.isArray(picked) ? picked : [picked];
      const files = [];
      for (const it of items) {
        const blob = await it.read();
        files.push(new File([blob], it.name, { type: blob.type }));
      }
      if (files.length) await importWithProgress(files);
    } catch (err) {
      if (err) toast("Couldn't open that file from Puter.", { kind: 'error' });
    }
  }

  /* Toolbar ------------------------------------------------------------------ */
  const importBtn = h('button.btn.primary.import-btn', { type: 'button' }, icon('import', 16), 'Import');
  importBtn.addEventListener('click', () => fileInput.click());
  const recordBtn = h('button.btn.record-btn', { type: 'button' }, icon('record', 16), 'Record');
  menuButton(recordBtn, () => [
    { label: 'Camera', icon: 'camera', onSelect: () => openRecord('camera') },
    { label: 'Screen', icon: 'screen', onSelect: () => openRecord('screen') },
  ], { label: 'Record' });
  const folderBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'New folder', 'data-tip': 'New folder' }, icon('folderPlus', 18));
  folderBtn.addEventListener('click', () => newFolder());
  const puterBtn = typeof puter !== 'undefined' && ctx.library.backend.kind === 'puter'
    ? h('button.icon-btn', { type: 'button', 'aria-label': 'Import from Puter', 'data-tip': 'Import from Puter' }, icon('cloud', 18))
    : null;
  puterBtn?.addEventListener('click', fromPuter);

  const viewBtn = h('button.icon-btn.media-view-btn', { type: 'button' });
  const syncViewBtn = () => {
    const list = viewPref() === 'list';
    viewBtn.replaceChildren(icon(list ? 'grid' : 'list', 16));
    viewBtn.setAttribute('aria-label', list ? 'Show as grid' : 'Show as list');
    viewBtn.dataset.tip = list ? 'Grid view' : 'List view';
  };
  syncViewBtn();
  viewBtn.addEventListener('click', () => {
    setPref('mediaView', viewPref() === 'list' ? 'grid' : 'list');
    syncViewBtn();
    layout.refresh();
  });

  function sortMenu() {
    const s = sortPref();
    const types = typesPref();
    const setSort = (patch) => {
      setPref('mediaSort', { ...s, ...patch });
      layout.refresh();
    };
    const toggleType = (t) => {
      const cur = new Set(types.length ? types : MEDIA_TYPES.map((x) => x.id));
      if (cur.has(t)) cur.delete(t);
      else cur.add(t);
      const next = MEDIA_TYPES.map((x) => x.id).filter((x) => cur.has(x));
      // Nothing or everything checked both mean "all types".
      setPref('mediaTypes', next.length === MEDIA_TYPES.length || !next.length ? [] : next);
      layout.refresh();
    };
    return [
      { heading: 'Sort by' },
      ...MEDIA_SORTS.map((o) => ({ label: o.label, checked: s.key === o.id, radio: true, onSelect: () => setSort({ key: o.id }) })),
      'separator',
      { label: s.key === 'name' || s.key === 'type' ? 'A to Z' : 'Smallest first', checked: s.dir === 'asc', radio: true, onSelect: () => setSort({ dir: 'asc' }) },
      { label: s.key === 'name' || s.key === 'type' ? 'Z to A' : s.key === 'added' ? 'Newest first' : 'Largest first', checked: s.dir === 'desc', radio: true, onSelect: () => setSort({ dir: 'desc' }) },
      'separator',
      { heading: 'Show' },
      ...MEDIA_TYPES.map((t) => ({ label: t.label, checked: !types.length || types.includes(t.id), onSelect: () => toggleType(t.id) })),
      'separator',
      { label: 'Remove unused media...', icon: 'trash', onSelect: () => actions.removeUnusedMedia() },
      { label: 'Find missing media...', icon: 'search', onSelect: () => actions.findMissingMedia() },
    ];
  }

  /* Folders -------------------------------------------------------------------- */
  async function newFolder(parent = currentFolder(), moveIds = null) {
    const name = await promptDialog({ title: 'New folder', label: 'Folder name', value: 'New folder', confirm: 'Create', maxLength: 80 });
    if (!name) return null;
    let bin = null;
    store.update('New folder', (p) => {
      bin = createBin(p, name, parent);
      if (moveIds?.length) moveAssets(p, moveIds, bin.id);
    }, { structural: false });
    announce(`Folder ${bin.name} created`);
    return bin;
  }

  async function rename(bin) {
    const name = await promptDialog({ title: 'Rename folder', label: 'Folder name', value: bin.name, confirm: 'Rename', maxLength: 80 });
    if (!name) return;
    store.update('Rename folder', (p) => renameBin(p, bin.id, name), { structural: false });
  }

  function removeFolder(bin) {
    const count = binItemCount(store.project, bin.id);
    const to = bin.parent ? findBin(store.project, bin.parent)?.name : 'the top level';
    store.update('Delete folder', (p) => deleteBin(p, bin.id), { structural: false });
    if (folder === bin.id) folder = bin.parent || null;
    toast(count ? `Deleted ${bin.name}. Its media moved to ${to}.` : `Deleted ${bin.name}.`);
  }

  function moveTo(ids, binId) {
    if (!ids.length) return;
    const n = store.update(binId ? 'Move to folder' : 'Move to top level', (p) => moveAssets(p, ids, binId) || false, { structural: false });
    if (n) {
      const where = binId ? findBin(store.project, binId)?.name : 'the top level';
      announce(`Moved ${ids.length === 1 ? store.project.assets[ids[0]]?.name || 'media' : `${ids.length} items`} to ${where}`);
    }
  }

  function open(binId) {
    folder = binId;
    selection.clear();
    anchor = null;
    if (layout.category !== 'project') layout.select('project');
    else layout.refresh();
    const name = binId ? findBin(store.project, binId)?.name : 'All media';
    announce(`Opened ${name}`);
  }

  /** Menu items listing every folder, indented, to move ids into. */
  function moveMenu(ids) {
    const items = [{ label: 'Top level', icon: 'folder', disabled: ids.every((id) => !store.project.assets[id]?.folder), onSelect: () => moveTo(ids, null) }];
    const walk = (parent, depth) => {
      for (const b of childBins(store.project, parent)) {
        items.push({ label: `${'  '.repeat(depth)}${b.name}`, icon: 'folder', disabled: ids.every((id) => store.project.assets[id]?.folder === b.id), onSelect: () => moveTo(ids, b.id) });
        walk(b.id, depth + 1);
      }
    };
    walk(null, 0);
    items.push('separator', { label: 'New folder...', icon: 'folderPlus', onSelect: () => newFolder(currentFolder(), ids) });
    return items;
  }

  /** Make el accept media (and folders) dropped from this panel into binId. */
  function dropTarget(el, binId) {
    el.addEventListener('dragover', (e) => {
      const types = [...(e.dataTransfer?.types || [])];
      if (!types.includes(DRAG_MIME) && !types.includes(BIN_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-into');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-into'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop-into');
      const binRaw = e.dataTransfer?.getData(BIN_MIME);
      const raw = e.dataTransfer?.getData(DRAG_MIME);
      if (!binRaw && !raw) return;
      e.preventDefault();
      e.stopPropagation();
      if (binRaw) {
        if (binRaw !== binId) store.update('Move folder', (p) => moveBin(p, binRaw, binId), { structural: false });
        return;
      }
      try {
        const d = JSON.parse(raw);
        if (d.kind === 'asset') moveTo(d.assetIds || [d.assetId], binId);
      } catch {
        /* not ours */
      }
    });
  }

  /* Selection ------------------------------------------------------------------ */
  function clickAsset(a, e) {
    const ids = visible.map((x) => x.id);
    if (e.shiftKey && anchor && ids.includes(anchor)) {
      const [i, j] = [ids.indexOf(anchor), ids.indexOf(a.id)].sort((x, y) => x - y);
      if (!(e.metaKey || e.ctrlKey)) selection.clear();
      ids.slice(i, j + 1).forEach((id) => selection.add(id));
    } else if (e.metaKey || e.ctrlKey) {
      if (selection.has(a.id)) selection.delete(a.id);
      else selection.add(a.id);
      anchor = a.id;
    } else {
      const only = selection.size === 1 && selection.has(a.id);
      selection.clear();
      if (!only) selection.add(a.id);
      anchor = a.id;
    }
    syncSelection();
  }

  const selectedInOrder = () => visible.filter((a) => selection.has(a.id));

  function addSelection() {
    const list = selectedInOrder();
    if (!list.length) return;
    if (list.length === 1) actions.addAsset(list[0]);
    else actions.addAssets(list);
  }

  async function removeAssets(list) {
    const used = new Set(allClipsDeep(store.project).map((c) => c.assetId));
    const inUse = list.filter((a) => used.has(a.id));
    const title = list.length === 1 ? 'Delete media?' : `Delete ${list.length} items?`;
    if (inUse.length && !(await confirmDialog({ title, message: inUse.length === 1 && list.length === 1 ? `${list[0].name} is used on the timeline. Its clips will be removed too.` : `${inUse.length} of these are used on the timeline. Their clips will be removed too.`, confirm: 'Delete', danger: true }))) return;
    if (list.length === 1) {
      actions.removeAsset(list[0].id);
      return;
    }
    const ids = new Set(list.map((a) => a.id));
    store.update(`Delete ${list.length} items`, (p) => {
      removeAssetClips(p, ids);
      for (const id of ids) delete p.assets[id];
    });
    announce(`Deleted ${list.length} items`);
  }

  const selBar = h('div.media-selbar', { role: 'toolbar', 'aria-label': 'Selected media', hidden: true });
  function syncSelection() {
    for (const id of [...selection]) if (!store.project.assets[id]) selection.delete(id);
    for (const el of layout.el.querySelectorAll('[data-asset]')) {
      const on = selection.has(el.dataset.asset);
      el.classList.toggle('selected', on);
      el.setAttribute('aria-pressed', String(on));
    }
    const n = selection.size;
    selBar.hidden = n === 0;
    if (!n) {
      selBar.replaceChildren();
      return;
    }
    const add = h('button.btn.small.primary', { type: 'button' }, icon('plus', 14), n === 1 ? 'Add to timeline' : `Add ${n} to timeline`);
    add.addEventListener('click', addSelection);
    const mv = h('button.btn.small', { type: 'button' }, icon('folderInput', 14), 'Move');
    menuButton(mv, () => moveMenu([...selection]), { label: 'Move to folder' });
    const del = h('button.icon-btn.small', { type: 'button', 'aria-label': `Delete ${n === 1 ? 'selected item' : `${n} selected items`}`, 'data-tip': 'Delete' }, icon('trash', 14));
    del.addEventListener('click', () => removeAssets(selectedInOrder()));
    const clear = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Clear selection', 'data-tip': 'Clear selection' }, icon('close', 14));
    clear.addEventListener('click', () => {
      selection.clear();
      syncSelection();
    });
    selBar.replaceChildren(h('span.media-selcount', { role: 'status' }, `${n} selected`), add, mv, del, clear);
  }

  /* Items ---------------------------------------------------------------------- */
  function posterCanvas(a, w, hgt) {
    const cv = h('canvas.tile-canvas', { width: w, height: hgt, 'aria-hidden': 'true' });
    const draw = (bmp) => {
      const c2 = cv.getContext('2d');
      if (!c2) return;
      c2.fillStyle = '#111';
      c2.fillRect(0, 0, w, hgt);
      if (!bmp) return;
      const k = Math.max(w / bmp.width, hgt / bmp.height);
      c2.drawImage(bmp, (w - bmp.width * k) / 2, (hgt - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
    };
    draw(null);
    media.poster(a).then(draw, () => {});
    return cv;
  }

  function assetMenu(a, e) {
    if (!selection.has(a.id)) {
      selection.clear();
      selection.add(a.id);
      anchor = a.id;
      syncSelection();
    }
    const list = selectedInOrder();
    const many = list.length > 1;
    showMenu({ x: e.clientX, y: e.clientY }, [
      { label: many ? `Add ${list.length} to timeline` : 'Add to timeline', icon: 'plus', onSelect: addSelection },
      !many && a.kind === 'video' && a.hasAudio ? { label: 'Add audio only', icon: 'music', onSelect: () => actions.addAsset({ ...a, kind: 'audio' }) } : null,
      { label: 'Move to folder', icon: 'folderInput', submenu: () => moveMenu(list.map((x) => x.id)) },
      !many ? { label: 'Show on timeline', icon: 'search', onSelect: () => actions.revealAsset(a.id) } : null,
      !many ? { label: 'Replace file...', icon: 'replace', onSelect: () => actions.replaceAssetFile(a.id) } : null,
      ...proxyMenu(list),
      'separator',
      { label: many ? `Delete ${list.length} items` : 'Delete', icon: 'trash', danger: true, onSelect: () => removeAssets(list) },
    ].filter(Boolean), { label: many ? `${list.length} items` : a.name });
  }

  /* Proxies ------------------------------------------------------------------- */
  function proxyBadge(a) {
    // Painted once it is in its item, which carries the spoken status.
    return h('span.proxy-badge', { 'data-proxy-asset': a.id, 'aria-hidden': 'true', hidden: true }, icon('zap', 10), h('span.proxy-badge-text'), h('span.proxy-badge-bar', h('span')));
  }

  function paintProxy(el) {
    const a = store.project.assets[el.dataset.proxyAsset];
    const b = proxyBadgeState(a, proxies, proxyMode(store.project));
    el.dataset.state = b.state;
    el.hidden = b.state === 'none';
    el.querySelector('.proxy-badge-text').textContent = b.text;
    el.style.setProperty('--progress', String(b.progress || 0));
    el.title = b.label;
    // Screen readers hear the status on the item itself.
    const host = el.closest('[data-asset]');
    if (host) {
      if (b.label) host.setAttribute('aria-description', b.label);
      else host.removeAttribute('aria-description');
    }
  }

  function repaintProxies(hash) {
    for (const el of layout.el.querySelectorAll('[data-proxy-asset]')) {
      const a = store.project.assets[el.dataset.proxyAsset];
      if (a && (!hash || a.hash === hash)) paintProxy(el);
    }
  }

  /** Media menu items for proxies of the chosen items. */
  function proxyMenu(list) {
    const videos = list.filter(canProxy);
    if (!proxies || !videos.length) return [];
    const mode = proxyMode(store.project);
    const states = videos.map((x) => proxies.status(x).state);
    const offNote = () => {
      if (mode === 'off') toast('Proxy media is off for this project. Turn it on in the project details to use proxies.', { action: { label: 'Turn on', onClick: () => actions.setProxyMode('on') } });
    };
    const create = () => {
      videos.forEach((x) => proxies.create(x));
      announce(videos.length === 1 ? `Making a proxy for ${videos[0].name}` : `Making proxies for ${videos.length} videos`);
      offNote();
    };
    const remove = async () => {
      for (const x of videos) await proxies.remove(x);
      announce(videos.length === 1 ? 'Proxy deleted' : 'Proxies deleted');
    };
    if (videos.length === 1) {
      const st = states[0];
      if (st === 'ready') return [{ label: 'Delete proxy', icon: 'zap', onSelect: remove }];
      if (st === 'queued' || st === 'generating') return [{ label: 'Stop making proxy', icon: 'close', onSelect: remove }];
      return [{ label: st === 'error' ? 'Try proxy again' : 'Create proxy', icon: 'zap', onSelect: create }];
    }
    const items = [];
    if (states.some((st) => st !== 'ready')) items.push({ label: 'Create proxies', icon: 'zap', onSelect: create });
    if (states.some((st) => st !== 'none' && st !== 'error')) items.push({ label: 'Delete proxies', icon: 'zap', onSelect: remove });
    return items;
  }

  function dragData(a) {
    const ids = selection.has(a.id) ? selectedInOrder().map((x) => x.id) : [a.id];
    return { kind: 'asset', assetId: a.id, assetIds: ids };
  }

  function assetTile(a, used, showFolder) {
    const t = tile({
      label: a.name,
      preview: a.kind === 'audio' ? h('span.tile-audio', icon('music', 26)) : posterCanvas(a, 160, 90),
      badge: a.kind === 'image' ? null : clock(a.duration),
      sub: used ? 'Added' : showFolder && a.folder ? findBin(store.project, a.folder)?.name : null,
      selected: selection.has(a.id),
      onSelect: (e) => clickAsset(a, e),
      onAdd: () => actions.addAsset(a),
      drag: () => dragData(a),
      addLabel: `${a.name}, ${assetFacts(a)}${used ? ', on the timeline' : ''}. Press Enter to add to the timeline`,
      plusLabel: `Add ${a.name} to timeline`,
    });
    t.dataset.asset = a.id;
    if (canProxy(a)) paintProxy(t.querySelector('.tile-preview').appendChild(proxyBadge(a)));
    t.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      assetMenu(a, e);
    });
    return t;
  }

  function assetRow(a, used, showFolder) {
    const thumb = a.kind === 'audio' ? h('span.media-row-thumb.audio', icon('music', 16)) : h('span.media-row-thumb', posterCanvas(a, 64, 36));
    const btn = h(`button.media-row${selection.has(a.id) ? '.selected' : ''}`, {
      type: 'button',
      draggable: 'true',
      'aria-pressed': String(selection.has(a.id)),
      'aria-label': `${a.name}, ${assetFacts(a)}${used ? ', on the timeline' : ''}. Press Enter to add to the timeline`,
      'data-asset': a.id,
    },
    thumb,
    h('span.media-row-text',
      h('span.media-row-name', a.name),
      h('span.media-row-facts', { 'aria-hidden': 'true' }, icon(KIND_ICON[a.kind] || 'film', 12), assetFacts(a), showFolder && a.folder ? ` · ${findBin(store.project, a.folder)?.name || ''}` : ''),
    ),
    canProxy(a) ? proxyBadge(a) : null,
    used ? h('span.media-row-used', { 'aria-hidden': 'true' }, 'Added') : null,
    );
    btn.addEventListener('click', (e) => clickAsset(a, e));
    btn.addEventListener('dblclick', () => actions.addAsset(a));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.repeat) {
        e.preventDefault();
        actions.addAsset(a);
      }
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      assetMenu(a, e);
    });
    btn.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify(dragData(a)));
      e.dataTransfer.setData('text/plain', a.name);
      document.body.classList.add('dragging-asset');
    });
    btn.addEventListener('dragend', () => document.body.classList.remove('dragging-asset'));
    const rowBadge = btn.querySelector('[data-proxy-asset]');
    if (rowBadge) paintProxy(rowBadge);
    const plus = h('button.icon-btn.small.media-row-add', { type: 'button', 'aria-label': `Add ${a.name} to timeline`, 'data-tip': 'Add to timeline' }, icon('plus', 14));
    plus.addEventListener('click', () => actions.addAsset(a));
    return h('div.media-row-cell', { role: 'listitem' }, btn, plus);
  }

  function folderItem(b, asRow) {
    const count = binItemCount(store.project, b.id);
    const sub = childBins(store.project, b.id).length;
    const facts = [count ? `${count} item${count === 1 ? '' : 's'}` : 'Empty', sub ? `${sub} folder${sub === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
    const label = `Folder ${b.name}, ${facts}`;
    const el = asRow
      ? h('button.media-row.folder-row', { type: 'button', draggable: 'true', 'aria-label': label }, h('span.media-row-thumb.folder', icon('folder', 18)), h('span.media-row-text', h('span.media-row-name', b.name), h('span.media-row-facts', { 'aria-hidden': 'true' }, facts)))
      : h('button.tile.folder-tile', { type: 'button', draggable: 'true', 'aria-label': label },
        h('span.tile-preview.folder-preview', icon('folder', 34), h('span.tile-badge', { 'aria-hidden': 'true' }, String(count))),
        h('span.tile-label', b.name));
    el.addEventListener('click', () => open(b.id));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu({ x: e.clientX, y: e.clientY }, [
        { label: 'Open', icon: 'folderOpen', onSelect: () => open(b.id) },
        { label: 'Rename...', icon: 'pencil', onSelect: () => rename(b) },
        { label: 'New folder inside...', icon: 'folderPlus', onSelect: () => newFolder(b.id) },
        'separator',
        { label: 'Delete folder', icon: 'trash', danger: true, onSelect: () => removeFolder(b) },
      ], { label: b.name });
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'F2') {
        e.preventDefault();
        rename(b);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeFolder(b);
      }
    });
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(BIN_MIME, b.id);
      e.dataTransfer.setData('text/plain', b.name);
    });
    dropTarget(el, b.id);
    return asRow ? h('div.media-row-cell', { role: 'listitem' }, el) : el;
  }

  function breadcrumb() {
    const path = binPath(store.project, currentFolder());
    const crumbs = [{ id: null, name: 'All media' }, ...path];
    const nav = h('nav.media-crumbs', { 'aria-label': 'Folder path' });
    crumbs.forEach((c, i) => {
      const last = i === crumbs.length - 1;
      const b = h('button.media-crumb', { type: 'button', 'aria-current': last ? 'location' : null }, i === 0 ? icon('home', 13) : null, c.name);
      if (!last) b.addEventListener('click', () => open(c.id));
      dropTarget(b, c.id);
      if (i) nav.append(h('span.media-crumb-sep', { 'aria-hidden': 'true' }, '/'));
      nav.append(b);
    });
    return nav;
  }

  /* Backdrops ------------------------------------------------------------------ */
  function addBackdrop(b) {
    const W = store.project.settings.width;
    const H = store.project.settings.height;
    const c = document.createElement('canvas');
    c.width = Math.min(W, 1920);
    c.height = Math.round((c.width * H) / W);
    const g = c.getContext('2d');
    if (!g) return;
    drawBackdrop(g, b, c.width, c.height);
    c.toBlob(async (blob) => {
      if (!blob) return;
      const file = new File([blob], `${b.label} backdrop.png`, { type: 'image/png' });
      const [asset] = await actions.importFiles([file], { folder: currentFolder(), origin: 'backdrop' });
      if (asset) actions.addAsset(asset);
    }, 'image/png');
  }

  function renderBackdrops(q) {
    const list = BACKDROPS.filter((b) => !q || b.label.toLowerCase().includes(q));
    if (!list.length) return emptyState('search', 'No backdrops found', 'Try another word.');
    const tileFor = (b) => {
      const cv = h('canvas.tile-canvas', { width: 160, height: 90, 'aria-hidden': 'true' });
      const c2 = cv.getContext('2d');
      if (c2) drawBackdrop(c2, b, 160, 90);
      return tile({ label: b.label, preview: cv, onAdd: () => addBackdrop(b), addLabel: `Add ${b.label} backdrop` });
    };
    return h('div.backdrops',
      h('p.asset-hint', 'Made on your device at your project size. Click one to add it at the playhead.'),
      BACKDROP_GROUPS.map((g) => {
        const items = list.filter((b) => b.group === g.id);
        if (!items.length) return null;
        return h('section.asset-group', h('h3.asset-group-title', g.label), tileGrid(items.map(tileFor), { label: g.label }));
      }),
    );
  }

  /* Bin ------------------------------------------------------------------------ */
  function renderBin(cat, q) {
    const s = sortPref();
    const types = typesPref();
    const asList = viewPref() === 'list';
    const used = new Set(allClipsDeep(store.project).map((c) => c.assetId));
    const inFolders = cat === 'project' && !q;
    if (folder && !findBin(store.project, folder)) folder = null;
    const pool = inFolders ? assetsInBin(store.project, folder) : Object.values(store.project.assets);
    const typeFilter = TYPE_CATS.has(cat) ? [cat] : types;
    visible = sortAssets(filterAssets(pool, { types: typeFilter, query: q }), s);
    const folders = inFolders ? childBins(store.project, folder) : [];
    const status = importing ? h('div.import-progress', { role: 'status' }, h('div.spinner'), `Importing ${importing} file${importing === 1 ? '' : 's'}...`) : null;
    const crumbs = cat === 'project' && (binsOf(store.project).length || folder) && !q ? breadcrumb() : null;
    const total = Object.keys(store.project.assets).length;

    if (!visible.length && !folders.length) {
      let empty;
      if (q) empty = emptyState('search', 'No matches', 'Try another name.');
      else if (!total) {
        const cta = h('button.btn.primary', { type: 'button' }, icon('import', 16), 'Import media');
        cta.addEventListener('click', () => fileInput.click());
        empty = h('div.drop-zone', emptyState('import', 'Import your media', 'Drag videos, photos and audio here, or choose files. You can also record your camera or screen.', cta));
      } else if (folder) empty = emptyState('folderOpen', 'This folder is empty', 'Drag media here, or import while the folder is open.');
      else if (TYPE_CATS.has(cat)) empty = emptyState(KIND_ICON[cat], `No ${KIND_LABEL[cat].toLowerCase()} media`, 'Import some to see it here.');
      else empty = emptyState('filter', 'Nothing to show', 'Some media types are hidden. Change what is shown in the sort and filter menu.');
      return h('div.media-bin', status, crumbs, empty);
    }

    const showFolder = !inFolders && binsOf(store.project).length > 0;
    let body;
    if (asList) {
      body = h('div.media-list', { role: 'list', 'aria-label': folder ? `Folder ${findBin(store.project, folder)?.name}` : 'Project media' },
        folders.map((b) => folderItem(b, true)),
        visible.map((a) => assetRow(a, used.has(a.id), showFolder)));
    } else {
      body = tileGrid([...folders.map((b) => folderItem(b, false)), ...visible.map((a) => assetTile(a, used.has(a.id), showFolder))], { label: folder ? `Folder ${findBin(store.project, folder)?.name}` : 'Project media', className: 'media-grid' });
    }
    body.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        e.stopPropagation();
        visible.forEach((a) => selection.add(a.id));
        syncSelection();
      } else if (e.key === 'Escape' && selection.size) {
        e.stopPropagation();
        selection.clear();
        syncSelection();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size && e.target.closest('[data-asset]')) {
        e.preventDefault();
        e.stopPropagation();
        removeAssets(selectedInOrder());
      }
    });
    // List rows move with the arrow keys too.
    if (asList) {
      body.setAttribute('data-own-arrows', '');
      body.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        const rows = [...body.querySelectorAll('.media-row')];
        const i = rows.indexOf(document.activeElement);
        const j = i + (e.key === 'ArrowDown' ? 1 : -1);
        if (i >= 0 && j >= 0 && j < rows.length) {
          e.preventDefault();
          rows[j].focus();
        }
      });
    }
    return h('div.media-bin', status, crumbs, body);
  }

  layout = tabLayout({
    title: 'Media',
    categories: [
      {
        id: 'bin',
        label: 'Project',
        children: [
          { id: 'project', label: 'All media' },
          { id: 'video', label: 'Videos' },
          { id: 'image', label: 'Photos' },
          { id: 'audio', label: 'Audio' },
        ],
      },
      { id: 'timelines', label: 'Timelines', icon: 'timelines' },
      { id: 'generate', label: 'Generate', icon: 'magic' },
      { id: 'backdrops', label: 'Backdrops' },
    ],
    topbar: [importBtn, recordBtn, folderBtn, puterBtn, fileInput],
    toolbar: viewBtn,
    menu: sortMenu,
    menuLabel: 'Sort and filter',
    menuActive: () => typesPref().length > 0 || sortPref().key !== 'added' || sortPref().dir !== 'desc',
    render(cat, q) {
      const binView = cat === 'project' || TYPE_CATS.has(cat);
      viewBtn.hidden = !binView;
      layout?.el.querySelector('.asset-menu-btn')?.toggleAttribute('hidden', !binView);
      folderBtn.disabled = !binView;
      if (cat === 'backdrops') return renderBackdrops(q);
      if (cat === 'timelines') return renderTimelines(ctx, q);
      if (cat === 'generate') return (gen ||= generatePanel(ctx, { getFolder: currentFolder })).el;
      const out = renderBin(cat, q);
      queueMicrotask(syncSelection);
      return out;
    },
  });
  layout.el.querySelector('.asset-main')?.append(selBar);
  layout.el.querySelector('.asset-menu-btn')?.toggleAttribute('hidden', !['project', 'video', 'image', 'audio'].includes(layout.category));
  layout.el.classList.add('media-tab');

  function openRecord(mode) {
    openRecordDialog(ctx, { mode, folder: currentFolder() });
  }

  // Drop files anywhere on the tab.
  layout.el.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) {
      e.preventDefault();
      layout.el.classList.add('drop-target');
    }
  });
  layout.el.addEventListener('dragleave', (e) => {
    if (!layout.el.contains(e.relatedTarget)) layout.el.classList.remove('drop-target');
  });
  layout.el.addEventListener('drop', (e) => {
    layout.el.classList.remove('drop-target');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    importWithProgress(files);
  });

  let pendingRefresh = 0;
  const refreshSoon = () => {
    cancelAnimationFrame(pendingRefresh);
    pendingRefresh = requestAnimationFrame(() => {
      if (layout.category === 'generate') return;
      layout.refresh();
    });
  };
  // Re-render only when the media list, folders or which media is in use change.
  const signature = () => {
    const used = new Set(allClipsDeep(store.project).map((c) => c.assetId));
    const assets = Object.values(store.project.assets).map((a) => `${a.id}:${used.has(a.id) ? 1 : 0}:${a.folder || ''}:${a.name}`).join('|');
    const timelines = layout?.category === 'timelines' ? timelinesSignature(store.project) : '';
    return `${assets}#${binsOf(store.project).map((b) => `${b.id}:${b.name}:${b.parent || ''}`).join('|')}#${timelines}#${proxyMode(store.project)}`;
  };
  let sig = signature();
  const off = store.on('change', () => {
    const next = signature();
    if (next === sig) return;
    sig = next;
    refreshSoon();
  });

  const offProxies = proxies?.on('change', ({ hash } = {}) => repaintProxies(hash));

  return {
    el: layout.el,
    openImport: () => fileInput.click(),
    openRecord,
    dispose() {
      off();
      offProxies?.();
      gen?.dispose?.();
      layout.dispose();
    },
  };
}

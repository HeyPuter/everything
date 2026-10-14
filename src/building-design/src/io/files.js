/**
 * Opening, saving and recovering projects: Puter cloud files, device files
 * and IndexedDB recovery copies (so work survives reloads without an
 * account). Projects are always stored as files.
 */
import { h, clear } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openDialog as modal, toast, unsavedDialog, promptDialog, confirmDialog } from '../ui/dialog.js';
import { encodeProject, decodeProject, baseName, safeFileName, NATIVE_EXT } from './native.js';
import { cloudList, cloudRead, cloudWrite, isExistsError, deviceOpen, deviceSave, download, recovery, acquireSessionLock, recentFiles as recent, addRecent, removeRecent, usePuterPickers, puterOpenPicker, puterSavePicker, CLOUD_DIR } from './storage.js';
import { isSignedIn, puterAvailable, whenPuter } from '../platform.js';
import { scheduleRows, scheduleColumns, toCSV } from '../core/schedule.js';

export const recentFiles = recent;

// Recovery ---------------------------------------------------------------------------------

let recoveryTimer = 0;
let ownsSession = null;

export function scheduleRecovery(app) {
  clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(() => writeRecovery(app), 1200);
}

async function writeRecovery(app) {
  if (!app.doc) return;
  if (ownsSession === null) ownsSession = await acquireSessionLock();
  if (!ownsSession) return;
  try {
    const blob = await encodeProject(app.doc);
    const data = await blob.arrayBuffer();
    const meta = app.file ? { name: app.file.name, path: app.file.path || null, source: app.file.source } : null;
    await recovery.put({ id: app.docId, data, file: meta, modified: app.doc.modified, savedAt: Date.now(), name: app.file?.name || app.doc.project.name });
    await recovery.setSession({ docId: app.docId, views: app.openViews, active: app.activeViewId });
  } catch (err) {
    console.warn('Recovery copy failed', err);
  }
}

/** Restore the last session in this browser. Returns true when a project was restored. */
export async function recover(app) {
  ownsSession = await acquireSessionLock();
  if (!ownsSession) return false;
  const session = await recovery.getSession();
  if (!session?.docId) return false;
  const rec = await recovery.get(session.docId);
  if (!rec?.data) return false;
  try {
    const doc = await decodeProject(rec.data);
    if (rec.modified) doc.savedRevision = -1;
    const file = rec.file ? { ...rec.file, recoveryId: rec.id } : { recoveryId: rec.id, name: rec.name, source: 'local' };
    app.setDoc(doc, file);
    for (const id of session.views || []) if (doc.has(id)) app.openView(id);
    if (session.active && doc.has(session.active)) app.activateView(session.active);
    return true;
  } catch (err) {
    console.warn('Could not restore the last session', err);
    return false;
  }
}

// Opening ------------------------------------------------------------------------------------

async function confirmDiscard(app) {
  if (!app.doc?.modified) return true;
  // Projects kept only in this browser are safe in the recovery store, but ask anyway.
  const r = await unsavedDialog(app.file?.name || app.doc.project.name || 'Untitled');
  if (r === 'save') return (await save(app)) !== false;
  return r === 'discard';
}

async function loadBuffer(app, buffer, file) {
  try {
    const doc = await decodeProject(buffer);
    await recovery.delete(app.docId);
    app.setDoc(doc, file);
    if (file?.path) addRecent({ name: file.name, path: file.path, source: file.source });
    toast(`Opened ${file?.name || 'project'}.`, { kind: 'success' });
    return true;
  } catch (err) {
    toast(err.message || 'This file could not be opened.', { kind: 'error' });
    return false;
  }
}

export async function openCloud(app, path, name) {
  if (!(await confirmDiscard(app))) return;
  try {
    const buf = await cloudRead(path);
    await loadBuffer(app, buf, { name: baseName(name || path), path, source: 'cloud' });
  } catch (err) {
    toast(`Could not open the file: ${err.message || err}`, { kind: 'error' });
    removeRecent(path);
  }
}

export async function openRecent(app, r) {
  if (r.source === 'cloud') return openCloud(app, r.path, r.name);
  toast('Device files are opened with Open > This device.', { kind: 'info' });
}

export async function openDevice(app) {
  if (!(await confirmDiscard(app))) return;
  const f = await deviceOpen();
  if (!f) return;
  await loadBuffer(app, f.buffer, { name: baseName(f.name), handle: f.handle || null, source: 'device' });
}

/** Files passed by the Puter desktop ("Open with"). */
export async function handleLaunchItems(app) {
  try {
    if (typeof puter?.ui?.onLaunchedWithItems !== 'function') return;
    puter.ui.onLaunchedWithItems(async (items) => {
      const f = items?.[0];
      if (!f) return;
      const blob = await f.read();
      await loadBuffer(app, await blob.arrayBuffer(), { name: baseName(f.name), path: f.path, source: 'cloud' });
    });
  } catch {
    /* not launched from the desktop */
  }
}

export async function openDialog(app, tab = null) {
  if (usePuterPickers() && !tab) {
    if (!(await confirmDiscard(app))) return;
    try {
      const f = await puterOpenPicker();
      if (f) await loadBuffer(app, f.buffer, { name: baseName(f.name), path: f.path, source: 'cloud' });
    } catch (err) {
      if (err) toast(`Could not open: ${err.message || err}`, { kind: 'error' });
    }
    return;
  }
  const list = h('ul.file-list', { role: 'list' });
  const status = h('div.file-empty', { role: 'status' });
  const tabs = h('div.tabs', { role: 'tablist', 'aria-label': 'Where to open from' });
  const panel = h('div', { role: 'tabpanel' });
  let close = null;
  const show = async (which) => {
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.tab === which));
    clear(panel);
    clear(list);
    clear(status);
    if (which === 'device') {
      panel.append(
        h('p.dialog-text', 'Open a project file (.bdp) from this computer or phone.'),
        h('div', { style: { marginTop: '12px' } }, h('button.btn.primary', { type: 'button', onClick: () => (close?.(), openDevice(app)) }, icon('device', 16), 'Choose a file')),
      );
      return;
    }
    if (which === 'recent') {
      const rec = recent();
      if (!rec.length) panel.append(h('p.dialog-text', 'Projects you open from Puter appear here.'));
      for (const r of rec) list.append(fileItem(r.name, new Date(r.at).toLocaleString(), r.source === 'cloud' ? 'cloud' : 'device', () => (close?.(), openRecent(app, r))));
      panel.append(list);
      return;
    }
    panel.append(status, list);
    if (!puterAvailable() || !(await whenPuter(4000))) {
      status.append(h('p', 'Puter could not be reached. Check your connection.'));
      return;
    }
    if (!(await isSignedIn())) {
      status.append(h('p', which === 'shared' ? 'Sign in to see projects other people shared with you.' : 'Sign in with Puter to keep projects in your cloud storage.'), h('button.btn.primary', { type: 'button', onClick: async () => (await app.signIn()) && show(which) }, icon('log-in', 16), 'Sign in'));
      return;
    }
    status.append(h('p', 'Loading...'));
    try {
      let items;
      if (which === 'shared') {
        const r = await puter.fs.listShared();
        items = (r?.items || []).filter((f) => !f.is_dir && /\.bdp$/i.test(f.name));
      } else items = (await cloudList()).items;
      clear(status);
      if (!items.length) status.append(h('p', which === 'shared' ? 'Nothing has been shared with you yet.' : `No projects in ${CLOUD_DIR} yet. Save a project to see it here.`));
      for (const f of items) {
        const when = f.modified ? new Date((f.modified > 1e12 ? f.modified : f.modified * 1000)).toLocaleString() : '';
        list.append(fileItem(baseName(f.name), when, which === 'shared' ? 'users' : 'cloud', () => (close?.(), openCloud(app, f.path, f.name))));
      }
    } catch (err) {
      clear(status);
      status.append(h('p', `Could not list files: ${err.message || err}`));
    }
  };
  for (const [id, label, ic] of [
    ['cloud', 'Puter', 'cloud'],
    ['shared', 'Shared with me', 'users'],
    ['device', 'This device', 'device'],
    ['recent', 'Recent', 'history'],
  ])
    tabs.append(h('button.tab', { type: 'button', role: 'tab', dataset: { tab: id }, onClick: () => show(id) }, h('span.inline', icon(ic, 14), label)));
  const body = h('div', tabs, panel);
  const p = modal({ title: 'Open Project', body, size: 'md', actions: [{ label: 'Cancel', value: null }], onClose: () => (close = null) });
  close = () => document.querySelector('dialog[open]')?._close?.(null);
  const signed = puterAvailable() && (await isSignedIn().catch(() => false));
  show(tab || (signed ? 'cloud' : 'device'));
  return p;
}

function fileItem(name, meta, ic, onClick) {
  return h('li', h('button.file-item', { type: 'button', onClick }, icon(ic, 16), h('span.file-name', name), h('span.file-meta', meta)));
}

// Saving --------------------------------------------------------------------------------------

export async function save(app) {
  if (!app.doc) return false;
  const f = app.file;
  if (f?.source === 'cloud' && f.path) return writeCloud(app, f.path, f.name);
  if (f?.source === 'device' && f.handle) return writeDevice(app, f.name, f.handle);
  return saveAs(app);
}

async function writeCloud(app, path, name) {
  try {
    const blob = await encodeProject(app.doc);
    await cloudWrite(path, blob, true);
    app.doc.markSaved();
    app.file = { ...app.file, name, path, source: 'cloud' };
    addRecent({ name, path, source: 'cloud' });
    app.updateTitle();
    scheduleRecovery(app);
    toast(`Saved ${name} to Puter.`, { kind: 'success' });
    return true;
  } catch (err) {
    toast(`Could not save: ${err.message || err}`, { kind: 'error' });
    return false;
  }
}

async function writeDevice(app, name, handle) {
  const blob = await encodeProject(app.doc);
  const r = await deviceSave(blob, `${safeFileName(name)}${NATIVE_EXT}`, handle);
  if (!r) return false;
  app.doc.markSaved();
  app.file = { ...app.file, name: baseName(r.name), handle: r.handle || null, source: 'device' };
  app.updateTitle();
  scheduleRecovery(app);
  toast(r.downloaded ? `Downloaded ${r.name}.` : `Saved ${r.name}.`, { kind: 'success' });
  return true;
}

export async function saveAs(app) {
  if (!app.doc) return false;
  const name0 = app.file?.name || app.doc.project.name || 'Untitled';
  if (usePuterPickers()) {
    try {
      const blob = await encodeProject(app.doc);
      const r = await puterSavePicker(blob, `${safeFileName(name0)}${NATIVE_EXT}`);
      if (!r) return false;
      app.doc.markSaved();
      app.file = { name: baseName(r.name), path: r.path, source: 'cloud' };
      addRecent({ name: app.file.name, path: r.path, source: 'cloud' });
      app.updateTitle();
      toast(`Saved ${app.file.name}.`, { kind: 'success' });
      return true;
    } catch (err) {
      toast(`Could not save: ${err.message || err}`, { kind: 'error' });
      return false;
    }
  }
  const signed = puterAvailable() && (await isSignedIn().catch(() => false));
  const choice = await modal({
    title: 'Save Project',
    size: 'sm',
    body: h(
      'div.open-sources',
      h('button.btn.big', { type: 'button', onClick: () => document.querySelector('dialog[open]')._close('cloud') }, icon('cloud', 22), h('span', h('strong', 'Puter cloud'), h('small', signed ? 'Keep it in your Puter storage, open it anywhere and share it.' : 'Sign in to keep it in your Puter storage and share it.'))),
      h('button.btn.big', { type: 'button', onClick: () => document.querySelector('dialog[open]')._close('device') }, icon('device', 22), h('span', h('strong', 'This device'), h('small', 'Save a .bdp file on this computer or phone.'))),
    ),
    actions: [{ label: 'Cancel', value: null }],
  });
  if (choice === 'device') return writeDevice(app, name0, null);
  if (choice !== 'cloud') return false;
  if (!signed && !(await app.signIn())) return false;
  const name = await promptDialog('Save to Puter', 'Project name', name0, { okLabel: 'Save', validate: (v) => (!v ? 'Enter a name.' : null) });
  if (!name) return false;
  const path = `${CLOUD_DIR}/${safeFileName(name)}${NATIVE_EXT}`;
  try {
    const blob = await encodeProject(app.doc);
    await cloudWrite(path, blob, false);
  } catch (err) {
    if (isExistsError(err)) {
      if (!(await confirmDialog('Replace project?', `"${name}" already exists in Puter. Replace it?`, { confirm: 'Replace', danger: true }))) return false;
    } else {
      toast(`Could not save: ${err.message || err}`, { kind: 'error' });
      return false;
    }
  }
  return writeCloud(app, path, safeFileName(name));
}

// Exports --------------------------------------------------------------------------------------

export function exportScheduleCSV(app, id) {
  const view = app.doc.get(id);
  if (!view || view.kind !== 'schedule') return;
  const cols = scheduleColumns(app.doc, view);
  const rows = scheduleRows(app, view);
  const csv = toCSV(cols, rows, app.doc.units);
  download(new Blob([csv], { type: 'text/csv' }), `${safeFileName(view.name)}.csv`);
}

export { download };

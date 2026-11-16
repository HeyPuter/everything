/**
 * Files feature: documents as PDF-compatible .ai files, opening and saving in the
 * Puter cloud or on this computer, recent files, autosave and recovery,
 * New Document / New from Template, Document Setup, Document Info and
 * Preferences, Puter launch items and window close handling.
 */
import { BookmarkPlus, RectangleVertical } from 'lucide';
import { registerIcons } from '../../ui/icons.js';
import { NATIVE_EXT, LEGACY_EXT, baseName, dirName, extensionOf } from './naming.js';
import { RecentFiles } from './recent.js';
import { Autosaver } from './autosave.js';
import { FileService } from './service.js';
import { opfsAvailable, opfsBackend, memoryBackend } from './backends.js';
// Dialogs load on first use to keep startup lean.
const newDocument = () => import('./new-document.js');
const templates = () => import('./templates.js');
const documentSetup = () => import('./document-setup.js');
const documentInfo = () => import('./document-info.js');
import { preferencesDialog, ensurePrefDefaults, applyPrefs, applyEditorPrefs, sections } from './preferences.js';
import { installHomeFiles } from './home-files.js';
import { cancelOpenDialogs } from '../../ui/dialogs/dialog.js';
import './styles.css';

export function install(app) {
  registerIcons({ 'bookmark-plus': BookmarkPlus, 'rectangle-vertical': RectangleVertical });
  ensurePrefDefaults(app.prefs);

  const cache = opfsAvailable() ? opfsBackend('vector-studio-cache') : memoryBackend();
  const recent = new RecentFiles(app.prefs, { cache });
  const autosaver = new Autosaver(app);
  const service = new FileService(app, { recent, recovery: autosaver });
  const files = {
    service,
    recent,
    autosaver,
    cache,
    get cloud() {
      return service.cloud;
    },
    clearRecent() {
      recent.clear();
      if (!app.home?.hidden) app.renderHome(app.home);
      app.notify('Cleared recent files.', { polite: true });
    },
  };
  app.files = files;

  app.newDocumentDialog = async () => (await newDocument()).newDocumentDialog(app);
  app.openFileBlob = (file, opts) => service.openFileBlob(file, opts);
  app.recentMenuItems = () => recentMenuItems(app, files);
  installHomeFiles(app, files);
  registerCommands(app, files);

  app.on('active-editor', (ed) => ed && applyEditorPrefs(app, ed));
  app.on('user', () => {
    if (app.home && !app.home.hidden) app.renderHome(app.home);
  });
  app.on('started', () => {
    applyPrefs(app);
    installDrop(app, service);
    installPuterHooks(app, service);
    autosaver.start();
  });
  app.on('ready', () => {
    autosaver.offerRecovery().catch((err) => console.warn('Recovery check failed', err));
  });
}

function registerCommands(app, { service }) {
  const ed = (a, args) => args?.editor || a.editor;
  app.commands.register([
    { id: 'file.newFromTemplate', label: 'New from Template...', shortcut: 'Shift+Mod+N', run: async (a) => (await templates()).newFromTemplate(a) },
    { id: 'file.newQuick', label: 'New with Last Settings', shortcut: 'Alt+Mod+N', run: async (a) => (await newDocument()).newDocumentQuick(a) },
    { id: 'file.open', label: 'Open...', shortcut: 'Mod+O', run: () => service.open() },
    { id: 'file.openLocal', label: 'Open from This Computer...', run: () => service.openLocal() },
    { id: 'file.save', label: 'Save', shortcut: 'Mod+S', enabled: (a, args) => Boolean(ed(a, args)), run: (a, args) => service.save(ed(a, args)) },
    { id: 'file.saveAs', label: 'Save As...', shortcut: 'Shift+Mod+S', enabled: (a, args) => Boolean(ed(a, args)), run: (a, args) => service.saveAs(ed(a, args)) },
    { id: 'file.saveCopy', label: 'Save a Copy...', shortcut: 'Alt+Mod+S', enabled: (a, args) => Boolean(ed(a, args)), run: (a, args) => service.saveAs(ed(a, args), { copy: true }) },
    { id: 'file.revert', label: 'Revert', shortcut: 'F12', enabled: (a, args) => service.canRevert(ed(a, args)), run: (a, args) => service.revert(ed(a, args)) },
    { id: 'file.documentSetup', label: 'Document Setup...', shortcut: 'Alt+Mod+P', enabled: (a) => Boolean(a.editor), run: async (a) => (await documentSetup()).documentSetupDialog(a) },
    { id: 'file.documentInfo', label: 'Document Info', enabled: (a) => Boolean(a.editor), run: async (a) => (await documentInfo()).documentInfoDialog(a) },
    { id: 'edit.preferences', label: 'Preferences...', shortcut: 'Mod+K', run: (a, args) => preferencesDialog(a, args?.section ? { section: args.section } : {}) },
    // One entry per section (Edit > Preferences submenu).
    ...sections(app).map((s) => ({ id: `edit.preferences.${s.id}`, label: `${s.label}...`, run: (a) => preferencesDialog(a, { section: s.id }) })),
  ]);
}

function recentMenuItems(app, files) {
  const list = files.recent.list().slice(0, 10);
  if (!list.length) return [];
  const counts = new Map();
  for (const e of list) counts.set(e.name, (counts.get(e.name) || 0) + 1);
  const label = (e) => (counts.get(e.name) > 1 && e.path ? `${e.name} (${baseName(dirName(e.path)) || '/'})` : e.name);
  return [
    ...list.map((e) => ({ type: 'cmd', label: label(e), enabled: true, checked: null, shortcut: '', run: () => files.service.openRecent(e) })),
    { type: 'sep' },
    { type: 'cmd', label: 'Clear Recent Files', enabled: true, checked: null, shortcut: '', run: () => files.clearRecent() },
  ];
}

/**
 * Dropping .ai (or .vstudio) documents opens them; other files open when no
 * document is showing. Onto the canvas of an open document, a .ai file is
 * placed as artwork instead (io/system.js handles that drop first).
 */
function installDrop(app, service) {
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const ours = (name) => {
    const ext = extensionOf(name);
    const other = ext === '.svg' || ext === '.svgz' || (app.importers?.openExtensions || []).includes(ext);
    return ext === NATIVE_EXT || ext === LEGACY_EXT || (other && (!app.editor || !app.home.hidden));
  };
  window.addEventListener('dragover', (e) => {
    if (e.defaultPrevented || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', async (e) => {
    if (e.defaultPrevented || !hasFiles(e)) return;
    // Files dropped onto an open dialog do nothing (and must not navigate away).
    if (document.querySelector('dialog[open]')) {
      e.preventDefault();
      return;
    }
    const items = [...(e.dataTransfer.items || [])].filter((it) => it.kind === 'file');
    const picked = items.map((it) => ({ it, file: it.getAsFile() })).filter((x) => x.file && ours(x.file.name));
    if (!picked.length) return;
    e.preventDefault();
    // Chromium can hand over a writable handle, so Save writes back to the dropped file.
    const handles = await Promise.all(picked.map(({ it }) => (it.getAsFileSystemHandle ? it.getAsFileSystemHandle().catch(() => null) : null)));
    for (let i = 0; i < picked.length; i++) {
      const handle = handles[i]?.kind === 'file' && [NATIVE_EXT, LEGACY_EXT].includes(extensionOf(picked[i].file.name)) ? handles[i] : null;
      await service.openFileBlob(picked[i].file, { handle });
    }
  });
}

/**
 * Puter desktop integration: files handed over by the desktop (a double-click,
 * "Open with", a drag from the desktop or a folder window), and, in a desktop
 * window, the window title and the close prompt.
 *
 * The desktop opens an app in a window of its own (app.env is 'app') or in a
 * browser tab, where the SDK reports 'web' and hands the session and the file
 * over a moment after load. Files are taken in both.
 * https://docs.puter.com/UI/onLaunchedWithItems/
 */
export function installPuterHooks(app, service) {
  const puter = app.puter;
  const ui = puter?.ui;
  if (!ui) return;
  const isDir = (it) => Boolean(it.is_dir || it.isDir || it.isDirectory || it.fsentry_is_dir);
  const openItems = async (given) => {
    const items = (Array.isArray(given) ? given : [given]).filter((it) => it && typeof it === 'object');
    const files = items.filter((it) => typeof it.path === 'string' && it.path && !isDir(it));
    if (!files.length) {
      if (items.some(isDir)) app.notify?.('Folders cannot be opened. Open the files inside instead.');
      return;
    }
    // An open dialog (and the preview it shows) is cancelled first, so the document is never left mid-change.
    await cancelOpenDialogs();
    // In a browser tab the session arrives with the file: the app follows it, so Save goes to the cloud.
    if (!app.user && puter.auth?.isSignedIn?.()) await Promise.resolve(app.onSessionChange?.()).catch(() => {});
    for (const it of files) {
      await service.openPath(it.path, { name: it.name || baseName(it.path), ...(typeof it.read === 'function' ? { item: it } : {}) });
    }
  };
  try {
    // The SDK answers at once (or as soon as the desktop has handed it over) when the app was started with a file.
    ui.onLaunchedWithItems?.(openItems);
    ui.onItemsOpened?.(openItems);
  } catch {
    // An SDK without launch items.
  }
  // Files dragged in from the Puter desktop do not arrive as a browser drop: the SDK
  // dispatches a drop of its own with the drive's entries in its detail.
  window.addEventListener('drop', (e) => {
    const items = e.detail?.items;
    if (e.dataTransfer || !Array.isArray(items)) return;
    e.preventDefault();
    openItems(items);
  });
  if (app.env !== 'app') return;

  // Mirror the page title (document name, unsaved marker) onto the Puter window.
  let last = '';
  const sync = () => {
    const t = document.title;
    if (t === last) return;
    last = t;
    try {
      ui.setWindowTitle?.(t);
    } catch {
      // Older SDKs: the window keeps its title.
    }
  };
  const titleEl = document.querySelector('title') || document.head.appendChild(document.createElement('title'));
  new MutationObserver(sync).observe(titleEl, { childList: true, characterData: true, subtree: true });
  sync();

  ui.onWindowClose?.(async () => {
    await cancelOpenDialogs();
    for (const ed of [...app.editors]) {
      if (!ed.doc.dirty) continue;
      app.activate(ed);
      if (!(await app.closeDocument(ed))) return;
    }
    puter.exit?.();
  });
}

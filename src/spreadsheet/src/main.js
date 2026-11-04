import './styles/index.css';
import { el } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { toast } from './ui/toast.js';
import { closeAllModals, openModal } from './ui/modal.js';
import { closeMenu } from './ui/menu.js';
import { session } from './lib/session.js';
import * as P from './lib/puter.js';
import { Doc } from './lib/doc.js';
import { sampleWorkbook } from './core/sample.js';
import { isSpreadsheetFile } from './core/filetypes.js';
import { templateById } from './core/templates.js';
import { rememberRecent, forgetRecent } from './lib/recent.js';
import { errorView, signInView } from './views/gate.js';
import { homeView } from './views/home.js';
import { editorView } from './views/editor.js';
import { parseAppHash, editHash } from './lib/links.js';
import { roomForFile, openRoom } from './collab/session.js';
import { appOptions, appOption, syncAppOptions } from './lib/app-options.js';
import { installAppOptions } from './lib/apply-options.js';
import { fileProblem } from './core/filetypes.js';
import { initI18n, t } from './i18n/index.js';
import { setRelauncher } from './lib/relaunch.js';

const appRoot = document.getElementById('app');
let current = null; // { kind: 'home' | 'editor' | 'gate', view }
let leaving = null; // the editor being flushed on the way to another screen, while `current` is already cleared
let launchedPath = null;

/* ---------- Routing ---------- */

/** The spreadsheet list. Opening the app lands in a new sheet instead. */
export const HOME = '#/home';

function parseHash() {
  return parseAppHash(location.hash);
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function unmount() {
  // Drop the reference first so a save finishing during flush does not rewrite the URL of the view being left.
  const prev = current;
  current = null;
  if (prev?.kind === 'editor') {
    leaving = prev.view;
    let flushed;
    try { flushed = await prev.view.flush(); } finally { leaving = null; }
    if (!flushed) {
      current = prev;
      const path = prev.view.doc.path;
      history.replaceState(null, '', path ? `#/edit/${encodeURIComponent(path)}` : '#/new');
      return false;
    }
  }
  prev?.view.destroy?.();
  closeMenu();
  closeAllModals();
  return true;
}

/**
 * Edits made without a session have nowhere to go when the editor closes:
 * 'stay', 'leave' (the local draft keeps them, unless this browser could not
 * keep one: `kept` false says so, since leaving then loses them), or 'sign-in'
 * to save them.
 */
export function leaveWithoutSessionDialog({ kept = true } = {}) {
  return new Promise((resolve) => {
    const content = el('div', {},
      el('p.modal-text', {}, kept ? t('app.leave.kept') : t('app.leave.notKept')),
      el('div.row.row-end', { style: { flexWrap: 'wrap' } },
        el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('app.leave.keepEditing')),
        el('button.btn.btn-danger', { type: 'button', onclick: () => { resolve('leave'); modal.close(); } }, t('app.leave.leaveWithoutSaving')),
        el('button.btn.btn-primary', { type: 'button', onclick: () => { resolve('sign-in'); modal.close(); } }, t('app.leave.signInAndSave'))));
    const modal = openModal({ title: t('app.leave.title'), content, onClose: () => resolve('stay') });
  });
}

/** A cloud file was asked for without a session: offer the sign-in, or a new sheet. */
function mountSignInGate(requestedHash) {
  document.title = t('common.spreadsheet');
  mount('gate', { el: signInView({
    title: t('app.signInGate.title'),
    message: t('app.signInGate.message'),
    onSignIn: async () => { if (await session.signIn() && location.hash === requestedHash) route(); },
    onSkip: () => go('#/'),
  }) });
}

/** The offline strip, when shown, stays above whichever screen is mounted. */
let offlineBanner = null;
function show(node) {
  appRoot.replaceChildren(...[offlineBanner, node].filter(Boolean));
}

function mount(kind, view) {
  current = { kind, view };
  document.body.dataset.view = kind; // styling that depends on the screen (where toasts sit)
  show(view.el);
}

function showLoading(label = t('common.opening')) {
  // The spinner says nothing and nothing takes the focus here, so the wait is carried by a live
  // region: the line goes up empty with the screen and is written a moment later, which is what a
  // screen reader reads out. Without it "Opening…" and "Importing <name>…" passed in silence.
  const message = el('p.auth-sub', { role: 'status', style: { marginTop: '14px' } });
  show(el('div.auth-view', {},
    el('div.auth-card', {},
      el('span.spin', { html: icon('spinner', 28), style: { color: 'var(--ink-3)' } }),
      message)));
  message.textContent = label;
}

const nav = {
  goHome: () => go(HOME),
  openPath: (path, { reload = false } = {}) => {
    const hash = `#/edit/${encodeURIComponent(path)}`;
    if (reload) { history.replaceState(null, '', hash); route({ reload: true }); }
    else go(hash);
  },
  // By its id, so a file moved or renamed since it was remembered opens where it is now.
  openFile: (uid) => go(`#/file/${encodeURIComponent(uid)}`),
  newDoc: () => go('#/new'),
  sampleDoc: () => go('#/sample'),
  templateDoc: (id) => go(`#/template/${encodeURIComponent(id)}`),
  importFile: (file) => route({ file }),
  recoverDraft: (draftKey) => route({ draftKey }),
  // A shared workbook (editing together): its room, and the owner's file when known.
  openLive: ({ server, room, path = null, uid = null }) => {
    liveFile = path ? { path, uid } : null;
    const hash = `#/live/${encodeURIComponent(room)}?${new URLSearchParams({ server })}`;
    history.replaceState(null, '', hash);
    route({ reload: true });
  },
};
/** The owner's file a shared workbook was opened from, while its room is being opened. */
let liveFile = null;

function openEditor(doc, initialRange = null) {
  const view = editorView({ doc, ...nav, initialRange, leaveDialog: () => leaveWithoutSessionDialog({ kept: doc.draftKept !== false }) });
  mount('editor', view);
  // The record keeps the file's own name; the list strips the extension itself, so "Q3.5" keeps its ".5".
  if (doc.path) rememberRecent(doc.file);
  // Once an unsaved document gets a file, the URL follows so a reload reopens it.
  doc.addEventListener('path', (e) => {
    if (e.detail?.oldPath) forgetRecent(e.detail.oldPath); // the old address no longer opens anything
    if (doc.path && current?.view === view) {
      history.replaceState(null, '', `#/edit/${encodeURIComponent(doc.path)}`);
      rememberRecent(doc.file);
    }
  });
  if (doc.path) history.replaceState(null, '', `#/edit/${encodeURIComponent(doc.path)}`);
}

let routing = false;
let pendingRoute = null;
async function route({ reload = false, file = null, draftKey = null } = {}) {
  if (routing) { pendingRoute = { hash: location.hash, reload, file, draftKey }; return; }
  routing = true;
  try {
    const { route: r, path, id, range } = parseHash();
    if (!file && !draftKey && !reload && current?.kind === 'editor' && r === 'edit' && P.samePath(current.view.doc.path, path)) {
      // The same document with a range in the address: jump there.
      if (range) { current.view.goTo(range); history.replaceState(null, '', `#/edit/${encodeURIComponent(path)}`); }
      return;
    }
    if (!await unmount()) {
      // The user chose to stay: a navigation that arrived while the question was open (Back pressed
      // again, say) was asked for before the answer, and must not put the question a second time. A
      // file dropped or a reload asked for meanwhile is a deliberate move on the app itself, and stands.
      if (pendingRoute && !pendingRoute.file && !pendingRoute.draftKey && !pendingRoute.reload) pendingRoute = null;
      return;
    }
    if (draftKey) {
      // A recovered draft has no file yet: the address must not keep naming the document that was open before.
      history.replaceState(null, '', '#/new');
      try { openEditor(Doc.fromDraft(draftKey)); }
      catch (e) { toast(e?.message || t('app.couldNotRecover'), { icon: 'alert', duration: 5000 }); go(HOME); }
      return;
    }
    // Device imports share the route queue: a navigation during a slow read
    // must still flush and destroy the imported editor before replacing it.
    if (file) {
      showLoading(t('app.importing', { name: file.name }));
      try {
        const imported = await Doc.fromBrowserFile(file);
        history.replaceState(null, '', '#/new'); // the imported document has no file yet
        openEditor(imported);
      } catch (e) {
        console.error(e);
        toast(fileProblem(e) || t('app.couldNotRead', { name: file.name }), { icon: 'alert', duration: 6000 });
        go(HOME);
      }
      return;
    }
    if (r === 'home') {
      mount('home', homeView(nav));
      document.title = t('common.spreadsheet');
      P.setWindowTitle(t('common.spreadsheet'));
      return;
    }
    // A new workbook starts as the options say: its font, how many sheets, its view and calculation.
    if (r === 'new') { openEditor(Doc.blank({ excel: true, start: appOptions() })); return; }
    if (r === 'template') {
      const template = templateById(id);
      if (!template) { go(HOME); return; }
      if (template.id === 'blank') { openEditor(Doc.blank({ excel: true, start: appOptions() })); return; }
      const wb = template.build();
      const doc = new Doc({ wb, name: template.name });
      wb.dirty = true;
      doc._changed('cells');
      openEditor(doc);
      return;
    }
    if (r === 'sample') {
      const wb = sampleWorkbook();
      const doc = new Doc({ wb, name: t('app.sampleName') });
      wb.dirty = true;
      doc._changed('cells');
      openEditor(doc);
      return;
    }
    // Reading a file without a session would pop the SDK's dialog by itself; ask first, in place.
    if (session.signedOut) { mountSignInGate(location.hash); return; }
    if (r === 'live') {
      showLoading(t('app.joiningShared'));
      const { room, server, token, range } = parseHash();
      try {
        const doc = await openRoom({ server, room, token, ...(liveFile || {}) });
        liveFile = null;
        // The invitation was used: the address left behind opens the workbook for members, without it.
        if (token) history.replaceState(null, '', `#/live/${encodeURIComponent(room)}?${new URLSearchParams({ server })}`);
        openEditor(doc, range);
        if (token) toast(t('app.joinedShared', { name: doc.name }), { icon: 'people', duration: 4000 });
      } catch (e) {
        console.error(e);
        liveFile = null;
        toast(e?.message || t('app.couldNotOpenShared'), { icon: 'alert', duration: 6000 });
        go(HOME);
      }
      return;
    }
    if (r === 'file') {
      // A shared spreadsheet's link names the file by its id: whoever follows it finds it at the
      // address their own drive shows for it (a shared one's masked path), and opens it there.
      showLoading();
      let found;
      try { found = await P.statByUid(id); }
      catch (e) {
        // A refusal says the file is not this user's to open; anything else (offline, say) is no answer
        // about the file, and must not be told as one.
        const code = e?.code || e?.error?.code;
        if (code === 'access_denied' || code === 'forbidden') found = null;
        else {
          console.error(e);
          toast(t('app.couldNotOpenFile'), { icon: 'alert', duration: 5000 });
          go(HOME);
          return;
        }
      }
      if (!found?.path || found.is_dir || P.inTrash(found.path)) {
        toast(t('app.fileNotShared'), { icon: 'alert', duration: 5000 });
        go(HOME);
        return;
      }
      // Through the route queue, so that a navigation made while the id was looked up wins.
      pendingRoute ??= { hash: editHash(found.path, range) };
      return;
    }
    showLoading();
    try {
      const doc = await Doc.fromPath(path);
      if (!doc.path) {
        // The file is gone, but edits made to it here never reached Puter: they open as a new spreadsheet.
        forgetRecent(path);
        history.replaceState(null, '', '#/new');
        toast(t('app.fileGoneDraftOpened'), { icon: 'info', duration: 6000 });
      } else if (!P.samePath(doc.path, path)) forgetRecent(path); // the file was found where the drive keeps it now
      // A file its owner shares for editing together opens as the shared workbook, which may be ahead of the file.
      const shared = doc.path ? await roomForFile(doc.file) : null;
      if (shared) {
        try {
          const live = await openRoom({ ...shared, path: doc.path, uid: doc.uid });
          doc.destroy();
          openEditor(live, range);
          return;
        } catch (e) {
          console.warn('The shared workbook could not be opened; opening the file instead', e);
          // Closed or deleted (from another device, say), the room writes the file no more: it opens as any file does.
          if ([404, 410].includes(e?.status)) toast(t('app.noLongerShared'), { icon: 'info', duration: 5000 });
          else {
            // Otherwise the room still writes the file, over whatever would be saved into it here (see Doc.holdForRoom).
            doc.holdForRoom();
            toast(t('app.sharedUnreachable'), { icon: 'info', duration: 8000 });
          }
        }
      }
      openEditor(doc, range);
    } catch (e) {
      console.error(e);
      toast(P.isNotFound(e) ? t('app.fileGone') : fileProblem(e) || t('app.couldNotOpenFile'), { icon: 'alert', duration: fileProblem(e) ? 6000 : 5000 });
      if (P.isNotFound(e)) forgetRecent(path);
      go(HOME);
    }
  } finally {
    routing = false;
    if (pendingRoute) {
      const next = pendingRoute;
      pendingRoute = null;
      // Opening a document can rewrite the hash. Restore the latest requested
      // address before processing the navigation that arrived during the read.
      history.replaceState(null, '', next.hash || '#/new');
      await route({ reload: next.reload, file: next.file, draftKey: next.draftKey });
    }
  }
}

/* ---------- Boot ---------- */

/**
 * Nobody has to sign in to work: the app opens straight into the editor.
 * Puter is asked for a sign-in at the first action that needs the cloud.
 */
async function start() {
  // The interface language comes first: every screen after this one is drawn in it.
  await initI18n();
  document.title = t('common.spreadsheet');
  setRelauncher(relaunch);
  if (!P.hasSDK()) {
    show(errorView(t('app.noPuter.title'), t('app.noPuter.message'), () => location.reload()));
    return;
  }
  setupFileDrop();
  // Double-click or "Open with" on the Puter desktop: the SDK answers from the launch address as soon as this is registered.
  P.onLaunchedWithItems(openDriveItems);
  P.onWindowClose(closeWindow);
  await boot();
}

/**
 * The Puter desktop window's close button, which waits for this: the sheet
 * saves what the autosave has not sent yet (a cell still being typed in
 * included), and asks, as leaving it for another screen would, when that save
 * cannot go through. Without this the window went at once, taking those edits.
 */
let closing = null;
function closeWindow() {
  const view = current?.kind === 'editor' ? current.view : leaving;
  if (closing) {
    // Pressed again while the save is still under way, with no question up: the flush wrote the edits to this
    // device before saving, to be recovered from the home screen, so a write that will not finish cannot keep
    // the window open. Where this browser could not keep them, it waits.
    if (!document.body.classList.contains('modal-open') && view?.doc?.draftKept !== false) P.exitApp();
    return;
  }
  closing = (async () => {
    try {
      if (view && !await view.flush()) return; // kept editing, or the save failed and the user stays
    } catch (e) {
      console.error(e);
      return;
    }
    P.exitApp();
  })().finally(() => { closing = null; });
}

/**
 * Files on the drive handed to the app by the Puter desktop: the one it was
 * launched with (double-click, "Open with"), or those dragged onto the window.
 * A spreadsheet opens where it lives, so that its edits go back to it; an
 * image goes on the open sheet, as one dropped from the device does.
 */
function openDriveItems(items) {
  const item = items.find((it) => it?.path && !P.isDirItem(it));
  if (!item) {
    if (items.some((it) => P.isDirItem(it))) toast(t('app.cannotOpenFolder'), { icon: 'info', duration: 3200 });
    return;
  }
  const name = item.name || P.displayName(item.path);
  const spreadsheet = isSpreadsheetFile(name);
  if (!booted) {
    // Before the app is up only a spreadsheet can wait: it becomes the first screen.
    if (spreadsheet) launchedPath = item.path;
    else toast(t('app.cannotOpenLaunched', { name }), { icon: 'info', duration: 4000 });
    return;
  }
  // The drop is a deliberate move on the app itself and outranks whatever is over it.
  closeMenu();
  closeAllModals();
  if (spreadsheet) { nav.openPath(item.path); return; }
  const type = imageType(name);
  const view = current?.view;
  if (!type || !view?.acceptDrop) {
    toast(view?.acceptDrop ? t('app.cannotOpenDroppedOrImage', { name }) : t('app.cannotOpenDropped', { name }), { icon: 'info', duration: 3200 });
    return;
  }
  P.readFile(item.path).then((bytes) => {
    // The sheet it was dropped on may have been left while the picture was read.
    if (current?.view === view) view.acceptDrop(new File([bytes], name, { type }));
  }, (e) => {
    console.error(e);
    if (current?.view === view) toast(t('app.couldNotRead', { name }), { icon: 'alert' });
  });
}

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
/** The image type a drive file's name says it is (the drive hands over no type of its own), or null. */
function imageType(name) {
  return IMAGE_TYPES[/\.([^.]+)$/.exec(String(name).toLowerCase())?.[1]] || null;
}

/**
 * The display language changed (File ▸ Options): the app reloads in it. The open spreadsheet is saved
 * or kept first, exactly as leaving it for another screen would; one that has no file yet comes back
 * from the draft this browser keeps of it.
 */
const RESUME_DRAFT = 'spreadsheet:resume-draft';
async function relaunch() {
  const view = current?.kind === 'editor' ? current.view : null;
  if (view && !await view.flush()) return false;
  const doc = view?.doc;
  try {
    if (doc && !doc.path && doc.wb?.dirty && doc.draftKept !== false) sessionStorage.setItem(RESUME_DRAFT, doc.draftKey);
  } catch { /* storage unavailable: it is still on the home screen's list */ }
  showLoading(t('i18n.relaunching'));
  // A language in the address (?lang=) outranks the one just chosen: it goes, so the choice shows.
  const url = new URL(location.href);
  if (url.searchParams.has('lang')) { url.searchParams.delete('lang'); history.replaceState(history.state, '', url); }
  location.reload();
  return true;
}

/** The draft relaunch left to reopen, once. */
function takeResumeDraft() {
  try {
    const key = sessionStorage.getItem(RESUME_DRAFT);
    sessionStorage.removeItem(RESUME_DRAFT);
    return key;
  } catch { return null; }
}

let booted = false;
async function boot() {
  showLoading(t('common.loading'));
  await session.init();
  // The SDK signs the user in on its own before an AI request; the views follow.
  P.onAuth((user) => session.signedInAs(user));
  // The person's options (File ▸ Options), with the account's copy when it arrives quickly enough to matter.
  installAppOptions();
  if (session.signedIn) await Promise.race([syncAppOptions().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 800))]);
  // Opened with no address, the app lands on a new workbook, or on the start screen when the options ask for it.
  if (!launchedPath && appOption('startScreen') && /^#?\/?$/.test(location.hash)) history.replaceState(null, '', HOME);
  booted = true;
  window.addEventListener('hashchange', route);
  if (launchedPath) {
    const p = launchedPath;
    launchedPath = null;
    location.hash = `#/edit/${encodeURIComponent(p)}`;
  }
  // A file dropped on the loading screen opens now that there is somewhere to open it.
  const dropped = droppedFile;
  droppedFile = null;
  const resumed = dropped ? null : takeResumeDraft();
  await route(dropped ? { file: dropped } : resumed ? { draftKey: resumed } : undefined);
  setupOfflineBanner();
}

/** A file dropped before the app was up, held until there is somewhere to open it. */
let droppedFile = null;

/**
 * A file dropped anywhere on the window opens: over a dialog, over the
 * sign-in screen, or over the sheet, not only over the part of the page the
 * current screen happens to cover. Left to itself the browser would leave the
 * app to show the dropped file, taking unsaved work with it, so a drag
 * carrying files is always taken over here.
 */
function setupFileDrop() {
  const carriesFile = (e) => !!e.dataTransfer?.types?.includes('Files');
  const unhighlight = () => {
    document.body.classList.remove('dropping', 'dropping-local');
    current?.view.dragOver?.(null);
  };
  window.addEventListener('dragover', (e) => {
    if (!carriesFile(e)) return; // text dragged into a field stays the browser's to handle
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    document.body.classList.add('dropping');
    // A part of the screen that takes the file for itself (the AI assistant) marks itself, in place of the window.
    document.body.classList.toggle('dropping-local', !!(booted && current?.view.dragOver?.(e.clientX, e.clientY)));
  });
  // While the file is over the app every element is a drop target, so only
  // leaving the window (no element entered) ends the drag.
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) unhighlight(); });
  window.addEventListener('dragend', unhighlight);
  window.addEventListener('drop', (e) => {
    // Files dragged in from the Puter desktop or one of its folder windows do not come the browser's way:
    // the SDK dispatches a drop of its own, with the drive's entries in its detail and no dataTransfer.
    if (!e.dataTransfer && Array.isArray(e.detail?.items)) {
      e.preventDefault();
      openDriveItems(e.detail.items);
      return;
    }
    if (!carriesFile(e)) return;
    e.preventDefault();
    unhighlight();
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) openDroppedFile(files[0], { files, x: e.clientX, y: e.clientY });
  });
}

/** The open spreadsheet takes a dropped file first: an image belongs on the sheet. */
function openDroppedFile(file, where = {}) {
  if (!booted) { droppedFile = file; return; }
  // The drop is a deliberate move on the app itself and outranks whatever is over it.
  closeMenu();
  closeAllModals();
  if (current?.view.acceptDrop) { current.view.acceptDrop(file, where); return; }
  if (isSpreadsheetFile(file.name)) route({ file });
  else toast(t('app.cannotOpenDropped', { name: file.name }), { icon: 'info', duration: 3200 });
}

function setupOfflineBanner() {
  const update = () => {
    if (!navigator.onLine && !offlineBanner) {
      offlineBanner = el('div.offline-banner', { role: 'status', html: icon('wifiOff', 15, 2) }, ' ', t('app.offline'));
      appRoot.prepend(offlineBanner);
    } else if (navigator.onLine && offlineBanner) {
      offlineBanner.remove();
      offlineBanner = null;
      current?.view?.doc?.reconnected?.().catch(() => {});
    }
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

if (import.meta.env?.DEV) window.__ss = { session, get current() { return current; } };

start();

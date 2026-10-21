import './styles/index.css';
import { el } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { announce, toast } from './ui/toast.js';
import { closeAllModals, confirmDialog, openModal } from './ui/modal.js';
import { closeMenu } from './ui/menu.js';
import { session } from './lib/session.js';
import * as P from './lib/puter.js';
import { Doc, needsUnloadWarning } from './lib/doc.js';
import { errorView, signInView } from './views/gate.js';
import { homeView } from './views/home.js';
import { editorView } from './views/editor.js';
import { loadEngine } from './lib/engine.js';
import { templateById } from './lib/templates.js';
import { importFiles, nothingImportable } from './lib/importfiles.js';
import { imageFilesFrom } from './lib/images.js';
import { customTemplatePath } from './lib/customtemplates.js';
import { parseLink } from './collab/protocol.js';

const appRoot = document.getElementById('app');
let current = null; // { kind: 'home' | 'editor' | 'gate', view }
let launchedPath = null;
let droppedFiles = null;
let importRequest = 0;

/* ---------- Routing ---------- */

/** The document list. Opening the app lands in a new document instead. */
export const HOME = '#/home';

export function parseHash(hash = location.hash) {
  const h = hash.replace(/^#\/?/, '');
  try {
    if (h === '' || h === 'new') return { route: 'new', template: null };
    if (h.startsWith('edit/')) return { route: 'edit', path: decodeURIComponent(h.slice(5)) };
    if (h.startsWith('new/')) return { route: 'new', template: decodeURIComponent(h.slice(4)) || null };
  } catch { /* A malformed percent escape should fall back to the home screen. */ }
  return { route: 'home' };
}

/**
 * A New action that has to change the URL is answered by the hash listener,
 * which knows nothing of the press behind it. The intent waits here so the
 * document it lands on is created rather than the open one reused: a template
 * document stops naming its template once it has been laid out, so "New
 * document" from one would otherwise look like the document already open.
 */
let requestedNewDocument = false;

function go(hash, { newDocument = false } = {}) {
  if (location.hash === hash) route({ newDocument });
  else {
    requestedNewDocument ||= newDocument;
    location.hash = hash;
  }
}

/** Why a document could not be opened, in the user's terms. */
const openFailureMessage = (e) => (P.isNotFound(e) ? 'That file no longer exists' : e?.name === 'HwpError' ? e.message : 'Could not open the file');

/** The URL that shows a document: its file, or the template it is being written from. */
const docHash = (doc) => (doc.path ? `#/edit/${encodeURIComponent(doc.path)}` : doc.template ? `#/new/${encodeURIComponent(doc.template)}` : '#/new');

async function unmount(stillWanted = () => true) {
  const leaving = current;
  const destination = location.hash;
  if (leaving?.kind === 'editor') {
    const doc = leaving.view.doc;
    const ownHash = () => docHash(doc);
    for (;;) {
      const saved = await leaving.view.flush();
      if (!stillWanted() || current !== leaving) return false;
      if (saved) break;
      // The URL shows the document while the user decides.
      history.replaceState(null, '', ownHash());
      const choice = await leaveDialog(doc, { unsaveable: !!leaving.view.unsaveable });
      if (!stillWanted() || current !== leaving) return false;
      // A place chosen while the dialog was open (a link, the back button) is where to go; staying shows the document again.
      const moved = location.hash !== ownHash();
      if (choice === 'stay') { if (moved) history.replaceState(null, '', ownHash()); return false; }
      if (!moved) history.replaceState(null, '', destination);
      if (choice === 'leave') break;
      // 'sign-in': with a session the save can go through; then try again.
      const signedIn = await session.signIn();
      if (!stillWanted() || current !== leaving) return false;
      if (!signedIn) { history.replaceState(null, '', ownHash()); return false; }
    }
  }
  closeMenu();
  closeAllModals();
  current?.view.destroy?.();
  current = null;
  return true;
}

const LEAVE_TITLES = ['Leave without saving?', 'Save before leaving?'];
/** Whether the question about leaving an unsaved document is on screen, whichever navigation or import asked it. */
const leaveQuestionOpen = () => [...document.querySelectorAll('.modal-root:not(.closing) [role="dialog"]')].some((dialog) => LEAVE_TITLES.includes(dialog.getAttribute('aria-label')));

/**
 * What to do with edits that could not be written: 'stay', 'leave' (and lose
 * them), or, without a session, 'sign-in' so they can be saved after all.
 */
function leaveDialog(doc, { unsaveable = false } = {}) {
  // A preview, or a file that could not be opened, has no save to try again: say what staying is for.
  if (unsaveable) {
    return confirmDialog({
      title: LEAVE_TITLES[0],
      message: `This document could not be opened for editing, so it has not been saved to Puter. ${doc.blob ? 'Stay to download a copy, or leave without it.' : 'Leave without it?'}`,
      confirmLabel: 'Leave without saving', cancelLabel: 'Stay',
    }).then((leave) => (leave ? 'leave' : 'stay'));
  }
  // Signing in helps only a document that can be saved at all; one that never opened cannot be.
  if (!session.signedOut || !doc.dirty || !doc.exporter) {
    return confirmDialog({
      title: LEAVE_TITLES[0],
      // A document that never reached a file has no "latest changes" to speak of; the whole of it is at stake.
      message: doc.path || doc.lastSaved
        ? 'Your latest changes could not be saved. Keep editing to try again, or leave and discard those changes.'
        : 'This document has not been saved yet. Keep editing to try again, or leave and discard it.',
      confirmLabel: 'Leave without saving', cancelLabel: 'Keep editing',
    }).then((leave) => (leave ? 'leave' : 'stay'));
  }
  return new Promise((resolve) => {
    const content = el('div', {},
      el('p.modal-text', {}, 'This document is not saved anywhere yet. Sign in to Puter to save it to your own cloud, or leave and discard it.'),
      el('div.row.row-end', { style: { flexWrap: 'wrap' } },
        el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Keep editing'),
        el('button.btn.btn-danger', { type: 'button', onclick: () => { resolve('leave'); modal.close(); } }, 'Leave without saving'),
        el('button.btn.btn-primary', { type: 'button', onclick: () => { resolve('sign-in'); modal.close(); } }, 'Sign in and save')));
    const modal = openModal({ title: LEAVE_TITLES[1], content, onClose: () => resolve('stay') });
  });
}

function mount(kind, view) {
  current = { kind, view };
  appRoot.replaceChildren(view.el);
  // A change of screen would otherwise leave the keyboard on the page body, wherever the last screen had it. The
  // editor places it itself once the engine is up; the list and the gate start at their heading.
  if (kind !== 'editor') {
    const heading = view.el.querySelector('h1');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }
}

/** A cloud document was asked for without a session: offer the sign-in, or a new document. */
function mountSignInGate(requestedHash, what) {
  document.title = 'Documents';
  mount('gate', { el: signInView({
    title: `Sign in to open this ${what}`,
    message: `Documents live in your own Puter cloud. Sign in to open this ${what}, or start a new document without an account.`,
    onSignIn: async () => { if (await session.signIn() && location.hash === requestedHash) route(); },
    onSkip: () => go('#/'),
  }) });
}

function showLoading(label = 'Opening') {
  appRoot.replaceChildren(el('div.auth-view', {},
    el('div.auth-card', {},
      el('span.spin', { html: icon('spinner', 28), style: { color: 'var(--ink-3)' } }),
      el('p.auth-sub', { style: { marginTop: '14px' } }, label))));
}

const nav = {
  goHome: () => go(HOME),
  openPath: (path) => go(`#/edit/${encodeURIComponent(path)}`),
  newDoc: () => go('#/new', { newDocument: true }),
  newFromTemplate: (id) => go(`#/new/${encodeURIComponent(id)}`, { newDocument: true }),
  /** Load a document from disk again (after its file was replaced), without a save on the way out. */
  reopen: async (path) => {
    const request = ++importRequest, requestedHash = location.hash;
    const stillWanted = () => request === importRequest && location.hash === requestedHash;
    current?.view?.doc?.destroy?.();
    current?.view?.doc?.discardEdits?.();
    if (!await unmount(stillWanted)) return;
    showLoading();
    try {
      const doc = await Doc.fromPath(path);
      if (!stillWanted()) return;
      openEditor(doc);
    } catch (e) {
      if (!stillWanted()) return;
      console.error(e);
      toast(openFailureMessage(e), { icon: 'alert', duration: 5000 });
      go(HOME);
    }
  },
  /**
   * Files dropped on the app, or picked from the device: one opens here, and
   * a batch is written into the documents folder behind it.
   */
  importFiles: (files, { picked = false } = {}) => {
    const source = current;
    const stillHere = () => current === source;
    return importFiles(files, {
      openFile: nav.importFile,
      stillHere,
      onImported: () => { if (stillHere() && current?.kind === 'home') current.view.reload(); },
      // In the editor a picture is a likelier drop than a document, and it has a place to go.
      nothingMessage: !picked && current?.kind === 'editor' && imageFilesFrom({ files }).length
        ? 'Drop pictures on the page to insert them'
        : nothingImportable(files, { picked }),
    });
  },
  importFile: async (file) => {
    const request = ++importRequest, source = current;
    const stillWanted = () => request === importRequest && current === source;
    let doc;
    try { doc = await Doc.fromImportFile(file); }
    catch (e) { if (stillWanted()) { console.error(e); toast(e?.message || 'Could not import that file', { icon: 'alert', duration: 8000 }); } return; }
    // File reads and converter loading can finish after another navigation.
    // Only the newest request may close the current editor and install its copy.
    if (!stillWanted()) return;
    // The question about leaving the open document unsaved is already up: a second file must not ask it again on top.
    if (leaveQuestionOpen()) { toast('Answer the question about the open document first', { icon: 'info' }); return; }
    // Closing the editor can ask about unsaved edits. A hash change meanwhile
    // (a link, the back button) waits for the answer instead of asking again on top.
    importing++;
    const requestedHash = location.hash, leaving = source?.kind === 'editor' ? source.view.doc : null;
    // The URL follows the leaving document while it saves, or stays where it was (a new document
    // reached without a hash never wrote one); anywhere else is a place the user chose.
    const moved = () => location.hash !== requestedHash && location.hash !== (leaving ? docHash(leaving) : requestedHash);
    let opened = false;
    try {
      if (!await unmount(stillWanted)) return;
      // A place chosen while the question was up is where to go, not the import.
      if (moved()) return;
      history.replaceState(null, '', '#/new');
      openEditor(doc);
      opened = true;
    } finally {
      importing--;
      if (!opened && !importing && !routing && moved()) route();
    }
  },

};

function openEditor(doc) {
  const view = editorView({ doc, ...nav });
  mount('editor', view);
  // Once an unsaved document gets a file, the URL follows so a reload reopens it.
  doc.addEventListener('path', () => {
    if (doc.path && current?.view === view && !routing) {
      history.replaceState(null, '', `#/edit/${encodeURIComponent(doc.path)}`);
    }
  });
  if (doc.path) history.replaceState(null, '', `#/edit/${encodeURIComponent(doc.path)}`);
  else if (doc.importInfo) history.replaceState(null, '', '#/new');
}

let routing = false;
// Imports closing the editor. Their leave question decides; the hash is followed after it.
let importing = 0;
async function route({ newDocument = false } = {}) {
  if (importing) return;
  importRequest++;
  if (routing) return;
  routing = true;
  const explicitNew = newDocument || requestedNewDocument;
  requestedNewDocument = false;
  const requestedHash = location.hash;
  try {
    // An invitation to a shared document (#collab-…): join its room, then open what it holds.
    let invitation = null;
    try { invitation = parseLink(location.href); } catch (e) { toast(e.message, { icon: 'alert' }); }
    if (invitation) {
      if (current?.kind === 'editor' && current.view.doc.collab?.link?.room === invitation.room) return;
      if (!await unmount()) return;
      if (location.hash !== requestedHash) return;
      await openInvitation(invitation, requestedHash);
      return;
    }
    const { route: r, path, template } = parseHash(requestedHash);
    if (current?.kind === 'editor' && r === 'edit' && current.view.doc.path === path) return;
    // Going home from a failed open changes the hash and re-routes when it settles: the list is mounted once.
    if (r === 'home' && current?.kind === 'home') return;
    // An explicit New action must save and leave an unsaved document even
    // when both documents use the same URL. Ordinary route events can reuse it.
    if (!explicitNew && current?.kind === 'editor' && r === 'new' && !current.view.doc.path && (current.view.doc.template || null) === template) return;
    if (!await unmount()) return;
    if (location.hash !== requestedHash) return;
    if (r === 'home') {
      mount('home', homeView(nav));
      document.title = 'Documents';
      P.setWindowTitle('Documents');
      return;
    }
    if (r === 'new') {
      const customPath = customTemplatePath(template);
      if (customPath) {
        if (session.signedOut) { mountSignInGate(requestedHash, 'template'); return; }
        showLoading();
        try {
          const doc = await Doc.fromTemplateFile(customPath);
          if (location.hash !== requestedHash) return;
          openEditor(doc);
        } catch (e) {
          if (location.hash !== requestedHash) return;
          console.error(e);
          toast(P.isNotFound(e) ? 'That template no longer exists' : 'Could not open the template', { icon: 'alert', duration: 5000 });
          go(HOME);
        }
        return;
      }
      const t = template ? templateById(template) : null;
      if (template && !t) toast('That template does not exist', { icon: 'alert' });
      openEditor(Doc.blank(t ? { template: t.id, name: t.name } : {}));
      return;
    }
    if (session.signedOut) { mountSignInGate(requestedHash, 'document'); return; }
    showLoading();
    try {
      const doc = await Doc.fromPath(path);
      if (location.hash !== requestedHash) return;
      openEditor(doc);
    } catch (e) {
      if (location.hash !== requestedHash) return;
      console.error(e);
      toast(openFailureMessage(e), { icon: 'alert', duration: 8000 });
      go(HOME);
    }
  } finally {
    routing = false;
    // Hash changes during an awaited save/read must be processed after it settles.
    if (location.hash !== requestedHash) route();
  }
}

/** Join a shared document from its link and open the editor on the room's state. */
async function openInvitation(link, requestedHash) {
  if (!link.local && session.signedOut) { mountSignInGate(requestedHash, 'shared document'); return; }
  showLoading('Joining the shared document');
  try {
    const { joinRoom } = await import('./collab/live.js');
    const user = { id: session.user?.uuid || session.username, name: session.username };
    const joined = await joinRoom(link, user);
    if (location.hash !== requestedHash) { joined.client.close().catch(() => {}); return; }
    // The room holds the document; this tab never writes a file of its own unless sharing ends.
    const doc = new Doc({ name: joined.name, blob: new Blob([joined.base], { type: P.DOCX_MIME }) });
    doc.setSaving(false);
    doc.collab = { client: joined.client, link };
    openEditor(doc);
    document.title = `${doc.name} — Documents`;
  } catch (e) {
    if (location.hash !== requestedHash) return;
    console.error(e);
    toast(e?.status === 403 ? e.message : `Could not open the shared document: ${e?.message || e}`, { icon: 'alert', duration: 8000 });
    go(HOME);
  }
}

/* ---------- Boot ---------- */

/**
 * Nobody has to sign in to write: the app opens straight into the editor.
 * Puter is asked for a sign-in at the first action that needs the cloud.
 */
async function start() {
  if (!P.hasSDK()) {
    appRoot.replaceChildren(errorView('Could not reach Puter', 'The Puter SDK failed to load. Check your connection and try again.', () => location.reload()));
    return;
  }
  P.onLaunchedWithItems((items) => {
    const first = items.find((it) => it?.path);
    if (!first) return;
    if (booted) nav.openPath(first.path);
    else launchedPath = first.path;
  });
  await boot();
}

let booted = false;
async function boot() {
  showLoading('Loading');
  // Before anything else: a file dropped on the loading screen is meant for
  // the app, and the browser would otherwise leave the app to open it.
  setupFileDrop();
  // Start loading the canvas editor alongside session initialization.
  if (parseHash().route !== 'home') loadEngine().catch(() => {});
  await session.init();
  // The SDK signs the user in on its own before an AI request; the views follow.
  P.onAuth((user) => session.signedInAs(user));
  booted = true;
  window.addEventListener('hashchange', route);
  if (launchedPath) {
    const p = launchedPath;
    launchedPath = null;
    location.hash = `#/edit/${encodeURIComponent(p)}`;
  }
  await route();
  setupOfflineBanner();
  setupUnloadGuard();
  if (droppedFiles) {
    const files = droppedFiles;
    droppedFiles = null;
    nav.importFiles(files);
  }
  window.addEventListener('app:before-signout', (event) => event.detail.waitUntil(current?.view?.flush?.()));
}

/**
 * A file dropped anywhere on the app opens, wherever the drop lands: the
 * screens that make something of their own out of a drop (the document list
 * imports a batch, the page takes pictures) handle it first and this is what
 * catches the rest. Without it the browser would leave the app for the file.
 */
function setupFileDrop() {
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let hint = null;
  let hideTimer = 0;
  const hide = () => { clearTimeout(hideTimer); hideTimer = 0; hint?.remove(); hint = null; };
  const show = () => {
    if (!hint) {
      hint = el('div.drop-hint.dragging-over', { 'aria-hidden': 'true' },
        el('div.drop-hint-card', {}, el('span', { html: icon('upload', 26) }), el('span', {}, 'Drop to open')));
      document.body.append(hint);
    }
    // Nothing reports a file leaving the window for good, and dragleave fires
    // between elements on the way across. The drag repeats dragover while it
    // is over the app, so the hint goes when the repeats do.
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 500);
  };
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e) || e.defaultPrevented) return;
    // Accepting the drag is what allows the drop that follows.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    show();
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    hide();
    if (e.defaultPrevented) return;
    e.preventDefault();
    // A drop during the boot waits for it: the sign-in state a batch import
    // asks about, and the view it opens in front of, are not settled yet.
    if (!booted) { droppedFiles = e.dataTransfer.files; return; }
    nav.importFiles(e.dataTransfer.files);
  });
  window.addEventListener('dragend', hide);
}

/**
 * Closing the tab with edits pending: ask first, and use the moment the page
 * goes to the background to push a save so a quick close loses nothing.
 */
function setupUnloadGuard() {
  const doc = () => (current?.kind === 'editor' ? current.view.doc : null);
  window.addEventListener('beforeunload', (e) => {
    if (!needsUnloadWarning(doc())) return;
    e.preventDefault();
    e.returnValue = '';
  });
  const saveInBackground = () => { const d = doc(); if (d?.dirty) d.save({ auto: true, now: true }).catch(() => {}); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveInBackground(); });
  window.addEventListener('pagehide', saveInBackground);
}

function setupOfflineBanner() {
  let banner = null;
  const update = () => {
    if (!navigator.onLine && !banner) {
      banner = el('div.offline-banner', { html: icon('wifiOff', 15, 2) }, ' Offline. Changes will save when you reconnect');
      document.body.append(banner);
      announce('Offline. Changes will save when you reconnect');
    } else if (navigator.onLine && banner) {
      banner.remove();
      banner = null;
      announce('Back online');
      // Only pending edits go out; an untouched new document has no file to write yet.
      const doc = current?.view?.doc;
      if (doc?.dirty) doc.save({ auto: true }).catch(() => {});
    }
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

if (import.meta.env?.DEV) window.__docs = { session, get current() { return current; } };

start();

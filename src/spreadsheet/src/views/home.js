/**
 * Home: the list of spreadsheets in the app folder, with new / import / open
 * actions. Rows open the editor; a per-row menu renames, shares, duplicates,
 * downloads, or deletes. Spreadsheets other people shared with the user are
 * listed on their own. The list lives in the Puter cloud, so without a
 * session the screen offers the sign-in instead of the list.
 */

import { el, clear, formatBytes, relativeTime } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openMenu } from '../ui/menu.js';
import { confirmDialog, promptDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { openAppMenu, renderAccountButton } from '../ui/appmenu.js';
import { openTemplatePicker } from '../ui/templates.js';
import { templateThumbnail } from '../ui/template-thumbnail.js';
import { openShareDialog } from '../ui/share.js';
import { TEMPLATES } from '../core/templates.js';
import { session } from '../lib/session.js';
import * as P from '../lib/puter.js';
import { stripExtension } from '../core/io.js';
import { IMPORT_EXTENSIONS } from '../core/filetypes.js';
import { recentFiles, forgetRecent, refreshRecent } from '../lib/recent.js';
import { listDrafts, clearDraft, draftKey, liveDraftKey, moveDraft, parkDraft } from '../lib/drafts.js';
import { removeVersions, moveVersions, parkVersions } from '../lib/versions.js';
import { moveExternalDecision, copyExternalDecision, forgetExternalDecision } from '../lib/doc.js';

let views = 0; // headings name their sections by id, and each home screen has ids of its own

export function homeView({ openPath, openFile, newDoc, sampleDoc, templateDoc, importFile, recoverDraft }) {
  const n = ++views;
  const ids = { start: `home-start-${n}`, files: `home-files-${n}` };
  const fromTemplate = () => openTemplatePicker({ onPick: templateDoc });
  let files = [];
  let shared = []; // spreadsheets other people shared with this user
  let query = '';
  let loading = true;
  let error = null;
  let destroyed = false;
  let loadId = 0;
  let sortBy = 'modified'; // 'modified' | 'name' | 'size'
  try { sortBy = ['modified', 'name', 'size'].includes(localStorage.getItem('spreadsheet:homeSort')) ? localStorage.getItem('spreadsheet:homeSort') : 'modified'; } catch { /* no storage */ }

  const fileInput = el('input', {
    type: 'file', accept: IMPORT_EXTENSIONS.join(), hidden: true, 'aria-hidden': 'true', tabindex: -1,
    onchange: () => { const f = fileInput.files?.[0]; if (f) importFile(f); fileInput.value = ''; },
  });
  const pickDevice = () => fileInput.click();

  const search = el('input.input.home-search', {
    type: 'search', placeholder: 'Search spreadsheets', 'aria-label': 'Search spreadsheets', 'aria-keyshortcuts': '/',
    oninput: () => { query = search.value.trim().toLowerCase(); renderList(); },
    // Escape in a search field empties it where the browser does not already; an empty one lets go of the keyboard.
    onkeydown: (e) => {
      if (e.key !== 'Escape') return;
      if (search.value) { search.value = ''; query = ''; renderList(); } else search.blur();
      e.preventDefault();
    },
  });
  const searchBox = el('div.home-search-box', {},
    el('span.home-search-icon', { html: icon('search', 16), 'aria-hidden': 'true' }),
    search,
    el('kbd.kbd.home-search-key', { 'aria-hidden': 'true' }, '/'));
  // "/" goes to the search from anywhere on the screen, as it does on most file lists, unless something is being typed.
  const onSlash = (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || !root.isConnected) return;
    const t = e.target;
    if (t.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], .modal-root, .menu')) return;
    e.preventDefault();
    search.focus();
    search.select();
  };
  document.addEventListener('keydown', onSlash);

  // A relative time ("2 min ago") is written once and is stale a minute later. Every span that shows one is
  // kept in hand and, once a minute while the screen is up, those still on show are rewritten in place: the
  // rows themselves stay put, and with them the keyboard's place and any open menu. Leaving stops the clock.
  const clocks = new Set();
  const when = (cls, ts, more = null) => {
    const text = () => [relativeTime(ts), more].filter(Boolean).join(' · ');
    const node = el(cls, {}, text());
    clocks.add({ node, text });
    return node;
  };
  /**
   * Each file's row is built once and kept for as long as the listing it came from: a search or another order puts
   * the same rows back rather than building every one again, which on a list of a few thousand spreadsheets took a
   * fifth of a second a keystroke. A row's time is a column of its own on a wide screen, rewritten in place by the
   * clock below whether the row is on show or not, so a row a search brings back says the time it is now.
   */
  let rowCache = new Map(); // file → { row, time }
  const rowMeta = (ts, size) => {
    const time = el('span.file-when', {}, relativeTime(ts));
    return { time, meta: el('span.file-meta', {}, time, el('span.file-sep', { 'aria-hidden': 'true' }, ' · '), el('span.file-size', {}, formatBytes(size))) };
  };
  /**
   * A long list in order of change reads in stretches of time, as a file browser's does: Today,
   * Yesterday, the week, the month, and the rest. Each row still says its own time, so the labels
   * are for the eye, as the column header is.
   */
  const dayStart = (ago) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ago); return d.getTime(); };
  const groupOf = (stamp) => {
    if (!stamp) return 'Earlier';
    const ts = stamp < 1e12 ? stamp * 1000 : stamp; // the drive counts seconds, as relativeTime knows
    if (ts >= dayStart(0)) return 'Today';
    if (ts >= dayStart(1)) return 'Yesterday';
    if (ts >= dayStart(7)) return 'Previous 7 days';
    if (ts >= dayStart(30)) return 'Previous 30 days';
    return 'Earlier';
  };
  const groupsOf = (shown) => [...new Set(shown.map((f) => groupOf(f.modified)))];
  let shownFiles = [];
  let shownGroups = null; // the labels drawn, joined, or null when the list is drawn without them
  const tick = () => {
    for (const c of clocks) { if (c.node.isConnected) c.node.textContent = c.text(); else clocks.delete(c); }
    for (const [file, { time }] of rowCache) { const text = relativeTime(file.modified); if (time.textContent !== text) time.textContent = text; }
    // Past midnight, yesterday's "Today" is wrong: the list is drawn again when its date groups would change.
    if (shownGroups !== null && groupsOf(shownFiles).join() !== shownGroups) renderList();
  };
  const clock = setInterval(tick, 60000);

  const list = el('div.file-list', { role: 'list', 'aria-label': 'Spreadsheets' });
  const listHeading = el('h2.home-h2', { id: ids.files, tabindex: -1 }, 'Your spreadsheets');
  // How many there are, beside the heading; the status line below already says it, so this is for the eye only.
  const listCount = el('span.home-count', { 'aria-hidden': 'true', hidden: true });
  const showCount = (n) => { listCount.hidden = n == null; listCount.textContent = n == null ? '' : String(n); };
  // The list's columns, drawn once over it on a wide screen. The rows carry their own values, so the header is for the eye.
  const colHead = el('div.file-cols', { 'aria-hidden': 'true', hidden: true },
    el('span.file-col-name', {}, 'Name'), el('span.file-col-when', {}, 'Last modified'), el('span.file-col-size', {}, 'Size'));
  /**
   * The list is rebuilt in silence: a wait, its end and a search that narrows it are all shown and
   * none of them is said. The skeleton rows are hidden from assistive tech on purpose, so the wait is
   * carried by aria-busy on the list and its outcome by this line, which is read where it changes.
   */
  const listStatus = el('p.visually-hidden', { role: 'status' });
  const say = (text) => { if (listStatus.textContent !== text) listStatus.textContent = text; };

  /**
   * Rebuilding a list replaces every row, and with it the control the keyboard was on: after a delete,
   * a rename, a duplicate, a discard or a forget, focus fell to the top of the page and the next file
   * was a dozen tab stops away. Where focus was is noted before the rebuild and put back after it: on
   * the same row, else on the row that took its place, else on the section's heading. A reload that
   * paints the skeleton first keeps the note until the rows are back, and focus that has moved on by
   * then — to the search field, say — is left where the user put it.
   */
  let pendingFocus = null;
  const rowsOf = (container) => [...container.querySelectorAll('[data-focus-key]')];
  const controlsOf = (row) => [...row.querySelectorAll('a[href], button')];
  function keepingFocus(container, heading, rebuild) {
    const active = container.contains(document.activeElement) ? document.activeElement : null;
    const row = active?.closest('[data-focus-key]');
    if (row) pendingFocus = { container, key: row.dataset.focusKey, at: rowsOf(container).indexOf(row), control: Math.max(0, controlsOf(row).indexOf(active)) };
    rebuild();
    if (pendingFocus?.container !== container) return;
    if (document.activeElement && document.activeElement !== document.body) { pendingFocus = null; return; }
    const rows = rowsOf(container);
    if (!rows.length && loading) return; // the skeleton stands in for the rows: wait for them
    const next = rows.find((r) => r.dataset.focusKey === pendingFocus.key) || rows[Math.min(pendingFocus.at, rows.length - 1)];
    const target = next && (controlsOf(next)[pendingFocus.control] || controlsOf(next)[0]);
    (target || heading())?.focus();
    pendingFocus = null;
  }

  const draftsWrap = el('section.home-recent.home-drafts', { hidden: true, 'aria-label': 'Unsaved spreadsheets' });
  let lostDrafts = new Set(); // keys of drafts of files the drive no longer has (see findLostDrafts)
  function renderDrafts() {
    keepingFocus(draftsWrap, () => draftsWrap.querySelector('.home-h2') || listHeading, paintDrafts);
  }
  function paintDrafts() {
    const drafts = listDrafts().filter((draft) => draft.path === null || lostDrafts.has(draft.key));
    draftsWrap.hidden = !drafts.length;
    draftsWrap.replaceChildren();
    if (!drafts.length) return;
    draftsWrap.append(
      el('div.home-drafts-head', {},
        el('span.home-drafts-icon', { html: icon('alert', 18), 'aria-hidden': 'true' }),
        el('div', {},
          el('h2.home-h2', { tabindex: -1 }, 'Unsaved spreadsheets'),
          el('p.small.muted', {}, 'Kept only on this device, never saved to your cloud. Open one to recover it.'))),
      el('div.recent-list', { role: 'list' }, ...drafts.map((draft) => el('div.recent-chip', { role: 'listitem', dataset: { focusKey: draft.key } },
        // The edits to a file that is gone open through its old address, where they become a new spreadsheet.
        el('button.recent-open', {
          type: 'button', 'aria-label': `Recover ${draft.name}`, title: draft.path && 'The file no longer exists; the edits kept here open as a new spreadsheet',
          onclick: () => (draft.path ? openPath(draft.path) : recoverDraft?.(draft.key)),
        },
          el('span', { html: icon('sheet', 16) }), el('span.recent-name', { dir: 'auto' }, draft.name), when('span.recent-when', draft.savedAt)),
        el('button.icon-btn.recent-forget', { type: 'button', html: icon('x', 14), 'aria-label': `Discard ${draft.name}`, title: 'Discard this unsaved spreadsheet', onclick: () => discardDraft(draft) })))));
  }
  /**
   * Drafts keyed by a file's address whose file the drive no longer has (deleted elsewhere, say)
   * would otherwise be reachable only through a stale link to that address, and never cleaned up.
   * Only files not in the list are asked after, by id when the draft names one, else by address; a
   * file renamed or moved elsewhere lives on, and its draft is offered when it is opened, while one
   * in the trash is as good as deleted. A question that cannot be answered leaves the file as is.
   * A draft of a file that is gone while another file has its address (deleted, and a new spreadsheet
   * saved under its name) is not that file's: it is kept as an unsaved spreadsheet of its own, and
   * listed as such, rather than opening the file now at the address.
   */
  async function findLostDrafts(requestId) {
    const listed = (path) => files.find((f) => P.samePath(f.path, path));
    const anotherFile = (draft, found) => !!(found && draft.fileUid && found.uid && found.uid !== draft.fileUid);
    // The edits made to the same file while the draft awaited a decision were kept beside it (unlisted): they are as much that file's, and go with it.
    const park = (draft) => { const parked = parkDraft(draft.key); parkDraft(liveDraftKey(draft.key)); return parked; };
    const candidates = [];
    for (const draft of listDrafts()) {
      if (draft.path === null) continue;
      const here = listed(draft.path);
      if (anotherFile(draft, here)) park(draft);
      else if (!here) candidates.push(draft);
    }
    const lost = new Set();
    await Promise.all(candidates.map(async (draft) => {
      try {
        const found = draft.fileUid ? await P.statByUid(draft.fileUid) : await P.statFile(draft.path);
        if (found && !P.inTrash(found.path)) return;
        if (draft.fileUid && anotherFile(draft, await P.statFile(draft.path).catch(() => null)) && park(draft)) return;
        lost.add(draft.key);
      } catch { /* could not be asked */ }
    }));
    if (destroyed || requestId !== loadId) return;
    lostDrafts = lost;
    renderDrafts();
  }
  /** Unsaved work that was never a file is gone for good once discarded: ask first, as deleting a file does. */
  async function discardDraft(draft) {
    const ok = await confirmDialog({ title: `Discard "${draft.name}"?`, message: 'This unsaved spreadsheet is removed from this device. This cannot be undone.', confirmLabel: 'Discard' });
    if (!ok || destroyed) return;
    clearDraft(draft.key);
    clearDraft(liveDraftKey(draft.key)); // edits made to the file while that draft awaited a decision were kept beside it, and go with it
    renderDrafts();
  }
  /**
   * Spreadsheets other people shared with the user, at the masked addresses the drive gives them. Each
   * says whose it is and whether it may be edited; the × leaves the share, which only its owner can undo.
   */
  const sharedWrap = el('section.home-recent.home-shared', { hidden: true, 'aria-label': 'Shared with you' });
  // The newest few, as many as the files opened elsewhere keep: a long list would push the user's own far down.
  const SHARED_SHOWN = 8;
  let sharedAll = false;
  function renderShared() {
    keepingFocus(sharedWrap, () => sharedWrap.querySelector('.home-h2') || listHeading, paintShared);
  }
  function paintShared() {
    sharedWrap.hidden = !shared.length;
    if (!shared.length) { sharedWrap.replaceChildren(); return; }
    const chips = shared.map((f) => {
        const access = f.mode === 'write' || f.mode === 'manage' ? 'can edit' : 'view only';
        const from = [f.owner && `From ${f.owner}`, access].filter(Boolean).join(' · ');
        return el('div.recent-chip', { role: 'listitem', dataset: { focusKey: f.path } },
          el('button.recent-open', { type: 'button', title: `${f.name} · ${from}`, 'aria-label': `Open ${stripExtension(f.name)}, ${from}`, onclick: () => openPath(f.path) },
            el('span', { html: icon('users', 16) }), el('span.recent-name', { dir: 'auto' }, stripExtension(f.name)), el('span.recent-when', {}, from)),
          el('button.icon-btn.recent-forget', { type: 'button', html: icon('x', 14), 'aria-label': `Leave ${stripExtension(f.name)}`, title: 'Remove this spreadsheet from what is shared with you', onclick: () => leaveShared(f) }));
    });
    // Shown or hidden in place, not rebuilt, so the focus stays on the button that did it.
    const more = shared.length > SHARED_SHOWN && el('button.btn.btn-ghost.btn-sm.home-shared-more', { type: 'button', onclick: () => { sharedAll = !sharedAll; fold(); } });
    function fold() {
      chips.forEach((chip, i) => { chip.hidden = !sharedAll && i >= SHARED_SHOWN; });
      if (!more) return;
      more.textContent = sharedAll ? 'Show fewer' : `Show all ${shared.length}`;
      more.setAttribute('aria-expanded', String(sharedAll));
    }
    fold();
    // The native replaceChildren writes `false` out as text; only a list long enough to fold has the button.
    sharedWrap.replaceChildren(
      el('h2.home-h2', { tabindex: -1 }, 'Shared with you'),
      el('div.recent-list', { role: 'list' }, ...chips),
      ...(more ? [more] : []));
  }
  async function loadShared(requestId) {
    let next = [];
    try { next = await P.listSharedWithMe(); } catch (e) { console.error(e); } // the list of one's own files does not wait on, nor fail with, this one
    if (destroyed || requestId !== loadId) return;
    shared = next;
    renderShared();
    renderRecent(); // a shared file opened before is listed here now, not as opened elsewhere
  }
  async function leaveShared(f) {
    const ok = await confirmDialog({
      title: `Leave "${stripExtension(f.name)}"?`,
      message: `You will no longer be able to open this spreadsheet${f.owner ? `. ${f.owner} can share it with you again` : ''}. The file itself is not deleted.`,
      confirmLabel: 'Leave',
    });
    if (!ok || destroyed) return;
    try {
      // Nothing withdrawn while the file still opens: the access comes through a team the user is in, which
      // a leave does not reach. Said so, the chip stays; gone meanwhile (the owner stopped sharing), it goes.
      if (!await P.leaveShare(f.path) && await P.statFile(f.path).catch(() => null)) {
        if (destroyed) return;
        toast(`This spreadsheet is shared with a team you are in, so it cannot be left here${f.owner ? `. Ask ${f.owner} to stop sharing it with the team` : ''}`, { icon: 'info', duration: 6000 });
        return;
      }
      if (destroyed) return;
      forgetRecent(f.path);
      shared = shared.filter((s) => s.path !== f.path);
      renderShared();
      toast('Removed from shared with you', { icon: 'check' });
    } catch (e) {
      toast(P.failureText(e, 'Could not leave the share'), { icon: 'alert' });
    }
  }
  // Files opened from elsewhere on the drive (not in the app folder) are remembered on this device.
  const recentWrap = el('div.home-recent', { hidden: true });
  function renderRecent() {
    keepingFocus(recentWrap, () => recentWrap.querySelector('.home-h2') || listHeading, paintRecent);
  }
  function paintRecent() {
    const listed = new Set([...files, ...shared].map((f) => f.path));
    const recent = recentFiles().filter((r) => !listed.has(r.path) && !P.inAppFolder(r.path));
    recentWrap.hidden = !recent.length;
    if (!recent.length) { recentWrap.replaceChildren(); return; }
    recentWrap.replaceChildren(
      el('h2.home-h2', { tabindex: -1 }, 'Recently opened elsewhere'),
      el('div.recent-list', { role: 'list' }, ...recent.map((r) => el('div.recent-chip', { role: 'listitem', dataset: { focusKey: r.path } },
        el('button.recent-open', { type: 'button', title: r.path, onclick: () => (r.uid && openFile ? openFile(r.uid) : openPath(r.path)) }, el('span', { html: icon('sheet', 16) }), el('span.recent-name', { dir: 'auto' }, stripExtension(r.name)), when('span.recent-when', r.at)),
        el('button.icon-btn.recent-forget', { type: 'button', html: icon('x', 14), 'aria-label': `Forget ${stripExtension(r.name)}`, title: 'Remove from this list', onclick: () => { forgetRecent(r.path); renderRecent(); } })))));
  }
  const SORTS = [['modified', 'Last modified'], ['name', 'Name'], ['size', 'Size']];
  const sortBtn = el('button.btn.btn-ghost.btn-sm.home-sort', {
    type: 'button', 'aria-haspopup': 'menu',
    onclick: (e) => openMenu({
      anchor: e.currentTarget, align: 'end', label: 'Sort by',
      // One order of several: a radio item, not a checkbox.
      items: SORTS.map(([key, label]) => ({ label, checked: sortBy === key, radio: true, onSelect: () => { sortBy = key; try { localStorage.setItem('spreadsheet:homeSort', key); } catch { /* no storage */ } renderList(); } })),
    }),
  });
  /** The button shows the current order; its spoken name says what the order is of and includes it. */
  const labelSort = () => {
    const order = SORTS.find(([k]) => k === sortBy)[1];
    sortBtn.replaceChildren(el('span', { html: icon('chevUD', 14, 2) }), el('span', {}, order));
    sortBtn.setAttribute('aria-label', `Sort spreadsheets by: ${order}`);
    colHead.dataset.sort = sortBy;
  };
  labelSort(); // labelled from the start, not only once the list has loaded
  const sortedFiles = () => {
    const out = [...files];
    if (sortBy === 'name') out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    else if (sortBy === 'size') out.sort((a, b) => (b.size || 0) - (a.size || 0) || a.name.localeCompare(b.name));
    else out.sort((a, b) => (b.modified || 0) - (a.modified || 0));
    return out;
  };

  const avatar = el('button.icon-btn.user-btn', {
    type: 'button', 'aria-label': 'Account menu', 'aria-haspopup': 'menu',
    onclick: (e) => openAppMenu(e.currentTarget),
  });
  renderAccountButton(avatar);

  const root = el('div.home.view', {},
    fileInput,
    el('header.home-head', {},
      el('div.brand', {}, el('span.brand-mark', { html: icon('brand', 20, 2) }), el('h1.brand-name', {}, 'Spreadsheet')),
      el('div.grow'),
      avatar),
    el('main.home-main', {},
      el('section.home-start', { 'aria-labelledby': ids.start },
        el('div.home-section-head', {},
          el('h2.home-h2', { id: ids.start }, 'Start a new spreadsheet'),
          el('div.home-actions', {},
            el('button.btn.btn-outline.btn-sm', { type: 'button', html: icon('upload', 16), onclick: pickDevice }, el('span', {}, 'Import file')),
            P.canPickFiles() && el('button.btn.btn-outline.btn-sm', { type: 'button', html: icon('folderOpen', 16), onclick: openFromPuter }, el('span', {}, 'Open from Puter')))),
        startTiles()),
      draftsWrap,
      sharedWrap,
      recentWrap,
      el('section.home-files', { 'aria-labelledby': ids.files },
        el('div.home-list-head', {},
          el('div.home-title', {}, listHeading, listCount),
          el('div.home-list-tools', {}, sortBtn, searchBox)),
        listStatus,
        el('div.file-panel', {}, colHead, list))));

  /**
   * The ways to start, as tiles: a blank sheet first, the most asked-for templates, and the rest of
   * them behind the last tile. Each tile is a button with its name for a label; the drawing above the
   * name is decoration. A group, not a list, as in the template picker.
   */
  function startTiles() {
    const FEATURED = ['budget', 'expenses', 'invoice', 'todo'];
    const featured = FEATURED.map((id) => TEMPLATES.find((t) => t.id === id)).filter(Boolean);
    const more = TEMPLATES.length - 1 - featured.length;
    const tile = (cls, { name, sub, glyph, preview, onclick, dataset }) => el(`button.start-tile${cls}`, { type: 'button', onclick, dataset },
      el(`span.start-thumb${preview ? '.has-preview' : ''}`, { 'aria-hidden': 'true' }, preview || el('span.start-glyph', { html: glyph })),
      el('span.start-label', {}, el('span.start-name', {}, name), sub && el('span.start-sub', {}, sub)));
    return el('div.start-grid', { role: 'group', 'aria-labelledby': ids.start },
      tile('.start-blank', { name: 'Blank spreadsheet', glyph: icon('plus', 28, 2), onclick: newDoc }),
      ...featured.map((t) => tile('', { name: t.name, preview: templateThumbnail(t.id), glyph: icon(t.icon, 22), onclick: () => templateDoc(t.id), dataset: { template: t.id } })),
      more > 0 && tile('.start-more', { name: 'All templates', sub: `${more} more`, glyph: icon('layers', 22), onclick: fromTemplate }));
  }

  async function openFromPuter() {
    if (session.signedOut && (!await session.signIn() || destroyed)) return;
    const picked = await P.pickFile();
    if (picked && !destroyed) openPath(picked.path);
  }

  async function load() {
    if (destroyed) return;
    const requestId = ++loadId;
    loading = true;
    error = null;
    if (session.signedOut) {
      // Nothing to list without a session; the list area offers the sign-in.
      files = [];
      shared = [];
      loading = false;
      renderList();
      renderDrafts();
      renderShared();
      renderRecent();
      return;
    }
    renderList();
    loadShared(requestId);
    refreshRecent().then(() => { if (!destroyed && requestId === loadId) renderRecent(); }, () => {}); // files moved or renamed since are listed where they are now
    try {
      const nextFiles = await P.listFiles();
      if (destroyed || requestId !== loadId) return;
      files = nextFiles;
      rowCache = new Map(); // the rows of the listing before
    } catch (e) {
      if (destroyed || requestId !== loadId) return;
      console.error(e);
      error = navigator.onLine ? 'Could not load your files from Puter.' : 'You are offline. Connect to see your files.';
    }
    loading = false;
    renderList();
    renderDrafts();
    renderRecent();
    if (!error) findLostDrafts(requestId); // after the list, which does not wait for it
  }

  function fileMenu(file, anchor) {
    openMenu({
      anchor, align: 'end', label: `${file.name} options`,
      items: [
        { label: 'Open', icon: 'sheet', onSelect: () => openPath(file.path) },
        // The ellipsis marks the items that open a dialog first: Rename asks for the name, Delete asks to be sure.
        { label: 'Rename…', icon: 'pencil', onSelect: () => rename(file) },
        P.canShare() && { label: 'Share…', icon: 'share', onSelect: () => openShareDialog({ path: file.path, name: stripExtension(file.name), uid: file.uid }) },
        { label: 'Duplicate', icon: 'duplicate', onSelect: () => duplicate(file) },
        { label: 'Download', icon: 'download', onSelect: () => download(file) },
        { separator: true },
        { label: 'Delete…', icon: 'trash', danger: true, onSelect: () => remove(file) },
      ].filter(Boolean),
    });
  }

  async function rename(file) {
    const ext = file.name.slice(file.name.lastIndexOf('.'));
    // A typed "Budget.xlsx" names the file Budget.xlsx, not Budget.xlsx.xlsx.
    const stem = (typed) => { const clean = P.sanitizeName(typed); return clean.toLowerCase().endsWith(ext.toLowerCase()) ? clean.slice(0, -ext.length).trim() : clean; };
    const name = await promptDialog({
      title: 'Rename', label: 'Name', value: stripExtension(file.name), confirmLabel: 'Rename',
      validate: (v) => {
        const clean = stem(v);
        if (!clean) return 'Enter a name';
        if (files.some((f) => f.name.toLowerCase() === `${clean}${ext}`.toLowerCase() && f.path !== file.path)) return 'A file with that name already exists';
        return null;
      },
    });
    if (name == null) return;
    const target = `${file.path.slice(0, file.path.lastIndexOf('/') + 1)}${stem(name)}${ext}`;
    try {
      await P.renameFile(file.path, `${stem(name)}${ext}`);
      // What is kept for the file follows it: its draft of unsaved edits (with the edits kept beside
      // one awaiting a decision), its outside-content decision and its history; the old address opens nothing any more.
      moveDraft(draftKey(file.path), draftKey(target));
      moveDraft(liveDraftKey(draftKey(file.path)), liveDraftKey(draftKey(target)));
      moveExternalDecision(file.path, target);
      forgetRecent(file.path);
      moveVersions({ path: file.path, uid: file.uid }, { path: target, uid: file.uid }).catch(() => {});
      toast('Renamed');
      load();
    } catch (e) {
      toast(P.failureText(e, 'Could not rename'), { icon: 'alert' });
    }
  }

  async function duplicate(file) {
    try {
      const bytes = await P.readFile(file.path);
      const stem = stripExtension(file.name);
      const ext = file.name.slice(file.name.lastIndexOf('.'));
      let name = `${stem} copy${ext}`;
      let n = 2;
      while (files.some((f) => f.name.toLowerCase() === name.toLowerCase())) name = `${stem} copy ${n++}${ext}`;
      // The displayed list may be stale, or another tab may claim the name.
      const written = await P.writeFile(`${P.FOLDER}/${name}`, new Blob([bytes]), { dedupe: true });
      // The copy holds the same content: whether it may load outside content is decided already.
      const copyPath = P.canonicalPath(`${P.FOLDER}/${written?.name || name}`, written);
      copyExternalDecision({ path: file.path, uid: file.uid }, { path: copyPath, uid: written?.uid || written?.id || null }).catch(() => {});
      // A history left under the copy's name by a file that is gone is not the copy's: it is put aside,
      // as a first save and Save as do, so that a stranger's snapshots are not listed and restored here.
      await parkVersions({ path: copyPath, uid: written?.uid || written?.id || null }).catch(() => {});
      toast('Duplicated');
      load();
    } catch (e) {
      toast(P.failureText(e, 'Could not duplicate'), { icon: 'alert' });
    }
  }

  async function download(file) {
    try {
      const bytes = await P.readFile(file.path);
      const blob = new Blob([bytes]);
      if (P.isApp() && P.canSaveFiles()) P.saveFileAs(blob, file.name).catch(() => {});
      else P.downloadBlob(blob, file.name);
    } catch (e) {
      toast(P.failureText(e, 'Could not download'), { icon: 'alert' });
    }
  }

  async function remove(file) {
    const ok = await confirmDialog({ title: `Delete "${stripExtension(file.name)}"?`, message: 'The file is removed from your Puter cloud. This cannot be undone.', confirmLabel: 'Delete' });
    if (!ok) return;
    try {
      await P.deleteFile(file.path);
      removeVersions({ path: file.path, uid: file.uid }).catch(() => {});
      // A local draft of a deleted file has nowhere to go, under either spelling of its address, nor have
      // the edits kept beside one awaiting a decision; whatever lands at the address later is another file with a decision of its own.
      for (const spelling of [file.path, P.legacyAppPath(file.path)].filter(Boolean)) { clearDraft(draftKey(spelling)); clearDraft(liveDraftKey(draftKey(spelling))); }
      forgetExternalDecision({ path: file.path, uid: file.uid });
      files = files.filter((f) => f.path !== file.path);
      rowCache.delete(file);
      renderList();
      toast('Deleted', { icon: 'trash' });
    } catch (e) {
      toast(P.failureText(e, 'Could not delete'), { icon: 'alert' });
    }
  }

  function renderList() {
    keepingFocus(list, () => listHeading, paintList);
  }

  function paintList() {
    // The button stays on screen and stays usable through every state below, so it is relabelled
    // before any of them can return: a signed-out, loading or failed list left it naming the old order.
    labelSort();
    clear(list);
    showCount(null);
    colHead.hidden = true;
    shownGroups = null;
    // Only rows of files make a list; a notice or a loading skeleton is not a list item.
    list.setAttribute('role', 'list');
    if (loading) list.setAttribute('aria-busy', 'true'); else list.removeAttribute('aria-busy');
    if (session.signedOut) {
      say('');
      list.removeAttribute('role');
      list.append(el('div.empty', {},
        el('div.empty-icon', { html: icon('cloud', 26) }),
        el('h3', {}, 'Sign in to see your spreadsheets'),
        el('p', {}, 'Spreadsheets are saved as .xlsx files in your own Puter cloud. Sign in to open them here, or start working without an account.'),
        el('div.row', { style: { justifyContent: 'center', marginTop: '18px', flexWrap: 'wrap' } },
          el('button.btn.btn-primary', { type: 'button', html: icon('login', 16, 2.2), onclick: () => session.signIn() }, el('span', {}, 'Sign in to Puter')),
          el('button.btn.btn-outline', { type: 'button', html: icon('plus', 16, 2.2), onclick: newDoc }, el('span', {}, 'New spreadsheet')))));
      return;
    }
    if (loading) {
      say('Loading your spreadsheets…');
      list.removeAttribute('role');
      list.append(...['46%', '32%', '54%', '38%'].map((w) => el('div.file-row.skeleton-row', { 'aria-hidden': 'true' },
        el('div.skeleton', { style: { width: '36px', height: '36px', flex: 'none' } }),
        el('div.grow', {}, el('div.skeleton', { style: { width: w, height: '13px', marginBottom: '8px' } }), el('div.skeleton', { style: { width: '22%', height: '10px' } })))));
      return;
    }
    if (error) {
      say(error);
      list.removeAttribute('role');
      list.append(el('div.empty', {}, el('div.empty-icon', { html: icon('cloudOff', 26) }), el('h3', {}, 'Nothing to show'), el('p', {}, error),
        el('button.btn.btn-outline', { type: 'button', style: { marginTop: '16px' }, onclick: load }, 'Try again')));
      return;
    }
    const ordered = sortedFiles();
    // The search reads the names as the list shows them, without the extension every file shares.
    const shown = query ? ordered.filter((f) => stripExtension(f.name).toLowerCase().includes(query)) : ordered;
    if (!shown.length) {
      // The search finds a name holding the text anywhere, and the messages say so, in the case it was typed.
      const typed = search.value.trim();
      say(files.length ? `No spreadsheet names contain "${typed}"` : 'No spreadsheets yet');
      list.removeAttribute('role');
      list.append(files.length
        ? el('div.empty', {}, el('div.empty-icon', { html: icon('search', 26) }), el('h3', {}, 'No matches'), el('p', {}, `No spreadsheet names contain "${typed}"`))
        : el('div.empty', {}, el('div.empty-icon', { html: icon('sheet', 26) }), el('h3', {}, 'No spreadsheets yet'),
          el('div.row', { style: { justifyContent: 'center', marginTop: '18px', flexWrap: 'wrap' } },
            el('button.btn.btn-primary', { type: 'button', html: icon('plus', 16, 2.2), onclick: newDoc }, el('span', {}, 'New spreadsheet')),
            el('button.btn.btn-outline', { type: 'button', html: icon('sparkle', 16), onclick: sampleDoc }, el('span', {}, 'Try sample data')))));
      return;
    }
    say(`${shown.length} spreadsheet${shown.length === 1 ? '' : 's'}${query ? ` containing "${search.value.trim()}"` : ''}`);
    showCount(query ? `${shown.length} of ${files.length}` : files.length);
    colHead.hidden = false;
    // Groups only in order of change, and only when there is more than one: a single "Today" says nothing.
    const groups = sortBy === 'modified' ? groupsOf(shown) : [];
    const grouped = groups.length > 1;
    shownFiles = shown;
    shownGroups = sortBy === 'modified' ? groups.join() : null;
    let group = null;
    list.append(...shown.flatMap((file) => {
      const label = grouped && groupOf(file.modified) !== group ? (group = groupOf(file.modified)) : null;
      const row = fileRow(file);
      return label ? [el('div.file-group', { 'aria-hidden': 'true' }, label), row] : [row];
    }));
  }

  /** The row of a file in the list, built the first time it is shown (see rowCache). */
  function fileRow(file) {
    const kept = rowCache.get(file);
    if (kept) return kept.row;
    const { time, meta } = rowMeta(file.modified, file.size);
    const row = el('div.file-row', { role: 'listitem', dataset: { focusKey: file.path } },
      el('a.file-main', {
        href: `#/edit/${encodeURIComponent(file.path)}`,
        title: file.name, // a long name is cut short on screen; the whole of it on hover
        // A modifier click asks for a new tab or window: leave it to the browser.
        onclick: (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); openPath(file.path); },
      },
        el('span.file-icon', { html: icon('sheet', 20) }),
        el('span.file-text', {},
          // A file named in a right-to-left script is laid out that way, its digits and punctuation at its own end.
          el('span.file-name', { dir: 'auto' }, stripExtension(file.name)),
          meta)),
      el('button.icon-btn.file-menu-btn', {
        type: 'button', html: icon('moreV', 18), 'aria-label': `Options for ${stripExtension(file.name)}`, 'aria-haspopup': 'menu',
        onclick: (e) => fileMenu(file, e.currentTarget),
      }));
    rowCache.set(file, { row, time });
    return row;
  }

  renderDrafts();
  load();

  let hadSession = !session.signedOut;
  const onSession = () => {
    renderAccountButton(avatar);
    // Signing in brings the list; the sign-in state is replaced by the files.
    if (!hadSession && !session.signedOut) load();
    hadSession = !session.signedOut;
  };
  session.addEventListener?.('change', onSession);

  return { el: root, reload: load, destroy() { destroyed = true; clearInterval(clock); document.removeEventListener('keydown', onSlash); session.removeEventListener?.('change', onSession); } };
}

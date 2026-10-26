/**
 * Live co-editing in the editor: the Share command and dialog, who is here
 * (avatars in the title bar, carets and selections on the pages), the notice
 * bar for roles and the single-editor fallback. The co-editing engine (Yjs, the room client) loads only
 * when a document is shared or opened from an invitation.
 *
 * Commands on the editor's command object: share(), collaborators(),
 * shareItems() additions, coauthoringStatus().
 */
import { zipSync } from 'fflate';
import { el } from '../ui/dom.js';
import { openMenu } from '../ui/menu.js';
import { toast } from '../ui/toast.js';
import { engineApi } from '../lib/engine-api.js';
import { canEmail, sendMail } from '../lib/mail-send.js';
import { roleLabel, initials, colorFor } from '../collab/protocol.js';
import { rememberedRoom } from '../collab/room-memory.js';
import { openShareDialog, roleSentence } from './share-dialog.js';

/** This tab's name in local sharing (tabs of one browser): ?name= in the address, or a guest name kept for the tab. */
export function localGuest() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem('documents:collab-guest') || 'null'); } catch { /* storage blocked */ }
  const asked = new URLSearchParams(location.search).get('name');
  if (!saved || (asked && saved.name !== asked)) {
    saved = { id: `guest-${Math.random().toString(36).slice(2, 10)}`, name: (asked || `Guest ${Math.floor(10 + Math.random() * 90)}`).slice(0, 40) };
    try { sessionStorage.setItem('documents:collab-guest', JSON.stringify(saved)); } catch { /* storage blocked */ }
  }
  return saved;
}

/**
 * Keep the document from being changed until the returned function is called: the editor reads only, whatever
 * Editing / Viewing mode is chosen meanwhile, and the mode chosen last applies afterwards.
 */
function holdEditing(engine) {
  const original = engine?.setViewOnly;
  if (typeof original !== 'function') return () => {};
  const own = Object.hasOwn(engine, 'setViewOnly');
  let wanted = !!engine.viewOnly, released = false;
  engine.setViewOnly = on => { wanted = !!on; original.call(engine, true); };
  original.call(engine, true);
  return () => {
    if (released) return;
    released = true;
    if (own) engine.setViewOnly = original; else delete engine.setViewOnly;
    if (!engine.destroyed) original.call(engine, wanted);
  };
}

const MODE_REASONS = { 'content controls without text': 'form fields that are still empty', 'line feeds inside a run': 'text this editor keeps as a single run' };

export function createCollaboration({ editor, pkg, doc, local, error, onChange = () => {}, documentName, user, saveFirst, exportDocx, exportPdf, signIn = async () => true, readOnly = () => false, baseAssets = () => Object.keys(pkg()?.assets || {}) }) {
  let live = null, starting = null, liveModule = null, dialog = null, destroyed = false;
  const loadLive = () => (liveModule ||= import('../collab/live.js'));
  // The room an owner shared this file in, looked up while the editor loads rather than after.
  const remembered = !local && doc.path && !doc.collab ? rememberedRoom(doc.path) : null;

  /* ---- Title bar: who is here ---- */
  const avatars = el('div.cl-presence', { hidden: true, role: 'group', 'aria-label': 'People in this document' });
  const chip = el('span.cl-chip', { hidden: true });
  const banner = el('div.cl-banner', { role: 'status', hidden: true });

  function people() { return live ? live.people() : []; }
  function renderPeople() {
    const list = people();
    avatars.hidden = !live;
    if (!live) { avatars.replaceChildren(); return; }
    const shown = list.slice(0, 4), extra = list.length - shown.length;
    avatars.replaceChildren(...shown.map(p => el('button.cl-avatar', { type: 'button', style: `--cl-color: ${p.color || colorFor(p.name)}`, title: `${p.name}${p.me ? ' (you)' : ''} · ${roleLabel(p.role || 'editor')}`,
      'aria-label': `${p.name}${p.me ? ' (you)' : ''}, ${roleLabel(p.role || 'editor')}`, onclick: e => peopleMenu(e.currentTarget, !!e.detail) }, initials(p.name))),
    ...(extra > 0 ? [el('button.cl-avatar.cl-more', { type: 'button', 'aria-label': `${extra} more`, onclick: e => peopleMenu(e.currentTarget, !!e.detail) }, `+${extra}`)] : []), chip);
    renderChip();
  }
  function renderChip() {
    if (!live) { chip.hidden = true; return; }
    const offline = live.status === 'offline', pending = live.pending;
    const text = offline ? (pending ? `Offline · ${pending} waiting` : 'Offline') : live.role === 'viewer' ? 'View only' : live.role === 'commenter' ? 'Comment only' : '';
    chip.textContent = text; chip.hidden = !text;
    chip.classList.toggle('is-offline', offline);
  }
  function peopleMenu(anchor, pointer) {
    const list = people();
    openMenu({ anchor, label: 'People in this document', minWidth: 240, align: 'end', pointer, items: [
      { header: `${list.length} ${list.length === 1 ? 'person' : 'people'} here` },
      ...list.map(p => ({ label: `${p.name}${p.me ? ' (you)' : ''}`, hint: roleLabel(p.role || 'editor'), disabled: p.me, onSelect: () => { if (!live.follow(p.session)) toast(`${p.name} is not in the document text right now.`, { icon: 'info' }); } })),
      { separator: true },
      { label: 'Share…', icon: 'share', onSelect: () => share() },
    ] });
  }

  /* ---- Notices ---- */
  function setBanner(text, actions = []) {
    banner.hidden = !text;
    banner.replaceChildren(...(text ? [el('span.cl-banner-text', {}, text), ...actions] : []));
  }
  function renderBanner(event) {
    if (!live) return;
    const binding = live.binding, role = live.role;
    if (binding.conflict) return setBanner('Two changes to the same table could not be combined. You see the last version that fits together; an editor’s next change restores it for everyone.');
    if (binding.mode === 'single' && !binding.holdsLock()) {
      const lock = binding.meta.get('lock');
      const holderHere = lock && live.client.roster.some(p => p.session === lock.session);
      const why = 'This document has content that only one person can edit at a time';
      if (holderHere) return setBanner(`${why}. ${lock.name} is editing; you see their changes as they make them.`);
      return setBanner(`${why}. Nobody is editing it now.`, role === 'viewer' || role === 'commenter' ? [] : [el('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => { live.binding.takeLock(); renderBanner(); editor()?.focus(); } }, 'Edit Now')]);
    }
    if (binding.mode === 'single' && event?.type === 'single') return setBanner(`Others see this document read-only while you edit: it now has ${MODE_REASONS[event.detail?.reason] || 'content'} that only one person can change at a time.`);
    if (role === 'viewer') return setBanner('You can view this document. Ask its owner if you need to edit it.');
    if (role === 'commenter') return setBanner('You can read and comment on this document. Ask its owner if you need to edit it.');
    setBanner('');
  }

  /* ---- Sessions ---- */
  async function begin(client, link, { reopened = false } = {}) {
    const engine = editor(); if (!engine) return null;
    const { LiveSession } = await loadLive();
    // The editor closed while the room was being joined: leave it rather than run a session no one sees.
    if (destroyed) { client.close().catch(() => {}); return null; }
    const api = engineApi();
    const me = user();
    const commentGuard = api?.protectionGuard({ edit: 'comments', enforcement: true }, { name: me.name, email: me.name });
    const fileText = engine.session?.body?.text;
    live = new LiveSession({ engine, doc, client, link, user: me, baseAssets: baseAssets(), commentGuard,
      onApplied: () => onChange(), onError: e => error(e) });
    // Reopening a document it shared, the owner sees the room's state, which the file is then saved to. The room may lack
    // what the file has: a change made outside it (another app, a session that could not reach the room). The file as it
    // was is kept as a version before anything writes over it.
    if (reopened && fileText !== undefined && engine.session.body.text !== fileText && doc.keepFileVersion) {
      doc.keepFileVersion({ label: 'Before the shared changes' })
        .then(v => { if (v && !destroyed) toast('The shared document had changes this file did not, and they are shown now. The file as it was is kept in Version History.', { icon: 'info', duration: 10000 }); })
        .catch(e => console.warn('[documents] the file could not be kept as a version', e));
    }
    for (const name of ['people', 'status', 'saver']) live.addEventListener(name, () => { renderPeople(); onChange(); });
    for (const name of ['role', 'mode', 'single', 'conflict']) live.addEventListener(name, e => { renderBanner(e); renderPeople(); onChange(); });
    live.addEventListener('ended', e => {
      const reason = e.detail?.reason;
      const session = live; live = null;
      renderPeople();
      if (reason) setBanner(`${reason} The document stays open here as your own copy.`, session.role !== 'owner' ? [el('button.btn.btn-sm.btn-outline', { type: 'button', onclick: async () => { doc.setSaving?.(true); doc.changed?.(); setBanner(''); try { await saveFirst(); } catch (err) { error(err); } } }, local ? 'Keep a Copy' : 'Save a Copy')] : []);
      else setBanner('');
      onChange();
    });
    renderPeople(); renderBanner();
    onChange();
    return live;
  }

  /**
   * Save As and Save a Copy go on in a new document of the user's own. It is not the shared one: this tab leaves the
   * room, with the changes made before the copy delivered, so nothing typed in the copy reaches the others (or, through
   * the room, the original file). A guest's copy is theirs to save from here on.
   */
  const onPath = e => {
    if (!live || !e.detail?.savedAs) return;
    live.end(null);
    setBanner('You are editing your own copy now, which is not shared. Everyone else goes on with the shared document.');
    onChange();
  };
  doc.addEventListener?.('path', onPath);

  /** After the editor opened: join the room the document came from, or the one its owner shared before. */
  async function attach() {
    try {
      if (doc.collab) {
        const { client, link } = doc.collab;
        if (!await begin(client, link)) return;
        toast(roleSentence(client.role) || 'You joined the shared document.', { icon: 'info' });
        return;
      }
      if (!local && doc.path && !readOnly() && remembered) {
        // The room's state replaces what the editor shows once it has been joined: anything typed before then
        // would be lost. A document shared before reads only until its room has been joined. One that never
        // was opens for editing at once (the lookup started while the editor loaded).
        const saved = await remembered;
        if (!saved?.server || !saved?.room || destroyed) return;
        const release = holdEditing(editor());
        try {
          setBanner('Connecting to the shared document… You can edit it once it has opened.');
          const { reconnect } = await loadLive();
          const found = await reconnect(doc.path, user(), saved);
          if (!live) setBanner('');
          release();
          if (found) await begin(found.client, found.link, { reopened: true });
        } finally { release(); }
      }
    } catch (e) { if (!live) setBanner(''); error(e); }
  }

  /** Start sharing (once): the first invitation or link creates the room. */
  function ensureShared(progress = () => {}) {
    if (live) return Promise.resolve(live);
    return (starting ||= (async () => {
      const engine = editor();
      if (!engine) throw new Error('The document is still opening.');
      if (readOnly()) throw new Error('This document is open read-only, so it cannot be edited together. Save a copy first.');
      engine.finishComposition();
      if (!local) {
        if (!await signIn()) throw new Error('Sign in to Puter to share this document.');
        // A template or other file whose edits go to a new .docx (inside the Puter desktop, at the first Save) is
        // shared as that .docx, as a new document is: the room must not be the template's, nor the file it writes.
        if (!doc.path || doc.waitsForPlace) { progress('Saving the document first…'); await saveFirst(); }
        if (!doc.path || doc.waitsForPlace) throw new Error('Save the document before sharing it.');
      }
      const { shareDocument } = await loadLive();
      const p = pkg();
      const baseBytes = p?.parts ? zipSync(p.parts) : new Uint8Array(await exportDocx().arrayBuffer());
      const { client, link, reason } = await shareDocument({ engine, doc, user: user(), name: documentName() || 'Untitled document', baseBytes, local, progress });
      if (!await begin(client, link)) throw new Error('The document was closed.');
      // Pictures added since the file was opened are not in the document the room starts from.
      live.binding.shareOwnAssets();
      if (reason) toast('Others will see this document read-only while you edit it: it has content only one person can change at a time.', { icon: 'info', duration: 8000 });
      progress('');
      return live;
    })().finally(() => { starting = null; }));
  }

  async function emailInvitation(address, role, note) {
    const url = await live.inviteLink(role);
    const name = documentName() || 'a document';
    const who = user().name;
    const text = `${note ? `${note}\n\n` : ''}${who} invited you to ${role === 'editor' ? 'edit' : role === 'commenter' ? 'comment on' : 'view'} “${name}” in Documents.\n\nOpen it: ${url}\n\nYou will be asked to sign in to Puter. The invitation expires in seven days.`;
    return sendMail({ to: address, subject: `${who} shared “${name}” with you`, text, username: who });
  }
  async function sendCopy(address, format, note) {
    const name = (documentName() || 'Document').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Document';
    const blob = format === 'pdf' ? await exportPdf() : await exportDocx();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return sendMail({ to: address, subject: `“${name}” from ${user().name}`, text: `${note ? `${note}\n\n` : ''}${user().name} sent you a copy of “${name}”. It is attached as ${format === 'pdf' ? 'a PDF' : 'a Word document'}.`, username: user().name,
      attachments: [{ filename: `${name}.${format}`, bytes, contentType: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }] });
  }

  function share() {
    if (!editor()) return;
    dialog?.close();
    dialog = openShareDialog({ live: () => live, local, documentName, ensureShared, emailInvitation, sendCopy, canEmail: canEmail(),
      downloadCopy: format => (format === 'pdf' ? exportPdf(true) : exportDocx(true)), onClose: () => { dialog = null; queueMicrotask(() => editor()?.focus()); } });
  }

  /* ---- Ribbon and menus ---- */
  /* ---- Menus ---- */
  // Share and Version History sit in the title bar and the File menu; the Review tab is full already.
  const extendTab = () => [];
  function extendMenu(id) {
    if (id === 'tools') return [{ separator: true }, { label: 'Share…', icon: 'share', disabled: !editor(), onSelect: share }, ...(live ? [{ label: 'Co-authors', icon: 'coauthors', items: people().map(p => ({ label: `${p.name}${p.me ? ' (you)' : ''}`, hint: roleLabel(p.role || 'editor'), disabled: p.me, onSelect: () => live?.follow(p.session) })) }] : [])];
    return [];
  }
  const shareItems = () => [
    { label: 'Invite People…', icon: 'invitePeople', disabled: !editor(), onSelect: share },
    { label: 'Copy Link', icon: 'link', disabled: !editor() || readOnly(), onSelect: async () => {
      try { await ensureShared(); const url = await live.inviteLink('editor'); await navigator.clipboard?.writeText(url); toast('Link copied: anyone who opens it can edit'); }
      catch (e) { error(e); }
    } },
    ...(live ? [{ label: 'Manage Access…', icon: 'coauthors', onSelect: share }] : []),
    { separator: true },
  ];

  /**
   * Whether this tab has changes to a shared document that it does not save itself (a guest's, another owner tab's)
   * and that have not reached the room: they are nowhere else yet. The browser keeps them for the next visit to the
   * document from here, which the person may never make.
   */
  const undelivered = () => !!live && doc.writes === false && live.pending > 0;

  return {
    avatars, banner, attach, share, ensureShared, extendTab, extendMenu, shareItems,
    get live() { return live; },
    get undelivered() { return undelivered(); },
    /** Send those changes now (before leaving the document); resolves whether none are left. */
    async deliver() {
      if (undelivered()) await live.deliver();
      return !undelivered();
    },
    commands: {
      share,
      /** Who is in the document, for the title bar: [{ name, color, role, me }]. */
      collaborators: () => people().map(({ session, name, color, role, me }) => ({ session, name, color, role, me: !!me })),
      coauthoringStatus: () => (live ? { status: live.status, pending: live.pending, role: live.role, saves: !!live.saves } : null),
    },
    refresh() { renderChip(); },
    destroy() {
      destroyed = true; dialog?.close();
      doc.removeEventListener?.('path', onPath);
      // A room joined from an invitation whose session never began (the editor closed while opening, or could
      // not open the document) is left here; a session that began leaves it when it ends.
      if (!live && doc.collab?.client) doc.collab.client.close().catch(() => {});
      live?.destroy(); live = null;
    },
  };
}

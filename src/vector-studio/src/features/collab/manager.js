/**
 * CollabManager: shared documents in the app. Shares an open document
 * (deploying the owner's collaboration server), opens share links, keeps
 * one CollabSession per shared tab, follows other participants' views,
 * and stops sharing. The list of shared documents this account opened is
 * kept in its private app storage for the home screen.
 */
import { Emitter } from '../../lib/emitter.js';
import { uid } from '../../lib/ids.js';
import { VDocument } from '../../model/document.js';
import { CollabSession } from './session.js';
import { CollabError, call, deploy } from './api.js';
import { defaultOutbox } from './outbox.js';
import { canEdit, parseShareLink, shareLink } from './protocol.js';
import { claimLocalComments } from './comments.js';

const DOCS_KEY = 'vector-studio-collab-docs-v1';
const MAX_DOCS = 50;
const MEMBERS_MS = 60000;

export class CollabManager extends Emitter {
  /**
   * transportFor(server) and deployServer() replace the network in tests.
   */
  constructor(app, { outbox = null, transportFor = null, deployServer = null, sessionOptions = {} } = {}) {
    super();
    this.app = app;
    this.sessionOptions = sessionOptions;
    this.outbox = outbox || defaultOutbox();
    this.transportFor = transportFor;
    this.deployServer = deployServer;
    this.sessions = new Map(); // editor -> session
    this.membersCache = new Map(); // session -> { at, data }
    // A new window on a shared document works with its session too (comments, Save, roles).
    app.on('active-editor', (editor) => {
      if (editor && !editor.collab) editor.collab = this.sessionOf(editor);
    });
    app.on('closed', (editor) => {
      // Another window still shows the document: it keeps the session.
      const other = this.sessions.has(editor) && app.editors.find((e) => e.doc === editor.doc);
      if (other) this.#handOver(editor, other);
      else this.detach(editor, { leave: true });
    });
  }

  get puter() {
    return this.app.puter;
  }

  /** { uuid, username } of the signed-in account, or null. */
  identity() {
    const u = this.app.user;
    return u?.uuid && u.username ? { uuid: u.uuid, username: u.username } : null;
  }

  /** Why sharing cannot work right now, or null when it can. */
  unavailable() {
    if (!this.puter && !this.transportFor) return 'Sharing needs Puter, which could not be reached. Check your connection and reload the app.';
    if (!this.identity()) return 'Sign in with Puter to share documents and open documents others share with you.';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'You are offline. Sharing needs a connection; your own files keep working.';
    return null;
  }

  transport(server) {
    if (this.transportFor) return this.transportFor(server);
    return { call: (input) => call(this.puter, server, input) };
  }

  /** The session of a shared document, from any window showing it. */
  sessionOf(editor) {
    if (!editor) return null;
    const own = this.sessions.get(editor);
    if (own) return own;
    for (const [e, s] of this.sessions) if (e.doc === editor.doc) return s;
    return null;
  }

  // ---- sharing ----

  /** Share an open personal document: it becomes a shared document this account owns. */
  async share(editor, progress = () => {}) {
    const user = this.identity();
    if (!user) throw new CollabError('Sign in with Puter to share documents.');
    if (this.sessionOf(editor)) return this.sessionOf(editor);
    const server = this.deployServer ? await this.deployServer(progress) : await deploy(this.puter, progress);
    const doc = editor.doc;
    // The owner's own earlier comments become theirs by name.
    if (doc.comments) doc.setComments(claimLocalComments(doc.comments, { id: user.uuid, name: user.username }));
    const room = uid('d').replace(/[^A-Za-z0-9_-]/g, '') + Math.random().toString(36).slice(2, 10);
    const session = new CollabSession({ transport: this.transport(server), server, room, user, puter: this.puter, outbox: this.outbox, ...this.sessionOptions });
    progress('Sharing the document...');
    await session.create(doc, editor.name);
    editor.file = { kind: 'shared', name: editor.name, server, room };
    this.attach(editor, session);
    doc.markSaved();
    this.remember({ server, room, name: editor.name, owner: user.username, role: 'owner' });
    return session;
  }

  /** Open a share link (or { server, room, invite }); activates the tab when already open. */
  async open(target, { activate = true } = {}) {
    const link = typeof target === 'string' ? parseShareLink(target) : target;
    if (!link) throw new CollabError('This is not a Vector Studio share link.');
    for (const [editor, s] of this.sessions) {
      if (s.server === link.server && s.room === link.room) {
        if (activate) this.app.activate(editor);
        return editor;
      }
    }
    const user = this.identity();
    if (!user) throw new CollabError('Sign in with Puter to open shared documents.');
    const session = new CollabSession({ transport: this.transport(link.server), server: link.server, room: link.room, user, puter: this.puter, outbox: this.outbox, ...this.sessionOptions });
    const data = await session.join(link.invite);
    const doc = VDocument.fromJSON({ nodes: data.nodes, assets: data.assets, comments: data.comments });
    const name = session.joinInfo?.name || doc.root.name;
    const editor = this.app.addDocument(doc, { file: { kind: 'shared', name, server: link.server, room: link.room }, activate });
    this.attach(editor, session);
    editor.fitAll?.();
    this.remember({ server: link.server, room: link.room, name, owner: session.owner?.username || '', role: session.role });
    return editor;
  }

  attach(editor, session) {
    this.sessions.set(editor, session);
    editor.collab = session;
    session.bind(editor);
    this.#wire(editor, session);
  }

  /** Move a session to another window showing the same document (the one it was in closed). */
  #handOver(from, to) {
    const session = this.sessions.get(from);
    for (const off of session.offs || []) off();
    this.sessions.delete(from);
    from.collab = null;
    from.collabFollow = null;
    this.sessions.set(to, session);
    to.collab = session;
    session.editor = to;
    this.#wire(to, session);
  }

  /** The app's reactions to a session shown in `editor`. */
  #wire(editor, session) {
    this.applyRole(editor);
    const offs = [
      session.on('role', (role, prev) => {
        this.applyRole(editor);
        if (prev && editor === this.app.editor) this.app.notify(`Your access changed: ${roleSentence(role)}.`);
        this.emit('change', editor);
      }),
      session.on('status', () => this.emit('change', editor)),
      session.on('pending', () => this.app.renderTabs()),
      session.on('presence', () => {
        this.#followUpdate(editor);
        editor.emit('overlay');
        this.emit('presence', editor);
      }),
      session.on('rejected', (err) => this.app.notify(`A change could not be shared and was undone: ${err.message}`, { error: true })),
      session.on('ended', ({ kind, message }) => this.#ended(editor, kind, message)),
      session.on('remote-comments', (e) => this.emit('remote-comments', { editor, ...e })),
    ];
    session.offs = offs;
    this.emit('change', editor);
  }

  /** View-only documents for viewers and commenters (see gating.js). */
  applyRole(editor) {
    const session = this.sessionOf(editor);
    const ro = Boolean(session && !canEdit(session.role));
    if (editor.doc.readOnly !== ro) {
      editor.doc.readOnly = ro;
      if (ro) editor.clearSelection?.();
    }
    this.emit('role', editor);
  }

  detach(editor, { leave = false } = {}) {
    const session = this.sessions.get(editor);
    if (!session) return;
    this.sessions.delete(editor);
    for (const off of session.offs || []) off();
    session.close({ leave });
    for (const e of [editor, ...this.app.editors.filter((x) => x.doc === editor.doc)]) e.collab = null;
    editor.collabFollow = null;
    editor.doc.readOnly = false;
    this.emit('change', editor);
    this.emit('role', editor);
  }

  #ended(editor, kind, message) {
    this.forget(editor);
    this.detach(editor);
    // The tab stays open as an unsaved copy of what was shown.
    editor.file = null;
    editor.doc.savedRevision = -1;
    this.app.renderTabs();
    this.app.notify(`${message || (kind === 'removed' ? 'Your access was removed.' : 'Sharing ended.')} This tab is now your own unsaved copy.`, { timeout: 8000 });
  }

  /** Owner: stop sharing; the tab becomes a personal document again. */
  async stop(editor) {
    const session = this.sessionOf(editor);
    if (!session) return;
    await session.transport.call({ op: 'stop', room: session.room });
    this.forget(editor);
    this.detach(editor);
    session.outbox?.delete(session.key)?.catch?.(() => {});
    editor.file = null;
    editor.doc.savedRevision = -1;
    this.app.renderTabs();
  }

  // ---- access management (owner) ----

  async members(editor, { fresh = false } = {}) {
    const session = this.sessionOf(editor);
    if (!session) return null;
    const hit = this.membersCache.get(session);
    if (!fresh && hit && Date.now() - hit.at < MEMBERS_MS) return hit.data;
    const data = await session.transport.call({ op: 'members', room: session.room });
    this.membersCache.set(session, { at: Date.now(), data });
    return data;
  }

  async manage(editor, input) {
    const session = this.sessionOf(editor);
    if (!session) throw new CollabError('This document is not shared.');
    const res = await session.transport.call({ ...input, room: session.room });
    this.membersCache.delete(session);
    return res;
  }

  /** A link for people to open; with a role it is an invitation for new people. */
  async link(editor, { role = null, review = false } = {}) {
    const session = this.sessionOf(editor);
    if (!session) return null;
    if (!role) return shareLink(session.server, session.room);
    const { token } = await this.manage(editor, { op: 'invite', role, review });
    return shareLink(session.server, session.room, token);
  }

  // ---- following ----

  follow(editor, sessionId) {
    editor.collabFollow = sessionId || null;
    this.sessionOf(editor)?.setLocalState({ following: sessionId || null });
    this.#followUpdate(editor, true);
    this.emit('change', editor);
  }

  #followUpdate(editor, jump = false) {
    const id = editor.collabFollow;
    if (!id) return;
    const p = this.sessionOf(editor)?.others.get(id);
    if (!p) {
      editor.collabFollow = null;
      this.app.notify('The person you were following left.', { polite: true });
      this.emit('change', editor);
      return;
    }
    const v = p.state?.view;
    if (!v || !(v.w > 0 && v.h > 0)) return;
    const key = `${v.x},${v.y},${v.w},${v.h}`;
    if (!jump && key === editor.collabFollowKey) return;
    editor.collabFollowKey = key;
    editor.collabFollowing = true;
    editor.view.fit(v, 0);
    editor.viewChanged();
    editor.collabFollowing = false;
  }

  // ---- shared documents list (home screen) ----

  async recent() {
    if (!this.puter?.kv || !this.identity()) return [];
    try {
      const list = await this.puter.kv.get(DOCS_KEY);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  async remember(entry) {
    if (!this.puter?.kv) return;
    try {
      const list = (await this.recent()).filter((e) => !(e.server === entry.server && e.room === entry.room));
      list.unshift({ ...entry, opened: Date.now() });
      await this.puter.kv.set(DOCS_KEY, list.slice(0, MAX_DOCS));
    } catch {
      // The list is a convenience; sharing works without it.
    }
  }

  async forget(editorOrEntry) {
    const e = editorOrEntry?.file || editorOrEntry;
    const s = this.sessionOf(editorOrEntry);
    const server = s?.server || e?.server;
    const room = s?.room || e?.room;
    if (!this.puter?.kv || !server) return;
    try {
      const list = (await this.recent()).filter((x) => !(x.server === server && x.room === room));
      await this.puter.kv.set(DOCS_KEY, list);
    } catch {
      // Ignore.
    }
  }
}

export function roleSentence(role) {
  return { owner: 'you own this document', editor: 'you can edit', commenter: 'you can view and comment', viewer: 'you can view' }[role] || 'you can view';
}

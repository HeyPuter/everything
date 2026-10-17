/**
 * A live co-editing session for an open document: starting to share (a new
 * room), joining from a link, the binding between the editor and the room,
 * presence (others' carets, selections and names, painted over the pages),
 * which tab writes the file, and access management.
 *
 * The DOCX file stays the saved artifact. The room holds the document as it
 * was shared (its base file) and every change since; one tab saves the file:
 * the owner's, the one with the lowest session id when the owner has several
 * open. Everyone else's edits reach the file through it. A room on a Puter
 * worker keeps changes while the owner is away; the owner's next visit saves
 * them.
 */
import * as Y from 'yjs';
import { CollabBinding, editorState } from './binding.js';
import { CollabClient } from './client.js';
import { createSharedDoc, unsupportedReason } from './shared-doc.js';
import { BroadcastRoom, WorkerTransport } from './transports.js';
import { call, deploy } from './api.js';
import { canEdit, canManage, decode, encode, hash, randomId, shareLink, INVITE_ROLES } from './protocol.js';

const ROOM_KEY = 'documents-collab-room:';
const hexToRgba = (hex, alpha) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`; };

/** The SDK, when there is one (the mock SDK in development). */
const sdk = () => (typeof puter !== 'undefined' ? puter : null);

/** The room remembered for a document file this account shared, or null. */
export async function rememberedRoom(path) {
  const owner = sdk();
  if (!owner?.kv || !path) return null;
  try { return await owner.kv.get(ROOM_KEY + await hash(path)); } catch { return null; }
}
async function rememberRoom(path, value) {
  const owner = sdk();
  if (!owner?.kv || !path) return;
  try { if (value) await owner.kv.set(ROOM_KEY + await hash(path), value); else await owner.kv.del(ROOM_KEY + await hash(path)); }
  catch { /* the owner can share again */ }
}

function workerTransport(server, room, token) {
  const owner = sdk();
  return new WorkerTransport({ call: (op, input) => call(owner, server, { ...input, op }), room, token });
}

/**
 * Join a shared document from a link before its editor opens: the room's
 * state and the file it started from. Resolves { client, base, name, link }.
 */
export async function joinRoom(link, user) {
  const transport = link.local ? new BroadcastRoom(link.room, { role: link.role || 'editor' }) : workerTransport(link.server, link.room, link.token);
  const client = new CollabClient({ transport, user, room: link.room, sendDelay: link.local ? 30 : 150 });
  const joined = await client.connect();
  let base = joined.base || null;
  // Joined but unable to open: leave again, or the room keeps being synchronized for an editor that never opened.
  try { if (!base && !link.local) base = decode((await call(sdk(), link.server, { op: 'base', room: link.room })).base); }
  catch (error) { await client.close().catch(() => {}); throw error; }
  return { client, base, name: joined.name || 'Shared document', link, role: client.role, ownerName: joined.ownerName };
}

export class LiveSession extends EventTarget {
  /**
   * engine: the open CanvasEditor; doc: its Doc (saving); client: a connected
   * CollabClient; link: the room's link; onApplied: others' changes were shown.
   */
  constructor({ engine, doc, client, link, user, baseAssets, commentGuard = null, onApplied = () => {}, onError = () => {} }) {
    super();
    this.commentGuard = commentGuard;
    this.engine = engine; this.doc = doc; this.client = client; this.link = link; this.user = user;
    this.onError = onError;
    this.binding = new CollabBinding({ engine, ydoc: client.ydoc, session: { id: client.session, name: user.name }, baseAssets,
      onApplied: () => { if (this.saves) doc.changed(); this.paintPresence(); onApplied(); }, onError });
    client.attach(this.binding);
    this.invites = new Map();
    this.listen();
  }

  get role() { return this.client.role; }
  get local() { return !!this.link.local; }
  get status() { return this.client.status; }
  get pending() { return this.client.outbox.size; }
  get canManage() { return canManage(this.role) || (this.local && this.role === 'owner'); }

  listen() {
    const { client, binding, engine } = this;
    this.binding.apply();
    this.applyRole();
    client.addEventListener('presence', () => { this.elect(); this.paintPresence(); this.dispatchEvent(new Event('people')); });
    client.addEventListener('status', () => this.dispatchEvent(new Event('status')));
    client.addEventListener('role', () => { this.applyRole(); this.dispatchEvent(new Event('role')); });
    client.addEventListener('refused', e => this.onError(new Error(`${e.detail.message} Your latest changes could not be shared.`)));
    client.addEventListener('closed', e => { this.end(e.detail.reason); });
    for (const name of ['mode', 'single', 'conflict']) binding.addEventListener(name, e => this.dispatchEvent(new CustomEvent(name, { detail: e.detail })));
    // Carets and selections: publish ours as it moves, paint others' over the pages.
    const previousSelection = engine.onSelection, previousChange = engine.onChange;
    engine.onSelection = (...args) => { previousSelection?.(...args); this.publishPresence(); };
    engine.onChange = (...args) => { previousChange?.(...args); this.publishPresence(); };
    this.restoreHooks = () => { engine.onSelection = previousSelection; engine.onChange = previousChange; };
    this.overlay = (ctx, pageIndex) => this.drawCarets(ctx, pageIndex);
    engine.overlays.push(this.overlay);
    this.elect();
    this.publishPresence(true);
    // Presence lapses without a renewal; renew it while the document is open.
    this.renew = setInterval(() => this.publishPresence(true), 8000);
  }

  /**
   * Viewers see the document read-only; commenters run the Review tab's protection guard in
   * comments mode (given as `commentGuard`), which refuses every change but comments.
   */
  applyRole() {
    this.binding.setRole(this.role, { commentGuard: this.commentGuard });
    this.elect();
  }

  /** Whether this tab writes the file: an owner's tab with the file, the lowest session among them. */
  elect() {
    const mayWrite = !this.local && this.role === 'owner' && !!this.doc.path;
    let saves = mayWrite;
    if (mayWrite) for (const person of this.client.roster) if (person.saves && person.session < this.client.session) saves = false;
    if (this.saves !== saves) {
      this.saves = saves;
      // Local sharing has no file: each tab keeps its own download, as before sharing.
      if (!this.local) { this.doc.setSaving?.(saves); if (saves) this.doc.changed?.(); }
      this.dispatchEvent(new Event('saver'));
    }
  }

  publishPresence(now = false) {
    if (this.ended) return;
    const send = () => { this.presenceTimer = null; this.client.setPresence({ ...this.binding.localPresence(), saves: !this.local && this.role === 'owner' && !!this.doc.path }); };
    if (now) { clearTimeout(this.presenceTimer); send(); return; }
    if (!this.presenceTimer) this.presenceTimer = setTimeout(send, 80);
  }

  /** Everyone here: { session, name, color, role, me, anchor, focus }. */
  people() { return this.client.people(); }

  /** Others' carets and selections as model positions. */
  remoteSelections() {
    const out = [];
    for (const person of this.client.roster) {
      const at = this.binding.resolve(person);
      if (at) out.push({ ...person, ...at });
    }
    return out;
  }

  paintPresence() {
    const engine = this.engine;
    if (this.ended || engine.destroyed) return;
    const tints = this.remoteSelections().filter(p => p.anchor !== p.focus).map(p => ({ start: Math.min(p.anchor, p.focus), end: Math.max(p.anchor, p.focus), fill: hexToRgba(p.color || '#1e5aa8', 0.22) }));
    engine.setRangeTints?.(tints, 'collab');
    engine.paint();
  }

  /** A remote caret: a bar in the person's color with their name on a flag above it. */
  drawCarets(ctx, pageIndex) {
    const engine = this.engine;
    for (const person of this.remoteSelections()) {
      const geometry = engine.positionGeometry?.(person.focus);
      if (!geometry || geometry.page !== pageIndex) continue;
      const zoom = engine.zoom || 1;
      const x = (geometry.left - geometry.pageLeft) / zoom, y = (geometry.top - geometry.pageTop) / zoom, height = geometry.height / zoom;
      ctx.save();
      ctx.fillStyle = person.color || '#1e5aa8';
      ctx.fillRect(x - 0.75, y, 1.5, height);
      const label = String(person.name || 'Someone').slice(0, 24);
      ctx.font = '600 8px system-ui, sans-serif';
      const width = ctx.measureText(label).width + 6;
      ctx.fillRect(x - 0.75, y - 10, width, 10);
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + 2.25, y - 5);
      ctx.restore();
    }
  }

  /** Move to someone's caret. */
  follow(session) {
    const person = this.remoteSelections().find(p => p.session === session);
    if (!person) return false;
    const engine = this.engine;
    if (engine.session.path !== null) engine.editStory?.(null);
    engine.model.select(person.focus, person.focus);
    engine.syncInput?.(); engine.paint(); engine.revealCaret?.(); engine.onSelection?.();
    return true;
  }

  /* ---------- Access ---------- */

  async members() {
    if (this.local) return { members: this.people().map(p => ({ uuid: p.user || p.session, username: p.name, role: p.role })), named: [], invites: 0 };
    return call(sdk(), this.link.server, { op: 'members', room: this.link.room });
  }
  async inviteUser(username, role) {
    if (this.local) throw new Error('Inviting people needs a document saved to Puter. Local sharing works between tabs of this browser only.');
    return call(sdk(), this.link.server, { op: 'invite-user', room: this.link.room, username, role });
  }
  /** A link that admits whoever opens it with `role` (invitations expire after seven days). */
  async inviteLink(role) {
    if (!INVITE_ROLES.includes(role)) throw new Error('Choose what people with the link can do.');
    // The app's address alone: the sharer's own query parameters (a test user name, Puter's launch details) stay theirs.
    const base = `${location.origin}${location.pathname}`;
    if (this.local) return shareLink(base, { local: true, room: this.link.room, role });
    if (!this.invites.has(role)) this.invites.set(role, call(sdk(), this.link.server, { op: 'invite', room: this.link.room, role }).then(r => r.token));
    let token;
    try { token = await this.invites.get(role); } catch (e) { this.invites.delete(role); throw e; }
    return shareLink(base, { server: this.link.server, room: this.link.room, token });
  }
  async setRole(uuid, role) {
    if (this.local) throw new Error('Roles of local sharing come from the link each tab opened.');
    return call(sdk(), this.link.server, { op: 'role', room: this.link.room, uuid, role });
  }
  async revokeLinks() { this.invites.clear(); if (!this.local) await call(sdk(), this.link.server, { op: 'revoke-invites', room: this.link.room }); }
  async stop() {
    if (this.local) this.client.transport.stop?.();
    else {
      await call(sdk(), this.link.server, { op: 'stop', room: this.link.room });
      await rememberRoom(this.doc.path, null);
    }
    this.end(null);
  }

  /** The session ended: sharing stopped, access removed, or the editor closed. */
  end(reason) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.renew); clearTimeout(this.presenceTimer);
    this.restoreHooks?.();
    const at = this.engine.overlays?.indexOf(this.overlay) ?? -1;
    if (at >= 0) this.engine.overlays.splice(at, 1);
    this.engine.setRangeTints?.([], 'collab');
    this.binding.destroy();
    this.client.close(reason).catch(() => {});
    // A tab that did not write the file keeps the document as a copy of its own from here on: edits made in it
    // from now on are its own to save (or to download, between tabs of a browser), and leaving warns about them.
    if (!this.saves) this.doc.setSaving?.(true);
    this.dispatchEvent(new CustomEvent('ended', { detail: { reason } }));
  }
  destroy() { this.end(null); }
}

/**
 * Start sharing the open document: a new room holding it (on the owner's
 * Puter worker, or between this browser's tabs for a local document).
 */
export async function shareDocument({ engine, doc, user, name, baseBytes, local, progress = () => {} }) {
  const room = randomId(10);
  const state = editorState(engine);
  let transport, link;
  if (local) {
    link = { local: true, room };
  } else {
    const owner = sdk();
    if (!owner) throw new Error('Sharing needs Puter.');
    const server = await deploy(owner, progress);
    link = { server, room };
  }
  // The client's session takes the single-editor lock when the document needs it.
  const placeholder = new CollabClient({ transport: null, user, room });
  const ydoc = createSharedDoc(state);
  const reason = unsupportedReason(state);
  if (reason) ydoc.transact(() => {
    const meta = ydoc.getMap('meta');
    meta.set('mode', 'single'); meta.set('lock', { session: placeholder.session, name: user.name, at: Date.now() }); meta.set('snapshot', JSON.stringify(state));
  });
  const initial = Y.encodeStateAsUpdate(ydoc);
  if (local) transport = new BroadcastRoom(room, { role: 'owner', initial, base: baseBytes, name });
  else {
    progress('Sharing the document…');
    await call(sdk(), link.server, { op: 'create', room, name, initial: encode(initial), base: encode(baseBytes) });
    await rememberRoom(doc.path, link);
    transport = workerTransport(link.server, room, null);
  }
  const client = new CollabClient({ transport, user, room, sendDelay: local ? 30 : 150 });
  client.session = placeholder.session;
  await client.connect();
  if (!client.role) client.role = 'owner';
  return { client, link, reason };
}

/** Rejoin the room of a document this account shared before (owner reopening it). */
export async function reconnect(path, user) {
  const saved = await rememberedRoom(path);
  if (!saved?.server || !saved?.room) return null;
  try {
    const transport = workerTransport(saved.server, saved.room, null);
    const client = new CollabClient({ transport, user, room: saved.room, sendDelay: 150 });
    await client.connect();
    return { client, link: saved };
  } catch (error) {
    // Sharing was stopped (or the room is gone): forget it.
    if (error.status === 410 || error.status === 404) await rememberRoom(path, null);
    return null;
  }
}

export { canEdit };

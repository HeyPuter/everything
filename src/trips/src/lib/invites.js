import { invariant } from '../shared/errors.js';
import { isId } from '../shared/ids.js';
import { pool } from '../shared/pool.js';
import { KINDS, WORKER_PATTERN } from '../shared/protocol.js';
import { plainObject } from '../shared/schema/dsl.js';
import { filesEntry } from './store/personal.js';

const MAX_SHARES = 2000;
// Named invite ids are 128-bit hex secrets, like link tokens.
export const INVITE_ID = /^[0-9a-f]{32}$/;
const inviteId = (value) => typeof value === 'string' && INVITE_ID.test(value);
const text = (value, max) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

/** An invite stub is owner-written but still untrusted display data; anything malformed is hidden. */
export function inviteFrom(handle, info, now = Date.now()) {
  if (!plainObject(info) || !inviteId(info.invite) || typeof info.worker !== 'string' || !WORKER_PATTERN.test(info.worker)
    || !isId(info.space) || !KINDS.includes(info.kind) || !['editor', 'viewer'].includes(info.role)
    || !Number.isSafeInteger(info.exp) || info.exp <= now) return null;
  const title = text(info.title, 200);
  if (!title) return null;
  return { handle, invite: info.invite, ref: { w: info.worker, s: info.space, k: info.kind }, title, ownerName: text(info.ownerName, 100) ?? '', role: info.role, exp: info.exp };
}

const PROBES = 6;

/** A `kv.share.received` notice: another user shared part of their KV with this account in this app. */
export const isShareNotice = (event) => event?.notification?.type === 'kv.share.received' || event?.type === 'kv.share.received';
/**
 * Named invites arrive as read shares of `shared:inv:<id>:`. Handle ids already cached in `me:spaces` are not probed.
 * Accept calls `join`; decline asks the worker, then drops the share.
 */
export function createInvites({ puter, api, spaces, knownHandles, now = Date.now }) {
  const known = knownHandles ?? (async () => new Set((await spaces?.list() ?? []).flatMap((entry) => entry.handles ? [entry.handles.read, entry.handles.write] : [])));
  const session = puter.authToken;
  const check = () => invariant(session && puter.authToken === session, 'account_changed', 401);
  async function shares() {
    const items = [];
    let cursor = null;
    do {
      const page = await puter.kv.listShared({ limit: 200, ...(cursor ? { cursor } : {}) });
      check();
      invariant(plainObject(page) && Array.isArray(page.items), 'invalid_list_response', 502);
      items.push(...page.items.filter((item) => plainObject(item) && typeof item.handle === 'string' && item.handle.length <= 256 && item.access === 'read' && item.appUid === puter.appID));
      cursor = typeof page.cursor === 'string' && page.cursor ? page.cursor : null;
    } while (cursor && items.length < MAX_SHARES);
    return items;
  }
  return {
    async list() {
      const skip = await known();
      check();
      const candidates = (await shares()).filter((item) => !skip.has(item.handle));
      const invites = await pool(candidates, PROBES, async (item) => {
        try { return inviteFrom(item.handle, await puter.kv.get('info', { handle: item.handle }), now()); } catch { return null; }
      });
      check();
      return invites.filter(Boolean).sort((a, b) => b.exp - a.exp);
    },
    async accept(invite) {
      invariant(inviteId(invite?.invite), 'invalid_invite');
      const result = await api.call(invite.ref, 'join', { invite: invite.invite });
      check();
      invariant(['owner', 'editor', 'viewer'].includes(result?.role), 'invalid_join_response', 502);
      const handles = plainObject(result.handles) && typeof result.handles.read === 'string' && typeof result.handles.write === 'string'
        ? { read: result.handles.read, write: result.handles.write } : undefined;
      const files = filesEntry(result.files);
      const entry = { ref: invite.ref, role: result.role, title: invite.title, ...(handles ? { handles } : {}), ...(files ? { files } : {}) };
      // Membership is already granted; an index failure is reported, not thrown, so the caller can retry `spaces.upsert(entry)`.
      let indexed = true;
      try { await spaces?.upsert(entry); } catch (error) { if (error.code === 'account_changed') throw error; indexed = false; }
      return { ref: invite.ref, role: result.role, handles, rev: Number.isSafeInteger(result.rev) ? result.rev : 0, indexed, entry };
    },
    async decline(invite) {
      invariant(inviteId(invite?.invite), 'invalid_invite');
      try { await api.call(invite.ref, 'invite.decline', { invite: invite.invite }); check(); return { declined: true }; }
      catch (error) {
        if (error.code === 'account_changed') throw error;
        // The invitee may drop the stub share themselves when the worker cannot answer.
        try { await puter.kv.unshare(invite.handle); } catch (cause) { if (cause?.code !== 'subject_does_not_exist') throw cause; }
        check();
        return { declined: true, local: true };
      }
    },
    /** Calls `onChange` when Puter delivers a `kv.share.received` notice for a share that is not a member handle. */
    async watch(onChange) {
      const subscription = await puter.events.onLocal(`notif:${puter.appID}:app-user`, async ({ event }) => {
        if (!isShareNotice(event)) return;
        const handle = event.notification.handle;
        if (typeof handle === 'string' && (await known().catch(() => new Set())).has(handle)) return;
        onChange();
      });
      return () => { void subscription.off?.(); };
    },
  };
}

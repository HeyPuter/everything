// Vacay sharing over direct KV shares of `vacay:` (data-model §3.4). Each person writes only their own KV; others
// read it through `read` handles and pay for those reads. Owners stay hidden from holders, so names come from the
// sharer's invite record and fused peers are confirmed with handle-bound acks.
import { pool } from '../../shared/pool.js';
import { shareLabel } from '../../shared/share-label.js';
import { PREFIX, ackFor, handleHash, parseKey } from './keys.js';
import { NAME_MAX, clampText, cleanIndex, readCompany, readEntry, readInvite, readPlan } from './model.js';
import { getMany } from './store.js';
import { VacayError, errorCode } from './errors.js';

const LIST_MAX = 2000;
const PROBES = 6;
const ORPHAN_MS = 5 * 60_000;
const SUBSCRIPTIONS = 40;

const createdMs = (value) => (typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : typeof value === 'string' ? Date.parse(value) : NaN);

/**
 * `store` is the user's own `createVacayStore`. `knownHandles()` returns handle ids that belong to trips
 * (from `me:spaces`) so they are never probed. `label(name)` is the share label Puter shows the recipient.
 */
export function createVacaySharing({ puter, store, account, knownHandles = async () => new Set(), label = (name) => name, now = Date.now }) {
  const self = { uid: account?.uuid ?? null, name: account?.username ?? '' };
  const state = { available: true, incoming: new Map(), peers: new Map(), notVacay: new Set() };
  const listeners = new Set();
  let queue = Promise.resolve();
  let notifSub = null;
  let closed = false;

  const notify = (change) => { for (const listener of listeners) listener(change); };
  // Sharing mutations run one at a time so records and grants stay in step within a tab.
  const exclusive = (task) => { const run = queue.then(task, task); queue = run.catch(() => {}); return run; };
  const fail = (code, cause) => { throw new VacayError(code, cause); };

  function guard(error) {
    const code = errorCode(error);
    if (code === 'disabled' && state.available) { state.available = false; notify({ type: 'available' }); }
    return code;
  }
  // Public methods reject with a VacayError whose `code` the view translates.
  const rethrow = (error) => { const code = guard(error); throw error instanceof VacayError ? error : new VacayError(code, error); };

  /** `{items, complete}`; `complete` is false when the listing stopped at the cap. */
  async function listAll(method) {
    const items = [];
    let cursor = null;
    do {
      const page = await puter.kv[method]({ limit: 200, ...(cursor ? { cursor } : {}) });
      if (!page || !Array.isArray(page.items)) fail('failed');
      items.push(...page.items.filter((item) => item && typeof item.handle === 'string' && item.handle.length <= 256));
      cursor = typeof page.cursor === 'string' && page.cursor ? page.cursor : null;
    } while (cursor && items.length < LIST_MAX);
    return { items, complete: !cursor };
  }

  async function unshareQuiet(handle) {
    try { await puter.kv.unshare(handle); } catch (error) { if (errorCode(error) !== 'gone') throw error; }
  }

  // Puter names a grant's holder by username; the uuid is known once we shared by uid or a fused reply was linked.
  const grantFor = (uid, mode) => (uid ? Object.entries(store.state.grants).find(([, grant]) => grant.uid === uid && (!mode || grant.mode === mode)) : null) ?? null;

  /** Our fused grant to the writer of `ack` (read through `handle`): by uuid, else the unlinked grant the ack proves. */
  async function fusedGrant(uid, ack, handle) {
    const known = grantFor(uid, 'fused');
    if (known || !ack) return known;
    for (const entry of Object.entries(store.state.grants)) if (entry[1].mode === 'fused' && !entry[1].uid && ack === await ackFor(entry[1].handle, handle)) return entry;
    return null;
  }

  /** Asks for the `kvShare` consent on `vacay:` (no prompt once granted). */
  async function consent() {
    if (typeof puter.perms?.request !== 'function') return;
    if (!(await puter.perms.request('kvShare', { prefix: PREFIX, access: 'read' }))) fail('consent');
  }

  function peerFrom(hash, share, previous) {
    return previous ?? {
      h: hash, handle: share.handle, mode: share.mode, name: share.name ?? '', uid: share.uid ?? null, color: share.color ?? null,
      status: 'loading', verified: null, upgrade: false, plan: null, inv: null,
      entries: new Map(), company: new Map(), stamps: { e: {}, company: {} }, sub: null,
    };
  }

  /** Keeps `state.peers` in step with the accepted shares in `vacay:shares`. */
  function syncPeers() {
    const next = new Map();
    for (const [hash, share] of Object.entries(store.state.shares)) {
      const peer = peerFrom(hash, share, state.peers.get(hash));
      Object.assign(peer, { mode: share.mode, name: share.name ?? peer.name, uid: share.uid ?? peer.uid, color: share.color ?? null });
      next.set(hash, peer);
    }
    for (const [hash, peer] of state.peers) if (!next.has(hash)) { void peer.sub?.off?.(); peer.sub = null; }
    state.peers = next;
  }

  async function verify(peer) {
    peer.upgrade = peer.mode === 'view' && peer.inv?.mode === 'fused';
    if (peer.mode !== 'fused') { peer.verified = null; return; }
    const found = await fusedGrant(peer.uid, peer.inv?.ack, peer.handle);
    if (!found) { peer.verified = 'unlinked'; return; }
    if (!peer.inv?.ack) { peer.verified = 'pending'; return; }
    const expected = await ackFor(found[1].handle, peer.handle);
    peer.verified = peer.inv.ack === expected && (!peer.inv.uid || peer.inv.uid === peer.uid) ? 'yes' : 'mismatch';
  }

  async function dropGrant(hash, grant) {
    await unshareQuiet(grant.handle);
    if (store.state.invites.has(hash)) await store.setInvite(hash, null);
    if (store.state.grants[hash]) await store.setGrant(hash, null);
  }

  /** Ends a fusion from this side: our grant to `uid` and every share we hold from them. */
  async function dissolve(uid) {
    for (const [hash, grant] of Object.entries(store.state.grants)) if (grant.uid === uid && grant.mode === 'fused') await dropGrant(hash, grant);
    for (const [hash, share] of Object.entries(store.state.shares)) {
      if (share.uid !== uid || share.mode !== 'fused') continue;
      await unshareQuiet(share.handle);
      await store.setShare(hash, null);
    }
    syncPeers();
  }

  async function peerGone(peer) {
    if (peer.mode === 'fused' && peer.uid) await dissolve(peer.uid);
    else if (store.state.shares[peer.h]) await store.setShare(peer.h, null);
    syncPeers();
    notify({ type: 'gone', name: peer.name });
  }

  /** Reads one peer's plan, index and the entries and company days in `range` that changed since the last read. */
  async function loadPeer(peer, range) {
    const options = { handle: peer.handle };
    try {
      const [plan, index, invite] = await puter.kv.get(['plan', 'idx', `inv:${peer.h}`], options);
      peer.plan = readPlan(plan) ?? peer.plan;
      peer.inv = readInvite(invite);
      const stamps = cleanIndex(index);
      const wanted = [];
      for (const group of ['e', 'company']) {
        const map = group === 'e' ? peer.entries : peer.company;
        for (const id of Object.keys(peer.stamps[group])) if (!Object.hasOwn(stamps[group], id)) { delete peer.stamps[group][id]; map.delete(id); }
        for (const [id, at] of Object.entries(stamps[group])) if (id >= range.start && id <= range.end && peer.stamps[group][id] !== at) wanted.push([group, id, at]);
      }
      const values = await getMany(puter, wanted.map(([group, id]) => `${group}:${id}`), options);
      wanted.forEach(([group, id, at], position) => {
        const map = group === 'e' ? peer.entries : peer.company;
        const value = (group === 'e' ? readEntry : readCompany)(values[position]);
        peer.stamps[group][id] = at;
        if (value) map.set(id, value); else map.delete(id);
      });
      peer.status = 'ok';
      await verify(peer);
    } catch (error) {
      const code = guard(error);
      if (code === 'gone') { await exclusive(() => peerGone(peer)).catch(() => {}); return; }
      peer.status = code;
    }
    notify({ type: 'peer', h: peer.h });
  }

  function onPeerEvent(peer, event, range) {
    if (!state.peers.has(peer.h) || !event) return;
    if (event.op === 'gap' || (event.op !== 'del' && event.value === undefined)) { void loadPeer(peer, range()); return; }
    const value = event.op === 'del' ? null : event.value;
    if (event.key === 'plan') { peer.plan = readPlan(value) ?? peer.plan; notify({ type: 'peer', h: peer.h }); return; }
    if (event.key === `inv:${peer.h}`) { peer.inv = readInvite(value); void verify(peer).then(() => notify({ type: 'peer', h: peer.h })); return; }
    const parsed = parseKey(event.key ?? '');
    if (!parsed || !['e', 'company'].includes(parsed.group)) return;
    const map = parsed.group === 'e' ? peer.entries : peer.company;
    const read = (parsed.group === 'e' ? readEntry : readCompany)(value);
    // The stamp is unknown here, so the next poll re-reads this key once.
    delete peer.stamps[parsed.group][parsed.id];
    if (read) map.set(parsed.id, read); else map.delete(parsed.id);
    notify({ type: 'peer', h: peer.h, live: true });
  }

  async function watchPeer(peer, range) {
    if (peer.sub || closed || [...state.peers.values()].filter((item) => item.sub).length >= SUBSCRIPTIONS) return;
    try {
      const sub = await puter.events.onLocal(`kv:${peer.handle}:*`, ({ event }) => onPeerEvent(peer, event, range), { includeValue: true });
      if (closed || !state.peers.has(peer.h)) { void sub.off?.(); return; }
      peer.sub = sub;
    } catch (error) { guard(error); }
  }

  /** Finds Vacay shares among the handles this user holds. Fused replies to our own invites are linked at once. */
  async function discover() {
    try {
      const known = await knownHandles();
      const accepted = new Set(Object.values(store.state.shares).map((share) => share.handle));
      const items = (await listAll('listShared')).items.filter((item) => item.access === 'read' && item.appUid === puter.appID
        && !known.has(item.handle) && !accepted.has(item.handle) && !state.notVacay.has(item.handle));
      const found = new Map();
      await pool(items, PROBES, async (item) => {
        try {
          const hash = await handleHash(item.handle);
          const [plan, invite] = await puter.kv.get(['plan', `inv:${hash}`], { handle: item.handle });
          if (!readPlan(plan)) { state.notVacay.add(item.handle); return; }
          const record = readInvite(invite);
          found.set(hash, {
            h: hash, handle: item.handle, mode: record?.mode ?? 'view', uid: record?.uid ?? null, ack: record?.ack ?? null, complete: Boolean(record),
            name: record?.name || clampText(item.label, NAME_MAX), at: createdMs(item.createdAt) || now(), plan: readPlan(plan),
          });
        } catch (error) {
          const code = guard(error);
          if (code === 'disabled') throw error;
          // Watch-only handles belong to other features; Vacay shares are always `read`.
          if (code === 'denied') state.notVacay.add(item.handle);
        }
      });
      for (const invite of [...found.values()]) {
        if (invite.mode !== 'fused' || !invite.uid || !invite.ack) continue;
        const grant = await fusedGrant(invite.uid, invite.ack, invite.handle);
        if (grant && invite.ack === await ackFor(grant[1].handle, invite.handle)) {
          await exclusive(() => link(invite, grant));
          found.delete(invite.h);
        }
      }
      state.incoming = found;
      syncPeers();
      notify({ type: 'incoming' });
    } catch (error) { rethrow(error); }
  }

  // A fused share back from someone we invited: accept it and confirm our side with an ack.
  async function link(invite, [grantHash, grant]) {
    // The name we typed was resolved by Puter; the one in their record is only a claim.
    await store.setShare(invite.h, { handle: invite.handle, mode: 'fused', name: grant.name || invite.name, uid: invite.uid, at: now() });
    const mine = store.state.invites.get(grantHash) ?? { mode: 'fused', name: self.name, uid: self.uid, at: now() };
    await store.setInvite(grantHash, { ...mine, mode: 'fused', ack: await ackFor(invite.handle, grant.handle) });
    // The ack proved who holds our grant, so its uuid is now known.
    if (!grant.uid) await store.setGrant(grantHash, { ...grant, uid: invite.uid });
    syncPeers();
  }

  /** Cleans up grants their holder dropped or that were revoked elsewhere; returns `[{type: 'left'|'revoked', name}]`. */
  async function reconcile() {
    const events = [];
    try {
      const listing = await listAll('listSharedByMe');
      const mine = listing.items.filter((item) => item.prefix === PREFIX);
      const live = new Map(mine.filter((item) => !item.revokedAt).map((item) => [item.handle, item]));
      await exclusive(async () => {
        for (const [hash, grant] of Object.entries(store.state.grants)) {
          if (live.has(grant.handle)) continue;
          const record = mine.find((item) => item.handle === grant.handle);
          // Absence only counts in a complete listing; a capped one needs the revocation itself.
          if (!record && !listing.complete) continue;
          if (grant.mode === 'fused' && grant.uid) await dissolve(grant.uid); else await dropGrant(hash, grant);
          events.push({ type: record?.revokedBy === 'holder' ? 'left' : 'revoked', name: grant.name ?? '' });
        }
        const recorded = new Set(Object.values(store.state.grants).map((grant) => grant.handle));
        for (const item of live.values()) {
          const age = now() - createdMs(item.createdAt);
          if (!recorded.has(item.handle) && age > ORPHAN_MS) await unshareQuiet(item.handle);
        }
        for (const hash of [...store.state.invites.keys()]) if (!store.state.grants[hash]) await store.setInvite(hash, null);
      });
    } catch (error) { rethrow(error); }
    syncPeers();
    if (events.length) notify({ type: 'grants', events });
    return events;
  }

  async function shareTo(recipient) {
    await consent();
    let share;
    try { share = await puter.kv.share({ prefix: PREFIX, recipient, access: 'read', label: shareLabel(label(self.name)) }); } catch (error) {
      // An unknown user and an unknown handle share one platform code; here it can only be the user.
      if ((error?.code ?? error?.error?.code) === 'subject_does_not_exist') fail('noUser', error);
      throw error;
    }
    if (typeof share?.handle !== 'string' || typeof share.holder !== 'string') fail('failed');
    return share;
  }

  return {
    state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    discover,
    reconcile,
    syncPeers,
    loadPeer,
    watchPeer,
    /** Reads every peer, four at a time. */
    async poll(range) {
      syncPeers();
      await pool([...state.peers.values()], 4, (peer) => loadPeer(peer, range));
    },
    /** Shares `vacay:` with a Puter username as `fused` (plan together) or `view` (read-only overlay). */
    invite({ username, mode }) {
      return exclusive(async () => {
        const name = String(username ?? '').trim().replace(/^@/, '');
        if (!name || name.length > 64) fail('noUser');
        if (name.includes('@')) fail('recipient');
        if (!['fused', 'view'].includes(mode)) fail('failed');
        if (name.toLowerCase() === self.name.toLowerCase()) fail('self');
        const existing = Object.entries(store.state.grants).find(([, grant]) => grant.name?.toLowerCase() === name.toLowerCase());
        if (existing && (existing[1].mode === mode || existing[1].mode === 'fused')) fail('already');
        try {
          const share = await shareTo(name);
          const hash = await handleHash(share.handle);
          try {
            // An incoming plan-together invite from the person Puter just resolved; its uuid is their own claim, as on accept.
            const reply = mode === 'fused' ? [...state.incoming.values()].find((invite) => invite.mode === 'fused' && invite.uid && invite.name?.toLowerCase() === share.holder.toLowerCase()) : null;
            await store.setGrant(hash, { handle: share.handle, holder: share.holder, ...(reply ? { uid: reply.uid } : existing?.[1].uid ? { uid: existing[1].uid } : {}), mode, name, at: now() });
            await store.setInvite(hash, { mode, name: self.name, uid: self.uid, at: now(), ...(reply ? { ack: await ackFor(reply.handle, share.handle) } : {}) });
            // They had already invited us to plan together: accept theirs too.
            if (reply) {
              await store.setShare(reply.h, { handle: reply.handle, mode: 'fused', name, uid: reply.uid, at: now() });
              state.incoming.delete(reply.h);
            }
          } catch (error) {
            if (!existing) await unshareQuiet(share.handle).catch(() => {});
            await store.setGrant(hash, existing ? { ...existing[1] } : null).catch(() => {});
            throw error;
          }
          syncPeers();
          notify({ type: 'grants' });
          return { h: hash, holder: share.holder };
        } catch (error) { rethrow(error); }
      });
    },
    /** Accepts an incoming share; a fused invite shares `vacay:` back to the inviter's uid. */
    accept(hash) {
      return exclusive(async () => {
        const invite = state.incoming.get(hash) ?? (state.peers.get(hash)?.upgrade ? { ...state.peers.get(hash), mode: 'fused', uid: state.peers.get(hash).inv?.uid ?? state.peers.get(hash).uid } : null);
        if (!invite) fail('gone');
        try {
          if (invite.mode === 'fused') {
            if (!invite.uid || invite.uid === self.uid) fail('failed');
            const back = await shareTo({ uid: invite.uid });
            const backHash = await handleHash(back.handle);
            try {
              await store.setGrant(backHash, { handle: back.handle, holder: back.holder, uid: invite.uid, mode: 'fused', name: invite.name || '', at: now() });
              await store.setInvite(backHash, { mode: 'fused', name: self.name, uid: self.uid, at: now(), ack: await ackFor(invite.handle, back.handle) });
            } catch (error) {
              await unshareQuiet(back.handle).catch(() => {});
              await store.setGrant(backHash, null).catch(() => {});
              throw error;
            }
          }
          await store.setShare(hash, { handle: invite.handle, mode: invite.mode, name: invite.name || '', ...(invite.uid ? { uid: invite.uid } : {}), ...(invite.color ? { color: invite.color } : {}), at: now() });
          state.incoming.delete(hash);
          syncPeers();
          notify({ type: 'incoming' });
          return state.peers.get(hash);
        } catch (error) { rethrow(error); }
      });
    },
    /** Declines an incoming share by dropping it as its holder. */
    decline(hash) {
      return exclusive(async () => {
        const invite = state.incoming.get(hash);
        if (!invite) return;
        try { await unshareQuiet(invite.handle); } catch (error) { rethrow(error); }
        state.incoming.delete(hash);
        notify({ type: 'incoming' });
      });
    },
    /** Leaves a peer: removes a read-only overlay, or dissolves a fusion in both directions. */
    leave(hash) {
      return exclusive(async () => {
        const share = store.state.shares[hash];
        if (!share) return;
        try {
          if (share.mode === 'fused' && share.uid) await dissolve(share.uid);
          else { await unshareQuiet(share.handle); await store.setShare(hash, null); }
        } catch (error) { rethrow(error); }
        syncPeers();
        notify({ type: 'grants' });
      });
    },
    /** Stops sharing with a holder (or cancels a pending invite); a fused grant dissolves the fusion. */
    revoke(hash) {
      return exclusive(async () => {
        const grant = store.state.grants[hash];
        if (!grant) return;
        try {
          if (grant.mode === 'fused' && grant.uid) await dissolve(grant.uid); else await dropGrant(hash, grant);
        } catch (error) { rethrow(error); }
        syncPeers();
        notify({ type: 'grants' });
      });
    },
    /** Turns a read-only grant into a plan-together invite; the share keeps its handle. */
    upgrade(hash) {
      return exclusive(async () => {
        const grant = store.state.grants[hash];
        if (!grant || grant.mode === 'fused') return;
        try {
          await store.setGrant(hash, { ...grant, mode: 'fused' });
          const record = store.state.invites.get(hash) ?? { name: self.name, uid: self.uid, at: now() };
          await store.setInvite(hash, { ...record, mode: 'fused' });
        } catch (error) { rethrow(error); }
        notify({ type: 'grants' });
      });
    },
    setColor(hash, color) {
      const share = store.state.shares[hash];
      if (!share) return Promise.resolve();
      const next = { ...share };
      if (color) next.color = color; else delete next.color;
      return store.setShare(hash, next).then(() => { syncPeers(); notify({ type: 'peer', h: hash }); });
    },
    /** Calls `onShare` when Puter delivers a `kv.share.received` notice in this app. */
    async watchInvites(onShare) {
      if (notifSub || closed) return;
      try {
        notifSub = await puter.events.onLocal(`notif:${puter.appID}:app-user`, ({ event }) => {
          if (event?.notification?.type === 'kv.share.received' || event?.type === 'kv.share.received') onShare();
        });
        if (closed) { void notifSub.off?.(); notifSub = null; }
      } catch { notifSub = null; }
    },
    close() {
      closed = true;
      listeners.clear();
      void notifSub?.off?.(); notifSub = null;
      for (const peer of state.peers.values()) { void peer.sub?.off?.(); peer.sub = null; }
    },
  };
}

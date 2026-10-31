// Live cursors over `puter.peer`. Each editor serves an invite and publishes it in its own member region
// (`shared:<id>:u:<uuid>:peer`, data-model §1), which only that member (or the owner) can write. A session trusts
// only what arrives on connections it dialed itself: those come from the member whose invite it used. It sends its
// own presence on the connections others dialed to it. Presence is transient and never written to the journey.
import { isId, isUuid } from '../../shared/ids.js';
import { plainObject } from '../../shared/schema/dsl.js';
import { spaceScope } from '../sync/path-a.js';

export const INVITE_FRESH_MS = 5 * 60_000;
const REPUBLISH_MS = 2 * 60_000;
const POLL_MS = 10_000;
const HEARTBEAT_MS = 5_000;
const STALE_MS = 20_000;
const THROTTLE_MS = 80;
const DIAL_TIMEOUT_MS = 12_000;
const MAX_LINKS = 16;
const MAX_MESSAGE = 2048;
const INVITE = /^[\x21-\x7e]{1,512}$/;

const unit = (value) => (Number.isFinite(value) ? Math.min(1.5, Math.max(-0.5, Math.round(value * 10_000) / 10_000)) : null);

/** A published invite, clamped; null when unusable or older than `INVITE_FRESH_MS`. */
export function cleanInvite(value, now = Date.now()) {
  if (!plainObject(value) || value.v !== 1 || typeof value.invite !== 'string' || !INVITE.test(value.invite) || !isId(value.book)) return null;
  if (!Number.isSafeInteger(value.at) || value.at > now + 60_000 || now - value.at > INVITE_FRESH_MS) return null;
  return { invite: value.invite, book: value.book, at: value.at };
}

/** A presence message, clamped: `{page, x, y, sel, drag}`; null when it is not one. */
export function cleanPresence(value) {
  if (!plainObject(value) || value.v !== 1) return null;
  const page = isId(value.page) ? value.page : null;
  const x = unit(value.x);
  const y = unit(value.y);
  const sel = isId(value.sel) ? value.sel : null;
  let drag = null;
  if (plainObject(value.drag) && isId(value.drag.id)) {
    const box = ['x', 'y', 'w', 'h'].map((key) => unit(value.drag[key]));
    if (box.every((item) => item !== null)) drag = { id: value.drag.id, x: box[0], y: box[1], w: Math.max(0, box[2]), h: Math.max(0, box[3]) };
  }
  return { page, x: page && x !== null && y !== null ? x : null, y: page && x !== null && y !== null ? y : null, sel, drag };
}

/**
 * Where invites live: the member's own region through their write handle, the owner's own KV, and everyone's
 * region through the read handle (or the owner's KV) for reading.
 */
export function kvRendezvous({ puter, space: sid, uid, owner = false, handles = null }) {
  if (!isUuid(uid) || !isId(sid)) return null;
  if (!owner && !(handles?.read && handles?.write)) return null;
  const prefix = `shared:${sid}:`;
  const scope = owner ? spaceScope(puter, { prefix }) : spaceScope(puter, { handle: handles.read });
  const own = owner ? `${prefix}u:${uid}:peer` : 'peer';
  const config = owner ? [] : [{ handle: handles.write }];
  return {
    publish: (value) => puter.kv.set(own, value, ...config),
    clear: () => puter.kv.del(own, ...config),
    async read(uids) {
      const list = uids.filter((item) => isUuid(item) && item !== uid).slice(0, 50);
      if (!list.length) return new Map();
      const values = await scope.getMany(list.map((item) => `u:${item}:peer`));
      return new Map(list.map((item, index) => [item, values?.[index] ?? null]));
    },
  };
}

function withTimeout(promise, ms, setTimer, clearTimer) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimer(() => reject(new Error('peer_timeout')), ms); })]).finally(() => clearTimer(timer));
}

/**
 * Presence for one book. `members()` lists member uuids; `onChange()` fires when someone's cursor, page or selection
 * changes or a link comes or goes. `update(partial)` merges this session's own presence and sends it, throttled.
 */
export function createPresence({ peer, rendezvous, uid, book, members = () => [], onChange = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, document = globalThis.document }) {
  const available = typeof peer?.serve === 'function' && typeof peer?.connect === 'function' && Boolean(rendezvous) && isId(book);
  const accepted = new Set();
  const dialed = new Map();
  const remote = new Map();
  let mine = { v: 1, page: null, x: null, y: null, sel: null, drag: null };
  let server = null;
  let stopped = true;
  let serving = null;
  let pollTimer;
  let beatTimer;
  let sendTimer;
  let republishTimer;
  let lastSent = 0;
  let status = available ? 'idle' : 'unavailable';

  const notify = () => { if (!stopped) onChange(); };
  const setStatus = (next) => { if (status !== next) { status = next; notify(); } };
  const text = () => JSON.stringify(mine);

  function sendOn(conn) {
    try { if (conn.connected !== false) conn.send(text()); } catch { /* the link is closing */ }
  }
  function flush() {
    sendTimer = undefined;
    lastSent = now();
    for (const conn of accepted) sendOn(conn);
  }
  function schedule() {
    if (stopped || sendTimer !== undefined) return;
    const wait = Math.max(0, lastSent + THROTTLE_MS - now());
    sendTimer = setTimer(flush, wait);
  }

  function accept(conn) {
    if (!conn || stopped || accepted.size >= MAX_LINKS) { try { conn?.close(); } catch { /* gone */ } return; }
    accepted.add(conn);
    const drop = () => { accepted.delete(conn); };
    conn.addEventListener?.('open', () => sendOn(conn));
    conn.addEventListener?.('close', drop);
    conn.addEventListener?.('error', drop);
    if (conn.connected) sendOn(conn);
  }

  async function publish() {
    clearTimer(republishTimer);
    if (stopped || !server?.inviteCode) return;
    try { await rendezvous.publish({ v: 1, invite: server.inviteCode, book, at: now() }); } catch { /* the next refresh retries */ }
    if (!stopped) republishTimer = setTimer(() => { void publish(); }, REPUBLISH_MS);
  }

  async function serve() {
    if (stopped || server || serving) return serving;
    serving = (async () => {
      try {
        const next = await withTimeout(Promise.resolve(peer.serve()), DIAL_TIMEOUT_MS, setTimer, clearTimer);
        if (stopped) { try { next?.close?.(); } catch { /* closed */ } return; }
        server = next;
        server.addEventListener?.('connection', (event) => accept(event?.conn));
        server.addEventListener?.('reconnect', () => { void publish(); });
        server.addEventListener?.('close', () => { if (server === next) { server = null; setStatus('idle'); } });
        setStatus('live');
        await publish();
      } catch { setStatus('failed'); } finally { serving = null; }
    })();
    return serving;
  }

  function forget(member, conn) {
    const link = dialed.get(member);
    if (link?.conn === conn || (!conn && link)) { dialed.delete(member); if (remote.delete(member)) notify(); }
  }

  async function dial(member, invite) {
    const link = { invite, conn: null };
    dialed.set(member, link);
    try {
      const conn = await withTimeout(Promise.resolve(peer.connect(invite)), DIAL_TIMEOUT_MS, setTimer, clearTimer);
      if (stopped || dialed.get(member) !== link) { try { conn?.close?.(); } catch { /* closed */ } return; }
      link.conn = conn;
      conn.addEventListener?.('message', (event) => {
        if (stopped || dialed.get(member)?.conn !== conn || typeof event?.data !== 'string' || event.data.length > MAX_MESSAGE) return;
        let value;
        try { value = cleanPresence(JSON.parse(event.data)); } catch { return; }
        if (!value) return;
        remote.set(member, { ...value, uid: member, at: now() });
        notify();
      });
      conn.addEventListener?.('close', () => forget(member, conn));
      conn.addEventListener?.('error', () => { try { conn.close(); } catch { /* closed */ } forget(member, conn); });
    } catch { if (dialed.get(member) === link) dialed.delete(member); }
  }

  async function poll() {
    clearTimer(pollTimer);
    if (stopped) return;
    if (!document?.hidden) {
      if (!server) await serve();
      try {
        const invites = await rendezvous.read(members().filter((member) => member !== uid));
        for (const [member, value] of invites) {
          const invite = cleanInvite(value, now());
          const link = dialed.get(member);
          if (!invite || invite.book !== book) { if (link) { try { link.conn?.close?.(); } catch { /* closed */ } forget(member); } continue; }
          if (link?.invite === invite.invite) continue;
          if (link) { try { link.conn?.close?.(); } catch { /* closed */ } forget(member); }
          if (dialed.size < MAX_LINKS) void dial(member, invite.invite);
        }
      } catch { /* KV unavailable: try again on the next poll */ }
    }
    if (!stopped) pollTimer = setTimer(() => { void poll(); }, POLL_MS);
  }

  function beat() {
    clearTimer(beatTimer);
    if (stopped) return;
    flush();
    let changed = false;
    for (const [member, value] of remote) if (now() - value.at > STALE_MS) { remote.delete(member); changed = true; }
    if (changed) notify();
    beatTimer = setTimer(beat, HEARTBEAT_MS);
  }

  const visibility = () => { if (!document?.hidden && !stopped) void poll(); };

  return {
    available,
    get status() { return status; },
    /** Live peers with their latest presence. */
    peers: () => [...remote.values()].filter((value) => now() - value.at <= STALE_MS),
    /** Members this session is linked to either way. */
    get links() { return dialed.size + accepted.size; },
    start() {
      if (!available || !stopped) return;
      stopped = false;
      document?.addEventListener?.('visibilitychange', visibility);
      void poll();
      beatTimer = setTimer(beat, HEARTBEAT_MS);
    },
    update(partial) {
      const next = cleanPresence({ ...mine, ...partial, v: 1 });
      if (!next) return;
      const value = { v: 1, ...next };
      if (JSON.stringify(value) === JSON.stringify(mine)) return;
      mine = value;
      schedule();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const timer of [pollTimer, beatTimer, sendTimer, republishTimer]) clearTimer(timer);
      sendTimer = undefined;
      document?.removeEventListener?.('visibilitychange', visibility);
      for (const conn of accepted) { try { conn.close(); } catch { /* closed */ } }
      for (const link of dialed.values()) { try { link.conn?.close?.(); } catch { /* closed */ } }
      accepted.clear(); dialed.clear(); remote.clear();
      const served = server;
      server = null;
      try { served?.close?.(); } catch { /* closed */ }
      if (served) void Promise.resolve().then(() => rendezvous.clear()).catch(() => {});
    },
  };
}

/**
 * Live peer links between the people in a shared workbook, over Puter's WebRTC peer service
 * (puter.peer.serve / connect). Every link proves its identity with a ticket the room's worker signed and a
 * challenge signed with the session's own key, bound to the connection's transport certificates; every packet
 * is signed by its sender. Rooms of up to eight sessions form a full mesh, larger ones relay through two
 * sessions per group (see topology). Adapted from the Whiteboard app's peer network in this repository.
 *
 * The links carry what must be quick and need not last: where each person is (their sheet and selection),
 * and a notice, with the change itself when it is small, as soon as the worker accepted a change.
 */

import { PROTOCOL, sign, topology, verify } from './protocol.js';

function fingerprints(description) {
  const found = description?.sdp?.match(/^a=fingerprint:.+$/gim) ?? [];
  return [...new Set(found.map((line) => line.trim().toLowerCase()))].sort();
}
const binding = (conn) => ({ local: fingerprints(conn.peerconnection?.localDescription), remote: fingerprints(conn.peerconnection?.remoteDescription) });

let lastSequence = 0;
const nextSequence = () => (lastSequence = Math.max(lastSequence + 1, Date.now()));

export class PeerNetwork {
  /**
   * o: { peer, session, keys, roomKey, room, receive(kind, data, ticket) → false to refuse relaying,
   * changed() (the advertised invite changed), linked() (links came or went), stranger() (an unknown member dialed), now }
   */
  constructor(o) {
    this.o = o;
    this.links = new Map();
    this.connections = new Set();
    this.roster = [];
    this.ticket = null;
    this.signature = null;
    this.server = null;
    this.closed = false;
    this.serving = false;
    this.wanted = new Set();
    this.relays = new Set();
    this.seen = new Set();
    this.verified = new Set();
    this.retry = setInterval(() => this.reconcile(), 5000);
  }

  now() { return this.o.now?.() ?? Date.now(); }
  get invite() { return this.server?.inviteCode ?? null; }
  /** Sessions with an authorized link. */
  get connectedSessions() {
    return [...this.links.entries()].filter(([, l]) => l.ssAuthorized && l.connected !== false).map(([id]) => id);
  }

  async serve() {
    if (this.closed || this.serving || this.server) return;
    this.serving = true;
    try {
      const server = await Promise.race([this.o.peer.serve(), new Promise((_, reject) => setTimeout(() => reject(new Error('Peer service timed out.')), 12000))]);
      if (this.closed) { server.close(); return; }
      this.server = server;
      server.addEventListener('connection', (e) => this.attach(e.conn));
      server.addEventListener('close', () => { if (this.server !== server) return; this.server = null; this.o.changed?.(); });
      server.addEventListener('reconnect', () => this.o.changed?.());
    } finally {
      this.serving = false;
    }
  }

  update(ticket, signature, roster) {
    this.ticket = ticket;
    this.signature = signature;
    this.roster = roster;
    const plan = topology(roster);
    this.wanted = plan.edges.get(ticket.session) ?? new Set();
    this.relays = plan.relays;
    this.reconcile();
    clearTimeout(this.again);
    this.again = setTimeout(() => this.reconcile(), 1000);
  }

  reconcile() {
    if (this.closed || !this.ticket) return;
    if (!this.server && !this.serving) this.serve().then(() => this.server && this.o.changed?.()).catch(() => {});
    for (const [id, link] of this.links) if (!this.wanted.has(id)) { link.close(); this.links.delete(id); }
    for (const peer of this.roster) {
      // The session with the greater ID dials, so each pair links once.
      if (!this.wanted.has(peer.session) || peer.session < this.o.session || !peer.invite || this.links.has(peer.session)) continue;
      const pending = { close() {} };
      this.links.set(peer.session, pending);
      let expired = false;
      const timer = setTimeout(() => { expired = true; if (this.links.get(peer.session) === pending) this.links.delete(peer.session); }, 12000);
      this.o.peer.connect(peer.invite).then((conn) => {
        clearTimeout(timer);
        if (expired || this.closed || !this.wanted.has(peer.session)) { conn.close(); return; }
        this.attach(conn, peer.session);
      }).catch(() => {
        clearTimeout(timer);
        if (this.links.get(peer.session) === pending) this.links.delete(peer.session);
      });
    }
  }

  attach(conn, expected) {
    if (!conn || this.closed || this.connections.size >= 64) {
      conn?.close();
      if (expected && this.links.get(expected) && !this.connections.has(this.links.get(expected))) this.links.delete(expected);
      return;
    }
    this.connections.add(conn);
    if (expected) this.links.set(expected, conn);
    let authorized = null, ended = false, alive = Date.now();
    const early = [];
    const challenge = crypto.randomUUID();
    try {
      // Presence travels on an unordered channel without retransmits.
      const soft = conn.peerconnection?.createDataChannel?.('spreadsheet-presence', { negotiated: true, id: 5, ordered: false, maxRetransmits: 0 });
      if (soft) { conn.ssSoft = soft; soft.onmessage = (e) => message(e); }
    } catch { /* Notices still travel on the reliable channel. */ }
    const timeout = setTimeout(() => { if (!authorized) conn.close(); }, 12000);
    const heartbeat = setInterval(() => { if (Date.now() - alive > 25000) conn.close(); else this.sendOn(conn, { challenge }); }, 8000);
    const ask = () => this.sendOn(conn, { challenge });
    conn.addEventListener('open', ask);
    if (conn.connected) ask();
    const close = () => {
      if (ended) return;
      ended = true;
      early.length = 0;
      clearTimeout(timeout);
      clearInterval(heartbeat);
      conn.ssSoft?.close();
      this.connections.delete(conn);
      for (const [id, link] of this.links) if (link === conn) this.links.delete(id);
      if (authorized) this.o.linked?.();
    };
    conn.addEventListener('close', close);
    conn.addEventListener('error', () => { conn.close(); close(); });
    const message = async (event) => {
      try {
        if (ended || this.closed || typeof event.data !== 'string' || event.data.length > 64_000) return;
        const packet = JSON.parse(event.data);
        if (typeof packet.challenge === 'string' && !packet.hello && packet.challenge.length < 100) {
          if (!this.ticket) return;
          const { local, remote } = binding(conn);
          const proof = await sign(this.o.keys.privateKey, { challenge: packet.challenge, session: this.o.session, local, remote });
          if (ended || this.closed) return;
          this.sendOn(conn, { hello: true, challenge: packet.challenge, ticket: this.ticket, signature: this.signature, proof });
          return;
        }
        if (packet.hello) {
          // The other end signed its view of this link: our remote certificate is its local one.
          const { local, remote } = binding(conn);
          if (packet.challenge !== challenge || !(await this.validTicket(packet))
            || !(await verify(packet.ticket.publicKey, { challenge, session: packet.ticket.session, local: remote, remote: local }, packet.proof))
            || (expected && packet.ticket.session !== expected)) { conn.close(); return; }
          if (!this.wanted.has(packet.ticket.session)) {
            // A member who joined after our last check-in: refuse for now and learn the roster.
            conn.close();
            this.o.stranger?.();
            return;
          }
          if (ended || this.closed) return;
          authorized = packet.ticket.session;
          const prior = this.links.get(authorized);
          if (prior && prior !== conn) prior.close();
          this.links.set(authorized, conn);
          conn.ssAuthorized = authorized;
          alive = Date.now();
          for (const waiting of early.splice(0)) message(waiting);
          this.o.linked?.();
          return;
        }
        if (!authorized) { if (packet.body && early.length < 8) early.push(event); return; }
        const key = `${packet.ticket?.session}:${packet.body?.seq}`;
        if (this.seen.has(key)) return;
        if (!(await this.check(packet))) return;
        if (this.closed || this.seen.has(key)) return;
        // Viewers never change the workbook, so notices of their changes are dropped.
        if (packet.body.kind === 'change' && packet.ticket.role === 'viewer') return;
        this.seen.add(key);
        if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value);
        alive = Date.now();
        const taken = await this.o.receive(packet.body.kind, packet.body.data, packet.ticket);
        if (taken !== false && this.relays.has(this.o.session) && this.roster.length > 8) this.fanout(packet, conn);
      } catch { /* Malformed packets are ignored; durable state comes from the worker. */ }
    };
    conn.addEventListener('message', (e) => message(e));
  }

  /** Whether a packet is signed by a current member of this room. */
  async check(packet) {
    try {
      const { body, ticket } = packet;
      return (await this.validTicket(packet)) && body?.v === PROTOCOL && Number.isSafeInteger(body.seq) && (await verify(ticket.publicKey, body, packet.proof));
    } catch {
      return false;
    }
  }

  /** A ticket newer than ours stands on its signature; older ones must match the roster. */
  async validTicket(packet) {
    const t = packet.ticket;
    if (!t || t.room !== this.o.room || !Number.isFinite(t.expires) || t.expires < this.now()
      || (!(this.ticket && t.expires > this.ticket.expires) && !this.roster.some((p) => p.session === t.session && p.user === t.user && p.role === t.role))) return false;
    const key = JSON.stringify(t) + packet.signature;
    if (this.verified.has(key)) return true;
    if (!(await verify(this.o.roomKey, t, packet.signature))) return false;
    if (this.verified.size > 1024) this.verified.clear();
    this.verified.add(key);
    return true;
  }

  sendOn(conn, packet) {
    try {
      if (conn.connected === false || (packet.body && !conn.ssAuthorized)) return;
      const text = JSON.stringify(packet);
      const soft = conn.ssSoft;
      if (packet.body?.kind === 'presence' && soft?.readyState === 'open') {
        // A backed-up channel drops presence; the next sample replaces it.
        if (soft.bufferedAmount < 16384) soft.send(text);
      } else conn.send(text);
    } catch { /* Reconnection repairs the link. */ }
  }

  /** Sign and send a packet to every linked member (relays pass it on). */
  async broadcast(kind, data) {
    if (this.closed || !this.ticket || !this.signature) return;
    const body = { v: PROTOCOL, seq: nextSequence(), kind, data };
    const packet = { ticket: this.ticket, signature: this.signature, body, proof: await sign(this.o.keys.privateKey, body) };
    if (this.closed || JSON.stringify(packet).length > 64_000) return;
    this.seen.add(`${this.o.session}:${body.seq}`);
    this.fanout(packet);
  }

  fanout(packet, except) {
    for (const conn of this.links.values()) if (conn !== except && conn.ssAuthorized) this.sendOn(conn, packet);
  }

  close() {
    this.closed = true;
    clearInterval(this.retry);
    clearTimeout(this.again);
    for (const conn of this.connections) conn.close();
    this.connections.clear();
    this.links.clear();
    this.server?.close();
    this.server = null;
  }
}

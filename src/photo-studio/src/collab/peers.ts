// Live peer links between the people in a shared document, over Puter's
// WebRTC peer service (puter.peer.serve / connect). Every link proves its
// identity with a ticket the room's worker signed and a challenge signed with
// the session's own key, bound to the connection's transport certificates;
// every packet is signed by its sender. Rooms of up to eight sessions form a
// full mesh, larger ones relay through two sessions per group (see topology).
// Adapted from the Whiteboard app's peer network in this repository.
import { PROTOCOL, sign, topology, verify, type Jwk, type KeyPair } from './protocol';

export type Ticket = {
  room: string;
  session: string;
  user: string;
  username: string;
  role: string;
  publicKey: Jwk;
  expires: number;
  invite: string | null;
};
export type PeerPacket = { ticket: Ticket; signature: string; body: { v: number; seq: number; kind: string; data: unknown }; proof: string };

/** The parts of a peer connection this module uses (Puter's or a test fake). */
export interface PeerConnection extends EventTarget {
  connected?: boolean;
  send(data: string): void;
  close(): void;
  peerconnection?: { localDescription?: { sdp?: string } | null; remoteDescription?: { sdp?: string } | null; createDataChannel?: (label: string, options: RTCDataChannelInit) => { readyState: string; bufferedAmount: number; send(d: string): void; close(): void; onmessage?: ((e: { data: unknown }) => void) | null } };
}
export interface PeerServer extends EventTarget {
  inviteCode: string;
  close(): void;
}
export interface PeerApi {
  serve(): Promise<PeerServer>;
  connect(code: string): Promise<PeerConnection>;
}

function fingerprints(description?: { sdp?: string } | null) {
  const found = description?.sdp?.match(/^a=fingerprint:.+$/gim) ?? [];
  return [...new Set(found.map((line) => line.trim().toLowerCase()))].sort();
}
const binding = (conn: PeerConnection) => ({ local: fingerprints(conn.peerconnection?.localDescription), remote: fingerprints(conn.peerconnection?.remoteDescription) });

let lastSequence = 0;
const nextSequence = () => (lastSequence = Math.max(lastSequence + 1, Date.now()));

type Link = PeerConnection & { psAuthorized?: string; psHeard?: number; psSoft?: { readyState: string; bufferedAmount: number; send(d: string): void; close(): void } };

export class PeerNetwork {
  links = new Map<string, Link>();
  connections = new Set<Link>();
  roster: Ticket[] = [];
  ticket?: Ticket;
  signature?: string;
  server?: PeerServer | null;
  closed = false;
  private serving = false;
  private wanted = new Set<string>();
  private relays = new Set<string>();
  private seen = new Set<string>();
  private retry: ReturnType<typeof setInterval>;
  private again?: ReturnType<typeof setTimeout>;
  constructor(
    private o: {
      peer: PeerApi;
      session: string;
      keys: KeyPair;
      roomKey: Jwk;
      room: string;
      // A verified packet from a member; returns false to refuse relaying it.
      receive: (kind: string, data: unknown, ticket: Ticket) => unknown;
      // The advertised invite changed (a new server): check in again.
      changed?: () => void;
      // Links came or went.
      linked?: () => void;
      // A verified member not in our roster tried to link.
      stranger?: () => void;
      now?: () => number;
    },
  ) {
    this.retry = setInterval(() => void this.reconcile(), 5000);
  }
  private now() {
    return this.o.now?.() ?? Date.now();
  }
  get invite() {
    return this.server?.inviteCode ?? null;
  }
  /** Sessions with an authorized link. */
  get connectedSessions() {
    return [...this.links.entries()].filter(([, l]) => l.psAuthorized && l.connected !== false).map(([id]) => id);
  }
  async serve() {
    if (this.closed || this.serving || this.server) return;
    this.serving = true;
    try {
      const server = await Promise.race([
        this.o.peer.serve(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Peer service timed out.')), 12000)),
      ]);
      if (this.closed) {
        server.close();
        return;
      }
      this.server = server;
      server.addEventListener('connection', (e) => this.attach((e as unknown as { conn: PeerConnection }).conn));
      server.addEventListener('close', () => {
        if (this.server !== server) return;
        this.server = null;
        this.o.changed?.();
      });
      server.addEventListener('reconnect', () => this.o.changed?.());
    } finally {
      this.serving = false;
    }
  }
  update(ticket: Ticket, signature: string, roster: Ticket[]) {
    this.ticket = ticket;
    this.signature = signature;
    this.roster = roster;
    const plan = topology(roster);
    this.wanted = plan.edges.get(ticket.session) ?? new Set();
    this.relays = plan.relays;
    void this.reconcile();
    clearTimeout(this.again);
    this.again = setTimeout(() => void this.reconcile(), 1000);
  }
  async reconcile() {
    if (this.closed || !this.ticket) return;
    if (!this.server && !this.serving)
      this.serve()
        .then(() => this.server && this.o.changed?.())
        .catch(() => {});
    for (const [id, link] of this.links)
      if (!this.wanted.has(id)) {
        link.close();
        this.links.delete(id);
      }
    for (const peer of this.roster) {
      // The session with the greater ID dials, so each pair links once.
      if (!this.wanted.has(peer.session) || peer.session < this.o.session || !peer.invite || this.links.has(peer.session)) continue;
      const pending = { close() {} } as unknown as Link;
      this.links.set(peer.session, pending);
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        if (this.links.get(peer.session) === pending) this.links.delete(peer.session);
      }, 12000);
      this.o.peer
        .connect(peer.invite)
        .then((conn) => {
          clearTimeout(timer);
          if (expired || this.closed || !this.wanted.has(peer.session)) {
            conn.close();
            return;
          }
          this.attach(conn, peer.session);
        })
        .catch(() => {
          clearTimeout(timer);
          if (this.links.get(peer.session) === pending) this.links.delete(peer.session);
        });
    }
  }
  private attach(conn: Link, expected?: string) {
    if (!conn || this.closed || this.connections.size >= 64) {
      conn?.close();
      if (expected && this.links.get(expected) && !this.connections.has(this.links.get(expected)!)) this.links.delete(expected);
      return;
    }
    this.connections.add(conn);
    if (expected) this.links.set(expected, conn);
    let authorized: string | null = null,
      ended = false,
      alive = Date.now();
    const early: { data: unknown }[] = [];
    const challenge = crypto.randomUUID();
    try {
      // Presence travels on an unordered channel without retransmits.
      const soft = conn.peerconnection?.createDataChannel?.('photo-studio-presence', { negotiated: true, id: 5, ordered: false, maxRetransmits: 0 });
      if (soft) {
        conn.psSoft = soft;
        soft.onmessage = (e) => void message(e);
      }
    } catch {
      /* Edits still travel on the reliable channel. */
    }
    const timeout = setTimeout(() => {
      if (!authorized) conn.close();
    }, 12000);
    const heartbeat = setInterval(() => {
      if (Date.now() - alive > 25000) conn.close();
      else this.sendOn(conn, { challenge });
    }, 8000);
    const ask = () => this.sendOn(conn, { challenge });
    conn.addEventListener('open', ask);
    if (conn.connected) ask();
    const close = () => {
      if (ended) return;
      ended = true;
      early.length = 0;
      clearTimeout(timeout);
      clearInterval(heartbeat);
      conn.psSoft?.close();
      this.connections.delete(conn);
      for (const [id, link] of this.links) if (link === conn) this.links.delete(id);
      if (authorized) this.o.linked?.();
    };
    conn.addEventListener('close', close);
    conn.addEventListener('error', () => {
      conn.close();
      close();
    });
    const message = async (event: { data: unknown }) => {
      try {
        if (ended || this.closed || typeof event.data !== 'string' || event.data.length > 64_000) return;
        conn.psHeard = Date.now();
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
          if (
            packet.challenge !== challenge ||
            !(await this.validTicket(packet)) ||
            !(await verify(packet.ticket.publicKey, { challenge, session: packet.ticket.session, local: remote, remote: local }, packet.proof)) ||
            (expected && packet.ticket.session !== expected)
          ) {
            conn.close();
            return;
          }
          if (!this.wanted.has(packet.ticket.session)) {
            // A member who joined after our last check-in: refuse for now and
            // learn the roster, so the link forms when they dial again.
            conn.close();
            this.o.stranger?.();
            return;
          }
          if (ended || this.closed) return;
          authorized = packet.ticket.session as string;
          const prior = this.links.get(authorized);
          if (prior && prior !== conn) prior.close();
          this.links.set(authorized, conn);
          conn.psAuthorized = authorized;
          alive = Date.now();
          for (const waiting of early.splice(0)) void message(waiting);
          this.o.linked?.();
          return;
        }
        if (!authorized) {
          if (packet.body && early.length < 8) early.push(event);
          return;
        }
        const key = `${packet.ticket?.session}:${packet.body?.seq}`;
        if (this.seen.has(key)) return;
        if (!(await this.check(packet))) return;
        if (this.closed || this.seen.has(key)) return;
        // Viewers never save edits, so their edits and notices are dropped.
        if (['edit', 'committed'].includes(packet.body.kind) && packet.ticket.role === 'viewer') return;
        this.seen.add(key);
        if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
        alive = Date.now();
        const taken = await this.o.receive(packet.body.kind, packet.body.data, packet.ticket);
        if (taken !== false && this.relays.has(this.o.session) && this.roster.length > 8) this.fanout(packet, conn);
      } catch {
        /* Malformed packets are ignored; durable state comes from the worker. */
      }
    };
    conn.addEventListener('message', (e) => void message(e as unknown as { data: unknown }));
  }
  /** Whether a packet is signed by a current member of this room. */
  private async check(packet: PeerPacket) {
    try {
      const { body, ticket } = packet;
      return (await this.validTicket(packet)) && body?.v === PROTOCOL && Number.isSafeInteger(body.seq) && (await verify(ticket.publicKey, body, packet.proof));
    } catch {
      return false;
    }
  }
  private verified = new Set<string>();
  /** A ticket newer than ours stands on its signature; older ones must match the roster. */
  private async validTicket(packet: { ticket: Ticket; signature: string }) {
    const t = packet.ticket;
    if (
      !t ||
      t.room !== this.o.room ||
      !Number.isFinite(t.expires) ||
      t.expires < this.now() ||
      (!(this.ticket && t.expires > this.ticket.expires) && !this.roster.some((p) => p.session === t.session && p.user === t.user && p.role === t.role))
    )
      return false;
    const key = JSON.stringify(t) + packet.signature;
    if (this.verified.has(key)) return true;
    if (!(await verify(this.o.roomKey, t, packet.signature))) return false;
    if (this.verified.size > 1024) this.verified.clear();
    this.verified.add(key);
    return true;
  }
  private sendOn(conn: Link, packet: unknown) {
    try {
      const p = packet as { body?: { kind: string } };
      if (conn.connected === false || (p.body && !conn.psAuthorized)) return;
      const text = JSON.stringify(packet);
      const soft = conn.psSoft;
      if (p.body?.kind === 'presence' && soft?.readyState === 'open') {
        // A backed-up channel drops presence; the next sample replaces it.
        if (soft.bufferedAmount < 16384) soft.send(text);
      } else conn.send(text);
    } catch {
      /* Reconnection repairs the link. */
    }
  }
  /** Sign and send a packet to every linked member (relays pass it on). */
  async broadcast(kind: string, data: unknown) {
    if (this.closed || !this.ticket || !this.signature) return;
    const body = { v: PROTOCOL, seq: nextSequence(), kind, data };
    const packet: PeerPacket = { ticket: this.ticket, signature: this.signature, body, proof: await sign(this.o.keys.privateKey, body) };
    if (this.closed || JSON.stringify(packet).length > 64_000) return;
    this.seen.add(`${this.o.session}:${body.seq}`);
    this.fanout(packet);
  }
  private fanout(packet: PeerPacket, except?: Link) {
    for (const conn of this.links.values()) if (conn !== except && conn.psAuthorized) this.sendOn(conn, packet);
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

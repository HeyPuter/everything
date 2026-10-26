// A minimal in-memory stand-in for `puter.peer` (serve/connect, data connections), since dev/fake-puter has none.
class Emitter {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event = {}) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event); }
}

class Conn extends Emitter {
  constructor() { super(); this.connected = false; this.other = null; this.sent = []; }
  send(data) {
    if (!this.connected) throw new Error('not_connected');
    this.sent.push(data);
    const other = this.other;
    queueMicrotask(() => { if (other.connected) other.emit('message', { data }); });
  }
  close() {
    if (!this.connected && !this.other?.connected) return;
    for (const end of [this, this.other]) { if (end.connected) { end.connected = false; end.emit('close', {}); } }
  }
}

export function createFakePeerNetwork() {
  const servers = new Map();
  let next = 0;
  const network = {
    servers,
    /** Delivers raw text to the dialing side of every link served by `invite` (as if that server sent it). */
    inject(invite, data) { for (const conn of servers.get(invite)?.conns ?? []) conn.other?.emit('message', { data }); },
    peer(name) {
      return {
        async serve() {
          const server = Object.assign(new Emitter(), { inviteCode: `inv-${name}-${++next}`, conns: new Set(), closed: false });
          server.close = () => { server.closed = true; servers.delete(server.inviteCode); for (const conn of server.conns) conn.close(); server.emit('close', {}); };
          servers.set(server.inviteCode, server);
          return server;
        },
        async connect(invite) {
          const server = servers.get(invite);
          if (!server || server.closed) throw new Error('peer_not_found');
          const client = new Conn();
          const accepted = new Conn();
          client.other = accepted; accepted.other = client;
          client.connected = true; accepted.connected = true;
          server.conns.add(accepted);
          server.emit('connection', { conn: accepted });
          queueMicrotask(() => { accepted.emit('open', {}); client.emit('open', {}); });
          return client;
        },
      };
    },
  };
  return network;
}

import { randomUUID } from 'node:crypto';

// Browser half: `puter.peer.serve()` and `connect(invite)` over a Playwright binding. Messages for a link the page has
// not registered yet (its connect call is still resolving) wait until it is.
const SHIM = `(() => {
  if (globalThis.top !== globalThis || !globalThis.puter) return;
  const rpc = (method, ...args) => globalThis.__tripsPeerRpc(method, args);
  class Emitter {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    emit(type, event = {}) { for (const fn of [...(this.listeners.get(type) ?? [])]) { try { fn(event); } catch {} } }
  }
  const servers = new Map(); const links = new Map(); const early = new Map();
  function link(id) {
    const conn = Object.assign(new Emitter(), { connected: true });
    conn.send = (data) => { if (!conn.connected) throw new Error('not_connected'); rpc('send', id, String(data)).catch(() => {}); };
    conn.close = () => { if (!conn.connected) return; conn.connected = false; rpc('close', id).catch(() => {}); conn.emit('close'); };
    links.set(id, conn);
    for (const message of early.get(id) ?? []) receive(message);
    early.delete(id);
    queueMicrotask(() => { if (conn.connected) conn.emit('open'); });
    return conn;
  }
  function receive(message) {
    if (message.type === 'connection') { servers.get(message.server)?.emit('connection', { conn: link(message.conn) }); return; }
    const conn = links.get(message.conn);
    if (!conn) { if (!early.has(message.conn)) early.set(message.conn, []); early.get(message.conn).push(message); return; }
    if (message.type === 'message' && conn.connected) conn.emit('message', { data: message.data });
    if (message.type === 'close' && conn.connected) { conn.connected = false; conn.emit('close'); }
  }
  Object.defineProperty(globalThis, '__tripsPeerDeliver', { value: receive });
  globalThis.puter.peer = {
    async serve() {
      const { id, invite } = await rpc('serve');
      const server = Object.assign(new Emitter(), { inviteCode: invite });
      server.close = () => { rpc('closeServer', id).catch(() => {}); servers.delete(id); server.emit('close'); };
      servers.set(id, server);
      return server;
    },
    async connect(invite) { return link(await rpc('connect', invite)); },
  };
})();`;

/**
 * A Node-side stand-in for \`puter.peer\` shared by several bridge contexts, so live features (photo-book cursors) run
 * between two accounts. Attach each context before it opens a page. Links close with their page.
 */
export function createPeerRelay() {
  let next = 0;
  const servers = new Map();
  const links = new Map();
  const deliver = (page, message) => page.evaluate((value) => globalThis.__tripsPeerDeliver?.(value), message).catch(() => {});
  function closeLink(id) {
    const end = links.get(id);
    if (!end) return;
    links.delete(id);
    const other = links.get(end.other);
    if (other) { links.delete(end.other); void deliver(other.page, { type: 'close', conn: end.other }); }
  }
  function forgetPage(page) {
    for (const [invite, server] of servers) if (server.page === page) servers.delete(invite);
    for (const [id, end] of [...links]) if (end.page === page) closeLink(id);
  }
  async function attach(context) {
    await context.exposeBinding('__tripsPeerRpc', async ({ page }, method, args) => {
      if (method === 'serve') {
        const id = `server-${++next}`;
        const invite = `invite-${randomUUID()}`;
        servers.set(invite, { id, page });
        page.once('close', () => forgetPage(page));
        return { id, invite };
      }
      if (method === 'connect') {
        const server = servers.get(args[0]);
        if (!server) throw new Error('peer_not_found');
        const dialer = `link-${++next}`;
        const accepted = `link-${++next}`;
        links.set(dialer, { page, other: accepted });
        links.set(accepted, { page: server.page, other: dialer });
        page.once('close', () => forgetPage(page));
        void deliver(server.page, { type: 'connection', server: server.id, conn: accepted });
        return dialer;
      }
      if (method === 'send') {
        const end = links.get(args[0]);
        const other = end && links.get(end.other);
        if (!other) throw new Error('not_connected');
        void deliver(other.page, { type: 'message', conn: end.other, data: args[1] });
        return null;
      }
      if (method === 'close') { closeLink(args[0]); return null; }
      if (method === 'closeServer') { for (const [invite, server] of servers) if (server.id === args[0]) servers.delete(invite); return null; }
      throw new Error('unknown_method');
    });
    await context.addInitScript({ content: SHIM });
  }
  return { attach, stats: () => ({ servers: servers.size, links: links.size / 2 }) };
}

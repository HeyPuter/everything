// Dev harness for editing together in mock.html: the room worker runs inside the page over in-memory storage,
// and window.__collabDemo adds simulated collaborators (other accounts) who join, move about and type. Requests
// skip the signed-credential check (tests cover it); everything else is the real worker and client.
import { RoomService } from '/src/collab/server/service.js';
import { RoomClient } from '/src/collab/client.js';
import { memoryOutbox } from '/src/collab/outbox.js';
import { call } from '/src/collab/api.js';

const puter = window.puter;
if (puter && !puter.workers) {
  const data = new Map(), files = new Map(), listeners = new Map();
  const kv = {
    async get(key) { return data.has(key) ? structuredClone(data.get(key)) : null; },
    async incr(key, n = 1) { const v = (data.get(key) || 0) + n; data.set(key, v); return v; },
    async set(key, value) {
      data.set(key, structuredClone(value));
      for (const { key: k, fn } of listeners.values()) if (key.endsWith(':ev:signal') && (k === key || k === 'signal')) queueMicrotask(() => fn({ event: { key } }));
      return true;
    },
    async del(key) { data.delete(key); return true; },
    async list({ pattern }) { const p = pattern.replace(/\*$/, ''); return { items: [...data.keys()].filter((k) => k.startsWith(p)).sort().map((key) => ({ key, value: structuredClone(data.get(key)) })) }; },
  };
  const me = { uuid: '11111111-1111-4111-8111-111111111111', username: 'demo' };
  const workerFs = {
    async write(path, value) { files.set(path, typeof value === 'string' ? value : await value.arrayBuffer()); return { path }; },
    async read(path) { if (!files.has(path)) throw new Error('missing'); return new Blob([files.get(path)]); },
    async stat(path) { if (!files.has(path)) throw new Error('missing'); return { path }; },
  };
  const service = new RoomService({ kv, fs: workerFs, auth: { getUser: async () => me }, authToken: `h.${btoa(JSON.stringify({ app_uid: 'app-sheet' }))}.s`, APIOrigin: 'https://api.puter.test' });
  const sdkFor = (user, base = {}) => Object.assign(base, {
    APIOrigin: 'https://api.puter.test',
    authToken: base.authToken || `h.${btoa(JSON.stringify({ type: 'app-under-user', user_uid: user.uuid }))}.s`,
    workers: {
      async create(name) { return { url: `https://${name}.puter.work` }; },
      async exec(url, options = {}) {
        await new Promise((r) => setTimeout(r, 40 + Math.random() * 60)); // a network's latency
        if (url.endsWith('/health')) return Response.json({ ok: true, build: window.__collabBuild || 'dev' });
        try { return Response.json(await service.call(user, JSON.parse(options.body))); }
        catch (e) { return Response.json({ message: e.message }, { status: e.status || 500 }); }
      },
    },
    events: { async onLocal(subject, fn) { const id = crypto.randomUUID(); listeners.set(id, { key: subject.split(':').slice(2).join(':'), fn }); return { off: () => listeners.delete(id) }; } },
  });
  // The page's own account: credentials and the worker bundle are stood in for.
  sdkFor(me, puter);
  puter.authToken = `h.${btoa(JSON.stringify({ type: 'app-under-user', user_uid: me.uuid }))}.s`;
  puter.fs.getReadURL = async () => `https://api.puter.test/token-read?token=${encodeURIComponent(`h.${btoa(JSON.stringify({ type: 'access-token', user_uid: me.uuid, exp: Math.floor(Date.now() / 1000) + 86400 }))}.s`)}`;
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, init) => (String(url).includes('worker/spreadsheet-worker.js') ? Promise.resolve(new Response('/* spreadsheet-worker build=0123456789abcdef */')) : realFetch(url, init));
  window.__collabBuild = '0123456789abcdef';

  const bots = [];
  window.__collabDemo = {
    service, data,
    /** A collaborator who joins the shared workbook open in this page and works on it. */
    async addPerson(username, { role = 'editor', at = null } = {}) {
      const hash = location.hash;
      const m = /#\/live\/([^?]+)\?(.*)$/.exec(hash);
      let room, server;
      if (m) { room = decodeURIComponent(m[1]); server = new URLSearchParams(m[2]).get('server'); }
      else {
        const roomKeys = [...data.keys()].filter((k) => k.endsWith(':meta'));
        room = roomKeys.at(-1)?.split(':')[1];
        server = (await puter.kv.get('spreadsheet-collab-worker-v1'))?.server;
      }
      const user = { uuid: crypto.randomUUID(), username };
      const sdk = sdkFor(user, { kv: { get: async () => null, set: async () => true }, fs: puter.fs, auth: { getUser: async () => user } });
      sdk.fs = { ...puter.fs, getReadURL: puter.fs.getReadURL };
      const { token } = await call(puter, server, { op: 'invite', room, role });
      const client = new RoomClient({ puter: sdk, server, room, token, store: memoryOutbox(), poll: 400, noPeers: true });
      await client.open();
      bots.push(client);
      if (at) client.setPresence(at);
      await client.checkIn();
      return client;
    },
    bots,
  };
}

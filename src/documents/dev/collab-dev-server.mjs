/**
 * Development-only room server for shared documents: the same RoomService the
 * Puter worker runs (src/collab/server/service.js), in the Vite dev server at
 * /__collab/api, with an in-memory key-value store and file system. Requests
 * name their user in a header, as /mock.html's in-memory SDK has no real
 * accounts. Never part of a production build (Vite applies it only to `serve`).
 */
export default function collabDevServer() {
  return {
    name: 'documents-collab-dev-server',
    apply: 'serve',
    configureServer(server) {
      const kv = new Map(), files = new Map();
      const store = {
        async get(key) { return kv.has(key) ? structuredClone(kv.get(key)) : null; },
        async set(key, value) { kv.set(key, structuredClone(value)); return true; },
        async del(key) { kv.delete(key); return true; },
        async incr(key, amount = 1) { const next = Number(kv.get(key) || 0) + amount; kv.set(key, next); return next; },
        async list({ pattern }) { const prefix = pattern.replace(/\*$/, ''); return [...kv.keys()].filter(k => k.startsWith(prefix)).sort().map(key => ({ key, value: structuredClone(kv.get(key)) })); },
      };
      const fs = {
        async write(path, data) { files.set(path, typeof data === 'string' ? data : await data.text()); return { path }; },
        async read(path) { if (!files.has(path)) throw Object.assign(new Error('not found'), { code: 'subject_does_not_exist' }); return new Blob([files.get(path)]); },
        async stat(path) { if (!files.has(path)) throw new Error('not found'); return { path }; },
      };
      server.middlewares.use('/__collab/api', async (req, res) => {
        const reply = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
        try {
          if (req.method !== 'POST') return reply(405, { message: 'POST only.' });
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const user = JSON.parse(req.headers['x-collab-dev-user'] || 'null');
          if (!user?.uuid) return reply(401, { message: 'Sign in with Puter to continue.' });
          const { RoomService } = await server.ssrLoadModule('/src/collab/server/service.js');
          // In development everyone may create rooms: the service's owner is whoever asks.
          const service = new RoomService({ kv: store, fs, auth: { getUser: async () => user } });
          reply(200, await service.call(user, input));
        } catch (error) {
          reply(error.status || 500, { message: error.status ? error.message : `Dev room server: ${error.message}` });
        }
      });
    },
  };
}

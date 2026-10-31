// A stand-in for the puter.js surfaces the booking import uses: ai.chat, fs staging, perms and the Puter mailbox.
// dev/fake-puter models AI (`ai: true`, dev/fake-puter/ai.js) but not mail, so import tests use this.

/**
 * `replies` are consumed one per chat call: an object (sent back as JSON text), a string, an Error-like value to
 * reject with (`{reject: error}`), or a function `(messages, options) => reply`.
 */
export function fakeAiPuter({ replies = [], mail = [] } = {}) {
  const calls = [];
  const staged = new Map();
  const deleted = [];
  const permissions = [];
  const puter = {
    ai: {
      async chat(messages, options, testMode) {
        calls.push({ messages, options, testMode });
        const next = replies.shift();
        if (next && typeof next === 'object' && 'reject' in next) throw next.reject;
        const value = typeof next === 'function' ? next(messages, options) : next;
        return { message: { role: 'assistant', content: typeof value === 'string' ? value : JSON.stringify(value ?? { bookings: [] }) } };
      },
    },
    fs: {
      async write(path, blob) { const full = `/alice/AppData/app-test/${path}`; staged.set(full, blob); return { path: full, name: path.split('/').at(-1) }; },
      async delete(path) { deleted.push(path); staged.delete(path); },
    },
    perms: { async request(...args) { permissions.push(args); return true; } },
    email: {
      async list({ limit = 50 } = {}) {
        return { items: mail.slice(0, limit).map(({ id, subject, date }) => ({ id, subject, date, size: 100, folder: 'inbox' })), cursor: null };
      },
      async get(id) {
        const found = mail.find((message) => message.id === id);
        if (!found) throw Object.assign(new Error('not found'), { code: 'not_found', status: 404 });
        return found;
      },
    },
  };
  return { puter, calls, staged, deleted, permissions };
}

/** An in-memory stand-in for `openDatabase` (get/put/remove). */
export function memoryDb() {
  const map = new Map();
  return {
    map,
    async get(key) { return structuredClone(map.get(key)); },
    async put(key, value) { map.set(key, structuredClone(value)); },
    async remove(key) { map.delete(key); },
  };
}

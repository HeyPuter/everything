/**
 * Dev-only in-memory mock of the Puter SDK, served at /dev/mock.html.
 * Lets you develop and test the full signed-in UI without a Puter account.
 * Not part of the production build (vite only builds index.html).
 */
(() => {
  const kv = new Map();
  const files = new Map();
  // ?signedout shows the intro page; ?env=app exercises the Puter-app chrome.
  const params = new URLSearchParams(location.search);
  let signedIn = !params.has('signedout');

  window.puter = {
    env: params.get('env') || 'web',
    kv: {
      async get(key) {
        const v = kv.get(key);
        return v === undefined ? null : JSON.parse(JSON.stringify(v));
      },
      async set(key, value) {
        kv.set(key, JSON.parse(JSON.stringify(value)));
        return true;
      },
      async del(key) {
        return kv.delete(key);
      },
    },
    fs: {
      async write(path, data) {
        files.set(path, String(data));
        return { path };
      },
      async read(path) {
        if (!files.has(path)) {
          const err = new Error('No such file');
          err.code = 'subject_does_not_exist';
          throw err;
        }
        return new Blob([files.get(path)]);
      },
      async delete(path) {
        files.delete(path);
      },
      async getReadURL(path) {
        // Serve the current snapshot through a blob URL so the shared
        // viewer can be exercised end to end in dev.
        if (!files.has(path)) throw new Error('No such file');
        return URL.createObjectURL(new Blob([files.get(path)], { type: 'application/json' }));
      },
    },
    auth: {
      async isSignedIn() { return signedIn; },
      async signIn() { signedIn = true; return true; },
      signOut() { signedIn = false; },
      async getUser() { return { username: 'demo', uuid: 'demo-uuid' }; },
    },
  };

  // ?kvshare adds owner-side KV shares (invite by username). Any username
  // works except "nobody", which doesn't exist.
  const shares = [];
  if (params.has('kvshare')) {
    const fail = (code) => Promise.reject({ code, message: code });
    window.puter.appID = 'app-tasks-dev';
    const setOne = window.puter.kv.set;
    Object.assign(window.puter.kv, {
      async set(key, value) {
        if (!Array.isArray(key)) return setOne(key, value);
        for (const item of key) await setOne(item.key, item.value);
        return true;
      },
      async list(pattern = '*', values = false) {
        const p = String(pattern).replace(/\*$/, '');
        return [...kv.keys()].filter((k) => k.startsWith(p)).sort()
          .map((k) => (values ? { key: k, value: JSON.parse(JSON.stringify(kv.get(k))) } : k));
      },
      async share({ prefix, recipient, access = 'read', label = null }) {
        if (recipient.includes('@')) return fail('invalid_recipient');
        if (recipient === 'nobody') return fail('subject_does_not_exist');
        let s = shares.find((x) => x.prefix === prefix && x.holder === recipient && !x.revokedAt);
        if (!s) {
          s = { handle: `h-${shares.length + 1}`, prefix, holder: recipient, createdAt: Date.now() / 1000 | 0, revokedAt: null };
          shares.push(s);
        }
        Object.assign(s, { access, label });
        return { ...s };
      },
      async unshare(handle) {
        const s = shares.find((x) => x.handle === handle);
        if (!s) return fail('subject_does_not_exist');
        s.revokedAt ||= Date.now() / 1000 | 0;
        return { handle, revokedAt: s.revokedAt };
      },
      async listShared() { return { items: [] }; },
      async listSharedByMe() { return { items: shares.map((s) => ({ ...s })) }; },
    });
    window.puter.perms = {
      Resource: { KV_SHARE: 'kvShare' },
      // ?kvshare=deny answers the consent prompt with no.
      async request() { return params.get('kvshare') !== 'deny'; },
    };
  }

  window.__puterMock = { kv, files, shares };
})();

/**
 * Dev-only in-memory mock of the Puter SDK, used by /mock.html. Files persist
 * in sessionStorage so a reload keeps state; nothing here ships in the
 * production build (Vite only builds index.html).
 *
 * Query flags: ?env=app simulates running inside the Puter desktop;
 * ?signedout starts signed out; ?picture gives the signed-in user a photo.
 */
(() => {
  const params = new URLSearchParams(location.search);
  const LS = 'documents-mock-state';
  const state = (() => {
    try { return JSON.parse(sessionStorage.getItem(LS)) || { fs: {} }; } catch { return { fs: {} }; }
  })();
  let signedIn = !params.has('signedout');
  // ?user=name signs in as someone else (two people sharing a document in one browser).
  const mockUser = (params.get('user') || 'demo').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32) || 'demo';
  const persist = () => { try { sessionStorage.setItem(LS, JSON.stringify(state)); } catch {} };
  const delay = (ms = 60) => new Promise((r) => setTimeout(r, ms));

  const b64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
  const norm = (p) => String(p).replace(/^\/+/, '').replace(/\/+$/, '');
  const now = () => Math.floor(Date.now() / 1000);
  const item = (path, f) => ({
    path, name: path.split('/').pop(), is_dir: !f, size: f?.size ?? null,
    modified: f?.modified ?? now(), created: f?.created ?? now(), uid: `uid-${path}`,
    read: async () => window.puter.fs.read(path),
  });
  // A 64x40 blue PNG for the image picker.
  const SAMPLE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAADBrGu+AAAAPUlEQVR42u3PQQkAAAgEsMtnMLMawww+hcEKLNXzWgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELhbh+DEAtSaHCQAAAABJRU5ErkJggg==';
  const notFound = (p) => Object.assign(new Error(`${p} does not exist`), { code: 'subject_does_not_exist' });
  const dirs = new Set(Object.keys(state.fs).map((p) => p.split('/').slice(0, -1).join('/')).filter(Boolean));

  window.puter = {
    env: params.get('env') || 'web',
    appID: 'mock-app',
    // Shared documents use the dev server's in-process room service (dev/collab-dev-server.mjs).
    collabDevServer: `${location.origin}/__collab`,
    authToken: 'mock-session',
    /** App key-value storage (per tab, like the files). */
    kv: {
      async get(key) { await delay(10); return state.kv?.[key] ?? null; },
      async set(key, value) { await delay(10); (state.kv ||= {})[key] = value; persist(); return true; },
      async del(key) { await delay(10); if (state.kv) delete state.kv[key]; persist(); return true; },
    },
    /** Mail from the user's Puter address: recorded for tests (window.__sentMail), never sent. */
    email: {
      async send(message) {
        await delay(200);
        (window.__sentMail ||= []).push({ to: message.to, subject: message.subject, text: message.text, attachments: (message.attachments || []).map(a => ({ filename: a.filename, contentType: a.contentType, size: a.content?.length || 0 })) });
        console.log(`[puter-mock] email to ${message.to}: ${message.subject}`);
        return { delivered: [message.to] };
      },
    },
    auth: {
      isSignedIn: () => signedIn,
      async signIn() { await delay(200); signedIn = true; return true; },
      signOut() { signedIn = false; },
      async getUser() { await delay(); return signedIn ? { username: mockUser, uuid: mockUser === 'demo' ? 'mock-uuid' : `mock-uuid-${mockUser}`, email: `${mockUser}@example.com` } : null; },
      async getProfilePicture() { await delay(); return signedIn && params.has('picture') ? `data:image/png;base64,${SAMPLE_PNG}` : null; },
    },
    hosting: {
      _sites: {},
      async create(subdomain, dirPath) {
        await delay(200);
        if (this._sites[subdomain]) throw new Error('Subdomain already exists');
        this._sites[subdomain] = { subdomain, root_dir: norm(dirPath) };
        console.log(`[puter-mock] hosting ${subdomain}.puter.site -> ${dirPath}`);
        return this._sites[subdomain];
      },
      async update(subdomain, dirPath) { await delay(100); if (!this._sites[subdomain]) throw new Error('Subdomain does not exist'); this._sites[subdomain].root_dir = norm(dirPath); return this._sites[subdomain]; },
      async delete(subdomain) { await delay(100); if (!this._sites[subdomain]) throw new Error('Subdomain does not exist'); delete this._sites[subdomain]; return { success: true }; },
      async get(subdomain) { await delay(); if (!this._sites[subdomain]) throw new Error('Subdomain does not exist'); return this._sites[subdomain]; },
      async list() { await delay(); return Object.values(this._sites); },
    },
    ai: {
      /** A picture from a description: the sample PNG, so the flow can be exercised offline. */
      async txt2img(prompt) {
        await delay(900);
        const img = new Image();
        img.src = `data:image/png;base64,${SAMPLE_PNG}`;
        img.alt = String(prompt);
        console.log(`[puter-mock] txt2img "${String(prompt).slice(0, 40)}"`);
        return img;
      },
      /** Speech: a short silent clip per request, so reading aloud can be exercised offline. */
      async txt2speech(text) {
        await delay(400);
        const a = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=');
        a.dataset.text = String(text).slice(0, 60);
        console.log(`[puter-mock] txt2speech ${String(text).length} chars`);
        return a;
      },
      /** A canned rewrite so the writing assistant can be exercised offline. */
      async chat(prompt) {
        await delay(700);
        // Smart Lookup asks for a definition and related topics in a fixed format.
        if (/concise reference assistant/.test(prompt)) {
          const term = /Term:\n"+\n([\s\S]*?)\n"+/.exec(String(prompt))?.[1] || 'term';
          const reply = `Definition: ${term} is a sample term explained by the offline mock.\nRelated:\n- ${term} history\n- ${term} examples\n- Related concepts`;
          return { message: { role: 'assistant', content: reply }, toString: () => reply };
        }
        // The Assistant pane: a draft or rewrite comes back as TEXT, anything else as an ANSWER.
        if (/writing assistant inside a word processor\. Below/.test(prompt)) {
          const request = /The person asks: (.*)/.exec(String(prompt))?.[1] || '';
          const reply = /draft|write|rewrite|shorten|translate/i.test(request)
            ? `TEXT:\nThis draft was written by the offline assistant for: ${request.replace(/[.?!]+$/, '')}.`
            : `ANSWER:\nThe offline assistant read ${String(prompt).length} characters and answers: ${request}`;
          return { message: { role: 'assistant', content: reply }, toString: () => reply };
        }
        const m = /Text:\n"""\n([\s\S]*)\n"""$/.exec(String(prompt));
        const text = m ? m[1] : String(prompt);
        // The Review tools ask for JSON: proofreading answers (none here) and numbered translations.
        const numbered = [...String(prompt).matchAll(/^\[(\d+)\] (.*)$/gm)].map(n => n[2]);
        const reply = /proofreader inside a word processor/.test(prompt) ? '[]'
          : /Translate each numbered paragraph/.test(prompt) ? JSON.stringify(numbered.map(t => `[Translated] ${t}`))
          : /Translate this into/.test(prompt) ? `[Translated] ${text}` : /Continue this text/.test(prompt) ? 'And so the story went on, one careful sentence after another.\n\nIt ended where it had to.' : `${text.replace(/\s+/g, ' ').trim()} (revised)`;
        return { message: { role: 'assistant', content: reply }, toString: () => reply };
      },
    },
    fs: {
      async mkdir(path) { await delay(); dirs.add(norm(path)); return item(norm(path)); },
      async readdir(path) {
        await delay();
        const p = norm(path);
        if (!dirs.has(p) && !Object.keys(state.fs).some((k) => k.startsWith(`${p}/`))) throw notFound(p);
        return Object.entries(state.fs).filter(([k]) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/')).map(([k, f]) => item(k, f));
      },
      async read(path) {
        await delay();
        const f = state.fs[norm(path)];
        if (!f) throw notFound(path);
        return new Blob([fromB64(f.b64)], { type: f.type });
      },
      async write(path, data, opts = {}) {
        await delay(120);
        const blob = data instanceof Blob ? data : new Blob([data ?? '']);
        const buf = await blob.arrayBuffer();
        let p = norm(path);
        if (opts.dedupeName && state.fs[p]) {
          const stem = p.replace(/\.[^.]+$/, '');
          const ext = p.slice(stem.length);
          let n = 1;
          while (state.fs[`${stem} (${n})${ext}`]) n++;
          p = `${stem} (${n})${ext}`;
        }
        if (state.fs[p] && opts.overwrite === false) throw new Error('A file with that name already exists');
        state.fs[p] = { b64: b64(buf), type: blob.type, size: buf.byteLength, modified: now(), created: state.fs[p]?.created ?? now() };
        dirs.add(p.split('/').slice(0, -1).join('/'));
        persist();
        console.log(`[puter-mock] wrote ${p} (${buf.byteLength} bytes)`);
        return item(p, state.fs[p]);
      },
      async delete(path, { recursive = false } = {}) {
        await delay();
        const p = norm(path);
        delete state.fs[p];
        if (recursive || dirs.has(p)) for (const k of Object.keys(state.fs)) if (k.startsWith(`${p}/`)) delete state.fs[k];
        dirs.delete(p);
        persist();
      },
      async rename(path, newName) {
        await delay();
        const p = norm(path);
        const target = `${p.split('/').slice(0, -1).join('/')}/${newName}`;
        const f = state.fs[p];
        if (f) {
          delete state.fs[p];
          state.fs[target] = f;
        } else if (dirs.has(p) || Object.keys(state.fs).some((k) => k.startsWith(`${p}/`))) {
          for (const k of Object.keys(state.fs)) if (k.startsWith(`${p}/`)) { state.fs[`${target}${k.slice(p.length)}`] = state.fs[k]; delete state.fs[k]; }
          dirs.delete(p); dirs.add(target);
        } else throw notFound(p);
        persist();
        return item(target, f);
      },
      async stat(path) {
        await delay(20);
        const p = norm(path);
        if (state.fs[p]) return item(p, state.fs[p]);
        if (dirs.has(p)) return item(p);
        throw notFound(p);
      },
    },
    ui: {
      setWindowTitle(t) { document.title = t; },
      onLaunchedWithItems() {},
      async showOpenFilePicker({ accept = [] } = {}) {
        await delay();
        const ok = (p) => !accept.length || accept.some((ext) => p.toLowerCase().endsWith(ext));
        let names = Object.keys(state.fs).filter(ok).sort();
        if (!names.length && accept.some((ext) => ext === '.png')) {
          // No image on the mock drive yet: conjure a small one so the picker has something to return.
          await window.puter.fs.write('Pictures/sample.png', new Blob([fromB64(SAMPLE_PNG)], { type: 'image/png' }));
          names = ['Pictures/sample.png'];
        }
        if (!names.length) throw new Error('cancelled');
        const p = names[0];
        console.log(`[puter-mock] open picker -> ${p}`);
        return item(p, state.fs[p]);
      },
      async showSaveFilePicker(data, suggestedName) {
        const p = `Desktop/${suggestedName || `export-${Date.now()}`}`;
        const it = await window.puter.fs.write(p, data);
        console.log(`[puter-mock] save picker -> ${p}`);
        return it;
      },
    },
  };
})();

/**
 * Scripts: run JavaScript automation against the active document.
 *
 * A script runs in a sandboxed iframe with an opaque origin (no access to
 * the app, its storage or the user's sign-in) and talks to the app only
 * through the `vs` API below, by message. Every API call is async. All the
 * changes one run makes are a single undo step.
 *
 *   vs.doc                     { name, units, artboards: [{ name, x, y, w, h }] }
 *   await vs.selection()       selected objects (plain JSON copies)
 *   await vs.objects(filter?)  all objects, optionally { type: 'path' | 'text' | ... }
 *   await vs.get(id)
 *   await vs.update(id, patch) change properties (fill, stroke, opacity, name, anchors, ...)
 *   await vs.create(node, { parent?, index? })   add a path/text/group from JSON; returns its id
 *   await vs.remove(id)
 *   await vs.select(ids)
 *   await vs.command(id)       run a menu command by id (e.g. 'object.group')
 *   await vs.exportSVG({ artboard? | selection? })   SVG text
 *   await vs.download(name, text, type?)              save a file to the device
 *   vs.log(...values)          show a message
 *   await vs.prompt(label, value?)   ask for text (null when cancelled)
 *   await vs.confirm(message)
 */
import { createPath, createText, createGroup, DEFAULT_CHAR, NEW_PARA } from '../../model/nodes.js';
import { downloadBlob } from '../io/deliver.js';

const BOOT = `
<script>
(() => {
  let seq = 0;
  const waiting = new Map();
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    parent.postMessage({ __vs: 'call', id, method, args }, '*');
  });
  addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.__vs === 'reply') {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.error) w.reject(new Error(m.error));
      else w.resolve(m.value);
    } else if (m.__vs === 'run') {
      const vs = {
        doc: m.doc,
        selection: () => call('selection'),
        objects: (filter) => call('objects', filter || null),
        get: (id) => call('get', id),
        update: (id, patch) => call('update', id, patch),
        create: (node, opts) => call('create', node, opts || null),
        remove: (id) => call('remove', id),
        select: (ids) => call('select', ids),
        command: (id) => call('command', id),
        exportSVG: (opts) => call('exportSVG', opts || null),
        download: (name, text, type) => call('download', name, String(text), type || 'text/plain'),
        prompt: (label, value) => call('prompt', String(label), value == null ? '' : String(value)),
        confirm: (message) => call('confirm', String(message)),
        log: (...v) => { call('log', v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); },
      };
      let fn;
      try {
        fn = new Function('vs', '"use strict"; return (async () => {\\n' + m.source + '\\n})();');
      } catch (err) {
        parent.postMessage({ __vs: 'done', error: 'Syntax error: ' + err.message }, '*');
        return;
      }
      Promise.resolve()
        .then(() => fn(vs))
        .then((value) => parent.postMessage({ __vs: 'done', value: value === undefined ? null : String(value) }, '*'))
        .catch((err) => parent.postMessage({ __vs: 'done', error: (err && err.message) || String(err) }, '*'));
    }
  });
  parent.postMessage({ __vs: 'ready' }, '*');
})();
<\/script>`;

const plain = (n) => (n ? JSON.parse(JSON.stringify(n)) : null);

/** Object properties a script may change (structure stays with create/remove). */
const LOCKED_KEYS = new Set(['id', 'type', 'parent', 'children']);

/** Build a node from script JSON. */
function nodeFromJSON(data) {
  const t = data?.type;
  const { id, parent, children, ...rest } = data || {};
  if (t === 'path') return createPath(Array.isArray(rest.anchors) ? rest.anchors : [], Boolean(rest.closed), rest);
  if (t === 'text') return createText(String(rest.text ?? ''), Number(rest.x) || 0, Number(rest.y) || 0, { ...rest, char: { ...DEFAULT_CHAR, ...rest.char }, para: { ...NEW_PARA, ...rest.para } });
  if (t === 'group') return createGroup([], rest);
  throw new Error(`Scripts can create path, text and group objects, not "${t}".`);
}

/**
 * Run a script against the app's active editor. Resolves to
 * { ok, value?, error?, changes } when the script finishes. `timeoutMs`
 * stops runaway scripts.
 */
export function runScript(app, source, { name = 'Script', timeoutMs = 60000 } = {}) {
  const editor = app.editor;
  if (!editor) return Promise.resolve({ ok: false, error: 'Open a document to run a script.' });
  const doc = editor.doc;
  const { api, changes: count } = scriptAPI(app, editor, name);

  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      frame.remove();
      resolve({ ...result, changes: count() });
    };
    const timer = setTimeout(() => finish({ ok: false, error: `The script took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.` }), timeoutMs);
    const onMessage = async (e) => {
      if (e.source !== frame.contentWindow) return;
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.__vs === 'ready') {
        const root = doc.root;
        frame.contentWindow.postMessage({ __vs: 'run', source, doc: { name: editor.name || root.name, units: root.units, artboards: (root.artboards || []).map((a) => ({ name: a.name, x: a.x, y: a.y, w: a.w, h: a.h })) } }, '*');
      } else if (m.__vs === 'call') {
        let reply;
        try {
          const fn = api[m.method];
          if (!fn) throw new Error(`Unknown API "${m.method}".`);
          reply = { __vs: 'reply', id: m.id, value: await fn(...(m.args || [])) };
        } catch (err) {
          reply = { __vs: 'reply', id: m.id, error: err?.message || String(err) };
        }
        if (!done) frame.contentWindow?.postMessage(reply, '*');
      } else if (m.__vs === 'done') {
        finish(m.error ? { ok: false, error: m.error } : { ok: true, value: m.value });
      }
    };
    window.addEventListener('message', onMessage);
    frame.srcdoc = `<!doctype html><meta charset="utf-8">${BOOT}`;
    document.body.append(frame);
  });
}

/** The app side of the script API for one run: { api, changes() }. */
export function scriptAPI(app, editor, name) {
  const doc = editor.doc;
  const runKey = `script:${Date.now()}:${Math.random()}`;
  let changes = 0;

  const mutate = (fn) => {
    let out;
    doc.transact(name, () => {
      out = fn();
    }, { coalesce: runKey });
    changes++;
    return out;
  };
  const check = (id) => {
    const n = doc.get(id);
    if (!n || n.type === 'root') throw new Error(`No object with id "${id}".`);
    return n;
  };
  const api = {
    selection: () => editor.selectedNodes().map(plain),
    objects: (filter) => {
      const out = [];
      doc.walk((n) => {
        if (n.type === 'layer') return true;
        if (!filter?.type || n.type === filter.type) out.push(plain(n));
        return true;
      });
      return out;
    },
    get: (id) => plain(doc.get(id)),
    update: (id, patch) => {
      check(id);
      const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => !LOCKED_KEYS.has(k)));
      mutate(() => doc.update(id, clean));
      return true;
    },
    create: (data, opts) => {
      const node = nodeFromJSON(data);
      const parentId = opts?.parent && doc.get(opts.parent)?.children ? opts.parent : editor.targetLayer().id;
      return mutate(() => doc.insert(node, parentId, opts?.index ?? Infinity)).id;
    },
    remove: (id) => {
      check(id);
      mutate(() => doc.remove(id));
      return true;
    },
    select: (ids) => {
      editor.select((ids || []).filter((id) => doc.get(id)));
      return true;
    },
    command: async (id) => {
      if (!app.commands.get(id)) throw new Error(`Unknown command "${id}".`);
      await app.commands.run(id);
      changes++;
      return true;
    },
    exportSVG: async (opts) => app.exporters?.svg?.(editor, opts || {}) ?? null,
    download: (fileName, text, type) => {
      downloadBlob(new Blob([text], { type }), String(fileName || 'output.txt'));
      return true;
    },
    prompt: async (label, value) => {
      const v = await app.dialogs.form({ title: name, fields: [{ key: 'v', label, type: 'text', value }] });
      return v ? v.v : null;
    },
    confirm: (message) => app.dialogs.confirm({ title: name, message }),
    log: (text) => {
      app.notify?.(`${name}: ${text}`, { polite: true });
      return true;
    },
  };
  return { api, changes: () => changes };
}

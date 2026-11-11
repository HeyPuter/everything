// Script runtime: the `studio` API as a script sees it. This file runs inside
// the script sandbox (a dedicated worker started by an iframe with an opaque
// origin and a content security policy without network access), followed by
// the user's script wrapped in an async function. Every call becomes a
// structured-clone message to Photo Studio, which checks it and answers.
// Plain JavaScript: it is inserted as text, not bundled.
const __studioRegister = (() => {
  'use strict';
  let port = null;
  let main = null;
  let info = { lineOffset: 0, script: { id: '', name: '' }, event: null };
  let next = 0;
  let cancelled = false;
  const pending = new Map();
  // Calls a script may have waiting at once: a loop that calls the API without
  // awaiting stops here instead of flooding Photo Studio with requests.
  const MAX_PENDING = 10000;

  class ScriptCancelled extends Error {
    constructor() {
      super('The script was stopped.');
      this.name = 'ScriptCancelled';
    }
  }
  const send = (message) => port.postMessage(message);
  function call(method, ...args) {
    if (cancelled) return Promise.reject(new ScriptCancelled());
    if (pending.size >= MAX_PENDING) throw new Error(`More than ${MAX_PENDING} API calls are waiting: use await in loops that call the studio API.`);
    flushLogs();
    const id = ++next;
    // The call site, so an error reports the script's line rather than the runtime's.
    const site = new Error();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, site });
      send({ type: 'call', id, method, args });
    });
  }
  function receive(ev) {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ping') return send({ type: 'pong' });
    if (m.type === 'cancel') {
      cancelled = true;
      for (const p of pending.values()) p.reject(new ScriptCancelled());
      pending.clear();
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.type === 'result') p.resolve(m.value);
    else if (m.name === 'ScriptCancelled') p.reject(new ScriptCancelled());
    else {
      const error = new Error(m.message);
      error.name = m.name || 'Error';
      error.stack = `${error.name}: ${error.message}\n${String(p.site.stack || '').split('\n').slice(1).join('\n')}`;
      p.reject(error);
    }
  }

  // console.* goes to the Scripts panel output.
  const show = (v) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    try {
      return JSON.stringify(v, (_k, x) => (ArrayBuffer.isView(x) ? `[${x.constructor.name} ${x.length}]` : x));
    } catch {
      return String(v);
    }
  };
  // Output goes out at once up to LOG_RATE lines a second; more is held (the
  // latest LOG_HOLD lines) until the script next waits, so a loop that keeps
  // logging cannot flood Photo Studio or keep the watchdog from stopping it.
  const LOG_RATE = 100;
  const LOG_HOLD = 500;
  let held = [];
  let dropped = 0;
  let flushTimer = 0;
  let windowStart = 0;
  let windowCount = 0;
  function flushLogs() {
    clearTimeout(flushTimer);
    flushTimer = 0;
    if (dropped) send({ type: 'log', level: 'warn', text: `(${dropped} more lines were not shown)` });
    for (const line of held) send(line);
    held = [];
    dropped = 0;
    windowStart = Date.now();
    windowCount = 0;
  }
  function emit(line) {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      windowCount = 0;
    }
    if (!held.length && windowCount < LOG_RATE) {
      windowCount++;
      return send(line);
    }
    held.push(line);
    if (held.length >= LOG_HOLD * 2) {
      dropped += held.length - LOG_HOLD;
      held = held.slice(-LOG_HOLD);
    }
    flushTimer ||= setTimeout(flushLogs, 50);
  }
  const log = (level) => (...args) => emit({ type: 'log', level, text: args.map(show).join(' ').slice(0, 4000) });
  const scriptConsole = Object.freeze({ log: log('log'), info: log('info'), debug: log('log'), warn: log('warn'), error: log('error') });

  const idOf = (layer) => (layer && typeof layer === 'object' ? layer.id : layer);
  const layer = (info) => (info ? new Layer(info) : null);

  class Layer {
    constructor(data) {
      Object.assign(this, data);
    }
    refresh() { return call('layers.get', this.documentId, this.id).then(layer); }
    set(props) { return call('layers.set', this.documentId, this.id, props).then(layer); }
    rename(name) { return this.set({ name }); }
    show() { return this.set({ visible: true }); }
    hide() { return this.set({ visible: false }); }
    move(dx, dy) { return call('layers.translate', this.documentId, this.id, dx, dy).then(layer); }
    moveTo(x, y) {
      const b = this.bounds || { x: 0, y: 0 };
      return this.move(x - b.x, y - b.y);
    }
    arrange(where) {
      const w = where && typeof where === 'object' ? Object.fromEntries(Object.entries(where).map(([k, v]) => [k, idOf(v)])) : where;
      return call('layers.arrange', this.documentId, this.id, w).then(layer);
    }
    duplicate() { return call('layers.duplicate', this.documentId, this.id).then(layer); }
    remove() { return call('layers.remove', this.documentId, this.id); }
    select() { return call('layers.select', this.documentId, [this.id]); }
    pixels(rect) { return call('layers.getPixels', this.documentId, this.id, rect); }
    setPixels(image, x, y) {
      const img = x === undefined ? image : { ...image, x, y };
      return call('layers.setPixels', this.documentId, this.id, img).then(layer);
    }
    getText() { return call('layers.getText', this.documentId, this.id); }
    setText(textOrOptions) { return call('layers.setText', this.documentId, this.id, textOrOptions).then(layer); }
    setStyle(style) { return call('layers.setStyle', this.documentId, this.id, style).then(layer); }
    async children() {
      const all = await call('layers.list', this.documentId);
      return all.filter((l) => l.parentId === this.id).map(layer);
    }
    export(options = {}) { return call('documents.export', this.documentId, { ...options, layer: this.id }); }
  }

  const doc = (info) => (info ? new Document(info) : null);
  class Document {
    constructor(data) {
      Object.assign(this, data);
    }
    refresh() { return call('documents.get', this.id).then(doc); }
    activate() { return call('documents.activate', this.id).then(doc); }
    async layers() { return (await call('layers.list', this.id)).map(layer); }
    async layer(idOrName) {
      const all = await call('layers.list', this.id);
      return layer(all.find((l) => l.id === idOrName) || all.find((l) => l.name === idOrName));
    }
    async selectedLayers() { return (await call('layers.selected', this.id)).map(layer); }
    selectLayers(layers) { return call('layers.select', this.id, [].concat(layers).map(idOf)); }
    addLayer(options = {}) {
      const o = { ...options };
      for (const k of ['above', 'inside']) if (o[k] !== undefined) o[k] = idOf(o[k]);
      return call('layers.create', this.id, o).then(layer);
    }
    composite(rect) { return call('documents.composite', this.id, rect); }
    selection() { return call('selection.get', this.id); }
    select(shape, operation) { return call('selection.set', this.id, shape, operation); }
    selectAll() { return call('selection.all', this.id); }
    deselect() { return call('selection.clear', this.id); }
    invertSelection() { return call('selection.invert', this.id); }
    selectionMask() { return call('selection.getMask', this.id); }
    setSelectionMask(mask, operation) { return call('selection.setMask', this.id, mask, operation); }
    run(command, arg) { return call('commands.run', command, arg, this.id); }
    export(options = {}) { return call('documents.export', this.id, options); }
    save() { return call('documents.save', this.id); }
    close(options = {}) { return call('documents.close', this.id, options); }
    undo() { return call('documents.undo', this.id); }
    redo() { return call('documents.redo', this.id); }
  }

  const studio = Object.freeze({
    apiVersion: 1,
    get script() { return { ...info.script }; },
    // Set when the script runs for a Script Events Manager event.
    get event() { return info.event ? { ...info.event } : null; },
    get cancelled() { return cancelled; },
    checkCancelled() {
      if (cancelled) throw new ScriptCancelled();
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(60000, Number(ms) || 0)))),
    app: Object.freeze({
      info: () => call('app.info'),
      message: (text) => call('app.message', String(text)),
    }),
    documents: Object.freeze({
      list: async () => (await call('documents.list')).map(doc),
      active: () => call('documents.active').then(doc),
      get: (id) => call('documents.get', id).then(doc),
      create: (options = {}) => call('documents.create', options).then(doc),
      open: async (options = {}) => (await call('documents.open', options)).map(doc),
    }),
    commands: Object.freeze({
      run: (id, arg) => call('commands.run', id, arg),
      list: () => call('commands.list'),
    }),
    history: Object.freeze({
      checkpoint: (label) => call('history.checkpoint', label),
      setGrouping: (on) => call('history.grouping', !!on),
    }),
    ui: Object.freeze({
      alert: (message, title) => call('ui.alert', String(message), title),
      confirm: (message, title) => call('ui.confirm', String(message), title),
      prompt: (message, value, title) => call('ui.prompt', String(message), value === undefined ? '' : String(value), title),
      form: (title, fields, options) => call('ui.form', String(title), fields, options),
      progress: (fraction, message) => call('ui.progress', fraction === undefined ? null : fraction, message),
    }),
    files: Object.freeze({
      open: (options = {}) => call('files.open', options),
      save: (name, data, type) => call('files.save', name, data, type),
      saveAll: (files, zipName) => call('files.saveAll', files, zipName),
    }),
    image: Object.freeze({
      create(width, height, fill) {
        const data = new Uint8ClampedArray(width * height * 4);
        if (fill) {
          const [r, g, b, a = 255] = typeof fill === 'string' ? [1, 3, 5].map((i) => parseInt(fill.slice(i, i + 2), 16)) : fill;
          for (let i = 0; i < data.length; i += 4) {
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = a;
          }
        }
        return { width, height, data };
      },
      encode: (image, options) => call('image.encode', image, options),
    }),
  });

  // The script's own line number of an error, from the worker's stack.
  function lineOf(error) {
    const stack = String((error && error.stack) || '');
    for (const m of stack.matchAll(/blob:[^\s)]*?:(\d+):\d+/g)) {
      const line = Number(m[1]) - info.lineOffset;
      if (line > 0) return line;
    }
    return 0;
  }
  async function run() {
    try {
      if (!main) throw new Error('The script did not load.');
      await main(studio, scriptConsole);
      flushLogs();
      send({ type: 'done' });
    } catch (error) {
      flushLogs();
      if (cancelled || (error && error.name === 'ScriptCancelled')) return send({ type: 'done', cancelled: true });
      send({ type: 'failed', name: (error && error.name) || 'Error', message: String((error && error.message) || error), line: lineOf(error) });
    }
  }
  self.addEventListener('unhandledrejection', (ev) => {
    ev.preventDefault();
    if (port && !(ev.reason && ev.reason.name === 'ScriptCancelled')) scriptConsole.error('Unhandled rejection:', ev.reason);
  });
  self.onmessage = (ev) => {
    if (port || !ev.data || ev.data.type !== 'start' || !ev.ports[0]) return;
    port = ev.ports[0];
    info = ev.data.info;
    port.onmessage = receive;
    void run();
  };
  return (fn) => {
    main = fn;
  };
})();

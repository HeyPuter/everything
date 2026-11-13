/**
 * Scripts: run JavaScript automation against the active document.
 *
 * A script runs in a sandboxed iframe with an opaque origin (no access to
 * the app, its storage or the user's sign-in) and talks to the app only
 * through the `vs` API below, by message. Every API call is async. All the
 * changes one run makes are a single undo step. Coordinates are document
 * coordinates in points (those of anchors and artboards); `ids` arguments
 * take one id or a list, and a list gives a list back.
 *
 *   vs.doc                     { name, units, pointsPerUnit, artboards: [{ name, x, y, w, h }] }
 *
 * Objects
 *   await vs.selection()       selected objects (plain JSON copies)
 *   await vs.objects(filter?)  objects in paint order, filtered by { type, fill, stroke, closed,
 *                              within, selected, visible, compoundParts, fields }
 *   await vs.layers()          [{ id, name, hidden, locked, parent }]
 *   await vs.get(ids)          plain JSON copies (null for unknown ids)
 *   await vs.update(id, patch) change properties (fill, stroke, opacity, name, anchors, hidden, ...)
 *   await vs.updateMany(changes)   [{ id, patch }, ...] in one go; returns the count
 *   await vs.create(node, { parent?, index? })   add a path/compound/text/group/layer; returns its id
 *   await vs.createMany(nodes, { parent?, index? })   returns their ids
 *   await vs.duplicate(ids, { parent?, index? })      copies (above the originals); returns their ids
 *   await vs.remove(ids)       returns the count removed
 *   await vs.select(ids)
 *
 * Geometry (filled area: compound path holes and fill rules resolved, groups as their paths together)
 *   await vs.bounds(ids, { visual? })       { x, y, w, h } (visual: with strokes and effects)
 *   await vs.area(ids)                      filled area in square points (null: no area)
 *   await vs.labelPoint(ids, { precision? })   { x, y, radius }: the point inside farthest from
 *                                           the edges and the radius of the largest circle there
 *
 * Path operations (no dialogs; return the new objects' ids)
 *   await vs.pathfinder(kind, ids, { precision?, removeRedundant?, removeUnpainted? })
 *                              unite, minusFront, intersect, exclude, divide, trim, merge, crop,
 *                              outline, minusBack; the results replace the paths
 *   await vs.offsetPath(ids, { offset, joins?, miterLimit? })   joins: miter, round, bevel
 *   await vs.outlineStroke(ids, { keepFill? })
 *   await vs.command(id)       run a menu command by id (e.g. 'object.group'), with its dialog
 *
 * Running, asking and output
 *   vs.progress(fraction, message?)   show progress (0 to 1, or null) with a Stop button; a script
 *                              that reports progress may run as long as it needs, one that stays
 *                              silent for a minute is stopped
 *   await vs.form(title, fields)   several settings at once; fields: [{ key, label, type, value,
 *                              min?, max?, step?, options? }], types: text, number, length,
 *                              percent, angle, checkbox, select, radio, color, heading; null
 *                              when cancelled
 *   await vs.prompt(label, value?)   ask for text (null when cancelled)
 *   await vs.confirm(message)
 *   vs.log(...values)          show a message
 *   await vs.exportSVG({ artboard? | selection? })   SVG text
 *   await vs.download(name, text, type?)              save a file to the device
 */
import {
  createPath,
  createCompound,
  createText,
  createGroup,
  createLayer,
  DEFAULT_CHAR,
  NEW_PARA,
} from '../../model/nodes.js';
import { downloadBlob } from '../io/deliver.js';
import { repairNode } from '../files/format.js';
import { duplicateNodes } from '../../ops/layer-ops.js';
import { UNITS } from '../../lib/units.js';
import { boundsOf, areasOf, labelPointsOf } from './geometry.js';
import { pathfinderOn, offsetOn, outlineStrokeOn, PATHFINDER_KINDS } from './ops.js';

/**
 * The API reference shown in the app (File > Scripts > Scripting
 * Reference...). Each entry's `sig` also appears in the header comment
 * above (a test keeps the two in step).
 */
export const API_REFERENCE = [
  {
    title: 'Document',
    items: [
      [
        'vs.doc',
        'Name, units, points per unit and artboards ({ name, x, y, w, h }) of the document.',
      ],
    ],
  },
  {
    title: 'Objects',
    items: [
      ['await vs.selection()', 'The selected objects, as plain JSON copies.'],
      [
        'await vs.objects(filter?)',
        'Objects in paint order (back to front). Filter: type ("path", "compound", "text", "group", ... or a list), fill and stroke ("#rrggbb", true for any, false for none), closed, within (an id), selected, visible, compoundParts (include the paths inside compound paths), fields (a list of properties to copy, which keeps big documents fast).',
      ],
      ['await vs.layers()', 'Layers and sublayers: { id, name, hidden, locked, parent }.'],
      ['await vs.get(ids)', 'Copies of objects by id (null for unknown ids).'],
      [
        'await vs.update(id, patch)',
        'Change properties: fill, stroke, strokeWidth, opacity, name, anchors, hidden, ...',
      ],
      [
        'await vs.updateMany(changes)',
        'Many changes at once: [{ id, patch }, ...]. Returns the count.',
      ],
      [
        'await vs.create(node, { parent?, index? })',
        'Add a path ({ type: "path", anchors: [{ x, y }], closed }), compound ({ type: "compound", children: [paths] }), text, group or layer. Returns its id.',
      ],
      [
        'await vs.createMany(nodes, { parent?, index? })',
        'Add many objects at once. Returns their ids.',
      ],
      [
        'await vs.duplicate(ids, { parent?, index? })',
        'Copies, above their originals or in another layer or group. Returns their ids.',
      ],
      ['await vs.remove(ids)', 'Delete objects. Returns the count removed.'],
      ['await vs.select(ids)', 'Select objects.'],
    ],
  },
  {
    title: 'Geometry',
    items: [
      [
        'await vs.bounds(ids, { visual? })',
        'Bounding box { x, y, w, h }; visual includes strokes and effects.',
      ],
      [
        'await vs.area(ids)',
        'Filled area in square points: holes subtracted, overlaps counted once; a group is its paths together.',
      ],
      [
        'await vs.labelPoint(ids, { precision? })',
        '{ x, y, radius }: the point inside the shape farthest from its edges (where a label reads best) and the radius of the largest circle that fits there.',
      ],
    ],
  },
  {
    title: 'Path operations',
    items: [
      [
        'await vs.pathfinder(kind, ids, { precision?, removeRedundant?, removeUnpainted? })',
        `Combine paths without a dialog. Kinds: ${PATHFINDER_KINDS.join(', ')}. The results replace the paths; returns their ids.`,
      ],
      [
        'await vs.offsetPath(ids, { offset, joins?, miterLimit? })',
        'Offset copies (offset in points, negative insets; joins miter, round or bevel). Returns their ids.',
      ],
      [
        'await vs.outlineStroke(ids, { keepFill? })',
        'Turn strokes into filled shapes. Returns the new ids.',
      ],
      ['await vs.command(id)', 'Run a menu command by id (e.g. "object.group"), with its dialog.'],
    ],
  },
  {
    title: 'Running, asking and output',
    items: [
      [
        'vs.progress(fraction, message?)',
        'Show progress (0 to 1, or null) in the status bar with a Stop button. A script that reports progress can run as long as it needs; one that stays silent for a minute is stopped.',
      ],
      [
        'await vs.form(title, fields)',
        'Ask for several settings at once. Fields: [{ key, label, type, value, min?, max?, step?, options? }]; types text, number, length (in points, shown in the document units), percent, angle, checkbox, select, radio, color, heading. Returns { key: value } or null when cancelled.',
      ],
      ['await vs.prompt(label, value?)', 'Ask for text (null when cancelled).'],
      ['await vs.confirm(message)', 'Ask yes or no.'],
      ['vs.log(...values)', 'Show a message.'],
      [
        'await vs.exportSVG({ artboard? | selection? })',
        'SVG text of an artboard (index) or the selection.',
      ],
      ['await vs.download(name, text, type?)', 'Save a file to the device.'],
    ],
  },
];

/**
 * The script side of the API, as source text: `post` sends a message to the
 * app, `listen` receives them. It runs in a dedicated worker inside the
 * sandboxed iframe, so a runaway loop cannot freeze the app (a sandboxed
 * iframe may share the app's thread) and removing the iframe stops it.
 * Errors carry the script line they came from when the browser tells.
 */
export const SCRIPT_CORE = `(post, listen) => {
  let seq = 0;
  const waiting = new Map();
  const HEAD = '"use strict"; return (async () => {\\n';
  // The script's own frames are named, so its lines can be told from the API's.
  const TAIL = '\\n})();\\n//# sourceURL=vs-script.js';
  const frameLine = (stack) => {
    const text = String(stack || '');
    const m = /vs-script\\.js:(\\d+):\\d+/.exec(text) || /(?:<anonymous>|> Function|eval code):(\\d+):\\d+/.exec(text);
    return m ? Number(m[1]) : null;
  };
  let offset = null;
  try {
    offset = frameLine(new Function('vs', '"use strict"; return (() => {\\nreturn new Error();' + TAIL)().stack);
    if (offset != null) offset -= 1;
  } catch (e) {
    offset = null;
  }
  let lines = 0;
  const scriptLine = (stack) => {
    const n = frameLine(stack);
    if (n == null || offset == null) return null;
    const line = n - offset;
    return line >= 1 && line <= lines ? line : null;
  };
  const call = (method, ...args) => {
    const site = new Error();
    return new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject, site });
      post({ __vs: 'call', id, method, args });
    });
  };
  listen((m) => {
    if (!m || typeof m !== 'object') return;
    if (m.__vs === 'reply') {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.error) {
        const err = new Error(m.error);
        err.vsLine = scriptLine(w.site.stack);
        w.reject(err);
      } else w.resolve(m.value);
    } else if (m.__vs === 'run') {
      const vs = {
        doc: m.doc,
        selection: () => call('selection'),
        objects: (filter) => call('objects', filter || null),
        layers: () => call('layers'),
        get: (ids) => call('get', ids),
        update: (id, patch) => call('update', id, patch),
        updateMany: (changes) => call('updateMany', changes),
        create: (node, opts) => call('create', node, opts || null),
        createMany: (nodes, opts) => call('createMany', nodes, opts || null),
        duplicate: (ids, opts) => call('duplicate', ids, opts || null),
        remove: (ids) => call('remove', ids),
        select: (ids) => call('select', ids),
        bounds: (ids, opts) => call('bounds', ids, opts || null),
        area: (ids) => call('area', ids),
        labelPoint: (ids, opts) => call('labelPoint', ids, opts || null),
        pathfinder: (kind, ids, opts) => call('pathfinder', kind, ids, opts || null),
        offsetPath: (ids, opts) => call('offsetPath', ids, opts || null),
        outlineStroke: (ids, opts) => call('outlineStroke', ids, opts || null),
        command: (id) => call('command', id),
        exportSVG: (opts) => call('exportSVG', opts || null),
        download: (name, text, type) => call('download', name, String(text), type || 'text/plain'),
        progress: (value, message) => call('progress', value == null ? null : Number(value), message == null ? '' : String(message)),
        form: (title, fields) => call('form', String(title), fields),
        prompt: (label, value) => call('prompt', String(label), value == null ? '' : String(value)),
        confirm: (message) => call('confirm', String(message)),
        log: (...v) => { call('log', v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); },
      };
      lines = String(m.source).split('\\n').length;
      let fn;
      try {
        fn = new Function('vs', HEAD + m.source + TAIL);
      } catch (err) {
        const line = typeof err.lineNumber === 'number' && offset != null ? err.lineNumber - offset : null;
        post({ __vs: 'done', error: 'Syntax error: ' + err.message, syntax: true, line: line >= 1 && line <= lines ? line : null });
        return;
      }
      Promise.resolve()
        .then(() => fn(vs))
        .then((value) => post({ __vs: 'done', value: value === undefined ? null : String(value) }))
        .catch((err) => {
          const line = scriptLine(err && err.stack) || (err && err.vsLine) || null;
          post({ __vs: 'done', error: (err && err.message) || String(err), line });
        });
    }
  });
  post({ __vs: 'ready' });
}`;

/**
 * Boot code of the sandboxed iframe: starts the worker (or runs in the
 * iframe when workers cannot start) and passes messages. A syntax error
 * without a line is parsed once more in a throwaway worker, whose error
 * event tells the line.
 */
const BOOT = `
<script>
(() => {
  const core = ${SCRIPT_CORE};
  const toParent = (m) => parent.postMessage(m, '*');
  const fromParent = (fn) => addEventListener('message', (e) => { if (e.source === parent) fn(e.data); });
  let worker = null;
  let started = false;
  let source = '';
  const syntaxLine = (text) => new Promise((resolve) => {
    let w = null;
    let timer = 0;
    const end = (line) => {
      clearTimeout(timer);
      try { if (w) w.terminate(); } catch (e) {}
      resolve(line);
    };
    timer = setTimeout(() => end(null), 2000);
    try {
      w = new Worker(URL.createObjectURL(new Blob(['(async function (vs) {\\n' + text + '\\n});\\npostMessage(0);'], { type: 'text/javascript' })));
      w.onmessage = () => end(null);
      w.onerror = (e) => {
        e.preventDefault();
        const line = e.lineno ? e.lineno - 1 : null;
        end(line >= 1 ? line : null);
      };
    } catch (e) {
      end(null);
    }
  });
  const inline = () => {
    if (started) return;
    started = true;
    worker = null;
    core(toParent, fromParent);
  };
  try {
    const src = '(' + core.toString() + ')((m) => postMessage(m), (fn) => addEventListener("message", (e) => fn(e.data)));';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  } catch {
    worker = null;
  }
  if (!worker) {
    inline();
    return;
  }
  // Workers this browser will not start here (no 'ready' yet) fall back to running in the iframe.
  worker.onerror = () => {
    if (started) return;
    worker.terminate();
    inline();
  };
  worker.onmessage = (e) => {
    started = true;
    const m = e.data;
    if (m && m.__vs === 'done' && m.syntax && !m.line) syntaxLine(source).then((line) => toParent({ ...m, line }));
    else toParent(m);
  };
  fromParent((m) => {
    if (m && m.__vs === 'run') source = String(m.source);
    if (worker) worker.postMessage(m);
  });
})();
<\/script>`;

const plain = (n) => (n ? JSON.parse(JSON.stringify(n)) : null);

/** API calls that wait for the user to answer a dialog. */
const ASKS_USER = new Set(['prompt', 'confirm', 'form']);

/**
 * API calls that work for a while in the app (geometry over many shapes):
 * like waiting for the user, that time is not the script's own.
 */
const APP_WORK = new Set(['area', 'labelPoint', 'pathfinder', 'offsetPath', 'outlineStroke']);

/** Object properties a script may change (structure stays with create/remove). */
const LOCKED_KEYS = new Set(['id', 'type', 'parent', 'children']);

/** Most items one batch call takes. */
const MAX_BATCH = 200000;

/** How long a script may run without reporting progress (and without waiting for the user). */
export const SILENCE_LIMIT_MS = 60000;

/** "1 minute", "30 seconds". */
function duration(ms) {
  if (ms >= 60000) {
    const m = Math.round(ms / 60000);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const sec = Math.max(1, Math.round(ms / 1000));
  return `${sec} second${sec === 1 ? '' : 's'}`;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Script anchors as path points: { x, y } is enough; missing curve handles sit on the point. */
function toAnchors(list) {
  const num = (v, d) => (finite(v) ? v : d);
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && typeof a === 'object' && finite(a.x) && finite(a.y))
    .map((a) => ({
      ...a,
      ix: num(a.ix, a.x),
      iy: num(a.iy, a.y),
      ox: num(a.ox, a.x),
      oy: num(a.oy, a.y),
    }));
}

/** Refuse properties drawing cannot use (the wrong kind of value), naming them, instead of storing them. */
function checkValues(node, keys) {
  const fixed = repairNode(node);
  const bad = fixed === node ? [] : keys.filter((k) => fixed[k] !== node[k]);
  if (bad.length) throw new Error(`Not a valid value for ${bad.map((k) => `"${k}"`).join(', ')}.`);
}

/** Build a node (and its descendants) from script JSON: { node, descendants }. */
function nodeFromJSON(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('An object to create must be given as { type, ... }.');
  const t = data.type;
  // eslint-disable-next-line no-unused-vars
  const { id, parent, children, ...rest } = data;
  if (t === 'path') {
    const anchors = toAnchors(rest.anchors);
    return {
      node: createPath(anchors, Boolean(rest.closed), { ...rest, anchors }),
      descendants: [],
    };
  }
  if (t === 'compound') {
    const parts = Array.isArray(children) ? children : [];
    const comp = createCompound(
      [],
      {},
      { ...rest, fillRule: rest.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' },
    );
    const kids = parts.map((p) => {
      const anchors = toAnchors(p?.anchors);
      return { ...createPath(anchors, p?.closed !== false, {}), parent: comp.id };
    });
    comp.children = kids.map((k) => k.id);
    return { node: comp, descendants: kids };
  }
  if (t === 'text') {
    return {
      node: createText(String(rest.text ?? ''), Number(rest.x) || 0, Number(rest.y) || 0, {
        ...rest,
        char: { ...DEFAULT_CHAR, ...rest.char },
        para: { ...NEW_PARA, ...rest.para },
      }),
      descendants: [],
    };
  }
  if (t === 'group') return { node: createGroup([], rest), descendants: [] };
  if (t === 'layer') {
    const layer = createLayer(
      String(rest.name || 'Layer'),
      typeof rest.color === 'string' ? rest.color : undefined,
    );
    return {
      node: { ...layer, hidden: Boolean(rest.hidden), locked: Boolean(rest.locked) },
      descendants: [],
    };
  }
  throw new Error(`Scripts can create path, compound, text, group and layer objects, not "${t}".`);
}

/** Validate an options object: null or a plain object with only `allowed` keys. */
function options(v, allowed, what) {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v))
    throw new Error(`The options of ${what} must be an object.`);
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k))
      throw new Error(`Unknown option "${k}" for ${what}. Use: ${allowed.join(', ')}.`);
  }
  return v;
}

const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;

/** One id or a list of ids: { list, many }. */
function idArg(v, what) {
  const many = Array.isArray(v);
  const list = many ? v : [v];
  if (list.length > MAX_BATCH) throw new Error(`${what} takes at most ${MAX_BATCH} ids at once.`);
  for (const id of list)
    if (!isId(id)) throw new Error(`${what} takes an object id or a list of ids.`);
  return { list, many };
}

function numberOpt(o, key, what, { min = -Infinity, max = Infinity, required = false } = {}) {
  const v = o[key];
  if (v === undefined) {
    if (required) throw new Error(`${what} needs "${key}".`);
    return undefined;
  }
  if (!finite(v) || v < min || v > max)
    throw new Error(`"${key}" of ${what} must be a number from ${min} to ${max}.`);
  return v;
}

function boolOpt(o, key, what) {
  const v = o[key];
  if (v !== undefined && typeof v !== 'boolean')
    throw new Error(`"${key}" of ${what} must be true or false.`);
  return v;
}

/** Field types a script form may use. */
const FORM_TYPES = new Set([
  'text',
  'textarea',
  'number',
  'length',
  'percent',
  'angle',
  'checkbox',
  'select',
  'radio',
  'color',
  'heading',
]);
const FORM_KEYS = ['key', 'label', 'type', 'value', 'min', 'max', 'step', 'options', 'help'];

/** Script form fields, checked and copied into the dialog's field format. */
function formFields(fields) {
  if (!Array.isArray(fields) || !fields.length || fields.length > 40)
    throw new Error('vs.form() takes a list of 1 to 40 fields.');
  const keys = new Set();
  return fields.map((f, i) => {
    const o = options(f, FORM_KEYS, `field ${i + 1} of vs.form()`);
    const type = o.type ?? 'text';
    if (!FORM_TYPES.has(type))
      throw new Error(`Field ${i + 1} of vs.form() has an unknown type "${type}".`);
    const label = String(o.label ?? o.key ?? '').slice(0, 200);
    if (type === 'heading') return { type, label };
    if (
      typeof o.key !== 'string' ||
      !/^[A-Za-z_$][\w$]{0,63}$/.test(o.key) ||
      o.key === '__action' ||
      keys.has(o.key)
    ) {
      throw new Error(
        `Field ${i + 1} of vs.form() needs a unique "key" made of letters and digits.`,
      );
    }
    keys.add(o.key);
    const field = { key: o.key, label, type };
    for (const k of ['min', 'max', 'step'])
      if (o[k] !== undefined) field[k] = numberOpt(o, k, `field "${o.key}"`);
    if (o.help !== undefined) field.help = String(o.help).slice(0, 300);
    if (type === 'checkbox') field.value = Boolean(o.value);
    else if (['number', 'length', 'percent', 'angle'].includes(type))
      field.value = finite(o.value) ? o.value : 0;
    else field.value = o.value == null ? '' : String(o.value).slice(0, 10000);
    if (type === 'select' || type === 'radio') {
      if (!Array.isArray(o.options) || !o.options.length || o.options.length > 200)
        throw new Error(`Field "${o.key}" of vs.form() needs a list of options.`);
      field.options = o.options.map((opt) =>
        opt && typeof opt === 'object'
          ? { value: String(opt.value), label: String(opt.label ?? opt.value) }
          : { value: String(opt), label: String(opt) },
      );
      if (!field.options.some((opt) => opt.value === field.value))
        field.value = field.options[0].value;
    }
    return field;
  });
}

const FILTER_KEYS = [
  'type',
  'fill',
  'stroke',
  'closed',
  'within',
  'selected',
  'visible',
  'compoundParts',
  'fields',
];

/** A paint test from a filter value: true (any), false or 'none' (none), '#rrggbb' (that solid color). */
function paintTest(v, key) {
  if (v === undefined) return null;
  if (v === true) return (p) => Boolean(p);
  if (v === false || v === 'none') return (p) => !p;
  if (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v)) {
    const want = v.toLowerCase();
    return (p) => p?.type === 'solid' && String(p.color).toLowerCase() === want;
  }
  throw new Error(`"${key}" of vs.objects() must be true, false or a "#rrggbb" color.`);
}

/**
 * Run a script against the app's active editor. Resolves to
 * { ok, value?, error?, line?, stopped?, changes } when the script
 * finishes. A script that goes `timeoutMs` without reporting progress is
 * stopped (time spent waiting for the user or on geometry work in the app does not count); `signal`
 * (an AbortSignal) and the Stop button in the status bar stop it any time.
 * `onProgress(fraction, message)` follows its progress reports.
 */
export function runScript(
  app,
  source,
  { name = 'Script', timeoutMs = SILENCE_LIMIT_MS, signal = null, onProgress = null } = {},
) {
  const editor = app.editor;
  if (!editor) return Promise.resolve({ ok: false, error: 'Open a document to run a script.' });
  const doc = editor.doc;
  let status = null;
  let reportProgress = () => {};
  const { api, changes: count } = scriptAPI(app, editor, name, {
    progress: (v, msg) => reportProgress(v, msg),
  });

  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none';
    let done = false;
    let timer = 0;
    let left = timeoutMs;
    let since = 0;
    let asking = 0;
    const commandWatchers = new Set();
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const cleanup of commandWatchers) cleanup();
      window.removeEventListener('message', onMessage);
      signal?.removeEventListener('abort', onAbort);
      status?.remove();
      frame.remove();
      resolve({ ...result, changes: count() });
    };
    const stop = () => finish({ ok: false, stopped: true, error: 'Stopped.' });
    const onAbort = () => stop();
    if (signal?.aborted) {
      resolve({ ok: false, stopped: true, error: 'Stopped.', changes: 0 });
      return;
    }
    signal?.addEventListener('abort', onAbort);
    status = scriptStatus(app, name, stop);
    // The time limit stops runaway scripts; waiting for the user or for app work does not count, and progress starts it over.
    const resume = () => {
      since = Date.now();
      timer = setTimeout(
        () =>
          finish({
            ok: false,
            error: `The script ran longer than ${duration(timeoutMs)} without reporting progress and was stopped. Long scripts call vs.progress() now and then.`,
          }),
        left,
      );
    };
    const pause = () => {
      clearTimeout(timer);
      left = Math.max(0, left - (Date.now() - since));
    };
    const hold = () => {
      if (!asking++) pause();
    };
    const release = () => {
      if (!--asking && !done) resume();
    };
    reportProgress = (value, message) => {
      if (done) return;
      left = timeoutMs;
      if (!asking) {
        clearTimeout(timer);
        resume();
      }
      status?.update(value, message);
      onProgress?.(value, message);
    };
    /** While a menu command runs, the time its own dialogs (Move..., Offset Path...) are open does not count either. */
    const watchDialogs = () => {
      let held = false;
      const sync = () => {
        if (done) return;
        const open = Boolean(document.querySelector('dialog[open]'));
        if (open === held) return;
        held = open;
        if (open) hold();
        else release();
      };
      const observer = new MutationObserver(sync);
      observer.observe(document.body, { childList: true });
      const cleanup = () => {
        if (!commandWatchers.delete(cleanup)) return;
        observer.disconnect();
        if (held) release();
      };
      commandWatchers.add(cleanup);
      sync();
      return cleanup;
    };
    resume();
    const onMessage = async (e) => {
      if (e.source !== frame.contentWindow) return;
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.__vs === 'ready') {
        const root = doc.root;
        const units = root.units || 'pt';
        frame.contentWindow.postMessage(
          {
            __vs: 'run',
            source,
            doc: {
              name: editor.name || root.name,
              units,
              pointsPerUnit: UNITS[units]?.factor || 1,
              artboards: (root.artboards || []).map((a) => ({
                name: a.name,
                x: a.x,
                y: a.y,
                w: a.w,
                h: a.h,
              })),
            },
          },
          '*',
        );
      } else if (m.__vs === 'call') {
        let reply;
        const asks = ASKS_USER.has(m.method) || APP_WORK.has(m.method);
        if (asks) hold();
        const unwatch = m.method === 'command' ? watchDialogs() : null;
        try {
          const fn = Object.hasOwn(api, m.method) ? api[m.method] : null;
          if (!fn) throw new Error(`Unknown API "${m.method}".`);
          reply = {
            __vs: 'reply',
            id: m.id,
            value: await fn(...(Array.isArray(m.args) ? m.args : [])),
          };
        } catch (err) {
          reply = { __vs: 'reply', id: m.id, error: err?.message || String(err) };
        }
        unwatch?.();
        if (asks) release();
        if (!done) frame.contentWindow?.postMessage(reply, '*');
      } else if (m.__vs === 'done') {
        const line = Number.isInteger(m.line) && m.line > 0 ? m.line : null;
        finish(
          m.error
            ? { ok: false, error: String(m.error), ...(line ? { line } : {}) }
            : { ok: true, value: m.value },
        );
      }
    };
    window.addEventListener('message', onMessage);
    frame.srcdoc = `<!doctype html><meta charset="utf-8">${BOOT}`;
    document.body.append(frame);
  });
}

/**
 * The status bar item of a running script: its name, progress and a Stop
 * button. It shows after a moment, so quick scripts do not flash it.
 */
function scriptStatus(app, name, stop) {
  const row = app.statusbar?.el?.querySelector('.status-row');
  if (!row) return { update() {}, remove() {} };
  const label = document.createElement('span');
  label.className = 'status-script-label';
  const bar = document.createElement('progress');
  bar.className = 'status-script-bar';
  bar.max = 1;
  bar.setAttribute('aria-label', `${name} progress`);
  bar.removeAttribute('value');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn small status-script-stop';
  button.textContent = 'Stop';
  button.setAttribute('aria-label', `Stop ${name}`);
  button.addEventListener('click', stop);
  const el = document.createElement('div');
  el.className = 'status-group status-script';
  el.setAttribute('role', 'status');
  el.append(label, bar, button);
  label.textContent = `${name}...`;
  const show = setTimeout(() => row.insertBefore(el, row.querySelector('.status-spacer')), 400);
  return {
    el,
    update(value, message) {
      label.textContent = message ? `${name}: ${message}` : `${name}...`;
      if (value == null) bar.removeAttribute('value');
      else bar.value = Math.max(0, Math.min(1, value));
    },
    remove() {
      clearTimeout(show);
      el.remove();
    },
  };
}

/** The app side of the script API for one run: { api, changes() }. `hooks.progress(value, message)` gets progress reports. */
export function scriptAPI(app, editor, name, hooks = {}) {
  const doc = editor.doc;
  const runKey = `script:${Date.now()}:${Math.random()}`;
  let changes = 0;
  // Every undo step added from here on (changes and commands, however far apart) is part of this run.
  const earlier = new Set(doc.undoStack);
  const asOneStep = () => {
    const stack = doc.undoStack;
    let n = 0;
    while (n < stack.length && !earlier.has(stack[stack.length - 1 - n])) n++;
    if (n > 1 || (n === 1 && stack[stack.length - 1].label !== name)) doc.mergeHistory(n, name);
  };

  const checkOpen = () => {
    if (!app.editors.includes(editor))
      throw new Error('The document the script runs on was closed.');
  };
  const mutate = (fn) => {
    checkOpen();
    let out;
    doc.transact(
      name,
      () => {
        out = fn();
      },
      { coalesce: runKey },
    );
    changes++;
    asOneStep();
    return out;
  };
  const check = (id) => {
    const n = isId(id) ? doc.get(id) : null;
    if (!n || n.type === 'root') throw new Error(`No object with id "${id}".`);
    return n;
  };
  /** A checked patch for a node: { clean, keys }. */
  const cleanPatch = (id, patch) => {
    const node = check(id);
    if (patch == null || typeof patch !== 'object' || Array.isArray(patch))
      throw new Error(`The changes for "${id}" must be an object.`);
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => !LOCKED_KEYS.has(k)));
    if ('anchors' in clean) clean.anchors = toAnchors(clean.anchors);
    checkValues({ ...node, ...clean }, Object.keys(clean));
    return clean;
  };
  /** Where new objects go: { parentId, index } (layers go to the top level unless given a layer). */
  const target = (opts, what, layer = false) => {
    const o = options(opts, ['parent', 'index'], what);
    let parentId;
    if (o.parent != null) {
      const p = check(o.parent);
      if (!p.children || p.type === 'compound')
        throw new Error(`"${o.parent}" cannot hold objects.`);
      if (layer && p.type !== 'layer') throw new Error('A layer can only go into another layer.');
      parentId = p.id;
    } else parentId = layer ? 'root' : editor.targetLayer().id;
    const index = numberOpt(o, 'index', what, { min: 0 }) ?? Infinity;
    return { parentId, index };
  };
  const built = (data) => {
    const b = nodeFromJSON(data);
    checkValues(b.node, Object.keys(b.node));
    return b;
  };
  const leafNodes = (list) => list.map((id) => check(id));
  const api = {
    selection: () => editor.selectedNodes().map(plain),
    objects: (filter) => {
      const f = options(filter, FILTER_KEYS, 'vs.objects()');
      const types = f.type == null ? null : new Set([].concat(f.type).map(String));
      const fillOk = paintTest(f.fill, 'fill');
      const strokeOk = paintTest(f.stroke, 'stroke');
      const closed = boolOpt(f, 'closed', 'vs.objects()');
      const visible = boolOpt(f, 'visible', 'vs.objects()');
      const parts = boolOpt(f, 'compoundParts', 'vs.objects()');
      const fields = f.fields == null ? null : [].concat(f.fields).map(String);
      let start = 'root';
      if (f.within != null) start = check(f.within).id;
      let roots = [start];
      if (boolOpt(f, 'selected', 'vs.objects()'))
        roots = doc.sortByPaintOrder(editor.topSelection());
      const out = [];
      const visit = (n) => {
        if (!n) return false;
        if (visible && n.hidden) return false;
        const inCompound = n.type === 'path' && doc.get(n.parent)?.type === 'compound';
        if (n.type !== 'layer' && (!inCompound || parts)) {
          let ok = !types || types.has(n.type);
          if (ok && fillOk)
            ok =
              (n.type === 'path' || n.type === 'compound' || n.type === 'text') && fillOk(n.fill);
          if (ok && strokeOk)
            ok =
              (n.type === 'path' || n.type === 'compound' || n.type === 'text') &&
              strokeOk(n.stroke);
          if (ok && closed !== undefined)
            ok = n.type === 'compound' ? closed : n.type === 'path' && Boolean(n.closed) === closed;
          if (ok) {
            if (fields) {
              const o = { id: n.id, type: n.type, parent: n.parent };
              for (const k of fields) if (n[k] !== undefined) o[k] = n[k];
              out.push(plain(o));
            } else out.push(plain(n));
          }
        }
        return true;
      };
      for (const r of roots) doc.walk(visit, r);
      return out;
    },
    layers: () => {
      const out = [];
      doc.walk((n) => {
        if (n.type !== 'layer') return false;
        out.push({
          id: n.id,
          name: n.name,
          hidden: Boolean(n.hidden),
          locked: Boolean(n.locked),
          parent: n.parent,
        });
        return true;
      });
      return out;
    },
    get: (ids) => {
      const { list, many } = idArg(ids, 'vs.get()');
      const out = list.map((id) => plain(doc.get(id)));
      return many ? out : out[0];
    },
    update: (id, patch) => {
      const clean = cleanPatch(id, patch);
      mutate(() => doc.update(id, clean));
      return true;
    },
    updateMany: (list) => {
      if (!Array.isArray(list) || list.length > MAX_BATCH)
        throw new Error(
          `vs.updateMany() takes a list of up to ${MAX_BATCH} { id, patch } changes.`,
        );
      // Everything is checked before anything changes.
      const work = list.map((c, i) => {
        if (!c || typeof c !== 'object')
          throw new Error(`Change ${i + 1} of vs.updateMany() must be { id, patch }.`);
        return [c.id, cleanPatch(c.id, c.patch)];
      });
      if (work.length) mutate(() => work.forEach(([id, clean]) => doc.update(id, clean)));
      return work.length;
    },
    create: (data, opts) => {
      const b = built(data);
      const at = target(opts, 'vs.create()', b.node.type === 'layer');
      return mutate(() => doc.insert(b.node, at.parentId, at.index, b.descendants)).id;
    },
    createMany: (list, opts) => {
      if (!Array.isArray(list) || list.length > MAX_BATCH)
        throw new Error(`vs.createMany() takes a list of up to ${MAX_BATCH} objects.`);
      const items = list.map(built);
      if (!items.length) return [];
      const layers = items.filter((b) => b.node.type === 'layer').length;
      if (layers && layers !== items.length)
        throw new Error('vs.createMany() makes either layers or other objects, not both at once.');
      const at = target(opts, 'vs.createMany()', layers > 0);
      return mutate(() => {
        let index = at.index;
        return items.map((b) => {
          const id = doc.insert(b.node, at.parentId, index, b.descendants).id;
          if (index !== Infinity) index++;
          return id;
        });
      });
    },
    duplicate: (ids, opts) => {
      const { list, many } = idArg(ids, 'vs.duplicate()');
      leafNodes(list);
      const o = options(opts, ['parent', 'index'], 'vs.duplicate()');
      const sorted = doc.sortByPaintOrder([...new Set(list)]);
      let made;
      if (o.parent == null && o.index == null) made = mutate(() => duplicateNodes(doc, sorted));
      else {
        const at = target(o, 'vs.duplicate()');
        made = mutate(() => {
          let index = at.index;
          return sorted.map((id) => {
            const { node, descendants } = doc.cloneSubtree(id);
            const copy = doc.insert(node, at.parentId, index, descendants).id;
            if (index !== Infinity) index++;
            return copy;
          });
        });
      }
      // Copies line up with the ids given (an object inside another one given makes no copy of its own).
      const copyOf = new Map();
      if (made.length === sorted.length) sorted.forEach((id, i) => copyOf.set(id, made[i]));
      const out = copyOf.size ? list.map((id) => copyOf.get(id)) : made;
      return many ? out : out[0];
    },
    remove: (ids) => {
      const { list } = idArg(ids, 'vs.remove()');
      leafNodes(list);
      let n = 0;
      mutate(() => {
        for (const id of list) {
          if (!doc.has(id)) continue;
          doc.remove(id);
          n++;
        }
      });
      return n;
    },
    select: (ids) => {
      checkOpen();
      const { list } = idArg(ids ?? [], 'vs.select()');
      editor.select(list.filter((id) => doc.get(id) && doc.get(id).type !== 'layer'));
      return true;
    },
    bounds: (ids, opts) => {
      const o = options(opts, ['visual'], 'vs.bounds()');
      const visual = Boolean(boolOpt(o, 'visual', 'vs.bounds()'));
      const { list, many } = idArg(ids, 'vs.bounds()');
      const out = leafNodes(list).map((n) => boundsOf(doc, n, visual));
      return many ? out : out[0];
    },
    area: async (ids) => {
      const { list, many } = idArg(ids, 'vs.area()');
      const out = await areasOf(doc, leafNodes(list));
      return many ? out : out[0];
    },
    labelPoint: async (ids, opts) => {
      const o = options(opts, ['precision'], 'vs.labelPoint()');
      const precision = numberOpt(o, 'precision', 'vs.labelPoint()', { min: 0.0001, max: 1e6 });
      const { list, many } = idArg(ids, 'vs.labelPoint()');
      const out = await labelPointsOf(doc, leafNodes(list), { precision });
      return many ? out : out[0];
    },
    pathfinder: async (kind, ids, opts) => {
      if (!PATHFINDER_KINDS.includes(kind))
        throw new Error(
          `Unknown pathfinder "${kind}". Use one of: ${PATHFINDER_KINDS.join(', ')}.`,
        );
      const o = options(
        opts,
        ['precision', 'removeRedundant', 'removeUnpainted'],
        'vs.pathfinder()',
      );
      const settings = {};
      const precision = numberOpt(o, 'precision', 'vs.pathfinder()', { min: 0.001, max: 100 });
      if (precision !== undefined) settings.precision = precision;
      for (const k of ['removeRedundant', 'removeUnpainted']) {
        const v = boolOpt(o, k, 'vs.pathfinder()');
        if (v !== undefined) settings[k] = v;
      }
      const { list } = idArg(ids, 'vs.pathfinder()');
      leafNodes(list);
      checkOpen();
      return pathfinderOn(doc, kind, list, settings, mutate);
    },
    offsetPath: async (ids, opts) => {
      const o = options(opts, ['offset', 'joins', 'miterLimit'], 'vs.offsetPath()');
      const offset = numberOpt(o, 'offset', 'vs.offsetPath()', {
        min: -1e5,
        max: 1e5,
        required: true,
      });
      const miterLimit = numberOpt(o, 'miterLimit', 'vs.offsetPath()', { min: 1, max: 500 });
      const { list } = idArg(ids, 'vs.offsetPath()');
      leafNodes(list);
      checkOpen();
      return offsetOn(
        doc,
        list,
        { offset, joins: o.joins ?? 'miter', miterLimit: miterLimit ?? 4 },
        mutate,
      );
    },
    outlineStroke: async (ids, opts) => {
      const o = options(opts, ['keepFill'], 'vs.outlineStroke()');
      const keepFill = boolOpt(o, 'keepFill', 'vs.outlineStroke()') ?? true;
      const { list } = idArg(ids, 'vs.outlineStroke()');
      leafNodes(list);
      checkOpen();
      return outlineStrokeOn(app, doc, list, { keepFill }, mutate);
    },
    command: async (id) => {
      if (typeof id !== 'string' || !app.commands.get(id))
        throw new Error(`Unknown command "${id}".`);
      // Commands act on the active document: make it the script's again if another tab was chosen.
      checkOpen();
      if (app.editor !== editor) app.activate(editor);
      if (!app.commands.isEnabled(id))
        throw new Error(`Command "${id}" cannot be used with the current selection.`);
      await app.commands.run(id, undefined, { throwOnError: true });
      changes++;
      asOneStep();
      return true;
    },
    exportSVG: async (opts) =>
      app.exporters?.svg?.(editor, options(opts, ['artboard', 'selection'], 'vs.exportSVG()')) ??
      null,
    download: (fileName, text, type) => {
      downloadBlob(
        new Blob([String(text)], { type: String(type || 'text/plain') }),
        String(fileName || 'output.txt'),
      );
      return true;
    },
    progress: (value, message) => {
      if (value != null && !finite(value))
        throw new Error('vs.progress() takes a number from 0 to 1, or null.');
      hooks.progress?.(
        value == null ? null : Math.max(0, Math.min(1, value)),
        String(message ?? '').slice(0, 200),
      );
      return true;
    },
    form: async (title, fields) => {
      const list = formFields(fields);
      const v = await app.dialogs.form({
        title: String(title || name).slice(0, 200),
        fields: list,
      });
      if (!v) return null;
      const out = {};
      for (const f of list) if (f.key) out[f.key] = v[f.key];
      return out;
    },
    prompt: async (label, value) => {
      const v = await app.dialogs.form({
        title: name,
        fields: [{ key: 'v', label, type: 'text', value }],
      });
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

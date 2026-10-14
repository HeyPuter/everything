/**
 * The shared document: how the editor's model maps onto a Yjs document for
 * real-time co-editing (see docs/collaboration.md).
 *
 *   body      Y.Text. Every body paragraph is its characters followed by one
 *             paragraph-mark character ("\n"), the last paragraph included, so
 *             a model position is the same index in the shared text. A text
 *             character carries its run's formatting as attributes `r:<key>`
 *             (JSON values; defaults are left out). A mark carries the
 *             paragraph's properties as `p:<key>`. Zero-width markers kept in
 *             paragraph arrays with an `offset` (bookmarks, comment and
 *             permission anchors, field markers) ride on the character at their
 *             offset as `m:<list>:<key>`, so text typed before them moves them.
 *             Objects that must stay separate runs (pictures, equations,
 *             fields, note references) get a unique `u` attribute.
 *   parts     Y.Map of atomic registers, one per table, style, numbering
 *             definition, page setting and edited header/footer/note story.
 *   comments  Y.Map: comment id → JSON (outside the body so comment-only
 *             participants can be checked by the server).
 *   assets    Y.Map: pictures added after sharing (bytes, and their metadata).
 *   meta      Y.Map: schema, editing mode ('shared' or 'single') and the
 *             single-editor lock and snapshot.
 *
 * Splitting a paragraph inserts a mark; joining two deletes one; typing,
 * deleting and formatting are character operations; so concurrent edits merge
 * as text does. Tables and drawings are atomic: the last structural change to
 * a table wins and its cells' paragraphs stay in the shared text.
 */
import * as Y from 'yjs';
import { RUN_FORMAT } from '../engine/formatting.js';
import { diffText } from './text-diff.js';

export const SCHEMA = 1;
export const MARK = '\n';
/** The comments map's marker that the document has a comments part (possibly empty). */
const PRESENT = '$part';
/** Runs the editor never merges with their neighbours (see normalize() in model.js). */
export const SEPARATE_RUNS = ['image', 'math', 'field', 'noteMark', 'bodySymbol', 'noBreakHyphen', 'breakClear'];

const RUN_DEFAULTS = Object.fromEntries(Object.entries(RUN_FORMAT).map(([k, v]) => [k, JSON.stringify(v)]));
const json = value => JSON.stringify(value);
const isMarkerList = value => Array.isArray(value) && value.length > 0 && value.every(m => m && typeof m === 'object' && !Array.isArray(m) && Number.isFinite(m.offset));
const paragraphLength = p => p.runs.reduce((n, r) => n + (r.text?.length || 0), 0);

/** Why a document cannot be co-edited character by character, or null. */
export function unsupportedReason(state) {
  for (const p of state.paragraphs) {
    for (const run of p.runs) {
      if (!run.text && run.contentControl) return 'content controls without text';
      if (run.text.includes(MARK)) return 'line feeds inside a run';
    }
  }
  return null;
}

/* ---------- Encoding a paragraph ---------- */

function markerKey(list, marker, index, used) {
  let key = marker.id !== undefined ? `${marker.id}|${marker.edge ?? ''}` : `${marker.type ?? ''}|${marker.order ?? index}`;
  if (used.has(key)) { let n = 2; while (used.has(`${key}#${n}`)) n++; key = `${key}#${n}`; }
  used.add(key);
  return `m:${list}:${key}`;
}

function runAttributes(run) {
  const attrs = {};
  for (const key of Object.keys(run)) {
    if (key === 'text') continue;
    const value = run[key];
    if (value === undefined) continue;
    const text = json(value);
    if (RUN_DEFAULTS[key] === text) continue;
    attrs[`r:${key}`] = text;
  }
  return attrs;
}

const attrKey = attrs => {
  const keys = Object.keys(attrs).sort();
  let out = '';
  for (const k of keys) out += `${k}\u0001${attrs[k]}\u0002`;
  return out;
};

/**
 * A paragraph as shared characters: its text with the mark, one attribute set
 * per character (as a canonical key into `attrs`), and for each character the
 * index of a separate run it belongs to (or -1).
 */
export function encodeParagraph(p) {
  const markers = new Map(); // offset → attributes
  const markLists = {};
  for (const [list, value] of Object.entries(p)) {
    if (list === 'runs' || !isMarkerList(value)) continue;
    markLists[list] = true;
    const used = new Set();
    value.forEach((marker, index) => {
      const { offset, ...rest } = marker;
      const at = Math.max(0, Math.min(offset, paragraphLength(p)));
      const bucket = markers.get(at) || {};
      bucket[markerKey(list, marker, index, used)] = json({ ...rest, _i: index });
      markers.set(at, bucket);
    });
  }
  const keys = [], attrs = new Map(), separate = [];
  let text = '', at = 0;
  const add = (char, base, baseKey, separateIndex) => {
    const extra = markers.get(at);
    let key = baseKey, value = base;
    if (extra) { value = { ...base, ...extra }; key = attrKey(value); }
    if (!attrs.has(key)) attrs.set(key, value);
    keys.push(key); separate.push(separateIndex); text += char; at++;
  };
  p.runs.forEach((run, runIndex) => {
    const base = runAttributes(run), baseKey = attrKey(base);
    const isSeparate = SEPARATE_RUNS.some(k => run[k]);
    for (const char of run.text) for (let i = 0; i < char.length; i++) add(char[i], base, baseKey, isSeparate ? runIndex : -1);
  });
  const mark = {};
  for (const key of Object.keys(p)) {
    if (key === 'runs' || markLists[key] || p[key] === undefined) continue;
    mark[`p:${key}`] = json(p[key]);
  }
  add(MARK, mark, attrKey(mark), -1);
  return { text, keys, attrs, separate };
}

/* ---------- Reading the shared body ---------- */

const decode = text => { try { return JSON.parse(text); } catch { return undefined; } };

/** The body's paragraphs as the editor's model holds them. */
export function readBody(ytext) {
  const paragraphs = [];
  let runs = [], markers = {}, seenMarkers = new Set(), offset = 0, lastRunKey = null;
  const ids = new Set();
  const finishParagraph = attrs => {
    const p = { runs };
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key.startsWith('p:')) { const v = decode(value); if (v !== undefined) p[key.slice(2)] = v; }
    }
    addMarkers(attrs, offset);
    for (const [list, entries] of Object.entries(markers)) {
      p[list] = entries.sort((a, b) => a._i - b._i || a.offset - b.offset).map(({ _i, ...m }) => m);
    }
    if (!p.id) p.id = `shared-p${paragraphs.length + 1}`;
    // Ids are unique in the projection even after concurrent splits that copied one.
    if (ids.has(p.id)) { let n = 2; while (ids.has(`${p.id}~${n}`)) n++; p.id = `${p.id}~${n}`; }
    ids.add(p.id);
    paragraphs.push(p);
    runs = []; markers = {}; offset = 0; lastRunKey = null;
  };
  const addMarkers = (attrs, at) => {
    for (const [key, value] of Object.entries(attrs || {})) {
      if (!key.startsWith('m:')) continue;
      // A marker duplicated by concurrent edits keeps its first place.
      if (seenMarkers.has(key)) continue;
      seenMarkers.add(key);
      const list = key.slice(2, key.indexOf(':', 2));
      const marker = decode(value);
      if (!marker || typeof marker !== 'object') continue;
      (markers[list] ||= []).push({ ...marker, offset: at, _i: marker._i ?? 0 });
    }
  };
  for (const op of ytext.toDelta()) {
    if (typeof op.insert !== 'string') continue; // embeds are not used
    const attrs = op.attributes || {};
    const runAttrs = {};
    for (const [key, value] of Object.entries(attrs)) if (key.startsWith('r:') || key === 'u') runAttrs[key] = value;
    const runKey = attrKey(runAttrs);
    const pieces = op.insert.split(MARK);
    pieces.forEach((piece, i) => {
      if (piece) {
        addMarkers(attrs, offset);
        const last = runs.at(-1);
        // Characters with the same attributes (a separate object's unique tag included) form one run.
        if (last && lastRunKey === runKey) last.text += piece;
        else {
          const run = { text: piece, ...RUN_FORMAT };
          for (const [key, value] of Object.entries(runAttrs)) if (key.startsWith('r:')) { const v = decode(value); if (v !== undefined) run[key.slice(2)] = v; }
          runs.push(run);
        }
        lastRunKey = runKey;
        offset += piece.length;
      }
      if (i < pieces.length - 1) finishParagraph(attrs);
    });
  }
  // A body always ends with a mark; tolerate text after the last one. An empty
  // shared text has no paragraphs at all (the model then starts with one).
  if (runs.length) finishParagraph({});
  return paragraphs;
}

/* ---------- Registers ---------- */

/** The non-body parts of a state as register key → JSON text. */
export function encodeParts(state) {
  const out = new Map();
  (state.tables || []).forEach((table, i) => out.set(`t:${table.id}`, json({ ...table, _order: i })));
  const styles = state.styles;
  if (styles) {
    for (const [id, def] of Object.entries(styles.definitions || {})) out.set(`s:${id}`, json(def));
    for (const [key, value] of Object.entries(styles)) if (key !== 'definitions' && value !== undefined) out.set(`S:${key}`, json(value));
  }
  out.set('S:$enabled', json(!!state.stylesEnabled));
  const numbering = state.numbering;
  if (numbering) {
    for (const [id, def] of Object.entries(numbering.abstracts || {})) out.set(`na:${id}`, json(def));
    for (const [id, def] of Object.entries(numbering.instances || {})) out.set(`ni:${id}`, json(def));
    for (const [key, value] of Object.entries(numbering)) if (key !== 'abstracts' && key !== 'instances' && value !== undefined) out.set(`N:${key}`, json(value));
  }
  for (const [key, value] of Object.entries(state.pageSettings || {})) if (value !== undefined) out.set(`g:${key}`, json(value));
  for (const [path, story] of Object.entries(state.stories || {})) out.set(`x:${path}`, json({ paragraphs: story.paragraphs, tables: story.tables || [] }));
  if (state.trackChanges !== undefined) out.set('d:trackChanges', json(state.trackChanges));
  return out;
}

/** The parts registers as state fields; tables come back in body order. */
export function readParts(parts, paragraphs) {
  const tables = [], definitions = {}, styles = {}, abstracts = {}, instances = {}, numbering = {}, pageSettings = {}, stories = {};
  let stylesEnabled = false, trackChanges;
  for (const [key, text] of parts.entries()) {
    const value = decode(text);
    if (value === undefined) continue;
    const colon = key.indexOf(':'), kind = key.slice(0, colon), name = key.slice(colon + 1);
    if (kind === 't') tables.push(value);
    else if (kind === 's') definitions[name] = value;
    else if (kind === 'S') { if (name === '$enabled') stylesEnabled = !!value; else styles[name] = value; }
    else if (kind === 'na') abstracts[name] = value;
    else if (kind === 'ni') instances[name] = value;
    else if (kind === 'N') numbering[name] = value;
    else if (kind === 'g') pageSettings[name] = value;
    else if (kind === 'x') stories[name] = value;
    else if (key === 'd:trackChanges') trackChanges = value;
  }
  // Tables follow the order their cells appear in the body; nested tables after their parents.
  const firstUse = new Map();
  paragraphs.forEach((p, i) => { if (p.cellId && !firstUse.has(p.cellId)) firstUse.set(p.cellId, i); });
  const position = table => Math.min(Infinity, ...table.rows.flatMap(row => row.cells.map(cell => firstUse.get(cell.id) ?? Infinity)));
  // Tables keep their recorded order; tables added concurrently fall back to where their cells are.
  tables.sort((a, b) => (a._order ?? 0) - (b._order ?? 0) || position(a) - position(b) || String(a.id).localeCompare(String(b.id)));
  for (const table of tables) delete table._order;
  return { tables, styles: { ...styles, definitions }, stylesEnabled, numbering: { ...numbering, abstracts, instances }, pageSettings, stories, trackChanges };
}

export function readComments(map) {
  const list = [];
  for (const [id, text] of map.entries()) { if (id === PRESENT) continue; const value = decode(text); if (value) list.push(value); }
  // Comments keep their document order: by the order they were recorded, then id.
  return list.sort((a, b) => (a._order ?? 0) - (b._order ?? 0) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true })).map(({ _order, ...c }) => c);
}

/** The whole model state the shared document holds. */
export function readState(ydoc) {
  const paragraphs = readBody(ydoc.getText('body'));
  const parts = readParts(ydoc.getMap('parts'), paragraphs);
  // A document without a comments part reads as null until someone comments (the part is then created).
  const map = ydoc.getMap('comments');
  const comments = map.size ? readComments(map) : null;
  return { paragraphs, ...parts, comments };
}

/* ---------- Writing local changes ---------- */

let uniqueCounter = 0;
const freshUnique = ydoc => `${ydoc.clientID.toString(36)}.${(++uniqueCounter).toString(36)}`;

function concatEncodings(paragraphs) {
  let text = '';
  const keys = [], attrs = new Map(), separate = [];
  paragraphs.forEach((p, pi) => {
    const e = p.encoding;
    text += e.text;
    for (let i = 0; i < e.keys.length; i++) { keys.push(e.keys[i]); separate.push(e.separate[i] < 0 ? -1 : `${pi}:${e.separate[i]}`); }
    for (const [k, v] of e.attrs) attrs.set(k, v);
  });
  return { text, keys, attrs, separate };
}

const encodingCache = new Map();
/** Encode with a small cache keyed by the paragraph's JSON. */
export function encoded(p) {
  const key = json(p);
  let e = encodingCache.get(key);
  if (!e) {
    e = encodeParagraph(p);
    if (encodingCache.size > 4000) encodingCache.clear();
    encodingCache.set(key, e);
  }
  return { key, encoding: e };
}

/**
 * Write the difference between the body the shared document holds (`before`,
 * as read by readBody) and the editor's paragraphs (`after`) into `ytext`.
 * Untouched paragraphs at both ends are skipped; inside the changed stretch a
 * character diff finds insertions and deletions, and characters kept whose
 * attributes changed are reformatted. Returns whether anything was written.
 */
export function writeBody(ytext, before, after, cache = null) {
  const ydoc = ytext.doc;
  // `cache.body` holds the encodings of what the shared text holds when nothing else changed it since.
  const old = cache?.body || before.map(encoded), next = after.map(encoded);
  if (cache) cache.body = next;
  let head = 0;
  while (head < old.length && head < next.length && old[head].key === next[head].key) head++;
  let tailOld = old.length, tailNew = next.length;
  while (tailOld > head && tailNew > head && old[tailOld - 1].key === next[tailNew - 1].key) { tailOld--; tailNew--; }
  if (head === tailOld && head === tailNew) return false;
  let index = 0;
  for (let i = 0; i < head; i++) index += old[i].encoding.text.length;
  const a = concatEncodings(old.slice(head, tailOld)), b = concatEncodings(next.slice(head, tailNew));
  const script = diffText(a.text, b.text);
  let ai = 0, bi = 0, pos = index;
  const uniques = new Map();
  const uniqueFor = tag => { if (!uniques.has(tag)) uniques.set(tag, freshUnique(ydoc)); return uniques.get(tag); };
  const insertAttrs = (key, tag) => {
    const attrs = { ...b.attrs.get(key) };
    if (tag !== -1) attrs.u = uniqueFor(tag);
    return attrs;
  };
  for (const segment of script) {
    if (segment.type === 'delete') { ytext.delete(pos, segment.length); ai += segment.length; continue; }
    if (segment.type === 'insert') {
      let start = 0;
      while (start < segment.length) {
        const key = b.keys[bi + start], tag = b.separate[bi + start];
        let end = start + 1;
        while (end < segment.length && b.keys[bi + end] === key && b.separate[bi + end] === tag) end++;
        ytext.insert(pos, b.text.slice(bi + start, bi + end), insertAttrs(key, tag));
        pos += end - start; start = end;
      }
      bi += segment.length;
      continue;
    }
    // Equal characters: reformat those whose attributes differ.
    let start = 0;
    while (start < segment.length) {
      const oldKey = a.keys[ai + start], newKey = b.keys[bi + start];
      if (oldKey === newKey && (a.separate[ai + start] === -1) === (b.separate[bi + start] === -1)) { start++; continue; }
      const change = attributeChange(a.attrs.get(oldKey), b.attrs.get(newKey));
      const becameSeparate = a.separate[ai + start] === -1 && b.separate[bi + start] !== -1;
      let end = start + 1;
      while (end < segment.length && a.keys[ai + end] === oldKey && b.keys[bi + end] === newKey && b.separate[bi + end] === b.separate[bi + start]) end++;
      if (becameSeparate) change.u = uniqueFor(b.separate[bi + start]);
      if (Object.keys(change).length) ytext.format(pos + start, end - start, change);
      start = end;
    }
    ai += segment.length; bi += segment.length; pos += segment.length;
  }
  return true;
}

function attributeChange(before = {}, after = {}) {
  const change = {};
  for (const key of Object.keys(before)) if (!(key in after)) change[key] = null;
  for (const [key, value] of Object.entries(after)) if (before[key] !== value) change[key] = value;
  return change;
}

/** Set and delete registers so `map` holds `entries` (key → JSON text). */
export function writeRegisters(map, entries, { keep = () => false } = {}) {
  let changed = false;
  for (const key of [...map.keys()]) if (!entries.has(key) && !keep(key)) { map.delete(key); changed = true; }
  for (const [key, value] of entries) if (map.get(key) !== value) { map.set(key, value); changed = true; }
  return changed;
}

export function encodeComments(comments) {
  return new Map((comments || []).map((c, i) => [String(c.id), json({ ...c, _order: i })]));
}

/** Write a whole model state into the shared document (one transaction). */
export function writeState(ydoc, state, origin = null, cache = null) {
  let changed = false;
  ydoc.transact(() => {
    const before = cache?.body ? null : readBody(ydoc.getText('body'));
    changed = writeBody(ydoc.getText('body'), before, state.paragraphs, cache) || changed;
    changed = writeRegisters(ydoc.getMap('parts'), encodeParts(state)) || changed;
    if (state.comments) {
      if (!ydoc.getMap('comments').has(PRESENT)) ydoc.getMap('comments').set(PRESENT, 'true');
      // Comment order is recorded once; reordering alone is not a change.
      const map = ydoc.getMap('comments'), entries = encodeComments(state.comments);
      for (const [id, text] of entries) {
        const current = map.get(id);
        if (current === undefined) { map.set(id, text); changed = true; continue; }
        const strip = t => { const { _order, ...rest } = JSON.parse(t); return json(rest); };
        if (strip(current) !== strip(text)) { map.set(id, json({ ...JSON.parse(text), _order: JSON.parse(current)._order })); changed = true; }
      }
      for (const id of [...map.keys()]) if (id !== PRESENT && !entries.has(id)) { map.delete(id); changed = true; }
    }
    const meta = ydoc.getMap('meta');
    if (meta.get('schema') !== SCHEMA) meta.set('schema', SCHEMA);
  }, origin);
  return changed;
}

/** A fresh shared document holding `state`. */
export function createSharedDoc(state, { clientID } = {}) {
  const ydoc = new Y.Doc();
  if (clientID !== undefined) ydoc.clientID = clientID;
  writeState(ydoc, state);
  ydoc.getMap('meta').set('mode', 'shared');
  return ydoc;
}

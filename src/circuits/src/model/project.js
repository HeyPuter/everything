// Runtime project: documents backed by object stores, the embedded component
// library, and conversion to and from the saved JSON format.
//
// Document-level settings (sheet size, board outline, design rules) are kept
// as special objects inside each store ('sheet', 'board', 'rules', 'nets')
// so that editing them is undoable like any other change.

import { ObjectStore } from '../core/store.js';
import { Emitter, uid } from '../core/emitter.js';
import { mm } from '../core/units.js';
import { FORMAT, FORMAT_VERSION, defaultRules } from './schema.js';
import { schBounds } from './sch.js';
import { pcbBounds } from './pcb.js';
import { buildNetlist } from './netlist.js';

export const META_TYPES = new Set(['sheet', 'board', 'rules', 'nets', 'libmeta']);

export const SHEET_SIZES = {
  A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
  Letter: [279.4, 215.9], A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6],
};

/** Sheet extents in nm, origin at the bottom-left corner. */
export function sheetExtents(sheet) {
  const [w, h] = SHEET_SIZES[sheet?.size] || SHEET_SIZES.A4;
  const portrait = sheet?.orientation === 'portrait';
  // Keep sheets on the 100 mil grid so the border lines up with wires.
  const g = 2_540_000;
  const W = Math.round(mm(portrait ? h : w) / g) * g, H = Math.round(mm(portrait ? w : h) / g) * g;
  return { minX: 0, minY: 0, maxX: W, maxY: H };
}

export function defaultSheet() {
  return { id: 'sheet', t: 'sheet', size: 'A4', orientation: 'landscape', title: '', revision: '', author: '', company: '', showBorder: true, showTitleBlock: true, number: 1 };
}

export function defaultBoard() {
  const w = mm(80), h = mm(60);
  return {
    id: 'board', t: 'board',
    outline: [0, 0, w, 0, w, h, 0, h],
    cutouts: [],
    origin: { x: 0, y: 0 },
    copper: 2,
    thickness: mm(1.6),
    maskColor: '#1f5f3a',
    silkColor: '#f4f4f4',
    finish: 'ENIG',
  };
}

export class DocModel extends Emitter {
  constructor(project, { id, kind, name }) {
    super();
    this.project = project;
    this.id = id;
    this.kind = kind;
    this.name = name;
    // project.library is read at call time so replaced definitions take effect.
    const bounds = kind === 'sch' ? (o) => schBounds(o, project.library) : kind === 'pcb' ? (o) => pcbBounds(o, project.library) : () => ({ minX: 1, minY: 1, maxX: 0, maxY: 0 });
    this.store = new ObjectStore({ bounds: (o) => (META_TYPES.has(o.t) ? { minX: 1, minY: 1, maxX: 0, maxY: 0 } : bounds(o)) });
    this.store.on('change', (e) => { project._docChanged(this, e); this.emit('change', e); });
  }

  get meta() { return this.store.get(this.kind === 'sch' ? 'sheet' : 'board'); }
  get sheet() { return this.store.get('sheet'); }
  get board() { return this.store.get('board'); }
  get rules() { return this.store.get('rules'); }
  get nets() { return this.store.get('nets')?.nets || {}; }

  /** Content objects (no metadata entries). */
  *items() { for (const o of this.store.all()) if (!META_TYPES.has(o.t)) yield o; }

  get dirty() { return this.store.dirty; }

  /** Plain document in the saved shape, for the kernel and exporters. */
  snapshot() {
    const objects = [...this.items()];
    if (this.kind === 'sch') return { id: this.id, kind: 'sch', name: this.name, sheet: this.sheet, objects };
    return { id: this.id, kind: 'pcb', name: this.name, board: this.board, rules: this.rules, nets: this.nets, objects };
  }
}

export class Project extends Emitter {
  constructor(data = newProjectData()) {
    super();
    this.id = data.id || uid('p');
    this.name = data.name || 'Untitled';
    this.created = data.created || new Date().toISOString();
    this.modified = data.modified || this.created;
    this.settings = { units: 'mm', ...(data.settings || {}) };
    this.library = { ...(data.library || {}) };
    this.docs = [];
    this._libRevision = 0;
    this._metaDirty = false;
    this._netlistCache = null;
    for (const d of data.documents || []) this._loadDoc(d);
  }

  _loadDoc(d) {
    const doc = new DocModel(this, { id: d.id || uid('d'), kind: d.kind, name: d.name });
    const objs = [...(d.objects || [])];
    if (d.kind === 'sch') objs.push({ ...defaultSheet(), ...(d.sheet || {}), id: 'sheet', t: 'sheet' });
    if (d.kind === 'pcb') {
      objs.push({ ...defaultBoard(), ...(d.board || {}), id: 'board', t: 'board' });
      objs.push({ ...defaultRules(), ...(d.rules || {}), id: 'rules', t: 'rules' });
      objs.push({ id: 'nets', t: 'nets', nets: d.nets || {} });
    }
    doc.store.load(objs);
    this.docs.push(doc);
    return doc;
  }

  getDoc(id) { return this.docs.find((d) => d.id === id) || null; }
  get sheets() { return this.docs.filter((d) => d.kind === 'sch'); }
  get boards() { return this.docs.filter((d) => d.kind === 'pcb'); }

  get dirty() { return this._metaDirty || this.docs.some((d) => d.dirty); }

  markSaved() {
    for (const d of this.docs) d.store.markSaved();
    this._metaDirty = false;
    this.emit('saved');
  }

  touchMeta() { this._metaDirty = true; this.emit('meta'); }

  _docChanged(doc, e) {
    if (doc.kind === 'sch') this._netlistCache = null;
    this.emit('docchange', { doc, ...e });
  }

  uniqueDocName(base, ext) {
    const names = new Set(this.docs.map((d) => d.name.toLowerCase()));
    let i = 1;
    while (names.has(`${base}${i}.${ext}`.toLowerCase())) i++;
    return `${base}${i}.${ext}`;
  }

  addSheet(name) {
    const doc = this._loadDoc({ id: uid('d'), kind: 'sch', name: name || this.uniqueDocName('Sheet', 'sch'), sheet: { number: this.sheets.length + 1 }, objects: [] });
    this.touchMeta();
    this.emit('docs');
    return doc;
  }

  addBoard(name) {
    const doc = this._loadDoc({ id: uid('d'), kind: 'pcb', name: name || this.uniqueDocName('Board', 'pcb'), objects: [] });
    this.touchMeta();
    this.emit('docs');
    return doc;
  }

  removeDoc(id) {
    const i = this.docs.findIndex((d) => d.id === id);
    if (i < 0) return;
    this.docs.splice(i, 1);
    this._netlistCache = null;
    this.touchMeta();
    this.emit('docs');
  }

  renameDoc(id, name) {
    const d = this.getDoc(id);
    if (!d || !name) return;
    d.name = name;
    this.touchMeta();
    this.emit('docs');
  }

  moveDoc(id, delta) {
    const i = this.docs.findIndex((d) => d.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.docs.length) return;
    const [d] = this.docs.splice(i, 1);
    this.docs.splice(j, 0, d);
    this.touchMeta();
    this.emit('docs');
  }

  rename(name) { this.name = name; this.touchMeta(); }

  /** Adds or replaces a component definition, refreshing documents that use it. */
  putComponent(def) {
    const existed = !!this.library[def.id];
    this.library[def.id] = def;
    this._libRevision++;
    this._netlistCache = null;
    if (existed) {
      for (const d of this.docs) {
        const ids = [];
        for (const o of d.store.all()) if ((o.t === 'part' || o.t === 'comp') && o.comp === def.id) ids.push(o.id);
        if (ids.length) d.store.reindex(ids);
      }
    }
    this.touchMeta();
    this.emit('library', { id: def.id });
  }

  /** Copies a definition into the project library if it is not there yet. */
  ensureComponent(def) {
    if (!this.library[def.id]) this.putComponent(structuredClone(def));
    return def.id;
  }

  /** Library entries no document references. */
  unusedComponents() {
    const used = new Set();
    for (const d of this.docs) for (const o of d.store.all()) if (o.comp) used.add(o.comp);
    return Object.keys(this.library).filter((id) => !used.has(id));
  }

  /** Netlist across all sheets, cached until a sheet or the library changes. */
  netlist() {
    if (!this._netlistCache) {
      const sheets = this.sheets.map((d) => ({ id: d.id, name: d.name, objects: [...d.items()] }));
      this._netlistCache = buildNetlist(sheets, this.library);
    }
    return this._netlistCache;
  }

  sheetObjects() {
    return this.sheets.map((d) => ({ id: d.id, name: d.name, objects: [...d.items()] }));
  }

  /** Plain JSON for saving. */
  toJSON() {
    const documents = this.docs.map((d) => {
      const objects = [...d.items()];
      const base = { id: d.id, kind: d.kind, name: d.name };
      if (d.kind === 'sch') return { ...base, sheet: stripMeta(d.sheet || defaultSheet()), objects };
      if (d.kind === 'pcb') return { ...base, board: stripMeta(d.board), rules: stripMeta(d.rules), nets: d.nets, objects };
      return { ...base, objects };
    });
    return {
      format: FORMAT,
      version: FORMAT_VERSION,
      id: this.id,
      name: this.name,
      created: this.created,
      modified: new Date().toISOString(),
      settings: this.settings,
      library: this.library,
      documents,
    };
  }
}

function stripMeta(o) {
  const out = { ...o };
  delete out.id;
  delete out.t;
  return out;
}

export function newProjectData(name = 'Untitled') {
  const now = new Date().toISOString();
  return {
    format: FORMAT, version: FORMAT_VERSION, id: uid('p'), name, created: now, modified: now,
    settings: { units: 'mm' },
    library: {},
    documents: [
      { id: uid('d'), kind: 'sch', name: 'Sheet1.sch', sheet: defaultSheet(), objects: [] },
      { id: uid('d'), kind: 'pcb', name: 'Board1.pcb', board: defaultBoard(), rules: defaultRules(), nets: {}, objects: [] },
    ],
  };
}

const MIN_POINTS = { wire: 2, bus: 2, gline: 2, pour: 3, region: 3 };

/** Objects drawn through a point list need enough points to have a shape. */
function hasPoints(o) {
  const min = MIN_POINTS[o.t];
  if (!min) return true;
  const pts = o.pts;
  return Array.isArray(pts) && pts.length >= min * 2 && pts.length % 2 === 0 && pts.every(Number.isFinite);
}

/** Validates and upgrades parsed JSON. Throws with a readable message. */
export function parseProject(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data || data.format !== FORMAT) throw new Error('This file is not a Circuits project.');
  if (typeof data.version !== 'number' || data.version > FORMAT_VERSION) throw new Error('This project was saved by a newer version of Circuits.');
  if (!Array.isArray(data.documents)) throw new Error('The project has no documents.');
  data.documents = data.documents.filter((d) => d && typeof d === 'object');
  const docIds = new Set();
  for (const d of data.documents) {
    if (!['sch', 'pcb'].includes(d.kind)) throw new Error(`Unknown document type "${d.kind}".`);
    if (!d.id || docIds.has(d.id)) d.id = uid('d');
    docIds.add(d.id);
    if (!Array.isArray(d.objects)) d.objects = [];
    // Ids of the document settings entries ('sheet', 'board', ...) are reserved.
    const seen = new Set(META_TYPES);
    const usable = (o) => o && typeof o === 'object' && typeof o.t === 'string' && !META_TYPES.has(o.t);
    d.objects = d.objects.filter((o) => usable(o) && hasPoints(o)).map((o) => {
      if (!o.id || seen.has(o.id)) o = { ...o, id: uid() };
      seen.add(o.id);
      return o;
    });
  }
  return new Project(data);
}

// The editor side of the scripting API. A script in the sandbox calls these
// methods by name with structured-clone arguments; every argument is checked
// here, because scripts are code the user installed, not part of the app.
// Edits go through the editor's history, and by default every edit of one
// run is combined into a single undo step per document.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import type { HistoryMark } from '../../history/history';
import { commands, findCommand } from '../../app/registry';
import { allLayers, blends, findLayer, layer as newLayer, type Blend, type Layer, type PhotoDocument } from '../../model/document';
import { moveLayers } from '../../model/layers';
import { layerLock } from '../../model/locks';
import { newPixelLayer, setLayerPixels } from '../../model/pixel-layer';
import { canvasRect, combineSelection, maskGrid, selectionBounds, selectionGrid, applySelection, invertSelection, selectAllGrid } from '../../model/selection';
import { emptyGrid, filledMask, intersectRect, readMask, readRGBA, writeRect } from '../../model/tiles';
import type { IRect, RGBA8 } from '../../imaging/types';

/** Dialogs, progress and file pickers a script may use (replaced in tests). */
export type ScriptField = {
  name: string;
  label: string;
  type: 'text' | 'number' | 'checkbox' | 'select' | 'color' | 'range' | 'textarea';
  value: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: [string, string][];
};
export type ScriptFile = { name: string; type: string; data: Uint8Array };
export interface ScriptUI {
  alert(message: string, title: string): Promise<void>;
  confirm(message: string, title: string): Promise<boolean>;
  prompt(message: string, value: string, title: string): Promise<string | null>;
  form(title: string, fields: ScriptField[], submit: string, message: string): Promise<Record<string, string | number | boolean> | null>;
  progress(fraction: number | null, message: string): void;
  openFiles(opts: { accept: string; multiple: boolean }): Promise<ScriptFile[]>;
  saveFiles(files: ScriptFile[], zipName?: string): Promise<boolean>;
}

export class ScriptError extends Error {
  name = 'ScriptError';
}
const fail = (message: string): never => {
  throw new ScriptError(message);
};

// ----- Argument checks -----
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function text(v: unknown, what: string, max = 10_000): string {
  if (typeof v !== 'string') fail(`${what} must be a string.`);
  return (v as string).slice(0, max);
}
function num(v: unknown, what: string, lo = -1e7, hi = 1e7): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${what} must be a finite number.`);
  return Math.min(hi, Math.max(lo, v as number));
}
function int(v: unknown, what: string, lo = -1e7, hi = 1e7) {
  return Math.round(num(v, what, lo, hi));
}
const opt = <T,>(v: unknown, read: (v: unknown) => T): T | undefined => (v === undefined || v === null ? undefined : read(v));
function color(v: unknown, what = 'color'): [number, number, number] {
  if (Array.isArray(v) && v.length >= 3) return [0, 1, 2].map((i) => int(v[i], what, 0, 255)) as [number, number, number];
  const m = typeof v === 'string' ? /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim()) : null;
  if (!m) return fail(`${what} must be "#rrggbb" or [r, g, b].`);
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
const hex = (c: readonly number[]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
function blendMode(v: unknown): Blend {
  const s = text(v, 'blendMode', 40).toLowerCase().replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  const found = blends.find((b) => b === s || b.replace(/ /g, '') === s.replace(/ /g, ''));
  return found ?? fail(`Unknown blend mode “${String(v)}”. Use one of: ${blends.join(', ')}.`);
}
/** An RGBA image from a script: { width, height, data } with 4 bytes per pixel. */
function image(v: unknown, what = 'image'): RGBA8 & { x: number; y: number } {
  if (!isObj(v)) return fail(`${what} must be { width, height, data }.`);
  const width = int(v.width, `${what}.width`, 1, 8192),
    height = int(v.height, `${what}.height`, 1, 8192);
  const d = v.data;
  const n = width * height * 4;
  let data: Uint8ClampedArray;
  if (d instanceof Uint8ClampedArray || d instanceof Uint8Array) data = new Uint8ClampedArray(d.buffer, d.byteOffset, d.length);
  else if (Array.isArray(d)) data = Uint8ClampedArray.from(d as number[]);
  else return fail(`${what}.data must be a Uint8ClampedArray, Uint8Array or array.`);
  if (data.length !== n) fail(`${what}.data has ${data.length} values; ${width} × ${height} RGBA needs ${n}.`);
  return { width, height, data, x: v.x === undefined ? 0 : int(v.x, `${what}.x`), y: v.y === undefined ? 0 : int(v.y, `${what}.y`) };
}
function rect(v: unknown, what = 'rect'): IRect {
  if (!isObj(v)) return fail(`${what} must be { x, y, width, height }.`);
  return { x: int(v.x, `${what}.x`), y: int(v.y, `${what}.y`), width: int(v.width, `${what}.width`, 0, 30000), height: int(v.height, `${what}.height`, 0, 30000) };
}

// ----- Descriptions sent to scripts -----
export function layerKind(l: Layer): string {
  if (l.embed) return 'embedded';
  if (l.artboard) return 'artboard';
  if (l.frame) return 'frame';
  return l.kind === 'vector' ? 'shape' : l.kind === 'solid' ? 'fill' : l.kind;
}
function layerBounds(l: Layer): IRect | null {
  if (l.kind === 'group') {
    let out: IRect | null = null;
    for (const c of l.children) {
      const b = layerBounds(c);
      if (!b) continue;
      out = out ? unionRect(out, b) : b;
    }
    return out;
  }
  if (l.kind === 'pixel' && !l.pixels?.bounds) return null;
  const t = l.transform;
  const x = Math.floor(t.x),
    y = Math.floor(t.y);
  return { x, y, width: Math.ceil(t.x + t.width) - x, height: Math.ceil(t.y + t.height) - y };
}
function unionRect(a: IRect, b: IRect): IRect {
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
export function describeLayer(docId: string, l: Layer, parentId: string | null, depth: number) {
  return {
    id: l.id,
    documentId: docId,
    name: l.name,
    kind: layerKind(l),
    visible: l.visible,
    opacity: Math.round(l.opacity * 100),
    fillOpacity: Math.round((l.fillOpacity ?? 1) * 100),
    blendMode: l.blend,
    bounds: layerBounds(l),
    parentId,
    depth,
    clipped: !!l.clipped,
    locked: !!l.locked,
    background: !!l.background,
    hasMask: !!(l.maskGrid || l.vectorMask || l.pixelMask || l.mask),
    hasStyle: !!l.style,
    text: l.kind === 'text' ? l.text : undefined,
    children: l.kind === 'group' ? l.children.map((c) => c.id).reverse() : undefined,
  };
}
/** Layers top to bottom, as the Layers panel lists them; children follow their group. */
export function describeLayers(docId: string, layers: Layer[], parentId: string | null = null, depth = 0): ReturnType<typeof describeLayer>[] {
  return [...layers].reverse().flatMap((l) => [describeLayer(docId, l, parentId, depth), ...(l.kind === 'group' ? describeLayers(docId, l.children, l.id, depth + 1) : [])]);
}
function parentOf(layers: Layer[], id: string, parent: Layer | null = null): Layer | null | undefined {
  for (const l of layers) {
    if (l.id === id) return parent;
    const found = parentOf(l.children, id, l);
    if (found !== undefined) return found;
  }
  return undefined;
}
function depthOf(layers: Layer[], id: string): number {
  let depth = 0;
  for (let p = parentOf(layers, id); p; p = parentOf(layers, p.id)) depth++;
  return depth;
}

// Commands a script must not run: running scripts from scripts, and the
// windows that manage them.
const blockedCommand = (id: string) => id.startsWith('script.') || ['file.scripts-browse', 'file.script-events', 'file.batch-link', 'window.panel.scripts'].includes(id);
// Effects a script can set, by the key scripts use.
const effectKeys = ['dropShadow', 'innerShadow', 'outerGlow', 'innerGlow', 'bevel', 'satin', 'colorOverlay', 'stroke'] as const;

export class ScriptHost {
  // One undo step per document per run unless the script turns grouping off.
  private grouping = true;
  private marks = new Map<DocumentSession, HistoryMark>();
  private methods: Record<string, (...args: unknown[]) => unknown>;
  constructor(
    private e: Editor,
    private ui: ScriptUI,
    private label: string,
    // Documents whose edits from the start belong to the run (default: all
    // open documents); others join when the run first edits them.
    only?: DocumentSession[],
  ) {
    for (const s of only ?? e.sessions) this.marks.set(s, s.history.mark());
    this.methods = this.table();
  }
  /** Run an API method for the script. */
  async call(method: string, args: unknown[]): Promise<unknown> {
    if (!Object.prototype.hasOwnProperty.call(this.methods, method)) fail(`Unknown API method “${String(method).slice(0, 60)}”.`);
    return this.methods[method](...(Array.isArray(args) ? args : []));
  }
  /** Combine each document's edits into one step; returns how many documents changed. */
  finish(label = this.label) {
    let changed = 0;
    for (const [s, mark] of this.marks) if (this.e.sessions.includes(s) && s.history.squash(mark, label)) changed++;
    else if (!this.e.sessions.includes(s)) mark.open = false;
    this.marks.clear();
    this.e.update();
    return changed;
  }

  // ----- Documents -----
  private session(id: unknown): DocumentSession {
    if (id === undefined || id === null) {
      if (!this.e.hasDocument) fail('There is no open document.');
      return this.e.session;
    }
    const s = this.e.sessions.find((x) => x.id === id && x.hasDocument);
    return s ?? fail('That document is no longer open.');
  }
  /** Make a document active for an edit (and start its undo group). */
  private async use(id: unknown) {
    const s = this.session(id);
    if (s !== this.e.session) await this.e.switchSession(s);
    if (this.grouping && !this.marks.has(s)) this.marks.set(s, s.history.mark());
    return s;
  }
  private describeDocument(s: DocumentSession) {
    const d = s.doc;
    const r = d.resolution;
    const ppi = r ? (r.horizontalResolutionUnit === 'PPCM' ? r.horizontalResolution * 2.54 : r.horizontalResolution) : 72;
    return {
      id: s.id,
      name: d.name,
      width: d.width,
      height: d.height,
      resolution: Math.round(ppi * 100) / 100,
      mode: d.mode ?? 'rgb',
      bitsPerChannel: d.bitsPerChannel ?? 8,
      active: s === this.e.session,
      saved: !s.dirty,
      fileName: s.fileName ?? null,
    };
  }
  private layerOf(s: DocumentSession, id: unknown): Layer {
    const l = findLayer(s.doc.layers, text(id, 'layer id', 100));
    return l ?? fail('That layer no longer exists.');
  }
  private info(s: DocumentSession, id: string) {
    const l = findLayer(s.doc.layers, id);
    if (!l) return null;
    return describeLayer(s.id, l, parentOf(s.doc.layers, id)?.id ?? null, depthOf(s.doc.layers, id));
  }
  /** One edit of a document as a history step (combined later when grouping). */
  private async edit(id: unknown, label: string, fn: (d: PhotoDocument) => void) {
    await this.use(id);
    let error: unknown;
    this.e.command(label, (d) => {
      try {
        fn(d);
      } catch (err) {
        error = err;
      }
    });
    if (error) throw error;
  }
  private unlocked(s: DocumentSession, l: Layer, operation: 'all' | 'position' | 'pixels' = 'all') {
    if (layerLock(s.doc.layers, l.id, operation)) fail(`“${l.name}” is locked.`);
  }

  private table(): Record<string, (...args: unknown[]) => unknown> {
    const e = this.e;
    return {
      'app.info': () => ({ name: 'Photo Studio', apiVersion: 1, foreground: e.color, background: e.background }),
      'app.message': (m) => void e.message(text(m, 'message', 500)),

      'documents.list': () => e.sessions.filter((s) => s.hasDocument).map((s) => this.describeDocument(s)),
      'documents.active': () => (e.hasDocument ? this.describeDocument(e.session) : null),
      'documents.get': (id) => this.describeDocument(this.session(id)),
      'documents.activate': async (id) => {
        await this.use(id);
        return this.describeDocument(e.session);
      },
      'documents.create': async (o) => {
        const opts = isObj(o) ? o : {};
        const { createDocument } = await import('../files/new-document');
        const bg = opts.background === undefined ? 'white' : opts.background;
        const background = bg === 'transparent' || bg === 'white' || bg === 'black' ? bg : 'custom';
        await createDocument(e, {
          name: opt(opts.name, (v) => text(v, 'name', 200)) ?? 'Untitled',
          width: opt(opts.width, (v) => int(v, 'width', 1, 8192)) ?? 1200,
          height: opt(opts.height, (v) => int(v, 'height', 1, 8192)) ?? 800,
          unit: 'px',
          ppi: opt(opts.resolution, (v) => num(v, 'resolution', 1, 10000)) ?? 72,
          ppiUnit: 'ppi',
          mode: 'rgb',
          background,
          color: background === 'custom' ? hex(color(bg, 'background')) : '#ffffff',
          profile: 'working',
          pixelAspect: 1,
          artboards: false,
        } as Parameters<typeof createDocument>[1]);
        const s = e.session;
        if (this.grouping) this.marks.set(s, s.history.mark());
        return this.describeDocument(s);
      },
      'documents.open': async (o) => {
        const opts = isObj(o) ? o : {};
        const files = await this.ui.openFiles({ accept: 'image', multiple: opts.multiple !== false });
        const { openFile } = await import('../files/open');
        const out = [];
        for (const f of files) {
          if (!(await openFile(e, new Blob([f.data as Uint8Array<ArrayBuffer>], { type: f.type }), f.name))) continue;
          if (this.grouping) this.marks.set(e.session, e.session.history.mark());
          out.push(this.describeDocument(e.session));
        }
        return out;
      },
      'documents.close': async (id, o) => {
        const s = this.session(id);
        const opts = isObj(o) ? o : {};
        // Closing asks about unsaved changes unless the script says to discard them.
        const mark = this.marks.get(s);
        if (mark) s.history.squash(mark, this.label);
        this.marks.delete(s);
        return e.closeSession(s, opts.discard === true);
      },
      'documents.save': async (id) => {
        await this.use(id);
        await this.runCommand('file.save', undefined);
      },
      'documents.export': async (id, o) => this.exportImage(this.session(id), isObj(o) ? o : {}),
      'documents.composite': async (id, r) => {
        const s = await this.use(id);
        const { compositeRGBA } = await import('../pixels');
        return crop(await compositeRGBA(e, s.doc), opt(r, rect), s.doc);
      },
      'documents.undo': async (id) => {
        const s = this.session(id);
        s.history.undo();
        e.update();
      },
      'documents.redo': async (id) => {
        const s = this.session(id);
        s.history.redo();
        e.update();
      },

      // ----- Layers -----
      'layers.list': (id) => {
        const s = this.session(id);
        return describeLayers(s.id, s.doc.layers);
      },
      'layers.get': (id, layerId) => {
        const s = this.session(id);
        return this.info(s, text(layerId, 'layer id', 100));
      },
      'layers.selected': (id) => {
        const s = this.session(id);
        return [...s.selectedIds].map((l) => this.info(s, l)).filter(Boolean);
      },
      'layers.select': async (id, ids) => {
        const s = await this.use(id);
        const list = (Array.isArray(ids) ? ids : [ids]).map((x) => this.layerOf(s, x).id);
        e.selectLayers(list);
        e.update();
      },
      'layers.create': async (id, o) => this.createLayer(await this.use(id), isObj(o) ? o : {}),
      'layers.set': async (id, layerId, props) => {
        const s = this.session(id);
        const l = this.layerOf(s, layerId);
        if (!isObj(props)) fail('Layer properties must be an object.');
        const p = props as Record<string, unknown>;
        const name = opt(p.name, (v) => text(v, 'name', 255));
        const visible = opt(p.visible, (v) => !!v);
        const opacity = opt(p.opacity, (v) => num(v, 'opacity', 0, 100) / 100);
        const fillOpacity = opt(p.fillOpacity, (v) => num(v, 'fillOpacity', 0, 100) / 100);
        const blend = opt(p.blendMode, blendMode);
        const clipped = opt(p.clipped, (v) => !!v);
        const locked = opt(p.locked, (v) => !!v);
        if (blend !== undefined || opacity !== undefined || fillOpacity !== undefined || clipped !== undefined) this.unlocked(s, l);
        await this.edit(id, 'Layer Properties', (d) => {
          const t = findLayer(d.layers, l.id)!;
          if (name !== undefined) t.name = name;
          if (visible !== undefined) t.visible = visible;
          if (opacity !== undefined) t.opacity = opacity;
          if (fillOpacity !== undefined) t.fillOpacity = fillOpacity;
          if (blend !== undefined) t.blend = blend;
          if (clipped !== undefined) t.clipped = clipped || undefined;
          if (locked !== undefined) t.locked = locked;
        });
        return this.info(this.session(id), l.id);
      },
      'layers.setStyle': async (id, layerId, style) => {
        const s = this.session(id);
        const l = this.layerOf(s, layerId);
        this.unlocked(s, l);
        const next = style === null || style === undefined ? undefined : await buildStyle(style);
        await this.edit(id, 'Layer Style', (d) => {
          const t = findLayer(d.layers, l.id)!;
          if (next) t.style = next;
          else delete t.style;
        });
        return this.info(this.session(id), l.id);
      },
      'layers.translate': async (id, layerId, dx, dy) => {
        const s = await this.use(id);
        const l = this.layerOf(s, layerId);
        this.unlocked(s, l, 'position');
        const x = num(dx, 'dx', -1e5, 1e5),
          y = num(dy, 'dy', -1e5, 1e5);
        if (!x && !y) return this.info(s, l.id);
        e.selectLayers([l.id]);
        e.transform.nudge(x, y);
        return this.info(this.session(id), l.id);
      },
      'layers.arrange': async (id, layerId, where) => {
        const s = this.session(id);
        const l = this.layerOf(s, layerId);
        await this.edit(id, 'Arrange Layer', (d) => arrange(d, l.id, where));
        return this.info(this.session(id), l.id);
      },
      'layers.duplicate': async (id, layerId) => {
        const s = this.session(id);
        const l = this.layerOf(s, layerId);
        const copy = { ...structuredClone(l), name: `${l.name} copy` };
        delete copy.background;
        const relabel = (x: Layer) => {
          x.id = crypto.randomUUID();
          x.children.forEach(relabel);
        };
        relabel(copy);
        await this.edit(id, 'Duplicate Layer', (d) => {
          const list = containerList(d.layers, l.id);
          list.splice(list.findIndex((x) => x.id === l.id) + 1, 0, copy);
        });
        return this.info(this.session(id), copy.id);
      },
      'layers.remove': async (id, layerId) => {
        const s = this.session(id);
        const l = this.layerOf(s, layerId);
        this.unlocked(s, l);
        await this.edit(id, 'Delete Layer', (d) => {
          const list = containerList(d.layers, l.id);
          list.splice(list.findIndex((x) => x.id === l.id), 1);
        });
      },
      'layers.getPixels': async (id, layerId, r) => {
        const s = this.session(id);
        const l = this.layerOf(s, layerId);
        const area = opt(r, rect) ?? layerBounds(l) ?? { x: 0, y: 0, width: 0, height: 0 };
        if (!area.width || !area.height) return { x: area.x, y: area.y, width: 0, height: 0, data: new Uint8ClampedArray(0) };
        if (area.width * area.height > 24_000_000) fail('Read at most 24 megapixels at once.');
        if (l.kind === 'pixel' && l.pixels) return { ...readRGBA(s.assets.tiles, l.pixels, area), x: area.x, y: area.y };
        await this.use(id);
        const { layerRGBA } = await import('../pixels');
        return crop(await layerRGBA(e, l, s.doc), area, s.doc);
      },
      'layers.setPixels': async (id, layerId, img) => {
        const s = this.session(id);
        const l = this.layerOf(s, layerId);
        if (l.kind !== 'pixel') fail(`“${l.name}” is not a pixel layer. Rasterize it first.`);
        if (l.liveFilters?.length) fail(`“${l.name}” has Live Filters; its pixels come from the filters.`);
        this.unlocked(s, l, 'pixels');
        const src = image(img);
        const grid = writeRect(s.assets.tiles, l.pixels ?? emptyGrid(4), src.x, src.y, src);
        await this.edit(id, 'Set Pixels', (d) => setLayerPixels(findLayer(d.layers, l.id)!, grid, d));
        return this.info(this.session(id), l.id);
      },
      'layers.getText': (id, layerId) => {
        const s = this.session(id);
        const l = this.layerOf(s, layerId);
        if (l.kind !== 'text') fail(`“${l.name}” is not a text layer.`);
        return l.text;
      },
      'layers.setText': async (id, layerId, o) => {
        const s = this.session(id);
        const l = this.layerOf(s, layerId);
        if (l.kind !== 'text') fail(`“${l.name}” is not a text layer.`);
        this.unlocked(s, l);
        const opts = typeof o === 'string' ? { text: o } : isObj(o) ? o : fail('setText takes a string or { text, size, color, font }.');
        const next = await textUpdate(s.doc, l, opts as Record<string, unknown>);
        await this.edit(id, 'Edit Text', (d) => next(findLayer(d.layers, l.id)!));
        return this.info(this.session(id), l.id);
      },

      // ----- Selection -----
      'selection.get': (id) => {
        const s = this.session(id);
        return selectionBounds(s.doc, selectionGrid(s.doc, s.assets.tiles));
      },
      'selection.set': async (id, shape, op) => {
        const s = this.session(id);
        const o = isObj(shape) ? shape : fail('A selection shape is { type: "rect" | "ellipse", x, y, width, height }.');
        const r = rect(o, 'shape');
        const kind = o.type === undefined ? 'rect' : text(o.type, 'shape.type', 20);
        if (kind !== 'rect' && kind !== 'ellipse') fail('shape.type must be "rect" or "ellipse".');
        const mode = selectionOp(op);
        const store = s.assets.tiles;
        const area = intersectRect(r, canvasRect(s.doc));
        let grid = null;
        if (area && kind === 'rect') grid = filledMask(store, area);
        else if (area) {
          const { ellipsePoints, rasterizePolygon } = await import('../selection');
          grid = maskGrid(store, rasterizePolygon(ellipsePoints(r.x, r.y, r.width, r.height), s.doc.width, s.doc.height));
        }
        await this.setSelection(id, grid, mode, 'Select');
        return selectionBounds(this.session(id).doc, selectionGrid(this.session(id).doc, store));
      },
      'selection.all': async (id) => this.setSelection(id, selectAllGrid(), 'replace', 'Select All'),
      'selection.clear': async (id) => this.setSelection(id, null, 'replace', 'Deselect'),
      'selection.invert': async (id) => {
        const s = this.session(id);
        await this.edit(id, 'Select Inverse', (d) => applySelection(d, invertSelection(s.assets.tiles, d, selectionGrid(d, s.assets.tiles))));
      },
      'selection.getMask': (id) => {
        const s = this.session(id);
        const grid = selectionGrid(s.doc, s.assets.tiles);
        const b = selectionBounds(s.doc, grid);
        if (!grid || !b) return null;
        return { ...readMask(s.assets.tiles, grid, b), x: b.x, y: b.y };
      },
      'selection.setMask': async (id, m, op) => {
        const s = this.session(id);
        if (!isObj(m)) fail('A mask is { x, y, width, height, data } with one byte per pixel.');
        const mo = m as Record<string, unknown>;
        const width = int(mo.width, 'mask.width', 1, 8192),
          height = int(mo.height, 'mask.height', 1, 8192);
        const d = mo.data;
        const data = d instanceof Uint8Array || d instanceof Uint8ClampedArray ? new Uint8Array(d.buffer, d.byteOffset, d.length) : Array.isArray(d) ? Uint8Array.from(d as number[]) : fail('mask.data must be a Uint8Array or array.');
        if (data.length !== width * height) fail(`mask.data must have ${width * height} values.`);
        const grid = maskGrid(s.assets.tiles, { width, height, data }, mo.x === undefined ? 0 : int(mo.x, 'mask.x'), mo.y === undefined ? 0 : int(mo.y, 'mask.y'));
        await this.setSelection(id, grid, selectionOp(op), 'Select');
      },

      // ----- Commands and history -----
      'commands.run': async (cmd, arg, id) => {
        if (id !== undefined && id !== null) await this.use(id);
        else if (e.hasDocument) await this.use(undefined);
        await this.runCommand(text(cmd, 'command id', 200), arg);
      },
      'commands.list': () =>
        [...commands.values()].filter((c) => !c.hidden && !blockedCommand(c.id)).map((c) => ({ id: c.id, label: c.label, enabled: safeEnabled(e, c.enabled) })),
      'history.checkpoint': (label) => {
        const l = label === undefined ? this.label : text(label, 'label', 120);
        this.finish(l);
        if (this.grouping) for (const s of e.sessions) this.marks.set(s, s.history.mark());
      },
      'history.grouping': (on) => {
        const next = !!on;
        if (next === this.grouping) return;
        this.finish();
        this.grouping = next;
        if (next) for (const s of e.sessions) this.marks.set(s, s.history.mark());
      },

      // ----- Dialogs and files -----
      'ui.alert': (m, t) => this.ui.alert(text(m, 'message', 4000), opt(t, (v) => text(v, 'title', 120)) ?? this.label),
      'ui.confirm': (m, t) => this.ui.confirm(text(m, 'message', 4000), opt(t, (v) => text(v, 'title', 120)) ?? this.label),
      'ui.prompt': (m, v, t) => this.ui.prompt(text(m, 'message', 4000), opt(v, (x) => String(x)) ?? '', opt(t, (x) => text(x, 'title', 120)) ?? this.label),
      'ui.form': (t, f, o) => {
        const opts = isObj(o) ? o : {};
        return this.ui.form(text(t, 'title', 120), formFields(f), opt(opts.submit, (v) => text(v, 'submit', 40)) ?? 'OK', opt(opts.message, (v) => text(v, 'message', 2000)) ?? '');
      },
      'ui.progress': (f, m) => this.ui.progress(f === null || f === undefined ? null : num(f, 'fraction', 0, 1), opt(m, (v) => text(v, 'message', 200)) ?? ''),
      'files.open': (o) => {
        const opts = isObj(o) ? o : {};
        return this.ui.openFiles({ accept: opt(opts.accept, (v) => text(v, 'accept', 200)) ?? '', multiple: opts.multiple === true });
      },
      'files.save': (name, data, type) => this.ui.saveFiles([scriptFile(name, data, type)]),
      'files.saveAll': (list, zip) => {
        if (!Array.isArray(list) || !list.length) fail('saveAll takes a non-empty array of { name, data }.');
        if ((list as unknown[]).length > 5000) fail('Save at most 5000 files at once.');
        const files = (list as unknown[]).map((f) => (isObj(f) ? scriptFile(f.name, f.data, f.type) : fail('Each file is { name, data }.')));
        return this.ui.saveFiles(files, opt(zip, (v) => text(v, 'zip name', 200)) ?? 'files.zip');
      },
      'image.encode': async (img, o) => encodeImage(image(img), isObj(o) ? o : {}),
    };
  }

  private async runCommand(id: string, arg: unknown) {
    if (blockedCommand(id)) fail(`Scripts cannot run “${id}”.`);
    const c = findCommand(id) ?? fail(`Unknown command “${id}”.`);
    if (c.enabled && !c.enabled(this.e)) fail(`“${c.label}” is not available in the current state.`);
    // Commands are called directly, as recorded actions replay them.
    await c.run(this.e, arg);
    this.e.update();
  }
  private async setSelection(id: unknown, grid: Parameters<typeof applySelection>[1], op: 'replace' | 'add' | 'subtract' | 'intersect', label: string) {
    const s = this.session(id);
    const store = s.assets.tiles;
    const current = selectionGrid(s.doc, store);
    const next = grid ? combineSelection(store, s.doc, current, grid, op) : op === 'replace' ? null : current;
    s.lastSelection = current;
    await this.edit(id, label, (d) => applySelection(d, next));
  }
  private async createLayer(s: DocumentSession, o: Record<string, unknown>) {
    const e = this.e;
    const kind = o.kind === undefined ? 'pixel' : text(o.kind, 'kind', 20);
    const name = opt(o.name, (v) => text(v, 'name', 255));
    const doc = s.doc;
    let l: Layer;
    if (kind === 'pixel') {
      l = newPixelLayer(name ?? nextName(doc), doc);
      if (o.fill !== undefined) {
        const [r, g, b] = color(o.fill, 'fill');
        const area = opt(o.rect, rect) ?? canvasRect(doc);
        const data = new Uint8ClampedArray(area.width * area.height * 4);
        for (let i = 0; i < data.length; i += 4) ((data[i] = r), (data[i + 1] = g), (data[i + 2] = b), (data[i + 3] = 255));
        setLayerPixels(l, writeRect(s.assets.tiles, emptyGrid(4), area.x, area.y, { width: area.width, height: area.height, data }), doc);
      }
    } else if (kind === 'group') {
      l = newLayer('group', name ?? 'Group', doc.width, doc.height);
    } else if (kind === 'fill') {
      l = newLayer('solid', name ?? 'Color Fill', doc.width, doc.height);
      l.color = hex(color(o.color ?? e.color));
    } else if (kind === 'text') {
      l = await newTextLayer(doc, name, o, e.color);
    } else return fail('kind must be "pixel", "text", "group" or "fill".');
    if (o.opacity !== undefined) l.opacity = num(o.opacity, 'opacity', 0, 100) / 100;
    if (o.blendMode !== undefined) l.blend = blendMode(o.blendMode);
    if (o.visible === false) l.visible = false;
    const above = opt(o.above, (v) => this.layerOf(s, v).id);
    const inside = opt(o.inside, (v) => this.layerOf(s, v));
    if (inside && inside.kind !== 'group') fail('Layers can only be created inside a group.');
    const anchor = above ?? (inside ? undefined : [...s.selectedIds].at(-1));
    await this.edit(s.id, 'New Layer', (d) => {
      if (inside) findLayer(d.layers, inside.id)!.children.push(l);
      else if (anchor && findLayer(d.layers, anchor)) {
        const list = containerList(d.layers, anchor);
        list.splice(list.findIndex((x) => x.id === anchor) + 1, 0, l);
      } else d.layers.push(l);
    });
    e.selectLayers([l.id]);
    e.update();
    return this.info(this.session(s.id), l.id);
  }
  private async exportImage(s: DocumentSession, o: Record<string, unknown>) {
    const format = opt(o.format, (v) => text(v, 'format', 10).toLowerCase()) ?? 'png';
    let img: RGBA8;
    const { compositeRGBA, layerRGBA } = await import('../pixels');
    await this.use(s.id);
    if (o.layer !== undefined) {
      const l = this.layerOf(s, o.layer);
      const full = await layerRGBA(this.e, { ...l, visible: true }, s.doc);
      // Layers export at their own bounds unless the script asks for the canvas.
      img = o.trim === false ? full : trimTransparent(full);
    } else img = await compositeRGBA(this.e, { ...s.doc, selection: null });
    const out = await encodeImage(img, { ...o, format });
    const base = opt(o.name, (v) => text(v, 'name', 200)) ?? s.doc.name;
    return { ...out, name: /\.[a-z0-9]{2,4}$/i.test(base) ? base : `${base}.${out.extension}` };
  }
}

function safeEnabled(e: Editor, f?: (e: Editor) => boolean) {
  try {
    return f ? f(e) : true;
  } catch {
    return false;
  }
}
function selectionOp(v: unknown): 'replace' | 'add' | 'subtract' | 'intersect' {
  if (v === undefined || v === null) return 'replace';
  const s = text(v, 'operation', 20);
  if (s === 'replace' || s === 'add' || s === 'subtract' || s === 'intersect') return s;
  return fail('The selection operation must be "replace", "add", "subtract" or "intersect".');
}
function containerList(layers: Layer[], id: string): Layer[] {
  if (layers.some((l) => l.id === id)) return layers;
  for (const l of layers) {
    const found = l.children.length ? containerListOrNull(l.children, id) : null;
    if (found) return found;
  }
  return fail('That layer no longer exists.');
}
function containerListOrNull(layers: Layer[], id: string): Layer[] | null {
  if (layers.some((l) => l.id === id)) return layers;
  for (const l of layers) {
    const found = containerListOrNull(l.children, id);
    if (found) return found;
  }
  return null;
}
function nextName(doc: PhotoDocument) {
  const used = new Set(allLayers(doc.layers).map((l) => l.name));
  let i = 1;
  while (used.has(`Layer ${i}`)) i++;
  return `Layer ${i}`;
}
/** Restack a layer: "top", "bottom", "up", "down" or { above | below | inside: id }. */
function arrange(d: PhotoDocument, id: string, where: unknown) {
  const list = containerList(d.layers, id);
  const i = list.findIndex((l) => l.id === id);
  const l = list[i];
  if (typeof where === 'string') {
    if (!['top', 'bottom', 'up', 'down'].includes(where)) fail('Arrange takes "top", "bottom", "up", "down" or { above | below | inside: layer }.');
    list.splice(i, 1);
    // The Background layer stays at the bottom.
    const floor = list[0]?.background ? 1 : 0;
    const to = where === 'top' ? list.length : where === 'bottom' ? floor : where === 'up' ? Math.min(list.length, i + 1) : Math.max(floor, i - 1);
    list.splice(to, 0, l);
    return;
  }
  if (!isObj(where)) return fail('Arrange takes "top", "bottom", "up", "down" or { above | below | inside: layer }.');
  const [position, target] = where.above !== undefined ? (['above', where.above] as const) : where.below !== undefined ? (['below', where.below] as const) : (['inside', where.inside] as const);
  const targetId = isObj(target) && typeof target.id === 'string' ? target.id : text(target, 'target layer', 100);
  moveLayers(d, new Set([id]), targetId, position);
}
/** Pixels of a canvas-sized image within a rectangle (clipped to the canvas). */
function crop(img: RGBA8, r: IRect | undefined, doc: PhotoDocument) {
  const area = r ? intersectRect(r, canvasRect(doc)) : canvasRect(doc);
  if (!area) return { x: 0, y: 0, width: 0, height: 0, data: new Uint8ClampedArray(0) };
  if (area.x === 0 && area.y === 0 && area.width === img.width && area.height === img.height) return { ...img, data: new Uint8ClampedArray(img.data), x: 0, y: 0 };
  const data = new Uint8ClampedArray(area.width * area.height * 4);
  for (let y = 0; y < area.height; y++) data.set(img.data.subarray(((area.y + y) * img.width + area.x) * 4, ((area.y + y) * img.width + area.x + area.width) * 4), y * area.width * 4);
  return { x: area.x, y: area.y, width: area.width, height: area.height, data };
}
/** The image cropped to its non-transparent pixels (1×1 when empty). */
export function trimTransparent(img: RGBA8): RGBA8 {
  let x0 = img.width,
    y0 = img.height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  const w = x1 - x0 + 1,
    h = y1 - y0 + 1;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) data.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x1 + 1) * 4), y * w * 4);
  return { width: w, height: h, data };
}
const encodeFormats = ['png', 'jpeg', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'tga'];
/** Encode RGBA pixels: { format, quality, width, height, scale }. */
async function encodeImage(img: RGBA8, o: Record<string, unknown>) {
  let format = opt(o.format, (v) => text(v, 'format', 10).toLowerCase()) ?? 'png';
  if (format === 'jpg') format = 'jpeg';
  if (!encodeFormats.includes(format)) fail(`format must be one of ${encodeFormats.join(', ')}.`);
  const quality = opt(o.quality, (v) => int(v, 'quality', 1, 100)) ?? 90;
  let width = opt(o.width, (v) => int(v, 'width', 1, 8192));
  let height = opt(o.height, (v) => int(v, 'height', 1, 8192));
  const scale = opt(o.scale, (v) => num(v, 'scale', 0.01, 16));
  if (scale !== undefined) {
    width = Math.max(1, Math.round(img.width * scale));
    height = Math.max(1, Math.round(img.height * scale));
  } else if (width && !height) height = Math.max(1, Math.round((img.height * width) / img.width));
  else if (height && !width) width = Math.max(1, Math.round((img.width * height) / img.height));
  width ??= img.width;
  height ??= img.height;
  const [{ encodeOffThread, loadSettings }, { formatInfo }] = await Promise.all([import('../files/pipeline'), import('../files/formats')]);
  const f = format as keyof typeof formatInfo;
  const settings = { ...loadSettings(), format: f, quality, sizeMode: 'exact' as const, width, height, canvasWidth: 0, canvasHeight: 0, depth: 8 as const, convertSrgb: false, metadata: 'none' as const };
  const { bytes } = await encodeOffThread(img, settings, { profile: null });
  return { type: formatInfo[f].mime, extension: formatInfo[f].ext, width, height, data: bytes };
}
function scriptFile(name: unknown, data: unknown, type: unknown): { name: string; type: string; data: Uint8Array } {
  const n = text(name, 'file name', 200).replace(/[\\/:*?"<>|]/g, '_') || 'file';
  let bytes: Uint8Array;
  if (typeof data === 'string') bytes = new TextEncoder().encode(data);
  else if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) bytes = new Uint8Array(data.buffer, data.byteOffset, data.length);
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else return fail('File data must be a string, ArrayBuffer or Uint8Array.');
  if (bytes.length > 512 * 1024 * 1024) fail('A file can be at most 512 MB.');
  return { name: n, type: opt(type, (v) => text(v, 'type', 100)) ?? (typeof data === 'string' ? 'text/plain' : 'application/octet-stream'), data: bytes };
}
function formFields(v: unknown): ScriptField[] {
  if (!Array.isArray(v) || !v.length) fail('A form needs an array of fields.');
  if ((v as unknown[]).length > 40) fail('A form can have at most 40 fields.');
  const types = ['text', 'number', 'checkbox', 'select', 'color', 'range', 'textarea'];
  return (v as unknown[]).map((raw, i) => {
    if (!isObj(raw)) fail(`Field ${i + 1} must be an object.`);
    const f = raw as Record<string, unknown>;
    const type = (f.type === undefined ? 'text' : text(f.type, 'field type', 20)) as ScriptField['type'];
    if (!types.includes(type)) fail(`Field type must be one of ${types.join(', ')}.`);
    const name = text(f.name, 'field name', 60);
    const options = type === 'select' ? (Array.isArray(f.options) ? (f.options as unknown[]) : fail(`Select field “${name}” needs options.`)).slice(0, 200).map((o) => (Array.isArray(o) ? ([String(o[0]), String(o[1] ?? o[0])] as [string, string]) : ([String(o), String(o)] as [string, string]))) : undefined;
    const value = f.value === undefined ? (type === 'checkbox' ? false : type === 'number' || type === 'range' ? (typeof f.min === 'number' ? f.min : 0) : type === 'select' ? (options?.[0]?.[0] ?? '') : type === 'color' ? '#000000' : '') : f.value;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') fail(`Field “${name}” has an invalid value.`);
    return {
      name,
      label: f.label === undefined ? name : text(f.label, 'field label', 120),
      type,
      value: value as string | number | boolean,
      min: opt(f.min, (x) => num(x, 'min')),
      max: opt(f.max, (x) => num(x, 'max')),
      step: opt(f.step, (x) => num(x, 'step', 0, 1e7)),
      options,
    };
  });
}

// ----- Text layers -----
async function newTextLayer(doc: PhotoDocument, name: string | undefined, o: Record<string, unknown>, fg: string) {
  const [{ defaultCharStyle, defaultParagraphStyle, fromPlainText }, { prepareFonts }, { layoutOf, localBounds }, { documentPpi, syncLegacyFields, textLayerName }] = await Promise.all([
    import('../../imaging/text/model'),
    import('../../imaging/text/fonts'),
    import('../type/text-utils'),
    import('../../model/text-layer'),
  ]);
  const content = text(o.text ?? 'Text', 'text', 20_000);
  const ppi = documentPpi(doc);
  const px = opt(o.size, (v) => num(v, 'size', 1, 5000)) ?? Math.round(Math.min(doc.width, doc.height) / 12);
  const rgb = color(o.color ?? fg);
  const style = { ...defaultCharStyle(), size: (px * 72) / ppi, color: rgb, ...(o.font !== undefined ? { family: text(o.font, 'font', 100) } : {}), ...(o.bold === true ? { weight: 700 } : {}), ...(o.italic === true ? { italic: true } : {}) };
  const align = o.align === 'center' || o.align === 'right' ? o.align : 'left';
  const data = { content: fromPlainText(content, style, { ...defaultParagraphStyle(), align }), mode: 'point' as const, origin: { x: 0, y: 0 }, orientation: 'horizontal' as const, antiAlias: 'smooth' as const };
  await prepareFonts(data);
  // x and y place the top-left corner of the text's bounds (centered by default).
  const b0 = localBounds(data, layoutOf(data, ppi));
  const x = opt(o.x, (v) => num(v, 'x')) ?? Math.round((doc.width - b0.width) / 2);
  const y = opt(o.y, (v) => num(v, 'y')) ?? Math.round((doc.height - b0.height) / 2);
  const placed = { ...data, origin: { x: x - b0.x, y: y - b0.y } };
  const l = newLayer('text', name ?? textLayerName(placed.content), 1, 1);
  l.textData = placed;
  const b = localBounds(placed, layoutOf(placed, ppi));
  l.textFrame = { ...b, width: Math.max(1, b.width), height: Math.max(1, b.height) };
  l.transform = { ...l.textFrame, rotation: 0 };
  syncLegacyFields(l);
  return l;
}
/** An edit replacing a text layer's characters and/or style, keeping its place. */
async function textUpdate(doc: PhotoDocument, l: Layer, o: Record<string, unknown>) {
  const [{ fromPlainText, plainText }, { prepareFonts }, { editable, layoutOf, localBounds }, { documentPpi, fitTextFrame, syncLegacyFields }] = await Promise.all([
    import('../../imaging/text/model'),
    import('../../imaging/text/fonts'),
    import('../type/text-utils'),
    import('../../model/text-layer'),
  ]);
  const ppi = documentPpi(doc);
  const t = editable(l, ppi);
  const first = t.textData.content.paragraphs[0];
  const style = { ...first?.runs[0]?.style! };
  if (o.size !== undefined) style.size = (num(o.size, 'size', 1, 5000) * 72) / ppi;
  if (o.color !== undefined) style.color = color(o.color);
  if (o.font !== undefined) style.family = text(o.font, 'font', 100);
  if (o.bold !== undefined) style.weight = o.bold ? 700 : 400;
  if (o.italic !== undefined) style.italic = !!o.italic;
  const chars = o.text === undefined ? plainText(t.textData.content) : text(o.text, 'text', 20_000);
  const data = { ...t.textData, content: fromPlainText(chars, style, first?.style) };
  await prepareFonts(data);
  const bounds = localBounds(data, layoutOf(data, ppi));
  return (target: Layer) => {
    target.textData = data;
    target.textFrame = t.textFrame;
    delete target.asset;
    fitTextFrame(target, bounds);
    syncLegacyFields(target);
  };
}

// ----- Layer styles -----
/** A layer style from a script's description: each effect key holds the
 * settings to change from the effect's defaults (opacity in percent, colors
 * as "#rrggbb"); `false` leaves an effect out. */
async function buildStyle(v: unknown) {
  if (!isObj(v)) return fail('A layer style is an object such as { dropShadow: { distance: 8 } } or null.');
  const fx = await import('../../imaging/effects/types');
  const defaults: Record<(typeof effectKeys)[number], () => Record<string, unknown>> = {
    dropShadow: fx.defaultDropShadow,
    innerShadow: fx.defaultInnerShadow,
    outerGlow: fx.defaultOuterGlow,
    innerGlow: fx.defaultInnerGlow,
    bevel: fx.defaultBevel,
    satin: fx.defaultSatin,
    colorOverlay: fx.defaultColorOverlay,
    stroke: fx.defaultStroke,
  } as never;
  const style: Record<string, unknown> = { enabled: true };
  for (const key of Object.keys(v)) {
    if (!(effectKeys as readonly string[]).includes(key)) fail(`Unknown effect “${key}”. Use ${effectKeys.join(', ')}.`);
    const given = v[key];
    if (given === false || given === null || given === undefined) continue;
    const settings = given === true ? {} : isObj(given) ? given : fail(`${key} must be an object of settings or true.`);
    const fxv = defaults[key as (typeof effectKeys)[number]]();
    for (const [k, value] of Object.entries(settings)) {
      if (k === 'color') {
        const rgb = color(value, `${key}.color`);
        if (isObj(fxv.fill)) fxv.fill = { type: 'color', color: rgb };
        else if ('color' in fxv) fxv.color = rgb;
        else fail(`${key} has no color.`);
      } else if (k === 'opacity') fxv.opacity = num(value, `${key}.opacity`, 0, 100) / 100;
      else if (k === 'blendMode') fxv[key === 'bevel' ? 'highlightMode' : 'blendMode'] = blendMode(value);
      else if (k in fxv && typeof fxv[k] === 'number') fxv[k] = num(value, `${key}.${k}`, -10000, 10000);
      else if (k in fxv && typeof fxv[k] === 'boolean') fxv[k] = !!value;
      else if (styleChoices[`${key}.${k}`]?.includes(value as string)) fxv[k] = value;
      else if (styleChoices[`${key}.${k}`]) fail(`${key}.${k} must be one of ${styleChoices[`${key}.${k}`].join(', ')}.`);
      else fail(`${key} has no setting “${k}”.`);
    }
    style[key] = ['dropShadow', 'innerShadow', 'colorOverlay', 'stroke'].includes(key) ? [fxv] : fxv;
  }
  return style;
}
// Settings of effects that take one of a few words.
const styleChoices: Record<string, string[]> = {
  'stroke.position': ['outside', 'inside', 'center'],
  'bevel.style': ['outer-bevel', 'inner-bevel', 'emboss', 'pillow-emboss', 'stroke-emboss'],
  'bevel.technique': ['smooth', 'chisel-hard', 'chisel-soft'],
  'bevel.direction': ['up', 'down'],
  'outerGlow.technique': ['softer', 'precise'],
  'innerGlow.technique': ['softer', 'precise'],
  'innerGlow.source': ['edge', 'center'],
};

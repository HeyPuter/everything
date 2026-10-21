// Import / export operators of the interchange formats.
//
// Every format gets operators under the scripting names (wm.obj_import, export_scene.gltf, …).
// Invoked from a menu they ask for the file(s), the options (with presets) and companion files
// (material libraries, textures); run with `filepath` (scripts, drag and drop, redo) they read
// and write the session file store (io/vfs.ts) synchronously, so a script can export a file and
// read it back in the same run. Option ids follow the scripting property names; a format may give
// an option a different scripting name (`bpy`) and accept the scripting enum values (`bpyItems`).
import { app, registerOperators, type PropDef, type OpResult } from '../../app/app';
import type { DocumentData } from '../../data/types';
import { registerFormat } from '../files';
import { download } from '../native';
import { scriptState } from '../../scripting/rna';
import { imageCanvas, imageReady } from '../../render/images';
import { baseOf, dirOf, extOf, joinPath, normPath, stemOf, vfsCompanion, vfsRead, vfsWrite } from '../vfs';
import { AbortError, companionFilesDialog, loadOptions, optionsDialog, type FormatOption } from './ui';

export interface ImportSource {
  /** normalised path in the file store */
  path: string;
  name: string;
  bytes: Uint8Array;
  /** companion files by name (material libraries, textures, buffers) */
  resources: Map<string, Uint8Array>;
}

export interface CompanionRequest {
  title: string;
  message: string;
  names: string[];
  accept: string;
}

export interface ExportFile {
  bytes: Uint8Array | string;
  mime: string;
  /** main file extension, e.g. '.obj' or '.obj.zip' */
  ext: string;
  /** companion files written next to the main file (names relative to it) */
  extra?: { name: string; bytes: Uint8Array | string; mime: string }[];
}

export interface ExportTarget {
  /** file stem (no folder, no extension) */
  base: string;
  /** the requested path ('' when the file is only downloaded) */
  path: string;
  /** write companions as separate files (scripts) instead of packaging them (downloads) */
  toFiles: boolean;
}

export interface FormatDef {
  id: string;
  label: string;
  extensions: string[];
  description?: string;
  importOptions?: FormatOption[];
  exportOptions?: FormatOption[];
  /** operator ids; the first one is the File ▸ Import / Export entry, the others are aliases */
  importOps?: string[];
  exportOps?: string[];
  importOpLabel?: string;
  exportOpLabel?: string;
  /** the scripting property that limits an export to the selected objects */
  selectionProp?: string;
  /** several files per import (the `files` + `directory` properties) */
  multiFile?: boolean;
  /** companion files the source refers to that are not known yet (called until it returns null) */
  companions?: (src: { name: string; bytes: Uint8Array }, have: Map<string, Uint8Array>) => CompanionRequest | null;
  importData?: (src: ImportSource, options: Record<string, unknown>) => void | Promise<void>;
  exportData?: (options: Record<string, unknown> & ExportScope, target: ExportTarget) => ExportFile;
}

export interface ExportScope {
  selectedOnly: boolean;
  /** objects of a collection exporter (or the `collection` property) */
  objectIds?: Set<string>;
}

export const formatDefs = new Map<string, FormatDef>();

// ---------------------------------------------------------------------------
// properties ↔ options

const propType = (o: FormatOption): PropDef['type'] => (o.type === 'float' ? 'float' : o.type === 'int' ? 'int' : o.type === 'string' ? 'string' : o.type);

export function optionProps(options: FormatOption[]): PropDef[] {
  return options.map((o) => ({
    id: o.bpy ?? o.id,
    label: o.label,
    type: propType(o),
    // scene-dependent options stay unset so a script that leaves them out gets the scene's value
    default: o.dynamicDefault ? undefined : o.default,
    min: o.min,
    max: o.max,
    items: o.items?.map(([v, l]) => [v, l] as [string, string]),
    hidden: true,
  }));
}

/** Option values from operator properties (scripting names and values accepted). */
export function propsToOptions(options: FormatOption[], props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of options) {
    let v = props[o.bpy ?? o.id];
    if (v === undefined) v = props[o.id];
    if (v === undefined || v === null) {
      out[o.id] = o.dynamicDefault ? o.dynamicDefault() : o.default;
      continue;
    }
    if (o.type === 'bool') out[o.id] = !!v;
    else if (o.type === 'float' || o.type === 'int') {
      let n = Number(v);
      if (!Number.isFinite(n)) n = o.default as number;
      if (o.min !== undefined) n = Math.max(o.min, n);
      if (o.max !== undefined) n = Math.min(o.max, n);
      out[o.id] = o.type === 'int' ? Math.round(n) : n;
    } else if (o.type === 'enum') {
      const s = String(v);
      if (o.items?.some((i) => i[0] === s)) out[o.id] = s;
      else if (o.bpyItems && s in o.bpyItems) out[o.id] = o.bpyItems[s];
      else throw new Error(`${o.bpy ?? o.id}: enum "${s}" not found in (${[...(o.items ?? []).map((i) => i[0]), ...Object.keys(o.bpyItems ?? {})].map((x) => `'${x}'`).join(', ')})`);
    } else out[o.id] = String(v);
  }
  return out;
}

export function optionsToProps(options: FormatOption[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of options) out[o.bpy ?? o.id] = values[o.id] ?? (o.dynamicDefault ? o.dynamicDefault() : o.default);
  return out;
}

// ---------------------------------------------------------------------------
// helpers

export function collectionObjectIds(doc: DocumentData, name: string): Set<string> | null {
  const col = doc.collections[name] ?? Object.values(doc.collections).find((c) => c.name === name) ?? (name === 'Scene Collection' ? doc.collections[doc.scene.collection] : undefined);
  if (!col) return null;
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (cid: string) => {
    const c = doc.collections[cid];
    if (!c || seen.has(cid)) return;
    seen.add(cid);
    for (const o of c.objects) if (doc.objects[o]) out.add(o);
    for (const ch of c.children) walk(ch);
  };
  walk(col.id);
  return out;
}

/** Wait (bounded) until the images of the document are decoded, so exporters can read pixels. */
export async function ensureImagesReady(doc: DocumentData, timeoutMs = 8000) {
  const imgs = Object.values(doc.images).filter((im) => im.bytes?.length);
  for (const im of imgs) imageCanvas(im);
  const t0 = performance.now();
  while (imgs.some((im) => !imageReady(im)) && performance.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 30));
}

const TEMP_DIRS = /^\/(tmp|var\/tmp|private\/tmp|temp)\//i;

/** Files written under a temporary folder stay in the session store; others are also downloaded. */
export const isTempPath = (p: string) => TEMP_DIRS.test(normPath(p)) || /\/temp\//i.test(normPath(p));

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((res) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => res(Array.from(input.files ?? []));
    input.addEventListener('cancel', () => res([]));
    input.click();
  });
}

/** Resolve companion files of `path` from the store (scripts) — names next to the file, else anywhere. */
function storedCompanions(def: FormatDef, path: string, bytes: Uint8Array): Map<string, Uint8Array> {
  const have = new Map<string, Uint8Array>();
  if (!def.companions) return have;
  const asked = new Set<string>();
  for (let guard = 0; guard < 8; guard++) {
    const req = def.companions({ name: baseOf(path), bytes }, have);
    if (!req || asked.has(req.title)) break;
    asked.add(req.title);
    let added = 0;
    for (const n of req.names) {
      const b = vfsCompanion(path, n);
      if (b) {
        have.set(baseOf(n), b);
        added++;
      }
    }
    if (!added) break;
  }
  return have;
}

/** Paths an import operator was given: `files` + `directory`, else `filepath`. */
export function importPaths(p: Record<string, unknown>): string[] {
  const files = Array.isArray(p.files) ? (p.files as unknown[]) : [];
  const dir = String(p.directory ?? '');
  const names = files.map((f) => (f && typeof f === 'object' ? String((f as { name?: unknown }).name ?? '') : String(f ?? ''))).filter(Boolean);
  if (names.length) return names.map((n) => (dir ? joinPath(dir, n) : n.includes('/') ? normPath(n) : p.filepath ? joinPath(dirOf(String(p.filepath)), n) : normPath(n)));
  return p.filepath ? [normPath(String(p.filepath))] : [];
}

// ---------------------------------------------------------------------------
// import

function importExec(def: FormatDef, p: Record<string, unknown>): OpResult {
  const paths = importPaths(p);
  if (!paths.length) {
    app.report('ERROR', `${def.label}: no file path given`);
    return 'CANCELLED';
  }
  const options = propsToOptions(def.importOptions ?? [], p);
  const pending: Promise<void>[] = [];
  for (const path of paths) {
    const bytes = vfsRead(path);
    if (!bytes) {
      app.report('ERROR', `Cannot read "${path}": no such file in this session (pick it with File ▸ Import, or write it first)`);
      return 'CANCELLED';
    }
    const src: ImportSource = { path, name: baseOf(path), bytes, resources: storedCompanions(def, path, bytes) };
    const r = def.importData!(src, options);
    if (r instanceof Promise) pending.push(r);
    else app.report('INFO', `Imported "${src.name}"`);
  }
  if (pending.length) {
    // asynchronous readers (Collada): commit later as its own undo step
    void Promise.all(pending).then(
      () => {
        app.pushUndo(def.importOpLabel ?? `Import ${def.label}`);
        app.changed('doc', 'select');
        app.report('INFO', `Imported ${paths.map((x) => `"${baseOf(x)}"`).join(', ')}`);
      },
      (e) => app.report('ERROR', `Import failed: ${e instanceof Error ? e.message : String(e)}`),
    );
    return 'CANCELLED';
  }
  return 'FINISHED';
}

/** Store picked files, ask for companions and options, then run the operator with paths. */
async function importInteractive(def: FormatDef, opId: string, files: File[], props: Record<string, unknown>) {
  const intro = files.length === 1 ? files[0].name : `${files.length} files`;
  const values = await optionsDialog(def.importOpLabel ?? `Import ${def.label}`, `${def.id}:import`, def.importOptions ?? [], 'Import', intro, propsToOptions(def.importOptions ?? [], { ...optionsToProps(def.importOptions ?? [], dialogStart(def.importOptions ?? [], `${def.id}:import`)), ...stripDefaults(def.importOptions ?? [], props) }));
  const dir = '/imports';
  const names: string[] = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    vfsWrite(joinPath(dir, f.name), bytes);
    names.push(f.name);
    if (!def.companions) continue;
    const have = new Map<string, Uint8Array>();
    const asked = new Set<string>();
    for (let guard = 0; guard < 8; guard++) {
      const req = def.companions({ name: f.name, bytes }, have);
      if (!req || asked.has(req.title)) break;
      asked.add(req.title);
      // files already in the store from an earlier pick are reused without asking again
      const missing = req.names.filter((n) => !vfsCompanion(joinPath(dir, f.name), n));
      for (const n of req.names) {
        const b = vfsCompanion(joinPath(dir, f.name), n);
        if (b) have.set(baseOf(n), b);
      }
      if (!missing.length) continue;
      const picked = await companionFilesDialog(req.title, req.message, missing.map((n) => baseOf(n)), req.accept);
      if (!picked.length) break;
      for (const c of picked) {
        const b = new Uint8Array(await c.arrayBuffer());
        vfsWrite(joinPath(dir, c.name), b);
        have.set(c.name, b);
      }
    }
  }
  app.run(opId, { ...optionsToProps(def.importOptions ?? [], values), directory: dir, files: names.map((name) => ({ name })), filepath: joinPath(dir, names[0]) }, { invoke: false });
}

// ---------------------------------------------------------------------------
// export

function exportExec(def: FormatDef, p: Record<string, unknown>): OpResult {
  const options = propsToOptions(def.exportOptions ?? [], p);
  const selectedOnly = !!(p[def.selectionProp ?? 'use_selection'] ?? p.use_selection ?? p.selectedOnly);
  let objectIds: Set<string> | undefined;
  if (p.collection) {
    const ids = collectionObjectIds(app.doc, String(p.collection));
    if (!ids) {
      app.report('ERROR', `Collection "${p.collection}" not found`);
      return 'CANCELLED';
    }
    objectIds = ids;
  }
  const requested = String(p.filepath ?? '');
  const toDownload = !!p.download;
  const base = requested ? stemOf(requested) || 'untitled' : app.filename.replace(/\.[^.]+$/, '') || 'untitled';
  const out = def.exportData!({ ...options, selectedOnly, objectIds }, { base, path: requested, toFiles: !toDownload });
  // the written path: keep a known extension, otherwise add the format's
  let path = requested ? normPath(requested) : '';
  if (path) {
    const ext = extOf(path);
    const known = def.extensions.includes(ext) || out.ext.endsWith(ext);
    if (!ext || !known) path = `${path}${out.ext}`;
    else if (out.ext.endsWith('.zip') && !path.endsWith('.zip')) path = `${path.replace(/\.[^./]*$/, '')}${out.ext}`;
    vfsWrite(path, out.bytes);
    for (const e of out.extra ?? []) vfsWrite(joinPath(dirOf(path), e.name), e.bytes);
  }
  const name = path ? baseOf(path) : `${base}${out.ext}`;
  // menus download; scripts download what they write outside temporary folders
  if (toDownload || (!path ? true : !isTempPath(path))) {
    download(out.bytes, name, out.mime);
    for (const e of out.extra ?? []) download(e.bytes, e.name, e.mime);
  }
  app.report('INFO', `Exported "${name}"`);
  return 'FINISHED';
}

async function exportInteractive(def: FormatDef, opId: string, props: Record<string, unknown>) {
  await ensureImagesReady(app.doc);
  const selProp = def.selectionProp ?? 'use_selection';
  const selected = !!props[selProp];
  const values = await optionsDialog(def.exportOpLabel ?? `Export ${def.label}`, `${def.id}:export`, def.exportOptions ?? [], 'Export', selected ? 'Selected objects only' : 'All objects in the scene', propsToOptions(def.exportOptions ?? [], { ...optionsToProps(def.exportOptions ?? [], dialogStart(def.exportOptions ?? [], `${def.id}:export`)), ...stripDefaults(def.exportOptions ?? [], props) }), {
    id: selProp,
    label: 'Selected Only',
    value: selected,
  });
  const sel = values.__selection as boolean | undefined;
  delete values.__selection;
  app.run(opId, { ...props, ...optionsToProps(def.exportOptions ?? [], values), [selProp]: sel ?? selected, filepath: props.filepath || `//${app.filename.replace(/\.[^.]+$/, '') || 'untitled'}`, download: true }, { invoke: false });
}

/** Remembered dialog values, with options that follow the scene (frame ranges) filled in fresh. */
function dialogStart(options: FormatOption[], key: string): Record<string, unknown> {
  const v = loadOptions(key, options);
  for (const o of options) if (o.dynamicDefault) v[o.id] = o.dynamicDefault();
  return v;
}

/** Properties that differ from the operator defaults (menu entries that preset an option). */
function stripDefaults(options: FormatOption[], props: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const o of options) {
    const k = o.bpy ?? o.id;
    if (k in props && props[k] !== o.default) out[k] = props[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// registration

const filePathProps = (multi: boolean): PropDef[] => [
  { id: 'filepath', label: 'File Path', type: 'string', default: '', hidden: true },
  ...(multi ? [{ id: 'directory', label: 'Directory', type: 'string', default: '', hidden: true } as PropDef] : []),
  { id: 'filter_glob', label: 'Filter', type: 'string', default: '', hidden: true },
];

export function defineFormat(def: FormatDef) {
  formatDefs.set(def.id, def);
  const importOps = def.importData ? (def.importOps?.length ? def.importOps : [`wm.${def.id}_import`]) : [];
  const exportOps = def.exportData ? (def.exportOps?.length ? def.exportOps : [`wm.${def.id}_export`]) : [];
  const accept = def.extensions.join(',');
  const ops = [];
  for (const id of importOps) {
    ops.push({
      idname: id,
      label: def.importOpLabel ?? `Import ${def.label}`,
      description: `Load a ${def.label.replace(/\s*\(.*\)$/, '')} file${def.description ? `: ${def.description}` : ''}`,
      props: [...filePathProps(true), ...optionProps(def.importOptions ?? [])],
      redo: false,
      exec: (_ctx: unknown, p: Record<string, unknown>) => importExec(def, p),
      invoke: (_ctx: unknown, p: Record<string, unknown>) => {
        if (importPaths(p).length) return importExec(def, p);
        void pickFiles(accept, !!def.multiFile)
          .then((files) => (files.length ? importInteractive(def, importOps[0], files, p) : undefined))
          .catch((e) => {
            if (!(e instanceof AbortError)) app.report('ERROR', `Import failed: ${e instanceof Error ? e.message : String(e)}`);
          });
        return 'CANCELLED' as const;
      },
    });
  }
  for (const id of exportOps) {
    ops.push({
      idname: id,
      label: def.exportOpLabel ?? `Export ${def.label}`,
      description: `Write the scene${def.selectionProp ? ' (or the selected objects)' : ''} to a ${def.label.replace(/\s*\(.*\)$/, '')} file`,
      props: [
        ...filePathProps(false),
        { id: def.selectionProp ?? 'use_selection', label: 'Selected Only', type: 'bool', default: false, hidden: true } as PropDef,
        { id: 'collection', label: 'Collection', type: 'string', default: '', hidden: true } as PropDef,
        { id: 'download', label: 'Download', type: 'bool', default: false, hidden: true } as PropDef,
        ...optionProps(def.exportOptions ?? []),
      ],
      undo: false,
      exec: (_ctx: unknown, p: Record<string, unknown>) => exportExec(def, p),
      invoke: (_ctx: unknown, p: Record<string, unknown>) => {
        // scripts that pass a path run directly, like the desktop's EXEC
        if (p.filepath && scriptState.depth > 0) return exportExec(def, p);
        void exportInteractive(def, exportOps[0], p).catch((e) => {
          if (!(e instanceof AbortError)) app.report('ERROR', `Export failed: ${e instanceof Error ? e.message : String(e)}`);
        });
        return 'CANCELLED' as const;
      },
    });
  }
  registerOperators(ops as never);
  registerFormat({
    id: def.id,
    label: def.label,
    extensions: def.extensions,
    description: def.description,
    importOp: importOps[0],
    exportOp: exportOps[0],
    // drag and drop / File Browser: the picked file goes through the options dialog
    import: def.importData ? (file: File) => importInteractive(def, importOps[0], [file], {}) : undefined,
    handlesUndo: true,
  });
}

/** Run an export for a list of objects into the store (collection exporters); returns the written path. */
export function exportToPath(formatId: string, path: string, props: Record<string, unknown>, objectIds?: Set<string>): string | null {
  const def = formatDefs.get(formatId);
  if (!def?.exportData) return null;
  const options = propsToOptions(def.exportOptions ?? [], props);
  const out = def.exportData({ ...options, selectedOnly: false, objectIds }, { base: stemOf(path), path, toFiles: true });
  let p = normPath(path);
  if (!def.extensions.includes(extOf(p))) p = `${p}${out.ext}`;
  vfsWrite(p, out.bytes);
  for (const e of out.extra ?? []) vfsWrite(joinPath(dirOf(p), e.name), e.bytes);
  if (!isTempPath(p)) {
    download(out.bytes, baseOf(p), out.mime);
    for (const e of out.extra ?? []) download(e.bytes, e.name, e.mime);
  }
  return p;
}

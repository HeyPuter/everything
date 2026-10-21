// File ▸ External Data and File ▸ Data Previews operators, plus small file-level window-manager
// operators (save an auto save now, open a path, validate names).
//
// Everything a project uses is stored inside it, so "packing" here means filling resources that
// only have a path (e.g. images of an imported file) from the session's files (io/vfs.ts: files
// picked for imports, written by exports or by scripts); unpacking writes them out as downloads.
import { app, registerOperators } from '../app/app';
import type { DocumentData, ImageData } from '../data/types';
import type { MenuItem } from '../ui/menu';
import { download } from './native';
import { autosave } from './files';
import { takeSnapshot } from './session';
import { baseOf, normPath, PROJECT_DIR, vfsFind, vfsRead } from './vfs';
import { imageSize, sniffMime } from './formats/common';
import { ASSET_TABLES, assetsOf, type AssetTable } from '../assets/types';
import { renderPreview } from '../assets/preview';
import { ensureLibrary, saveLibrary, userLibraries } from '../assets/library';

declare module '../data/types' {
  interface DocumentData {
    /** File ▸ External Data ▸ Automatically Pack Resources */
    use_autopack?: boolean;
  }
}

// ---------------------------------------------------------------------------
// external file paths

/** A file path stored in the document, with its stored bytes when there are any. */
export interface PathRef {
  kind: 'IMAGE' | 'FONT' | 'VOLUME' | 'LIBRARY' | 'MOVIECLIP' | 'SOUND' | 'CACHEFILE' | 'FILE';
  name: string;
  get(): string;
  set(v: string): void;
  owner: Record<string, unknown>;
}

/** Every external file path of the document (images, fonts, volumes, libraries, clips, sounds, caches). */
export function externalPaths(doc: DocumentData): PathRef[] {
  const out: PathRef[] = [];
  const add = (kind: PathRef['kind'], name: string, owner: Record<string, unknown>) => {
    if (typeof owner.filepath !== 'string') return;
    out.push({ kind, name, owner, get: () => owner.filepath as string, set: (v) => (owner.filepath = v) });
  };
  const tables: [PathRef['kind'], Record<string, unknown> | undefined][] = [
    ['IMAGE', doc.images],
    ['FONT', doc.fonts],
    ['VOLUME', doc.volumes],
    ['LIBRARY', doc.libraries],
    ['MOVIECLIP', (doc as { movieclips?: Record<string, unknown> }).movieclips],
    ['FILE', doc.packed_files],
  ];
  for (const [kind, t] of tables) for (const rec of Object.values(t ?? {})) add(kind, String((rec as { name?: string }).name ?? ''), rec as Record<string, unknown>);
  for (const ob of Object.values(doc.objects)) {
    const snd = ob.speaker?.sound as Record<string, unknown> | null | undefined;
    if (snd) add('SOUND', ob.name, snd);
    for (const m of ob.modifiers) if (typeof (m as Record<string, unknown>).filepath === 'string') add('CACHEFILE', `${ob.name} ▸ ${m.name}`, m as unknown as Record<string, unknown>);
  }
  // sequencer media (all scenes)
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || seen.has(v) || depth > 12 || ArrayBuffer.isView(v)) return;
    seen.add(v);
    const r = v as Record<string, unknown>;
    if (typeof r.filepath === 'string' && 'bytes' in r) add('SOUND', baseOf(r.filepath) || 'Media', r);
    for (const x of Object.values(r)) walk(x, depth + 1);
  };
  const scenes = [doc.scene, ...Object.values((doc as { scenes?: Record<string, unknown> }).scenes ?? {})];
  for (const sc of scenes) walk((sc as { sequence_editor?: unknown }).sequence_editor, 0);
  return out;
}

/** '//x' style path of a path inside the project folder, or null when it is elsewhere. */
export function relativePath(p: string): string | null {
  if (!p || p.startsWith('//')) return p ? p : null;
  if (!/^([a-zA-Z]:)?[\\/]/.test(p)) return null; // bare names stay as they are
  const n = normPath(p);
  return n.startsWith(`${PROJECT_DIR}/`) ? `//${n.slice(PROJECT_DIR.length + 1)}` : null;
}

export function absolutePath(p: string): string {
  return p.startsWith('//') ? normPath(p) : p;
}

export function makePaths(doc: DocumentData, relative: boolean): { changed: number; failed: string[] } {
  let changed = 0;
  const failed: string[] = [];
  for (const r of externalPaths(doc)) {
    const p = r.get();
    if (!p) continue;
    if (relative) {
      if (p.startsWith('//')) continue;
      const rel = relativePath(p);
      if (rel === null) {
        if (/^([a-zA-Z]:)?[\\/]/.test(p)) failed.push(`${r.name} (${p})`);
        continue;
      }
      r.set(rel);
      changed++;
    } else if (p.startsWith('//')) {
      r.set(absolutePath(p));
      changed++;
    }
  }
  return { changed, failed };
}

// ---------------------------------------------------------------------------
// packing

/** Fill one image that has only a path from the session files; true when its pixels arrived. */
export function packImage(im: ImageData): boolean {
  if (im.bytes?.length || !im.filepath) return false;
  const bytes = vfsRead(im.filepath) ?? vfsFind(baseOf(im.filepath))?.bytes ?? null;
  if (!bytes) return false;
  const mime = sniffMime(bytes);
  if (!mime.startsWith('image/')) return false;
  const { width, height } = imageSize(bytes);
  Object.assign(im, { bytes, mime, width: width || im.width, height: height || im.height, revision: (im.revision ?? 0) + 1 });
  return true;
}

/** Pack every resource that has a path but no stored data; returns the counts. */
export function packAll(doc: DocumentData): { packed: number; missing: string[] } {
  let packed = 0;
  const missing: string[] = [];
  for (const r of externalPaths(doc)) {
    const o = r.owner;
    const p = r.get();
    if (!p || !('bytes' in o) || (o.bytes as Uint8Array | null)?.length) continue;
    if (r.kind === 'IMAGE') {
      if ((o as unknown as ImageData).source !== 'FILE') continue;
      if (packImage(o as unknown as ImageData)) packed++;
      else missing.push(r.name);
      continue;
    }
    const bytes = vfsRead(p) ?? vfsFind(baseOf(p))?.bytes ?? null;
    if (bytes) {
      o.bytes = bytes;
      packed++;
    } else missing.push(r.name);
  }
  return { packed, missing };
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/x-exr': 'exr', 'image/vnd.radiance': 'hdr', 'image/tiff': 'tif' };

function fileNameOf(r: PathRef): string {
  const o = r.owner as { bytes?: Uint8Array; mime?: string };
  let name = baseOf(r.get() || r.name).replace(/[^\w.\- ]/g, '_') || 'file';
  if (!/\.[a-z0-9]+$/i.test(name)) name += `.${EXT[o.mime ?? ''] ?? (o.bytes ? EXT[sniffMime(o.bytes)] : undefined) ?? 'bin'}`;
  return name;
}

const ID_TYPES: [string, string][] = [
  ['IMAGE', 'Image'],
  ['SOUND', 'Sound'],
  ['FONT', 'Font'],
  ['VOLUME', 'Volume'],
  ['MOVIECLIP', 'Movie Clip'],
  ['LIBRARY', 'Library'],
];

const UNPACK_METHODS: [string, string][] = [
  ['USE_LOCAL', 'Use Local File'],
  ['WRITE_LOCAL', 'Write Local File (overwrite existing)'],
  ['USE_ORIGINAL', 'Use Original File'],
  ['WRITE_ORIGINAL', 'Write Original File (overwrite existing)'],
  ['KEEP', 'Keep Stored'],
  ['REMOVE', 'Remove Stored Data'],
];

// ---------------------------------------------------------------------------
// previews

/** Asset data-block types offered by "Clear Data-Block Previews". */
const PREVIEW_TYPES: [string, string][] = [
  ['ALL', 'All Types'],
  ['COLLECTION', 'Collections'],
  ['OBJECT', 'Objects'],
  ['MATERIAL', 'Materials'],
  ['WORLD', 'Worlds'],
  ['NODETREE', 'Node Groups'],
  ['ACTION', 'Actions'],
  ['BRUSH', 'Brushes'],
];
const TYPE_TABLE: Record<string, AssetTable> = { COLLECTION: 'collections', OBJECT: 'objects', MATERIAL: 'materials', WORLD: 'worlds', NODETREE: 'node_groups', ACTION: 'actions', BRUSH: 'brushes' };

/** Render the missing (automatic) previews of a document's assets; returns how many were made. */
export function ensurePreviews(doc: DocumentData, tables: readonly AssetTable[] = ASSET_TABLES): number {
  let n = 0;
  for (const { table, block } of assetsOf(doc)) {
    if (!tables.includes(table) || !block.asset_data || block.asset_data.preview) continue;
    const url = renderPreview(doc, table, block.id);
    if (url) {
      block.asset_data.preview = url;
      block.asset_data.preview_custom = false;
      n++;
    }
  }
  return n;
}

export function clearPreviews(doc: DocumentData, tables: readonly AssetTable[] = ASSET_TABLES): number {
  let n = 0;
  for (const { table, block } of assetsOf(doc))
    if (tables.includes(table) && block.asset_data?.preview) {
      delete block.asset_data.preview;
      delete block.asset_data.preview_custom;
      n++;
    }
  return n;
}

const tablesOf = (p: Record<string, unknown>): AssetTable[] => {
  const v = String(p.id_type ?? 'ALL');
  return v === 'ALL' || !TYPE_TABLE[v] ? [...ASSET_TABLES] : [TYPE_TABLE[v]];
};

// ---------------------------------------------------------------------------
// names

/** Replace characters that cannot be stored (lone surrogates, control characters) in a name. */
export function cleanName(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      } else out += '�';
    } else if (c >= 0xdc00 && c <= 0xdfff) out += '�';
    else if (c < 0x20 || c === 0x7f) out += '_';
    else out += s[i];
  }
  return out;
}

/** Fix invalid names of every data-block (and bones, vertex groups); returns the fixed count. */
export function validateNames(doc: DocumentData): number {
  let n = 0;
  const fix = (o: { name?: unknown }) => {
    if (typeof o.name !== 'string') return;
    const c = cleanName(o.name);
    if (c !== o.name) {
      o.name = c;
      n++;
    }
  };
  for (const v of Object.values(doc as unknown as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    for (const rec of Object.values(v as Record<string, unknown>)) if (rec && typeof rec === 'object' && 'id' in (rec as object)) fix(rec as { name?: unknown });
  }
  for (const arm of Object.values(doc.armatures)) for (const b of arm.bones) fix(b);
  for (const me of Object.values(doc.meshes)) for (const g of (me as { vertex_groups?: { name: string }[] }).vertex_groups ?? []) fix(g);
  return n;
}

// ---------------------------------------------------------------------------
// menus

export function externalDataMenu(): MenuItem[] {
  return [
    { label: 'Automatically Pack Resources', op: 'file.autopack_toggle', checked: !!app.doc.use_autopack },
    { label: 'Pack Resources', op: 'file.pack_all' },
    { label: 'Unpack Resources…', op: 'file.unpack_all' },
    { separator: true },
    { label: 'Pack Linked Libraries', op: 'file.pack_libraries' },
    { label: 'Unpack Linked Libraries', op: 'file.unpack_libraries' },
    { separator: true },
    { label: 'Make Paths Relative', op: 'file.make_paths_relative' },
    { label: 'Make Paths Absolute', op: 'file.make_paths_absolute' },
    { separator: true },
    { label: 'Report Missing Files', op: 'file.report_missing_files' },
    { label: 'Find Missing Files…', op: 'file.find_missing_files' },
  ];
}

export function previewsMenu(): MenuItem[] {
  return [
    { label: 'Refresh Data-Block Previews', op: 'wm.previews_ensure' },
    { label: 'Batch-Generate Previews…', op: 'wm.previews_batch_generate' },
    { separator: true },
    { label: 'Clear Data-Block Previews…', op: 'wm.previews_clear' },
    { label: 'Batch-Clear Previews…', op: 'wm.previews_batch_clear' },
  ];
}

// ---------------------------------------------------------------------------
// operators

const libraryScopeProps = [
  { id: 'use_collections', label: 'Collections', type: 'bool' as const, default: true },
  { id: 'use_objects', label: 'Objects', type: 'bool' as const, default: true },
  { id: 'use_intern_data', label: 'Materials, Worlds, Node Groups…', type: 'bool' as const, default: true },
];

function scopeTables(p: Record<string, unknown>): AssetTable[] {
  const t: AssetTable[] = [];
  if (p.use_collections !== false) t.push('collections');
  if (p.use_objects !== false) t.push('objects');
  if (p.use_intern_data !== false) t.push('materials', 'worlds', 'node_groups', 'actions', 'brushes');
  return t;
}

async function batchLibraries(p: Record<string, unknown>, clear: boolean) {
  const libs = userLibraries();
  if (!libs.length) {
    app.report('WARNING', 'There are no user asset libraries (add one in the Asset Browser)');
    return;
  }
  let n = 0;
  for (const lib of libs) {
    const doc = await ensureLibrary(lib.id);
    if (!doc) continue;
    const k = clear ? clearPreviews(doc, scopeTables(p)) : ensurePreviews(doc, scopeTables(p));
    if (k) {
      n += k;
      await saveLibrary(lib.id, true);
    }
  }
  app.report('INFO', `${clear ? 'Cleared' : 'Generated'} ${n} preview${n === 1 ? '' : 's'} in ${libs.length} librar${libs.length === 1 ? 'y' : 'ies'}`);
  app.changed('ui');
}

registerOperators([
  {
    idname: 'file.autopack_toggle',
    label: 'Automatically Pack Resources',
    description: 'Pack resources that only have a file path (from the files of this session) every time the project is saved',
    exec: (ctx) => {
      ctx.doc.use_autopack = !ctx.doc.use_autopack;
      if (ctx.doc.use_autopack) packAll(ctx.doc);
      app.report('INFO', `Automatic packing ${ctx.doc.use_autopack ? 'enabled' : 'disabled'}`);
    },
  },
  {
    idname: 'file.pack_all',
    label: 'Pack Resources',
    description: 'Store resources that only have a file path in the project, taking them from the files of this session (picked for imports or written by exports and scripts)',
    exec: (ctx) => {
      const { packed, missing } = packAll(ctx.doc);
      if (missing.length) app.report('WARNING', `Not found among this session's files: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ` and ${missing.length - 6} more` : ''} (use Find Missing Files)`);
      if (!packed) {
        app.report('INFO', missing.length ? 'Nothing was packed' : 'All resources are already stored in the project');
        return 'CANCELLED';
      }
      app.report('INFO', `Packed ${packed} file${packed === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'file.unpack_item',
    label: 'Unpack Item',
    description: 'Save one stored resource as a file (download); "Remove Stored Data" keeps only its path',
    props: [
      { id: 'method', label: 'Method', type: 'enum', default: 'USE_LOCAL', items: UNPACK_METHODS },
      { id: 'id_name', label: 'Name', type: 'string', default: '' },
      { id: 'id_type', label: 'Type', type: 'enum', default: 'IMAGE', items: ID_TYPES },
    ],
    exec: (ctx, p) => {
      const r = externalPaths(ctx.doc).find((x) => x.kind === p.id_type && x.name === p.id_name);
      const o = r?.owner as { bytes?: Uint8Array | null; mime?: string } | undefined;
      if (!r || !o?.bytes?.length) {
        app.report('ERROR', `No stored ${String(p.id_type).toLowerCase()} named "${p.id_name}"`);
        return 'CANCELLED';
      }
      if (p.method === 'KEEP') return 'CANCELLED';
      if (p.method === 'REMOVE') {
        if (!r.get()) {
          app.report('ERROR', `"${p.id_name}" has no file path to fall back on`);
          return 'CANCELLED';
        }
        o.bytes = null;
        return;
      }
      download(o.bytes, fileNameOf(r), o.mime ?? 'application/octet-stream');
      app.report('INFO', `Unpacked "${fileNameOf(r)}"`);
      return 'CANCELLED';
    },
  },
  {
    idname: 'file.make_paths_relative',
    label: 'Make Paths Relative',
    description: 'Write file paths inside the project folder relative to it (//…)',
    exec: (ctx) => {
      const { changed, failed } = makePaths(ctx.doc, true);
      if (failed.length) app.report('WARNING', `${failed.length} path${failed.length === 1 ? '' : 's'} outside the project folder stay absolute: ${failed.slice(0, 4).join(', ')}`);
      app.report('INFO', `Made ${changed} path${changed === 1 ? '' : 's'} relative`);
      if (!changed) return 'CANCELLED';
    },
  },
  {
    idname: 'file.make_paths_absolute',
    label: 'Make Paths Absolute',
    description: 'Write relative (//…) file paths as full paths',
    exec: (ctx) => {
      const { changed } = makePaths(ctx.doc, false);
      app.report('INFO', `Made ${changed} path${changed === 1 ? '' : 's'} absolute`);
      if (!changed) return 'CANCELLED';
    },
  },
  {
    idname: 'image.unpack',
    label: 'Unpack Image',
    description: 'Save the stored image as a file (download)',
    props: [
      { id: 'method', label: 'Method', type: 'enum', default: 'USE_LOCAL', items: UNPACK_METHODS },
      { id: 'id', label: 'Image Name', type: 'string', default: '' },
    ],
    poll: (ctx) => Object.values(ctx.doc.images).some((im) => im.bytes?.length),
    exec: (_ctx, p) => app.run('file.unpack_item', { method: p.method, id_name: p.id || activeImageName(), id_type: 'IMAGE' }, { invoke: false }),
  },
  {
    idname: 'sound.pack',
    label: 'Pack Sound',
    description: 'Store sounds that only have a file path in the project (from the files of this session)',
    exec: (ctx) => {
      let n = 0;
      for (const r of externalPaths(ctx.doc)) {
        if (r.kind !== 'SOUND' || (r.owner.bytes as Uint8Array | null)?.length) continue;
        const b = vfsRead(r.get()) ?? vfsFind(baseOf(r.get()))?.bytes;
        if (b) {
          r.owner.bytes = b;
          n++;
        }
      }
      app.report('INFO', n ? `Packed ${n} sound${n === 1 ? '' : 's'}` : 'Sounds are already stored in the project');
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'sound.unpack',
    label: 'Unpack Sound',
    description: 'Save a stored sound as a file (download)',
    props: [
      { id: 'method', label: 'Method', type: 'enum', default: 'USE_LOCAL', items: UNPACK_METHODS },
      { id: 'id', label: 'Sound Name', type: 'string', default: '' },
    ],
    exec: (ctx, p) => {
      const sounds = externalPaths(ctx.doc).filter((r) => r.kind === 'SOUND' && (r.owner.bytes as Uint8Array | null)?.length);
      const want = String(p.id ?? '');
      const r = sounds.find((s) => !want || s.name === want || baseOf(s.get()) === want) ?? (want ? undefined : sounds[0]);
      if (!r) {
        app.report('ERROR', want ? `No stored sound named "${want}"` : 'There are no stored sounds');
        return 'CANCELLED';
      }
      download(r.owner.bytes as Uint8Array, fileNameOf(r), String(r.owner.mime ?? 'audio/wav'));
      return 'CANCELLED';
    },
  },
  {
    idname: 'wm.previews_ensure',
    label: 'Refresh Data-Block Previews',
    description: 'Render the missing previews of the assets in this file',
    exec: (ctx) => {
      const n = ensurePreviews(ctx.doc);
      app.report('INFO', n ? `Rendered ${n} preview${n === 1 ? '' : 's'}` : 'All asset previews are up to date');
      if (!n) return 'CANCELLED';
      app.changed('ui');
    },
  },
  {
    idname: 'wm.previews_clear',
    label: 'Clear Data-Block Previews',
    description: 'Remove the previews of the assets of the chosen types in this file',
    props: [{ id: 'id_type', label: 'Data-Block Type', type: 'enum', default: 'ALL', items: PREVIEW_TYPES }],
    exec: (ctx, p) => {
      const n = clearPreviews(ctx.doc, tablesOf(p));
      app.report('INFO', `Cleared ${n} preview${n === 1 ? '' : 's'}`);
      if (!n) return 'CANCELLED';
      app.changed('ui');
    },
  },
  {
    idname: 'wm.previews_batch_generate',
    label: 'Batch-Generate Previews',
    description: 'Render the missing previews of the assets in every user asset library',
    props: libraryScopeProps,
    undo: false,
    exec: (_ctx, p) => {
      void batchLibraries(p, false);
      return 'CANCELLED';
    },
  },
  {
    idname: 'wm.previews_batch_clear',
    label: 'Batch-Clear Previews',
    description: 'Remove the asset previews of every user asset library',
    props: libraryScopeProps,
    undo: false,
    exec: (_ctx, p) => {
      void batchLibraries(p, true);
      return 'CANCELLED';
    },
  },
  {
    idname: 'wm.save_auto_save',
    label: 'Save Autosave',
    description: 'Write an auto save of the current state now (File ▸ Recover ▸ Auto Save lists it)',
    undo: false,
    exec: () => {
      void (async () => {
        try {
          await autosave();
          await takeSnapshot('Saved on request');
          app.report('INFO', 'Auto save written');
        } catch (e) {
          app.report('ERROR', `Auto save failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    },
  },
  {
    idname: 'wm.path_open',
    label: 'Open Path',
    description: 'Open a file of this session (or a web address) in a new browser tab',
    props: [{ id: 'filepath', label: 'File Path', type: 'string', default: '' }],
    undo: false,
    exec: (_ctx, p) => {
      const path = String(p.filepath ?? '');
      if (/^https?:\/\//i.test(path)) {
        window.open(path, '_blank', 'noopener');
        return;
      }
      const bytes = path ? vfsRead(path) : null;
      if (!bytes) {
        app.report('ERROR', path ? `"${path}" is not among this session's files` : 'No path given');
        return 'CANCELLED';
      }
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: sniffMime(bytes) === 'application/octet-stream' ? 'text/plain' : sniffMime(bytes) }));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  },
  {
    idname: 'wm.blend_strings_utf8_validate',
    label: 'Validate Names',
    description: 'Replace characters that cannot be stored in data-block, bone and vertex group names',
    exec: (ctx) => {
      const n = validateNames(ctx.doc);
      app.report('INFO', n ? `Fixed ${n} name${n === 1 ? '' : 's'}` : 'All names are valid');
      if (!n) return 'CANCELLED';
    },
  },
]);

function activeImageName(): string {
  const ims = Object.values(app.doc.images).filter((im) => im.bytes?.length);
  return ims[0]?.name ?? '';
}

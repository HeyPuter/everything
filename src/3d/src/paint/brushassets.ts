// Brush assets: saving the active brush's changes back to its asset library, reverting it, deleting
// it, editing its metadata and loading a custom preview image. A brush is either a copy of an asset
// from a library (stamped with its source), an asset of the current file, or one of the built-in
// brushes (which revert to their factory settings).
import { app, registerOperators } from '../app/app';
import { cloneShared } from '../data/cow';
import type { DocumentData } from '../data/types';
import type { MenuItem } from '../ui/menu';
import { operatorDialog } from '../ui/opdialog';
import { ESSENTIALS, LOCAL, libraryChanged, libraryDoc, libraryInfo, removeFromLibrary, saveLibrary } from '../assets/library';
import { catalogById, ensureCatalogPath } from '../assets/catalogs';
import { newMetaData, type AssetCatalog, type AssetMetaData } from '../assets/types';
import { activeBrush, BRUSH_LISTS, factoryBrush, isBrushMode, type BrushMode, type PaintBrush } from './brushes';
import { setActiveTool } from '../editors/view3d/toolbar';

type AssetBrush = PaintBrush & { asset_data?: AssetMetaData; asset_source?: string };

export type BrushOrigin = { kind: 'LIBRARY'; library: string; id: string } | { kind: 'LOCAL_ASSET' } | { kind: 'BUILTIN' } | { kind: 'LOCAL' };

const builtinIds = () => new Set(Object.values(BRUSH_LISTS).flatMap((l) => l.filter(Boolean).map((b) => b!.id)));

/** Where the brush comes from (pure apart from the built-in brush list). */
export function brushOrigin(b: AssetBrush): BrushOrigin {
  if (b.asset_source) {
    const i = b.asset_source.lastIndexOf('/');
    if (i > 0) return { kind: 'LIBRARY', library: b.asset_source.slice(0, i), id: b.asset_source.slice(i + 1) };
  }
  if (b.asset_data) return { kind: 'LOCAL_ASSET' };
  if (builtinIds().has(b.id)) return { kind: 'BUILTIN' };
  return { kind: 'LOCAL' };
}

/** Settings of a brush without its identity (id, name, asset metadata, source stamp). */
export function brushSettings(b: AssetBrush): Partial<AssetBrush> {
  const out = cloneShared(b) as Partial<AssetBrush>;
  delete out.id;
  delete out.name;
  delete out.asset_data;
  delete out.asset_source;
  return out;
}

/** Replace the settings of `dst` by those of `src`, keeping the identity of `dst`. */
export function copyBrushSettings(dst: AssetBrush, src: AssetBrush) {
  const keep = { id: dst.id, name: dst.name, asset_data: dst.asset_data, asset_source: dst.asset_source };
  for (const k of Object.keys(dst)) delete (dst as unknown as Record<string, unknown>)[k];
  Object.assign(dst, brushSettings(src), keep);
  if (keep.asset_data === undefined) delete dst.asset_data;
  if (keep.asset_source === undefined) delete dst.asset_source;
}

function current(): AssetBrush | null {
  const m = app.doc.mode;
  return isBrushMode(m) ? (activeBrush(m as BrushMode) as AssetBrush | null) : null;
}

const writableLibrary = (lib: string) => libraryInfo(lib)?.kind === 'USER';

function libraryBrush(o: BrushOrigin): { doc: DocumentData; brush: AssetBrush } | null {
  if (o.kind !== 'LIBRARY') return null;
  const doc = libraryDoc(o.library);
  const brush = doc?.brushes[o.id] as AssetBrush | undefined;
  return doc && brush ? { doc, brush } : null;
}

/** The metadata record the metadata / preview operators edit (library copy or the file's own). */
function metadataTarget(b: AssetBrush): { meta: AssetMetaData; catalogs: AssetCatalog[]; library: string | null } | null {
  const o = brushOrigin(b);
  if (o.kind === 'LIBRARY') {
    if (!writableLibrary(o.library)) return null;
    const lb = libraryBrush(o);
    if (!lb) return null;
    lb.brush.asset_data ??= newMetaData();
    return { meta: lb.brush.asset_data, catalogs: (lb.doc.asset_catalogs ??= []), library: o.library };
  }
  if (o.kind === 'LOCAL_ASSET') return { meta: b.asset_data!, catalogs: (app.doc.asset_catalogs ??= []), library: null };
  return null;
}

function touched(library: string | null) {
  if (library) libraryChanged(library);
  app.changed('ui');
}

registerOperators([
  {
    idname: 'brush.asset_save',
    label: 'Save Brush Asset',
    description: 'Write the changed settings of the active brush back to its asset library',
    poll: () => {
      const b = current();
      if (!b) return false;
      const o = brushOrigin(b);
      return o.kind === 'LIBRARY' && writableLibrary(o.library) && !!libraryBrush(o);
    },
    exec: () => {
      const b = current()!;
      const o = brushOrigin(b);
      const lb = libraryBrush(o)!;
      copyBrushSettings(lb.brush, b);
      void saveLibrary((o as { library: string }).library);
      touched((o as { library: string }).library);
      app.report('INFO', `Saved the changes of "${b.name}" to its asset library`);
    },
  },
  {
    idname: 'brush.asset_revert',
    label: 'Revert Brush Asset',
    description: 'Throw away the changes to the active brush: back to the asset as stored in its library (built-in brushes return to their defaults)',
    poll: () => {
      const b = current();
      if (!b) return false;
      const o = brushOrigin(b);
      return o.kind === 'BUILTIN' || (o.kind === 'LIBRARY' && !!libraryBrush(o));
    },
    exec: () => {
      const b = current()!;
      const o = brushOrigin(b);
      if (o.kind === 'BUILTIN') {
        const f = factoryBrush(b.id);
        if (!f) return 'CANCELLED';
        copyBrushSettings(b, f as AssetBrush);
      } else {
        const lb = libraryBrush(o);
        if (!lb) return 'CANCELLED';
        copyBrushSettings(b, lb.brush);
      }
      app.changed('ui');
    },
  },
  {
    idname: 'brush.asset_delete',
    label: 'Delete Brush Asset',
    description: 'Delete the active brush asset: from its asset library, or from this file',
    poll: () => {
      const b = current();
      if (!b) return false;
      const o = brushOrigin(b);
      return o.kind === 'LOCAL_ASSET' || (o.kind === 'LIBRARY' && writableLibrary(o.library)) || o.kind === 'LOCAL';
    },
    exec: (ctx) => {
      const b = current()!;
      const o = brushOrigin(b);
      const mode = ctx.doc.mode as BrushMode;
      if (o.kind === 'LIBRARY') {
        if (!removeFromLibrary(o.library, [{ table: 'brushes', id: o.id }])) return 'CANCELLED';
      }
      // the brush itself leaves the file; the mode falls back to its first built-in brush
      delete ctx.doc.brushes[b.id];
      const first = BRUSH_LISTS[mode].find((x) => !!x);
      if (first) setActiveTool(first.id);
      app.report('INFO', `Deleted the brush "${b.name}"`);
    },
  },
  {
    idname: 'brush.asset_edit_metadata',
    label: 'Edit Metadata',
    description: 'Change the catalog, author and description of the active brush asset',
    props: [
      { id: 'catalog_path', label: 'Catalog', type: 'string', default: '' },
      { id: 'author', label: 'Author', type: 'string', default: '' },
      { id: 'description', label: 'Description', type: 'string', default: '' },
    ],
    poll: () => {
      const b = current();
      return !!b && !!metadataTarget(b);
    },
    invoke: (_ctx, p) => {
      const t = metadataTarget(current()!)!;
      operatorDialog('brush.asset_edit_metadata', { ...p, catalog_path: catalogById(t.catalogs, t.meta.catalog_id)?.path ?? '', author: t.meta.author, description: t.meta.description });
      return 'CANCELLED';
    },
    exec: (_ctx, p) => {
      const t = metadataTarget(current()!);
      if (!t) return 'CANCELLED';
      const path = String(p.catalog_path ?? '').trim();
      t.meta.catalog_id = path ? ensureCatalogPath(t.catalogs, path) : '';
      t.meta.author = String(p.author ?? '');
      t.meta.description = String(p.description ?? '');
      if (t.library) void saveLibrary(t.library);
      touched(t.library);
    },
  },
  {
    idname: 'brush.asset_load_preview',
    label: 'Load Preview Image',
    description: 'Choose an image file as the preview of the active brush asset',
    props: [{ id: 'filepath', label: 'File Path', type: 'string', default: '', hidden: true }],
    poll: () => {
      const b = current();
      return !!b && !!metadataTarget(b);
    },
    invoke: () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = () => {
        const f = input.files?.[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => void previewFromDataURL(String(rd.result)).then((url) => url && app.run('brush.asset_load_preview', { filepath: url }, { invoke: false }));
        rd.readAsDataURL(f);
      };
      input.click();
      return 'CANCELLED';
    },
    exec: (_ctx, p) => {
      const url = String(p.filepath ?? '');
      if (!url.startsWith('data:image/')) {
        app.report('ERROR', 'Choose an image file for the preview');
        return 'CANCELLED';
      }
      const t = metadataTarget(current()!);
      if (!t) return 'CANCELLED';
      t.meta.preview = url;
      t.meta.preview_custom = true;
      if (t.library) void saveLibrary(t.library);
      touched(t.library);
    },
  },
]);

/** Scale an image (data URL) down to a 128 px square preview. */
function previewFromDataURL(url: string): Promise<string | null> {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const N = 128;
      const c = document.createElement('canvas');
      c.width = c.height = N;
      const g = c.getContext('2d');
      if (!g) return res(null);
      const k = Math.max(N / img.width, N / img.height);
      const w = img.width * k,
        h = img.height * k;
      g.drawImage(img, (N - w) / 2, (N - h) / 2, w, h);
      res(c.toDataURL('image/png'));
    };
    img.onerror = () => res(null);
    img.src = url;
  });
}

/** Brush Specials menu of the Brush panel. */
export function brushSpecialsMenu(): MenuItem[] {
  return [
    { label: 'Duplicate Asset…', icon: 'duplicate', op: 'brush.asset_save_as', props: { asset_library_reference: LOCAL } },
    { label: 'Delete Asset', op: 'brush.asset_delete' },
    { separator: true },
    { label: 'Edit Metadata…', op: 'brush.asset_edit_metadata' },
    { label: 'Edit Preview Image…', op: 'brush.asset_load_preview' },
    { label: 'Save Changes to Asset', op: 'brush.asset_save' },
    { label: 'Revert to Asset', op: 'brush.asset_revert' },
  ];
}

/** Short note on where the active brush comes from (shown under its name). */
export function brushOriginNote(b: PaintBrush): string | null {
  const o = brushOrigin(b as AssetBrush);
  if (o.kind === 'LIBRARY') return o.library === ESSENTIALS ? 'Essentials asset' : `Asset of "${libraryInfo(o.library)?.name ?? 'a library'}"`;
  if (o.kind === 'LOCAL_ASSET') return 'Asset of this file';
  return null;
}


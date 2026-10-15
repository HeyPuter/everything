// Asset marks of .blend files: data-blocks with asset metadata become assets of the imported
// document (description, author, license, copyright, tags, catalog and the stored preview image).
// Asset data-blocks that nothing in the scene uses (a material or node group kept only as an
// asset) are converted as well. Catalog paths come from a catalog definition file when one is
// given, otherwise from the catalog's one-line name.
import type { DocumentData, ID, NodeTreeData } from '../../data/types';
import type { BlendFile, BStruct } from './reader';
import type { Ctx } from './context';
import { convertGroup } from './nodes';
import { convertAction } from './anim';

interface Meta {
  description: string;
  author: string;
  license: string;
  copyright: string;
  tags: string[];
  catalog_id: string;
  preview?: string;
}

const CODES: [string, string][] = [
  ['OB', 'objects'],
  ['GR', 'collections'],
  ['MA', 'materials'],
  ['NT', 'node_groups'],
  ['WO', 'worlds'],
  ['AC', 'actions'],
];

const TREE_TYPES: Record<string, NodeTreeData['type']> = { GeometryNodeTree: 'GEOMETRY', ShaderNodeTree: 'SHADER', CompositorNodeTree: 'COMPOSITOR' };

const hex = (n: number, w: number) => (n >>> 0).toString(16).padStart(w, '0').slice(-w);

/** A bUUID struct as the usual 8-4-4-4-12 text form. */
export function uuidText(u: BStruct | null): string {
  if (!u) return '';
  const node = u.nums('node', 6);
  const s = `${hex(u.num('time_low'), 8)}-${hex(u.num('time_mid'), 4)}-${hex(u.num('time_hi_and_version'), 4)}-${hex(u.num('clock_seq_hi_and_reserved'), 2)}${hex(u.num('clock_seq_low'), 2)}-${node.map((b) => hex(b, 2)).join('')}`;
  return /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(s) ? '' : s;
}

/** Parse a catalog definition file ("UUID:path:simple name" lines). */
export function parseCatalogFile(text: string): { id: string; path: string }[] {
  const out: { id: string; path: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('VERSION')) continue;
    const m = /^([0-9a-fA-F-]{36}):([^:]*)(?::.*)?$/.exec(line);
    if (m && m[2]) out.push({ id: m[1].toLowerCase(), path: m[2].split('/').filter(Boolean).join('/') });
  }
  return out;
}

/** The large stored preview of an ID as an image URL (needs a canvas; undefined otherwise). */
function previewOf(f: BlendFile, id: BStruct): string | undefined {
  const pv = id.ref('preview');
  if (!pv) return undefined;
  const w = pv.num('w', 0, 1),
    h = pv.num('h', 0, 1);
  if (w < 1 || h < 1 || w > 1024 || h > 1024) return undefined;
  const px = f.bytesAt(pv.ptr('rect', 1), w * h * 4, pv.block);
  if (!px || typeof document === 'undefined') return undefined;
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (!g) return undefined;
    const img = g.createImageData(w, h);
    // rows are stored bottom-up
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    g.putImageData(img, 0, 0);
    const url = c.toDataURL('image/png');
    return url.startsWith('data:image/png') ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mark the converted data-blocks that are assets in the file; converts unused asset materials,
 * worlds, node groups and actions first. Returns the number of assets.
 */
export function readAssetMarks(f: BlendFile, ctx: Ctx, convertWorld: (s: BStruct) => ID | null): number {
  const doc = ctx.doc;
  const cats = new Map<string, string>();
  let n = 0;
  for (const [code, table] of CODES) {
    for (const s of f.ids(code)) {
      const idSub = s.sub('id');
      const ad = idSub?.ref('asset_data');
      if (!idSub || !ad) continue;
      let id: ID | null | undefined;
      try {
        if (code === 'OB') id = ctx.objectIds.get(s.offset);
        else if (code === 'GR') id = ctx.ids.get(s.offset);
        else if (code === 'MA') id = ctx.material(s);
        else if (code === 'WO') id = convertWorld(s);
        else if (code === 'NT') {
          const type = TREE_TYPES[s.str('idname')];
          id = type ? convertGroup(s, type, ctx, new Set()) : null;
        } else if (code === 'AC') id = ctx.ids.get(s.offset) ?? convertAction(s, 0, ctx);
      } catch (e) {
        ctx.warn.add('Asset could not be converted', `${s.idName}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      const block = id ? (doc as unknown as Record<string, Record<ID, { asset_data?: Meta; use_fake_user?: boolean }>>)[table]?.[id] : undefined;
      if (!block) continue;
      const catalog = uuidText(ad.sub('catalog_id'));
      const simple = ad.str('catalog_simple_name');
      // without a one-line name the catalog gets a placeholder name (a definition file can fix it)
      if (catalog && !cats.has(catalog)) cats.set(catalog, simple || `Catalog ${catalog.slice(0, 8)}`);
      block.asset_data = {
        description: ad.cstr('description'),
        author: ad.cstr('author'),
        license: ad.cstr('license'),
        copyright: ad.cstr('copyright'),
        tags: ad.list('tags', 1000).map((t) => t.str('name')).filter(Boolean),
        catalog_id: catalog,
      };
      const pv = previewOf(f, idSub);
      if (pv) block.asset_data.preview = pv;
      if (table !== 'objects' && table !== 'collections') block.use_fake_user = true;
      n++;
    }
  }
  // catalogs named by their one-line names until a definition file says otherwise
  const list = (doc.asset_catalogs ??= []);
  for (const [id, simple] of cats) if (!list.some((c) => c.id === id)) list.push({ id, path: simple.split('-').filter(Boolean).join('/') || simple });
  fillLevels(list);
  return n;
}

/** Give every level of every catalog path its own entry (stable ids derived from the child's). */
function fillLevels(list: { id: string; path: string }[]) {
  for (const c of [...list]) {
    const parts = c.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      if (!list.some((x) => x.path === p)) list.push({ id: `${c.id.slice(0, 24)}${hex(i, 12)}`, path: p });
    }
  }
}

/** Use the paths of a catalog definition file for the document's catalogs (adding missing levels). */
export function applyCatalogFile(doc: DocumentData, text: string) {
  const defs = parseCatalogFile(text);
  const list = (doc.asset_catalogs ??= []);
  for (const d of defs) {
    const cur = list.find((c) => c.id === d.id);
    if (cur) cur.path = d.path;
    else list.push(d);
  }
  fillLevels(list);
}

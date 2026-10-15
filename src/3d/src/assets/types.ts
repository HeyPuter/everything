// Asset data model: any data-block of an asset type can carry `asset_data` (its metadata and
// preview), and a document keeps its own catalog list. Both live in the document, so marking,
// tags, catalogs and previews are saved with the project and go through undo like other edits.
import type { DocumentData, ID } from '../data/types';

export interface AssetMetaData {
  description: string;
  author: string;
  license: string;
  copyright: string;
  tags: string[];
  /** catalog UUID ('' when the asset is not in a catalog) */
  catalog_id: string;
  /** preview image as a PNG data URL */
  preview?: string;
  /** the preview was picked by the user (automatic previews do not replace it) */
  preview_custom?: boolean;
}

export interface AssetCatalog {
  /** stable UUID; assets refer to catalogs by it */
  id: string;
  /** slash separated path, e.g. "Materials/Metal" */
  path: string;
}

declare module '../data/types' {
  interface DocumentData {
    /** asset catalogs defined in this file (the "Current File" library) */
    asset_catalogs?: AssetCatalog[];
  }
}

/** Data-block tables that can hold assets, in display order. */
export const ASSET_TABLES = ['objects', 'collections', 'materials', 'node_groups', 'worlds', 'actions', 'brushes'] as const;
export type AssetTable = (typeof ASSET_TABLES)[number];

export const ASSET_TYPE_INFO: Record<AssetTable, { label: string; plural: string; icon: string; filter: string }> = {
  objects: { label: 'Object', plural: 'Objects', icon: 'object', filter: 'filter_object' },
  collections: { label: 'Collection', plural: 'Collections', icon: 'collection', filter: 'filter_group' },
  materials: { label: 'Material', plural: 'Materials', icon: 'material', filter: 'filter_material' },
  node_groups: { label: 'Node Group', plural: 'Node Groups', icon: 'node_tree', filter: 'filter_node_tree' },
  worlds: { label: 'World', plural: 'Worlds', icon: 'world', filter: 'filter_world' },
  actions: { label: 'Action', plural: 'Poses & Actions', icon: 'action', filter: 'filter_action' },
  brushes: { label: 'Brush', plural: 'Brushes', icon: 'brush', filter: 'filter_brush' },
};

export const isAssetTable = (t: string): t is AssetTable => (ASSET_TABLES as readonly string[]).includes(t);

export interface AssetBlock {
  id: ID;
  name: string;
  asset_data?: AssetMetaData;
  use_fake_user?: boolean;
}

export function tableOf(doc: DocumentData, table: string): Record<ID, AssetBlock> | undefined {
  return (doc as unknown as Record<string, Record<ID, AssetBlock> | undefined>)[table];
}

export function blockOf(doc: DocumentData, table: string, id: ID): AssetBlock | undefined {
  return tableOf(doc, table)?.[id];
}

export function newMetaData(): AssetMetaData {
  return { description: '', author: '', license: '', copyright: '', tags: [], catalog_id: '' };
}

/** Every asset of a document, by table and in name order. */
export function assetsOf(doc: DocumentData): { table: AssetTable; block: AssetBlock }[] {
  const out: { table: AssetTable; block: AssetBlock }[] = [];
  for (const table of ASSET_TABLES) {
    const t = tableOf(doc, table);
    if (!t) continue;
    for (const b of Object.values(t)) if (b.asset_data) out.push({ table, block: b });
  }
  return out;
}

/** The table holding a data-block id (only asset tables). */
export function assetTableOfId(doc: DocumentData, id: ID): AssetTable | null {
  for (const t of ASSET_TABLES) if (tableOf(doc, t)?.[id]) return t;
  return null;
}

/** Encode / decode references to data-blocks of the current file ("table:id"). */
export const encodeTarget = (table: string, id: ID) => `${table}:${id}`;
export function decodeTargets(s: string): { table: AssetTable; id: ID }[] {
  return s
    .split('|')
    .map((x) => x.split(':'))
    .filter(([t, id]) => isAssetTable(t) && !!id)
    .map(([t, id]) => ({ table: t as AssetTable, id }));
}

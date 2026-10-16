// Outliner tree model: filter settings, the element tree for each display mode, flattening
// into rows (with search and expansion state) and data-block user counts. Pure functions of the
// document so they can be unit tested without the UI.
import { allScenes, childOfInactiveScene, linkedInInactiveScene, scenesByName } from '../../scenes/scenes';
import type { CollectionData, DocumentData, ObjectData } from '../../data/types';
import { modifierTypes } from '../../eval/modifiers';

export type DisplayMode = 'SCENES' | 'VIEW_LAYER' | 'SEQUENCE' | 'BLENDER_FILE' | 'DATA_API' | 'LIBRARY_OVERRIDES' | 'ORPHAN_DATA';
export type FilterState = 'ALL' | 'VISIBLE' | 'SELECTED' | 'ACTIVE' | 'SELECTABLE';

export interface OutlinerFilter {
  show_restrict_column_enable: boolean;
  show_restrict_column_select: boolean;
  show_restrict_column_hide: boolean;
  show_restrict_column_viewport: boolean;
  show_restrict_column_render: boolean;
  show_restrict_column_holdout: boolean;
  show_restrict_column_indirect_only: boolean;
  use_sort_alpha: boolean;
  use_sync_select: boolean;
  show_mode_column: boolean;
  use_filter_complete: boolean;
  use_filter_case_sensitive: boolean;
  use_filter_collection: boolean;
  use_filter_object: boolean;
  filter_state: FilterState;
  filter_invert: boolean;
  use_filter_object_content: boolean;
  use_filter_children: boolean;
  use_filter_object_mesh: boolean;
  use_filter_object_armature: boolean;
  use_filter_object_empty: boolean;
  use_filter_object_light: boolean;
  use_filter_object_camera: boolean;
  use_filter_object_grease_pencil: boolean;
  use_filter_object_others: boolean;
  /** Data Blocks / Unused Data: only list one data-block type */
  use_filter_id_type: boolean;
  filter_id_type: string;
  /** Library Overrides: overridden properties, or the override hierarchies */
  lib_override_view_mode: 'PROPERTIES' | 'HIERARCHIES';
  /** Library Overrides: also list overrides made as part of a hierarchy */
  use_filter_lib_override_system: boolean;
}

export function defaultFilter(): OutlinerFilter {
  return {
    show_restrict_column_enable: true,
    show_restrict_column_select: false,
    show_restrict_column_hide: true,
    show_restrict_column_viewport: false,
    show_restrict_column_render: true,
    show_restrict_column_holdout: false,
    show_restrict_column_indirect_only: false,
    use_sort_alpha: true,
    use_sync_select: true,
    show_mode_column: true,
    use_filter_complete: false,
    use_filter_case_sensitive: false,
    use_filter_collection: true,
    use_filter_object: true,
    filter_state: 'ALL',
    filter_invert: false,
    use_filter_object_content: true,
    use_filter_children: true,
    use_filter_object_mesh: true,
    use_filter_object_armature: true,
    use_filter_object_empty: true,
    use_filter_object_light: true,
    use_filter_object_camera: true,
    use_filter_object_grease_pencil: true,
    use_filter_object_others: true,
    use_filter_id_type: false,
    filter_id_type: 'objects',
    lib_override_view_mode: 'PROPERTIES',
    use_filter_lib_override_system: false,
  };
}

export type RowKind = 'scene' | 'file' | 'collection' | 'object' | 'data' | 'material' | 'modifiers' | 'modifier' | 'constraints' | 'constraint' | 'vgroups' | 'vgroup' | 'action' | 'group' | 'id' | 'library' | 'strip' | 'rna' | 'override';

export interface Row {
  /** unique per position in the tree (an object linked to two collections has two rows) */
  key: string;
  /** element identity used for selection and expansion */
  ekey: string;
  depth: number;
  kind: RowKind;
  label: string;
  icon: string;
  /** collection / object / data-block id */
  id?: string;
  /** data-block table for 'id' and 'data' rows */
  table?: string;
  collection?: CollectionData;
  ob?: ObjectData;
  /** collection that holds this object row (view layer / scenes modes) */
  parentCollection?: string;
  /** row key of the parent row */
  parentKey?: string;
  expandable: boolean;
  expanded: boolean;
  /** summary icons (with counts) of the children of a collapsed row */
  chips?: { icon: string; count: number }[];
  /** child object shown under its parent although it lives in another collection */
  indirect?: boolean;
  /** row matches the search string */
  match?: boolean;
  /** data-block user count (file / orphan modes) */
  users?: number;
  fakeUser?: boolean;
  /** number of items in a data-block type group */
  count?: number;
  /** Data API: the value shown (and edited) in the value column */
  value?: RowValue;
  /** Data API property path / Library Overrides property name / strip name */
  path?: string;
}

/** A property value shown in the Data API display mode. */
export interface RowValue {
  get(): unknown;
  set?(v: unknown): void;
  kind: 'number' | 'int' | 'bool' | 'string' | 'enum' | 'vector' | 'color' | 'readonly';
  items?: string[];
}

export interface TreeState {
  mode: DisplayMode;
  filter: OutlinerFilter;
  search: string;
  /** explicit expansion state; elements without an entry use their default */
  open: Map<string, boolean>;
}

export interface TreeNode {
  ekey: string;
  kind: RowKind;
  label: string;
  icon: string;
  id?: string;
  table?: string;
  collection?: CollectionData;
  ob?: ObjectData;
  parentCollection?: string;
  indirect?: boolean;
  defaultOpen: boolean;
  users?: number;
  fakeUser?: boolean;
  /** number of items in a data-block type group */
  count?: number;
  /** search ignores structural rows that only group other elements */
  searchable?: boolean;
  value?: RowValue;
  path?: string;
  /** whether there are children, when known without building them */
  hasKids?: boolean;
  children: () => TreeNode[];
}

/** Builders of display modes defined in their own files (Data API, Video Sequencer, …). */
export const modeBuilders: Partial<Record<DisplayMode, (doc: DocumentData, st: TreeState, tc: TreeContext) => TreeNode[]>> = {};

/** Extra root elements of the Data Blocks mode after "Current File" (linked libraries). */
export const fileModeRoots: ((doc: DocumentData, st: TreeState, idNode: (table: string, it: { id: string; name: string; use_fake_user?: boolean }, users: Map<string, number>) => TreeNode) => TreeNode[])[] = [];

/** Is a data-block local (not linked from a library)? */
const isLocal = (x: unknown) => !(x as { library?: string | null }).library;

export const OB_ICON: Record<string, string> = {
  MESH: 'outliner_ob_mesh',
  CURVE: 'outliner_ob_curve',
  FONT: 'outliner_ob_font',
  EMPTY: 'outliner_ob_empty',
  LIGHT: 'outliner_ob_light',
  CAMERA: 'outliner_ob_camera',
  ARMATURE: 'outliner_ob_armature',
  LATTICE: 'outliner_ob_lattice',
  POINTCLOUD: 'outliner_ob_pointcloud',
  GREASEPENCIL: 'outliner_ob_greasepencil',
  SPEAKER: 'outliner_ob_speaker',
  LIGHT_PROBE: 'outliner_ob_lightprobe',
  META: 'outliner_ob_meta',
};
export const DATA_ICON: Record<string, string> = {
  MESH: 'mesh_data',
  CURVE: 'curve_data',
  FONT: 'curve_data',
  LIGHT: 'light_data',
  CAMERA: 'camera_data',
  ARMATURE: 'armature_data',
  LATTICE: 'outliner_ob_lattice',
  GREASEPENCIL: 'outliner_data_greasepencil',
  META: 'outliner_ob_meta',
};
export const DATA_TABLE: Record<string, keyof DocumentData> = {
  MESH: 'meshes',
  CURVE: 'curves',
  FONT: 'curves',
  LIGHT: 'lights',
  CAMERA: 'cameras',
  ARMATURE: 'armatures',
  LATTICE: 'lattices',
  GREASEPENCIL: 'grease_pencils',
  META: 'metaballs',
};

/** Data-block types listed in the Data Blocks / Unused Data display modes. */
export const ID_GROUPS: [label: string, table: keyof DocumentData, icon: string][] = [
  ['Actions', 'actions', 'action'],
  ['Armatures', 'armatures', 'armature_data'],
  ['Brushes', 'brushes', 'brush'],
  ['Cameras', 'cameras', 'camera_data'],
  ['Collections', 'collections', 'collection'],
  ['Curves', 'curves', 'curve_data'],
  ['Grease Pencil', 'grease_pencils', 'outliner_data_greasepencil'],
  ['Images', 'images', 'image'],
  ['Lattices', 'lattices', 'outliner_ob_lattice'],
  ['Lights', 'lights', 'light_data'],
  ['Materials', 'materials', 'material'],
  ['Meshes', 'meshes', 'mesh_data'],
  ['Metaballs', 'metaballs', 'outliner_ob_meta'],
  ['Node Groups', 'node_groups', 'node_tree'],
  ['Objects', 'objects', 'object'],
  ['Particle Settings', 'particles', 'particles'],
  ['Texts', 'texts', 'text'],
  ['Worlds', 'worlds', 'world'],
];

const natural = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});
export const byName = (a: { name: string }, b: { name: string }) => natural.compare(a.name, b.name);

export function objectData(
  doc: DocumentData,
  ob: ObjectData,
):
  | {
      id: string;
      name: string;
      materials?: (string | null)[];
      vertex_groups?: { name: string }[];
    }
  | undefined {
  if (!ob.data) return undefined;
  const t = DATA_TABLE[ob.type];
  return t ? ((doc[t] as Record<string, never> | undefined)?.[ob.data] as never) : undefined;
}

/** Materials shown under an object: data-linked slots, then object-linked overrides. */
export function objectMaterials(doc: DocumentData, ob: ObjectData): string[] {
  const d = objectData(doc, ob);
  const out: string[] = [];
  d?.materials?.forEach((m, i) => {
    const link = ob.material_slots_link?.[i];
    const mid = link === 'OBJECT' ? ob.object_materials?.[i] : m;
    if (mid && doc.materials[mid] && !out.includes(mid)) out.push(mid);
  });
  return out;
}

export function childrenMap(doc: DocumentData): Map<string, ObjectData[]> {
  const map = new Map<string, ObjectData[]>();
  for (const ob of Object.values(doc.objects)) {
    if (!ob.parent || !doc.objects[ob.parent]) continue;
    let l = map.get(ob.parent);
    if (!l) map.set(ob.parent, (l = []));
    l.push(ob);
  }
  return map;
}

/** The collection that directly contains `id` as a child (undefined for the scene collection). */
export function parentCollection(doc: DocumentData, id: string): CollectionData | undefined {
  for (const c of Object.values(doc.collections)) if (c.children.includes(id)) return c;
  return undefined;
}

/** Collections in depth-first view-layer order (scene collection excluded). */
export function collectionsInOrder(doc: DocumentData): CollectionData[] {
  const out: CollectionData[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const c = doc.collections[id];
    if (!c) return;
    if (id !== doc.scene.collection) out.push(c);
    for (const ch of c.children) walk(ch);
  };
  walk(doc.scene.collection);
  return out;
}

/** Every collection below `id` (not including it). */
export function descendantCollections(doc: DocumentData, id: string): string[] {
  const out: string[] = [];
  const walk = (cid: string, depth: number) => {
    if (depth > 64) return;
    for (const ch of doc.collections[cid]?.children ?? []) {
      if (out.includes(ch)) continue;
      out.push(ch);
      walk(ch, depth + 1);
    }
  };
  walk(id, 0);
  return out;
}

/** Collections from the scene collection down to (not including) `id`. */
export function ancestorCollections(doc: DocumentData, id: string): string[] {
  const out: string[] = [];
  let cur = parentCollection(doc, id);
  while (cur && !out.includes(cur.id)) {
    out.unshift(cur.id);
    cur = parentCollection(doc, cur.id);
  }
  return out;
}

/** Objects in a collection and all collections below it. */
export function objectsInside(doc: DocumentData, id: string): string[] {
  const ids = new Set<string>(doc.collections[id]?.objects ?? []);
  for (const c of descendantCollections(doc, id)) for (const o of doc.collections[c]?.objects ?? []) ids.add(o);
  return [...ids].filter((o) => doc.objects[o]);
}

/** An object and all of its descendants. */
export function objectHierarchy(doc: DocumentData, id: string): string[] {
  const kids = childrenMap(doc);
  const out: string[] = [];
  const walk = (oid: string) => {
    if (out.includes(oid)) return;
    out.push(oid);
    for (const c of kids.get(oid) ?? []) walk(c.id);
  };
  walk(id);
  return out;
}

// ---------------------------------------------------------------------------
// data-block users

/**
 * Count references to every data-block id across the document (an id string stored anywhere
 * in another data-block, the scene or a collection counts as one user). Fake users are not counted.
 */
export function userCounts(doc: DocumentData): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (v: unknown, self: string | null, depth: number) => {
    if (depth > 14 || v === null || v === undefined) return;
    if (typeof v === 'string') {
      if (v !== self) counts.set(v, (counts.get(v) ?? 0) + 1);
      return;
    }
    if (typeof v !== 'object' || ArrayBuffer.isView(v)) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, self, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k !== 'id' && k !== 'name') visit(x, self, depth + 1);
  };
  for (const [k, t] of Object.entries(doc as unknown as Record<string, unknown>)) {
    if (k === 'object_order' || k === 'mode' || k === 'version') continue;
    if (k === 'scene') visit(t, null, 0);
    else if (t && typeof t === 'object' && !Array.isArray(t)) for (const [id, rec] of Object.entries(t as Record<string, unknown>)) visit(rec, id, 0);
  }
  return counts;
}

/** Data-blocks without real users; collections and objects count as used when linked to the scene. */
export function isOrphan(doc: DocumentData, table: string, id: string, users: Map<string, number>): boolean {
  if (table === 'brushes') return false;
  if (table === 'collections') return id !== doc.scene.collection && !Object.values(doc.collections).some((c) => c.children.includes(id)) && !childOfInactiveScene(doc, id) && !(users.get(id) ?? 0);
  if (table === 'objects') return !Object.values(doc.collections).some((c) => c.objects.includes(id)) && !linkedInInactiveScene(doc, id);
  if (table === 'worlds' && doc.scene.world === id) return false;
  return !(users.get(id) ?? 0);
}

// ---------------------------------------------------------------------------
// tree construction

function objectPasses(ob: ObjectData, f: OutlinerFilter, doc: DocumentData, visible: (id: string) => boolean, selectable: (id: string) => boolean): boolean {
  const typeOk =
    ob.type === 'MESH'
      ? f.use_filter_object_mesh
      : ob.type === 'ARMATURE'
        ? f.use_filter_object_armature
        : ob.type === 'EMPTY'
          ? f.use_filter_object_empty
          : ob.type === 'LIGHT'
            ? f.use_filter_object_light
            : ob.type === 'CAMERA'
              ? f.use_filter_object_camera
              : ob.type === 'GREASEPENCIL'
                ? f.use_filter_object_grease_pencil
                : f.use_filter_object_others;
  if (!typeOk) return false;
  let st = true;
  switch (f.filter_state) {
    case 'VISIBLE':
      st = visible(ob.id);
      break;
    case 'SELECTED':
      st = ob.select && visible(ob.id);
      break;
    case 'ACTIVE':
      st = doc.scene.active_object === ob.id;
      break;
    case 'SELECTABLE':
      st = selectable(ob.id);
      break;
  }
  if (f.filter_state !== 'ALL' && f.filter_invert) st = !st;
  return st;
}

export interface TreeContext {
  visible: (id: string) => boolean;
  selectable: (id: string) => boolean;
}

function buildViewLayer(doc: DocumentData, st: TreeState, tc: TreeContext): TreeNode[] {
  const f = st.filter;
  const kids = childrenMap(doc);
  const master = doc.collections[doc.scene.collection];
  const sortObs = (l: ObjectData[]) => (f.use_sort_alpha ? [...l].sort(byName) : l);
  const passes = (ob: ObjectData) => objectPasses(ob, f, doc, tc.visible, tc.selectable);

  const objectNode = (ob: ObjectData, colId: string | undefined, inCol: Set<string> | null, depth: number): TreeNode => ({
    ekey: `o:${ob.id}`,
    kind: 'object',
    label: ob.name,
    icon: OB_ICON[ob.type] ?? 'object',
    id: ob.id,
    ob,
    parentCollection: colId,
    indirect: inCol ? !inCol.has(ob.id) : false,
    defaultOpen: false,
    searchable: true,
    children: () => {
      const out: TreeNode[] = [];
      if (f.use_filter_object_content) out.push(...objectContent(doc, ob));
      if (f.use_filter_children && depth < 64) for (const c of liftFiltered(sortObs(kids.get(ob.id) ?? []))) out.push(objectNode(c, colId, inCol, depth + 1));
      return out;
    },
  });
  // objects hidden by the filter pass their (filtered) children up to the parent level
  const liftFiltered = (obs: ObjectData[], depth = 0): ObjectData[] => {
    const out: ObjectData[] = [];
    for (const o of obs) {
      if (passes(o)) out.push(o);
      else if (f.use_filter_children && depth < 64) out.push(...liftFiltered(sortObs(kids.get(o.id) ?? []), depth + 1));
    }
    return out;
  };
  const objectsOf = (c: CollectionData): TreeNode[] => {
    if (!f.use_filter_object) return [];
    const inCol = new Set(c.objects);
    const obs = c.objects.map((id) => doc.objects[id]).filter(Boolean);
    const roots = f.use_filter_children ? obs.filter((o) => !o.parent || !inCol.has(o.parent) || !doc.objects[o.parent]) : obs;
    const list = f.use_filter_children ? liftFiltered(sortObs(roots)) : sortObs(roots).filter(passes);
    return list.map((o) => objectNode(o, c.id, inCol, 0));
  };
  const collectionNode = (c: CollectionData, depth: number): TreeNode => {
    const isMaster = c.id === master.id;
    return {
      ekey: `c:${c.id}`,
      kind: 'collection',
      label: isMaster ? 'Scene Collection' : c.name,
      icon: isMaster ? 'scene' : 'collection',
      id: c.id,
      collection: c,
      defaultOpen: true,
      searchable: !isMaster,
      children: () => [
        ...(depth < 64
          ? c.children
              .map((id) => doc.collections[id])
              .filter(Boolean)
              .map((cc) => collectionNode(cc, depth + 1))
          : []),
        ...objectsOf(c),
      ],
    };
  };
  if (!f.use_filter_collection) {
    // flat list of every object in the view layer
    if (!f.use_filter_object) return [];
    const all = new Set<string>();
    for (const c of collectionsInOrder(doc)) if (!c.exclude) c.objects.forEach((o) => all.add(o));
    master.objects.forEach((o) => all.add(o));
    const obs = [...all].map((id) => doc.objects[id]).filter(Boolean);
    const roots = f.use_filter_children ? obs.filter((o) => !o.parent || !all.has(o.parent)) : obs;
    const list = f.use_filter_children ? liftFiltered(sortObs(roots)) : sortObs(roots).filter(passes);
    return list.map((o) => objectNode(o, undefined, null, 0));
  }
  return [collectionNode(master, 0)];
}

function objectContent(doc: DocumentData, ob: ObjectData): TreeNode[] {
  const out: TreeNode[] = [];
  const leaf = (n: Omit<TreeNode, 'children' | 'defaultOpen'>): TreeNode => ({
    ...n,
    defaultOpen: false,
    children: () => [],
  });
  const act = ob.animation_data?.action ? doc.actions[ob.animation_data.action] : undefined;
  if (act)
    out.push(
      leaf({
        ekey: `ac:${ob.id}`,
        kind: 'action',
        label: act.name,
        icon: 'action',
        id: act.id,
        table: 'actions',
        ob,
        searchable: true,
      }),
    );
  const data = objectData(doc, ob);
  if (data) {
    const t = DATA_TABLE[ob.type];
    const mats = objectMaterials(doc, ob);
    out.push({
      ekey: `d:${ob.id}`,
      kind: 'data',
      label: data.name,
      icon: DATA_ICON[ob.type] ?? 'mesh_data',
      id: data.id,
      table: t,
      ob,
      defaultOpen: false,
      searchable: true,
      children: () => {
        const l: TreeNode[] = mats.map((m) =>
          leaf({
            ekey: `m:${ob.id}:${m}`,
            kind: 'material',
            label: doc.materials[m].name,
            icon: 'material',
            id: m,
            table: 'materials',
            ob,
            searchable: true,
          }),
        );
        const vgs = data.vertex_groups ?? [];
        if (vgs.length)
          l.push({
            ekey: `vgs:${ob.id}`,
            kind: 'vgroups',
            label: 'Vertex Groups',
            icon: 'group_vertex',
            ob,
            defaultOpen: false,
            children: () =>
              vgs.map((g) =>
                leaf({
                  ekey: `vg:${ob.id}:${g.name}`,
                  kind: 'vgroup',
                  label: g.name,
                  icon: 'group_vertex',
                  ob,
                  searchable: true,
                }),
              ),
          });
        return l;
      },
    });
  }
  if (ob.modifiers.length)
    out.push({
      ekey: `ms:${ob.id}`,
      kind: 'modifiers',
      label: 'Modifiers',
      icon: 'modifier',
      ob,
      defaultOpen: false,
      children: () =>
        ob.modifiers.map((m) =>
          leaf({
            ekey: `md:${ob.id}:${m.id}`,
            kind: 'modifier',
            label: m.name,
            icon: modifierTypes[m.type]?.icon ?? 'modifier',
            id: m.id,
            ob,
            searchable: true,
          }),
        ),
    });
  if (ob.constraints.length)
    out.push({
      ekey: `cs:${ob.id}`,
      kind: 'constraints',
      label: 'Constraints',
      icon: 'constraint',
      ob,
      defaultOpen: false,
      children: () =>
        ob.constraints.map((c) =>
          leaf({
            ekey: `cn:${ob.id}:${c.id}`,
            kind: 'constraint',
            label: c.name,
            icon: 'constraint',
            id: c.id,
            ob,
            searchable: true,
          }),
        ),
    });
  return out;
}

/** Element of one data-block in the Data Blocks / Unused Data modes. */
export function idNode(table: string, it: { id: string; name: string; use_fake_user?: boolean }, users: Map<string, number>, ekeyPrefix = 'id'): TreeNode {
  const base = { label: it.name, id: it.id, table, defaultOpen: false, searchable: true, users: users.get(it.id) ?? 0, fakeUser: !!it.use_fake_user, children: () => [] };
  if (table === 'objects') return { ...base, ekey: `${ekeyPrefix}:objects:${it.id}`, kind: 'object', icon: OB_ICON[(it as unknown as ObjectData).type] ?? 'object', ob: it as unknown as ObjectData };
  if (table === 'collections') return { ...base, ekey: `${ekeyPrefix}:collections:${it.id}`, kind: 'id', icon: 'collection', collection: it as unknown as CollectionData };
  return { ...base, ekey: `${ekeyPrefix}:${table}:${it.id}`, kind: 'id', icon: ID_GROUPS.find((g) => g[1] === table)?.[2] ?? 'file' };
}

/** Type groups of data-blocks (those passing `keep`), as in the Data Blocks display mode. */
export function idGroups(doc: DocumentData, st: TreeState, keep: (table: string, x: { id: string; name: string; use_fake_user?: boolean }) => boolean, users: Map<string, number>, ekeyPrefix = 'g', defaultOpen = false): TreeNode[] {
  const groups: TreeNode[] = [];
  for (const [label, table, ic] of ID_GROUPS) {
    if (st.filter.use_filter_id_type && st.filter.filter_id_type !== table) continue;
    const rec = doc[table] as Record<string, { id: string; name: string; use_fake_user?: boolean }> | undefined;
    if (!rec) continue;
    // the scene collection belongs to the scene and is not listed as a data-block
    const items = Object.values(rec).filter((x) => (table !== 'collections' || x.id !== doc.scene.collection) && keep(table, x));
    if (!items.length) continue;
    items.sort(byName);
    groups.push({
      ekey: `${ekeyPrefix}:${table}`,
      kind: 'group',
      label,
      icon: ic,
      table,
      count: items.length,
      defaultOpen,
      children: () => items.map((it) => idNode(table, it, users, ekeyPrefix === 'g' ? 'id' : `${ekeyPrefix}id`)),
    });
  }
  return groups;
}

function buildIdModes(doc: DocumentData, st: TreeState): TreeNode[] {
  const orphans = st.mode === 'ORPHAN_DATA';
  const users = userCounts(doc);
  if (orphans) return idGroups(doc, st, (table, x) => isOrphan(doc, table, x.id, users) || (!!x.use_fake_user && !(users.get(x.id) ?? 0)), users, 'g', true);
  const groups = idGroups(doc, st, (_t, x) => isLocal(x), users);
  if (!st.filter.use_filter_id_type || st.filter.filter_id_type === 'scenes') {
    // the scene is listed with the data-blocks (it is not stored in a table)
    const scenes: TreeNode = {
      ekey: 'g:scenes',
      kind: 'group',
      label: 'Scenes',
      icon: 'scene_data',
      table: 'scenes',
      defaultOpen: false,
      count: allScenes(doc).length,
      children: () => scenesByName(doc).map((sc) => ({ ekey: `id:scenes:${sc.id}`, kind: 'scene' as const, label: sc.name, icon: 'scene_data', id: sc.id, table: 'scenes', defaultOpen: false, searchable: true, children: () => [] })),
    };
    const at = groups.findIndex((g) => g.label.localeCompare('Scenes') > 0);
    groups.splice(at < 0 ? groups.length : at, 0, scenes);
  }
  return [
    {
      ekey: 'file',
      kind: 'file',
      label: 'Current File',
      icon: 'file_3d',
      defaultOpen: true,
      children: () => groups,
    },
    ...fileModeRoots.flatMap((f) => f(doc, st, (table, it, u) => idNode(table, it, u))),
  ];
}

function rootNodes(doc: DocumentData, st: TreeState, tc: TreeContext): TreeNode[] {
  const extra = modeBuilders[st.mode];
  if (extra) return extra(doc, st, tc);
  if (st.mode === 'BLENDER_FILE' || st.mode === 'ORPHAN_DATA') return buildIdModes(doc, st);
  const vl = buildViewLayer(doc, st, tc);
  if (st.mode === 'SCENES') return sceneRoots(doc, vl);
  return vl;
}

/** Scenes display mode: one element per scene with its view layer tree (replaceable). */
export const scenesMode = {
  roots: (doc: DocumentData, viewLayer: TreeNode[]): TreeNode[] => [
    {
      ekey: 'scene',
      kind: 'scene',
      label: doc.scene.name,
      icon: 'scene_data',
      id: doc.scene.id,
      defaultOpen: true,
      children: () => viewLayer,
    },
    // the other scenes (click to make one active)
    ...scenesByName(doc)
      .filter((sc) => sc !== doc.scene)
      .map((sc): TreeNode => ({ ekey: `scene:${sc.id}`, kind: 'scene', label: sc.name, icon: 'scene_data', id: sc.id, defaultOpen: false, searchable: true, children: () => [] })),
  ],
};
const sceneRoots = (doc: DocumentData, vl: TreeNode[]) => scenesMode.roots(doc, vl);

/** Does `label` match the search string under the current filter settings? */
export function nameMatches(label: string, search: string, f: Pick<OutlinerFilter, 'use_filter_complete' | 'use_filter_case_sensitive'>): boolean {
  if (!search) return true;
  const a = f.use_filter_case_sensitive ? label : label.toLowerCase();
  const b = f.use_filter_case_sensitive ? search : search.toLowerCase();
  if (f.use_filter_complete) return a === b;
  if (b.includes('*') || b.includes('?')) {
    const re = new RegExp(
      `^${b
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`,
      f.use_filter_case_sensitive ? '' : 'i',
    );
    return re.test(a);
  }
  return a.includes(b);
}

export function isOpen(st: TreeState, ekey: string, def: boolean) {
  return st.open.get(ekey) ?? def;
}

const ZERO_TC: TreeContext = { visible: () => true, selectable: () => true };

/** Flatten the element tree into visible rows. */
export function buildRows(doc: DocumentData, st: TreeState, tc: TreeContext = ZERO_TC): Row[] {
  const rows: Row[] = [];
  const search = st.search.trim();
  const memoKids = new Map<TreeNode, TreeNode[]>();
  const kidsOf = (n: TreeNode) => {
    let k = memoKids.get(n);
    if (!k) memoKids.set(n, (k = n.children()));
    return k;
  };
  const selfMatch = (n: TreeNode) => !!n.searchable && nameMatches(n.label, search, st.filter);
  const memoMatch = new Map<TreeNode, boolean>();
  const subtreeMatch = (n: TreeNode, depth = 0): boolean => {
    let m = memoMatch.get(n);
    if (m === undefined) {
      m = selfMatch(n) || (depth < 128 && kidsOf(n).some((c) => subtreeMatch(c, depth + 1)));
      memoMatch.set(n, m);
    }
    return m;
  };
  const chipsOf = (n: TreeNode) => {
    const counts = new Map<string, number>();
    for (const c of kidsOf(n)) {
      // group rows summarise as their own icon
      counts.set(c.icon, (counts.get(c.icon) ?? 0) + 1);
    }
    return [...counts].slice(0, 10).map(([icon, count]) => ({ icon, count }));
  };
  const emit = (n: TreeNode, depth: number, parentKey: string) => {
    if (search && !subtreeMatch(n)) return;
    const key = parentKey ? `${parentKey}/${n.ekey}` : n.ekey;
    // nodes that know whether they have children skip building them while collapsed
    const hasKids = n.hasKids !== undefined && !search && !isOpen(st, n.ekey, n.defaultOpen) ? n.hasKids : kidsOf(n).length > 0;
    const expanded = hasKids && (search ? kidsOf(n).some((c) => subtreeMatch(c)) || isOpen(st, n.ekey, n.defaultOpen) : isOpen(st, n.ekey, n.defaultOpen));
    rows.push({
      key,
      ekey: n.ekey,
      depth,
      kind: n.kind,
      label: n.label,
      icon: n.icon,
      id: n.id,
      table: n.table,
      collection: n.collection,
      ob: n.ob,
      parentCollection: n.parentCollection,
      parentKey: parentKey || undefined,
      expandable: hasKids,
      expanded,
      chips: hasKids && !expanded && n.hasKids === undefined ? chipsOf(n) : undefined,
      indirect: n.indirect,
      match: !!search && selfMatch(n),
      users: n.users,
      fakeUser: n.fakeUser,
      count: n.count,
      value: n.value,
      path: n.path,
    });
    if (expanded && depth < 256) for (const c of kidsOf(n)) emit(c, depth + 1, key);
  };
  for (const n of rootNodes(doc, st, tc)) emit(n, 0, '');
  return rows;
}

/**
 * Every element key of the tree with its depth and whether it has children, ignoring expansion
 * (used by Show One Level, Show Hierarchy and Expand/Collapse All).
 */
export function allElements(
  doc: DocumentData,
  st: TreeState,
  tc: TreeContext = ZERO_TC,
  maxDepth = 32,
): {
  ekey: string;
  kind: RowKind;
  depth: number;
  parentOpen: boolean;
  open: boolean;
  hasKids: boolean;
}[] {
  const out: {
    ekey: string;
    kind: RowKind;
    depth: number;
    parentOpen: boolean;
    open: boolean;
    hasKids: boolean;
  }[] = [];
  const seen = new Set<string>();
  const walk = (n: TreeNode, depth: number, parentOpen: boolean) => {
    if (depth > maxDepth) return;
    const kids = n.children();
    const open = isOpen(st, n.ekey, n.defaultOpen);
    if (!seen.has(n.ekey)) {
      seen.add(n.ekey);
      out.push({
        ekey: n.ekey,
        kind: n.kind,
        depth,
        parentOpen,
        open,
        hasKids: kids.length > 0,
      });
    }
    for (const c of kids) walk(c, depth + 1, parentOpen && open);
  };
  for (const n of rootNodes(doc, st, tc)) walk(n, 0, true);
  return out;
}

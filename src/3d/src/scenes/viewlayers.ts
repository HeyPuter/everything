// View layers: each scene has one or more layers with their own passes, collection flags and
// light groups. The active layer of the active scene is "live" (its passes in scene.render, its
// collection flags on the collections) so the renderers and the outliner read it directly; the
// other layers keep a stored copy that is swapped in when they become active. Pure functions.
import type { DocumentData, ID, RenderSettings, SceneData } from '../data/types';
import { defaultRender } from '../data/defaults';
import { cloneShared } from '../data/cow';
import type { LayerCollectionFlags, ViewLayerData } from './types';

/** Render settings that belong to a view layer (passes, filter, use for rendering). */
export const LAYER_RENDER_KEYS = [
  'use_view_layer',
  'use_sky',
  'use_solid',
  'use_pass_combined',
  'use_pass_z',
  'use_pass_mist',
  'use_pass_normal',
  'use_pass_position',
  'use_pass_uv',
  'use_pass_vector',
  'use_pass_object_index',
  'use_pass_material_index',
  'use_pass_diffuse_color',
  'use_pass_emit',
  'use_pass_ambient_occlusion',
  'ambient_occlusion_distance',
  'use_pass_cryptomatte_object',
  'use_pass_cryptomatte_material',
  'use_pass_cryptomatte_asset',
  'pass_cryptomatte_depth',
  'aovs',
  'use_pass_bloom',
] as const satisfies readonly (keyof RenderSettings | 'use_pass_bloom' | 'ambient_occlusion_distance')[];

/** Collection flags that belong to a view layer. */
export const LAYER_FLAGS = ['exclude', 'hide', 'holdout', 'indirect_only'] as const;

type AnyRecord = Record<string, unknown>;

/** The scene's view layers (a scene without any gets the default "ViewLayer"). */
export function ensureViewLayers(scene: SceneData): ViewLayerData[] {
  if (!scene.view_layers?.length) scene.view_layers = [{ name: 'ViewLayer' }];
  const n = scene.view_layers.length;
  if (!(Number.isInteger(scene.active_view_layer) && scene.active_view_layer! >= 0 && scene.active_view_layer! < n)) scene.active_view_layer = 0;
  return scene.view_layers;
}

export function activeLayerIndex(scene: SceneData): number {
  ensureViewLayers(scene);
  return scene.active_view_layer!;
}

export function activeViewLayer(scene: SceneData): ViewLayerData {
  return ensureViewLayers(scene)[activeLayerIndex(scene)];
}

/** Ids of the collections in a collection tree (the master collection included). */
export function collectionTree(doc: DocumentData, master: ID, masterData?: { children: ID[] }): Set<ID> {
  const out = new Set<ID>([master]);
  const walk = (ids: ID[]) => {
    for (const id of ids) {
      const c = doc.collections[id];
      if (!c || out.has(id)) continue;
      out.add(id);
      walk(c.children);
    }
  };
  walk((masterData ?? doc.collections[master])?.children ?? []);
  return out;
}

/** Non-default flags of the collections in the active scene (the live state of the active layer). */
export function captureLiveFlags(doc: DocumentData): Record<ID, LayerCollectionFlags> {
  const out: Record<ID, LayerCollectionFlags> = {};
  for (const id of collectionTree(doc, doc.scene.collection)) {
    if (id === doc.scene.collection) continue;
    const c = doc.collections[id];
    if (!c) continue;
    const f: LayerCollectionFlags = {};
    for (const k of LAYER_FLAGS) if (c[k]) f[k] = true;
    if (Object.keys(f).length) out[id] = f;
  }
  return out;
}

/** Make `flags` the live collection flags of the active scene (missing entries are cleared). */
export function applyLiveFlags(doc: DocumentData, flags: Record<ID, LayerCollectionFlags>) {
  for (const id of collectionTree(doc, doc.scene.collection)) {
    if (id === doc.scene.collection) continue;
    const c = doc.collections[id];
    if (!c) continue;
    const f = flags[id] ?? {};
    for (const k of LAYER_FLAGS) {
      if (k === 'exclude' || k === 'hide') c[k] = !!f[k];
      else if (f[k]) c[k] = true;
      else delete c[k];
    }
  }
}

/** Copy of the view layer render settings in `r`. */
export function captureRender(r: RenderSettings): Partial<RenderSettings> {
  const out: AnyRecord = {};
  const src = r as unknown as AnyRecord;
  for (const k of LAYER_RENDER_KEYS) if (src[k] !== undefined) out[k] = cloneShared(src[k]);
  return out as Partial<RenderSettings>;
}

/** Default view layer render settings (a new layer). */
export function defaultLayerRender(): Partial<RenderSettings> {
  return captureRender(defaultRender());
}

/** Write stored layer settings into `r` (keys the layer does not have get their defaults). */
export function applyRender(r: RenderSettings, stored: Partial<RenderSettings>) {
  const dst = r as unknown as AnyRecord;
  const src = stored as unknown as AnyRecord;
  const defs = defaultRender() as unknown as AnyRecord;
  for (const k of LAYER_RENDER_KEYS) {
    if (src[k] !== undefined) dst[k] = cloneShared(src[k]);
    else if (defs[k] !== undefined) dst[k] = defs[k];
    else delete dst[k];
  }
}

/** Render settings of layer `i` of a scene (live for the active layer). */
export function layerRender(scene: SceneData, i: number): Partial<RenderSettings> {
  const layers = ensureViewLayers(scene);
  if (i === scene.active_view_layer) return scene.render;
  return layers[i]?.stored?.render ?? defaultLayerRender();
}

/** Flags of a collection in layer `i` of a scene. */
export function layerFlags(doc: DocumentData, scene: SceneData, i: number, cid: ID): LayerCollectionFlags {
  const layers = ensureViewLayers(scene);
  if (i === scene.active_view_layer) {
    if (scene === doc.scene) {
      const c = doc.collections[cid];
      return c ? { exclude: c.exclude, hide: c.hide, holdout: c.holdout, indirect_only: c.indirect_only } : {};
    }
    return scene.stashed_flags?.[cid] ?? {};
  }
  return layers[i]?.stored?.collections[cid] ?? {};
}

/** Unique layer name in a scene. */
export function uniqueLayerName(scene: SceneData, base: string, except?: ViewLayerData): string {
  const names = new Set(ensureViewLayers(scene).filter((l) => l !== except).map((l) => l.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

/** Make layer `i` the active layer of the active scene. Returns false when nothing changed. */
export function setActiveViewLayer(doc: DocumentData, i: number): boolean {
  const scene = doc.scene;
  const layers = ensureViewLayers(scene);
  const cur = scene.active_view_layer!;
  if (i === cur || i < 0 || i >= layers.length) return false;
  const old = layers[cur];
  old.stored = { render: captureRender(scene.render), collections: captureLiveFlags(doc) };
  const next = layers[i];
  applyRender(scene.render, next.stored?.render ?? defaultLayerRender());
  applyLiveFlags(doc, next.stored?.collections ?? {});
  delete next.stored;
  scene.active_view_layer = i;
  return true;
}

export type ViewLayerAddType = 'NEW' | 'COPY' | 'EMPTY';

/**
 * Add a view layer to the active scene and make it active: NEW (default settings, every
 * collection included), COPY (the active layer's settings and flags) or EMPTY (every top-level
 * collection excluded). Returns the index of the new layer.
 */
export function addViewLayer(doc: DocumentData, type: ViewLayerAddType = 'NEW', name?: string): number {
  const scene = doc.scene;
  const layers = ensureViewLayers(scene);
  const act = layers[scene.active_view_layer!];
  let render: Partial<RenderSettings>;
  let collections: Record<ID, LayerCollectionFlags> = {};
  const layer: ViewLayerData = { name: '' };
  if (type === 'COPY') {
    render = captureRender(scene.render);
    collections = captureLiveFlags(doc);
    if (act.lightgroups) layer.lightgroups = cloneShared(act.lightgroups);
    if (act.samples) layer.samples = act.samples;
  } else {
    render = defaultLayerRender();
    if (type === 'EMPTY') for (const ch of doc.collections[scene.collection]?.children ?? []) collections[ch] = { exclude: true };
  }
  layer.name = uniqueLayerName(scene, name || (type === 'COPY' ? act.name : 'ViewLayer'));
  layer.stored = { render, collections };
  layers.push(layer);
  setActiveViewLayer(doc, layers.length - 1);
  return layers.length - 1;
}

/** Remove layer `i` of the active scene (a scene keeps at least one). */
export function removeViewLayer(doc: DocumentData, i: number): boolean {
  const scene = doc.scene;
  const layers = ensureViewLayers(scene);
  if (layers.length < 2 || i < 0 || i >= layers.length) return false;
  if (i === scene.active_view_layer) setActiveViewLayer(doc, i > 0 ? i - 1 : 1);
  layers.splice(i, 1);
  if (scene.active_view_layer! > i) scene.active_view_layer!--;
  return true;
}

/** Run `fn` with layer `i` temporarily active (no undo step; the previous layer is restored). */
export function withViewLayer<T>(doc: DocumentData, i: number, fn: () => T): T {
  const prev = activeLayerIndex(doc.scene);
  if (i === prev) return fn();
  setActiveViewLayer(doc, i);
  try {
    return fn();
  } finally {
    setActiveViewLayer(doc, prev);
  }
}

/** Indices of the layers rendered by F12 (Use for Rendering), in list order. */
export function renderLayers(scene: SceneData): number[] {
  const layers = ensureViewLayers(scene);
  const out: number[] = [];
  for (let i = 0; i < layers.length; i++) if (layerRender(scene, i).use_view_layer !== false) out.push(i);
  return out;
}

declare module '../data/types' {
  interface SceneData {
    /** collection flags of the active layer while the scene is inactive (the collections are shared) */
    stashed_flags?: Record<ID, LayerCollectionFlags>;
  }
}

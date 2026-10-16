// Scripting API of scenes and view layers: bpy.data.scenes (new / remove), context.scene /
// window.scene (assignable: switches the active scene), Scene.view_layers (new / remove),
// ViewLayer passes, use, samples, layer_collection (exclude, hide_viewport, holdout,
// indirect_only), lightgroups and aovs, context.view_layer / window.view_layer.
import { app } from '../app/app';
import type { ID, SceneData } from '../data/types';
import { Context, SceneStruct, sceneHooks, sceneWrapperFor, viewLayer as legacyViewLayer, activeCollectionId, wrapId } from '../scripting/api';
import { PropCollection, Struct, kwMethod, mixin, proxify, pyError, touched, type Raw } from '../scripting/rna';
import { allScenes, deleteScene, newScene, renameScene, sceneById, sceneObjects, activateScene } from './scenes';
import { LAYER_RENDER_KEYS, activeLayerIndex, addViewLayer, ensureViewLayers, layerFlags, layerRender, removeViewLayer, setActiveViewLayer, uniqueLayerName } from './viewlayers';
import type { LayerCollectionFlags, ViewLayerData } from './types';
import { switchScene, switchViewLayer } from './switch';

type Any = Record<string, unknown>;

sceneHooks.rename = (sc, name) => renameScene(app.doc, sc, name);
sceneHooks.objects = (sc) => app.doc.object_order.filter((id) => sceneObjects(app.doc, sc).has(id));
sceneHooks.list = () => allScenes(app.doc);
sceneHooks.create = (name) => {
  // a new, empty scene; the active scene stays active
  const prev = app.doc.scene.id!;
  const sc = newScene(app.doc, 'NEW');
  sc.name = name ? renameScene(app.doc, sc, name) : sc.name;
  activateScene(app.doc, prev);
  return sc;
};
sceneHooks.remove = (id) => {
  const ok = deleteScene(app.doc, id);
  if (ok) app.changed('doc', 'frame', 'select');
  return ok;
};

/** Scene of a wrapper (or the active scene). */
const sceneOf = (sid: string | null): SceneData => {
  const sc = sid ? sceneById(app.doc, sid) : app.doc.scene;
  if (!sc) throw pyError('ReferenceError', 'StructRNA of type Scene has been removed');
  return sc;
};

/** Write a view layer render setting (live for the active layer, stored otherwise). */
function setLayerRender(sc: SceneData, i: number, key: string, v: unknown) {
  if (i === activeLayerIndex(sc)) (sc.render as unknown as Any)[key] = v;
  else {
    const l = ensureViewLayers(sc)[i];
    l.stored ??= { render: {}, collections: {} };
    (l.stored.render as Any)[key] = v;
  }
  touched();
}

// ---------------------------------------------------------------------------
// LayerCollection

class LayerCollection extends Struct {
  constructor(
    readonly sid: string,
    readonly li: number,
    readonly cid: ID,
  ) {
    super('LayerCollection', () => (app.doc.collections[cid] ?? sceneOf(sid).master_collection ?? null) as unknown as Raw, '');
  }
  override get __path() {
    return `bpy.context.view_layer.layer_collection`;
  }
  private get sc() {
    return sceneOf(this.sid);
  }
  private flag(k: keyof LayerCollectionFlags): boolean {
    return !!layerFlags(app.doc, this.sc, this.li, this.cid)[k];
  }
  private setFlag(k: keyof LayerCollectionFlags, v: unknown) {
    const sc = this.sc;
    if (this.cid === sc.collection) throw pyError('RuntimeError', 'the scene collection cannot be excluded or hidden');
    const on = !!v;
    if (sc === app.doc.scene && this.li === activeLayerIndex(sc)) {
      const c = app.doc.collections[this.cid];
      if (!c) return;
      if (k === 'exclude' || k === 'hide') c[k] = on;
      else if (on) c[k] = true;
      else delete c[k];
    } else {
      const flags = this.li === activeLayerIndex(sc) ? (sc.stashed_flags ??= {}) : ((ensureViewLayers(sc)[this.li].stored ??= { render: {}, collections: {} }).collections);
      const f = (flags[this.cid] ??= {});
      if (on) f[k] = true;
      else delete f[k];
    }
    touched();
  }
  get name() {
    return (app.doc.collections[this.cid] ?? sceneOf(this.sid).master_collection)?.name ?? '';
  }
  get collection() {
    return wrapId('collections', this.cid);
  }
  get exclude() {
    return this.flag('exclude');
  }
  set exclude(v: boolean) {
    this.setFlag('exclude', v);
  }
  get hide_viewport() {
    return this.flag('hide');
  }
  set hide_viewport(v: boolean) {
    this.setFlag('hide', v);
  }
  get holdout() {
    return this.flag('holdout');
  }
  set holdout(v: boolean) {
    this.setFlag('holdout', v);
  }
  get indirect_only() {
    return this.flag('indirect_only');
  }
  set indirect_only(v: boolean) {
    this.setFlag('indirect_only', v);
  }
  get children() {
    const self = this;
    const c = this.cid === this.sc.collection ? (app.doc.collections[this.cid] ?? this.sc.master_collection) : app.doc.collections[this.cid];
    const kids = (c?.children ?? []).filter((id) => app.doc.collections[id]);
    return new (class extends PropCollection<unknown> {
      list() {
        return kids.map((id) => proxify(new LayerCollection(self.sid, self.li, id)));
      }
      nameOf(x: unknown) {
        return (x as { name: string }).name;
      }
    })('LayerCollection.children');
  }
  is_visible() {
    return !this.flag('exclude') && !this.flag('hide');
  }
  override toString() {
    return `<bpy_struct, LayerCollection("${this.name}")>`;
  }
}

// ---------------------------------------------------------------------------
// ViewLayer

class NamedList extends PropCollection<unknown> {
  constructor(
    path: string,
    private readonly source: () => { name: string }[],
    private readonly make: (name: string) => unknown,
    private readonly drop: (item: { name: string }) => void,
  ) {
    super(path);
  }
  list() {
    return this.source().map((x) => x);
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  new(name = '') {
    const r = this.make(String(name));
    touched();
    return r;
  }
  remove(item: unknown) {
    const it = this.source().find((x) => x === item || x.name === (item as { name?: string })?.name);
    if (!it) throw pyError('ValueError', 'remove(): item not found');
    this.drop(it);
    touched();
  }
}

kwMethod(NamedList.prototype, 'new', ['name']);
kwMethod(NamedList.prototype, 'remove', ['item']);

class ViewLayerStruct extends Struct {
  constructor(
    readonly sid: string,
    readonly layer: ViewLayerData,
  ) {
    super('ViewLayer', () => (ensureViewLayers(sceneOf(sid)).includes(layer) ? (layer as unknown as Raw) : null), '');
  }
  override __hidden() {
    return LAYER_HIDDEN;
  }
  get sc() {
    return sceneOf(this.sid);
  }
  get index() {
    const i = ensureViewLayers(this.sc).indexOf(this.layer);
    if (i < 0) throw pyError('ReferenceError', 'StructRNA of type ViewLayer has been removed');
    return i;
  }
  override get __path() {
    return `bpy.data.scenes[${JSON.stringify(this.sc.name)}].view_layers[${JSON.stringify(this.layer.name)}]`;
  }
  get name() {
    return this.layer.name;
  }
  set name(v: string) {
    this.layer.name = uniqueLayerName(this.sc, String(v).trim().slice(0, 63) || 'ViewLayer', this.layer);
    touched();
  }
  get use() {
    return layerRender(this.sc, this.index).use_view_layer !== false;
  }
  set use(v: boolean) {
    setLayerRender(this.sc, this.index, 'use_view_layer', !!v);
  }
  get samples() {
    return this.layer.samples ?? 0;
  }
  set samples(v: number) {
    this.layer.samples = Math.max(0, Math.round(Number(v)));
    touched();
  }
  get objects() {
    if (this.sc !== app.doc.scene) return (sceneWrapperFor(this.sid) as { objects: unknown }).objects;
    return legacyViewLayer.objects;
  }
  get active_layer_collection() {
    if (this.sc !== app.doc.scene) return this.layer_collection;
    return proxify(new LayerCollection(this.sid, this.index, activeCollectionId()));
  }
  get layer_collection() {
    return proxify(new LayerCollection(this.sid, this.index, this.sc.collection));
  }
  get lightgroups() {
    const l = this.layer;
    return new NamedList(
      `${this.__path}.lightgroups`,
      () => l.lightgroups ?? [],
      (name) => {
        const list = (l.lightgroups ??= []);
        const base = name.replace(/[^A-Za-z0-9_]/g, '_') || 'Lightgroup';
        let n = base;
        for (let i = 1; list.some((g) => g.name === n); i++) n = `${base}_${String(i).padStart(3, '0')}`;
        const g = { name: n };
        list.push(g);
        return g;
      },
      (g) => (l.lightgroups = (l.lightgroups ?? []).filter((x) => x !== g)),
    );
  }
  get aovs() {
    const sc = this.sc;
    const i = this.index;
    const get = () => (layerRender(sc, i).aovs ?? []) as { name: string; type: 'COLOR' | 'VALUE' }[];
    return new NamedList(
      `${this.__path}.aovs`,
      get,
      (name) => {
        const list = [...get()];
        const base = name || 'AOV';
        let n = base;
        for (let k = 1; list.some((a) => a.name === n); k++) n = `${base}.${String(k).padStart(3, '0')}`;
        const a = { name: n, type: 'COLOR' as const };
        setLayerRender(sc, i, 'aovs', [...list, a]);
        return get()[get().length - 1];
      },
      (a) => setLayerRender(sc, i, 'aovs', get().filter((x) => x !== a)),
    );
  }
  get active_lightgroup_index() {
    return this.layer.active_lightgroup_index ?? 0;
  }
  set active_lightgroup_index(v: number) {
    this.layer.active_lightgroup_index = Math.max(0, Math.round(Number(v)));
  }
  get active_aov_index() {
    return this.layer.active_aov_index ?? 0;
  }
  set active_aov_index(v: number) {
    this.layer.active_aov_index = Math.max(0, Math.round(Number(v)));
  }
  update() {
    app.evaluate();
  }
  override toString() {
    return `<bpy_struct, ViewLayer("${this.layer.name}")>`;
  }
  override repr() {
    return this.__path;
  }
}
const LAYER_HIDDEN = new Set(['stored', 'lightgroups']);
for (const k of LAYER_RENDER_KEYS) {
  if (k === 'use_view_layer' || k === 'aovs') continue;
  Object.defineProperty(ViewLayerStruct.prototype, k, {
    get(this: ViewLayerStruct) {
      const v = (layerRender(this.sc, this.index) as Any)[k];
      return k === 'use_pass_combined' ? v !== false : typeof v === 'number' ? v : !!v;
    },
    set(this: ViewLayerStruct, v: unknown) {
      setLayerRender(this.sc, this.index, k, typeof v === 'number' && k !== 'pass_cryptomatte_depth' && k !== 'ambient_occlusion_distance' ? !!v : v);
    },
    enumerable: true,
    configurable: true,
  });
}

const layerWrappers = new WeakMap<ViewLayerData, unknown>();
function layerWrapper(sid: string, l: ViewLayerData) {
  let w = layerWrappers.get(l);
  if (!w) layerWrappers.set(l, (w = proxify(new ViewLayerStruct(sid, l))));
  return w;
}

class ViewLayers extends PropCollection<unknown> {
  constructor(readonly sid: string) {
    super('Scene.view_layers');
  }
  list() {
    return ensureViewLayers(sceneOf(this.sid)).map((l) => layerWrapper(this.sid, l));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  new(name = 'ViewLayer') {
    const sc = sceneOf(this.sid);
    if (sc !== app.doc.scene) throw pyError('RuntimeError', 'view layers can be added to the active scene');
    const prev = activeLayerIndex(sc);
    const i = addViewLayer(app.doc, 'NEW', String(name));
    setActiveViewLayer(app.doc, prev);
    touched();
    return layerWrapper(this.sid, ensureViewLayers(sc)[i]);
  }
  remove(layer: unknown) {
    const sc = sceneOf(this.sid);
    if (sc !== app.doc.scene) throw pyError('RuntimeError', 'view layers can be removed from the active scene');
    const l = (layer as { layer?: ViewLayerData })?.layer;
    const i = l ? ensureViewLayers(sc).indexOf(l) : -1;
    if (i < 0) throw pyError('ValueError', 'ViewLayers.remove(): view layer not found');
    if (!removeViewLayer(app.doc, i)) throw pyError('RuntimeError', 'ViewLayers.remove(): a scene needs at least one view layer');
    touched();
  }
}
kwMethod(ViewLayers.prototype, 'new', ['name']);
kwMethod(ViewLayers.prototype, 'remove', ['layer']);

class SceneLayers {
  get view_layers() {
    return new ViewLayers((this as unknown as SceneStruct).__id);
  }
}
mixin(SceneStruct, SceneLayers, true);

/** Wrapper of the active view layer. */
function activeLayerWrapper() {
  const sc = app.doc.scene;
  return layerWrapper(sc.id!, ensureViewLayers(sc)[activeLayerIndex(sc)]);
}

/** A window: the scene and view layer it shows (both assignable). */
function windowStruct(base: Any) {
  return {
    ...base,
    get scene() {
      return sceneWrapperFor(app.doc.scene.id!);
    },
    set scene(v: unknown) {
      const id = (v as { __id?: string } | null)?.__id;
      if (!id || !sceneById(app.doc, id)) throw pyError('TypeError', 'Window.scene: expected a Scene');
      switchScene(id);
    },
    get view_layer() {
      return activeLayerWrapper();
    },
    set view_layer(v: unknown) {
      const l = (v as { layer?: ViewLayerData })?.layer;
      const i = l ? ensureViewLayers(app.doc.scene).indexOf(l) : -1;
      if (i < 0) throw pyError('TypeError', 'Window.view_layer: expected a view layer of the window scene');
      switchViewLayer(i);
    },
  };
}

const prevWindow = Object.getOwnPropertyDescriptor(Context.prototype, 'window')?.get;
class ContextScenes {
  get view_layer() {
    return activeLayerWrapper();
  }
  get window() {
    const base = (prevWindow?.call(this) ?? { __kind: 'struct', __type: 'Window' }) as Any;
    return windowStruct(base);
  }
}
mixin(Context, ContextScenes, true);

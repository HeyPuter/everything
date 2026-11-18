// Document → .blend (the 4.2 LTS layout, which every later version reads and upgrades).
// The inverse of ../convert.ts: scene settings, view layer, collections, objects with their
// transforms, parenting and display settings, meshes, cameras, lights, materials and worlds with
// their node trees, and packed images. What the format cannot carry from this app (modifier stacks,
// curves, animation, …) is written as its evaluated result or left out, with a message; the whole
// project travels along in a block other programs skip (../embed.ts), so this app loses nothing.
import type { CameraData, CollectionData, DocumentData, ImageData, LightData, MaterialData, MeshData, NodeTreeData, ObjectData, WorldData } from '../../../data/types';
import { buildExportScene, type ExportMesh } from '../../formats/scene-builder';
import { BlendWriter, type Addr, type Struct } from './container';
import { DNA_FILE_VERSION } from './dna.gen';
import { meshSourceFromDoc, writeMesh, type MeshSource } from './mesh';
import { writeNodeTree } from './nodes';
import { EMBED_CODE, embedPayload } from '../embed';

export interface BlendWriteOptions {
  /** this app's encoded project, stored whole so reopening the file here loses nothing */
  embed?: Uint8Array;
}

export interface BlendWriteResult {
  bytes: Uint8Array;
  warnings: string[];
}

const ROT_MODE: Record<string, number> = { AXIS_ANGLE: -1, QUATERNION: 0, XYZ: 1, XZY: 2, YXZ: 3, YZX: 4, ZXY: 5, ZYX: 6 };
const EMPTY_DRAW: Record<ObjectData['empty_display_type'], number> = { PLAIN_AXES: 1, ARROWS: 1, SINGLE_ARROW: 4, CIRCLE: 3, CUBE: 5, SPHERE: 6, CONE: 7, IMAGE: 8 };
const DISPLAY: Record<ObjectData['display_type'], number> = { BOUNDS: 1, WIRE: 2, SOLID: 3, TEXTURED: 5 };
const COLOR_TAGS = ['COLOR_01', 'COLOR_02', 'COLOR_03', 'COLOR_04', 'COLOR_05', 'COLOR_06', 'COLOR_07', 'COLOR_08'];
const LIGHT_TYPE: Record<LightData['type'], number> = { POINT: 0, SUN: 1, SPOT: 2, AREA: 4 };
const AREA_SHAPE: Record<LightData['shape'], number> = { SQUARE: 0, RECTANGLE: 1, DISK: 4, ELLIPSE: 5 };
const VIEW_TRANSFORM: Record<string, string> = { AGX: 'AgX', FILMIC: 'Filmic', STANDARD: 'Standard', KHRONOS_PBR_NEUTRAL: 'Khronos PBR Neutral', RAW: 'Raw' };
const ENGINE: Record<string, string> = { PATHTRACE: 'CYCLES', SOLID: 'BLENDER_WORKBENCH', RASTER: 'BLENDER_EEVEE_NEXT' };
/** ID flag of data owned by another ID (master collection, node trees of materials and worlds) */
const LIB_EMBEDDED_DATA = 1024;
const COLLECTION_IS_MASTER = 32;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Unique data-block names per ID code ("name", "name.001", …) within the 63 bytes a name may use. */
class Names {
  private used = new Map<string, Set<string>>();
  take(code: string, name: string): string {
    const set = this.used.get(code) ?? new Set<string>();
    this.used.set(code, set);
    const enc = new TextEncoder();
    const clip = (s: string, bytes: number) => {
      while (enc.encode(s).length > bytes) s = s.slice(0, -1);
      return s;
    };
    const base = clip(name || 'Untitled', 63);
    let n = base;
    for (let k = 1; set.has(n); k++) {
      const suffix = `.${String(k).padStart(3, '0')}`;
      n = clip(base, 63 - suffix.length) + suffix;
    }
    set.add(n);
    return code + n;
  }
}

function flatMat(m: unknown): number[] {
  const a = Array.isArray(m) && Array.isArray(m[0]) ? (m as number[][]).flat() : Array.from((m as ArrayLike<number>) ?? []);
  return a.length === 16 && a.every(Number.isFinite) ? a : IDENTITY;
}

/** Writes structs as a ListBase of the owner: next / prev links and the list's first / last. */
function linkList(w: BlendWriter, owner: Struct, field: string, items: Struct[]): Addr[] {
  const addrs = items.map(() => w.addr());
  items.forEach((s, i) => {
    if (i > 0) s.ptr('prev', addrs[i - 1]);
    if (i < items.length - 1) s.ptr('next', addrs[i + 1]);
  });
  items.forEach((s, i) => w.write('DATA', s, addrs[i]));
  if (items.length) owner.list(field, addrs[0], addrs[addrs.length - 1]);
  return addrs;
}

type DataKind = 'ME' | 'CA' | 'LA';

class DocWriter {
  readonly w = new BlendWriter();
  readonly names = new Names();
  readonly warnings = new Set<string>();
  readonly scene: DocumentData['scene'];
  readonly master: CollectionData;
  readonly collections: CollectionData[] = [];
  readonly objects: ObjectData[] = [];
  /** document id → address, per kind */
  readonly at = {
    scene: 0 as Addr,
    master: 0 as Addr,
    viewLayer: 0 as Addr,
    collection: new Map<string, Addr>(),
    object: new Map<string, Addr>(),
    material: new Map<string, Addr>(),
    image: new Map<string, Addr>(),
    world: new Map<string, Addr>(),
  };
  /** each object's data: kind, address, and how it is written */
  readonly data = new Map<string, { kind: DataKind; addr: Addr; slots: number }>();
  private readonly dataWriters: (() => void)[] = [];
  private readonly evalMesh = new Map<string, ExportMesh>();
  private readonly users = new Map<Addr, number>();

  constructor(
    readonly doc: DocumentData,
    readonly opts: BlendWriteOptions,
  ) {
    this.scene = doc.scene;
    this.master = doc.collections[this.scene.collection];
    if (!this.master) throw new Error('The scene has no collection');
    const w = this.w;
    this.at.scene = w.addr();
    this.at.master = w.addr();
    this.at.viewLayer = w.addr();
    this.gather();
    for (const c of this.collections) this.at.collection.set(c.id, w.addr());
    for (const o of this.objects) this.at.object.set(o.id, w.addr());
    this.evaluate();
    this.planData();
  }

  warn(m: string) {
    this.warnings.add(m);
  }
  use(a: Addr) {
    if (a) this.users.set(a, (this.users.get(a) ?? 0) + 1);
    return a;
  }
  usersOf(a: Addr, min = 1) {
    return Math.max(min, this.users.get(a) ?? 0);
  }

  /** The scene's collection tree, its objects, instanced collections and parents. */
  private gather() {
    const doc = this.doc;
    const seen = new Set<string>();
    const ids = new Set<string>();
    const walk = (c: CollectionData | undefined) => {
      if (!c || seen.has(c.id)) return;
      seen.add(c.id);
      if (c !== this.master) this.collections.push(c);
      for (const o of c.objects) if (doc.objects[o]) ids.add(o);
      for (const ch of c.children) walk(doc.collections[ch]);
    };
    walk(this.master);
    for (const id of [...ids]) {
      const ic = doc.objects[id]?.instance_collection;
      if (ic) walk(doc.collections[ic]);
    }
    for (const id of [...ids]) for (let p = doc.objects[id]?.parent; p && doc.objects[p] && !ids.has(p); p = doc.objects[p].parent) ids.add(p);
    for (const id of doc.object_order) if (ids.has(id)) this.objects.push(doc.objects[id]);
    for (const id of ids) if (!doc.object_order.includes(id)) this.objects.push(doc.objects[id]);
  }

  /** Objects whose geometry is written evaluated: active modifiers, shape keys, curves and text. */
  needsEval(ob: ObjectData) {
    if (ob.type === 'MESH') {
      const me = ob.data ? this.doc.meshes[ob.data] : null;
      return ob.modifiers.some((m) => m.show_viewport !== false) || !!me?.shape_keys?.length;
    }
    return ob.type === 'CURVE' || ob.type === 'FONT' || ob.type === 'SURFACE';
  }

  private evaluate() {
    const want = this.objects.filter((o) => this.needsEval(o));
    if (!want.length) return;
    try {
      const ex = buildExportScene(this.doc, { applyModifiers: true, skins: false, shapeKeys: false, animation: false, includeHidden: true, objectIds: new Set(want.map((o) => o.id)) });
      for (const eo of ex.objects) if (eo.mesh) this.evalMesh.set(eo.id, eo.mesh);
    } catch (e) {
      this.warn(`Evaluated geometry could not be computed (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  materialAddr(id: string | null | undefined): Addr {
    if (!id || !this.doc.materials[id]) return 0;
    let a = this.at.material.get(id);
    if (!a) this.at.material.set(id, (a = this.w.addr()));
    return a;
  }
  imageAddr = (id: string | null | undefined): Addr => {
    if (!id || !this.doc.images[id]) return 0;
    let a = this.at.image.get(id);
    if (!a) this.at.image.set(id, (a = this.w.addr()));
    return this.use(a);
  };
  worldAddr(id: string | null | undefined): Addr {
    if (!id || !this.doc.worlds[id]) return 0;
    let a = this.at.world.get(id);
    if (!a) this.at.world.set(id, (a = this.w.addr()));
    return a;
  }

  /** Decides what each object's data block is; shared data is written once. */
  private planData() {
    const doc = this.doc;
    const shared = new Map<string, { kind: DataKind; addr: Addr; slots: number }>();
    for (const ob of this.objects) {
      const share = (key: string, kind: DataKind, slots: number, write: (a: Addr) => void) => {
        let d = shared.get(key);
        if (!d) {
          d = { kind, addr: this.w.addr(), slots };
          shared.set(key, d);
          const a = d.addr;
          this.dataWriters.push(() => write(a));
        }
        this.use(d.addr);
        this.data.set(ob.id, d);
      };
      if (this.needsEval(ob)) {
        const em = this.evalMesh.get(ob.id);
        if (!em) {
          this.warn(`Object geometry that could not be evaluated is stored as an empty (${ob.name})`);
          continue;
        }
        share(`eval:${ob.id}`, 'ME', em.materials.length, (a) => this.writeEvalMesh(em, ob, a));
        if (ob.type !== 'MESH') this.warn(`Curves and text are stored as meshes in .blend files (${ob.name})`);
        else if (ob.modifiers.some((m) => m.show_viewport !== false)) this.warn(`Modifiers are applied in .blend files (${ob.name})`);
        else this.warn(`Shape keys are applied in .blend files (${ob.name})`);
      } else if (ob.type === 'MESH' && ob.data && doc.meshes[ob.data]) {
        const me = doc.meshes[ob.data];
        share(`me:${me.id}`, 'ME', me.materials.length, (a) => this.writeDocMesh(me, a));
      } else if (ob.type === 'CAMERA' && ob.data && doc.cameras[ob.data]) {
        const ca = doc.cameras[ob.data];
        share(`ca:${ca.id}`, 'CA', 0, (a) => this.writeCamera(ca, a));
      } else if (ob.type === 'LIGHT' && ob.data && doc.lights[ob.data]) {
        const la = doc.lights[ob.data];
        share(`la:${la.id}`, 'LA', 0, (a) => this.writeLight(la, a));
      } else if (ob.type !== 'EMPTY') {
        this.warn(`${ob.type.charAt(0) + ob.type.slice(1).toLowerCase().replace(/_/g, ' ')} objects are stored as empties in .blend files (${ob.name})`);
      }
    }
    // user counts of collections (parents, instancing) and objects (collections)
    for (const c of [this.master, ...this.collections]) {
      for (const o of c.objects) if (this.at.object.has(o)) this.use(this.at.object.get(o)!);
      for (const ch of c.children) if (this.at.collection.has(ch)) this.use(this.at.collection.get(ch)!);
    }
  }

  run(): BlendWriteResult {
    this.writeGlobal();
    this.writeScene();
    for (const c of this.collections) this.writeCollection(c);
    for (const o of this.objects) this.writeObject(o);
    for (const f of this.dataWriters) f();
    // materials, worlds and images found while writing the blocks above
    const written = new Set<string>();
    for (let again = true; again; ) {
      again = false;
      for (const [id, a] of [...this.at.material]) if (!written.has(id)) {
          written.add(id);
          this.writeMaterial(this.doc.materials[id], a);
          again = true;
        }
      for (const [id, a] of [...this.at.world]) if (!written.has(id)) {
          written.add(id);
          this.writeWorld(this.doc.worlds[id], a);
          again = true;
        }
    }
    for (const [id, a] of this.at.image) this.writeImage(this.doc.images[id], a);
    if (this.opts.embed) this.w.extra(EMBED_CODE, embedPayload(this.opts.embed));
    return { bytes: this.w.finish(), warnings: [...this.warnings] };
  }

  // ---------------------------------------------------------------- file global and scene
  private writeGlobal() {
    const g = this.w.struct('FileGlobal');
    g.set('subversion', DNA_FILE_VERSION.subversion).set('minversion', DNA_FILE_VERSION.minversion).set('minsubversion', DNA_FILE_VERSION.minsubversion);
    g.set('subvstr', String(DNA_FILE_VERSION.subversion).padStart(4, ' '));
    g.set('build_hash', '').set('build_commit_timestamp', 0).set('globalf', 0).set('filename', '');
    g.ptr('curscene', this.at.scene).ptr('cur_view_layer', this.at.viewLayer);
    this.w.write('GLOB', g);
  }

  private writeScene() {
    const { w, scene, at } = this;
    const sc = w.struct('Scene');
    sc.set('id.name', this.names.take('SC', scene.name || 'Scene')).set('id.us', 1);
    const slot = w.reserve();
    const r = sc.sub('r');
    r.set('sfra', scene.frame_start).set('efra', scene.frame_end).set('cfra', Math.round(scene.frame_current)).set('frame_step', scene.frame_step || 1);
    const rs = scene.render;
    r.set('frs_sec', Math.round(rs.fps || 24)).set('frs_sec_base', rs.fps_base || 1);
    r.set('xsch', rs.resolution_x).set('ysch', rs.resolution_y).set('size', rs.resolution_percentage || 100);
    r.set('xasp', rs.pixel_aspect_x || 1).set('yasp', rs.pixel_aspect_y || 1);
    r.set('alphamode', rs.film_transparent ? 1 : 0);
    if (ENGINE[rs.engine]) r.set('engine', ENGINE[rs.engine]);
    if (scene.frame_preview_end !== undefined && scene.frame_preview_start !== undefined && scene.frame_preview_end > scene.frame_preview_start) {
      r.set('psfra', scene.frame_preview_start).set('pefra', scene.frame_preview_end);
    }
    const vs = sc.sub('view_settings');
    const vt = rs.view_transform && VIEW_TRANSFORM[rs.view_transform];
    if (vt) vs.set('view_transform', vt);
    if (rs.exposure !== undefined) vs.set('exposure', rs.exposure);
    if (rs.gamma !== undefined) vs.set('gamma', rs.gamma || 1);
    if (vt && rs.look && rs.look !== 'None') vs.set('look', `${vt} - ${rs.look}`);
    sc.set('cursor.location', scene.cursor.location).set('cursor.rotation_euler', scene.cursor.rotation_euler);
    const units = scene.unit_settings;
    sc.set('unit.system', Math.max(0, ['NONE', 'METRIC', 'IMPERIAL'].indexOf(units.system))).set('unit.scale_length', units.scale_length || 1);
    if (scene.gravity) sc.set('physics_settings.gravity', scene.gravity);
    if (scene.use_gravity !== undefined) sc.sub('physics_settings').flag('flag', 1, scene.use_gravity);
    if (scene.camera && at.object.has(scene.camera)) sc.ptr('camera', at.object.get(scene.camera)!);
    const wa = this.worldAddr(scene.world);
    if (wa) sc.ptr('world', this.use(wa));
    sc.ptr('master_collection', at.master);
    // tool settings: readers expect a scene to have them (the values of a new scene)
    sc.ptr('toolsettings', w.write('DATA', w.struct('ToolSettings')));
    if (scene.timeline_markers?.length) this.warn('Timeline markers are not stored in .blend files yet');

    // master collection (embedded in the scene)
    const mc = w.struct('Collection');
    mc.set('id.name', 'GRScene Collection').set('id.flag', LIB_EMBEDDED_DATA).set('flag', COLLECTION_IS_MASTER).set('color_tag', -1);
    mc.ptr('owner_id', at.scene);
    this.collectionLists(mc, this.master);
    w.write('DATA', mc, at.master);

    // view layer: bases (selection, hidden) and layer collections (exclude, hide, holdout)
    const vl = w.struct('ViewLayer');
    vl.set('name', scene.view_layers?.[scene.active_view_layer ?? 0]?.name || 'ViewLayer').flag('flag', 1, scene.render.use_view_layer !== false);
    const inScene = new Set([this.master, ...this.collections].flatMap((c) => c.objects));
    const bases = this.objects
      .filter((o) => inScene.has(o.id))
      .map((o) => {
        const b = w.struct('Base');
        b.ptr('object', at.object.get(o.id)!);
        b.set('flag', (o.select ? 1 : 0) | (o.hide ? 256 : 0));
        return { b, o };
      });
    const baseAddrs = linkList(
      w,
      vl,
      'object_bases',
      bases.map((x) => x.b),
    );
    const act = bases.findIndex((x) => x.o.id === scene.active_object);
    if (act >= 0) vl.ptr('basact', baseAddrs[act]);
    const layerTree = (c: CollectionData): Struct => {
      const lc = w.struct('LayerCollection');
      lc.ptr('collection', c === this.master ? at.master : at.collection.get(c.id)!);
      if (c !== this.master) lc.set('flag', (c.exclude ? 16 : 0) | (c.holdout ? 32 : 0) | (c.indirect_only ? 64 : 0) | (c.hide ? 128 : 0));
      const kids = c.children.map((id) => this.doc.collections[id]).filter((x): x is CollectionData => !!x && at.collection.has(x.id));
      linkList(w, lc, 'layer_collections', kids.map(layerTree));
      return lc;
    };
    const [rootLc] = linkList(w, vl, 'layer_collections', [layerTree(this.master)]);
    vl.ptr('active_collection', rootLc);
    w.write('DATA', vl, at.viewLayer);
    sc.list('view_layers', at.viewLayer, at.viewLayer);
    w.fill(slot, 'SC', sc, at.scene);
  }

  private collectionLists(st: Struct, c: CollectionData) {
    const { w, at } = this;
    const obs = c.objects.filter((id) => at.object.has(id)).map((id) => w.struct('CollectionObject').ptr('ob', at.object.get(id)!));
    linkList(w, st, 'gobject', obs);
    const kids = c.children.filter((id) => at.collection.has(id)).map((id) => w.struct('CollectionChild').ptr('collection', at.collection.get(id)!));
    linkList(w, st, 'children', kids);
  }

  private writeCollection(c: CollectionData) {
    const { w, at } = this;
    const a = at.collection.get(c.id)!;
    const st = w.struct('Collection');
    st.set('id.name', this.names.take('GR', c.name)).set('id.us', this.usersOf(a));
    const slot = w.reserve();
    st.set('flag', (c.hide_viewport ? 1 : 0) | (c.hide_select ? 2 : 0) | (c.hide_render ? 8 : 0));
    st.set('color_tag', COLOR_TAGS.indexOf(c.color_tag)).set('dupli_ofs', c.instance_offset);
    this.collectionLists(st, c);
    w.fill(slot, 'GR', st, a);
  }

  // ---------------------------------------------------------------- objects
  private writeObject(ob: ObjectData) {
    const { w, at } = this;
    const a = at.object.get(ob.id)!;
    const st = w.struct('Object');
    st.set('id.name', this.names.take('OB', ob.name)).set('id.us', this.usersOf(a));
    const slot = w.reserve();
    const d = this.data.get(ob.id);
    st.set('type', d?.kind === 'ME' ? 1 : d?.kind === 'CA' ? 11 : d?.kind === 'LA' ? 10 : 0);
    if (d) st.ptr('data', d.addr);
    // transform
    st.set('loc', ob.location).set('rot', ob.rotation_euler).set('size', ob.scale).set('quat', ob.rotation_quaternion);
    st.set('rotAngle', ob.rotation_axis_angle[0]).set('rotAxis', ob.rotation_axis_angle.slice(1));
    st.set('rotmode', ROT_MODE[ob.rotation_mode] ?? 1);
    st.set('dloc', ob.delta_location).set('drot', ob.delta_rotation_euler).set('dscale', ob.delta_scale);
    // parenting
    if (ob.parent && at.object.has(ob.parent)) {
      st.ptr('parent', at.object.get(ob.parent)!).set('partype', 0);
      st.set('parentinv', flatMat(ob.matrix_parent_inverse));
      if (ob.parent_type === 'BONE') this.warn(`Bone parents are stored as object parents in .blend files (${ob.name})`);
      else if (ob.parent_type !== 'OBJECT') this.warn(`Vertex parents are stored as object parents in .blend files (${ob.name})`);
    }
    // visibility, locks, display
    st.set('restrictflag', (ob.hide_viewport ? 1 : 0) | (ob.hide_select ? 2 : 0) | (ob.hide_render ? 4 : 0));
    let pf = 0;
    ob.lock_location.forEach((v, i) => v && (pf |= 1 << i));
    ob.lock_rotation.forEach((v, i) => v && (pf |= 8 << i));
    ob.lock_scale.forEach((v, i) => v && (pf |= 64 << i));
    st.set('protectflag', pf);
    st.set('dt', DISPLAY[ob.display_type] ?? 5);
    st.set('dtx', (ob.show_bounds ? 1 : 0) | (ob.show_axis ? 2 : 0) | (ob.show_name ? 8 : 0) | (ob.show_wire ? 32 : 0) | (ob.show_in_front ? 64 : 0));
    st.set('col', ob.color);
    st.set('empty_drawtype', EMPTY_DRAW[ob.empty_display_type] ?? 1).set('empty_drawsize', ob.empty_display_size || 1);
    if (ob.type === 'EMPTY' && ob.empty_display_type === 'IMAGE') this.warn(`Image empties are stored as plain empties in .blend files (${ob.name})`);
    if (ob.pass_index) st.set('index', ob.pass_index);
    // instancing
    if (ob.instance_type === 'COLLECTION' && ob.instance_collection && at.collection.has(ob.instance_collection)) {
      st.flag('transflag', 256, true).ptr('dup_group', this.use(at.collection.get(ob.instance_collection)!));
    } else if (ob.instance_type === 'VERTS') st.flag('transflag', 16, true);
    else if (ob.instance_type === 'FACES') st.flag('transflag', 512, true);
    // material slots: as many as the data has; object-linked slots carry their material here
    const slots = d?.kind === 'ME' ? d.slots : 0;
    if (slots) {
      const links = ob.material_slots_link ?? [];
      const bits = new Uint8Array(slots);
      const mats: Addr[] = [];
      for (let i = 0; i < slots; i++) {
        const onObject = links[i] === 'OBJECT';
        bits[i] = onObject ? 1 : 0;
        mats.push(onObject ? this.use(this.materialAddr(ob.object_materials?.[i])) : 0);
      }
      st.set('totcol', slots).set('actcol', Math.min(slots, (ob.active_material_index ?? 0) + 1));
      st.ptr('mat', w.pointers(mats)).ptr('matbits', w.raw(bits));
    }
    if (ob.modifiers.length && !this.needsEval(ob)) this.warn(`Disabled modifiers are not stored in .blend files (${ob.name})`);
    if (ob.constraints.length) this.warn(`Constraints are not stored in .blend files yet (${ob.name})`);
    const ad = ob.animation_data;
    if (ad && (ad.action || ad.nla_tracks.length || ad.drivers.length)) this.warn(`Animation is not stored in .blend files yet (${ob.name})`);
    if (ob.particle_systems.length) this.warn(`Particle systems are not stored in .blend files (${ob.name})`);
    if (ob.rigid_body) this.warn(`Rigid bodies are not stored in .blend files (${ob.name})`);
    w.fill(slot, 'OB', st, a);
  }

  // ---------------------------------------------------------------- object data
  private writeDocMesh(me: MeshData, a: Addr) {
    const mats = me.materials.map((m) => this.use(this.materialAddr(m)));
    const st = writeMesh(this.w, meshSourceFromDoc(me, mats), this.names.take('ME', me.name), a, (m) => this.warn(m));
    void st;
  }

  private writeEvalMesh(em: ExportMesh, ob: ObjectData, a: Addr) {
    const mats = em.materials.map((m) => this.use(this.materialAddr(m)));
    const src: MeshSource = {
      name: ob.name,
      positions: em.positions,
      offsets: em.offsets,
      indices: em.indices,
      smooth: em.smooth,
      materialIndex: em.materialIndex,
      uvs: em.uvs ? [{ name: em.uvName || 'UVMap', data: em.uvs }] : [],
      activeUv: 0,
      renderUv: 0,
      colors: em.colors.map((c) => ({ name: c.name, domain: 'CORNER' as const, data: c.data })),
      activeColor: 0,
      groups: em.groups ? { names: em.groups.names, weights: em.groups.weights, active: 0 } : null,
      materials: mats,
    };
    writeMesh(this.w, src, this.names.take('ME', ob.name), a, (m) => this.warn(m));
  }

  private writeCamera(ca: CameraData, a: Addr) {
    const st = this.w.struct('Camera');
    st.set('id.name', this.names.take('CA', ca.name)).set('id.us', this.usersOf(a));
    st.set('type', Math.max(0, ['PERSP', 'ORTHO', 'PANO'].indexOf(ca.type)));
    st.set('lens', ca.lens).set('sensor_x', ca.sensor_width).set('sensor_y', ca.sensor_height);
    st.set('sensor_fit', Math.max(0, ['AUTO', 'HORIZONTAL', 'VERTICAL'].indexOf(ca.sensor_fit)));
    st.set('ortho_scale', ca.ortho_scale).set('clipsta', ca.clip_start).set('clipend', ca.clip_end);
    st.set('shiftx', ca.shift_x).set('shifty', ca.shift_y).set('drawsize', ca.display_size || 1).set('passepartalpha', ca.passepartout_alpha);
    st.flag('flag', 1, !!ca.show_limits).flag('flag', 4, !!ca.show_passepartout);
    const dof = st.sub('dof');
    dof.flag('flag', 1, !!ca.dof.use_dof).set('focus_distance', ca.dof.focus_distance).set('aperture_fstop', ca.dof.aperture_fstop).set('aperture_blades', ca.dof.aperture_blades);
    if (ca.dof.aperture_rotation !== undefined) dof.set('aperture_rotation', ca.dof.aperture_rotation);
    if (ca.dof.aperture_ratio !== undefined) dof.set('aperture_ratio', ca.dof.aperture_ratio);
    if (ca.dof.focus_object && this.at.object.has(ca.dof.focus_object)) dof.ptr('focus_object', this.at.object.get(ca.dof.focus_object)!);
    if (ca.type === 'PANO') this.warn(`Panoramic camera settings are not stored in .blend files (${ca.name})`);
    this.w.write('CA', st, a);
  }

  private writeLight(la: LightData, a: Addr) {
    const st = this.w.struct('Lamp');
    st.set('id.name', this.names.take('LA', la.name)).set('id.us', this.usersOf(a));
    st.set('type', LIGHT_TYPE[la.type] ?? 0);
    st.set('r', la.color[0]).set('g', la.color[1]).set('b', la.color[2]);
    st.set(st.has('energy_new') ? 'energy_new' : 'energy', la.energy);
    st.set('radius', la.shadow_soft_size).set('sun_angle', la.angle).set('spotsize', la.spot_size).set('spotblend', la.spot_blend);
    st.flag('mode', 1, la.use_shadow).flag('mode', 1 << 17, la.show_cone);
    st.set('area_shape', AREA_SHAPE[la.shape] ?? 0).set('area_size', la.size).set('area_sizey', la.size_y);
    st.set('diff_fac', la.diffuse_factor).set('spec_fac', la.specular_factor).set('volume_fac', la.volume_factor);
    if (la.cutoff_distance !== undefined) st.set('att_dist', la.cutoff_distance);
    if (la.spread !== undefined && st.has('area_spread')) st.set('area_spread', la.spread);
    if (la.exposure !== undefined && st.has('exposure')) st.set('exposure', la.exposure);
    this.w.write('LA', st, a);
  }

  // ---------------------------------------------------------------- materials, worlds, images
  private tree(tree: NodeTreeData | undefined, owner: Addr, ownerName: string): Addr {
    if (!tree) return 0;
    return writeNodeTree(this.w, tree, this.w.addr(), owner, { image: this.imageAddr, warn: (m) => this.warn(m), owner: ownerName });
  }

  private writeMaterial(m: MaterialData, a: Addr) {
    const st = this.w.struct('Material');
    st.set('id.name', this.names.take('MA', m.name)).set('id.us', this.usersOf(a));
    const slot = this.w.reserve();
    const c = m.diffuse_color ?? [0.8, 0.8, 0.8, 1];
    st.set('r', c[0]).set('g', c[1]).set('b', c[2]).set('a', c[3] ?? 1);
    st.set('metallic', m.metallic ?? 0).set('roughness', m.roughness ?? 0.5);
    st.set('alpha_threshold', m.alpha_threshold ?? 0.5).set('index', m.pass_index ?? 0);
    st.flag('blend_flag', 4, !!m.use_backface_culling);
    if (st.has('surface_render_method')) st.set('surface_render_method', m.blend_method === 'BLEND' ? 1 : 0);
    st.set('blend_method', ({ OPAQUE: 0, CLIP: 3, HASHED: 4, BLEND: 5 } as Record<string, number>)[m.blend_method ?? 'OPAQUE'] ?? 0);
    st.set('use_nodes', m.use_nodes === false ? 0 : 1);
    if (m.tree) st.ptr('nodetree', this.tree(m.tree, a, m.name));
    this.w.fill(slot, 'MA', st, a);
  }

  private writeWorld(wo: WorldData, a: Addr) {
    const st = this.w.struct('World');
    st.set('id.name', this.names.take('WO', wo.name)).set('id.us', this.usersOf(a));
    const slot = this.w.reserve();
    st.set('horr', wo.color[0]).set('horg', wo.color[1]).set('horb', wo.color[2]);
    if (wo.mist_start !== undefined) st.set('miststa', wo.mist_start);
    if (wo.mist_depth !== undefined) st.set('mistdist', wo.mist_depth);
    st.set('use_nodes', wo.use_nodes === false ? 0 : 1);
    if (wo.tree) st.ptr('nodetree', this.tree(wo.tree, a, wo.name));
    this.w.fill(slot, 'WO', st, a);
  }

  private writeImage(im: ImageData, a: Addr) {
    const { w } = this;
    const st = w.struct('Image');
    st.set('id.name', this.names.take('IM', im.name)).set('id.us', this.usersOf(a));
    const slot = w.reserve();
    const cs = im.colorspace === 'Non-Color' ? 'Non-Color' : im.colorspace === 'Linear' ? 'Linear Rec.709' : 'sRGB';
    st.set('colorspace_settings.name', cs);
    if (im.bytes && im.bytes.length) {
      // packed: the file's bytes travel inside the .blend file
      const ext = im.mime === 'image/jpeg' ? 'jpg' : (im.mime.split('/')[1] ?? 'png').replace('x-', '').replace('vnd.radiance', 'hdr');
      const path = im.filepath || `//${im.name.replace(/[\\/:*?"<>|]/g, '_')}.${ext}`;
      st.set('name', path).set('source', 1).set('type', 0);
      const pf = w.struct('PackedFile').set('size', im.bytes.length);
      pf.ptr('data', w.raw(im.bytes));
      const pfAddr = w.write('DATA', pf);
      st.ptr('packedfile', pfAddr);
      const ipf = w.struct('ImagePackedFile').set('filepath', path).set('tile_number', 1001);
      ipf.ptr('packedfile', pfAddr);
      const ia = w.write('DATA', ipf);
      st.list('packedfiles', ia, ia);
    } else if (im.source === 'GENERATED') {
      st.set('source', 4).set('gen_x', im.width || 1024).set('gen_y', im.height || 1024);
      st.set('gen_type', Math.max(0, ['BLANK', 'UV_GRID', 'COLOR_GRID'].indexOf(im.generated_type ?? 'BLANK')));
      if (im.generated_color) st.set('gen_color', im.generated_color);
    } else {
      st.set('name', im.filepath || im.name).set('source', 1);
      this.warn(`Images without their pixels are stored as file references (${im.name})`);
    }
    const tile = w.struct('ImageTile').set('tile_number', 1001);
    const ta = w.write('DATA', tile);
    st.list('tiles', ta, ta);
    st.ptr('stereo3d_format', w.write('DATA', w.struct('Stereo3dFormat')));
    w.fill(slot, 'IM', st, a);
  }
}

/** Writes the document as a .blend file. */
export function writeBlend(doc: DocumentData, opts: BlendWriteOptions = {}): BlendWriteResult {
  return new DocWriter(doc, opts).run();
}

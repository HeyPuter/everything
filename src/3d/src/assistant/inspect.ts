// Text descriptions of the scene for the model: the snapshot sent with each
// message, and the details behind get_scene, get_object and get_material.
// Read straight from the document and the evaluated depsgraph, so sizes
// include modifiers. World is Z-up, lengths in meters, angles in degrees.

import { Box3, Vector3 } from 'three';
import type { App } from '../app/app';
import type { CollectionData, DocumentData, MaterialData, NodeTreeData, ObjectData } from '../data/types';
import { getNodeType } from '../nodes/registry';

const DEG = 180 / Math.PI;

/** A number rounded for reading: at most 4 decimals, no "-0". */
export function n(x: number, digits = 4): string {
  if (!Number.isFinite(x)) return String(x);
  const r = Number(x.toFixed(digits));
  return String(Object.is(r, -0) ? 0 : r);
}
const vec = (v: ArrayLike<number>, digits = 4) => `(${Array.from(v, (x) => n(x, digits)).join(', ')})`;
const deg = (v: ArrayLike<number>) => `(${Array.from(v, (x) => n(x * DEG, 2)).join(', ')})`;
const q = (s: string) => JSON.stringify(s);
const isZero = (v: ArrayLike<number>) => Array.from(v).every((x) => Math.abs(x) < 1e-9);
const isOne = (v: ArrayLike<number>) => Array.from(v).every((x) => Math.abs(x - 1) < 1e-9);

export interface Bounds {
  /** Local bounding box size times scale (the object's `dimensions`). */
  dims: Vector3;
  /** World-space axis-aligned box. */
  world: Box3;
}

/** An object's evaluated size; null for objects without geometry (empties, lights, cameras). */
export function objectBounds(app: App, id: string): Bounds | null {
  const ev = app.graph.get(id);
  const P = ev?.mesh?.positions;
  if (!ev || !P || P.length < 3) return null;
  const local = new Box3();
  const world = new Box3();
  const v = new Vector3();
  const count = P.length / 3;
  const step = Math.max(1, Math.floor(count / 20000));
  for (let i = 0; i < count; i += step) {
    v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    local.expandByPoint(v);
    world.expandByPoint(v.applyMatrix4(ev.world));
  }
  const s = new Vector3().setFromMatrixScale(ev.world);
  return { dims: local.getSize(new Vector3()).multiply(s), world };
}

const boxText = (b: Box3) => `x ${n(b.min.x, 3)}…${n(b.max.x, 3)}, y ${n(b.min.y, 3)}…${n(b.max.y, 3)}, z ${n(b.min.z, 3)}…${n(b.max.z, 3)}`;

export class Inspector {
  constructor(private app: App) {}

  private get doc(): DocumentData {
    return this.app.doc;
  }

  /** Makes sure evaluated geometry matches the document. */
  settle() {
    if (this.app.hasPending) this.app.flush();
  }

  objectsInOrder(): ObjectData[] {
    const d = this.doc;
    const seen = new Set<string>();
    const out: ObjectData[] = [];
    for (const id of d.object_order ?? []) {
      const ob = d.objects[id];
      if (ob && !seen.has(id)) (seen.add(id), out.push(ob));
    }
    for (const ob of Object.values(d.objects)) if (!seen.has(ob.id)) out.push(ob);
    return out;
  }

  findObject(name: string): ObjectData | null {
    const obs = Object.values(this.doc.objects);
    return obs.find((o) => o.name === name) ?? obs.find((o) => o.name.toLowerCase() === String(name).toLowerCase()) ?? null;
  }

  findMaterial(name: string): MaterialData | null {
    const ms = Object.values(this.doc.materials);
    return ms.find((m) => m.name === name) ?? ms.find((m) => m.name.toLowerCase() === String(name).toLowerCase()) ?? null;
  }

  private name(table: keyof DocumentData, id: string | null | undefined): string {
    if (!id) return '';
    const t = this.doc[table] as unknown as Record<string, { name?: string }> | undefined;
    return t?.[id]?.name ?? '';
  }

  /** Material names of an object's slots (object-linked overrides included). */
  materials(ob: ObjectData): string[] {
    const data = ob.data ? ((this.doc as unknown as Record<string, Record<string, { materials?: (string | null)[] }>>)[tableOf(ob.type)]?.[ob.data] ?? null) : null;
    const slots = data?.materials ?? [];
    const out: string[] = [];
    const count = Math.max(slots.length, ob.object_materials?.length ?? 0);
    for (let i = 0; i < count; i++) {
      const id = ob.material_slots_link?.[i] === 'OBJECT' ? ob.object_materials?.[i] : slots[i];
      out.push(id ? this.name('materials', id) : '(empty)');
    }
    return out;
  }

  private typeDetail(ob: ObjectData): string {
    const d = this.doc;
    if (ob.type === 'LIGHT' && ob.data) {
      const l = d.lights[ob.data];
      return l ? `${l.type}, ${n(l.energy, 2)} ${l.type === 'SUN' ? 'strength' : 'W'}` : '';
    }
    if (ob.type === 'CAMERA' && ob.data) {
      const c = d.cameras[ob.data];
      const parts = c ? [c.type === 'ORTHO' ? 'orthographic' : `${n(c.lens, 1)} mm`] : [];
      if (d.scene.camera === ob.id) parts.push('scene camera');
      return parts.join(', ');
    }
    if (ob.type === 'EMPTY') return ob.empty_display_type;
    if (ob.type === 'GREASEPENCIL' && ob.data) {
      const gp = d.grease_pencils?.[ob.data];
      if (!gp) return '';
      let strokes = 0;
      for (const dr of gp.drawings) strokes += dr.offsets.length - 1;
      return `${gp.layers.length} layer${gp.layers.length === 1 ? '' : 's'}, ${strokes} stroke${strokes === 1 ? '' : 's'}`;
    }
    if (ob.type === 'META' && ob.data) {
      const mb = d.metaballs?.[ob.data];
      return mb ? `${mb.elements.length} element${mb.elements.length === 1 ? '' : 's'}` : '';
    }
    if (ob.type === 'ARMATURE' && ob.data) {
      const arm = d.armatures[ob.data];
      return arm ? `${arm.bones.length} bone${arm.bones.length === 1 ? '' : 's'}` : '';
    }
    if (ob.type === 'SPEAKER' && ob.speaker) return `${ob.speaker.sound ? 'sound' : 'no sound'}, volume ${n(ob.speaker.volume, 2)}`;
    if (ob.type === 'FONT' && ob.data) {
      const t = d.curves[ob.data] as unknown as { body?: string } | undefined;
      return t?.body ? `text ${q(t.body.length > 40 ? `${t.body.slice(0, 39)}…` : t.body)}` : '';
    }
    return '';
  }

  /** One line per object: what and where it is. */
  objectLine(ob: ObjectData): string {
    const parts: string[] = [];
    const detail = this.typeDetail(ob);
    parts.push(`location ${vec(ob.location, 3)}`);
    if (!isZero(ob.rotation_euler) && ob.rotation_mode !== 'QUATERNION' && ob.rotation_mode !== 'AXIS_ANGLE') parts.push(`rotation ${deg(ob.rotation_euler)}°`);
    else if (ob.rotation_mode === 'QUATERNION') parts.push(`rotation quaternion ${vec(ob.rotation_quaternion, 3)}`);
    if (!isOne(ob.scale)) parts.push(`scale ${vec(ob.scale, 3)}`);
    const b = objectBounds(this.app, ob.id);
    if (b) parts.push(`size ${n(b.dims.x, 3)} × ${n(b.dims.y, 3)} × ${n(b.dims.z, 3)}`, `bounds ${boxText(b.world)}`);
    if (ob.parent) parts.push(`parent ${q(this.name('objects', ob.parent))}`);
    const mats = ob.type === 'MESH' || ob.type === 'CURVE' || ob.type === 'FONT' ? this.materials(ob).filter((m) => m !== '(empty)') : [];
    if (mats.length) parts.push(`material${mats.length > 1 ? 's' : ''} ${mats.map(q).join(', ')}`);
    if (ob.modifiers.length) parts.push(`modifiers ${ob.modifiers.map((m) => `${m.name} (${m.type})`).join(', ')}`);
    if (ob.constraints.length) parts.push(`constraints ${ob.constraints.map((c) => c.type).join(', ')}`);
    if (ob.animation_data?.action) parts.push(`animated (${this.actionRange(ob.animation_data.action)})`);
    const hidden = [ob.hide && 'hidden', ob.hide_viewport && 'disabled in viewports', ob.hide_render && 'hidden in renders'].filter(Boolean);
    if (hidden.length) parts.push(hidden.join(', '));
    return `- ${q(ob.name)} ${ob.type}${detail ? ` (${detail})` : ''}: ${parts.join('; ')}`;
  }

  private actionRange(actionId: string): string {
    const a = this.doc.actions[actionId];
    if (!a) return 'action missing';
    let lo = Infinity,
      hi = -Infinity;
    const paths = new Set<string>();
    for (const fc of a.fcurves) {
      paths.add(fc.data_path);
      for (const k of fc.keyframe_points) {
        const f = k.co[0];
        lo = Math.min(lo, f);
        hi = Math.max(hi, f);
      }
    }
    return `${[...paths].slice(0, 4).join(', ')}${paths.size > 4 ? '…' : ''}${Number.isFinite(lo) ? `, frames ${n(lo, 2)}–${n(hi, 2)}` : ''}`;
  }

  sceneHeader(): string {
    const s = this.doc.scene;
    const u = s.unit_settings;
    const world = s.world ? this.doc.worlds[s.world] : null;
    const lines = [
      `Scene ${q(s.name)}: frames ${s.frame_start}–${s.frame_end} at ${n(s.render.fps / (s.render.fps_base || 1), 2)} fps (current ${s.frame_current}); render engine ${s.render.engine}, ${s.render.resolution_x}×${s.render.resolution_y}; units ${u.system}${u.scale_length !== 1 ? ` (scale ${n(u.scale_length)})` : ''}.`,
      `World: ${world ? `${q(world.name)}, color ${vec(world.color, 3)}` : 'none'}. 3D cursor at ${vec(s.cursor.location, 3)}.`,
    ];
    return lines.join('\n');
  }

  modeLine(): string {
    const d = this.doc;
    const active = d.scene.active_object ? d.objects[d.scene.active_object] : null;
    const sel = this.objectsInOrder().filter((o) => o.select);
    const selText = sel.length ? `${sel.slice(0, 20).map((o) => q(o.name)).join(', ')}${sel.length > 20 ? ` and ${sel.length - 20} more` : ''}` : 'nothing';
    return `Mode: ${d.mode}. Active object: ${active ? q(active.name) : 'none'}. Selected: ${selText}.`;
  }

  objectsText(limit: number): string {
    const obs = this.objectsInOrder();
    if (!obs.length) return 'Objects: none (the scene is empty).';
    const lines = [`Objects (${obs.length}):`];
    for (const ob of obs.slice(0, limit)) lines.push(this.objectLine(ob));
    if (obs.length > limit) {
      const rest = obs.slice(limit);
      const byType = new Map<string, number>();
      for (const o of rest) byType.set(o.type, (byType.get(o.type) ?? 0) + 1);
      lines.push(`… and ${rest.length} more (${[...byType].map(([t, c]) => `${c} ${t}`).join(', ')}); call get_scene for all of them.`);
    }
    return lines.join('\n');
  }

  collectionsText(): string {
    const d = this.doc;
    const root = d.collections[d.scene.collection];
    if (!root) return '';
    const lines: string[] = [];
    const walk = (c: CollectionData, depth: number, seen: Set<string>) => {
      if (seen.has(c.id)) return;
      seen.add(c.id);
      const flags = [c.exclude && 'excluded', c.hide_viewport && 'disabled in viewports', c.hide && 'hidden', c.hide_render && 'hidden in renders'].filter(Boolean);
      if (depth > 0) lines.push(`${'  '.repeat(depth - 1)}- ${q(c.name)}: ${c.objects.length} object${c.objects.length === 1 ? '' : 's'}${flags.length ? ` (${flags.join(', ')})` : ''}`);
      for (const id of c.children) {
        const ch = d.collections[id];
        if (ch) walk(ch, depth + 1, seen);
      }
    };
    walk(root, 0, new Set());
    const loose = root.objects.length;
    return lines.length || loose ? `Collections${loose ? ` (${loose} object${loose === 1 ? '' : 's'} directly in the scene collection)` : ''}:\n${lines.join('\n')}`.trimEnd() : '';
  }

  /** The snapshot that goes with each message. */
  snapshot(extra: string[] = []): string {
    this.settle();
    const mats = Object.values(this.doc.materials).filter((m) => !m.grease_pencil);
    const parts = [this.sceneHeader(), this.modeLine(), ...extra, this.objectsText(60), this.collectionsText()];
    if (mats.length) parts.push(`Materials (${mats.length}): ${mats.slice(0, 40).map((m) => q(m.name)).join(', ')}${mats.length > 40 ? ', …' : ''}`);
    return parts.filter(Boolean).join('\n');
  }

  /** get_scene: everything at the scene level. */
  sceneText(limit = 300): string {
    this.settle();
    const d = this.doc;
    const parts = [this.sceneHeader(), this.modeLine(), this.objectsText(limit), this.collectionsText()];
    const list = (label: string, items: { name: string }[], fmt: (x: never) => string = (x: { name: string }) => q(x.name)) => {
      if (items.length) parts.push(`${label} (${items.length}): ${items.slice(0, 80).map((x) => fmt(x as never)).join(', ')}${items.length > 80 ? ', …' : ''}`);
    };
    list('Materials', Object.values(d.materials));
    list('Meshes', Object.values(d.meshes));
    list('Actions', Object.values(d.actions));
    list('Images', Object.values(d.images));
    list('Node groups', Object.values(d.node_groups));
    list('Texts', Object.values(d.texts));
    const r = d.scene.render;
    parts.push(`Render: engine ${r.engine}, ${r.resolution_x}×${r.resolution_y} at ${r.resolution_percentage}%, samples ${r.samples}, film transparent ${r.film_transparent}, output ${r.file_format}.`);
    list('Grease pencils', Object.values(d.grease_pencils ?? {}));
    list('Metaballs', Object.values(d.metaballs ?? {}));
    list('Masks', Object.values(d.masks ?? {}));
    const ks = d.scene.keying_sets ?? [];
    if (ks.length) parts.push(`Keying sets: ${ks.map((k) => `${q(k.name)} (${k.paths.length} paths)`).join(', ')}; active ${d.scene.keying_set ?? 'LocRotScale'}`);
    const seq = d.scene.sequence_editor;
    if (seq?.strips?.length) parts.push(`Video sequencer: ${seq.strips.length} strips: ${seq.strips.slice(0, 30).map((st) => `${q(st.name)} ${st.type} ch${st.channel} ${n(st.frame_start + st.frame_offset_start, 2)}–${n(st.frame_start + st.frame_duration - st.frame_offset_end, 2)}`).join(', ')}${seq.strips.length > 30 ? ', …' : ''}`);
    if (d.scene.timeline_markers.length) parts.push(`Markers: ${d.scene.timeline_markers.map((m) => `${q(m.name)} @${m.frame}`).join(', ')}`);
    return parts.filter(Boolean).join('\n');
  }

  /** get_object: one object in full. */
  objectText(ob: ObjectData): string {
    this.settle();
    const d = this.doc;
    const lines = [this.objectLine(ob).replace(/^- /, '')];
    const ev = this.app.graph.get(ob.id);
    if (ev) {
      const p = new Vector3().setFromMatrixPosition(ev.world);
      if (ob.parent || ob.constraints.length) lines.push(`World position: ${vec(p.toArray(), 3)}`);
    }
    lines.push(`Rotation mode ${ob.rotation_mode}; delta location ${vec(ob.delta_location, 3)}; display ${ob.display_type}${ob.show_wire ? ', wire overlay' : ''}${ob.show_in_front ? ', in front' : ''}.`);
    const children = Object.values(d.objects).filter((o) => o.parent === ob.id);
    if (children.length) lines.push(`Children: ${children.map((c) => q(c.name)).join(', ')}`);
    const colls = Object.values(d.collections).filter((c) => c.objects.includes(ob.id));
    if (colls.length) lines.push(`In collection${colls.length > 1 ? 's' : ''}: ${colls.map((c) => (c.id === d.scene.collection ? 'Scene Collection' : q(c.name))).join(', ')}`);
    if (ob.data) lines.push(`Data: ${q(this.name(tableOf(ob.type) as keyof DocumentData, ob.data))}`);
    if (ob.type === 'MESH' && ob.data) {
      const me = d.meshes[ob.data];
      if (me) {
        const faces = me.offsets.length - 1;
        const smooth = me.smooth ? Array.from(me.smooth).filter(Boolean).length : 0;
        lines.push(`Mesh: ${me.positions.length / 3} vertices, ${faces} faces${smooth ? ` (${smooth === faces ? 'all' : smooth} smooth-shaded)` : ', flat-shaded'}${me.uvs?.length ? ', has UVs' : ''}.`);
        if (ev?.mesh && ob.modifiers.length) lines.push(`After modifiers: ${ev.mesh.positions.length / 3} vertices, ${ev.mesh.offsets.length - 1} faces.`);
        const vg = (me as unknown as { vertex_groups?: { name: string }[] }).vertex_groups ?? (ob as unknown as { vertex_groups?: { name: string }[] }).vertex_groups;
        if (vg?.length) lines.push(`Vertex groups: ${vg.map((g) => q(g.name)).join(', ')}`);
        const sk = (me as unknown as { shape_keys?: { name: string }[] }).shape_keys;
        if (sk?.length) lines.push(`Shape keys: ${sk.map((k) => q(k.name)).join(', ')}`);
      }
    }
    if (ob.type === 'LIGHT' && ob.data) {
      const l = d.lights[ob.data];
      if (l) lines.push(`Light: ${l.type}, color ${vec(l.color, 3)}, energy ${n(l.energy)}, radius ${n(l.shadow_soft_size)}${l.type === 'SPOT' ? `, spot size ${n(l.spot_size * DEG, 2)}°, blend ${n(l.spot_blend)}` : ''}${l.type === 'AREA' ? `, ${l.shape} size ${n(l.size)}` : ''}${l.type === 'SUN' ? `, angle ${n(l.angle * DEG, 2)}°` : ''}.`);
    }
    if (ob.type === 'CAMERA' && ob.data) {
      const c = d.cameras[ob.data];
      if (c) lines.push(`Camera: ${c.type}, lens ${n(c.lens, 2)} mm, sensor ${n(c.sensor_width, 2)} mm, clip ${n(c.clip_start)}–${n(c.clip_end)}.`);
    }
    const mats = this.materials(ob);
    if (mats.length) lines.push(`Material slots: ${mats.map((m, i) => `${i}: ${m === '(empty)' ? m : q(m)}`).join(', ')}`);
    for (const m of ob.modifiers) lines.push(`Modifier ${q(m.name)} (${m.type}): ${settings(m, ['id', 'name', 'type', 'show_expanded', 'show_on_cage'], d)}`);
    for (const c of ob.constraints) lines.push(`Constraint ${q(c.name)} (${c.type}): ${settings(c, ['id', 'name', 'type', 'show_expanded'], d)}`);
    const ad = ob.animation_data;
    if (ad?.action) {
      const a = d.actions[ad.action];
      if (a) {
        lines.push(`Action ${q(a.name)}:`);
        for (const fc of a.fcurves.slice(0, 40)) {
          const keys = fc.keyframe_points.map((k) => k.co);
          lines.push(`  ${fc.data_path}[${fc.array_index}]: ${keys.length} keys ${keys.slice(0, 8).map(([f, v]) => `${n(f, 2)}→${n(v, 3)}`).join(', ')}${keys.length > 8 ? ', …' : ''}`);
        }
      }
    }
    if (ad?.nla_tracks?.length) lines.push(`NLA tracks: ${ad.nla_tracks.map((t) => `${q(t.name)} [${t.strips.map((st) => `${q(st.name)} ${n(st.frame_start, 2)}–${n(st.frame_end, 2)}`).join(', ')}]`).join('; ')}`);
    for (const dr of ad?.drivers ?? []) lines.push(`Driver ${dr.data_path}[${dr.array_index}]: ${dr.type}${dr.type === 'SCRIPTED' ? ` ${q(dr.expression)}` : ''}${dr.variables.length ? ` with ${dr.variables.map((v) => `${v.name} = ${v.type === 'SINGLE_PROP' ? `${v.targets[0]?.id ? q(this.name('objects', v.targets[0].id)) : 'self'}.${v.targets[0]?.data_path}` : v.type}`).join(', ')}` : ''}`);
    if (ob.type === 'ARMATURE' && ob.data) {
      const arm = d.armatures[ob.data];
      if (arm) lines.push(`Bones: ${arm.bones.slice(0, 60).map((b) => `${q(b.name)}${b.parent ? ` (child of ${q(b.parent)})` : ''}`).join(', ')}${arm.bones.length > 60 ? ', …' : ''}`);
      const posed = Object.entries(ob.pose ?? {}).filter(([, pb]) => !isZero(pb.location) || !isZero(pb.rotation_euler) || pb.rotation_quaternion[0] !== 1 || !isOne(pb.scale) || pb.constraints.length);
      if (posed.length) lines.push(`Posed bones: ${posed.slice(0, 30).map(([name, pb]) => `${q(name)}${pb.constraints.length ? ` (constraints ${pb.constraints.map((c) => c.type).join(', ')})` : ''}`).join(', ')}`);
    }
    if (ob.type === 'GREASEPENCIL' && ob.data) {
      const gp = d.grease_pencils?.[ob.data];
      for (const l of gp?.layers ?? []) {
        const strokes = l.frames.map((f) => (gp!.drawings[f.drawing]?.offsets.length ?? 1) - 1);
        lines.push(`Layer ${q(l.name)}: keyframes ${l.frames.map((f, i) => `${f.frame_number} (${strokes[i]} strokes)`).join(', ') || 'none'}${l.hide ? ', hidden' : ''}${l.opacity !== 1 ? `, opacity ${n(l.opacity, 2)}` : ''}`);
      }
    }
    for (const fx of ob.shader_effects ?? []) lines.push(`Effect ${q(fx.name)} (${fx.type}): ${settings(fx, ['id', 'name', 'type', 'show_expanded'], d)}`);
    if (ob.type === 'SPEAKER' && ob.speaker) lines.push(`Speaker: ${ob.speaker.sound ? q(ob.speaker.sound.filepath) : 'no sound'}, volume ${n(ob.speaker.volume)}, pitch ${n(ob.speaker.pitch)}, starts at frame ${ob.speaker.frame_start}${ob.speaker.muted ? ', muted' : ''}.`);
    if (ob.rigid_body) lines.push(`Rigid body: ${(ob.rigid_body as unknown as { type: string }).type}`);
    if (ob.particle_systems?.length) lines.push(`Particle systems: ${ob.particle_systems.length}`);
    const custom = (ob as unknown as { custom?: Record<string, unknown> }).custom;
    if (custom && Object.keys(custom).length) lines.push(`Custom properties: ${JSON.stringify(custom).slice(0, 400)}`);
    return lines.join('\n');
  }

  /** get_material: settings and node tree. */
  materialText(m: MaterialData): string {
    const users = this.objectsInOrder().filter((o) => this.materials(o).includes(m.name));
    const lines = [
      `Material ${q(m.name)}: viewport color ${vec(m.diffuse_color, 3)}, metallic ${n(m.metallic)}, roughness ${n(m.roughness)}, blend ${m.blend_method}${m.use_backface_culling ? ', backface culling' : ''}; nodes ${m.use_nodes ? 'on' : 'off'}.`,
      `Used by: ${users.length ? users.map((o) => q(o.name)).join(', ') : 'no object'}.`,
    ];
    if (m.tree) lines.push(treeText(m.tree));
    return lines.join('\n');
  }
}

const tableOf = (type: string) => ({ MESH: 'meshes', CURVE: 'curves', SURFACE: 'curves', FONT: 'curves', LIGHT: 'lights', CAMERA: 'cameras', ARMATURE: 'armatures', LATTICE: 'lattices', GREASEPENCIL: 'grease_pencils', META: 'metaballs', EMPTY: 'images' })[type] ?? 'meshes';

function value(v: unknown, d: DocumentData): string {
  if (typeof v === 'number') return n(v);
  if (typeof v === 'string') {
    for (const t of ['objects', 'materials', 'images', 'collections', 'node_groups'] as const) {
      const hit = (d[t] as Record<string, { name: string }>)[v];
      if (hit) return q(hit.name);
    }
    return q(v);
  }
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const a = Array.from(v as ArrayLike<unknown>);
    return a.length > 16 ? `[${a.length} values]` : `[${a.map((x) => value(x, d)).join(', ')}]`;
  }
  if (v && typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 160 ? `${s.slice(0, 159)}…` : s;
  }
  return String(v);
}

function settings(o: object, skip: string[], d: DocumentData): string {
  return Object.entries(o)
    .filter(([k]) => !skip.includes(k) && !k.startsWith('_'))
    .map(([k, v]) => `${k}=${value(v, d)}`)
    .join(', ');
}

/** A node tree as lines: nodes with their unlinked inputs that differ from the defaults, then links. */
export function treeText(tree: NodeTreeData): string {
  const byId = new Map(tree.nodes.map((nd) => [nd.id, nd]));
  const linked = new Set(tree.links.map((l) => `${l.to_node}:${l.to_socket}`));
  const lines = [`Nodes (${tree.nodes.length}):`];
  for (const nd of tree.nodes) {
    const def = getNodeType(nd.type);
    const defaults = new Map<string, unknown>();
    const names = new Map<string, string>();
    for (const s of def?.inputs ?? []) {
      defaults.set(s.identifier, s.default);
      names.set(s.identifier, s.name);
    }
    const ins = Object.entries(nd.inputs ?? {})
      .filter(([k, v]) => !linked.has(`${nd.id}:${k}`) && JSON.stringify(v) !== JSON.stringify(defaults.get(k)))
      .slice(0, 16)
      .map(([k, v]) => `${names.get(k) ?? k}=${Array.isArray(v) ? `[${v.map((x) => (typeof x === 'number' ? n(x, 3) : String(x))).join(', ')}]` : typeof v === 'number' ? n(v) : JSON.stringify(v)}`);
    const props = Object.entries(nd.props ?? {})
      .slice(0, 8)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    lines.push(`- ${q(nd.name)} ${nd.type}${nd.mute ? ' (muted)' : ''}${[...props, ...ins].length ? `: ${[...props, ...ins].join(', ')}` : ''}`);
  }
  if (tree.links.length) {
    lines.push('Links:');
    for (const l of tree.links) {
      const a = byId.get(l.from_node),
        b = byId.get(l.to_node);
      lines.push(`- ${q(a?.name ?? l.from_node)}.${l.from_socket} → ${q(b?.name ?? l.to_node)}.${l.to_socket}${l.is_muted ? ' (muted)' : ''}`);
    }
  }
  return lines.join('\n');
}


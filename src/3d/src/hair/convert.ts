// Conversions: Curves ↔ hair particle systems, Curves → Mesh (loose edges) / Curve (poly
// splines), Curve objects → Curves; snapping curve roots back onto their surface.
import { Matrix4, Vector3 } from 'three';
import { app, onAppReady, operators, registerOperator, registerOperators, type OpContext } from '../app/app';
import { newCurve, newMeshData, newObject, uid } from '../data/defaults';
import type { DocumentData, ObjectData, Spline } from '../data/types';
import { newModifier } from '../eval/modifiers';
import { uniqueName } from '../ops/object';
import { defaultParticleSettings, defaultPointCache, type EditedHair, type ObjectPhysics, type ParticleSettingsX, type ParticleSystemX } from '../physics/types';
import { evaluateHair, settingsOf, systemOf } from '../physics/particles';
import { curveObjectToCurves } from '../geonodes/curves/curvedata';
import { addHairObject } from './add';
import { hairEvalMesh } from './eval';
import { SURFACE_UV, appendCurves, curveCount, getAttr, hairOf, newHairCurves, radii, setAttr, uniqueHairName, type CurveInput } from './data';
import { componentToHair } from './component';
import { targetHairs } from './edit';
import { surfaceOf } from './common';
import { Surface } from './surface';
import type { HairCurvesData } from './types';

// ---------------------------------------------------------------------------
// snapping roots to the surface

/** Move every curve so its root sits on the surface: nearest point, or where its stored UV lies. */
export function snapToSurface(ob: ObjectData, hc: HairCurvesData, mode: 'NEAREST' | 'DEFORM'): number {
  const so = surfaceOf(ob, hc);
  if (!so) return 0;
  const s = Surface.of(so.mesh);
  const P = hc.positions.slice();
  const o = hc.curve_offsets;
  const uvA = getAttr(hc, SURFACE_UV);
  const uv = uvA ? Float32Array.from(uvA.data) : new Float32Array(curveCount(hc) * 2);
  let moved = 0;
  const p = new Vector3();
  for (let c = 0; c + 1 < o.length; c++) {
    p.fromArray(P, o[c] * 3).applyMatrix4(so.toSurface);
    let hit = null;
    if (mode === 'DEFORM' && uvA) hit = s.lookupUV([uv[c * 2], uv[c * 2 + 1]]);
    if (!hit) hit = s.closest(p);
    if (!hit) continue;
    const target = hit.point.clone().applyMatrix4(so.fromSurface);
    const off = target.sub(new Vector3().fromArray(P, o[c] * 3));
    for (let i = o[c]; i < o[c + 1]; i++) {
      P[i * 3] += off.x;
      P[i * 3 + 1] += off.y;
      P[i * 3 + 2] += off.z;
    }
    if (hit.uv) uv.set(hit.uv, c * 2);
    moved++;
  }
  hc.positions = P;
  if (s.hasUV) setAttr(hc, SURFACE_UV, 'CURVE', 'FLOAT2', uv);
  return moved;
}

// ---------------------------------------------------------------------------
// curves → particle system

/** Edited hair keys from curves (in the surface object's space). */
export function curvesToEditedHair(hc: HairCurvesData, toSurface: Matrix4): EditedHair {
  const n = hc.positions.length / 3;
  const co = new Float32Array(hc.positions.length);
  const v = new Vector3();
  for (let i = 0; i < n; i++) v.fromArray(hc.positions, i * 3).applyMatrix4(toSurface).toArray(co, i * 3);
  return { key_offsets: hc.curve_offsets.slice(), co, weight: new Float32Array(n).fill(1), select: new Uint8Array(n), hide: new Uint8Array(curveCount(hc)) };
}

/** Add (or update) a hair particle system on `surface` holding these curves. */
export function curvesToParticles(doc: DocumentData, ob: ObjectData, hc: HairCurvesData, surface: ObjectData, toSurface: Matrix4): ParticleSystemX {
  const sob = surface as ObjectPhysics;
  const name = ob.name;
  let ps = (sob.particle_systems as (ParticleSystemX & { id?: string })[]).find((x) => x.name === name);
  const keys = curvesToEditedHair(hc, toSurface);
  const maxKeys = Math.max(2, ...Array.from({ length: curveCount(hc) }, (_, c) => hc.curve_offsets[c + 1] - hc.curve_offsets[c]));
  const lengths: number[] = [];
  for (let c = 0; c < curveCount(hc); c++) {
    let l = 0;
    for (let i = hc.curve_offsets[c] + 1; i < hc.curve_offsets[c + 1]; i++) l += Math.hypot(hc.positions[i * 3] - hc.positions[i * 3 - 3], hc.positions[i * 3 + 1] - hc.positions[i * 3 - 2], hc.positions[i * 3 + 2] - hc.positions[i * 3 - 1]);
    lengths.push(l);
  }
  const avgLen = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0.1;
  if (!ps) {
    const s = defaultParticleSettings(uid('pa'), uniqueSettingsName(doc, name));
    Object.assign(s, { type: 'HAIR', frame_start: doc.scene.frame_start, frame_end: doc.scene.frame_start + 199 });
    doc.particles[s.id] = s;
    ps = { name, settings: s.id, seed: sob.particle_systems.length, id: uid('psys'), point_cache: defaultPointCache(doc.scene.frame_start, doc.scene.frame_end) };
    sob.particle_systems = [...sob.particle_systems, ps];
    const m = newModifier('PARTICLE_SYSTEM', uid('md'), sob.modifiers);
    m.name = name;
    m.particle_system = ps.id;
    sob.modifiers = [...sob.modifiers, m];
    sob.active_particle_system_index = sob.particle_systems.length - 1;
  }
  const st = doc.particles[ps.settings] as ParticleSettingsX;
  st.count = curveCount(hc);
  st.hair_length = avgLen;
  st.hair_step = Math.max(st.hair_step ?? 5, maxKeys - 1);
  ps.edited_hair = keys;
  return ps;
}

function uniqueSettingsName(doc: DocumentData, base: string) {
  let n = base;
  for (let i = 1; Object.values(doc.particles).some((x) => x.name === n); i++) n = `${base}.${String(i).padStart(3, '0')}`;
  return n;
}

// ---------------------------------------------------------------------------
// particle system → curves

/** Curves of a hair particle system as evaluated now (parents and children), emitter space. */
export function particleStrands(ob: ObjectData, psys: ParticleSystemX): CurveInput[] {
  const doc = app.doc;
  const s = settingsOf(doc, psys);
  const m = ob.modifiers.find((x) => x.type === 'PARTICLE_SYSTEM' && systemOf(ob, x) === psys);
  if (!s || s.type !== 'HAIR' || !m) return [];
  const mesh = baseMesh(ob);
  if (!mesh) return [];
  const hair = evaluateHair(ob, m, psys, s, mesh, 1);
  const per = hair.segments + 1;
  const out: CurveInput[] = [];
  const r = (s.particle_size ?? 0.05) * 0.1;
  for (let i = 0; i < hair.strands; i++) out.push({ points: hair.points.slice(i * per * 3, (i + 1) * per * 3), radius: Math.max(0.0005, Math.min(0.01, r)) });
  return out;
}

function baseMesh(ob: ObjectData) {
  // the emitter as evaluated by the modifiers before the particle system
  const ev = app.graph.get(ob.id);
  return ev?.mesh ?? null;
}

// ---------------------------------------------------------------------------
// operators

const curvesTargets = () => targetHairs().filter((t) => !!t.hc.surface);

registerOperators([
  {
    idname: 'curves.snap_curves_to_surface',
    label: 'Snap Curves to Surface',
    description: 'Move curve roots onto their surface',
    props: [
      {
        id: 'attach_mode',
        label: 'Attach Mode',
        type: 'enum',
        default: 'NEAREST',
        items: [
          ['NEAREST', 'Nearest', 'Use the nearest point on the surface'],
          ['DEFORM', 'Deform', 'Use the point at the stored UV coordinate (follows surface deformation)'],
        ],
      },
    ],
    poll: () => curvesTargets().length > 0,
    exec: (_c, p) => {
      let n = 0;
      for (const { ob, hc } of curvesTargets()) n += snapToSurface(ob, hc, p.attach_mode as 'NEAREST' | 'DEFORM');
      if (!n) {
        app.report('WARNING', 'The curves have no mesh surface to snap to');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'curves.convert_to_particle_system',
    label: 'Convert Curves to Particle System',
    description: 'Add a hair particle system on the surface object holding these curves (or update it)',
    poll: () => curvesTargets().length > 0,
    exec: (ctx) => {
      let n = 0;
      for (const { ob, hc } of curvesTargets()) {
        const so = surfaceOf(ob, hc);
        if (!so) continue;
        curvesToParticles(ctx.doc, ob, hc, so.ob, so.toSurface);
        n++;
      }
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'curves.convert_from_particle_system',
    label: 'Convert Particle System to Curves',
    description: 'Add a hair curves object made from the current state of the active hair particle system',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && !!activeHairSystem(),
    exec: (ctx) => {
      const r = activeHairSystem();
      if (!r) return 'CANCELLED';
      const strands = particleStrands(r.ob, r.psys);
      if (!strands.length) return 'CANCELLED';
      const { hc } = addHairObject(ctx.doc, r.psys.name, r.ob);
      hc.materials = [...((r.ob.data ? ctx.doc.meshes[r.ob.data]?.materials : null) ?? [])].slice(0, 1);
      const s = Surface.of(app.graph.get(r.ob.id)!.mesh!);
      for (const c of strands) {
        const h = s.closest(new Vector3(c.points[0], c.points[1], c.points[2]));
        if (h?.uv) c.uv = h.uv;
      }
      appendCurves(hc, strands);
    },
  },
]);

/** Active object's active hair particle system. */
export function activeHairSystem(): { ob: ObjectData; psys: ParticleSystemX } | null {
  const ob = app.activeObject as ObjectPhysics | null;
  if (!ob || ob.type !== 'MESH' || !ob.particle_systems.length) return null;
  const psys = ob.particle_systems[ob.active_particle_system_index ?? 0] as ParticleSystemX | undefined;
  const s = psys ? app.doc.particles[psys.settings] : undefined;
  return psys && s?.type === 'HAIR' ? { ob, psys } : null;
}

// ---------------------------------------------------------------------------
// object.convert: Curves objects to meshes / curves, curve objects to Curves

function hairToMeshObject(doc: DocumentData, ob: ObjectData, hc: HairCurvesData, keep: boolean) {
  const m = hairEvalMesh(hc);
  const curves = m.curves ?? [];
  let n = 0;
  for (const c of curves) n += c.points.length / 3;
  const pos = new Float32Array(n * 3);
  const edges: number[] = [];
  let o = 0;
  for (const c of curves) {
    const k = c.points.length / 3;
    pos.set(c.points, o * 3);
    for (let i = 0; i + 1 < k; i++) edges.push(o + i, o + i + 1);
    if (c.cyclic && k > 2) edges.push(o + k - 1, o);
    o += k;
  }
  const me = newMeshData(uniqueName(doc, ob.name, 'meshes'), { positions: pos, offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0) });
  me.loose_edges = Uint32Array.from(edges);
  me.materials = [...hc.materials];
  doc.meshes[me.id] = me;
  const target = keep ? copyObject(doc, ob) : ob;
  target.type = 'MESH';
  target.data = me.id;
}

function hairToCurveObject(doc: DocumentData, ob: ObjectData, hc: HairCurvesData, keep: boolean) {
  const cu = newCurve(uniqueName(doc, ob.name, 'curves'));
  const r = radii(hc);
  const o = hc.curve_offsets;
  const cyc = getAttr(hc, 'cyclic')?.data;
  const splines: Spline[] = [];
  for (let c = 0; c < curveCount(hc); c++) {
    const points = [];
    for (let i = o[c]; i < o[c + 1]; i++) points.push({ co: [hc.positions[i * 3], hc.positions[i * 3 + 1], hc.positions[i * 3 + 2], 1] as [number, number, number, number], radius: r[i] / 0.005, tilt: 0 });
    splines.push({ type: 'POLY', bezier_points: [], points, use_cyclic_u: !!cyc?.[c], resolution_u: 12, order_u: 4, use_smooth: true, material_index: 0 });
  }
  cu.splines = splines;
  cu.dimensions = '3D';
  cu.materials = [...hc.materials];
  doc.curves[cu.id] = cu;
  const target = keep ? copyObject(doc, ob) : ob;
  target.type = 'CURVE';
  target.data = cu.id;
}

function curveToHairObject(doc: DocumentData, ob: ObjectData, keep: boolean) {
  const cu = ob.data ? doc.curves[ob.data] : undefined;
  if (!cu) return false;
  doc.hair_curves ??= {};
  const target = keep ? copyObject(doc, ob) : ob;
  const hc = newHairCurves(uniqueHairName(doc, ob.name));
  componentToHair(curveObjectToCurves(cu), hc);
  // radius 1 on legacy curves means "unscaled": strands get the default hair radius scaled by it
  const r = getAttr(hc, 'radius');
  if (r) setAttr(hc, 'radius', 'POINT', 'FLOAT', Float32Array.from(r.data, (x) => x * 0.005));
  hc.materials = [...cu.materials];
  doc.hair_curves[hc.id] = hc;
  target.type = 'CURVES';
  target.data = hc.id;
  return true;
}

function copyObject(doc: DocumentData, ob: ObjectData): ObjectData {
  const copy = structuredClone({ ...ob, animation_data: null }) as ObjectData;
  copy.id = uid('ob');
  copy.name = uniqueName(doc, ob.name);
  copy.animation_data = ob.animation_data ? structuredClone(ob.animation_data) : null;
  doc.objects[copy.id] = copy;
  doc.object_order.push(copy.id);
  for (const c of Object.values(doc.collections)) if (c.objects.includes(ob.id)) c.objects.push(copy.id);
  return copy;
}

onAppReady(() => {
  const prev = operators.get('object.convert');
  if (!prev) return;
  const props = (prev.props ?? []).map((p) => (p.id === 'target' && p.items && !p.items.some((i) => i[0] === 'CURVES') ? { ...p, items: [...p.items, ['CURVES', 'Curves'] as [string, string]] } : p));
  registerOperator({
    ...prev,
    props,
    exec: (ctx: OpContext, p) => {
      const doc = ctx.doc;
      const target = p.target as string;
      const sel = app.selectedObjects();
      const hairs = sel.filter((o) => o.type === 'CURVES' && hairOf(doc, o));
      let n = 0;
      if (target === 'MESH' || target === 'CURVE')
        for (const ob of hairs) {
          const hc = hairOf(doc, ob)!;
          if (target === 'MESH') hairToMeshObject(doc, ob, hc, !!p.keep_original);
          else hairToCurveObject(doc, ob, hc, !!p.keep_original);
          n++;
        }
      if (target === 'CURVES') {
        for (const ob of sel) if (ob.type === 'CURVE' && curveToHairObject(doc, ob, !!p.keep_original)) n++;
        return n ? 'FINISHED' : 'CANCELLED';
      }
      // everything else goes through the regular conversion
      const rest = sel.filter((o) => !hairs.includes(o));
      if (!rest.length) return n ? 'FINISHED' : 'CANCELLED';
      if (hairs.length) for (const o of hairs) o.select = false;
      const r = prev.exec ? prev.exec(ctx, p) : 'CANCELLED';
      if (hairs.length) for (const o of hairs) o.select = true;
      return n ? 'FINISHED' : r;
    },
  });
});


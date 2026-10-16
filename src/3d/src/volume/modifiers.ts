// Volume modifiers: Mesh to Volume and Volume Displace on Volume objects, Volume to Mesh on mesh
// objects; their panels, and applying modifiers of Volume objects (the evaluated grids become
// the volume's own grids).
import { Matrix4 } from 'three';
import { app, onAppReady, operators } from '../app/app';
import { registerModifier } from '../eval/modifiers';
import { proceduralTexture } from '../eval/textures';
import type { EvalMesh, ModifierContext } from '../eval/types';
import type { ModifierBase, ObjectData } from '../data/types';
import { MeshComponent } from '../geonodes/geometry';
import { meshToEvalMesh } from '../geonodes/convert';
import { modifierExtraUI } from '../editors/properties/stack';
import { num as numProp, vecProp, enumProp, objectProp, textProp, bool } from '../ui/props';
import { textureRows, textureCoordRows } from '../editors/properties/modui/kit';
import { registerIcons } from '../ui/icons';
import { h } from '../ui/h';
import { volumeEvalMesh } from './eval';
import { volumeOf } from './data';
import { GridSampler, displaceGrid, findGrid, gridBounds, gridToMesh, makeGrid, meshToFog, mulMat4, quadsToPolys, transformGrid, triangulate, voxelSize, voxelSizeForAmount, clampVoxelSize, xform } from './grid';
import type { VolumeGrid } from './types';

registerIcons({
  // a cube turning into a puff
  mod_mesh_to_volume: '<path class="s" d="M1.5 5.5 5 3.5l3.5 2v4L5 11.5l-3.5-2z" fill="none" stroke-width="1.1" stroke-linejoin="round"/><path class="f" d="M10.4 13a1.9 1.9 0 0 1-.3-3.8 2.4 2.4 0 0 1 4.4-1A1.8 1.8 0 0 1 14 13z"/>',
  // a puff with displacement arrows
  mod_volume_displace: '<path class="f" d="M4.6 12a2.3 2.3 0 0 1-.4-4.5 2.8 2.8 0 0 1 5.3-1.3A2.2 2.2 0 0 1 12.3 8.3 2 2 0 0 1 11.7 12z"/><path class="s" d="M12 3.5h2.5V6M14.5 3.5 11.5 6.5" fill="none" stroke-width="1.1" stroke-linecap="round"/>',
  // a puff turning into a cube
  mod_volume_to_mesh: '<path class="f" d="M3.4 9a1.9 1.9 0 0 1-.3-3.8 2.4 2.4 0 0 1 4.4-1A1.8 1.8 0 0 1 7 9z"/><path class="s" d="M8.5 9.5 11.5 8l3 1.5V13l-3 1.5-3-1.5z" fill="none" stroke-width="1.1" stroke-linejoin="round"/>',
});

const num = (m: ModifierBase, k: string, d: number) => (typeof m[k] === 'number' ? (m[k] as number) : d);
const str = (m: ModifierBase, k: string, d: string) => (typeof m[k] === 'string' ? (m[k] as string) : d);

/** Matrix taking another object's local space into the owner's local space. */
function relativeMatrix(ctx: ModifierContext, otherId: string): number[] | null {
  const own = ctx.graph.get(ctx.ob.id)?.world;
  const other = ctx.graph.get(otherId)?.world;
  if (!own || !other) return null;
  return new Matrix4().copy(own).invert().multiply(other).toArray();
}

const volumeOfCtx = (ctx: ModifierContext) => volumeOf(ctx.doc, ctx.ob);

/** Evaluated mesh for new volume grids of the modifier's owner. */
function withGrids(ctx: ModifierContext, grids: VolumeGrid[]): EvalMesh {
  return volumeEvalMesh(grids, volumeOfCtx(ctx));
}

// ---------------------------------------------------------------------------
// Mesh to Volume

function meshToVolume(mesh: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const id = typeof mod.object === 'string' ? mod.object : null;
  const src = id ? ctx.graph.get(id)?.mesh : undefined;
  const rel = id ? relativeMatrix(ctx, id) : null;
  const grids = (mesh.volume ?? []).filter((g) => g.name !== 'density');
  if (!src || !rel || src.offsets.length < 2) return withGrids(ctx, mesh.volume ?? []);
  const P = new Float32Array(src.positions.length);
  const t = [0, 0, 0];
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) {
    xform(rel, src.positions[i], src.positions[i + 1], src.positions[i + 2], t);
    P[i] = t[0];
    P[i + 1] = t[1];
    P[i + 2] = t[2];
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], t[k]);
      max[k] = Math.max(max[k], t[k]);
    }
  }
  const band = Math.max(0, num(mod, 'interior_band_width', 0.2));
  let vs = str(mod, 'resolution_mode', 'VOXEL_AMOUNT') === 'VOXEL_SIZE' ? num(mod, 'voxel_size', 0.1) : voxelSizeForAmount(min, max, Math.max(1, num(mod, 'voxel_amount', 32)));
  if (!(vs > 0)) return withGrids(ctx, mesh.volume ?? []);
  vs = clampVoxelSize(min, max, vs, band + vs);
  const fog = meshToFog(P, triangulate(src.offsets, src.indices), vs, band, Math.max(0, num(mod, 'density', 1)));
  return withGrids(ctx, fog ? [fog, ...grids] : grids);
}

registerModifier({
  type: 'MESH_TO_VOLUME',
  label: 'Mesh to Volume',
  category: 'GENERATE',
  icon: 'mod_mesh_to_volume',
  objectTypes: ['VOLUME'],
  defaults: () => ({ object: null, resolution_mode: 'VOXEL_AMOUNT', voxel_size: 0.1, voxel_amount: 32, interior_band_width: 0.2, density: 1 }),
  deps: (m) => [m.object as string],
  apply: meshToVolume,
});

// ---------------------------------------------------------------------------
// Volume Displace

function volumeDisplace(mesh: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const grids = mesh.volume;
  if (!grids?.length) return mesh;
  const strength = num(mod, 'strength', 0.5);
  const midArr = Array.isArray(mod.texture_mid_level) ? (mod.texture_mid_level as number[]) : [0.5, 0.5, 0.5];
  const mid: [number, number, number] = [midArr[0] ?? 0.5, midArr[1] ?? 0.5, midArr[2] ?? 0.5];
  const radius = Math.max(0, num(mod, 'texture_sample_radius', 1));
  const tex = (mod.texture as Record<string, unknown> | null) ?? null;
  const mode = str(mod, 'texture_map_mode', 'LOCAL');
  let map: number[] | null = null;
  if (mode === 'GLOBAL') map = ctx.graph.get(ctx.ob.id)?.world.toArray() ?? null;
  else if (mode === 'OBJECT' && typeof mod.texture_map_object === 'string') {
    const own = ctx.graph.get(ctx.ob.id)?.world;
    const other = ctx.graph.get(mod.texture_map_object)?.world;
    if (own && other) map = new Matrix4().copy(other).invert().multiply(own).toArray();
  }
  const q = [0, 0, 0];
  const sample = (x: number, y: number, z: number): [number, number, number] => {
    if (!tex?.type) return [1, 1, 1];
    if (map) {
      xform(map, x, y, z, q);
      x = q[0];
      y = q[1];
      z = q[2];
    }
    const v = proceduralTexture(tex, x, y, z);
    return [v, v, v];
  };
  // the sample radius limits how far displaced values can come from (grid growth)
  const out = grids.map((g) => {
    const d = displaceGrid(g, sample, strength * Math.min(1, radius > 0 ? 1 : 0), mid);
    return radius < 1 ? clipGrowth(d, g, radius) : d;
  });
  return withGrids(ctx, out);
}

/** Crop a displaced grid's growth to a fraction of the full margin. */
function clipGrowth(d: VolumeGrid, g: VolumeGrid, frac: number): VolumeGrid {
  const gx = (d.dims[0] - g.dims[0]) / 2,
    gy = (d.dims[1] - g.dims[1]) / 2,
    gz = (d.dims[2] - g.dims[2]) / 2;
  const kx = Math.round(gx * frac),
    ky = Math.round(gy * frac),
    kz = Math.round(gz * frac);
  const dims: [number, number, number] = [g.dims[0] + 2 * kx, g.dims[1] + 2 * ky, g.dims[2] + 2 * kz];
  const ch = d.values.length / (d.dims[0] * d.dims[1] * d.dims[2]);
  const vals = new Float32Array(dims[0] * dims[1] * dims[2] * ch);
  const ox = gx - kx,
    oy = gy - ky,
    oz = gz - kz;
  for (let k = 0; k < dims[2]; k++)
    for (let j = 0; j < dims[1]; j++)
      for (let i = 0; i < dims[0]; i++) {
        const s = (((k + oz) * d.dims[1] + j + oy) * d.dims[0] + i + ox) * ch,
          o = ((k * dims[1] + j) * dims[0] + i) * ch;
        for (let c = 0; c < ch; c++) vals[o + c] = d.values[s + c];
      }
  return { ...d, dims, values: vals, transform: mulMat4(d.transform, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ox, oy, oz, 1]) };
}

registerModifier({
  type: 'VOLUME_DISPLACE',
  label: 'Volume Displace',
  category: 'DEFORM',
  icon: 'mod_volume_displace',
  objectTypes: ['VOLUME'],
  defaults: () => ({ texture: null, texture_map_mode: 'LOCAL', texture_map_object: null, strength: 0.5, texture_mid_level: [0.5, 0.5, 0.5], texture_sample_radius: 1 }),
  deps: (m) => [m.texture_map_object as string],
  apply: volumeDisplace,
});

// ---------------------------------------------------------------------------
// Volume to Mesh

/** Resample a grid at another voxel size (same region). */
function resample(g: VolumeGrid, vs: number): VolumeGrid {
  const b = gridBounds(g);
  vs = clampVoxelSize(b.min, b.max, vs);
  const dims: [number, number, number] = [0, 1, 2].map((k) => Math.max(2, Math.round((b.max[k] - b.min[k]) / vs))) as [number, number, number];
  const out = makeGrid(g.name, dims, vs, [b.min[0] + vs / 2, b.min[1] + vs / 2, b.min[2] + vs / 2], 'FLOAT', g.grid_class);
  out.background = g.background;
  const s = new GridSampler(g);
  const p = [0, 0, 0];
  let i = 0;
  for (let k = 0; k < dims[2]; k++)
    for (let j = 0; j < dims[1]; j++)
      for (let a = 0; a < dims[0]; a++, i++) {
        xform(out.transform, a, j, k, p);
        out.values[i] = s.sample(p[0], p[1], p[2]);
      }
  return out;
}

/** Mesh of a grid's iso surface as an evaluated mesh (in the grid's space). */
export function gridSurface(g: VolumeGrid, threshold: number, adaptivity: number, smooth: boolean): EvalMesh {
  const level = g.grid_class === 'LEVEL_SET';
  const m = gridToMesh(g, level ? 0 : threshold, level, adaptivity);
  const { offsets, indices } = quadsToPolys(m.quads);
  const attrs = new Map();
  if (!smooth) attrs.set('sharp_face', { domain: 'FACE', type: 'BOOLEAN', data: new Uint8Array(offsets.length - 1).fill(1) });
  return meshToEvalMesh(new MeshComponent(m.positions, offsets, indices, new Uint32Array(0), attrs));
}

function volumeToMesh(mesh: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const id = typeof mod.object === 'string' ? mod.object : null;
  const grids = id ? ctx.graph.get(id)?.mesh?.volume : undefined;
  const rel = id ? relativeMatrix(ctx, id) : null;
  if (!grids?.length || !rel) return mesh;
  let g = findGrid(grids, str(mod, 'grid_name', 'density'), false);
  if (!g) throw new Error(`grid "${str(mod, 'grid_name', 'density')}" not found`);
  const mode = str(mod, 'resolution_mode', 'GRID');
  if (mode === 'VOXEL_SIZE') g = resample(g, Math.max(1e-4, num(mod, 'voxel_size', 0.1)));
  else if (mode === 'VOXEL_AMOUNT') {
    const b = gridBounds(g);
    g = resample(g, voxelSizeForAmount(b.min, b.max, Math.max(1, num(mod, 'voxel_amount', 32))) || voxelSize(g)[0]);
  }
  g = transformGrid(g, rel);
  return gridSurface(g, num(mod, 'threshold', 0.1), Math.min(1, Math.max(0, num(mod, 'adaptivity', 0))), !!mod.use_smooth_shade);
}

registerModifier({
  type: 'VOLUME_TO_MESH',
  label: 'Volume to Mesh',
  category: 'GENERATE',
  icon: 'mod_volume_to_mesh',
  objectTypes: ['MESH'],
  defaults: () => ({ object: null, threshold: 0.1, adaptivity: 0, use_smooth_shade: false, grid_name: 'density', resolution_mode: 'GRID', voxel_size: 0.1, voxel_amount: 32 }),
  deps: (m) => [m.object as string],
  apply: volumeToMesh,
});

// ---------------------------------------------------------------------------
// Panels

type Rec = Record<string, unknown>;
const objRow = (ob: ObjectData, m: ModifierBase, label: string, type: string) => objectProp(m as Rec, 'object', label, { filter: (o) => o.id !== ob.id && o.type === type, undo: `Set ${label}` });

modifierExtraUI.MESH_TO_VOLUME = (ob, m) => {
  const r = m as Rec;
  const bySize = r.resolution_mode === 'VOXEL_SIZE';
  return [
    objRow(ob, m, 'Object', 'MESH'),
    numProp(r, 'density', 'Density', { min: 0 }),
    h('div', { class: 'sub-label' }, 'Resolution'),
    enumProp(r, 'resolution_mode', 'Resolution Mode', [
      ['VOXEL_AMOUNT', 'Voxel Amount'],
      ['VOXEL_SIZE', 'Voxel Size'],
    ]),
    bySize ? numProp(r, 'voxel_size', 'Voxel Size', { unit: 'distance', min: 0.0001 }) : numProp(r, 'voxel_amount', 'Voxel Amount', { int: true, min: 1, max: 512, tip: 'Voxels across the diagonal of the mesh bounds' }),
    numProp(r, 'interior_band_width', 'Interior Band Width', { unit: 'distance', min: 0, tip: 'Distance over which the density fades in from the surface' }),
  ];
};

modifierExtraUI.VOLUME_TO_MESH = (ob, m) => {
  const r = m as Rec;
  const mode = r.resolution_mode;
  return [
    objRow(ob, m, 'Object', 'VOLUME'),
    textProp(r, 'grid_name', 'Grid Name'),
    h('div', { class: 'sub-label' }, 'Resolution'),
    enumProp(r, 'resolution_mode', 'Resolution Mode', [
      ['GRID', 'Grid'],
      ['VOXEL_AMOUNT', 'Voxel Amount'],
      ['VOXEL_SIZE', 'Voxel Size'],
    ]),
    mode === 'VOXEL_AMOUNT' ? numProp(r, 'voxel_amount', 'Voxel Amount', { int: true, min: 1, max: 512 }) : null,
    mode === 'VOXEL_SIZE' ? numProp(r, 'voxel_size', 'Voxel Size', { unit: 'distance', min: 0.0001 }) : null,
    h('div', { class: 'sub-label' }, 'Thresholds'),
    numProp(r, 'threshold', 'Threshold', { min: 0, tip: 'Values above this are inside the surface (distance grids use 0)' }),
    numProp(r, 'adaptivity', 'Adaptivity', { min: 0, max: 1, slider: true, tip: 'Merge polygons in flat areas' }),
    bool(r, 'use_smooth_shade', 'Smooth Shading'),
  ];
};

modifierExtraUI.VOLUME_DISPLACE = (ob, m) => {
  const r = m as Rec;
  return [
    ...textureRows(m, 'texture'),
    ...textureCoordRows(m, 'texture_map_mode', 'texture_map_object', ob),
    numProp(r, 'strength', 'Strength'),
    numProp(r, 'texture_sample_radius', 'Sample Radius', { min: 0, max: 1, slider: true, tip: 'How far around a voxel displaced values are gathered from (smaller is faster but can cut the volume off)' }),
    vecProp(r, 'texture_mid_level', 'Mid Level', {}),
  ];
};

// ---------------------------------------------------------------------------
// Applying modifiers of Volume objects writes the evaluated grids into the volume

onAppReady(() => {
  const op = operators.get('object.modifier_apply');
  if (!op?.exec) return;
  const orig = op.exec;
  const poll = op.poll;
  op.poll = (ctx) => (app.activeObject?.type === 'VOLUME' ? app.doc.mode === 'OBJECT' && !!app.activeObject.modifiers.length : poll ? poll(ctx) : true);
  op.exec = (ctx, p) => {
    const ob = app.activeObject;
    const vo = volumeOf(ctx.doc, ob);
    if (!ob || !vo) return orig(ctx, p);
    const id = String(p.modifier ?? '');
    const target = ob.modifiers.find((m) => m.id === id || m.name === id) ?? ob.modifiers.find((m) => m.is_active) ?? ob.modifiers[0];
    if (!target) return 'CANCELLED';
    // evaluate the stack up to and including the modifier
    const keep = ob.modifiers;
    ob.modifiers = keep.slice(0, keep.indexOf(target) + 1);
    app.graph.invalidate(ob.id);
    app.graph.evaluate(ctx.doc);
    const grids = app.graph.get(ob.id)?.mesh?.volume ?? vo.grids;
    ob.modifiers = keep.filter((m) => m !== target);
    vo.grids = grids;
    vo.active_grid_index = Math.min(vo.active_grid_index, Math.max(0, grids.length - 1));
    app.graph.invalidate(ob.id);
    app.report('INFO', `Applied modifier: ${target.name}`);
  };
});

// Volume objects take modifiers too (Mesh to Volume, Volume Displace, geometry nodes)
onAppReady(() => {
  const op = operators.get('object.modifier_add');
  if (!op) return;
  const poll = op.poll;
  op.poll = (ctx) => app.activeObject?.type === 'VOLUME' || app.activeObject?.type === 'POINTCLOUD' || (poll ? poll(ctx) : true);
});

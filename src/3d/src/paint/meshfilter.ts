// Mesh Filter: deform the whole (unmasked, visible) mesh with a filter; interactive strength by
// dragging left / right (tool or menu), exact values in Adjust Last Operation.
import { Matrix3, Matrix4, Vector3 } from 'three';
import { app, registerOperators } from '../app/app';
import { cow } from '../data/cow';
import type { MeshData } from '../data/types';
import { h, type Child } from '../ui/h';
import { checkbox, enumMenu, numberField } from '../ui/widgets';
import { toolSettingsRenderers } from '../editors/view3d/toolbar';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { activeMeshData, beginGeometryStroke, meshSession, reevaluate, type MeshSession } from './session';
import { applyMeshFilter, type FilterMesh, type MeshFilterType } from './filters';
import { faceSetBoundaryVerts } from './fsdata';
import { finishDeform } from './gestureops';
import { sculptPoll } from './facesetops';
import { meshFilterTool, sculptToolHooks } from './sculpttools';

export const FILTER_TYPES: [MeshFilterType, string, string][] = [
  ['SMOOTH', 'Smooth', 'Smooth the mesh'],
  ['SCALE', 'Scale', 'Scale the mesh'],
  ['INFLATE', 'Inflate', 'Inflate the mesh along the vertex normals'],
  ['SPHERE', 'Sphere', 'Morph the mesh into a sphere'],
  ['RANDOM', 'Random', 'Randomize the vertex positions along their normals'],
  ['RELAX', 'Relax', 'Even out the topology without changing the shape much'],
  ['RELAX_FACE_SETS', 'Relax Face Sets', 'Smooth the borders between face sets'],
  ['SURFACE_SMOOTH', 'Surface Smooth', 'Smooth while keeping the volume'],
  ['SHARPEN', 'Sharpen', 'Sharpen the cavities of the mesh'],
  ['ENHANCE_DETAILS', 'Enhance Details', 'Amplify the high frequency detail'],
];

/** Settings of the Mesh Filter tool. */
export const meshFilterSettings = {
  type: 'INFLATE' as MeshFilterType,
  strength: 1,
  deform_axis: [true, true, true] as [boolean, boolean, boolean],
  orientation: 'LOCAL' as 'LOCAL' | 'WORLD' | 'VIEW',
};

function filterMesh(s: MeshSession, me: MeshData, orig: Float32Array, type: string): FilterMesh {
  const nb = s.neighbors;
  // normals of the original shape (the session normals follow the live positions)
  const normals = s.vn.slice();
  return {
    orig,
    normals,
    nbOffsets: nb.offsets,
    nb: nb.neighbors,
    mask: me.sculpt_mask && me.sculpt_mask.length === s.nv ? me.sculpt_mask : null,
    hidden: s.hiddenV,
    fsBoundary: type === 'RELAX_FACE_SETS' ? faceSetBoundaryVerts(me) : null,
  };
}

/** Rows: the deformation axes of the orientation, in object space. */
function orientationFrame(s: MeshSession, orientation: string, v: View3D | null): number[] | undefined {
  if (orientation === 'LOCAL') return undefined;
  const inv = new Matrix3().setFromMatrix4(new Matrix4().copy(s.world()).invert());
  const axes =
    orientation === 'VIEW' && v
      ? [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)].map((a) => a.transformDirection(v.camera.matrixWorld))
      : [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  const out: number[] = [];
  for (const a of axes) {
    const l = a.applyMatrix3(inv).normalize();
    out.push(l.x, l.y, l.z);
  }
  return out;
}

function params(p: Record<string, unknown>, s: MeshSession, v: View3D | null) {
  return {
    type: p.type as MeshFilterType,
    strength: p.strength as number,
    axes: [!!(p.deform_axis as boolean[])[0], !!(p.deform_axis as boolean[])[1], !!(p.deform_axis as boolean[])[2]] as [boolean, boolean, boolean],
    frame: orientationFrame(s, p.orientation as string, v),
    seed: p.seed as number,
    shapePreservation: p.surface_smooth_shape_preservation as number,
    currentDisplacement: p.surface_smooth_current_vertex as number,
  };
}

/** Write filtered positions into the live session (preview while dragging). */
function preview(s: MeshSession, me: MeshData, res: Float32Array, lastEval: { t: number }) {
  s.positions.set(res);
  s.recomputeNormals();
  if (s.direct) {
    const all: number[] = [];
    for (let f = 0; f < s.nf; f++) all.push(f);
    s.writeFaces(all, me.smooth);
    s.flush();
  } else {
    const now = performance.now();
    if (now - lastEval.t > 40) {
      lastEval.t = now;
      reevaluate(s);
    }
  }
}

function startFilter(v: View3D, p: Record<string, unknown>, start?: PointerEvent): 'RUNNING_MODAL' | 'CANCELLED' {
  const am = activeMeshData();
  const s = meshSession();
  if (!am || !s || app.modal) return 'CANCELLED';
  const { me } = am;
  const old = me.positions;
  beginGeometryStroke(s, me, () => cow(me, 'positions'));
  const orig = old !== me.positions ? old : me.positions.slice();
  const fm = filterMesh(s, me, orig, p.type as string);
  const x0 = start ? start.clientX : app.pointer.x;
  const scale = (p.strength as number) || 1;
  const lastEval = { t: 0 };
  let done = false;
  const update = (x: number) => {
    // 200 px of horizontal drag = strength 1 (times the tool strength)
    p.strength = Math.round(((x - x0) / 200) * scale * 1000) / 1000;
    preview(s, me, applyMeshFilter(fm, params(p, s, v)), lastEval);
  };
  const label = FILTER_TYPES.find((t) => t[0] === p.type)?.[1] ?? 'Filter';
  app.startModal({
    label: 'Filter Mesh',
    cursor: 'ew-resize',
    onPointerMove: (e) => update(e.clientX),
    onPointerDown: (e) => (e.button === 2 ? 'CANCELLED' : start ? undefined : 'FINISHED'),
    onPointerUp: (e) => (start && e.button === 0 ? 'FINISHED' : undefined),
    onKey: (e) => {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      return true;
    },
    cancel: () => {
      if (done) return;
      preview(s, me, orig, { t: 0 });
      s.finishGeometry();
      if (!s.direct) reevaluate(s);
    },
    finish: () => {
      done = true;
      finishDeform(s, me, null);
    },
    header: () => `Mesh Filter (${label}): move left / right to set the strength ${(p.strength as number).toFixed(3)}, click or Enter to apply, Esc / right-click to cancel`,
    redoOp: { idname: 'sculpt.mesh_filter', props: p },
  });
  void h;
  return 'RUNNING_MODAL';
}

registerOperators([
  {
    idname: 'sculpt.mesh_filter',
    label: 'Filter Mesh',
    description: 'Deform the whole unmasked mesh with a filter',
    props: [
      { id: 'type', label: 'Filter Type', type: 'enum', default: 'INFLATE', items: FILTER_TYPES },
      { id: 'strength', label: 'Strength', type: 'float', default: 1, min: -10, max: 10, softMin: -2, softMax: 2 },
      { id: 'deform_axis', label: 'Deform Axis', type: 'bools', default: [true, true, true] },
      {
        id: 'orientation',
        label: 'Orientation',
        type: 'enum',
        default: 'LOCAL',
        items: [
          ['LOCAL', 'Local', 'Use the object axes'],
          ['WORLD', 'World', 'Use the world axes'],
          ['VIEW', 'View', 'Use the view axes'],
        ],
      },
      { id: 'seed', label: 'Seed', type: 'int', default: 0, min: 0, max: 10000, showIf: (p) => p.type === 'RANDOM' },
      { id: 'surface_smooth_shape_preservation', label: 'Shape Preservation', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor', showIf: (p) => p.type === 'SURFACE_SMOOTH' },
      { id: 'surface_smooth_current_vertex', label: 'Per Vertex Displacement', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor', showIf: (p) => p.type === 'SURFACE_SMOOTH' },
    ],
    poll: sculptPoll,
    invoke: (_ctx, p) => {
      const v = activeView3D();
      return v ? startFilter(v, p) : 'CANCELLED';
    },
    exec: (_ctx, p) => {
      const am = activeMeshData();
      const s = meshSession();
      if (!am || !s) return 'CANCELLED';
      const { me } = am;
      beginGeometryStroke(s, me, () => cow(me, 'positions'));
      const fm = filterMesh(s, me, me.positions.slice(), p.type as string);
      s.positions.set(applyMeshFilter(fm, params(p, s, activeView3D())));
      finishDeform(s, me, null);
    },
  },
]);

// ---------------------------------------------------------------------------
// tool

sculptToolHooks.pointer.push((v, e, tool) => {
  if (tool !== meshFilterTool.id) return false;
  const st = meshFilterSettings;
  startFilter(v, { type: st.type, strength: st.strength, deform_axis: [...st.deform_axis], orientation: st.orientation, seed: Math.floor(Math.random() * 10000), surface_smooth_shape_preservation: 0.5, surface_smooth_current_vertex: 0.5 }, e);
  return true;
});

toolSettingsRenderers[meshFilterTool.id] = (): Child => {
  const st = meshFilterSettings;
  const ch = () => app.changed('ui');
  const box = (w: number, c: Child) => h('div', { style: { width: `${w}px`, flex: 'none' } }, c);
  return [
    box(
      140,
      enumMenu(
        'th-mf-type',
        FILTER_TYPES.map(([value, label]) => ({ value, label })),
        st.type,
        (x) => ((st.type = x as MeshFilterType), ch()),
        { tip: 'Filter to apply' },
      ),
    ),
    box(140, numberField({ id: 'th-mf-str', label: 'Strength', value: st.strength, min: -10, max: 10, softMin: -2, softMax: 2, slider: false, tip: 'Multiplier for the drag distance', set: (x) => ((st.strength = x), ch()) })),
    h('span', { class: 'th-label' }, 'Deform Axis'),
    ...(['X', 'Y', 'Z'] as const).map((a, i) => checkbox(`th-mf-ax${a}`, a, st.deform_axis[i], (x) => ((st.deform_axis[i] = x), ch()))),
    box(
      100,
      enumMenu(
        'th-mf-orient',
        [
          { value: 'LOCAL', label: 'Local' },
          { value: 'WORLD', label: 'World' },
          { value: 'VIEW', label: 'View' },
        ],
        st.orientation,
        (x) => ((st.orientation = x as 'LOCAL'), ch()),
        { tip: 'Orientation of the deform axes' },
      ),
    ),
    h('span', { class: 'th-label' }, 'Drag left / right'),
  ];
};

// Clean Up operators (Draw and Edit Mode): loose points, duplicate keyframes, merge by distance,
// reproject. In Edit Mode they act on the selection, in Draw Mode on every editable stroke.
import { Vector3, Raycaster, Matrix4, Plane, Ray, Euler, type Mesh as ThreeMesh } from 'three';
import { app, registerOperators } from '../app/app';
import { activeView3D } from '../editors/view3d/view3d';
import { renderContext } from '../render/context';
import { gpOf, frameAt, toStrokes, fromStrokes, compactDrawings, normalizeDrawing, type GPPoint, type GPStroke } from './data';
import { editTargets, inGPEdit, type EditTarget } from './edit';
import { layerMatrix } from './render';
import type { GPDrawing, GPLayer } from './types';

// ---------------------------------------------------------------------------
// kernels (pure)

/** Strokes with at most `limit` points are removed (only strokes passing `consider`). */
export function cleanLoose(strokes: GPStroke[], limit: number, consider: (s: GPStroke) => boolean = () => true): GPStroke[] {
  return strokes.filter((s) => !consider(s) || s.points.length > limit);
}

/** Consecutive points closer than `threshold` to the first of their run collapse to the run's average. */
export function mergeByDistance(points: GPPoint[], threshold: number, consider: (p: GPPoint) => boolean = () => true): GPPoint[] {
  const out: GPPoint[] = [];
  let i = 0;
  const d = (a: GPPoint, b: GPPoint) => Math.hypot(a.co[0] - b.co[0], a.co[1] - b.co[1], a.co[2] - b.co[2]);
  while (i < points.length) {
    const first = points[i];
    let j = i + 1;
    if (consider(first)) while (j < points.length && consider(points[j]) && d(first, points[j]) < threshold) j++;
    if (j - i === 1) out.push(first);
    else {
      const run = points.slice(i, j);
      const avg = (f: (p: GPPoint) => number) => run.reduce((a, p) => a + f(p), 0) / run.length;
      out.push({
        ...first,
        co: [avg((p) => p.co[0]), avg((p) => p.co[1]), avg((p) => p.co[2])],
        radius: avg((p) => p.radius),
        opacity: avg((p) => p.opacity),
        vertex_color: [0, 1, 2, 3].map((k) => avg((p) => p.vertex_color[k])) as GPPoint['vertex_color'],
      });
    }
    i = j;
  }
  return out;
}

/** True when two drawings hold the same strokes. */
export function sameDrawing(a: GPDrawing, b: GPDrawing): boolean {
  if (a === b) return true;
  const keys: (keyof GPDrawing)[] = ['position', 'radius', 'opacity', 'vertex_color', 'offsets', 'cyclic', 'material_index', 'start_cap', 'end_cap', 'fill_color', 'fill_opacity', 'fill_id'];
  for (const k of keys) {
    const x = a[k] as ArrayLike<number> | undefined,
      y = b[k] as ArrayLike<number> | undefined;
    if (!x || !y) {
      if ((x?.length ?? 0) !== (y?.length ?? 0)) return false;
      continue;
    }
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i] - y[i]) > 1e-6) return false;
  }
  return true;
}

/** Remove keyframes whose drawing repeats the previous key's; returns the removed count. */
export function cleanDuplicateFrames(layer: GPLayer, drawings: GPDrawing[], onlySelected = false): number {
  const keep = [];
  let removed = 0;
  for (const f of layer.frames) {
    const prev = keep[keep.length - 1];
    if (prev && (!onlySelected || f.select) && drawings[prev.drawing] && drawings[f.drawing] && sameDrawing(normalizeDrawing(drawings[prev.drawing]), normalizeDrawing(drawings[f.drawing]))) {
      removed++;
      continue;
    }
    keep.push(f);
  }
  layer.frames = keep;
  return removed;
}

// ---------------------------------------------------------------------------
// targets

/** Drawings the clean up operators work on: Edit Mode targets, or the current keys in Draw / Sculpt Mode. */
export function strokeTargets(): EditTarget[] {
  if (inGPEdit()) return editTargets();
  const ob = app.activeObject;
  const gp = gpOf(app.doc, ob);
  if (!ob || !gp) return [];
  const obWorld = app.graph.get(ob.id)?.world ?? new Matrix4();
  const out: EditTarget[] = [];
  gp.layers.forEach((layer, li) => {
    if (layer.hide || layer.lock) return;
    const fr = frameAt(layer, app.doc.scene.frame_current);
    if (fr && gp.drawings[fr.drawing]) out.push({ layer, layerIndex: li, idx: fr.drawing, world: obWorld.clone().multiply(layerMatrix(layer)) });
  });
  return out;
}

const pollAny = () => {
  const m = app.doc.mode;
  return !!gpOf(app.doc, app.activeObject) && (m === 'EDIT' || m === 'PAINT_GREASE_PENCIL' || m === 'SCULPT_GREASE_PENCIL');
};

function mapTargets(fn: (strokes: GPStroke[], t: EditTarget) => GPStroke[] | null): boolean {
  const gp = gpOf(app.doc, app.activeObject)!;
  let changed = false;
  for (const t of strokeTargets()) {
    const out = fn(toStrokes(normalizeDrawing(gp.drawings[t.idx])), t);
    if (out) {
      gp.drawings[t.idx] = fromStrokes(out);
      changed = true;
    }
  }
  return changed;
}

const useSel = () => inGPEdit();
const strokeSelected = (s: GPStroke) => !useSel() || s.points.some((p) => p.select);

// ---------------------------------------------------------------------------
// reprojection

export type ReprojectType = 'FRONT' | 'SIDE' | 'TOP' | 'VIEW' | 'SURFACE' | 'CURSOR';

function surfaceMeshes(): ThreeMesh[] {
  const out: ThreeMesh[] = [];
  for (const so of renderContext?.sync.objects.values() ?? []) if (so.mesh && so.root.visible && so.ev.ob.type === 'MESH') out.push(so.mesh);
  return out;
}

registerOperators([
  {
    idname: 'grease_pencil.clean_loose',
    label: 'Clean Loose Points',
    description: 'Remove strokes that have too few points',
    props: [{ id: 'limit', label: 'Limit', type: 'int', default: 1, min: 1, max: 100 }],
    poll: pollAny,
    exec: (_c, p) => {
      if (!mapTargets((ss) => {
        const out = cleanLoose(ss, p.limit as number, strokeSelected);
        return out.length === ss.length ? null : out;
      }))
        return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.frame_clean_duplicate',
    label: 'Delete Duplicate Frames',
    description: 'Remove keyframes that repeat the drawing of the key before them',
    props: [{ id: 'selected', label: 'Selected', type: 'bool', default: false }],
    poll: pollAny,
    exec: (_c, p) => {
      const gp = gpOf(app.doc, app.activeObject)!;
      let n = 0;
      for (const l of gp.layers) if (!l.lock) n += cleanDuplicateFrames(l, gp.drawings, !!p.selected);
      if (!n) {
        app.report('INFO', 'No duplicate frames found');
        return 'CANCELLED';
      }
      compactDrawings(gp);
      app.report('INFO', `Deleted ${n} duplicate frame${n === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'grease_pencil.stroke_merge_by_distance',
    label: 'Merge by Distance',
    description: 'Merge points that are closer together than the threshold',
    props: [
      { id: 'threshold', label: 'Threshold', type: 'float', default: 0.001, min: 0, max: 100, subtype: 'distance', precision: 4 },
      { id: 'use_unselected', label: 'Unselected', type: 'bool', default: false },
    ],
    poll: pollAny,
    exec: (_c, p) => {
      const all = !useSel() || !!p.use_unselected;
      if (!mapTargets((ss) => {
        let changed = false;
        const out = ss.map((s) => {
          const pts = mergeByDistance(s.points, p.threshold as number, (pt) => all || !!pt.select);
          if (pts.length !== s.points.length) changed = true;
          return { ...s, points: pts };
        });
        return changed ? out : null;
      }))
        return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.reproject',
    label: 'Reproject Strokes',
    description: 'Project the strokes onto a plane or onto surfaces, as seen from the current view',
    props: [
      {
        id: 'type',
        label: 'Projection Type',
        type: 'enum',
        default: 'VIEW',
        items: [
          ['FRONT', 'Front', 'Flatten onto the front (X-Z) plane'],
          ['SIDE', 'Side', 'Flatten onto the side (Y-Z) plane'],
          ['TOP', 'Top', 'Flatten onto the top (X-Y) plane'],
          ['VIEW', 'View', 'Flatten onto the view plane through the object origin'],
          ['SURFACE', 'Surface', 'Project onto the surfaces under the strokes'],
          ['CURSOR', 'Cursor', 'Flatten onto the 3D cursor plane'],
        ],
      },
      { id: 'keep_original', label: 'Keep Original', type: 'bool', default: false },
      { id: 'offset', label: 'Surface Offset', type: 'float', default: 0, min: 0, max: 10, subtype: 'distance', showIf: (q) => q.type === 'SURFACE' },
    ],
    poll: pollAny,
    exec: (_c, p) => {
      const v = activeView3D();
      const type = p.type as ReprojectType;
      if (!v) return 'CANCELLED';
      const ob = app.activeObject!;
      const obWorld = app.graph.get(ob.id)?.world ?? new Matrix4();
      const cursor = app.doc.scene.cursor;
      const viewDir = new Vector3(0, 0, -1).applyQuaternion(v.camera.quaternion);
      const normal =
        type === 'FRONT'
          ? new Vector3(0, 1, 0)
          : type === 'SIDE'
            ? new Vector3(1, 0, 0)
            : type === 'TOP'
              ? new Vector3(0, 0, 1)
              : type === 'CURSOR'
                ? new Vector3(0, 0, 1).applyEuler(new Euler(...cursor.rotation_euler, 'XYZ'))
                : viewDir.clone().negate();
      const plane = new Plane().setFromNormalAndCoplanarPoint(normal.normalize(), type === 'CURSOR' ? new Vector3(...cursor.location) : new Vector3().setFromMatrixPosition(obWorld));
      const meshes = type === 'SURFACE' ? surfaceMeshes() : [];
      const ray = new Raycaster();
      const w = new Vector3();
      /** where a world point lands: along its view ray (VIEW / SURFACE) or straight onto the plane */
      const land = (pt: Vector3): Vector3 | null => {
        if (type !== 'VIEW' && type !== 'SURFACE') return plane.projectPoint(pt, new Vector3());
        const s = v.project(pt);
        const { origin, dir } = v.ray(s.x, s.y);
        if (type === 'SURFACE') {
          ray.set(origin, dir);
          const h = ray.intersectObjects(meshes, false)[0];
          if (h) return h.point.clone().addScaledVector(dir, -Math.max(p.offset as number, 1e-4));
          return null;
        }
        return new Ray(origin, dir).intersectPlane(plane, new Vector3());
      };
      const moved = mapTargets((ss, t) => {
        const inv = t.world.clone().invert();
        const sel = ss.map(strokeSelected);
        if (!sel.some(Boolean)) return null;
        const out = ss.map((s, si) =>
          !sel[si]
            ? s
            : {
                ...s,
                points: s.points.map((pt) => {
                  if (useSel() && !pt.select) return pt;
                  const hit = land(w.set(...pt.co).applyMatrix4(t.world));
                  if (!hit) return pt;
                  const q = hit.applyMatrix4(inv);
                  return { ...pt, co: [q.x, q.y, q.z] as [number, number, number] };
                }),
              },
        );
        return p.keep_original ? [...ss.map((s) => ({ ...s, points: s.points.map((q) => ({ ...q, select: false })) })), ...out.filter((_, i) => sel[i])] : out;
      });
      if (!moved) return 'CANCELLED';
    },
  },
]);

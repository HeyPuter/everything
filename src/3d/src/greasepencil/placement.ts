// Stroke placement: where screen positions land in 3D while drawing.
//   Placement (tool_settings.gpencil_stroke_placement_view3d): Origin / 3D Cursor / Surface / Stroke
//   Drawing plane (lock axis): View / Front (X-Z) / Side (Y-Z) / Top (X-Y) / Cursor
import { Matrix4, Vector3, Raycaster, Euler, Quaternion, type Mesh } from 'three';
import { app } from '../app/app';
import type { ObjectData } from '../data/types';
import type { View3D } from '../editors/view3d/view3d';
import { renderContext } from '../render/context';
import { gpTS, frameAt } from './data';
import { layerMatrix } from './render';
import type { GPLayer, GreasePencilData } from './types';

export class Placement {
  /** world → layer space */
  inv: Matrix4;
  /** layer → world */
  world: Matrix4;
  planePoint: Vector3;
  planeNormal: Vector3;
  mode: string;
  private ray = new Raycaster();
  private meshes: Mesh[] | null = null;

  constructor(
    public v: View3D,
    public ob: ObjectData,
    public gp: GreasePencilData,
    public layer: GPLayer | null,
  ) {
    const doc = app.doc;
    const ts = gpTS(doc);
    const obWorld = app.graph.get(ob.id)?.world ?? new Matrix4();
    this.world = layer ? obWorld.clone().multiply(layerMatrix(layer)) : obWorld.clone();
    this.inv = this.world.clone().invert();
    this.mode = ts.gpencil_stroke_placement_view3d;
    const cursor = doc.scene.cursor;
    this.planePoint = this.mode === 'CURSOR' ? new Vector3(...cursor.location) : new Vector3().setFromMatrixPosition(obWorld);
    const viewDir = new Vector3(0, 0, -1).applyQuaternion(v.camera.quaternion);
    switch (ts.gpencil_lock_axis) {
      case 'VIEW':
        this.planeNormal = viewDir.clone().negate();
        break;
      case 'AXIS_X':
        this.planeNormal = new Vector3(1, 0, 0);
        break;
      case 'AXIS_Z':
        this.planeNormal = new Vector3(0, 0, 1);
        break;
      case 'CURSOR':
        this.planeNormal = new Vector3(0, 0, 1).applyQuaternion(new Quaternion().setFromEuler(new Euler(...cursor.rotation_euler, 'XYZ')));
        break;
      default:
        this.planeNormal = new Vector3(0, 1, 0);
    }
    // a plane seen edge-on cannot be drawn on: fall back to the view plane
    if (Math.abs(this.planeNormal.dot(viewDir)) < 0.05) this.planeNormal = viewDir.clone().negate();
  }

  /**
   * Projected pixels: a live stroke re-places all its samples on every update, and Surface / Stroke
   * placement cost a raycast / a scan of the drawing per sample.
   */
  private memo = new Map<string, Vector3 | null>();

  /** World position for a viewport pixel. */
  project(x: number, y: number): Vector3 | null {
    const key = `${x},${y}`;
    let p = this.memo.get(key);
    if (p === undefined) {
      if (this.memo.size > 100000) this.memo.clear();
      p = this.place(x, y);
      this.memo.set(key, p);
    }
    return p ? p.clone() : null;
  }

  private place(x: number, y: number): Vector3 | null {
    const { origin, dir } = this.v.ray(x, y);
    if (this.mode === 'SURFACE') {
      const hit = this.surface(origin, dir);
      if (hit) return hit;
    }
    if (this.mode === 'STROKE') {
      const p = this.strokeDepth(x, y);
      if (p) return this.v.unproject(x, y, p);
    }
    const denom = dir.dot(this.planeNormal);
    if (Math.abs(denom) < 1e-8) return this.v.unproject(x, y, this.planePoint);
    const t = this.planePoint.clone().sub(origin).dot(this.planeNormal) / denom;
    if (t < 0 && !(this.v.camera as { isOrthographicCamera?: boolean }).isOrthographicCamera) return this.v.unproject(x, y, this.planePoint);
    return origin.clone().addScaledVector(dir, t);
  }

  private surface(origin: Vector3, dir: Vector3): Vector3 | null {
    if (!this.meshes) {
      this.meshes = [];
      for (const so of renderContext?.sync.objects.values() ?? []) if (so.mesh && so.root.visible && so.ev.ob.type === 'MESH') this.meshes.push(so.mesh);
    }
    this.ray.set(origin, dir);
    const hits = this.ray.intersectObjects(this.meshes, false);
    if (!hits.length) return null;
    const off = gpTS(app.doc).gpencil_surface_offset * 0.01;
    return hits[0].point.clone().addScaledVector(dir, -Math.max(off, 1e-4));
  }

  /** Depth of the nearest existing stroke point under the cursor (Stroke placement). */
  private strokeDepth(x: number, y: number): Vector3 | null {
    let best: Vector3 | null = null,
      bd = 24;
    const frame = app.doc.scene.frame_current;
    for (const l of this.gp.layers) {
      if (l.hide) continue;
      const fr = frameAt(l, frame);
      const d = fr ? this.gp.drawings[fr.drawing] : null;
      if (!d) continue;
      const m = (app.graph.get(this.ob.id)?.world ?? new Matrix4()).clone().multiply(layerMatrix(l));
      const p = new Vector3();
      for (let i = 0; i < d.position.length / 3; i++) {
        p.set(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]).applyMatrix4(m);
        const s = this.v.project(p);
        const dd = Math.hypot(s.x - x, s.y - y);
        if (dd < bd) {
          bd = dd;
          best = p.clone();
        }
      }
    }
    return best;
  }

  /** World units per pixel at a world position. */
  pixelSize(p: Vector3): number {
    const s = this.v.project(p);
    const a = this.v.unproject(s.x, s.y, p),
      b = this.v.unproject(s.x + 1, s.y, p);
    return a.distanceTo(b) || 0.001;
  }

  toLocal(p: Vector3): [number, number, number] {
    const q = p.clone().applyMatrix4(this.inv);
    return [q.x, q.y, q.z];
  }

  /** Average scale of layer space → world (to convert world radii into layer-space radii). */
  scale(): number {
    const e = this.world.elements;
    return (Math.hypot(e[0], e[1], e[2]) + Math.hypot(e[4], e[5], e[6]) + Math.hypot(e[8], e[9], e[10])) / 3 || 1;
  }
}

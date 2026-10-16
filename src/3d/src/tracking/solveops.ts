// Camera solving and scene orientation operators: solve / clear the solution, solver keyframes,
// Set Origin / Floor / Wall / Axis / Scale, solution scale, bundles to mesh and tracking objects.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { app, registerOperators, type OpContext, type Operator } from '../app/app';
import { newObject, newMeshData, newCamera } from '../data/defaults';
import { uniqueName } from '../io/formats/common';
import { addObjectToScene } from '../ops/object';
import { applyMatrixToObject } from '../eval/transform';
import { newConstraint } from '../eval/constraints';
import { uid } from '../data/defaults';
import type { DocumentData, ObjectData } from '../data/types';
import { clipTable, isCameraActive, sceneToClipFrame, tobj, trackingObjects, activeTrack, type MovieClipData, type MovieTrackingTrack, type TrackingObjectData } from './types';
import { contextClip } from './ops';
import { runJob, setProgress, type Job } from './jobs';
import { applySolution, clearSolution, solveSettings, solveTracks } from './reconstruction';
import { solveCamera, type SolveResult } from './solve/pipeline';
import type { SolveMessage, SolveRequest } from './solve/worker';

// ---------------------------------------------------------------------------
// solving

/** Run the solver in a worker (synchronously where workers are unavailable). Null when cancelled. */
export function solveOffThread(req: SolveRequest, job: Job): Promise<SolveResult | null> {
  if (typeof Worker === 'undefined') return Promise.resolve(solveCamera(req.tracks, req.settings, { shouldStop: () => job.cancelled }));
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./solve/worker.ts', import.meta.url), { type: 'module' });
    const finish = () => {
      clearInterval(timer);
      w.terminate();
    };
    const timer = setInterval(() => {
      if (!job.cancelled) return;
      finish();
      resolve(null);
    }, 50);
    w.onmessage = (e: MessageEvent<SolveMessage>) => {
      const m = e.data;
      if (m.type === 'progress') {
        job.detail = m.message;
        setProgress(job, m.fraction);
      } else if (m.type === 'done') {
        finish();
        resolve(m.result);
      } else {
        finish();
        reject(new Error(m.error));
      }
    };
    w.onerror = (e) => {
      finish();
      reject(new Error(e.message || 'Solver worker failed'));
    };
    w.postMessage(req);
  });
}

/** Tracks usable by the solver: enabled markers on at least two frames. */
function solvableTracks(obj: TrackingObjectData) {
  return obj.tracks.filter((t) => t.weight > 0 && t.markers.filter((m) => !m.mute).length >= 2).length;
}

/** Copy the solved lens to the scene camera so the 3D view matches the footage. */
export function copyLensToCamera(doc: DocumentData, clip: MovieClipData, ob: ObjectData | null | undefined) {
  if (!ob || ob.type !== 'CAMERA' || !ob.data) return;
  const cam = doc.cameras[ob.data];
  if (!cam) return;
  const tc = clip.tracking.camera;
  cam.sensor_width = tc.sensor_width;
  cam.lens = tc.focal_length;
  cam.sensor_fit = 'AUTO';
  // optical center offset → lens shift (in units of the larger frame side)
  const [W, H] = clip.size;
  const big = Math.max(W, H * (tc.pixel_aspect || 1)) || 1;
  cam.shift_x = (-tc.principal_point[0] * W) / 2 / big;
  cam.shift_y = (-tc.principal_point[1] * H * (tc.pixel_aspect || 1)) / 2 / big;
}

async function solveJob(clipId: string) {
  const clip0 = clipTable(app.doc)[clipId];
  const isCamera = isCameraActive(clip0);
  const objIndex = clip0.tracking.active_object_index ?? 0;
  const req: SolveRequest = { tracks: solveTracks(clip0, tobj(clip0)), settings: solveSettings(clip0, tobj(clip0), isCamera) };
  await runJob(isCamera ? 'Solve Camera' : 'Solve Object', async (job) => {
    job.detail = 'Starting';
    const t0 = performance.now();
    const res = await solveOffThread(req, job);
    if (!res) return 'Solve cancelled';
    const clip = clipTable(app.doc)[clipId];
    if (!clip) return;
    clip.tracking.active_object_index = objIndex;
    applySolution(clip, tobj(clip), res, isCamera);
    if (!res.ok) {
      app.report('ERROR', res.message);
      return;
    }
    if (isCamera) {
      app.doc.scene.active_clip ??= clip.id;
      copyLensToCamera(app.doc, clip, app.doc.objects[app.doc.scene.camera ?? '']);
    }
    for (const id of Object.keys(app.doc.objects)) app.graph.invalidate(id);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    return `Solved ${res.cameras.length} frames and ${res.bundles.length} tracks in ${secs} s; average reprojection error ${res.error.toFixed(4)} px`;
  });
}

// ---------------------------------------------------------------------------
// orientation helpers

/** The scene camera (the object the camera solution is shown on). */
function sceneCamera(doc: DocumentData): ObjectData | null {
  const id = doc.scene.camera;
  return (id && doc.objects[id]) || null;
}

/** Object whose transform places the camera solution in the scene: the camera, or its parent. */
function orientationTarget(doc: DocumentData): ObjectData | null {
  const cam = sceneCamera(doc);
  if (!cam) return null;
  return (cam.parent && doc.objects[cam.parent]) || cam;
}

/** Reconstruction space → world: the camera's own transform (without its constraints). */
function reconstructionToWorld(doc: DocumentData): Matrix4 {
  const cam = sceneCamera(doc);
  if (!cam) return new Matrix4();
  app.graph.evaluate(doc);
  return app.graph.get(cam.id)?.worldBasis.clone() ?? new Matrix4();
}

/** Premultiply the scene placement of the reconstruction by a world-space transform. */
function transformReconstruction(doc: DocumentData, T: Matrix4) {
  const target = orientationTarget(doc)!;
  app.graph.evaluate(doc);
  const ev = app.graph.get(target.id);
  const world = (ev?.worldBasis ?? new Matrix4()).clone();
  const next = T.clone().multiply(world);
  const parent = ev?.parentMatrix ? ev.parentMatrix.clone().invert() : new Matrix4();
  applyMatrixToObject(target, parent.multiply(next));
  app.graph.invalidate(target.id);
  for (const id of Object.keys(doc.objects)) app.graph.invalidate(id);
}

function bundleTracks(clip: MovieClipData, selectedOnly = true): MovieTrackingTrack[] {
  return tobj(clip).tracks.filter((t) => t.has_bundle && t.bundle && !t.hide && (!selectedOnly || t.select));
}

/** Selected bundles in world space, the active track first. */
function selectedBundlesWorld(clip: MovieClipData, doc: DocumentData): Vector3[] {
  const M = reconstructionToWorld(doc);
  const act = activeTrack(clip);
  const list = bundleTracks(clip).sort((a, b) => Number(b === act) - Number(a === act));
  return list.map((t) => new Vector3(...t.bundle!).applyMatrix4(M));
}

const needsCameraSolve = (ctx: OpContext) => {
  const c = contextClip(ctx);
  return !!c && isCameraActive(c) && !!c.tracking.reconstruction?.is_valid;
};

function orientationPoll(count: number | 'any') {
  return (ctx: OpContext) => {
    const c = contextClip(ctx);
    if (!c || !needsCameraSolve(ctx)) return false;
    const n = bundleTracks(c).length;
    return count === 'any' ? n > 0 : n === count;
  };
}

function requireCamera(): boolean {
  if (sceneCamera(app.doc)) return true;
  app.report('ERROR', 'The scene has no camera to orient (use Setup Tracking Scene or add a camera)');
  return false;
}

/** Shortest rotation taking direction a onto direction b. */
function rotationBetween(a: Vector3, b: Vector3): Matrix4 {
  return new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromUnitVectors(a.clone().normalize(), b.clone().normalize()));
}

function setPlane(clip: MovieClipData, plane: 'FLOOR' | 'WALL') {
  const doc = app.doc;
  const pts = selectedBundlesWorld(clip, doc);
  if (pts.length !== 3) return app.report('ERROR', 'Select exactly three tracks with bundles to define the plane'), false;
  const [p1, p2, p3] = pts;
  const n = new Vector3().subVectors(p2, p1).cross(new Vector3().subVectors(p3, p1));
  if (n.lengthSq() < 1e-20) return app.report('ERROR', 'The three tracks lie on a line'), false;
  n.normalize();
  // the camera stays on the visible side of the plane (above the floor, in front of the wall)
  app.graph.evaluate(doc);
  const camPos = new Vector3().setFromMatrixPosition(app.graph.get(sceneCamera(doc)!.id)!.world);
  if (n.dot(camPos.clone().sub(p1)) < 0) n.negate();
  const axis = plane === 'FLOOR' ? new Vector3(0, 0, 1) : new Vector3(0, -1, 0);
  const R = rotationBetween(n, axis);
  const q = p1.clone().applyMatrix4(R);
  const T = plane === 'FLOOR' ? new Matrix4().makeTranslation(0, 0, -q.z) : new Matrix4().makeTranslation(0, -q.y, 0);
  transformReconstruction(doc, T.multiply(R));
  return true;
}

// ---------------------------------------------------------------------------
// operators

const SCALE_PROP = { id: 'distance', label: 'Distance', type: 'float' as const, default: 1, min: 0, subtype: 'distance' as const };

const ops: Operator[] = [
  {
    idname: 'clip.solve_camera',
    label: 'Solve Camera',
    description: 'Reconstruct the camera motion (or the motion of the active tracking object) and the 3D positions of the tracks from the tracked markers',
    undo: false,
    poll: (ctx) => {
      const c = contextClip(ctx);
      return !!c && c.size[0] > 0 && solvableTracks(tobj(c)) > 0;
    },
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      const n = solvableTracks(tobj(c));
      if (n < (c.tracking.settings.use_tripod_solver ? 3 : 8)) {
        app.report('ERROR', `At least ${c.tracking.settings.use_tripod_solver ? 3 : 8} tracks with markers on two or more frames are needed (${n} found)`);
        return 'CANCELLED';
      }
      void solveJob(c.id);
      return 'CANCELLED';
    },
  },
  {
    idname: 'clip.clear_solution',
    label: 'Clear Solution',
    description: 'Remove the camera (or object) solution and the reconstructed track positions',
    poll: (ctx) => !!contextClip(ctx) && (!!tobj(contextClip(ctx)!).reconstruction?.is_valid || tobj(contextClip(ctx)!).tracks.some((t) => t.has_bundle)),
    exec: (ctx) => {
      clearSolution(tobj(contextClip(ctx)!));
      for (const id of Object.keys(ctx.doc.objects)) app.graph.invalidate(id);
    },
  },
  {
    idname: 'clip.set_solver_keyframe',
    label: 'Set Solver Keyframe',
    description: 'Use the current frame as a keyframe of the reconstruction',
    props: [
      {
        id: 'keyframe',
        label: 'Keyframe',
        type: 'enum',
        default: 'KEYFRAME_A',
        items: [
          ['KEYFRAME_A', 'Keyframe A'],
          ['KEYFRAME_B', 'Keyframe B'],
        ],
      },
    ],
    poll: (ctx) => !!contextClip(ctx),
    exec: (ctx, p) => {
      const c = contextClip(ctx)!;
      const o = tobj(c);
      const f = sceneToClipFrame(c, ctx.doc.scene.frame_current);
      if (p.keyframe === 'KEYFRAME_B') o.keyframe_b = f;
      else o.keyframe_a = f;
    },
  },
  {
    idname: 'clip.set_origin',
    label: 'Set Origin',
    description: 'Move the scene so the active track (or the median of the selected tracks) sits at the world origin, by moving the camera or its parent',
    props: [{ id: 'use_median', label: 'Use Median', type: 'bool', default: false }],
    poll: orientationPoll('any'),
    exec: (ctx, p) => {
      if (!requireCamera()) return 'CANCELLED';
      const c = contextClip(ctx)!;
      const pts = selectedBundlesWorld(c, ctx.doc);
      if (!pts.length) return 'CANCELLED';
      const o = new Vector3();
      if (p.use_median) {
        for (const v of pts) o.add(v);
        o.multiplyScalar(1 / pts.length);
      } else o.copy(pts[0]);
      transformReconstruction(ctx.doc, new Matrix4().makeTranslation(-o.x, -o.y, -o.z));
    },
  },
  {
    idname: 'clip.set_plane',
    label: 'Set Plane',
    description: 'Orient the scene so the plane through three selected tracks becomes the floor or a wall, by moving the camera or its parent',
    props: [
      {
        id: 'plane',
        label: 'Plane',
        type: 'enum',
        default: 'FLOOR',
        items: [
          ['FLOOR', 'Floor', 'Set floor plane'],
          ['WALL', 'Wall', 'Set wall plane'],
        ],
      },
    ],
    poll: orientationPoll(3),
    exec: (ctx, p) => {
      if (!requireCamera()) return 'CANCELLED';
      return setPlane(contextClip(ctx)!, p.plane === 'WALL' ? 'WALL' : 'FLOOR') ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'clip.set_axis',
    label: 'Set Axis',
    description: 'Turn the scene around the vertical axis so the selected track lies on the chosen axis through the origin',
    props: [
      {
        id: 'axis',
        label: 'Axis',
        type: 'enum',
        default: 'X',
        items: [
          ['X', 'X', 'Align bundle to X axis'],
          ['Y', 'Y', 'Align bundle to Y axis'],
        ],
      },
    ],
    poll: orientationPoll(1),
    exec: (ctx, p) => {
      if (!requireCamera()) return 'CANCELLED';
      const b = selectedBundlesWorld(contextClip(ctx)!, ctx.doc)[0];
      if (Math.hypot(b.x, b.y) < 1e-9) {
        app.report('ERROR', 'The track is at the origin: set the origin to another track first');
        return 'CANCELLED';
      }
      const a = Math.atan2(b.y, b.x);
      transformReconstruction(ctx.doc, new Matrix4().makeRotationZ((p.axis === 'Y' ? Math.PI / 2 : 0) - a));
    },
  },
  {
    idname: 'clip.set_scale',
    label: 'Set Scale',
    description: 'Scale the scene so the two selected tracks are the given distance apart, by scaling the camera or its parent',
    props: [SCALE_PROP],
    poll: orientationPoll(2),
    exec: (ctx, p) => {
      if (!requireCamera()) return 'CANCELLED';
      const [a, b] = selectedBundlesWorld(contextClip(ctx)!, ctx.doc);
      const d = a.distanceTo(b);
      if (d < 1e-12) return 'CANCELLED';
      const s = Number(p.distance) / d;
      transformReconstruction(ctx.doc, new Matrix4().makeScale(s, s, s));
    },
  },
  {
    idname: 'clip.apply_solution_scale',
    label: 'Apply Solution Scale',
    description: 'Scale the solution itself so the two selected tracks are the given distance apart',
    props: [SCALE_PROP],
    poll: orientationPoll(2),
    exec: (ctx, p) => {
      const c = contextClip(ctx)!;
      const [ta, tb] = bundleTracks(c);
      const d = new Vector3(...ta.bundle!).distanceTo(new Vector3(...tb.bundle!));
      if (d < 1e-12) return 'CANCELLED';
      scaleSolution(tobj(c), Number(p.distance) / d);
      for (const id of Object.keys(ctx.doc.objects)) app.graph.invalidate(id);
    },
  },
  {
    idname: 'clip.set_solution_scale',
    label: 'Set Solution Scale',
    description: 'Set the scale of the object solution so the two selected tracks are the given distance apart',
    props: [SCALE_PROP],
    poll: (ctx) => {
      const c = contextClip(ctx);
      return !!c && !isCameraActive(c) && !!tobj(c).reconstruction?.is_valid && bundleTracks(c).length === 2;
    },
    exec: (ctx, p) => {
      const c = contextClip(ctx)!;
      const [ta, tb] = bundleTracks(c);
      const d = new Vector3(...ta.bundle!).distanceTo(new Vector3(...tb.bundle!));
      if (d < 1e-12) return 'CANCELLED';
      (tobj(c) as { scale?: number }).scale = Number(p.distance) / d;
      for (const id of Object.keys(ctx.doc.objects)) app.graph.invalidate(id);
    },
  },
  {
    idname: 'clip.bundles_to_mesh',
    label: '3D Markers to Mesh',
    description: 'Create a mesh with one vertex per reconstructed track (the selected ones, or all)',
    poll: (ctx) => {
      const c = contextClip(ctx);
      return !!c && tobj(c).tracks.some((t) => t.has_bundle) && ctx.doc.mode === 'OBJECT';
    },
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      let list = bundleTracks(c);
      if (!list.length) list = bundleTracks(c, false);
      const pos = new Float32Array(list.length * 3);
      list.forEach((t, i) => pos.set(t.bundle!, i * 3));
      const doc = ctx.doc;
      const me = newMeshData(uniqueName(doc, 'Tracks', 'meshes'), { positions: pos, offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0) });
      doc.meshes[me.id] = me;
      const ob = newObject('Tracks', 'MESH', me.id);
      addObjectToScene(doc, ob, { location: [0, 0, 0] });
      if (isCameraActive(c)) applyMatrixToObject(ob, reconstructionToWorld(doc));
      app.report('INFO', `Created a mesh with ${list.length} vertices`);
    },
  },
  {
    idname: 'clip.tracking_object_new',
    label: 'Add Tracking Object',
    description: 'Add a tracked object: its tracks are solved separately, as an object moving relative to the camera',
    poll: (ctx) => !!contextClip(ctx),
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      const objs = (c.tracking.objects ??= []);
      const names = new Set(trackingObjects(c).map((o) => o.name));
      let name = 'Object';
      for (let i = 1; names.has(name); i++) name = `Object.${String(i).padStart(3, '0')}`;
      objs.push({ name, scale: 1, tracks: [], active_track: null, plane_tracks: [], reconstruction: { is_valid: false, average_error: 0, cameras: [] }, keyframe_a: 1, keyframe_b: 30 });
      c.tracking.active_object_index = objs.length;
    },
  },
  {
    idname: 'clip.tracking_object_remove',
    label: 'Remove Tracking Object',
    description: 'Remove the active tracking object and its tracks (the camera cannot be removed)',
    poll: (ctx) => {
      const c = contextClip(ctx);
      return !!c && !isCameraActive(c);
    },
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      const i = (c.tracking.active_object_index ?? 0) - 1;
      c.tracking.objects!.splice(i, 1);
      c.tracking.active_object_index = Math.max(0, i);
    },
  },
];

export function scaleSolution(o: TrackingObjectData, s: number) {
  const rec = o.reconstruction;
  if (rec)
    for (const cam of rec.cameras) {
      cam.matrix = [...cam.matrix];
      cam.matrix[12] *= s;
      cam.matrix[13] *= s;
      cam.matrix[14] *= s;
    }
  for (const t of o.tracks) if (t.bundle) t.bundle = [t.bundle[0] * s, t.bundle[1] * s, t.bundle[2] * s];
}

registerOperators(ops);

// ---------------------------------------------------------------------------
// scene setup helpers shared with the setup operators

/** The scene camera, created (and made the scene camera) when missing. */
export function ensureSceneCamera(doc: DocumentData): ObjectData {
  const existing = sceneCamera(doc);
  if (existing) return existing;
  const cam = newCamera('Camera');
  doc.cameras[cam.id] = cam;
  const ob = newObject('Camera', 'CAMERA', cam.id);
  const keep = doc.scene.active_object;
  const sel = Object.values(doc.objects).filter((o) => o.select);
  addObjectToScene(doc, ob, { location: [0, 0, 0] });
  ob.select = false;
  for (const o of sel) o.select = true;
  doc.scene.active_object = keep;
  doc.scene.camera = ob.id;
  return ob;
}

/**
 * Add a Camera Solver constraint to the camera when it has none. The camera's own transform then
 * places the solution in the scene, so it starts out as the identity (and no parent).
 */
export function ensureCameraSolver(ob: ObjectData) {
  if (ob.constraints.some((c) => c.type === 'CAMERA_SOLVER')) return;
  ob.location = [0, 0, 0];
  ob.rotation_euler = [0, 0, 0];
  ob.rotation_quaternion = [1, 0, 0, 0];
  ob.rotation_axis_angle = [0, 0, 1, 0];
  ob.scale = [1, 1, 1];
  const con = newConstraint('CAMERA_SOLVER', uid('cn'), ob.constraints);
  Object.assign(con, { use_active_clip: true, clip: null });
  ob.constraints.push(con);
}

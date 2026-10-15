// Scene input nodes: Active Camera, Camera Info, Image Info and Bone Info.
import './fdata';
import { gn, sprop } from './defs';
import { identity, invertMat, mulMat } from '../geometry';
import { evaluatePose } from '../../eval/armature';
import { poseBoneMatrix } from '../../eval/transform';
import type { DocumentData, ObjectData } from '../../data/types';
import type { EvalEnv } from '../exec';

const IDENTITY = Array.from(identity());

gn('GeometryNodeInputActiveCamera', 'input', {
  exec: (ctx) => ({ 'Active Camera': ctx.env.doc.scene.camera ?? null }),
  sig: (_n, env) => String(env.doc.scene.camera ?? ''),
  deps: (_n, doc) => (doc.scene.camera ? [doc.scene.camera] : []),
});

// ---------------------------------------------------------------------------
// Camera Info

/** Lens and projection values of a camera for the scene's render size. */
export function cameraInfo(doc: DocumentData, ob: ObjectData | undefined) {
  const cam = ob?.type === 'CAMERA' && ob.data ? doc.cameras[ob.data] : undefined;
  if (!cam) return null;
  const r = doc.scene.render;
  const w = r.resolution_x * (r.pixel_aspect_x || 1),
    h = r.resolution_y * (r.pixel_aspect_y || 1);
  const fit = cam.sensor_fit === 'AUTO' ? (w >= h ? 'HORIZONTAL' : 'VERTICAL') : cam.sensor_fit;
  const aspect = w / (h || 1);
  // sensor size covering the frame along the fitted axis
  const sensor = fit === 'HORIZONTAL' ? [cam.sensor_width, cam.sensor_width / aspect] : [cam.sensor_height * aspect, cam.sensor_height];
  // shift is relative to the larger frame side; express it per axis
  const big = Math.max(w, h) || 1;
  const shift = [(cam.shift_x * big) / (w || 1), (cam.shift_y * big) / (h || 1)];
  const n = cam.clip_start,
    f = cam.clip_end;
  const P = new Array<number>(16).fill(0);
  if (cam.type === 'ORTHO') {
    const view = fit === 'HORIZONTAL' ? [cam.ortho_scale, cam.ortho_scale / aspect] : [cam.ortho_scale * aspect, cam.ortho_scale];
    P[0] = 2 / view[0];
    P[5] = 2 / view[1];
    P[10] = -2 / (f - n);
    P[12] = -2 * shift[0];
    P[13] = -2 * shift[1];
    P[14] = -(f + n) / (f - n);
    P[15] = 1;
  } else {
    P[0] = (2 * cam.lens) / sensor[0];
    P[5] = (2 * cam.lens) / sensor[1];
    P[8] = 2 * shift[0];
    P[9] = 2 * shift[1];
    P[10] = -(f + n) / (f - n);
    P[11] = -1;
    P[14] = (-2 * f * n) / (f - n);
  }
  return {
    'Projection Matrix': P,
    'Focal Length': cam.lens,
    Sensor: [sensor[0], sensor[1], 0],
    Shift: [shift[0], shift[1], 0],
    'Clip Start': n,
    'Clip End': f,
    'Focus Distance': cam.dof.focus_distance,
    'Is Orthographic': cam.type === 'ORTHO',
    'Orthographic Scale': cam.ortho_scale,
  };
}

gn('GeometryNodeCameraInfo', 'input', {
  exec: (ctx) => {
    const id = ctx.idRef('Camera');
    const info = id ? cameraInfo(ctx.env.doc, ctx.env.doc.objects[id]) : null;
    return (
      info ?? {
        'Projection Matrix': IDENTITY,
        'Focal Length': 0,
        Sensor: [0, 0, 0],
        Shift: [0, 0, 0],
        'Clip Start': 0,
        'Clip End': 0,
        'Focus Distance': 0,
        'Is Orthographic': false,
        'Orthographic Scale': 0,
      }
    );
  },
  sig: (n, env) => {
    const id = n.inputs.Camera as string | null;
    const ob = id ? env.doc.objects[id] : undefined;
    const r = env.doc.scene.render;
    return `${JSON.stringify(ob?.data ? (env.doc.cameras[ob.data] ?? null) : null)}|${r.resolution_x}x${r.resolution_y}|${r.pixel_aspect_x}:${r.pixel_aspect_y}`;
  },
});

// ---------------------------------------------------------------------------
// Image Info

gn('GeometryNodeImageInfo', 'input', {
  exec: (ctx) => {
    const id = ctx.idRef('Image');
    const im = id ? ctx.env.doc.images[id] : undefined;
    if (!im) return { Width: 0, Height: 0, 'Has Alpha': false, 'Frame Count': 0, FPS: 0 };
    return {
      Width: im.width,
      Height: im.height,
      'Has Alpha': im.alpha_mode !== 'NONE' && !/jpe?g/i.test(im.mime),
      'Frame Count': 1,
      FPS: 0,
    };
  },
  sig: (n, env) => {
    const id = n.inputs.Image as string | null;
    const im = id ? env.doc.images[id] : undefined;
    return im ? `${im.width}x${im.height}:${im.alpha_mode}:${im.mime}` : '';
  },
});

// ---------------------------------------------------------------------------
// Bone Info

const flat = (m: { elements: ArrayLike<number> }) => Array.from(m.elements);

function boneInfo(env: EvalEnv, armId: string | null, boneName: string, relative: boolean) {
  const none = { Pose: IDENTITY, 'Local Pose': IDENTITY, 'Transform Pose': IDENTITY, 'Rest Pose': IDENTITY, 'Rest Length': 0, Exists: false };
  const ob = armId ? env.doc.objects[armId] : undefined;
  const arm = ob?.type === 'ARMATURE' && ob.data ? env.doc.armatures[ob.data] : undefined;
  if (!ob || !arm) return none;
  const pose = evaluatePose(env.doc, ob, arm);
  const b = pose.bones.get(boneName);
  if (!b) return none;
  // the bone's own transform (its location, rotation and scale channels)
  const pb = arm.pose_position === 'REST' ? undefined : ob.pose?.[boneName];
  const local = pb ? flat(poseBoneMatrix(pb)) : IDENTITY;
  const toSpace = relative ? mulMat(invertMat(env.selfWorld), env.objectWorld(ob.id) ?? identity()) : identity();
  return {
    Pose: Array.from(mulMat(toSpace, flat(b.pose))),
    'Local Pose': local,
    'Transform Pose': local,
    'Rest Pose': Array.from(mulMat(toSpace, flat(b.rest))),
    'Rest Length': b.length,
    Exists: true,
  };
}

gn(
  'GeometryNodeBoneInfo',
  'input',
  {
    exec: (ctx) => boneInfo(ctx.env, ctx.idRef('Armature'), ctx.string('Bone Name'), sprop(ctx.node, 'transform_space') === 'RELATIVE'),
    sig: (n, env) => {
      const id = n.inputs.Armature as string | null;
      const ob = id ? env.doc.objects[id] : undefined;
      const arm = ob?.data ? env.doc.armatures[ob.data] : undefined;
      return `${id ? env.objectSig(id) : ''}|${JSON.stringify(ob?.pose ?? null)}|${JSON.stringify(arm?.bones ?? null)}|${arm?.pose_position}|${Array.from(env.selfWorld)
        .map((x) => x.toFixed(5))
        .join(',')}`;
    },
    deps: (n) => (typeof n.inputs.Armature === 'string' ? [n.inputs.Armature] : []),
  },
  { propPatch: { transform_space: { expand: true } } },
);

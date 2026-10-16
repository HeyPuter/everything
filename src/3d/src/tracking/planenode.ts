// Compositor "Plane Track Deform" node: warps an image onto a plane track of a movie clip (the
// result has the clip's resolution) and outputs the plane as a matte, optionally with motion blur
// from the plane's motion around the frame.
import { h } from '../ui/h';
import { app, onAppReady } from '../app/app';
import { enumMenu } from '../ui/widgets';
import { registerNodeType, nodeMenu } from '../nodes/registry';
import type { MenuCategory } from '../nodes/types';
import { registerExec } from '../compositor/eval/evaluator';
import { Result, IDENTITY, type Domain, type Xform } from '../compositor/eval/result';
import { idSelector } from '../nodes/editor/idselect';
import { nodeChanged } from '../nodes/editor/nodeui';
import { clipTable, sceneToClipFrame, trackingObjectByName, trackingObjects, type MovieClipData, type MovieTrackingPlaneTrack } from './types';
import { planeMarkerAt, squareToQuad } from './planetrack';

const MAX_SAMPLES = 32;

const DEFORM = `
uniform sampler2D u_src;
uniform vec2 u_out;
uniform mat3 u_inv[${MAX_SAMPLES}];
uniform int u_n;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  vec2 size = vec2(textureSize(u_src, 0));
  vec2 p = gl_FragCoord.xy / u_out;
  vec4 acc = vec4(0.0);
  float m = 0.0;
  for (int i = 0; i < ${MAX_SAMPLES}; i++) {
    if (i >= u_n) break;
    vec3 q = u_inv[i] * vec3(p, 1.0);
    vec2 uv = q.xy / q.z;
    bool inside = q.z > 0.0 && all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
    if (inside) {
      acc += cmpSample(u_src, uv * size, 1, 0, 0);
      m += 1.0;
    }
  }
  float n = float(max(u_n, 1));
  o0 = acc / n;
  o1 = vec4(vec3(m / n), 1.0);
}`;

function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, hh, i] = m;
  const A = e * i - f * hh,
    B = -(d * i - f * g),
    C = d * hh - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const k = 1 / det;
  return [A * k, -(b * i - c * hh) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * hh - b * g) * k, (a * e - b * d) * k];
}

/** Plane corners (normalized) at a fractional clip frame, interpolated between frames. */
export function planeCornersAt(pt: MovieTrackingPlaneTrack, frame: number): [number, number][] | null {
  if (!pt.markers.length) return null;
  const f0 = Math.floor(frame),
    t = frame - f0;
  const a = planeMarkerAt(pt, f0),
    b = planeMarkerAt(pt, f0 + 1);
  if (!a) return null;
  if (!b || t === 0) return a.corners.map((p) => [p[0], p[1]]);
  return a.corners.map((p, i) => [p[0] + (b.corners[i][0] - p[0]) * t, p[1] + (b.corners[i][1] - p[1]) * t]);
}

function nodePlane(x: { prop(id: string): unknown; env: { doc: { movieclips?: Record<string, MovieClipData> } } }): { clip: MovieClipData; pt: MovieTrackingPlaneTrack } | null {
  const id = x.prop('clip') as string | null;
  const clip = id ? clipTable(x.env.doc)[id] : null;
  if (!clip) return null;
  const o = trackingObjectByName(clip, x.prop('tracking_object') as string);
  const pt = (o.plane_tracks ?? []).find((p) => p.name === x.prop('plane_track_name'));
  return pt ? { clip, pt } : null;
}

registerNodeType({
  idname: 'CompositorNodePlaneTrackDeform',
  label: 'Plane Track Deform',
  category: 'distort',
  treeTypes: ['COMPOSITOR'],
  width: 180,
  description: 'Warp an image onto a plane track of a movie clip; Plane is the matte of the plane',
  inputs: [{ name: 'Image', identifier: 'Image', type: 'RGBA', default: [1, 1, 1, 1] }],
  outputs: [
    { name: 'Image', identifier: 'Image', type: 'RGBA', default: [0, 0, 0, 0] },
    { name: 'Plane', identifier: 'Plane', type: 'FLOAT', default: 0 },
  ],
  props: [
    { id: 'use_motion_blur', name: 'Motion Blur', type: 'BOOLEAN', d: false },
    { id: 'motion_blur_samples', name: 'Samples', type: 'INT', d: 16, min: 1, max: MAX_SAMPLES, visible: (n) => !!n.props.use_motion_blur },
    { id: 'motion_blur_shutter', name: 'Shutter', type: 'FLOAT', d: 0.5, min: 0, max: 1, visible: (n) => !!n.props.use_motion_blur },
  ],
  bodyHeight: () => 78,
  drawBody: (ctx) => {
    const n = ctx.node;
    const clip = (n.props.clip as string | null) ? clipTable(app.doc)[n.props.clip as string] : undefined;
    const objs = clip ? trackingObjects(clip) : [];
    const o = clip ? trackingObjectByName(clip, n.props.tracking_object as string) : null;
    return h(
      'div',
      { class: 'cmp-body-col' },
      idSelector(n, 'clip', { items: () => Object.values(clipTable(app.doc)), icon: 'tracker', kind: 'Movie Clip' }),
      enumMenu(`${ctx.key}:obj`, objs.map((x) => ({ value: x.is_camera ? '' : x.name, label: x.name, icon: x.is_camera ? 'camera_data' : 'object' })).concat(objs.length ? [] : [{ value: '', label: 'Object', icon: 'object' }]), String(n.props.tracking_object ?? ''), (v) => ((n.props.tracking_object = v), nodeChanged('Tracking Object')), { title: 'Tracking Object' }),
      enumMenu(`${ctx.key}:plane`, [{ value: '', label: 'Plane Track', icon: 'object' }, ...(o?.plane_tracks ?? []).map((p) => ({ value: p.name, label: p.name, icon: 'object' }))], String(n.props.plane_track_name ?? ''), (v) => ((n.props.plane_track_name = v), nodeChanged('Plane Track')), { title: 'Plane Track' }),
    );
  },
});

registerExec('CompositorNodePlaneTrackDeform', (x) => {
  const r = x.input('Image');
  const sel = nodePlane(x);
  if (!sel || !r.domain || !sel.clip.size[0]) {
    x.out('Image', r);
    x.out('Plane', Result.single('FLOAT', 0));
    return;
  }
  const { clip, pt } = sel;
  const f = sceneToClipFrame(clip, x.env.frame);
  const blur = !!x.prop('use_motion_blur');
  const n = blur ? Math.max(1, Math.min(MAX_SAMPLES, Number(x.prop('motion_blur_samples')) || 16)) : 1;
  const shutter = Math.max(0, Math.min(1, Number(x.prop('motion_blur_shutter') ?? 0.5)));
  const mats = new Float32Array(MAX_SAMPLES * 9);
  let used = 0;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? f : f - shutter / 2 + (shutter * i) / (n - 1);
    const q = planeCornersAt(pt, t);
    if (!q) continue;
    const inv = invert3(squareToQuad(q));
    mats.set([inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]], used * 9);
    used++;
  }
  if (!used) {
    x.out('Image', Result.single('RGBA', [0, 0, 0, 0]));
    x.out('Plane', Result.single('FLOAT', 0));
    return;
  }
  const d: Domain = { w: clip.size[0], h: clip.size[1], xf: [...IDENTITY] as Xform };
  const img = x.alloc(d),
    plane = x.alloc(d);
  x.pass('planedeform', DEFORM, [img, plane], { u_src: x.ev.tex(r), u_out: [d.w, d.h], u_inv: mats, u_n: used });
  x.out('Image', Result.image('RGBA', img, d));
  x.out('Plane', Result.image('FLOAT', plane, d));
});

// Add ▸ Tracking lists the node first
onAppReady(() => {
  const listed = (items: MenuCategory['items']): boolean => items.some((i) => typeof i === 'object' && ('idname' in i ? i.idname === 'CompositorNodePlaneTrackDeform' : listed(i.items)));
  if (listed(nodeMenu('COMPOSITOR'))) return;
  const cat = nodeMenu('COMPOSITOR').find((c) => c.label === 'Tracking') as MenuCategory | undefined;
  if (cat) cat.items.unshift({ idname: 'CompositorNodePlaneTrackDeform' });
});

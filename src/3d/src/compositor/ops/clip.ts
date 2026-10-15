// Motion tracking nodes: Movie Clip, Movie Distortion, Stabilize 2D, Track Position and Keying
// Screen. Footage comes from the clip's frame source (decoded asynchronously: the compositor
// re-runs once a frame is ready); tracks, lens and stabilization from the clip's tracking data.
import { h } from '../../ui/h';
import { app } from '../../app/app';
import { enumMenu } from '../../ui/widgets';
import type { NodeData } from '../../data/types';
import { getNodeType } from '../../nodes/registry';
import { idSelector } from '../../nodes/editor/idselect';
import { nodeChanged } from '../../nodes/editor/nodeui';
import { registerExec, type NodeCtx } from '../eval/evaluator';
import { Result, IDENTITY, xfMul, type Domain, type Xform } from '../eval/result';
import { cachedTexture, notifyDecoded } from '../eval/cache';
import { menuValue } from '../nodes/defs';
import { clipTable, sceneToClipFrame, clipFrameToSourceIndex, enabledMarkerAt, markerAt, focalPixels, principalPixels, type MovieClipData, type MovieTrackingTrack } from '../../tracking/types';
import { readySource, clipSource } from '../../tracking/source';
import { stabilizationMatrix, type Affine2 } from '../../tracking/stabilize';

const ident = (): Xform => [...IDENTITY] as Xform;

export function nodeClip(x: { env: { doc: { movieclips?: Record<string, MovieClipData> } }; prop(id: string): unknown }): MovieClipData | null {
  const id = x.prop('clip') as string | null;
  return id ? (clipTable(x.env.doc)[id] ?? null) : null;
}

/** Clip frame shown at the current scene frame. */
const clipFrame = (x: NodeCtx, clip: MovieClipData) => sceneToClipFrame(clip, x.env.frame);

const DECODE = `
uniform sampler2D u_src;
layout(location = 0) out vec4 o0;
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
void main() {
  ivec2 s = textureSize(u_src, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(u_src, ivec2(p.x, s.y - 1 - p.y), 0);
  o0 = vec4(srgbToLinear(c.rgb) * c.a, c.a);
}`;

const pending = new Set<string>();

/** Footage texture of a clip frame (linear, premultiplied), or null while it is being decoded. */
function frameTexture(x: NodeCtx, clip: MovieClipData, frame: number): { tex: ReturnType<typeof cachedTexture>; w: number; h: number } | null {
  const index = clipFrameToSourceIndex(clip, frame);
  const src = readySource(clip);
  if (!src) {
    const p = clipSource(clip);
    if (p && !pending.has(clip.id)) {
      pending.add(clip.id);
      void p.then(() => (pending.delete(clip.id), notifyDecoded())).catch(() => pending.delete(clip.id));
    }
    return null;
  }
  if (index < 0 || index >= src.frameCount) return null;
  const bmp = src.peek(index);
  if (!bmp) {
    const k = `${src.key}${index}`;
    if (!pending.has(k)) {
      pending.add(k);
      void src.get(index).then(() => (pending.delete(k), notifyDecoded()));
    }
    return null;
  }
  const tex = cachedTexture(`clip|${src.key}${index}|${bmp.width}x${bmp.height}`, () => {
    const gl = x.gpu.gl;
    const raw = x.gpu.uploadSource(bmp, bmp.width, bmp.height);
    const t = x.gpu.alloc(bmp.width, bmp.height, `clip:${clip.name}`);
    x.ev.pass('clip-decode', DECODE, t, { u_src: x.gpu.wrap(raw, bmp.width, bmp.height) });
    gl.deleteTexture(raw);
    return t;
  });
  return { tex, w: bmp.width, h: bmp.height };
}

/** Stabilization as a transform of the centred pixel space (footage domain → stabilized domain). */
export function stabilizationXform(clip: MovieClipData, frame: number, invert: boolean): Xform {
  if (!clip.tracking.stabilization.use_2d_stabilization) return ident();
  const T: Affine2 = stabilizationMatrix(clip, frame);
  const [W, H] = clip.size;
  const toPx: Xform = [1, 0, 0, 1, W / 2, H / 2],
    toC: Xform = [1, 0, 0, 1, -W / 2, -H / 2];
  let m = xfMul(toC, xfMul(T as unknown as Xform, toPx));
  if (invert) {
    const det = m[0] * m[3] - m[1] * m[2];
    const a = m[3] / det,
      b = -m[1] / det,
      c = -m[2] / det,
      d = m[0] / det;
    m = [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
  }
  return m;
}

// ---------------------------------------------------------------------------
// Movie Clip

registerExec('CompositorNodeMovieClip', (x) => {
  const clip = nodeClip(x);
  const empty = () => {
    x.out('Image', Result.single('RGBA', [0, 0, 0, 0]));
    x.out('Alpha', Result.single('FLOAT', 0));
  };
  x.out('Offset X', Result.single('FLOAT', 0));
  x.out('Offset Y', Result.single('FLOAT', 0));
  x.out('Scale', Result.single('FLOAT', 1));
  x.out('Angle', Result.single('FLOAT', 0));
  if (!clip) return empty();
  const f = clipFrame(x, clip);
  if (clip.tracking.stabilization.use_2d_stabilization) {
    const m = stabilizationXform(clip, f, false);
    x.out('Offset X', Result.single('FLOAT', m[4]));
    x.out('Offset Y', Result.single('FLOAT', m[5]));
    x.out('Scale', Result.single('FLOAT', Math.hypot(m[0], m[1])));
    x.out('Angle', Result.single('FLOAT', Math.atan2(m[1], m[0])));
  }
  const fr = frameTexture(x, clip, f);
  if (!fr) {
    if (clip.movie || clip.sequence?.length) x.error('Loading footage…');
    return empty();
  }
  const d: Domain = { w: fr.w, h: fr.h, xf: ident() };
  x.out('Image', Result.image('RGBA', fr.tex, d));
  const a = x.alloc(d, 'clip-alpha');
  x.pass('clip-alpha', `uniform sampler2D u_src;\nlayout(location = 0) out vec4 o0;\nvoid main() { float a = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0).a; o0 = vec4(vec3(a), 1.0); }`, a, {
    u_src: fr.tex,
  });
  x.out('Alpha', Result.image('FLOAT', a, d));
});

// ---------------------------------------------------------------------------
// Stabilize 2D: a transform of the image domain (resampled when realized)

const INTERP: Record<string, number> = { Nearest: 0, Bilinear: 1, Bicubic: 2, Anisotropic: 3 };
const EXT: Record<string, number> = { Clip: 0, Extend: 1, Repeat: 2 };

registerExec('CompositorNodeStabilize', (x) => {
  const r = x.input('Image');
  const clip = nodeClip(x);
  if (!r.domain || !clip) return x.out('Image', r);
  const m = stabilizationXform(clip, clipFrame(x, clip), x.bool('Invert'));
  x.out(
    'Image',
    r.withDomain(
      { w: r.domain.w, h: r.domain.h, xf: xfMul(m, r.domain.xf) },
      { interp: INTERP[menuValue(x.node, 'Interpolation')] ?? 1, extX: EXT[menuValue(x.node, 'Extension X')] ?? 0, extY: EXT[menuValue(x.node, 'Extension Y')] ?? 0 },
    ),
  );
});

// ---------------------------------------------------------------------------
// Movie Distortion: the clip's polynomial lens model

const DISTORTION = `
uniform sampler2D u_src;
uniform vec2 u_f;
uniform vec2 u_c;
uniform float u_pa;
uniform vec3 u_k;
uniform int u_undistort;
layout(location = 0) out vec4 o0;
vec2 toNorm(vec2 p) { return vec2((p.x - u_c.x) / u_f.x, (p.y * u_pa - u_c.y) / u_f.y); }
vec2 toPx(vec2 n) { return vec2(n.x * u_f.x + u_c.x, (n.y * u_f.y + u_c.y) / u_pa); }
float radial(vec2 n) { float r2 = dot(n, n); return 1.0 + u_k.x * r2 + u_k.y * r2 * r2 + u_k.z * r2 * r2 * r2; }
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 n = toNorm(p);
  vec2 q;
  if (u_undistort == 1) q = toPx(n * radial(n));
  else {
    // the source pixel is the undistorted position of this (distorted) one
    vec2 u = n;
    for (int i = 0; i < 20; i++) u = n / radial(u);
    q = toPx(u);
  }
  o0 = cmpBilinear(u_src, q, 0, 0);
}`;

registerExec('CompositorNodeMovieDistortion', (x) => {
  const r = x.input('Image');
  const clip = nodeClip(x);
  if (!r.domain || !clip || clip.size[0] <= 0) return x.out('Image', r);
  const cam = clip.tracking.camera;
  if (!cam.k1 && !cam.k2 && !cam.k3) return x.out('Image', r);
  const d = r.domain;
  // lens parameters are defined for the footage size: scale them to the image size
  const sx = d.w / clip.size[0],
    sy = d.h / clip.size[1];
  const f = focalPixels(clip) * sx;
  const pa = cam.pixel_aspect || 1;
  const [cx, cy] = principalPixels(clip);
  const t = x.alloc(d);
  x.pass('movie-distortion', DISTORTION, t, {
    u_src: r.tex!,
    u_f: [f, f * pa],
    u_c: [cx * sx, cy * sy * pa],
    u_pa: pa,
    u_k: [cam.k1, cam.k2, cam.k3],
    u_undistort: menuValue(x.node, 'Type') === 'Distort' ? 0 : 1,
  });
  x.out('Image', Result.image('RGBA', t, d));
});

// ---------------------------------------------------------------------------
// Track Position

function trackOf(clip: MovieClipData, name: string): MovieTrackingTrack | null {
  return clip.tracking.tracks.find((t) => t.name === name) ?? null;
}

/** Marker position in pixels (origin bottom-left) at a clip frame, or null. */
function trackPos(clip: MovieClipData, t: MovieTrackingTrack, frame: number): [number, number] | null {
  const m = enabledMarkerAt(t, frame) ?? markerAt(t, frame);
  return m ? [m.co[0] * clip.size[0], m.co[1] * clip.size[1]] : null;
}

/** Outputs of the Track Position node (pure, for tests). */
export function trackPosition(clip: MovieClipData, track: string, mode: string, sceneFrame: number, frameInput: number): { x: number; y: number; speed: [number, number, number, number] } {
  const t = trackOf(clip, track);
  if (!t || !t.markers.length) return { x: 0, y: 0, speed: [0, 0, 0, 0] };
  const f = sceneToClipFrame(clip, sceneFrame);
  const fi = sceneToClipFrame(clip, frameInput);
  const cur = trackPos(clip, t, mode === 'Absolute Frame' ? fi : f) ?? [0, 0];
  let [x, y] = cur;
  if (mode === 'Relative Start') {
    const s = trackPos(clip, t, t.markers[0].frame) ?? [0, 0];
    x -= s[0];
    y -= s[1];
  } else if (mode === 'Relative Frame') {
    const s = trackPos(clip, t, fi) ?? [0, 0];
    x -= s[0];
    y -= s[1];
  }
  const at = (k: number) => {
    const m = t.markers.find((mk) => mk.frame === k && !mk.mute);
    return m ? [m.co[0] * clip.size[0], m.co[1] * clip.size[1]] : null;
  };
  const here = at(f),
    prev = at(f - 1),
    next = at(f + 1);
  const speed: [number, number, number, number] = [
    here && prev ? prev[0] - here[0] : 0,
    here && prev ? prev[1] - here[1] : 0,
    here && next ? here[0] - next[0] : 0,
    here && next ? here[1] - next[1] : 0,
  ];
  return { x, y, speed };
}

registerExec('CompositorNodeTrackPos', (x) => {
  const clip = nodeClip(x);
  if (!clip) {
    x.out('X', Result.single('FLOAT', 0));
    x.out('Y', Result.single('FLOAT', 0));
    x.out('Speed', Result.single('VECTOR', [0, 0, 0, 0]));
    return;
  }
  const r = trackPosition(clip, x.str('track_name'), menuValue(x.node, 'Mode') || 'Absolute', x.env.frame, Math.round(x.num('Frame')));
  x.out('X', Result.single('FLOAT', r.x));
  x.out('Y', Result.single('FLOAT', r.y));
  x.out('Speed', Result.single('VECTOR', r.speed));
});

// ---------------------------------------------------------------------------
// Keying Screen: screen colour interpolated from the footage under the tracks

const MAX_SAMPLES = 64;
const SCREEN = `
uniform vec4 u_pts[${MAX_SAMPLES}];
uniform vec4 u_cols[${MAX_SAMPLES}];
uniform int u_n;
uniform float u_power;
layout(location = 0) out vec4 o0;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < ${MAX_SAMPLES}; i++) {
    if (i >= u_n) break;
    float d = distance(p, u_pts[i].xy);
    if (d < 1e-3) { acc = u_cols[i].rgb; wsum = 1.0; break; }
    float w = 1.0 / pow(d, u_power);
    acc += u_cols[i].rgb * w;
    wsum += w;
  }
  o0 = vec4(wsum > 0.0 ? acc / wsum : vec3(0.0), 1.0);
}`;

registerExec('CompositorNodeKeyingScreen', (x) => {
  const clip = nodeClip(x);
  if (!clip) return x.out('Screen', Result.single('RGBA', [0, 0, 0, 1]));
  const f = clipFrame(x, clip);
  const fr = frameTexture(x, clip, f);
  if (!fr) {
    x.error('Loading footage…');
    return x.out('Screen', Result.single('RGBA', [0, 0, 0, 1]));
  }
  const pixels = x.gpu.read(fr.tex);
  const pts: number[] = [],
    cols: number[] = [];
  for (const t of clip.tracking.tracks) {
    const m = enabledMarkerAt(t, f);
    if (!m || pts.length / 4 >= MAX_SAMPLES) continue;
    // average colour of the pattern area
    const cx = m.co[0] * fr.w,
      cy = m.co[1] * fr.h;
    const rx = Math.max(1, Math.abs(m.pattern_corners[1][0] - m.pattern_corners[0][0]) * fr.w * 0.5),
      ry = Math.max(1, Math.abs(m.pattern_corners[2][1] - m.pattern_corners[1][1]) * fr.h * 0.5);
    let r = 0,
      g = 0,
      b = 0,
      n = 0;
    for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(fr.h - 1, Math.ceil(cy + ry)); y++)
      for (let xx = Math.max(0, Math.floor(cx - rx)); xx <= Math.min(fr.w - 1, Math.ceil(cx + rx)); xx++) {
        const k = (y * fr.w + xx) * 4;
        r += pixels[k];
        g += pixels[k + 1];
        b += pixels[k + 2];
        n++;
      }
    if (!n) continue;
    pts.push(cx, cy, 0, 0);
    cols.push(r / n, g / n, b / n, 1);
  }
  if (!pts.length) return x.out('Screen', Result.single('RGBA', [0, 0, 0, 1]));
  const d: Domain = { w: fr.w, h: fr.h, xf: ident() };
  const t = x.alloc(d);
  const smooth = Math.min(1, Math.max(0, x.num('Smoothness')));
  x.pass('keying-screen', SCREEN, t, {
    u_pts: new Float32Array(pts.concat(new Array(MAX_SAMPLES * 4 - pts.length).fill(0))),
    u_cols: new Float32Array(cols.concat(new Array(MAX_SAMPLES * 4 - cols.length).fill(0))),
    u_n: pts.length / 4,
    u_power: 6 - 5 * smooth,
  });
  x.out('Screen', Result.image('RGBA', t, d));
});

// ---------------------------------------------------------------------------
// Node bodies: clip selector (and track selector for Track Position)

function clipSelector(n: NodeData) {
  return idSelector(n, 'clip', { items: () => Object.values(clipTable(app.doc)), icon: 'tracker', kind: 'Movie Clip' });
}

for (const id of ['CompositorNodeMovieClip', 'CompositorNodeMovieDistortion', 'CompositorNodeStabilize', 'CompositorNodeKeyingScreen']) {
  const d = getNodeType(id);
  if (!d) continue;
  d.bodyHeight = () => 26;
  d.drawBody = (ctx) => clipSelector(ctx.node);
}
{
  const d = getNodeType('CompositorNodeTrackPos');
  if (d) {
    d.props = d.props.filter((p) => p.id !== 'track_name');
    d.bodyHeight = () => 52;
    d.drawBody = (ctx) => {
      const n = ctx.node;
      const clip = (n.props.clip as string | null) ? clipTable(app.doc)[n.props.clip as string] : undefined;
      const tracks = clip?.tracking.tracks ?? [];
      return h(
        'div',
        { class: 'cmp-body-col' },
        clipSelector(n),
        enumMenu(
          `${ctx.key}:track`,
          [{ value: '', label: 'Track' }, ...tracks.map((t) => ({ value: t.name, label: t.name, icon: 'tracker' }))],
          String(n.props.track_name ?? ''),
          (v) => ((n.props.track_name = v), nodeChanged('Track')),
          { title: 'Track' },
        ),
      );
    };
  }
}

// One compositing run: evaluate the scene's compositing tree on the GPU and read back the
// composite (render size) and the active Viewer image, plus an 8-bit display copy of the viewer
// for the node editor backdrop.
import type { DocumentData, NodeData, NodeTreeData } from '../data/types';
import { renderSize } from '../render/final/units';
import { displayGLSL, VIEW_INDEX, type ViewSettings } from '../render/final/colormanage';
import { gpu, type Gpu, type Texture } from './gpu/gpu';
import { Evaluator, type LayerSource } from './eval/evaluator';
import { Result, boundingDomain, IDENTITY, type Domain, type Xform } from './eval/result';
import { beginGeneration, sweepCache } from './eval/cache';
import { compositingGroup } from './data';

export interface ImageOut {
  /** top-down premultiplied RGBA */
  data: Float32Array;
  width: number;
  height: number;
}

export interface RunResult {
  composite: ImageOut | null;
  viewer: (ImageOut & { node: string; display: HTMLCanvasElement | null }) | null;
  errors: Map<string, string>;
  evaluated: Set<string>;
  /** milliseconds */
  time: number;
  error?: string;
}

export interface RunOptions {
  layers: LayerSource | null;
  composite: boolean;
  viewer: boolean;
  /** viewer node id (falls back to the first viewer) */
  viewerNode?: string | null;
  /** display transform for the viewer backdrop copy */
  view?: ViewSettings;
}

/** The viewer node a run evaluates: the active node when it is a viewer, else the given one or the first. */
export function pickViewer(tree: NodeTreeData, preferred?: string | null): NodeData | null {
  const viewers = tree.nodes.filter((n) => n.type === 'CompositorNodeViewer' && !n.mute);
  if (!viewers.length) return null;
  const act = tree.active_node ? viewers.find((n) => n.id === tree.active_node) : undefined;
  return act ?? viewers.find((n) => n.id === preferred) ?? viewers[0];
}

const FLIP_PASS = `
uniform sampler2D u_src;
layout(location = 0) out vec4 o0;
void main() { ivec2 s = textureSize(u_src, 0); ivec2 p = ivec2(gl_FragCoord.xy); o0 = texelFetch(u_src, ivec2(p.x, s.y - 1 - p.y), 0); }`;

const DISPLAY_PASS = `${displayGLSL}
uniform sampler2D u_src;
uniform int u_view;
uniform float u_exposure;
uniform float u_invGamma;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = cmDisplay(texelFetch(u_src, p, 0), u_view, u_exposure, u_invGamma);
  o0 = c;
}`;

function readTopDown(g: Gpu, ev: Evaluator, t: Texture): Float32Array {
  const f = ev.alloc(t.w, t.h, 'flip');
  ev.pass('flip', FLIP_PASS, f, { u_src: t });
  return g.read(f);
}

/** Display-encoded copy of a texture as an 8-bit canvas (straight alpha). */
function displayCanvas(g: Gpu, t: Texture, view: ViewSettings): HTMLCanvasElement {
  const prog = g.program('display', DISPLAY_PASS);
  g.present(prog, t.w, t.h, {
    u_src: t,
    u_view: VIEW_INDEX[view.view_transform] ?? 0,
    u_exposure: Math.pow(2, view.exposure),
    u_invGamma: view.gamma > 0 ? 1 / view.gamma : 1,
  });
  const c = document.createElement('canvas');
  c.width = t.w;
  c.height = t.h;
  // GL row 0 is the bottom of the canvas, which matches the texture's bottom-up rows
  c.getContext('2d')!.drawImage(g.canvas, 0, 0);
  return c;
}

export function runCompositor(doc: DocumentData, opts: RunOptions): RunResult {
  const t0 = performance.now();
  const res: RunResult = {
    composite: null,
    viewer: null,
    errors: new Map(),
    evaluated: new Set(),
    time: 0,
  };
  const group = compositingGroup(doc);
  if (!group) return res;
  const g = gpu();
  if (!g) {
    res.error = 'The compositor needs WebGL 2 with float render targets';
    return res;
  }
  const [W, H] = renderSize(doc.scene.render);
  const fps = doc.scene.render.fps / (doc.scene.render.fps_base || 1);
  beginGeneration();
  const ev = new Evaluator(g, {
    doc,
    renderSize: [W, H],
    frame: doc.scene.frame_current,
    fps,
    layers: opts.layers,
    viewer: opts.viewerNode ?? null,
    composite: opts.composite,
  });
  const tree = group.tree;
  try {
    const full: Domain = { w: W, h: H, xf: [...IDENTITY] as Xform };
    if (opts.composite) {
      const r = ev.compositeOutput(tree);
      if (r) {
        const t = ev.realize(r, full);
        res.composite = { data: readTopDown(g, ev, t), width: W, height: H };
      }
    }
    if (opts.viewer) {
      const v = pickViewer(tree, opts.viewerNode);
      if (v) {
        const r: Result = ev.viewerOutput(tree, v);
        const d = r.domain ? boundingDomain(r.domain) : full;
        const t = ev.realize(r, d);
        res.viewer = {
          data: readTopDown(g, ev, t),
          width: d.w,
          height: d.h,
          node: v.id,
          display: opts.view ? displayCanvas(g, t, opts.view) : null,
        };
      }
    }
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e);
    console.error('Compositor:', e);
  } finally {
    for (const [k, v] of ev.errors) res.errors.set(k, v);
    for (const id of ev.evaluated) res.evaluated.add(id);
    ev.finish();
    sweepCache(g);
  }
  res.time = performance.now() - t0;
  return res;
}

/**
 * Run a compositing node group on one image: the first color input of the group's interface
 * receives the image (premultiplied float RGBA, rows bottom-up) and the result of its Group
 * Output is read back the same way at the same size. Returns null without WebGL 2 or output.
 */
export function runCompositorGroup(doc: DocumentData, group: { tree: NodeTreeData }, image: { data: Float32Array; width: number; height: number }, frame = doc.scene.frame_current): { data: Float32Array; errors: Map<string, string> } | null {
  const g = gpu();
  if (!g) return null;
  const { width: W, height: H } = image;
  const fps = doc.scene.render.fps / (doc.scene.render.fps_base || 1);
  beginGeneration();
  const full: Domain = { w: W, h: H, xf: [...IDENTITY] as Xform };
  const input = (group.tree.interface ?? []).find((i) => i.in_out === 'INPUT' && /Color/.test(i.socket_type));
  const ev = new Evaluator(g, { doc, renderSize: [W, H], frame, fps, layers: null, viewer: null, composite: true, groupInputs: {} });
  try {
    if (input) {
      const tex = g.upload(image.data, W, H, 'strip');
      ev.env.groupInputs![input.identifier] = Result.image('RGBA', tex, full);
      ev.keep(tex);
      try {
        const r = ev.compositeOutput(group.tree);
        if (!r) return null;
        const t = ev.realize(r, full);
        return { data: g.read(t), errors: new Map(ev.errors) };
      } finally {
        g.free(tex);
      }
    }
    const r = ev.compositeOutput(group.tree);
    if (!r) return null;
    return { data: g.read(ev.realize(r, full)), errors: new Map(ev.errors) };
  } finally {
    ev.finish();
    sweepCache(g);
  }
}

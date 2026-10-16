// Compositor integration: composites final renders (render job post-process hook), keeps the
// "Viewer Node" image, and re-composites the last render live (debounced) while the tree or the
// relevant scene settings change.
import { app, onAppReady } from '../app/app';
import type { DocumentData, NodeTreeData } from '../data/types';
import { renderResult, renderPostHooks, virtualImages, touchVirtualImage, type RenderResult, type PassName } from '../render/final/result';
import { renderJob, finalRenderHooks } from '../render/final/job';
import { runCompositor, pickViewer, type RunResult } from './run';
import { compositingActive, compositingGroup } from './data';
import { imageKey, setImageDecodedCallback } from './eval/cache';
import type { LayerSource } from './eval/evaluator';

export const VIEWER_IMAGE = '__viewer_node__';

export interface CompositorState {
  viewer: RunResult['viewer'];
  /** bumped whenever the viewer image changes */
  version: number;
  errors: Map<string, string>;
  evaluated: Set<string>;
  error?: string;
  time: number;
  /** viewer node used by the last run */
  viewerNode: string | null;
  running: boolean;
}

export const compositorState: CompositorState = {
  viewer: null,
  version: 0,
  errors: new Map(),
  evaluated: new Set(),
  time: 0,
  viewerNode: null,
  running: false,
};

const listeners = new Set<() => void>();
export function onCompositorUpdate(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------
// render result bookkeeping

/** Results of final renders (only those are composited). */
const finalResults = new WeakSet<RenderResult>();
const arrayIds = new WeakMap<Float32Array, number>();
let nextArrayId = 1;
const idOf = (a: Float32Array) => {
  let id = arrayIds.get(a);
  if (!id) arrayIds.set(a, (id = nextArrayId++));
  return id;
};

function rawPasses(r: RenderResult): Partial<Record<PassName, Float32Array>> {
  return r.viewLayer ?? r.passes;
}

function sourceOf(r: RenderResult, passes: Partial<Record<PassName, Float32Array>>): LayerSource {
  return {
    width: r.width,
    height: r.height,
    version: `${idOf(passes.Combined!)}|${passes.Depth ? idOf(passes.Depth) : 0}|${passes.Normal ? idOf(passes.Normal) : 0}|${passes.Mist ? idOf(passes.Mist) : 0}`,
    passes,
  };
}

function layersOf(r: RenderResult | null): LayerSource | null {
  if (!r) return null;
  const passes = rawPasses(r);
  if (!passes.Combined) return null;
  const src = sourceOf(r, passes);
  // every rendered view layer, for Render Layers nodes that pick a scene / layer
  if (r.layers?.length) src.named = Object.fromEntries(r.layers.filter((l) => l.passes.Combined).map((l) => [`${l.scene}/${l.name}`, sourceOf(r, l.passes)]));
  return src;
}

/** View layers of other scenes that the compositing tree reads (rendered with each frame). */
finalRenderHooks.extraLayers = () => {
  const doc = app.doc;
  const g = compositingGroup(doc);
  if (!g || !compositingActive(doc)) return [];
  const out: { scene: string; layer: string }[] = [];
  const visit = (tree: NodeTreeData, depth: number) => {
    for (const n of tree.nodes) {
      if (n.type === 'CompositorNodeRLayers' && n.props.scene && n.props.scene !== doc.scene.id && !n.mute) out.push({ scene: String(n.props.scene), layer: String(n.props.layer ?? '') });
      const sub = n.props.node_tree ? doc.node_groups[String(n.props.node_tree)] : undefined;
      if (sub && depth < 8) visit(sub.tree, depth + 1);
    }
  };
  visit(g.tree, 0);
  return out;
};

function sceneView() {
  const r = app.doc.scene.render;
  return {
    view_transform: r.view_transform,
    exposure: r.exposure,
    gamma: r.gamma,
  };
}

/** Apply a run's outputs: composite into the render result, viewer into the Viewer Node image. */
function apply(out: RunResult, result: RenderResult | null, composite: boolean) {
  compositorState.errors = out.errors;
  compositorState.evaluated = out.evaluated;
  compositorState.error = out.error;
  compositorState.time = out.time;
  if (out.viewer) {
    compositorState.viewer = out.viewer;
    compositorState.viewerNode = out.viewer.node;
  } else compositorState.viewer = null;
  compositorState.version++;
  viewerResult = null;
  if (result && composite) {
    const raw = rawPasses(result);
    if (out.composite && out.composite.width === result.width && out.composite.height === result.height) {
      result.viewLayer = raw;
      result.passes = { ...raw, Combined: out.composite.data };
    } else if (result.viewLayer) {
      result.passes = result.viewLayer;
      delete result.viewLayer;
    }
  }
  touchVirtualImage(VIEWER_IMAGE);
  for (const fn of listeners) fn();
}

/** Restore the raw render passes when compositing is disabled. */
function uncomposite(result: RenderResult | null) {
  if (result?.viewLayer) {
    result.passes = result.viewLayer;
    delete result.viewLayer;
    renderResult.touch();
  }
}

// final renders
renderPostHooks.push((r, ctx) => {
  if (!ctx.final) return;
  finalResults.add(r);
  const doc = app.doc;
  if (!compositingGroup(doc)) return;
  const active = compositingActive(doc);
  const out = runCompositor(doc, {
    layers: layersOf(r),
    composite: active,
    viewer: true,
    viewerNode: compositorState.viewerNode,
    view: sceneView(),
  });
  lastSignature = signature(doc);
  apply(out, r, active);
});

// ---------------------------------------------------------------------------
// live updates

let lastSignature = '';
let timer = 0;
let pending = false;

const SKIP = new Set(['select', 'location', 'hide', 'open_panels', 'view', 'active_node', 'width', 'hidden_sockets', 'hide_options', 'use_custom_color', 'color', 'label', 'parent', 'name']);

function resultKey() {
  const r = renderResult.get();
  if (!r) return 'none';
  if (!finalResults.has(r)) return 'other';
  return r.rendering ? 'rendering' : (layersOf(r)?.version ?? 'empty');
}

/** Everything the composite depends on, minus pure UI state. */
export function signature(doc: DocumentData): string {
  const g = compositingGroup(doc);
  if (!g) return 'none';
  const groups = new Set<string>();
  const images = new Set<string>();
  const walk = (t: typeof g.tree, depth: number) => {
    for (const n of t.nodes) {
      const ng = n.props.node_tree as string | undefined;
      if (ng && !groups.has(ng) && doc.node_groups[ng] && depth < 32) {
        groups.add(ng);
        walk(doc.node_groups[ng].tree, depth + 1);
      }
      const im = n.props.image as string | undefined;
      if (im && doc.images[im]) images.add(imageKey(doc.images[im]));
    }
  };
  walk(g.tree, 0);
  const r = doc.scene.render;
  const viewer = pickViewer(g.tree, compositorState.viewerNode);
  return JSON.stringify(
    [
      g.tree.nodes,
      g.tree.links,
      g.tree.interface,
      [...groups].map((id) => doc.node_groups[id].tree),
      [...images],
      viewer?.id ?? null,
      [r.resolution_x, r.resolution_y, r.resolution_percentage, r.use_compositing, r.use_pass_z, r.use_pass_normal, r.use_pass_mist, r.view_transform, r.exposure, r.gamma, r.fps, r.fps_base],
      doc.scene.use_nodes,
      doc.scene.frame_current,
      resultKey(),
    ],
    (k, v) => (SKIP.has(k) ? undefined : v),
  );
}

/** Re-run the compositor on the last render (and refresh the viewer). */
export function recomposite(force = false) {
  const doc = app.doc;
  const sig = signature(doc);
  if (!force && sig === lastSignature) return;
  if (renderJob()) {
    // a render is running: try again afterwards
    schedule();
    return;
  }
  lastSignature = sig;
  const r = renderResult.get();
  const final = r && finalResults.has(r) && !r.rendering ? r : null;
  if (!compositingGroup(doc)) {
    uncomposite(final);
    if (compositorState.viewer) {
      compositorState.viewer = null;
      compositorState.version++;
      viewerResult = null;
      touchVirtualImage(VIEWER_IMAGE);
      for (const fn of listeners) fn();
    }
    return;
  }
  const active = compositingActive(doc);
  if (!active) uncomposite(final);
  compositorState.running = true;
  const out = runCompositor(doc, {
    layers: layersOf(final ?? (r && !r.rendering && finalResults.has(r) ? r : null)),
    composite: active && !!final,
    viewer: true,
    viewerNode: compositorState.viewerNode,
    view: sceneView(),
  });
  compositorState.running = false;
  apply(out, final, active && !!final);
  if (final && active) renderResult.touch();
}

/** Debounced live update. */
export function schedule(delay = 40) {
  if (pending) return;
  pending = true;
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    pending = false;
    requestAnimationFrame(() => recomposite());
  }, delay);
}

// the app instance exists only after the feature modules are imported
function connect() {
  app.subscribe((kinds) => {
    if (kinds.has('doc') || kinds.has('frame') || kinds.has('ui') || kinds.has('select')) {
      if (!compositingGroup(app.doc) && !compositorState.viewer) return;
      schedule();
    }
  });
}
onAppReady(connect);
renderResult.subscribe((pixels) => {
  if (pixels) schedule(80);
});
setImageDecodedCallback(() => recomposite(true));

// ---------------------------------------------------------------------------
// "Viewer Node" image

let viewerResult: RenderResult | null = null;
virtualImages.set(VIEWER_IMAGE, {
  id: VIEWER_IMAGE,
  label: 'Viewer Node',
  icon: 'node_compositing',
  get: () => {
    const v = compositorState.viewer;
    if (!v) return null;
    if (!viewerResult)
      viewerResult = {
        width: v.width,
        height: v.height,
        passes: { Combined: v.data },
        filmTransparent: true,
        info: {
          frame: app.doc.scene.frame_current,
          time: compositorState.time / 1000,
          engine: 'Compositor',
          camera: '',
          scene: app.doc.scene.name,
        },
        version: compositorState.version,
        rendering: false,
      };
    return viewerResult;
  },
});

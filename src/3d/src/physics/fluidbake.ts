// Fluid baking: the fluid.bake_* / fluid.free_* operators and the bake job. A bake fills the domain's
// data cache frame by frame (evaluating the scene so flows and effectors move), then the derived
// layers (noise, surface mesh, secondary particles) from those frames. Interactive bakes run in the
// background with progress in the status bar and can be paused (and resumed when the cache is
// resumable); script / test calls run to completion at once.
import { app, registerOperators, type OpContext } from '../app/app';
import type { DocumentData, ObjectData } from '../data/types';
import { statusWidgets } from '../ui/shell';
import { h } from '../ui/h';
import { icon } from '../ui/icons';
import { caches, freeCache, startBudget, type FrameCache } from './common';
import { computeNoise, defaultDomainSettings, fluidCacheKey, guideFieldFor, type FluidFrame, type FluidLive, type FluidModifier } from './fluid';
import { buildLiquidSurface, fluidShared, secondaryEnabled, stepSecondaryLayer, type LiquidFrame, type LiquidLive } from './liquid';
import { baseEvalMesh } from '../eval/depsgraph';
import { fluidJob, fluidLayers, freeFluidLayers, setFluidJob, type FluidJob, type FluidLayer } from './fluidcache';
import { physicsState } from './runtime';

const LABELS: Record<FluidLayer, string> = { data: 'Data', noise: 'Noise', mesh: 'Mesh', particles: 'Particles', guide: 'Guides' };

/** The fluid domain modifier of an object (or of the active object). */
export function domainOf(ob: ObjectData | null | undefined): FluidModifier | undefined {
  const m = ob?.modifiers.find((x) => x.type === 'FLUID') as FluidModifier | undefined;
  return m && m.fluid_type === 'DOMAIN' ? m : undefined;
}

const activeDomain = () => {
  const ob = app.activeObject;
  const m = domainOf(ob);
  return ob && m ? { ob, m } : null;
};

const settings = (m: FluidModifier) => {
  const d = defaultDomainSettings() as unknown as Record<string, unknown>;
  const s = m.domain_settings as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(d)) if (s[k] === undefined) s[k] = v;
  return m.domain_settings;
};

/** Layers that make sense for this domain (in bake order). */
export function domainLayers(m: FluidModifier): FluidLayer[] {
  const s = settings(m);
  const out: FluidLayer[] = [];
  if (s.use_guide && (s.guide_source ?? 'DOMAIN') === 'EFFECTOR') out.push('guide');
  out.push('data');
  if (s.domain_type === 'GAS' && s.use_noise) out.push('noise');
  if (s.domain_type === 'LIQUID' && s.use_mesh !== false) out.push('mesh');
  if (s.domain_type === 'LIQUID' && secondaryEnabled(s)) out.push('particles');
  return out;
}

const flagKey = (l: FluidLayer) => `has_cache_baked_${l}` as const;
const pauseKey = (l: FluidLayer) => `cache_frame_pause_${l}` as const;

function setFlag(m: FluidModifier, l: FluidLayer, baked: boolean, pause = 0) {
  const s = m.domain_settings as unknown as Record<string, unknown>;
  s[flagKey(l)] = baked;
  s[pauseKey(l)] = pause;
  // the point cache's baked flag protects the data frames from being re-simulated
  if (l === 'data') m.point_cache.is_baked = baked || pause > 0;
}

/** Free a layer (freeing the data frees everything derived from it). */
export function freeLayer(ob: ObjectData, m: FluidModifier, l: FluidLayer) {
  const key = fluidCacheKey(ob, m);
  const j = fluidJob();
  if (j && j.key === key) setFluidJob(null);
  if (l === 'data') {
    freeCache(key);
    freeFluidLayers(key);
    for (const x of ['data', 'noise', 'mesh', 'particles'] as FluidLayer[]) setFlag(m, x, false);
  } else {
    freeFluidLayers(key, l);
    setFlag(m, l, false);
  }
}

// ---------------------------------------------------------------------------
// Job steps

/** Compute one frame of the running layer. Returns false when the layer cannot go on. */
function stepFrame(doc: DocumentData, ob: ObjectData, m: FluidModifier, j: FluidJob): boolean {
  const key = j.key;
  const f = j.frame;
  const s = settings(m);
  if (j.layer === 'data') {
    const cur = doc.scene.frame_current,
      sub = doc.scene.frame_subframe;
    // the cache offset shifts playback only; bakes always fill the cache's own frames
    const off = Math.round(s.cache_frame_offset ?? 0);
    try {
      doc.scene.frame_current = f + off;
      doc.scene.frame_subframe = 0;
      app.graph.evaluate(doc);
    } finally {
      doc.scene.frame_current = cur;
      doc.scene.frame_subframe = sub;
    }
    return caches.get(key)?.frames.has(f) ?? false;
  }
  const cache = caches.get(key) as FrameCache<FluidFrame & LiquidFrame, FluidLive & LiquidLive> | undefined;
  const fr = cache?.frames.get(f);
  const L = fluidLayers(key);
  if (j.layer === 'noise') {
    if (!fr || !cache?.live) return false;
    L.noise.set(f, computeNoise(fr, cache.live, { ...defaultDomainSettings(), ...s }, f));
    return true;
  }
  if (j.layer === 'mesh') {
    if (!fr || !cache?.live) return false;
    L.mesh.set(f, buildLiquidSurface({ frame: fr, live: cache.live }, { ...defaultDomainSettings(), ...s }));
    return true;
  }
  if (j.layer === 'particles') {
    if (!cache) return false;
    return stepSecondaryLayer(L, s, cache as unknown as FrameCache<LiquidFrame, LiquidLive>, f);
  }
  if (j.layer === 'guide') {
    const G = cache?.live?.G ?? guideGrid(doc, ob, m);
    if (!G) return false;
    const field = guideFieldFor({ doc, graph: null }, ob, { ...m, domain_settings: { ...s, use_guide: true } } as FluidModifier, G, f, '');
    L.guide.set(f, field ?? new Float32Array(G.nx * G.ny * G.nz * 4));
    return true;
  }
  return false;
}

/** Grid placement for baking guides before any data exists (the same the data bake will use). */
function guideGrid(doc: DocumentData, ob: ObjectData, m: FluidModifier) {
  const me = ob.data ? doc.meshes[ob.data] : undefined;
  const F = fluidShared.fns;
  if (!me || !F) return null;
  const s = { ...defaultDomainSettings(), ...m.domain_settings };
  const res = s.domain_type === 'LIQUID' ? Math.min(128, Math.max(8, s.resolution_max)) : Math.min(256, Math.max(8, s.resolution_max));
  return F.gridFrame({ doc, graph: null }, ob, baseEvalMesh(me), res, m.point_cache.frame_start).G;
}

function finishLayer(m: FluidModifier, j: FluidJob, complete: boolean) {
  if (complete) setFlag(m, j.layer, true, 0);
  else setFlag(m, j.layer, true, Math.max(j.start, j.frame - 1));
}

/** Start (or resume) baking `layers` of a domain. */
function startJob(ob: ObjectData, m: FluidModifier, layers: FluidLayer[], resume: boolean): FluidJob | null {
  if (!layers.length) return null;
  const key = fluidCacheKey(ob, m);
  const pc = m.point_cache;
  const first = layers[0];
  const s = m.domain_settings as unknown as Record<string, number>;
  const paused = resume ? s[pauseKey(first)] || 0 : 0;
  if (!paused) {
    if (first === 'data') {
      freeCache(key);
      freeFluidLayers(key);
    } else freeFluidLayers(key, first as Exclude<FluidLayer, 'data'>);
  }
  setFlag(m, first, false, 0);
  if (first === 'data') pc.is_baked = false;
  const start = first === 'particles' ? pc.frame_start + 1 : pc.frame_start;
  const j: FluidJob = { key, objectId: ob.id, modifierId: m.id, queue: layers.slice(1), layer: first, start, end: pc.frame_end, frame: paused ? paused + 1 : start, paused: false, cancelled: false, started: performance.now() };
  setFluidJob(j);
  return j;
}

/** Move to the next queued layer; false when the job is done. */
function nextLayer(m: FluidModifier, j: FluidJob): boolean {
  const l = j.queue.shift();
  if (!l) return false;
  j.layer = l;
  freeFluidLayers(j.key, l as Exclude<FluidLayer, 'data'>);
  setFlag(m, l, false, 0);
  j.start = l === 'particles' ? m.point_cache.frame_start + 1 : m.point_cache.frame_start;
  j.frame = j.start;
  return true;
}

/** Run a whole job now (scripts, tests). */
function runSync(doc: DocumentData, ob: ObjectData, m: FluidModifier, j: FluidJob): number {
  let frames = 0;
  physicsState.baking = true;
  startBudget(Infinity);
  try {
    for (;;) {
      for (; j.frame <= j.end; j.frame++) {
        if (!stepFrame(doc, ob, m, j)) break;
        frames++;
      }
      finishLayer(m, j, j.frame > j.end);
      if (j.frame <= j.end || !nextLayer(m, j)) break;
    }
  } finally {
    physicsState.baking = false;
    setFluidJob(null);
  }
  app.graph.evaluate(doc);
  return frames;
}

/** Run a job in the background, a few frames per tick, until done, paused or cancelled. */
function runAsync(ob: ObjectData, m: FluidModifier, j: FluidJob, label: string) {
  const tick = () => {
    if (fluidJob() !== j) return;
    const doc = app.doc;
    // the document may have been replaced (undo, file load): stop
    const live = doc.objects[ob.id];
    const mod = live?.modifiers.find((x) => x.id === m.id) as FluidModifier | undefined;
    if (!live || !mod) {
      setFluidJob(null);
      app.changed('ui');
      return;
    }
    if (j.paused || j.cancelled) {
      finishLayer(mod, j, false);
      setFluidJob(null);
      app.report('INFO', `Fluid bake paused at frame ${Math.max(j.start, j.frame - 1)}`);
      app.changed('doc', 'frame', 'ui');
      return;
    }
    const t0 = performance.now();
    physicsState.baking = true;
    startBudget(Infinity);
    let failed = false;
    try {
      while (j.frame <= j.end && performance.now() - t0 < 40) {
        if (!stepFrame(doc, live, mod, j)) {
          failed = true;
          break;
        }
        j.frame++;
      }
    } catch (e) {
      failed = true;
      app.report('ERROR', `Fluid bake failed: ${(e as Error).message}`);
    } finally {
      physicsState.baking = false;
    }
    if (failed || j.frame > j.end) {
      finishLayer(mod, j, !failed);
      if (failed || !nextLayer(mod, j)) {
        setFluidJob(null);
        const secs = ((performance.now() - j.started) / 1000).toFixed(2);
        if (!failed) app.report('INFO', `${label} finished in ${secs} s`);
        app.pushUndo(label);
        app.changed('doc', 'frame', 'ui');
        return;
      }
    }
    app.changed('frame', 'ui');
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
}

// ---------------------------------------------------------------------------
// Operators

type Target = { ob: ObjectData; m: FluidModifier };

function bakeOp(idname: string, label: string, description: string, layers: (m: FluidModifier) => FluidLayer[], poll: (t: Target) => boolean) {
  const run = (ctx: OpContext, async: boolean) => {
    const t = activeDomain();
    if (!t || fluidJob()) return 'CANCELLED' as const;
    const ls = layers(t.m);
    if (!ls.length) return 'CANCELLED' as const;
    const s = t.m.domain_settings as unknown as Record<string, number | boolean>;
    const resume = !!s.cache_resumable && !!s[pauseKey(ls[0])];
    const j = startJob(t.ob, t.m, ls, resume);
    if (!j) return 'CANCELLED' as const;
    if (!async) {
      const t0 = performance.now();
      const n = runSync(ctx.doc, t.ob, t.m, j);
      app.report('INFO', `${label}: ${n} frames in ${((performance.now() - t0) / 1000).toFixed(2)} s`);
      return 'FINISHED' as const;
    }
    runAsync(t.ob, t.m, j, label);
    app.changed('ui');
    // the job pushes its undo step when it ends
    return 'RUNNING_MODAL' as const;
  };
  return {
    idname,
    label,
    description,
    redo: false,
    poll: () => {
      const t = activeDomain();
      return !!t && !fluidJob() && poll(t);
    },
    exec: (ctx: OpContext) => run(ctx, false),
    invoke: (ctx: OpContext) => run(ctx, true),
  };
}

function freeOp(idname: string, label: string, description: string, layer: FluidLayer | 'all') {
  return {
    idname,
    label,
    description,
    redo: false,
    poll: () => !!activeDomain() && !fluidJob(),
    exec: () => {
      const t = activeDomain()!;
      if (layer === 'all' || layer === 'data') freeLayer(t.ob, t.m, 'data');
      else freeLayer(t.ob, t.m, layer);
      if (layer === 'all') freeLayer(t.ob, t.m, 'guide');
      app.changed('frame');
    },
  };
}

const gas = (t: Target) => settings(t.m).domain_type === 'GAS';
const liquid = (t: Target) => settings(t.m).domain_type === 'LIQUID';
const dataReady = (t: Target) => !!caches.get(fluidCacheKey(t.ob, t.m))?.frames.size && !!(settings(t.m).has_cache_baked_data || settings(t.m).cache_frame_pause_data);

registerOperators([
  bakeOp('fluid.bake_all', 'Bake All', 'Bake the whole fluid simulation: the data and everything derived from it', (m) => domainLayers(m), () => true),
  freeOp('fluid.free_all', 'Free All', 'Free the entire fluid simulation cache', 'all'),
  bakeOp('fluid.bake_data', 'Bake Data', 'Bake the fluid data (smoke grids or liquid particles)', () => ['data'], () => true),
  freeOp('fluid.free_data', 'Free Data', 'Free the fluid data and everything baked from it', 'data'),
  bakeOp('fluid.bake_noise', 'Bake Noise', 'Bake the high resolution noise of the smoke from the baked data', () => ['noise'], (t) => gas(t) && !!settings(t.m).use_noise && dataReady(t)),
  freeOp('fluid.free_noise', 'Free Noise', 'Free the baked noise', 'noise'),
  bakeOp('fluid.bake_mesh', 'Bake Mesh', 'Bake the liquid surface mesh from the baked data', () => ['mesh'], (t) => liquid(t) && settings(t.m).use_mesh !== false && dataReady(t)),
  freeOp('fluid.free_mesh', 'Free Mesh', 'Free the baked liquid surface', 'mesh'),
  bakeOp('fluid.bake_particles', 'Bake Particles', 'Bake the spray, foam and bubble particles from the baked data', () => ['particles'], (t) => liquid(t) && secondaryEnabled(settings(t.m)) && dataReady(t)),
  freeOp('fluid.free_particles', 'Free Particles', 'Free the baked spray, foam and bubble particles', 'particles'),
  bakeOp('fluid.bake_guides', 'Bake Guides', 'Bake the guiding velocities of the guide effectors', () => ['guide'], (t) => !!settings(t.m).use_guide && (settings(t.m).guide_source ?? 'DOMAIN') === 'EFFECTOR'),
  freeOp('fluid.free_guides', 'Free Guides', 'Free the baked guiding velocities', 'guide'),
  {
    idname: 'fluid.pause_bake',
    label: 'Pause Bake',
    description: 'Pause the running fluid bake (a resumable cache can continue it later)',
    undo: false,
    poll: () => !!fluidJob() && !fluidJob()!.paused,
    exec: () => {
      const j = fluidJob();
      if (!j) return 'CANCELLED';
      j.paused = true;
      app.changed('ui');
    },
  },
]);

// progress of a running fluid bake in the status bar
statusWidgets.push(() => {
  const j = fluidJob();
  if (!j) return null;
  const total = Math.max(1, j.end - j.start + 1);
  const done = Math.min(1, Math.max(0, (j.frame - j.start) / total));
  return h(
    'span',
    { key: 'fluid-job', class: 'sb-job', 'data-tip': `Baking fluid ${LABELS[j.layer]}: frame ${Math.min(j.frame, j.end)} of ${j.end}` },
    h('span', { class: 'sb-job-label' }, `Fluid ${LABELS[j.layer]}`),
    h('span', { class: 'sb-job-bar' }, h('span', { class: 'sb-job-fill', style: { width: `${(done * 100).toFixed(1)}%` } })),
    h('button', { class: 'sb-job-cancel', 'data-tip': 'Pause the bake', onclick: () => app.run('fluid.pause_bake') }, icon('pause')),
  );
});

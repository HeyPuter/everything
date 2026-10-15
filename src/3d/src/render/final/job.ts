// Final rendering: F12 still / Ctrl F12 animation, viewport renders, progress, cancel, passes.
import { Color, type Camera, type WebGLRenderTarget, type WebGLRenderer, Matrix4, Vector3, Vector4, type PerspectiveCamera } from 'three';
import { app, registerOperators } from '../../app/app';
import { renderContext } from '../context';
import { RenderScene, type BuildOptions } from './renderscene';
import { RasterRenderer, Accumulator, effectsFrom } from './raster';
import { PathTracerCore } from './pathtracer';
import { Denoiser } from './denoise';
import { floatTarget, normalDepthMaterial, renderOverride, renderAlbedo } from './gbuffer';
import { renderCamera, viewportCameraForAspect, jitterProjection, cameraDof, apertureSample, apertureJitter, regionRect, cropProjection, type PixelRect } from './camera';
import { renderSize, frameList, jitter, halton, shutterOffset, formatTime, frameFileName, filmTransparent, tileCount, expandRegion } from './units';
import { filterTable, sampleFilter } from './filter';
import { renderResult, passToRGBA8, encodeRGBA8, download, toBW, EXT, MIME, renderPostHooks, PASS_CHANNELS, type RenderResult, type FileFormat, type PassName } from './result';
import { studioEquirect } from './environment';
import { ZipWriter } from './zip';
import { createVideoWriter, type VideoWriter } from './webm';
import { drawViewport, type DrawView } from '../../editors/view3d/draw';
import { defaultOverlay, defaultShading, type Shading } from '../../editors/view3d/state';
import { NavCamera } from '../navcam';
import { activeView3D, type View3D } from '../../editors/view3d/view3d';
import { showRenderView } from './renderwindow';
import { shell, statusWidgets } from '../../ui/shell';
import { h } from '../../ui/h';
import { icon } from '../../ui/icons';
import type { ViewSettings } from './colormanage';
import { passesFromGuide } from './passes';
import { stampFields, burnStampOverlay, pngWithText } from './stamp';
import { animationRecorder } from './playback';
import { extraPasses, wantsExtraPasses } from './extrapasses';

type Source = { kind: 'final' } | { kind: 'viewport'; view: View3D };

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

class Cancelled extends Error {}

interface FrameOutput {
  combined: Float32Array;
  passes: Partial<Record<PassName, Float32Array>>;
  samples: number;
  maxSamples: number;
  /** display transform override (workbench / viewport-solid renders) */
  view?: ViewSettings;
}

// shared GPU resources for final renders
let finalCore: PathTracerCore | null = null;
const raster = new RasterRenderer(4);
const accum = new Accumulator();
const denoiser = new Denoiser();

export interface JobState {
  frame: number;
  frameIndex: number;
  frameCount: number;
  sample: number;
  maxSamples: number;
  started: number;
  phase: string;
  cancelled: boolean;
  animation: boolean;
}

let job: JobState | null = null;
export function renderJob(): JobState | null {
  return job;
}

/**
 * Post-processing pipelines that replace the frame render (the Video Sequencer when
 * Post Processing ▸ Sequencer is enabled and the scene has strips).
 */
export const finalRenderHooks: {
  /** true → frames come from `renderFrame` and the scene camera is not required */
  active?: () => boolean;
  renderFrame?: (frame: number, W: number, H: number) => Promise<{ combined: Float32Array; view?: ViewSettings }>;
  /** optional video writer (e.g. WebM with an audio track) */
  createVideoWriter?: (W: number, H: number, fps: number, frames: number[]) => Promise<VideoWriter | null>;
} = {};

/** Render the scene camera (or `cameraId`) at the evaluated frame from inside a running render job. */
export async function renderSceneForJob(W: number, H: number, cameraId?: string | null): Promise<{ combined: Float32Array; view?: ViewSettings }> {
  if (!job) throw new Error('No render job is running');
  const sc = app.doc.scene;
  const prev = sc.camera;
  if (cameraId) sc.camera = cameraId;
  try {
    return await renderFrame({ kind: 'final' }, W, H, () => {}, null);
  } finally {
    sc.camera = prev;
  }
}

let lastUi = 0;
function progress(force = false) {
  const now = performance.now();
  if (!force && now - lastUi < 250) return;
  lastUi = now;
  const r = renderResult.get();
  if (r && job) {
    r.info.status = statusText();
    r.info.time = (now - job.started) / 1000;
  }
  renderResult.touchInfo();
  shellStatus();
}

/** Refresh only the status bar (avoid re-drawing every editor while rendering). */
function shellStatus() {
  try {
    shell?.drawStatus();
  } catch {
    app.changed('ui');
  }
}

function statusText() {
  if (!job) return '';
  const parts = [`Frame:${job.frame}`];
  if (job.frameCount > 1) parts.push(`${job.frameIndex + 1}/${job.frameCount}`);
  parts.push(`Time:${formatTime((performance.now() - job.started) / 1000)}`);
  if (job.phase) parts.push(job.phase);
  if (job.maxSamples > 1) parts.push(`Sample ${Math.min(job.sample, job.maxSamples)}/${job.maxSamples}`);
  return parts.join(' | ');
}

/** Overall progress of the running job (0..1). */
export function jobProgress(j: JobState): number {
  const frame = j.maxSamples > 0 ? Math.min(1, j.sample / j.maxSamples) : 0;
  return Math.min(1, (j.frameIndex + frame) / Math.max(1, j.frameCount));
}

// progress bar with a cancel button in the status bar while a job runs
statusWidgets.push(() =>
  job
    ? h(
        'span',
        { key: 'render-job', class: 'sb-job', 'data-tip': statusText() },
        h('span', { class: 'sb-job-label' }, job.animation ? 'Render Animation' : 'Render'),
        h('span', { class: 'sb-job-bar' }, h('span', { class: 'sb-job-fill', style: { width: `${(jobProgress(job) * 100).toFixed(1)}%` } })),
        h('button', { class: 'sb-job-cancel', 'data-tip': 'Cancel the render (Esc)', onclick: () => cancelRender() }, icon('x')),
      )
    : null,
);

function check() {
  if (job?.cancelled) throw new Cancelled();
}

// ---------------------------------------------------------------------------
// GPU helpers

function readFloat(renderer: WebGLRenderer, rt: WebGLRenderTarget, W: number, H: number): Float32Array {
  const buf = new Float32Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  // flip to top-down rows
  const row = W * 4;
  const tmp = new Float32Array(row);
  for (let y = 0; y < H >> 1; y++) {
    const a = y * row,
      b = (H - 1 - y) * row;
    tmp.set(buf.subarray(a, a + row));
    buf.copyWithin(a, b, b + row);
    buf.set(tmp, b);
  }
  return buf;
}

function saveState(renderer: WebGLRenderer) {
  const st = {
    target: renderer.getRenderTarget(),
    scissor: renderer.getScissorTest(),
    viewport: renderer.getViewport(new Vector4()),
    tone: renderer.toneMapping,
    exposure: renderer.toneMappingExposure,
    shadows: renderer.shadowMap.enabled,
    clear: renderer.getClearColor(new Color()),
    clearAlpha: renderer.getClearAlpha(),
  };
  return () => {
    renderer.setRenderTarget(st.target);
    renderer.setScissorTest(st.scissor);
    renderer.setViewport(st.viewport);
    renderer.toneMapping = st.tone;
    renderer.toneMappingExposure = st.exposure;
    renderer.shadowMap.enabled = st.shadows;
    renderer.setClearColor(st.clear, st.clearAlpha);
    renderContext?.engine.requestDraw();
  };
}


// ---------------------------------------------------------------------------
// frame rendering

function cameraFor(src: Source, W: number, H: number, region: PixelRect | null): Camera | null {
  let cam: Camera | null;
  if (src.kind === 'final' || (src.view.cameraView && app.doc.scene.camera)) cam = renderCamera(app, W, H);
  else {
    const v = src.view;
    const nc = new NavCamera();
    nc.load(v.nav.serialize());
    nc.autoPersp = v.nav.autoPersp;
    nc.resize(W, H);
    nc.update();
    cam = viewportCameraForAspect(nc.camera, W / H);
  }
  if (cam && region) cropProjection(cam, region, W, H);
  return cam;
}

function engineFor(src: Source): 'RASTER' | 'PATHTRACE' | 'WORKBENCH' {
  const e = app.doc.scene.render.engine;
  if (src.kind === 'viewport' && src.view.shading.type !== 'RENDERED') return 'WORKBENCH';
  return e === 'SOLID' ? 'WORKBENCH' : e;
}


function buildOptions(src: Source, mode: 'raster' | 'pathtrace'): BuildOptions {
  const r = app.doc.scene.render;
  const realtime = mode === 'raster' ? { lightScale: r.direct_light_intensity ?? 1, envScale: r.indirect_light_intensity ?? 1 } : {};
  if (src.kind === 'final') return { mode, final: true, filmTransparent: filmTransparent(r), hideSurfaces: r.use_solid === false, ...realtime };
  const sh = src.view.shading;
  const ctx = renderContext!;
  return {
    mode,
    final: false,
    localView: src.view.localView,
    useSceneLights: sh.use_scene_lights_render,
    useSceneWorld: sh.use_scene_world_render,
    studio: sh.use_scene_world_render ? null : mode === 'pathtrace' ? { texture: studioEquirect(), intensity: sh.studiolight_intensity } : { texture: ctx.studio(), intensity: sh.studiolight_intensity },
    filmTransparent: r.film_transparent,
    ...realtime,
  };
}

/** Evaluate the scene at a (sub)frame without notifying the UI. */
function evaluateAt(frame: number) {
  const s = app.doc.scene;
  const f = Math.floor(frame);
  s.frame_current = f;
  s.frame_subframe = frame - f;
  app.evaluate();
}


async function renderFrame(src: Source, FW: number, FH: number, onPartial: (buf: Float32Array, samples: number) => void, region: PixelRect | null): Promise<FrameOutput> {
  const ctx = renderContext!;
  const renderer = ctx.engine.renderer;
  const doc = app.doc;
  const r = doc.scene.render;
  const engine = engineFor(src);
  // the render region renders only its pixels (the frame camera's projection is cropped)
  const W = region?.w ?? FW,
    H = region?.h ?? FH;
  let camera = cameraFor(src, FW, FH, region);
  if (!camera) throw new Error('No camera found in scene');
  const restore = saveState(renderer);
  const transparent = filmTransparent(r);
  const passesWanted = { z: r.use_pass_z, normal: r.use_pass_normal, mist: r.use_pass_mist };
  const needGuide = passesWanted.z || passesWanted.normal || passesWanted.mist || (engine === 'WORKBENCH' && transparent);
  try {
    let combined: Float32Array;
    let samples = 1,
      maxSamples = 1;
    let view: ViewSettings | undefined;
    let guideScene: RenderScene;
    if (engine === 'PATHTRACE') {
      const rs = new RenderScene('pathtrace');
      rs.build(app, buildOptions(src, 'pathtrace'));
      guideScene = rs;
      const core = (finalCore ??= new PathTracerCore(renderer));
      core.applySettings(r);
      core.setSize(W, H);
      core.setTiles(...tileCount(r, W, H));
      core.sync(rs, camera, Math.random());
      core.reset();
      maxSamples = Math.max(1, src.kind === 'final' ? r.samples : r.preview_samples);
      const timeLimit = src.kind === 'final' ? Math.max(0, r.time_limit ?? 0) : 0;
      const exposure = r.film_exposure ?? 1;
      const scale = (buf: Float32Array) => {
        if (exposure !== 1) for (let i = 0; i < buf.length; i += 4) (buf[i] *= exposure), (buf[i + 1] *= exposure), (buf[i + 2] *= exposure);
        return buf;
      };
      job!.maxSamples = maxSamples;
      job!.phase = 'Compiling shaders';
      progress(true);
      // let shader compilation start, then sample progressively with an adaptive batch size
      core.sample();
      while (core.isCompiling) {
        check();
        await nextFrame();
        core.sample();
      }
      job!.phase = 'Path Tracing';
      const traceStart = performance.now();
      let batch = 1;
      let lastPreview = performance.now();
      let previewCost = 100;
      let last = performance.now();
      while (core.samples < maxSamples) {
        check();
        for (let i = 0; i < batch && core.samples < maxSamples; i++) core.sample();
        job!.sample = core.samples;
        const now = performance.now();
        if (timeLimit > 0 && (now - traceStart) / 1000 >= timeLimit && core.samples > 0) break;
        if (now - lastPreview > Math.max(700, previewCost * 6)) {
          onPartial(scale(readFloat(renderer, core.renderTarget, W, H)), core.samples);
          lastPreview = performance.now();
          previewCost = lastPreview - now;
        }
        progress();
        await nextFrame();
        const dt = performance.now() - last;
        last = performance.now();
        if (dt < 34) batch = Math.min(64, batch + 1);
        else if (dt > 70 && batch > 1) batch--;
      }
      samples = core.samples;
      if (timeLimit > 0 && samples < maxSamples) maxSamples = samples;
      let resultRT: WebGLRenderTarget = core.renderTarget;
      const denoise = src.kind === 'final' ? r.use_denoising : r.preview_denoising !== false;
      if (denoise) {
        job!.phase = 'Denoising';
        progress(true);
        await nextFrame();
        const guide = floatTarget(W, H, { samples: 4 });
        const albedo = floatTarget(W, H, { half: true, samples: 4 });
        renderer.shadowMap.enabled = false;
        renderOverride(renderer, rs.scene, camera, guide, normalDepthMaterial);
        renderAlbedo(renderer, rs.scene, camera, albedo);
        denoiser.run(renderer, core.texture, guide.texture, albedo.texture, W, H, samples);
        resultRT = denoiser.out!;
        guide.dispose();
        albedo.dispose();
      }
      combined = scale(readFloat(renderer, resultRT, W, H));
    } else if (engine === 'RASTER') {
      const rs = new RenderScene('raster');
      const opts = buildOptions(src, 'raster');
      rs.build(app, opts);
      guideScene = rs;
      rs.configureShadows(renderer, doc);
      maxSamples = Math.max(1, r.raster_samples);
      job!.maxSamples = maxSamples;
      job!.phase = 'Rendering';
      accum.reset(W, H);
      const motion = r.use_motion_blur && src.kind === 'final' && r.motion_blur_shutter > 0;
      const frame = doc.scene.frame_current + (doc.scene.frame_subframe ?? 0);
      const fx = effectsFrom(r);
      fx.transparent = transparent;
      const table = filterTable('BLACKMAN_HARRIS', r.filter_size ?? 1.5);
      const lookThrough = src.kind === 'final' || src.view.cameraView;
      const dofFor = () => (lookThrough && r.use_bokeh_jittered !== false ? cameraDof(app) : null);
      let dof = dofFor();
      let base = (camera as PerspectiveCamera).projectionMatrix.clone();
      let basePos = camera.position.clone();
      let last = performance.now();
      for (let i = 0; i < maxSamples; i++) {
        check();
        if (motion) {
          evaluateAt(frame + shutterOffset(i, maxSamples, r.motion_blur_shutter, r.motion_blur_position ?? 'CENTER'));
          rs.build(app, opts);
          camera = cameraFor(src, FW, FH, region) ?? camera;
          base = (camera as PerspectiveCamera).projectionMatrix.clone();
          basePos = camera.position.clone();
          dof = dofFor();
        }
        // sub-pixel offset distributed like the pixel filter
        const jx = i === 0 ? 0 : sampleFilter(table, halton(i + 1, 2)),
          jy = i === 0 ? 0 : sampleFilter(table, halton(i + 1, 3));
        if (dof && maxSamples > 1) {
          const [ax, ay] = apertureSample(halton(i + 1, 5), halton(i + 1, 7), dof.blades, dof.rotation, dof.ratio);
          apertureJitter(camera, basePos, base, ax * dof.radius, ay * dof.radius, dof.focus);
          jitterProjection(camera, (camera as PerspectiveCamera).projectionMatrix.clone(), jx, jy, W, H);
        } else jitterProjection(camera, base, jx, jy, W, H);
        const tex = raster.render(renderer, rs.scene, camera, W, H, fx);
        accum.add(renderer, tex);
        job!.sample = i + 1;
        if (performance.now() - last > 30) {
          progress();
          await nextFrame();
          last = performance.now();
        }
      }
      if (motion) {
        evaluateAt(frame);
        rs.build(app, opts);
        camera = cameraFor(src, FW, FH, region) ?? camera;
      } else {
        camera.position.copy(basePos);
        camera.updateMatrixWorld(true);
        jitterProjection(camera, base, 0, 0, W, H);
      }
      samples = maxSamples;
      combined = readFloat(renderer, accum.target, W, H);
    } else {
      // workbench: the viewport's own drawing code with overlays disabled
      const shading: Shading = src.kind === 'viewport' ? { ...src.view.shading } : { ...defaultShading(), background_type: 'WORLD', ...(r.display_shading ?? {}) };
      if (shading.type === 'RENDERED') shading.type = 'MATERIAL';
      const nav = new NavCamera();
      if (src.kind === 'viewport') nav.load(src.view.nav.serialize());
      const dv: DrawView = {
        nav,
        shading,
        overlay: { ...defaultOverlay(), show_overlays: false },
        sceneCamera: camera,
        localView: src.kind === 'viewport' ? src.view.localView : null,
        idTarget: null,
        idDirty: true,
        width: W,
        height: H,
        extraOverlays: [],
        pathTracer: null,
      };
      const rt = floatTarget(W, H, { samples: 4 });
      maxSamples = src.kind === 'final' ? Math.max(1, Math.min(16, r.raster_samples)) : 8;
      job!.maxSamples = maxSamples;
      job!.phase = 'Rendering';
      accum.reset(W, H);
      const base = (camera as PerspectiveCamera).projectionMatrix.clone();
      for (let i = 0; i < maxSamples; i++) {
        check();
        const [jx, jy] = jitter(i);
        jitterProjection(camera, base, jx, jy, W, H);
        renderer.setScissorTest(false);
        renderer.setRenderTarget(rt);
        drawViewport(app, ctx, dv, 0, 0, W, H);
        accum.add(renderer, rt.texture);
        job!.sample = i + 1;
      }
      jitterProjection(camera, base, 0, 0, W, H);
      rt.dispose();
      combined = readFloat(renderer, accum.target, W, H);
      samples = maxSamples;
      // the solid/material viewport look is displayed like the viewport shows it
      view = shading.type === 'SOLID' || shading.type === 'WIREFRAME' ? { view_transform: 'STANDARD', exposure: 0, gamma: 1 } : undefined;
      guideScene = new RenderScene('raster');
      guideScene.build(app, buildOptions(src, 'raster'));
    }
    // data passes & alpha for workbench renders
    const passes: Partial<Record<PassName, Float32Array>> = {};
    if (needGuide) {
      const guide = floatTarget(W, H);
      renderer.shadowMap.enabled = false;
      renderOverride(renderer, guideScene.scene, camera, guide, normalDepthMaterial);
      const g = readFloat(renderer, guide, W, H);
      guide.dispose();
      const world = doc.scene.world ? doc.worlds[doc.scene.world] : null;
      const ortho = !!(camera as unknown as { isOrthographicCamera?: boolean }).isOrthographicCamera;
      Object.assign(
        passes,
        passesFromGuide(g, W, H, (camera as PerspectiveCamera).projectionMatrixInverse.elements, ortho, { start: world?.mist_start ?? 5, depth: world?.mist_depth ?? 25 }, passesWanted),
      );
      if (engine === 'WORKBENCH' && transparent) {
        for (let i = 0; i < W * H; i++) {
          const a = g[i * 4 + 3] > 0 ? 1 : 0;
          combined[i * 4] *= a;
          combined[i * 4 + 1] *= a;
          combined[i * 4 + 2] *= a;
          combined[i * 4 + 3] = a;
        }
      }
    }
    if (src.kind === 'final' && wantsExtraPasses(r)) Object.assign(passes, extraPasses(renderer, guideScene, camera, W, H, r, doc));
    guideScene.dispose();
    if (!transparent) for (let i = 3; i < combined.length; i += 4) combined[i] = 1;
    return { combined, passes, samples, maxSamples, view };
  } finally {
    restore();
  }
}

// ---------------------------------------------------------------------------
// job control

function newResult(W: number, H: number, src: Source): RenderResult {
  const doc = app.doc;
  const camOb = doc.scene.camera ? doc.objects[doc.scene.camera] : null;
  const engine = engineFor(src);
  return {
    width: W,
    height: H,
    passes: { Combined: new Float32Array(W * H * 4) },
    filmTransparent: filmTransparent(doc.scene.render),
    info: {
      frame: doc.scene.frame_current,
      time: 0,
      engine: engine === 'PATHTRACE' ? 'Path Tracer' : engine === 'RASTER' ? 'Realtime (Raster)' : src.kind === 'viewport' ? 'Viewport' : 'Solid (Workbench)',
      camera: src.kind === 'viewport' && !src.view.cameraView ? 'Viewport' : camOb?.name ?? '',
      scene: doc.scene.name,
    },
    version: 0,
    rendering: true,
  };
}

let lockEl: HTMLElement | null = null;

/** Render ▸ Lock Interface: block editing while a render runs (Esc still cancels). */
function lockInterface(on: boolean) {
  if (on && !lockEl && typeof document !== 'undefined') {
    lockEl = document.createElement('div');
    lockEl.className = 'render-lock';
    lockEl.title = 'The interface is locked while rendering (Render ▸ Lock Interface)';
    document.body.append(lockEl);
  } else if (!on && lockEl) {
    lockEl.remove();
    lockEl = null;
  }
}

function beginModal(label: string) {
  app.startModal({
    label,
    header: () => statusText(),
    status: () => [['Esc', 'Cancel']],
    onKey: (e) => {
      if (e.key === 'Escape') {
        if (e.type === 'keydown' && job) job.cancelled = true;
        return true;
      }
      // other keys keep working in text fields while rendering (unless the interface is locked)
      return !!lockEl;
    },
    cancel: () => {
      if (job) job.cancelled = true;
    },
  });
}

function endModal() {
  if (app.modal) {
    // the render does not change the document: end without pushing an undo step
    const m = app.modal;
    m.cancel = () => {};
    app.endModal('CANCELLED');
  }
}

export interface RenderOptions {
  animation: boolean;
  viewport: View3D | null;
}

/** Text metadata of a frame (Output ▸ Metadata) and the burnt-in overlay when enabled. */
function applyMetadata(result: RenderResult, frame: number, time: number) {
  const r = app.doc.scene.render;
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  result.metadata = stampFields(r, { doc: app.doc, frame, renderTime: time, filename: app.filename, now: new Date(), hostname: typeof location !== 'undefined' ? location.hostname : undefined, memory: mem });
  result.overlay = r.use_stamp ? burnStampOverlay(result.metadata, r, result.width, result.height) ?? undefined : undefined;
}

/** Encode the Combined pass of a result as an image file (with metadata text for PNG). */
export async function encodeResult(result: RenderResult, format: FileFormat, opts: { colorMode: 'BW' | 'RGB' | 'RGBA'; quality?: number; view?: ViewSettings; dither?: number }): Promise<Uint8Array> {
  const keepAlpha = opts.colorMode === 'RGBA' && result.filmTransparent && format !== 'JPEG';
  let px = passToRGBA8(result, 'Combined', 'COLOR_ALPHA', opts.view ?? app.doc.scene.render, { keepAlpha, dither: opts.dither });
  if (opts.colorMode === 'BW') px = toBW(px);
  let bytes = await encodeRGBA8(px, result.width, result.height, format, { alpha: keepAlpha, quality: opts.quality });
  if (format === 'PNG' && result.metadata?.length) bytes = pngWithText(bytes, result.metadata.map((f) => [f.key, f.value]));
  return bytes;
}

/** Start a render job (still or animation). */
export async function startRender(o: RenderOptions): Promise<boolean> {
  if (job) return false;
  const ctx = renderContext;
  if (!ctx) {
    app.report('ERROR', 'Rendering requires WebGL 2');
    return false;
  }
  const src: Source = o.viewport ? { kind: 'viewport', view: o.viewport } : { kind: 'final' };
  const seqHook = src.kind === 'final' && finalRenderHooks.renderFrame && finalRenderHooks.active?.() ? finalRenderHooks : null;
  if (src.kind === 'final' && !seqHook && !(app.doc.scene.camera && app.doc.objects[app.doc.scene.camera])) {
    app.report('ERROR', 'No camera found in scene');
    return false;
  }
  const doc = app.doc;
  const r = doc.scene.render;
  if (src.kind === 'final' && !seqHook && r.use_view_layer === false) {
    app.report('ERROR', 'The view layer is disabled for rendering (View Layer ▸ Use for Rendering)');
    return false;
  }
  const [FW, FH] = renderSize(r);
  const region = src.kind === 'final' && !seqHook ? regionRect(r, FW, FH) : null;
  const crop = !!region && !!r.use_crop_to_border;
  const W = crop ? region.w : FW,
    H = crop ? region.h : FH;
  const maxTex = ctx.engine.renderer.capabilities.maxTextureSize;
  if (FW > maxTex || FH > maxTex) {
    app.report('ERROR', `Render size ${FW}×${FH} exceeds the GPU limit of ${maxTex} px`);
    return false;
  }
  const frames = o.animation ? frameList(doc.scene) : [doc.scene.frame_current];
  if (!frames.length) {
    app.report('ERROR', 'Frame range is empty');
    return false;
  }
  const origFrame = doc.scene.frame_current;
  const origSub = doc.scene.frame_subframe ?? 0;
  job = { frame: frames[0], frameIndex: 0, frameCount: frames.length, sample: 0, maxSamples: 1, started: performance.now(), phase: '', cancelled: false, animation: o.animation };
  const result = newResult(W, H, src);
  if (seqHook) result.info.engine = 'Sequencer';
  renderResult.set(result);
  showRenderView();
  beginModal(o.viewport ? 'Viewport Render' : 'Render');
  if (r.use_lock_interface) lockInterface(true);
  // final renders evaluate the scene with render settings (render levels, render visibility, simplify)
  const finalEval = src.kind === 'final';
  if (finalEval) {
    app.graph.render = true;
    app.evaluate();
  }
  progress(true);
  await nextFrame();

  // place a region render into the frame (transparent outside), or keep it cropped
  const place = (buf: Float32Array, ch: number) => (region && !crop ? expandRegion(buf, ch, region, FW, FH) : buf);

  // animation output
  const format = r.file_format;
  let zip: ZipWriter | null = null;
  let video: VideoWriter | null = null;
  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = W;
  frameCanvas.height = H;
  let ok = true;
  let rendered = 0;
  const fps = r.fps / (r.fps_base || 1);
  try {
    if (o.animation) {
      animationRecorder.begin(fps, W, H);
      if (format === 'WEBM') video = (seqHook?.createVideoWriter ? await seqHook.createVideoWriter(W, H, fps, frames) : null) ?? (await createVideoWriter(W, H, fps));
      else zip = new ZipWriter();
    }
    for (let k = 0; k < frames.length; k++) {
      const f = frames[k];
      job.frame = f;
      job.frameIndex = k;
      job.sample = 0;
      if (o.animation || f !== doc.scene.frame_current) evaluateAt(f);
      const t0 = performance.now();
      const out = seqHook
        ? { passes: {}, samples: 1, maxSamples: 1, ...(await seqHook.renderFrame!(f, W, H)) }
        : await renderFrame(
            src,
            FW,
            FH,
            (buf, n) => {
              result.passes = { Combined: place(buf, 4) };
              result.info.samples = n;
              renderResult.touch();
              progress(true);
            },
            region,
          );
      const passes: Partial<Record<PassName, Float32Array>> = {};
      for (const [name, buf] of Object.entries(out.passes) as [PassName, Float32Array][]) passes[name] = place(buf, PASS_CHANNELS[name]);
      result.passes = { Combined: place(out.combined, 4), ...passes };
      const time = (performance.now() - (o.animation ? t0 : job.started)) / 1000;
      result.info = { ...result.info, frame: f, samples: out.samples, maxSamples: out.maxSamples, time };
      result.view = out.view;
      result.viewLayer = undefined;
      if (!seqHook) for (const hook of renderPostHooks) await hook(result, { final: src.kind === 'final' });
      if (src.kind === 'final') applyMetadata(result, f, time);
      rendered++;
      renderResult.touch();
      progress(true);
      if (o.animation) {
        const view = out.view ?? doc.scene.render;
        if (video) {
          const keepAlpha = false;
          let px = passToRGBA8(result, 'Combined', 'COLOR_ALPHA', view, { keepAlpha, dither: r.dither_intensity });
          if (r.color_mode === 'BW') px = toBW(px);
          const c2 = frameCanvas.getContext('2d')!;
          c2.putImageData(new ImageData(new Uint8ClampedArray(px), W, H), 0, 0);
          await video.addFrame(frameCanvas, k);
        } else if (zip) {
          const fmt = format as FileFormat;
          const bytes = await encodeResult(result, fmt, { colorMode: r.color_mode, quality: (r.quality ?? 90) / 100, view, dither: r.dither_intensity });
          zip.add(frameFileName(r.filepath, f, EXT[fmt], r.use_file_extension !== false), bytes);
          animationRecorder.addFrame(f, bytes, MIME[fmt]);
        }
      }
      await nextFrame();
    }
  } catch (e) {
    ok = false;
    if (!(e instanceof Cancelled)) {
      console.error(e);
      app.report('ERROR', `Render failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const cancelled = job.cancelled;
  const total = (performance.now() - job.started) / 1000;
  result.rendering = false;
  result.info.status = undefined;
  if (!o.animation) result.info.time = total;
  if (finalEval) app.graph.render = false;
  // restore the scene frame (and the viewport evaluation)
  if (finalEval || o.animation || doc.scene.frame_current !== origFrame || (doc.scene.frame_subframe ?? 0) !== origSub) {
    doc.scene.frame_current = origFrame;
    doc.scene.frame_subframe = origSub;
    app.changed('frame');
  }
  job = null;
  lockInterface(false);
  endModal();
  // write animation output (also the frames finished before a cancel)
  if (o.animation && rendered > 0) {
    const base = `${doc.scene.name || 'render'}_${frames[0]}-${frames[Math.min(rendered, frames.length) - 1]}`;
    try {
      if (video) {
        const blob = await video.finish();
        animationRecorder.setVideo(blob);
        download(blob, `${base}.webm`, 'video/webm');
      } else if (zip) download(new Blob(zip.finish() as BlobPart[], { type: 'application/zip' }), `${base}.zip`, 'application/zip');
    } catch (e) {
      app.report('ERROR', `Could not write the animation: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (o.animation) animationRecorder.finish();
  renderResult.touch();
  shellStatus();
  if (cancelled) app.report('WARNING', o.animation ? `Render cancelled after ${rendered} frame${rendered === 1 ? '' : 's'}` : 'Render cancelled');
  else if (ok) app.report('INFO', o.animation ? `Rendered ${rendered} frames in ${formatTime(total)}` : `Render finished in ${formatTime(total)}`);
  return ok && !cancelled;
}

export function cancelRender() {
  if (job) job.cancelled = true;
}

// ---------------------------------------------------------------------------
// operators

registerOperators([
  {
    idname: 'render.render',
    label: 'Render',
    description: 'Render the active scene camera (F12), or the frame range as an animation (Ctrl F12)',
    icon: 'render',
    undo: false,
    props: [{ id: 'animation', label: 'Animation', type: 'bool', default: false }],
    poll: () => !job,
    exec: (_ctx, p) => {
      void startRender({ animation: !!p.animation, viewport: null });
      return 'CANCELLED';
    },
  },
  {
    idname: 'render.opengl',
    label: 'Viewport Render Image',
    description: 'Render the active 3D viewport as seen, without overlays',
    undo: false,
    props: [{ id: 'animation', label: 'Animation', type: 'bool', default: false }],
    poll: () => !job && !!activeView3D(),
    exec: (_ctx, p) => {
      const v = activeView3D();
      if (!v) return 'CANCELLED';
      void startRender({ animation: !!p.animation, viewport: v });
      return 'CANCELLED';
    },
  },
  {
    idname: 'render.opengl_animation',
    label: 'Viewport Render Animation',
    description: 'Render the frame range from the active 3D viewport, without overlays',
    undo: false,
    poll: () => !job && !!activeView3D(),
    exec: () => {
      const v = activeView3D();
      if (!v) return 'CANCELLED';
      void startRender({ animation: true, viewport: v });
      return 'CANCELLED';
    },
  },
]);

export type { Matrix4, Vector3 };

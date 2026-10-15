// Final rendering: F12 still / Ctrl F12 animation, viewport renders, progress, cancel, passes.
import { Color, type Camera, type WebGLRenderTarget, type WebGLRenderer, Matrix4, Vector4, type PerspectiveCamera } from 'three';
import { app, registerOperators } from '../../app/app';
import { renderContext } from '../context';
import { RenderScene, type BuildOptions } from './renderscene';
import { RasterRenderer, Accumulator, effectsFrom } from './raster';
import { PathTracerCore } from './pathtracer';
import { Denoiser } from './denoise';
import { floatTarget, normalDepthMaterial, renderOverride, renderAlbedo } from './gbuffer';
import { renderCamera, viewportCameraForAspect, jitterProjection } from './camera';
import { renderSize, frameList, jitter, shutterOffset, formatTime, frameFileName } from './units';
import { renderResult, passToRGBA8, encodeRGBA8, download, toBW, EXT, renderPostHooks, type RenderResult, type FileFormat, type PassName } from './result';
import { studioEquirect } from './environment';
import { ZipWriter } from './zip';
import { createVideoWriter, type VideoWriter } from './webm';
import { drawViewport, type DrawView } from '../../editors/view3d/draw';
import { defaultOverlay, defaultShading, type Shading } from '../../editors/view3d/state';
import { NavCamera } from '../navcam';
import { activeView3D, type View3D } from '../../editors/view3d/view3d';
import { showRenderView } from './renderwindow';
import { shell } from '../../ui/shell';
import type { ViewSettings } from './colormanage';
import { passesFromGuide } from './passes';
import { renderExtraPasses, wantsExtraPasses } from './extrapasses';

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
    return await renderFrame({ kind: 'final' }, W, H, () => {});
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

function cameraFor(src: Source, W: number, H: number): Camera | null {
  if (src.kind === 'final') return renderCamera(app, W, H);
  const v = src.view;
  if (v.cameraView && app.doc.scene.camera) return renderCamera(app, W, H);
  const nc = new NavCamera();
  nc.load(v.nav.serialize());
  nc.autoPersp = v.nav.autoPersp;
  nc.resize(W, H);
  nc.update();
  return viewportCameraForAspect(nc.camera, W / H);
}

function engineFor(src: Source): 'RASTER' | 'PATHTRACE' | 'WORKBENCH' {
  const e = app.doc.scene.render.engine;
  if (src.kind === 'viewport' && src.view.shading.type !== 'RENDERED') return 'WORKBENCH';
  return e === 'SOLID' ? 'WORKBENCH' : e;
}

function buildOptions(src: Source, mode: 'raster' | 'pathtrace'): BuildOptions {
  const r = app.doc.scene.render;
  if (src.kind === 'final') return { mode, final: true, filmTransparent: r.film_transparent };
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

async function renderFrame(src: Source, W: number, H: number, onPartial: (buf: Float32Array, samples: number) => void): Promise<FrameOutput> {
  const ctx = renderContext!;
  const renderer = ctx.engine.renderer;
  const doc = app.doc;
  const r = doc.scene.render;
  const engine = engineFor(src);
  let camera = cameraFor(src, W, H);
  if (!camera) throw new Error('No camera found in scene');
  const restore = saveState(renderer);
  const passesWanted = { z: r.use_pass_z, normal: r.use_pass_normal, mist: r.use_pass_mist };
  const needGuide = passesWanted.z || passesWanted.normal || passesWanted.mist || (engine === 'WORKBENCH' && r.film_transparent);
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
      const tiles = Math.max(1, Math.ceil(Math.sqrt((W * H) / (640 * 640))));
      core.setTiles(tiles, tiles);
      core.sync(rs, camera, Math.random());
      core.reset();
      maxSamples = Math.max(1, src.kind === 'final' ? r.samples : r.preview_samples);
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
      let batch = 1;
      let lastPreview = performance.now();
      let previewCost = 100;
      let last = performance.now();
      while (core.samples < maxSamples) {
        check();
        for (let i = 0; i < batch && core.samples < maxSamples; i++) core.sample();
        job!.sample = core.samples;
        const now = performance.now();
        if (now - lastPreview > Math.max(700, previewCost * 6)) {
          onPartial(readFloat(renderer, core.renderTarget, W, H), core.samples);
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
      combined = readFloat(renderer, resultRT, W, H);
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
      const frame = doc.scene.frame_current;
      let base = (camera as PerspectiveCamera).projectionMatrix.clone();
      const fx = effectsFrom(r);
      let last = performance.now();
      for (let i = 0; i < maxSamples; i++) {
        check();
        if (motion) {
          evaluateAt(frame + shutterOffset(i, maxSamples, r.motion_blur_shutter));
          rs.build(app, opts);
          camera = renderCamera(app, W, H) ?? camera;
          base = (camera as PerspectiveCamera).projectionMatrix.clone();
        }
        const [jx, jy] = jitter(i);
        jitterProjection(camera, base, jx, jy, W, H);
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
        camera = renderCamera(app, W, H) ?? camera;
      } else jitterProjection(camera, base, 0, 0, W, H);
      samples = maxSamples;
      combined = readFloat(renderer, accum.target, W, H);
    } else {
      // workbench: the viewport's own drawing code with overlays disabled
      const shading: Shading = src.kind === 'viewport' ? { ...src.view.shading } : { ...defaultShading(), background_type: 'WORLD' };
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
      if (engine === 'WORKBENCH' && r.film_transparent) {
        for (let i = 0; i < W * H; i++) {
          const a = g[i * 4 + 3] > 0 ? 1 : 0;
          combined[i * 4] *= a;
          combined[i * 4 + 1] *= a;
          combined[i * 4 + 2] *= a;
          combined[i * 4 + 3] = a;
        }
      }
    }
    // object/material indexes, cryptomatte and shader AOVs
    if (wantsExtraPasses(doc)) Object.assign(passes, (await renderExtraPasses({ renderer, scene: guideScene.scene, camera, W, H, doc, yieldFrame: nextFrame })).passes);
    guideScene.dispose();
    if (!(engine === 'WORKBENCH' && r.film_transparent) && !r.film_transparent) for (let i = 3; i < combined.length; i += 4) combined[i] = 1;
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
    filmTransparent: doc.scene.render.film_transparent,
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
      // other keys keep working in text fields while rendering
      return false;
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
  const [W, H] = renderSize(r);
  const maxTex = ctx.engine.renderer.capabilities.maxTextureSize;
  if (W > maxTex || H > maxTex) {
    app.report('ERROR', `Render size ${W}×${H} exceeds the GPU limit of ${maxTex} px`);
    return false;
  }
  const frames = o.animation ? frameList(doc.scene) : [doc.scene.frame_current];
  if (!frames.length) {
    app.report('ERROR', 'Frame range is empty');
    return false;
  }
  const origFrame = doc.scene.frame_current;
  const origSub = doc.scene.frame_subframe ?? 0;
  job = { frame: frames[0], frameIndex: 0, frameCount: frames.length, sample: 0, maxSamples: 1, started: performance.now(), phase: '', cancelled: false };
  const result = newResult(W, H, src);
  if (seqHook) result.info.engine = 'Sequencer';
  renderResult.set(result);
  showRenderView();
  beginModal(o.viewport ? 'Viewport Render' : 'Render');
  progress(true);
  await nextFrame();

  // animation output
  const format = r.file_format;
  let zip: ZipWriter | null = null;
  let video: VideoWriter | null = null;
  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = W;
  frameCanvas.height = H;
  let ok = true;
  let rendered = 0;
  try {
    if (o.animation) {
      if (format === 'WEBM') video = (seqHook?.createVideoWriter ? await seqHook.createVideoWriter(W, H, r.fps / (r.fps_base || 1), frames) : null) ?? (await createVideoWriter(W, H, r.fps / (r.fps_base || 1)));
      else zip = new ZipWriter();
    }
    for (let k = 0; k < frames.length; k++) {
      const f = frames[k];
      job.frame = f;
      job.frameIndex = k;
      job.sample = 0;
      if (o.animation || f !== doc.scene.frame_current) evaluateAt(f);
      const t0 = performance.now();
      const out = seqHook ? { passes: {}, samples: 1, maxSamples: 1, ...(await seqHook.renderFrame!(f, W, H)) } : await renderFrame(src, W, H, (buf, n) => {
        result.passes = { Combined: buf };
        result.info.samples = n;
        renderResult.touch();
        progress(true);
      });
      result.passes = { Combined: out.combined, ...out.passes };
      result.info = { ...result.info, frame: f, samples: out.samples, maxSamples: out.maxSamples, time: (performance.now() - (o.animation ? t0 : job.started)) / 1000 };
      result.view = out.view;
      if (!seqHook) for (const hook of renderPostHooks) await hook(result, { final: src.kind === 'final' });
      rendered++;
      renderResult.touch();
      progress(true);
      if (o.animation) {
        const view = out.view ?? doc.scene.render;
        const keepAlpha = r.color_mode === 'RGBA' && r.film_transparent && format !== 'WEBM' && format !== 'JPEG';
        let px = passToRGBA8(result, 'Combined', 'COLOR_ALPHA', view, { keepAlpha, dither: r.dither_intensity });
        if (r.color_mode === 'BW') px = toBW(px);
        if (video) {
          const c2 = frameCanvas.getContext('2d')!;
          c2.putImageData(new ImageData(new Uint8ClampedArray(px), W, H), 0, 0);
          await video.addFrame(frameCanvas, k);
        } else if (zip) {
          const fmt = format as FileFormat;
          const bytes = await encodeRGBA8(px, W, H, fmt, { alpha: keepAlpha });
          zip.add(frameFileName(r.filepath, f, EXT[fmt]), bytes);
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
  // restore the scene frame
  if (o.animation || doc.scene.frame_current !== origFrame || (doc.scene.frame_subframe ?? 0) !== origSub) {
    doc.scene.frame_current = origFrame;
    doc.scene.frame_subframe = origSub;
    app.changed('frame');
  }
  job = null;
  endModal();
  // write animation output (also the frames finished before a cancel)
  if (o.animation && rendered > 0) {
    const base = `${doc.scene.name || 'render'}_${frames[0]}-${frames[Math.min(rendered, frames.length) - 1]}`;
    try {
      if (video) download(await video.finish(), `${base}.webm`, 'video/webm');
      else if (zip) download(new Blob(zip.finish() as BlobPart[], { type: 'application/zip' }), `${base}.zip`, 'application/zip');
    } catch (e) {
      app.report('ERROR', `Could not write the animation: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  renderResult.touch();
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

export type { Matrix4 };

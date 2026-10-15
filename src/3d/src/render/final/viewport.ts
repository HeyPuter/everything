// Rendered viewport shading: attaches a per-viewport render engine (realtime raster with
// effects, or progressive path tracing with denoising) through the 3D view extension hook.
import { Color, OrthographicCamera, PerspectiveCamera, Vector4, type Camera, type WebGLRenderTarget } from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { PhysicalCamera } from 'three-gpu-pathtracer';
import { app } from '../../app/app';
import { renderContext } from '../context';
import { viewportExtensions } from '../../editors/view3d/hooks';
import type { View3D } from '../../editors/view3d/view3d';
import { RenderScene, type BuildOptions } from './renderscene';
import { RasterRenderer, Accumulator, effectsFrom, displayMaterial, setDisplay, depthOnlyMaterial } from './raster';
import { PathTracerCore } from './pathtracer';
import { Denoiser } from './denoise';
import { floatTarget, normalDepthMaterial, renderOverride, renderAlbedo } from './gbuffer';
import { studioEquirect } from './environment';
import { hdriEquirect, hdriEnvironment, libraryVersion } from '../studiolights';
import { renderCamera, cameraDof, apertureSample, apertureJitter, jitterProjection } from './camera';
import { filterTable, sampleFilter } from './filter';
import { halton } from './units';

/** Rendered viewport resolution divisor (Performance ▸ Viewport ▸ Pixel Size). */
export function viewportPixelSize(size: string | undefined): number {
  const n = Number(size);
  return n > 0 ? n : 1;
}

const transparentBg = new Color(0.12, 0.12, 0.12);
const quad = new FullScreenQuad(displayMaterial);
const noFx = { gtao: false, gtaoDistance: 0, bloom: false, bloomThreshold: 1, bloomIntensity: 0, bloomRadius: 0, transparent: false };

export class ViewportRender {
  private scene: RenderScene | null = null;
  private builtKey = '';
  private buildCount = 0;
  private raster = new RasterRenderer(4);
  private accum = new Accumulator();
  private accumKey = '';
  private accumCount = 0;
  private filterKey = '';
  private table = filterTable('BLACKMAN_HARRIS', 1.5);
  private core: PathTracerCore | null = null;
  private denoiser: Denoiser | null = null;
  private guide: WebGLRenderTarget | null = null;
  private albedo: WebGLRenderTarget | null = null;
  private guideKey = '';
  private denoisedSamples = -1;
  private infoEl: HTMLElement;
  status = '';

  constructor(private v: View3D) {
    this.infoEl = document.createElement('div');
    this.infoEl.className = 'rf-viewport-info';
    v.el.append(this.infoEl);
  }

  private maxSamples() {
    return Math.max(1, app.doc.scene.render.preview_samples || 1);
  }

  private rasterSamples() {
    return Math.max(1, Math.round(app.doc.scene.render.preview_raster_samples ?? 16));
  }

  /** Whether the viewport needs further frames (progressive refinement / shader compilation). */
  animating(): boolean {
    if (this.v.shading.type !== 'RENDERED') return false;
    const engine = app.doc.scene.render.engine;
    if (engine === 'RASTER') return !!this.accumKey && this.accumCount < this.rasterSamples();
    if (engine !== 'PATHTRACE' || !this.core) return engine === 'PATHTRACE';
    return this.core.isCompiling || this.core.samples < this.maxSamples() || (this.wantDenoise() && this.denoisedSamples !== this.core.samples);
  }

  private wantDenoise() {
    return app.doc.scene.render.preview_denoising !== false;
  }

  /** Draw the rendered view into the current (scissored) viewport. Returns false to fall back. */
  render(camera: Camera, w: number, h: number): boolean {
    const ctx = renderContext;
    const doc = app.doc;
    const r = doc.scene.render;
    if (!ctx || r.engine === 'SOLID') {
      this.setInfo('');
      return false;
    }
    const renderer = ctx.engine.renderer;
    // remember the viewport rectangle: environment pre-filtering may change it while rendering
    renderer.getViewport(this.vp);
    renderer.getScissor(this.sc);
    const sh = this.v.shading;
    const mode = r.engine === 'PATHTRACE' ? 'pathtrace' : 'raster';
    const opts: BuildOptions = {
      mode,
      final: false,
      localView: this.v.localView,
      useSceneLights: sh.use_scene_lights_render,
      useSceneWorld: sh.use_scene_world_render,
      studio: sh.use_scene_world_render ? null : mode === 'pathtrace' ? { texture: hdriEquirect(sh.studio_hdri) ?? studioEquirect(), intensity: sh.studiolight_intensity } : { texture: hdriEnvironment(ctx.engine.renderer, ctx.engine.pmrem, sh.studio_hdri) ?? ctx.studio(), intensity: sh.studiolight_intensity },
      filmTransparent: r.film_transparent,
      ...(mode === 'raster' ? { lightScale: r.direct_light_intensity ?? 1, envScale: r.indirect_light_intensity ?? 1 } : {}),
    };
    const key = `${app.revision}|${mode}|${opts.useSceneLights}|${opts.useSceneWorld}|${sh.studiolight_intensity}|${sh.studio_hdri ?? ''}:${libraryVersion}|${r.film_transparent}|${opts.lightScale}|${opts.envScale}|${this.v.localView ? [...this.v.localView].join(',') : ''}`;
    if (!this.scene || this.scene.mode !== mode) {
      this.scene?.dispose();
      this.scene = new RenderScene(mode);
      this.builtKey = '';
    }
    if (key !== this.builtKey) {
      this.scene.build(app, opts);
      this.builtKey = key;
      this.buildCount++;
    }
    const rs = this.scene;
    const bg = r.film_transparent ? transparentBg : null;
    const filmExposure = mode === 'pathtrace' ? Math.log2(Math.max(1e-6, r.film_exposure ?? 1)) : 0;
    setDisplay(r, filmExposure, bg ?? new Color(0, 0, 0));
    const pixel = viewportPixelSize(r.preview_pixel_size);
    const dpr = r.preview_pixel_size && r.preview_pixel_size !== 'AUTO' ? 1 / pixel : ctx.engine.dpr;
    if (mode === 'raster') {
      rs.configureShadows(renderer, doc);
      const W = Math.max(1, Math.round(w * dpr)),
        H = Math.max(1, Math.round(h * dpr));
      this.blit(this.rasterSample(camera, W, H));
      const max = this.rasterSamples();
      this.setInfo(max > 1 && this.accumCount < max ? `Sample ${this.accumCount}/${max}` : '');
    } else {
      const cam = this.cameraWithDof(camera);
      const core = (this.core ??= new PathTracerCore(renderer));
      core.applySettings(r);
      const W = Math.max(1, Math.round(w / pixel)),
        H = Math.max(1, Math.round(h / pixel));
      core.setSize(W, H);
      core.sync(rs, cam, this.buildCount);
      const max = this.maxSamples();
      if (core.samples < max) core.sample();
      const n = core.samples;
      if (n === 0) {
        // shaders compiling / first sample pending: show a quick raster preview
        const tex = this.raster.render(renderer, rs.scene, camera, Math.round(w * dpr), Math.round(h * dpr), noFx);
        this.blit(tex);
        this.setInfo(core.isCompiling ? 'Compiling shaders…' : 'Path Tracing Sample 0/' + max);
      } else {
        let tex = core.texture;
        if (this.wantDenoise()) {
          tex = this.denoise(cam, W, H, n) ?? tex;
        }
        this.blit(tex);
        this.setInfo(`Path Tracing Sample ${n}/${max}${this.wantDenoise() ? (n >= max ? ' · Denoised' : ' · Denoising') : ''}`);
      }
    }
    this.writeDepth(camera);
    return true;
  }

  /**
   * Realtime viewport: while the view and the scene stay unchanged, jittered samples (pixel
   * filter, and depth of field when looking through the camera) are averaged progressively.
   */
  private rasterSample(camera: Camera, W: number, H: number) {
    const renderer = renderContext!.engine.renderer;
    const r = app.doc.scene.render;
    const rs = this.scene!;
    const fx = effectsFrom(r);
    const fkey = `${r.filter_size ?? 1.5}`;
    if (fkey !== this.filterKey) {
      this.filterKey = fkey;
      this.table = filterTable('BLACKMAN_HARRIS', r.filter_size ?? 1.5);
    }
    camera.updateMatrixWorld();
    const proj = (camera as PerspectiveCamera).projectionMatrix;
    const dof = this.v.cameraView && camera === this.v.sceneCamera && r.use_bokeh_jittered !== false ? cameraDof(app) : null;
    const key = `${this.builtKey}|${W}x${H}|${camera.matrixWorld.elements.join(',')}|${proj.elements.join(',')}|${JSON.stringify(fx)}|${fkey}|${dof ? JSON.stringify(dof) : ''}|${r.shadow_cube_size}|${r.use_soft_shadows}`;
    const max = this.rasterSamples();
    if (key !== this.accumKey) {
      this.accumKey = key;
      this.accumCount = 0;
      this.accum.reset(W, H);
    }
    if (this.accumCount >= max) return this.accum.target.texture;
    const i = this.accumCount;
    let cam = camera;
    if (i > 0) {
      cam = camera.clone();
      (cam as PerspectiveCamera).projectionMatrix.copy(proj);
      const base = proj.clone();
      const jx = sampleFilter(this.table, halton(i + 1, 2)),
        jy = sampleFilter(this.table, halton(i + 1, 3));
      if (dof) {
        const [ax, ay] = apertureSample(halton(i + 1, 5), halton(i + 1, 7), dof.blades, dof.rotation, dof.ratio);
        apertureJitter(cam, camera.position.clone(), base, ax * dof.radius, ay * dof.radius, dof.focus);
        jitterProjection(cam, (cam as PerspectiveCamera).projectionMatrix.clone(), jx, jy, W, H);
      } else jitterProjection(cam, base, jx, jy, W, H);
    }
    const tex = this.raster.render(renderer, rs.scene, cam, W, H, fx);
    this.accum.add(renderer, tex);
    this.accumCount++;
    return this.accum.target.texture;
  }

  private denoise(cam: Camera, W: number, H: number, n: number) {
    const ctx = renderContext!;
    const renderer = ctx.engine.renderer;
    const rs = this.scene!;
    const gkey = `${this.buildCount}|${W}x${H}|${cam.matrixWorld.elements.join(',')}|${(cam as PerspectiveCamera).projectionMatrix.elements.join(',')}`;
    if (gkey !== this.guideKey) {
      this.guideKey = gkey;
      if (!this.guide) this.guide = floatTarget(W, H, { samples: 4 });
      else this.guide.setSize(W, H);
      if (!this.albedo) this.albedo = floatTarget(W, H, { half: true, samples: 4 });
      else this.albedo.setSize(W, H);
      const se = renderer.shadowMap.enabled;
      renderer.shadowMap.enabled = false;
      renderOverride(renderer, rs.scene, cam, this.guide, normalDepthMaterial);
      renderAlbedo(renderer, rs.scene, cam, this.albedo);
      renderer.shadowMap.enabled = se;
      this.denoisedSamples = -1;
    }
    const d = (this.denoiser ??= new Denoiser());
    if (this.denoisedSamples !== n || !d.out) {
      d.run(renderer, this.core!.texture, this.guide!.texture, this.albedo!.texture, W, H, n);
      this.denoisedSamples = n;
    }
    return d.out!.texture;
  }

  /** Path tracer camera: the scene camera gains depth of field when looking through it. */
  private cameraWithDof(camera: Camera): Camera {
    if (!this.v.cameraView || camera !== this.v.sceneCamera) return camera;
    const sc = renderCamera(app, 100, 100);
    if (!(sc instanceof PhysicalCamera) || !(camera instanceof PerspectiveCamera)) return camera;
    const p = new PhysicalCamera();
    p.copy(camera);
    p.focusDistance = sc.focusDistance;
    p.fStop = sc.fStop;
    p.apertureBlades = sc.apertureBlades;
    p.apertureRotation = sc.apertureRotation;
    p.anamorphicRatio = sc.anamorphicRatio;
    p.updateMatrixWorld(true);
    return p;
  }

  private vp = new Vector4();
  private sc = new Vector4();

  private restoreRect() {
    const renderer = renderContext!.engine.renderer;
    renderer.setRenderTarget(null);
    renderer.setViewport(this.vp);
    renderer.setScissor(this.sc);
    renderer.setScissorTest(true);
  }

  private blit(tex: import('three').Texture) {
    const renderer = renderContext!.engine.renderer;
    this.restoreRect();
    displayMaterial.uniforms.tMap.value = tex;
    quad.render(renderer);
  }

  /** Fill the depth buffer so overlays (grid, wires, outlines) are occluded correctly. */
  private writeDepth(camera: Camera) {
    const renderer = renderContext!.engine.renderer;
    const s = this.scene!.scene;
    const bg = s.background,
      over = s.overrideMaterial;
    const se = renderer.shadowMap.enabled;
    renderer.shadowMap.enabled = false;
    s.background = null;
    s.overrideMaterial = depthOnlyMaterial;
    this.restoreRect();
    renderer.clearDepth();
    renderer.render(s, camera);
    s.background = bg;
    s.overrideMaterial = over;
    renderer.shadowMap.enabled = se;
  }

  private setInfo(text: string) {
    if (text === this.status) return;
    this.status = text;
    this.infoEl.textContent = text;
    this.infoEl.hidden = !text;
  }

  /** Position the status line below the viewport's text info. */
  layout() {
    const info = this.v.el.querySelector('.v3d-info') as HTMLElement | null;
    const top = info ? info.offsetTop + info.offsetHeight + 2 : 34;
    this.infoEl.style.top = `${top}px`;
    this.infoEl.style.left = info?.style.left || '52px';
    this.infoEl.hidden = !this.status || !this.v.overlay.show_overlays || !this.v.overlay.show_text;
  }

  dispose() {
    this.scene?.dispose();
    this.raster.dispose();
    this.accum.dispose();
    this.core?.dispose();
    this.denoiser?.dispose();
    this.guide?.dispose();
    this.albedo?.dispose();
    this.infoEl.remove();
  }
}

viewportExtensions.push((v) => {
  const vr = new ViewportRender(v);
  v.pathTracer = {
    render: (camera, w, h) => {
      const ok = vr.render(camera, w, h);
      vr.layout();
      return ok;
    },
  };
  // keep redrawing only while the progressive render still refines
  v.animating = () => vr.animating();
  return () => vr.dispose();
});

export { OrthographicCamera };

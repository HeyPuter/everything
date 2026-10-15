// Shared WebGL2 renderer: a single context draws every 3D viewport into its
// screen rectangle (scissored) behind the DOM interface, sharing GPU resources.
import { prefs } from '../app/prefs';
import {
  WebGLRenderer,
  Scene,
  Color,
  SRGBColorSpace,
  PCFShadowMap,
  AgXToneMapping,
  NeutralToneMapping,
  LinearToneMapping,
  NoToneMapping,
  ACESFilmicToneMapping,
  type Camera,
  type ToneMapping,
  WebGLRenderTarget,
  NearestFilter,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  PMREMGenerator,
} from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';

export interface ViewportRenderer {
  /** client rect of the drawable region */
  rect(): DOMRect | null;
  visible(): boolean;
  draw(engine: RenderEngine, x: number, y: number, w: number, h: number): void;
  /** returns true when it needs continuous redraw (progressive renders, playback) */
  animating?(): boolean;
}

export class RenderEngine {
  canvas: HTMLCanvasElement;
  renderer: WebGLRenderer;
  pmrem: PMREMGenerator;
  /** registered viewports; adding or removing one redraws the shared canvas (no stale pixels) */
  viewports = new (class extends Set<ViewportRenderer> {
    constructor(private onChange: () => void) {
      super();
    }
    add(v: ViewportRenderer) {
      super.add(v);
      this.onChange?.();
      return this;
    }
    delete(v: ViewportRenderer) {
      const r = super.delete(v);
      this.onChange?.();
      return r;
    }
  })(() => this.requestDraw());
  private needsDraw = true;
  private raf = 0;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  lost = false;
  onLost?: (message: string) => void;
  frameCallbacks = new Set<() => void>();
  /** called after every redraw of the shared canvas (e.g. to copy a viewport into an area window) */
  afterDraw = new Set<() => void>();

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gl-canvas';
    container.prepend(this.canvas);
    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      // multisampling is fixed when the context is created (Preferences ▸ Viewport ▸ Quality)
      antialias: prefs.viewport_aa !== 'OFF',
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      stencil: true,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap; // soft edges come from per-light shadow radius
    this.renderer.autoClear = false;
    this.renderer.setPixelRatio(this.dpr);
    this.pmrem = new PMREMGenerator(this.renderer);
    RectAreaLightUniformsLib.init();
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.onLost?.('The graphics context was lost. Your work is kept; reload the page to continue.');
    });
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.loop();
  }

  resize() {
    const w = this.canvas.parentElement!.clientWidth,
      h = this.canvas.parentElement!.clientHeight;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.requestDraw();
  }

  requestDraw() {
    this.needsDraw = true;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    for (const cb of this.frameCallbacks) cb();
    let animating = false;
    for (const v of this.viewports) if (v.visible() && v.animating?.()) animating = true;
    if (!this.needsDraw && !animating) return;
    this.needsDraw = false;
    this.drawAll();
  };

  drawAll() {
    if (this.lost) return;
    const r = this.renderer;
    const base = this.canvas.getBoundingClientRect();
    r.setScissorTest(false);
    r.setClearColor(0x161616, 1);
    r.clear(true, true, true);
    for (const v of this.viewports) {
      if (!v.visible()) continue;
      const rect = v.rect();
      if (!rect || rect.width < 2 || rect.height < 2) continue;
      const x = rect.left - base.left,
        y = base.bottom - rect.bottom,
        w = rect.width,
        h = rect.height;
      r.setViewport(x, y, w, h);
      r.setScissor(x, y, w, h);
      r.setScissorTest(true);
      try {
        v.draw(this, x, y, w, h);
      } catch (e) {
        console.error(e);
      }
      r.setRenderTarget(null);
    }
    r.setScissorTest(false);
    for (const cb of this.afterDraw) cb();
  }

  /** Clear the current scissor region. */
  clear(color: Color, alpha = 1) {
    this.renderer.setClearColor(color, alpha);
    this.renderer.clear(true, true, true);
  }

  setToneMapping(view: string, exposure: number) {
    const map: Record<string, ToneMapping> = { AGX: AgXToneMapping, FILMIC: ACESFilmicToneMapping, KHRONOS_PBR_NEUTRAL: NeutralToneMapping, STANDARD: LinearToneMapping, RAW: NoToneMapping };
    this.renderer.toneMapping = map[view] ?? AgXToneMapping;
    this.renderer.toneMappingExposure = Math.pow(2, exposure);
  }

  render(scene: Scene, camera: Camera) {
    this.renderer.render(scene, camera);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.pmrem.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

/** Off-screen ID target for picking & outlines (RGBA8, nearest). */
export function makeIdTarget(w: number, h: number) {
  return new WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    format: RGBAFormat,
    type: UnsignedByteType,
    depthBuffer: true,
    generateMipmaps: false,
  });
}

export const tmpVec2 = new Vector2();

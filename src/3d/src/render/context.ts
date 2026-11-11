// Shared rendering context (single GL context, scene sync, environments).
import { Color, DataTexture, RGBAFormat, FloatType, EquirectangularReflectionMapping, type Texture, type WebGLRenderTarget, Scene, Mesh, SphereGeometry, MeshBasicMaterial, BackSide, LinearSRGBColorSpace } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RenderEngine } from './engine';
import { SceneSync } from './scene';
import type { App } from '../app/app';
import type { WorldData } from '../data/types';

export class RenderContext {
  engine: RenderEngine;
  sync: SceneSync;
  private syncedRevision = -1;
  private studioEnv: Texture | null = null;
  private worldEnvKey = '';
  private worldEnv: Texture | null = null;
  /** the PMREM target holding worldEnv (disposing only its texture leaks the target) */
  private worldEnvTarget: WebGLRenderTarget | null = null;
  /** the sky gradient made here for worldBackground (an image texture is owned by the image cache) */
  private skyTexture: DataTexture | null = null;
  worldBackground: Texture | Color | null = null;

  constructor(
    public app: App,
    container: HTMLElement,
  ) {
    this.engine = new RenderEngine(container);
    this.sync = new SceneSync(app);
    app.subscribe(() => this.engine.requestDraw());
  }

  /** Bring the three.js scene up to date with the depsgraph (once per revision). */
  ensureSynced() {
    // never draw a depsgraph that is older than the document (e.g. right after a file load)
    if (this.app.hasPending) this.app.flush();
    if (this.syncedRevision === this.app.revision) return;
    this.syncedRevision = this.app.revision;
    this.sync.sync();
  }

  forceSync() {
    this.syncedRevision = -1;
  }

  /** Neutral studio environment for material preview. */
  studio(): Texture {
    if (!this.studioEnv) {
      const room = new RoomEnvironment();
      this.studioEnv = this.engine.pmrem.fromScene(room, 0.02).texture;
    }
    return this.studioEnv;
  }

  /** Environment map from the world (uniform color, sky gradient or image). */
  world(world: WorldData | null, evaluateWorld: (w: WorldData) => { kind: 'color'; color: [number, number, number] } | { kind: 'texture'; texture: Texture; key: string } | { kind: 'sky'; top: number[]; horizon: number[]; ground: number[]; key: string }): Texture | null {
    if (!world) return null;
    const ev = evaluateWorld(world);
    const key = ev.kind === 'color' ? `c${ev.color.join(',')}` : ev.key;
    if (key === this.worldEnvKey && this.worldEnv) return this.worldEnv;
    if (this.worldEnvTarget) this.worldEnvTarget.dispose();
    else this.worldEnv?.dispose();
    this.skyTexture?.dispose();
    this.skyTexture = null;
    this.worldEnvKey = key;
    if (ev.kind === 'texture') {
      ev.texture.mapping = EquirectangularReflectionMapping;
      this.worldEnvTarget = this.engine.pmrem.fromEquirectangular(ev.texture);
      this.worldEnv = this.worldEnvTarget.texture;
      this.worldBackground = ev.texture;
    } else if (ev.kind === 'sky') {
      const w = 64,
        h = 32,
        data = new Float32Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        const t = 1 - (y + 0.5) / h; // 1 top
        const elev = (t - 0.5) * Math.PI;
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          let c: number[];
          if (elev >= 0) {
            const k = Math.pow(Math.sin(elev), 0.5);
            c = ev.horizon.map((v, j) => v + (ev.top[j] - v) * k);
          } else {
            const k = Math.min(1, -elev * 4);
            c = ev.horizon.map((v, j) => v + (ev.ground[j] - v) * k);
          }
          data.set([c[0], c[1], c[2], 1], i);
        }
      }
      const tex = new DataTexture(data, w, h, RGBAFormat, FloatType);
      tex.colorSpace = LinearSRGBColorSpace;
      tex.mapping = EquirectangularReflectionMapping;
      tex.needsUpdate = true;
      this.worldEnvTarget = this.engine.pmrem.fromEquirectangular(tex);
      this.worldEnv = this.worldEnvTarget.texture;
      this.worldBackground = this.skyTexture = tex;
    } else {
      const s = new Scene();
      const c = new Color(ev.color[0], ev.color[1], ev.color[2]);
      const geo = new SphereGeometry(10, 16, 8),
        mat = new MeshBasicMaterial({ color: c, side: BackSide });
      s.add(new Mesh(geo, mat));
      this.worldEnvTarget = this.engine.pmrem.fromScene(s, 0);
      this.worldEnv = this.worldEnvTarget.texture;
      geo.dispose();
      mat.dispose();
      this.worldBackground = c;
    }
    return this.worldEnv;
  }
}

export let renderContext: RenderContext | null = null;
export function setRenderContext(c: RenderContext) {
  renderContext = c;
}

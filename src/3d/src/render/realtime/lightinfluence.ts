// Per-light Diffuse / Glossy influence: the renderer packs lights per type in a fixed order
// (shadow casters first, then lights with a texture, in scene order); the same order is
// rebuilt here before each render so every light finds its factors in the shared uniforms.
import type { Camera, Light, Object3D, Scene } from 'three';
import { fxUniforms, MAX_LIGHTS } from './fxshader';

type LightKind = 'point' | 'spot' | 'dir' | 'sun' | 'rect';

interface LightLike {
  visible: boolean;
  castShadow?: boolean;
  map?: unknown;
  isPointLight?: boolean;
  isSpotLight?: boolean;
  isDirectionalLight?: boolean;
  isSunLight?: boolean;
  isRectAreaLight?: boolean;
  userData: { influence?: [number, number] };
}

export function lightKind(l: LightLike): LightKind | null {
  if (l.isRectAreaLight) return 'rect';
  if (l.isSunLight) return 'sun';
  if (l.isDirectionalLight) return 'dir';
  if (l.isSpotLight) return 'spot';
  if (l.isPointLight) return 'point';
  return null;
}

/** Lights in the renderer's packing order (stable sort: shadow casters, then textured lights). */
export function packedLightOrder<T extends LightLike>(lights: T[]): T[] {
  return [...lights].sort((a, b) => (b.castShadow ? 2 : 0) - (a.castShadow ? 2 : 0) + (b.map ? 1 : 0) - (a.map ? 1 : 0));
}

/** Fill the per-type arrays with (1 - diffuse, 1 - glossy) for lights in packing order. */
export function influenceArrays(lights: LightLike[]): Record<LightKind, Float32Array> {
  const out: Record<LightKind, Float32Array> = {
    point: fxUniforms.ndLiPoint.value,
    spot: fxUniforms.ndLiSpot.value,
    dir: fxUniforms.ndLiDir.value,
    sun: fxUniforms.ndLiSun.value,
    rect: fxUniforms.ndLiRect.value,
  };
  for (const a of Object.values(out)) a.fill(0);
  const n: Record<LightKind, number> = { point: 0, spot: 0, dir: 0, sun: 0, rect: 0 };
  for (const l of packedLightOrder(lights)) {
    const k = lightKind(l);
    if (!k) continue;
    const i = n[k]++;
    if (i >= MAX_LIGHTS) continue;
    const f = l.userData.influence;
    if (!f) continue;
    out[k][i * 2] = 1 - f[0];
    out[k][i * 2 + 1] = 1 - f[1];
  }
  return out;
}

const collected: Light[] = [];
function collect(o: Object3D, camera: Camera) {
  if (!o.visible) return;
  if ((o as Light).isLight && o.layers.test(camera.layers)) collected.push(o as Light);
  for (const c of o.children) collect(c, camera);
}

export function updateLightInfluence(scene: Scene, camera: Camera) {
  collected.length = 0;
  collect(scene, camera);
  influenceArrays(collected as unknown as LightLike[]);
  collected.length = 0;
}

/** Keep the influence uniforms in sync whenever `scene` renders. */
export function installLightInfluence(scene: Scene) {
  if ((scene.userData as { ndLi?: boolean }).ndLi) return;
  (scene.userData as { ndLi?: boolean }).ndLi = true;
  const prev = scene.onBeforeRender;
  scene.onBeforeRender = function (this: Scene, ...args: Parameters<Scene['onBeforeRender']>) {
    updateLightInfluence(scene, args[2]);
    prev.apply(this, args);
  };
}

// Fluid domain caches: the cache type (Replay simulates while playing; Modular and All only show
// what was baked), derived layers per frame (noise, liquid surface mesh, secondary particles,
// guide velocities) and the state of a running or paused bake.
import type { ModifierBase, ObjectData } from '../data/types';
import type { FluidModifier, FluidDomainSettings } from './fluid';

export type FluidLayer = 'data' | 'noise' | 'mesh' | 'particles' | 'guide';

/** Derived per-frame data of one domain (lives next to the domain's frame cache). */
export interface FluidLayers {
  /** hash of the data cache these layers were derived from */
  hash: string;
  /** key of the settings each layer was computed with (a change frees the unbaked layer) */
  keys: Partial<Record<FluidLayer, string>>;
  noise: Map<number, NoiseFrame>;
  mesh: Map<number, unknown>;
  particles: Map<number, SecondaryFrame>;
  guide: Map<number, Float32Array>;
  /** resumable state of the secondary particle simulation (last frame stepped) */
  secondaryLive: { frame: number; state: unknown } | null;
}

export interface NoiseFrame {
  nx: number;
  ny: number;
  nz: number;
  /** RG8: density, flame */
  data: Uint8Array;
}

export interface SecondaryFrame {
  /** domain-local positions per kind */
  spray: Float32Array;
  foam: Float32Array;
  bubbles: Float32Array;
}

const layers = new Map<string, FluidLayers>();

export function fluidLayers(key: string): FluidLayers {
  let l = layers.get(key);
  if (!l) {
    l = { hash: '', keys: {}, noise: new Map(), mesh: new Map(), particles: new Map(), guide: new Map(), secondaryLive: null };
    layers.set(key, l);
  }
  return l;
}

export function peekFluidLayers(key: string): FluidLayers | undefined {
  return layers.get(key);
}

/** Drop derived layers (all of them, or one). */
export function freeFluidLayers(key: string, which?: Exclude<FluidLayer, 'data'>) {
  const l = layers.get(key);
  if (!l) return;
  if (!which || which === 'noise') l.noise.clear();
  if (!which || which === 'mesh') l.mesh.clear();
  if (!which || which === 'particles') {
    l.particles.clear();
    l.secondaryLive = null;
  }
  if (!which || which === 'guide') l.guide.clear();
  if (which) delete l.keys[which];
  else l.keys = {};
}

export function deleteFluidLayers(key: string) {
  layers.delete(key);
}

export const cacheType = (s: Partial<FluidDomainSettings> | undefined) => s?.cache_type ?? 'REPLAY';

// ---------------------------------------------------------------------------
// Bake jobs

export interface FluidJob {
  /** domain cache key */
  key: string;
  objectId: string;
  modifierId: string;
  /** layers to bake, in order; the first one is running */
  queue: FluidLayer[];
  layer: FluidLayer;
  start: number;
  end: number;
  /** next frame to compute */
  frame: number;
  paused: boolean;
  cancelled: boolean;
  started: number;
}

let job: FluidJob | null = null;

export function fluidJob(): FluidJob | null {
  return job;
}

export function setFluidJob(j: FluidJob | null) {
  job = j;
}

/** True while the data of this domain may be simulated: Replay caches, or a running data bake. */
export function mayStepData(key: string, m: FluidModifier): boolean {
  if (cacheType(m.domain_settings) === 'REPLAY') return true;
  return !!job && job.key === key && job.layer === 'data' && !job.paused;
}

/** Whether a layer is (fully or partially) baked. */
export function layerBaked(s: Partial<FluidDomainSettings>, layer: FluidLayer): boolean {
  const k = `has_cache_baked_${layer}` as keyof FluidDomainSettings;
  return !!s[k] || !!s[`cache_frame_pause_${layer}` as keyof FluidDomainSettings];
}

/** Whether a domain has any baked (or paused) layer: its settings are then locked. */
export function anyBaked(s: Partial<FluidDomainSettings>): boolean {
  return (['data', 'noise', 'mesh', 'particles', 'guide'] as FluidLayer[]).some((l) => layerBaked(s, l));
}

/** Domain whose bake is running (for disabling settings while it runs). */
export function isBaking(ob: ObjectData, m: ModifierBase): boolean {
  return !!job && job.objectId === ob.id && job.modifierId === m.id;
}

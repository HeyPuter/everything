// Path tracer hints for subsurface scattering: the Principled BSDF's Subsurface inputs and the
// Subsurface Scattering node become random-walk settings on the converted material
// (see ptvolume.ts). Constant inputs only.
import { pbrHintBuilders } from '../../nodes/shader/material';
import type { NodeData } from '../../data/types';
import type { PbrHint } from './ptmaterial';

const num = (n: NodeData, k: string, d: number) => (typeof n.inputs[k] === 'number' ? (n.inputs[k] as number) : d);
const vec = (n: NodeData, k: string, d: [number, number, number]): [number, number, number] => {
  const v = n.inputs[k];
  return Array.isArray(v) ? [Number(v[0]), Number(v[1]), Number(v[2])] : d;
};

/** Subsurface settings of a Principled BSDF node (null when its weight is 0). */
export function principledSubsurface(n: NodeData): PbrHint['subsurface'] {
  const weight = Math.max(0, Math.min(1, num(n, 'Subsurface Weight', 0)));
  if (!(weight > 0)) return null;
  return {
    weight,
    radius: vec(n, 'Subsurface Radius', [1, 0.2, 0.1]),
    scale: Math.max(0, num(n, 'Subsurface Scale', 0.005)),
    ior: num(n, 'Subsurface IOR', 1.4),
    anisotropy: num(n, 'Subsurface Anisotropy', 0),
  };
}

const prevPrincipled = pbrHintBuilders.ShaderNodeBsdfPrincipled;
pbrHintBuilders.ShaderNodeBsdfPrincipled = (n, doc) => ({ ...(prevPrincipled?.(n, doc) ?? {}), subsurface: principledSubsurface(n) });

pbrHintBuilders.ShaderNodeSubsurfaceScattering = (n) => {
  const c = vec(n, 'Color', [0.8, 0.8, 0.8]);
  return {
    color: c,
    metalness: 0,
    transmission: 0,
    roughness: num(n, 'Roughness', 1),
    subsurface: { weight: 1, radius: vec(n, 'Radius', [1, 0.2, 0.1]), scale: Math.max(0, num(n, 'Scale', 0.005)), ior: num(n, 'IOR', 1.4), anisotropy: num(n, 'Anisotropy', 0) },
  };
};

// Volume shading parameters read from a material's (or world's) Volume output: Principled
// Volume, Volume Scatter, Volume Absorption, Volume Coefficients and Emission, combined through
// Add / Mix Shader, with densities, colours, temperatures and emission optionally driven by
// grids (Attribute / Volume Info nodes, scaled by Math Multiply or Value nodes). Every renderer
// (viewport, realtime engine, path tracer) uses this one description. Pure, unit tested.
import type { NodeData, NodeTreeData } from '../data/types';
import { getNodeType, socketDefault } from '../nodes/registry';
import { activeOutput } from '../nodes/tree';
import { blackbodyToRgb } from '../nodes/curves';

export type Vec3 = [number, number, number];

/**
 * Coefficients per unit of density D(x) = densityScale · grid(densityGrid) (grid read as 1 when
 * `densityGrid` is null): scattering σs = D·scatter, absorption σa = D·absorb. Emission adds
 * `emission · grid(emissionGrid)` radiance per unit length plus blackbody light from the
 * temperature.
 */
export interface VolumeShader {
  densityScale: number;
  densityGrid: string | null;
  scatter: Vec3;
  absorb: Vec3;
  /** grid multiplying the scattering colour (Color Attribute) */
  colorGrid: string | null;
  /** Henyey–Greenstein anisotropy (−1 back, 0 isotropic, 1 forward) */
  anisotropy: number;
  emission: Vec3;
  emissionGrid: string | null;
  blackbodyIntensity: number;
  blackbodyTint: Vec3;
  /** kelvin, multiplied by the temperature grid when set */
  temperature: number;
  temperatureGrid: string | null;
}

export const emptyVolumeShader = (): VolumeShader => ({
  densityScale: 0,
  densityGrid: null,
  scatter: [0, 0, 0],
  absorb: [0, 0, 0],
  colorGrid: null,
  anisotropy: 0,
  emission: [0, 0, 0],
  emissionGrid: null,
  blackbodyIntensity: 0,
  blackbodyTint: [1, 1, 1],
  temperature: 1000,
  temperatureGrid: null,
});

/** The default look of a volume without a material: grey smoke read from the density grid. */
export const defaultVolumeShader = (): VolumeShader => ({ ...emptyVolumeShader(), densityScale: 1, densityGrid: 'density', scatter: [0.5, 0.5, 0.5], absorb: [0.5, 0.5, 0.5] });

/** A scalar input: `k · grid(name)` (grid = 1 when null). */
interface Scalar {
  k: number;
  grid: string | null;
}

const VOLUME_INFO: Record<string, string> = { Density: 'density', Flame: 'flame', Temperature: 'temperature', Color: 'color' };

class Reader {
  constructor(private tree: NodeTreeData) {}

  link(node: NodeData, socket: string) {
    return this.tree.links.find((l) => l.to_node === node.id && l.to_socket === socket && !l.is_muted);
  }

  /** Node feeding an input (through reroutes), with the output socket. */
  source(node: NodeData, socket: string): { node: NodeData; out: string } | null {
    let l = this.link(node, socket);
    for (let guard = 0; l && guard < 64; guard++) {
      const n = this.tree.nodes.find((x) => x.id === l!.from_node);
      if (!n) return null;
      if (n.type !== 'NodeReroute') return { node: n, out: l.from_socket };
      l = this.tree.links.find((x) => x.to_node === n.id && !x.is_muted);
    }
    return null;
  }

  value(node: NodeData, socket: string): unknown {
    if (node.inputs[socket] !== undefined) return node.inputs[socket];
    const def = getNodeType(node.type)?.inputs.find((s) => s.identifier === socket);
    return def ? socketDefault(def) : undefined;
  }

  num(node: NodeData, socket: string, d: number): number {
    const v = this.value(node, socket);
    if (typeof v === 'number') return v;
    if (Array.isArray(v)) return (Number(v[0]) + Number(v[1]) + Number(v[2])) / 3;
    return d;
  }

  col(node: NodeData, socket: string, d: Vec3): Vec3 {
    const v = this.value(node, socket);
    if (Array.isArray(v)) return [Number(v[0]), Number(v[1]), Number(v[2])];
    if (typeof v === 'number') return [v, v, v];
    return d;
  }

  /** A scalar input, following simple grid-reading chains. */
  scalar(node: NodeData, socket: string, d: number, depth = 0): Scalar {
    const src = this.source(node, socket);
    if (!src || depth > 16) return { k: this.num(node, socket, d), grid: null };
    return this.scalarOut(src.node, src.out, d, depth);
  }

  private scalarOut(n: NodeData, out: string, d: number, depth: number): Scalar {
    if (n.mute) return { k: d, grid: null };
    switch (n.type) {
      case 'ShaderNodeValue':
        return { k: typeof n.props['outputs.Value'] === 'number' ? (n.props['outputs.Value'] as number) : 0.5, grid: null };
      case 'ShaderNodeAttribute': {
        const name = String(n.props.attribute_name ?? '');
        return { k: 1, grid: name || null };
      }
      case 'ShaderNodeVolumeInfo':
        return { k: 1, grid: VOLUME_INFO[out] ?? 'density' };
      case 'ShaderNodeMath': {
        const op = String(n.props.operation ?? 'ADD');
        const a = this.scalar(n, 'Value', 0.5, depth + 1);
        const b = this.scalar(n, 'Value_001', 0.5, depth + 1);
        if (op === 'MULTIPLY') {
          if (a.grid && b.grid) return { k: a.k * b.k, grid: a.grid };
          return { k: a.k * b.k, grid: a.grid ?? b.grid };
        }
        if (op === 'DIVIDE' && !b.grid) return { k: b.k ? a.k / b.k : 0, grid: a.grid };
        if (op === 'ADD' || op === 'SUBTRACT') {
          // constant offsets are dropped when a grid is involved (no affine grids)
          if (!a.grid && !b.grid) return { k: op === 'ADD' ? a.k + b.k : a.k - b.k, grid: null };
          return a.grid ? a : b;
        }
        return a;
      }
      case 'ShaderNodeSeparateColor':
      case 'ShaderNodeSeparateXYZ':
      case 'ShaderNodeRGBToBW':
        return this.scalar(n, n.type === 'ShaderNodeSeparateXYZ' ? 'Vector' : 'Color', d, depth + 1);
      case 'ShaderNodeMapRange':
      case 'ShaderNodeValToRGB':
      case 'ShaderNodeFloatCurve':
        // value remaps keep the grid (approximately linear between 0 and 1)
        return this.scalar(n, n.type === 'ShaderNodeValToRGB' ? 'Fac' : 'Value', d, depth + 1);
      default:
        return { k: d, grid: null };
    }
  }

  /** A colour input: constant, or a grid (attribute) with a white tint. */
  color(node: NodeData, socket: string, d: Vec3): { c: Vec3; grid: string | null } {
    const src = this.source(node, socket);
    if (!src) return { c: this.col(node, socket, d), grid: null };
    const n = src.node;
    if (n.type === 'ShaderNodeAttribute' && n.props.attribute_name) return { c: [1, 1, 1], grid: String(n.props.attribute_name) };
    if (n.type === 'ShaderNodeVolumeInfo') return { c: [1, 1, 1], grid: VOLUME_INFO[src.out] ?? 'color' };
    if (n.type === 'ShaderNodeRGB') {
      const v = n.props['outputs.Color'] as number[] | undefined;
      if (Array.isArray(v)) return { c: [v[0], v[1], v[2]], grid: null };
    }
    return { c: this.col(node, socket, d), grid: null };
  }

  /** Volume closure produced by a shader output. */
  shader(n: NodeData, depth = 0): VolumeShader | null {
    if (n.mute || depth > 16) return null;
    const out = emptyVolumeShader();
    switch (n.type) {
      case 'ShaderNodeVolumePrincipled': {
        const dens = this.scalar(n, 'Density', 1);
        const strName = (id: string, d: string) => {
          const v = n.inputs[id];
          return typeof v === 'string' ? v : d;
        };
        const densityAttr = strName('Density Attribute', 'density');
        const color = this.color(n, 'Color', [0.5, 0.5, 0.5]);
        const absorption = this.col(n, 'Absorption Color', [0, 0, 0]);
        out.densityScale = dens.k;
        out.densityGrid = dens.grid ?? (densityAttr || null);
        out.scatter = color.c;
        out.colorGrid = color.grid ?? (strName('Color Attribute', '') || null);
        out.absorb = [0, 1, 2].map((i) => Math.max(0, 1 - color.c[i]) * Math.max(0, 1 - absorption[i])) as Vec3;
        out.anisotropy = clampG(this.num(n, 'Anisotropy', 0));
        const es = this.scalar(n, 'Emission Strength', 0);
        const ec = this.col(n, 'Emission Color', [1, 1, 1]);
        out.emission = [ec[0] * es.k, ec[1] * es.k, ec[2] * es.k];
        out.emissionGrid = es.grid;
        out.blackbodyIntensity = Math.max(0, this.num(n, 'Blackbody Intensity', 0));
        out.blackbodyTint = this.col(n, 'Blackbody Tint', [1, 1, 1]);
        const t = this.scalar(n, 'Temperature', 1000);
        out.temperature = t.k;
        out.temperatureGrid = t.grid ?? (strName('Temperature Attribute', 'temperature') || null);
        return out;
      }
      case 'ShaderNodeVolumeScatter': {
        const dens = this.scalar(n, 'Density', 1);
        const color = this.color(n, 'Color', [0.8, 0.8, 0.8]);
        out.densityScale = dens.k;
        out.densityGrid = dens.grid;
        out.scatter = color.c;
        out.colorGrid = color.grid;
        out.anisotropy = clampG(this.num(n, 'Anisotropy', 0));
        return out;
      }
      case 'ShaderNodeVolumeAbsorption': {
        const dens = this.scalar(n, 'Density', 1);
        const c = this.col(n, 'Color', [0.8, 0.8, 0.8]);
        out.densityScale = dens.k;
        out.densityGrid = dens.grid;
        out.absorb = [Math.max(0, 1 - c[0]), Math.max(0, 1 - c[1]), Math.max(0, 1 - c[2])];
        return out;
      }
      case 'ShaderNodeVolumeCoefficients': {
        out.densityScale = 1;
        out.absorb = this.col(n, 'Absorption Coefficients', [1, 1, 1]).map((x) => Math.max(0, x)) as Vec3;
        out.scatter = this.col(n, 'Scatter Coefficients', [1, 1, 1]).map((x) => Math.max(0, x)) as Vec3;
        out.emission = this.col(n, 'Emission Coefficients', [0, 0, 0]).map((x) => Math.max(0, x)) as Vec3;
        out.anisotropy = clampG(this.num(n, 'Anisotropy', 0));
        return out;
      }
      case 'ShaderNodeEmission': {
        const s = this.scalar(n, 'Strength', 1);
        const c = this.col(n, 'Color', [1, 1, 1]);
        out.emission = [c[0] * s.k, c[1] * s.k, c[2] * s.k];
        out.emissionGrid = s.grid;
        return out;
      }
      case 'ShaderNodeAddShader': {
        const a = this.input(n, 'Shader', depth),
          b = this.input(n, 'Shader_001', depth);
        return combine(a, b, 1, 1);
      }
      case 'ShaderNodeMixShader': {
        const f = Math.min(1, Math.max(0, this.num(n, 'Fac', 0.5)));
        const a = this.input(n, 'Shader', depth),
          b = this.input(n, 'Shader_001', depth);
        return combine(a, b, 1 - f, f);
      }
      default:
        return null;
    }
  }

  input(n: NodeData, socket: string, depth: number): VolumeShader | null {
    const src = this.source(n, socket);
    return src ? this.shader(src.node, depth + 1) : null;
  }
}

const clampG = (g: number) => Math.max(-0.99, Math.min(0.99, g));

/** Weighted sum of two closures (coefficients add up; grids of the first one win). */
function combine(a: VolumeShader | null, b: VolumeShader | null, wa: number, wb: number): VolumeShader | null {
  if (!a && !b) return null;
  if (!b) return scale(a!, wa);
  if (!a) return scale(b, wb);
  const A = scale(a, wa),
    B = scale(b, wb);
  // express both per unit of the first's density
  const da = A.densityScale,
    db = B.densityScale;
  const out = { ...A };
  const ref = da > 0 ? da : db > 0 ? db : 1;
  out.densityScale = ref;
  out.densityGrid = A.densityGrid ?? B.densityGrid;
  out.scatter = [0, 1, 2].map((i) => (A.scatter[i] * da + B.scatter[i] * db) / ref) as Vec3;
  out.absorb = [0, 1, 2].map((i) => (A.absorb[i] * da + B.absorb[i] * db) / ref) as Vec3;
  out.colorGrid = A.colorGrid ?? B.colorGrid;
  const sa = da * (A.scatter[0] + A.scatter[1] + A.scatter[2]),
    sb = db * (B.scatter[0] + B.scatter[1] + B.scatter[2]);
  out.anisotropy = sa + sb > 0 ? (A.anisotropy * sa + B.anisotropy * sb) / (sa + sb) : 0;
  out.emission = [0, 1, 2].map((i) => A.emission[i] + B.emission[i]) as Vec3;
  out.emissionGrid = A.emissionGrid ?? B.emissionGrid;
  if (B.blackbodyIntensity > A.blackbodyIntensity) {
    out.blackbodyIntensity = B.blackbodyIntensity;
    out.blackbodyTint = B.blackbodyTint;
    out.temperature = B.temperature;
    out.temperatureGrid = B.temperatureGrid;
  }
  return out;
}

function scale(s: VolumeShader, w: number): VolumeShader {
  if (w === 1) return s;
  return { ...s, densityScale: s.densityScale * w, emission: s.emission.map((x) => x * w) as Vec3, blackbodyIntensity: s.blackbodyIntensity * w };
}

/** Volume shader of a node tree's output (`ShaderNodeOutputMaterial` / `ShaderNodeOutputWorld`). */
export function volumeShaderOfTree(tree: NodeTreeData | null | undefined, outputType = 'ShaderNodeOutputMaterial'): VolumeShader | null {
  if (!tree) return null;
  const out = activeOutput(tree, outputType);
  if (!out) return null;
  const r = new Reader(tree);
  const src = r.source(out, 'Volume');
  return src ? r.shader(src.node) : null;
}

/** Whether the shader emits light at all. */
export const emits = (s: VolumeShader) => s.emission.some((x) => x > 0) || s.blackbodyIntensity > 0;

/** Grid names a shader reads. */
export function shaderGrids(s: VolumeShader): string[] {
  return [s.densityGrid, s.colorGrid, s.emissionGrid, s.temperatureGrid].filter((x): x is string => !!x);
}

/** Linear RGB of a black body at `kelvin`, normalised to a maximum of 1. */
export function blackbodyColor(kelvin: number): Vec3 {
  const c = blackbodyToRgb(Math.max(800, kelvin));
  const m = Math.max(c[0], c[1], c[2], 1e-6);
  return [c[0] / m, c[1] / m, c[2] / m];
}

/** Emitted radiance per unit length of the blackbody term at a temperature. */
export function blackbodyRadiance(intensity: number, kelvin: number): number {
  // Stefan–Boltzmann: σT⁴/π, scaled so ~1500 K glows gently and ~3000 K is bright
  const T = Math.max(0, kelvin);
  return (intensity * 5.670374e-8 * T ** 4) / Math.PI / 1e5;
}

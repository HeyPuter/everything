// Texture, color and vector nodes shared with materials, evaluated per element on the CPU for
// geometry trees (`nodes/cpu/`). Unlinked texture Vector inputs read the position.
import { shared, prop, sprop } from './defs';
import { fnField, type Evaluated, type Field } from '../field';
import { positionField } from '../inputs';
import type { ExecContext, Val } from '../exec';
import type { FieldType } from '../types';
import { fieldComps } from '../types';
import { noiseTexture, type NoiseType } from '../../nodes/cpu/noise';
import { waveTexture, gradientTexture, magicTexture, checkerTexture, brickTexture, whiteNoise, gaborTexture, type WaveType, type WaveDirection, type WaveProfile, type GradientType, type BrickParams } from '../../nodes/cpu/textures';
import { readRamp, evalRamp, readCurve, evalCurve, blackbodyToRgb } from '../../nodes/curves';
import { radialTiling } from '../../nodes/shader/radial';
import { voronoi, type VoronoiFeature, type VoronoiMetric, type VoronoiParams } from '../../nodes/cpu/voronoi';

/** Per-element kernel: reads packed inputs, writes packed outputs. */
export type TexKernel = (inp: Float64Array, out: Float64Array) => void;

export interface TexSpec {
  /** input sockets (identifier, field type) in packing order */
  inputs: [string, FieldType][];
  /** output sockets (identifier, field type) in packing order */
  outputs: [string, FieldType][];
  /** builds the kernel from the node's properties and the outputs in use */
  kernel: (ctx: ExecContext, used: (output: string) => boolean) => TexKernel;
}

/**
 * Wrap a per-element kernel as field outputs. All outputs share one evaluation per set of evaluated
 * inputs (the kernel computes every output at once).
 */
export function textureFields(ctx: ExecContext, spec: TexSpec): Record<string, Val> {
  const fields: Field[] = spec.inputs.map(([id, t]) => ctx.field(id, t));
  const inComps = spec.inputs.map(([, t]) => fieldComps(t));
  const outComps = spec.outputs.map(([, t]) => fieldComps(t));
  const inSize = inComps.reduce((a, b) => a + b, 0);
  const outSize = outComps.reduce((a, b) => a + b, 0);
  const kernel = spec.kernel(ctx, (o) => ctx.used(o));
  let cache: { key: Evaluated[]; n: number; data: Float64Array } | null = null;
  const all = (e: Evaluated[], n: number) => {
    if (cache && cache.n === n && cache.key.every((k, i) => k === e[i])) return cache.data;
    const data = new Float64Array(n * outSize);
    const iv = new Float64Array(inSize);
    const ov = new Float64Array(outSize);
    for (let i = 0; i < n; i++) {
      let o = 0;
      for (let k = 0; k < e.length; k++) {
        const c = inComps[k],
          base = e[k].single ? 0 : i * c,
          d = e[k].data;
        for (let j = 0; j < c; j++) iv[o + j] = d[base + j];
        o += c;
      }
      ov.fill(0);
      kernel(iv, ov);
      data.set(ov, i * outSize);
    }
    cache = { key: e, n, data };
    return data;
  };
  const result: Record<string, Val> = {};
  let off = 0;
  spec.outputs.forEach(([id, t], k) => {
    const at = off,
      c = outComps[k];
    off += c;
    result[id] = fnField(t, fields, (e, out, n) => {
      const d = all(e, n);
      for (let i = 0; i < n; i++) for (let j = 0; j < c; j++) out[i * c + j] = d[i * outSize + at + j];
    });
  });
  return result;
}

/** Register a shader texture node for geometry trees. */
export function textureNode(idname: string, spec: TexSpec, vectorInput = 'Vector') {
  shared(idname, {
    exec: (ctx) => textureFields(ctx, spec),
    implicit: vectorInput ? { [vectorInput]: positionField } : undefined,
  });
}

const DIMS: Record<string, number> = { '1D': 1, '2D': 2, '3D': 3, '4D': 4 };

// ---------------------------------------------------------------------------
// Noise Texture

textureNode('ShaderNodeTexNoise', {
  inputs: [
    ['Vector', 'VECTOR'],
    ['W', 'FLOAT'],
    ['Scale', 'FLOAT'],
    ['Detail', 'FLOAT'],
    ['Roughness', 'FLOAT'],
    ['Lacunarity', 'FLOAT'],
    ['Offset', 'FLOAT'],
    ['Gain', 'FLOAT'],
    ['Distortion', 'FLOAT'],
  ],
  outputs: [
    ['Fac', 'FLOAT'],
    ['Color', 'RGBA'],
  ],
  kernel: (ctx, used) => {
    const n = DIMS[sprop(ctx.node, 'noise_dimensions')] ?? 3;
    const type = (sprop(ctx.node, 'noise_type') || 'FBM') as NoiseType;
    const norm = prop(ctx.node, 'normalize') !== false;
    const color = used('Color');
    const p = [0, 0, 0, 0];
    const r = [0, 0, 0, 0];
    return (iv, ov) => {
      const s = iv[4];
      if (n === 1) p[0] = iv[3] * s;
      else {
        p[0] = iv[0] * s;
        p[1] = iv[1] * s;
        p[2] = iv[2] * s;
        p[3] = iv[3] * s;
      }
      noiseTexture(p, n, { detail: iv[5], roughness: iv[6], lacunarity: iv[7], offset: iv[8], gain: iv[9], distortion: iv[10], type, normalize: norm }, color, r);
      ov[0] = r[0];
      ov[1] = r[1];
      ov[2] = r[2];
      ov[3] = r[3];
      ov[4] = 1;
    };
  },
});

// ---------------------------------------------------------------------------
// Voronoi Texture

textureNode('ShaderNodeTexVoronoi', {
  inputs: [
    ['Vector', 'VECTOR'],
    ['W', 'FLOAT'],
    ['Scale', 'FLOAT'],
    ['Detail', 'FLOAT'],
    ['Roughness', 'FLOAT'],
    ['Lacunarity', 'FLOAT'],
    ['Smoothness', 'FLOAT'],
    ['Exponent', 'FLOAT'],
    ['Randomness', 'FLOAT'],
  ],
  outputs: [
    ['Distance', 'FLOAT'],
    ['Color', 'RGBA'],
    ['Position', 'VECTOR'],
    ['W', 'FLOAT'],
    ['Radius', 'FLOAT'],
  ],
  kernel: (ctx) => {
    const n = DIMS[sprop(ctx.node, 'voronoi_dimensions')] ?? 3;
    const P: VoronoiParams = {
      n,
      scale: 5,
      detail: 0,
      roughness: 0.5,
      lacunarity: 2,
      smoothness: 1,
      exponent: 0.5,
      randomness: 1,
      feature: (sprop(ctx.node, 'feature') || 'F1') as VoronoiFeature,
      metric: (n === 1 ? 'EUCLIDEAN' : sprop(ctx.node, 'distance') || 'EUCLIDEAN') as VoronoiMetric,
      normalize: !!prop(ctx.node, 'normalize'),
    };
    const c = [0, 0, 0, 0];
    return (iv, ov) => {
      if (n === 1) c[0] = iv[3];
      else {
        c[0] = iv[0];
        c[1] = iv[1];
        c[2] = iv[2];
        c[3] = iv[3];
      }
      P.scale = iv[4];
      P.detail = iv[5];
      P.roughness = iv[6];
      P.lacunarity = iv[7];
      P.smoothness = iv[8];
      P.exponent = iv[9];
      P.randomness = Math.max(0, Math.min(1, iv[10]));
      const r = voronoi(c, P);
      ov[0] = r.distance;
      ov[1] = r.color[0];
      ov[2] = r.color[1];
      ov[3] = r.color[2];
      ov[4] = 1;
      if (n === 1) ov[8] = r.position[0];
      else {
        ov[5] = r.position[0];
        ov[6] = r.position[1];
        ov[7] = n >= 3 ? r.position[2] : 0;
        ov[8] = n === 4 ? r.position[3] : 0;
      }
      ov[9] = r.radius;
    };
  },
});

// ---------------------------------------------------------------------------
// Wave, Gradient, Magic, Checker, Brick, White Noise, Gabor

textureNode('ShaderNodeTexWave', {
  inputs: [
    ['Vector', 'VECTOR'],
    ['Scale', 'FLOAT'],
    ['Distortion', 'FLOAT'],
    ['Detail', 'FLOAT'],
    ['Detail Scale', 'FLOAT'],
    ['Detail Roughness', 'FLOAT'],
    ['Phase Offset', 'FLOAT'],
  ],
  outputs: [
    ['Color', 'RGBA'],
    ['Fac', 'FLOAT'],
  ],
  kernel: (ctx) => {
    const type = (sprop(ctx.node, 'wave_type') || 'BANDS') as WaveType;
    const bands = (sprop(ctx.node, 'bands_direction') || 'X') as WaveDirection;
    const rings = (sprop(ctx.node, 'rings_direction') || 'X') as WaveDirection;
    const profile = (sprop(ctx.node, 'wave_profile') || 'SIN') as WaveProfile;
    return (iv, ov) => {
      const s = iv[3];
      const f = waveTexture(iv[0] * s, iv[1] * s, iv[2] * s, type, bands, rings, profile, iv[4], iv[5], iv[6], iv[7], iv[8]);
      ov[0] = ov[1] = ov[2] = ov[4] = f;
      ov[3] = 1;
    };
  },
});

textureNode('ShaderNodeTexGradient', {
  inputs: [['Vector', 'VECTOR']],
  outputs: [
    ['Color', 'RGBA'],
    ['Fac', 'FLOAT'],
  ],
  kernel: (ctx) => {
    const type = (sprop(ctx.node, 'gradient_type') || 'LINEAR') as GradientType;
    return (iv, ov) => {
      const f = gradientTexture(iv[0], iv[1], iv[2], type);
      ov[0] = ov[1] = ov[2] = ov[4] = f;
      ov[3] = 1;
    };
  },
});

textureNode('ShaderNodeTexMagic', {
  inputs: [
    ['Vector', 'VECTOR'],
    ['Scale', 'FLOAT'],
    ['Distortion', 'FLOAT'],
  ],
  outputs: [
    ['Color', 'RGBA'],
    ['Fac', 'FLOAT'],
  ],
  kernel: (ctx) => {
    const depth = Number(prop(ctx.node, 'turbulence_depth') ?? 2);
    const c = [0, 0, 0];
    return (iv, ov) => {
      const s = iv[3];
      magicTexture(iv[0] * s, iv[1] * s, iv[2] * s, depth, iv[4], c);
      ov[0] = c[0];
      ov[1] = c[1];
      ov[2] = c[2];
      ov[3] = 1;
      ov[4] = (c[0] + c[1] + c[2]) / 3;
    };
  },
});

textureNode('ShaderNodeTexChecker', {
  inputs: [
    ['Vector', 'VECTOR'],
    ['Color1', 'RGBA'],
    ['Color2', 'RGBA'],
    ['Scale', 'FLOAT'],
  ],
  outputs: [
    ['Color', 'RGBA'],
    ['Fac', 'FLOAT'],
  ],
  kernel: () => (iv, ov) => {
    const s = iv[11];
    const f = checkerTexture(iv[0] * s, iv[1] * s, iv[2] * s);
    const o = f === 1 ? 3 : 7;
    for (let k = 0; k < 4; k++) ov[k] = iv[o + k];
    ov[4] = f;
  },
});

textureNode('ShaderNodeTexBrick', {
  inputs: [
    ['Vector', 'VECTOR'],
    ['Color1', 'RGBA'],
    ['Color2', 'RGBA'],
    ['Mortar', 'RGBA'],
    ['Scale', 'FLOAT'],
    ['Mortar Size', 'FLOAT'],
    ['Mortar Smooth', 'FLOAT'],
    ['Bias', 'FLOAT'],
    ['Brick Width', 'FLOAT'],
    ['Row Height', 'FLOAT'],
  ],
  outputs: [
    ['Color', 'RGBA'],
    ['Fac', 'FLOAT'],
  ],
  kernel: (ctx) => {
    const b: BrickParams = {
      mortarSize: 0,
      mortarSmooth: 0,
      bias: 0,
      brickWidth: 0.5,
      rowHeight: 0.25,
      offset: Number(prop(ctx.node, 'offset') ?? 0.5),
      offsetFrequency: Number(prop(ctx.node, 'offset_frequency') ?? 2),
      squash: Number(prop(ctx.node, 'squash') ?? 1),
      squashFrequency: Number(prop(ctx.node, 'squash_frequency') ?? 2),
    };
    const r = [0, 0];
    return (iv, ov) => {
      const s = iv[15];
      b.mortarSize = iv[16];
      b.mortarSmooth = iv[17];
      b.bias = iv[18];
      b.brickWidth = iv[19];
      b.rowHeight = iv[20];
      brickTexture(iv[0] * s, iv[1] * s, b, r);
      const [tint, f] = r;
      for (let k = 0; k < 4; k++) {
        const c1 = (1 - tint) * iv[3 + k] + tint * iv[7 + k];
        ov[k] = c1 * (1 - f) + iv[11 + k] * f;
      }
      ov[4] = f;
    };
  },
});

textureNode('ShaderNodeTexWhiteNoise', {
  inputs: [
    ['Vector', 'VECTOR'],
    ['W', 'FLOAT'],
  ],
  outputs: [
    ['Value', 'FLOAT'],
    ['Color', 'RGBA'],
  ],
  kernel: (ctx) => {
    const n = DIMS[sprop(ctx.node, 'noise_dimensions')] ?? 3;
    const p = [0, 0, 0, 0],
      r = [0, 0, 0, 0];
    return (iv, ov) => {
      if (n === 1) p[0] = iv[3];
      else for (let k = 0; k < 4; k++) p[k] = iv[k];
      whiteNoise(p, n, r);
      ov[0] = r[0];
      ov[1] = r[1];
      ov[2] = r[2];
      ov[3] = r[3];
      ov[4] = 1;
    };
  },
});

textureNode('ShaderNodeTexGabor', {
  inputs: [
    ['Vector', 'VECTOR'],
    ['Scale', 'FLOAT'],
    ['Frequency', 'FLOAT'],
    ['Anisotropy', 'FLOAT'],
    ['Orientation 2D', 'FLOAT'],
    ['Orientation 3D', 'VECTOR'],
  ],
  outputs: [
    ['Value', 'FLOAT'],
    ['Phase', 'FLOAT'],
    ['Intensity', 'FLOAT'],
  ],
  kernel: (ctx) => {
    const dims = sprop(ctx.node, 'gabor_type') === '3D' ? 3 : 2;
    const r = [0, 0, 0];
    return (iv, ov) => {
      gaborTexture(iv, dims, iv[3], iv[4], iv[5], iv[6], [iv[7], iv[8], iv[9]], r);
      ov[0] = r[0];
      ov[1] = r[1];
      ov[2] = r[2];
    };
  },
});

// ---------------------------------------------------------------------------
// Color and vector nodes

/** Register a shared node without an implicit position input. */
function fieldNode(idname: string, spec: TexSpec) {
  shared(idname, { exec: (ctx) => textureFields(ctx, spec) });
}

fieldNode('ShaderNodeValToRGB', {
  inputs: [['Fac', 'FLOAT']],
  outputs: [
    ['Color', 'RGBA'],
    ['Alpha', 'FLOAT'],
  ],
  kernel: (ctx) => {
    const ramp = readRamp(ctx.node.props);
    ramp.stops = [...ramp.stops].sort((a, b) => a.pos - b.pos);
    return (iv, ov) => {
      const c = evalRamp(ramp, iv[0]);
      ov[0] = c[0];
      ov[1] = c[1];
      ov[2] = c[2];
      ov[3] = c[3];
      ov[4] = c[3];
    };
  },
});

fieldNode('ShaderNodeRGBCurve', {
  inputs: [
    ['Fac', 'FLOAT'],
    ['Color', 'RGBA'],
  ],
  outputs: [['Color', 'RGBA']],
  kernel: (ctx) => {
    const props = ctx.node.props;
    const extend = String(props.curve_extend ?? 'EXTRAPOLATED');
    const curves = [0, 1, 2, 3].map((i) => readCurve(props, i));
    const black = (props.black_level as number[]) ?? [0, 0, 0],
      white = (props.white_level as number[]) ?? [1, 1, 1];
    return (iv, ov) => {
      const f = iv[0];
      for (let c = 0; c < 3; c++) {
        const x = iv[1 + c];
        const lv = (x - black[c]) / Math.max(1e-6, white[c] - black[c]);
        const y = evalCurve(curves[c + 1], evalCurve(curves[0], lv, extend), extend);
        ov[c] = x + (y - x) * f;
      }
      ov[3] = iv[4];
    };
  },
});

fieldNode('ShaderNodeVectorCurve', {
  inputs: [
    ['Fac', 'FLOAT'],
    ['Vector', 'VECTOR'],
  ],
  outputs: [['Vector', 'VECTOR']],
  kernel: (ctx) => {
    const props = ctx.node.props;
    const extend = String(props.curve_extend ?? 'EXTRAPOLATED');
    const curves = [0, 1, 2].map((i) => readCurve(props, i));
    return (iv, ov) => {
      for (let c = 0; c < 3; c++) {
        const x = iv[1 + c];
        ov[c] = x + (evalCurve(curves[c], x, extend) - x) * iv[0];
      }
    };
  },
});

fieldNode('ShaderNodeGamma', {
  inputs: [
    ['Color', 'RGBA'],
    ['Gamma', 'FLOAT'],
  ],
  outputs: [['Color', 'RGBA']],
  kernel: () => (iv, ov) => {
    const g = iv[4];
    for (let c = 0; c < 3; c++) ov[c] = iv[c] > 0 ? Math.pow(iv[c], g) : iv[c];
    ov[3] = iv[3];
  },
});

fieldNode('ShaderNodeBlackbody', {
  inputs: [['Temperature', 'FLOAT']],
  outputs: [['Color', 'RGBA']],
  kernel: () => (iv, ov) => {
    const c = blackbodyToRgb(iv[0]);
    ov[0] = c[0];
    ov[1] = c[1];
    ov[2] = c[2];
    ov[3] = 1;
  },
});

/** Rotate `v` about the unit axis `a` by angle `t` (right-handed). */
function rotateAxis(v: number[], a: number[], t: number, out: number[]) {
  const c = Math.cos(t),
    s = Math.sin(t);
  const d = v[0] * a[0] + v[1] * a[1] + v[2] * a[2];
  out[0] = v[0] * c + (a[1] * v[2] - a[2] * v[1]) * s + a[0] * d * (1 - c);
  out[1] = v[1] * c + (a[2] * v[0] - a[0] * v[2]) * s + a[1] * d * (1 - c);
  out[2] = v[2] * c + (a[0] * v[1] - a[1] * v[0]) * s + a[2] * d * (1 - c);
  return out;
}

textureNode('ShaderNodeVectorRotate', {
  inputs: [
    ['Vector', 'VECTOR'],
    ['Center', 'VECTOR'],
    ['Axis', 'VECTOR'],
    ['Angle', 'FLOAT'],
    ['Rotation', 'VECTOR'],
  ],
  outputs: [['Vector', 'VECTOR']],
  kernel: (ctx) => {
    const type = sprop(ctx.node, 'rotation_type') || 'AXIS_ANGLE';
    const inv = !!prop(ctx.node, 'invert');
    const v = [0, 0, 0],
      r = [0, 0, 0];
    return (iv, ov) => {
      for (let k = 0; k < 3; k++) v[k] = iv[k] - iv[3 + k];
      const sign = inv ? -1 : 1;
      if (type === 'EULER_XYZ') {
        // X, then Y, then Z (inverse: reverse order with negated angles)
        const order = inv ? [2, 1, 0] : [0, 1, 2];
        r[0] = v[0];
        r[1] = v[1];
        r[2] = v[2];
        for (const ax of order) {
          const axis = [ax === 0 ? 1 : 0, ax === 1 ? 1 : 0, ax === 2 ? 1 : 0];
          rotateAxis([r[0], r[1], r[2]], axis, sign * iv[10 + ax], r);
        }
      } else if (type === 'AXIS_ANGLE') {
        const l = Math.hypot(iv[6], iv[7], iv[8]);
        if (l === 0) {
          r[0] = v[0];
          r[1] = v[1];
          r[2] = v[2];
        } else rotateAxis(v, [iv[6] / l, iv[7] / l, iv[8] / l], sign * iv[9], r);
      } else {
        const axis = type === 'X_AXIS' ? [1, 0, 0] : type === 'Y_AXIS' ? [0, 1, 0] : [0, 0, 1];
        rotateAxis(v, axis, sign * iv[9], r);
      }
      for (let k = 0; k < 3; k++) ov[k] = r[k] + iv[3 + k];
    };
  },
});

fieldNode('ShaderNodeRadialTiling', {
  inputs: [
    ['Vector', 'VECTOR'],
    ['Sides', 'FLOAT'],
    ['Roundness', 'FLOAT'],
  ],
  outputs: [
    ['Segment Coordinates', 'VECTOR'],
    ['Segment ID', 'FLOAT'],
    ['Segment Width', 'FLOAT'],
    ['Segment Rotation', 'FLOAT'],
  ],
  kernel: (ctx) => {
    const norm = !!prop(ctx.node, 'normalize');
    return (iv, ov) => {
      const t = radialTiling(iv[0], iv[1], iv[3], iv[4], norm);
      ov[0] = t.co[0];
      ov[1] = t.co[1];
      ov[2] = t.co[2];
      ov[3] = t.id;
      ov[4] = t.width;
      ov[5] = t.rotation;
    };
  },
});

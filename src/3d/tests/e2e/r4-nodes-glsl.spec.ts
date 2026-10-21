// The GLSL texture library (materials) and the CPU textures (geometry nodes) give the same values:
// each case evaluates a GLSL expression per pixel on random points and compares with the CPU.
import { test, expect } from '@playwright/test';

test('procedural textures agree between GLSL and the CPU', async ({ page }) => {
  await page.goto('/?factory-startup');
  await page.waitForFunction(() => !!(window as unknown as { app?: unknown }).app);
  const report = await page.evaluate(async () => {
    const { collectLib } = await import('/src/nodes/shader/glsl/lib.ts');
    const N = await import('/src/nodes/cpu/noise.ts');
    const V = await import('/src/nodes/cpu/voronoi.ts');
    const X = await import('/src/nodes/cpu/textures.ts');
    const f = Math.fround;
    const COUNT = 96;
    // deterministic points in [-3, 3]^4 (single precision, shared by both sides)
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296) * 6 - 3;
    const pts: number[][] = [];
    for (let i = 0; i < COUNT; i++) pts.push([f(rnd()), f(rnd()), f(rnd()), f(rnd())]);
    const canvas = document.createElement('canvas');
    canvas.width = COUNT;
    canvas.height = 1;
    const gl = canvas.getContext('webgl2')!;
    if (!gl.getExtension('EXT_color_buffer_float')) return { skip: 'no float render targets' };
    const tex = (data: Float32Array | null) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, COUNT, 1, 0, gl.RGBA, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    };
    const input = tex(new Float32Array(pts.flat()));
    const target = tex(null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    const vs = `#version 300 es
in vec2 pos; void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;
    const run = (chunks: string[], expr: string, extra = ''): Float32Array | string => {
      const fs = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D pts; out vec4 outColor;
${collectLib(chunks)}
${extra}
void main() { vec4 p = texelFetch(pts, ivec2(int(gl_FragCoord.x), 0), 0); outColor = ${expr}; }`;
      const sh = (type: number, src: string) => {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'compile');
        return s;
      };
      let prog: WebGLProgram;
      try {
        prog = gl.createProgram()!;
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(prog);
      } catch (e) {
        return String(e);
      }
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, input);
      gl.uniform1i(gl.getUniformLocation(prog, 'pts'), 0);
      gl.viewport(0, 0, COUNT, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const out = new Float32Array(COUNT * 4);
      gl.readPixels(0, 0, COUNT, 1, gl.RGBA, gl.FLOAT, out);
      return out;
    };
    type Case = { name: string; chunks: string[]; glsl: string; cpu: (p: number[]) => number[]; tol?: number; helper?: string };
    const noiseOpts = (o: Partial<{ detail: number; roughness: number; lacunarity: number; offset: number; gain: number; distortion: number; type: string; normalize: boolean }>) => ({ detail: 2, roughness: 0.5, lacunarity: 2, offset: 0, gain: 1, distortion: 0, type: 'FBM', normalize: true, ...o });
    const noiseCpu = (n: number, s: number, o: ReturnType<typeof noiseOpts>) => (p: number[]) => {
      const q = n === 1 ? [f(p[3] * s)] : p.slice(0, n).map((x) => f(x * s));
      return N.noiseTexture(q, n, o as never, true, [0, 0, 0, 0]);
    };
    const TYPES = ['MULTIFRACTAL', 'RIDGED_MULTIFRACTAL', 'HYBRID_MULTIFRACTAL', 'FBM', 'HETERO_TERRAIN'];
    const cases: Case[] = [];
    const glslP = (n: number) => (n === 1 ? 'p.w' : n === 2 ? 'p.xy' : n === 3 ? 'p.xyz' : 'p');
    for (const n of [1, 2, 3, 4])
      cases.push({
        name: `noise ${n}D`,
        chunks: ['nd_noise_tex'],
        glsl: `nd_noise_tex${n}(${glslP(n)} * 2.5, 3.5, 0.6, 2.0, 0.0, 1.0, 0.0, 3, true)`,
        cpu: noiseCpu(n, 2.5, noiseOpts({ detail: 3.5, roughness: 0.6 })),
      });
    TYPES.forEach((t, i) =>
      cases.push({
        name: `noise 3D ${t}`,
        chunks: ['nd_noise_tex'],
        glsl: `nd_noise_tex3(p.xyz * 1.5, 3.0, 0.5, 2.0, 0.3, 1.2, 0.0, ${i}, true)`,
        cpu: noiseCpu(3, 1.5, noiseOpts({ detail: 3, offset: 0.3, gain: 1.2, type: t })),
        tol: 5e-3,
      }),
    );
    cases.push({ name: 'noise 3D distorted', chunks: ['nd_noise_tex'], glsl: 'nd_noise_tex3(p.xyz * 2.0, 2.0, 0.5, 2.0, 0.0, 1.0, 0.8, 3, false)', cpu: noiseCpu(3, 2, noiseOpts({ distortion: 0.8, normalize: false })), tol: 5e-3 });
    const FEATS = ['F1', 'F2', 'SMOOTH_F1', 'DISTANCE_TO_EDGE', 'N_SPHERE_RADIUS'];
    const METRICS = ['EUCLIDEAN', 'MANHATTAN', 'CHEBYCHEV', 'MINKOWSKI'];
    const vor = (n: number, fi: number, mi: number, detail: number, norm: boolean): Case => ({
      name: `voronoi ${n}D ${FEATS[fi]} ${METRICS[mi]} detail ${detail}${norm ? ' normalized' : ''}`,
      chunks: [`nd_voronoi${n}`],
      glsl: '',
      cpu: (p) => {
        const c = n === 1 ? [p[3]] : p.slice(0, n);
        const r = V.voronoi(c, { n, scale: 1.7, detail, roughness: 0.5, lacunarity: 2, smoothness: 0.6, exponent: 1.5, randomness: 0.9, feature: FEATS[fi] as never, metric: METRICS[mi] as never, normalize: norm });
        return [fi === 4 ? r.radius : r.distance, r.color[0], fi < 3 ? (n === 1 ? r.position[0] : r.position[0]) : 0, fi < 3 ? r.color[2] : 0];
      },
      tol: 2e-3,
    });
    const vcases: [number, number, number, number, boolean][] = [];
    for (const n of [1, 2, 3, 4]) for (const fi of [0, 1, 2, 3, 4]) vcases.push([n, fi, 0, 0, false]);
    for (const mi of [1, 2, 3]) vcases.push([3, 0, mi, 0, false]);
    vcases.push([3, 0, 0, 1.5, true], [2, 1, 0, 2, false], [3, 3, 0, 1.5, true]);
    for (const [n, fi, mi, detail, norm] of vcases) {
      const c = vor(n, fi, mi, detail, norm);
      const P = n === 1 ? 'p.w' : n === 2 ? 'p.xy' : n === 3 ? 'p.xyz' : 'p';
      const posx = n === 1 ? 'r.pos.w' : 'r.pos.x';
      c.glsl = `nd_case_v(${P})`;
      c.helper = `vec4 nd_case_v(${n === 1 ? 'float' : `vec${n}`} q) { NdVor r = nd_voronoi${n}(q, 1.7, ${detail.toFixed(2)}, 0.5, 2.0, 0.6, 1.5, 0.9, ${fi}, ${mi}, ${norm}); return vec4(${fi === 4 ? 'r.radius' : 'r.dist'}, r.col.x, ${fi < 3 ? posx : '0.0'}, ${fi < 3 ? 'r.col.z' : '0.0'}); }`;
      cases.push(c);
    }
    for (const n of [1, 2, 3, 4])
      cases.push({
        name: `white noise ${n}D`,
        chunks: ['nd_white_noise'],
        glsl: `nd_white${n}(${glslP(n)})`,
        cpu: (p) => X.whiteNoise(n === 1 ? [p[3]] : p.slice(0, n), n, [0, 0, 0, 0]),
        tol: 1e-5,
      });
    cases.push({
      name: 'wave rings distorted',
      chunks: ['nd_wave'],
      glsl: 'vec4(nd_wave(p.xyz * 1.3, 1, 0, 3, 2, 1.5, 3.0, 1.2, 0.6, 0.4))',
      cpu: (p) => [X.waveTexture(f(p[0] * 1.3), f(p[1] * 1.3), f(p[2] * 1.3), 'RINGS', 'X', 'SPHERICAL', 'TRI', 1.5, 3, 1.2, 0.6, 0.4)],
      tol: 5e-3,
    });
    cases.push({
      name: 'magic depth 6',
      chunks: ['nd_magic'],
      glsl: 'nd_magic(p.xyz * 0.7, 6, 1.7)',
      cpu: (p) => {
        const c = X.magicTexture(f(p[0] * 0.7), f(p[1] * 0.7), f(p[2] * 0.7), 6, 1.7, [0, 0, 0]);
        return [...c, (c[0] + c[1] + c[2]) / 3];
      },
      tol: 5e-3,
    });
    for (const dims of [2, 3] as const)
      cases.push({
        name: `gabor ${dims}D`,
        chunks: ['nd_gabor'],
        glsl: `vec4(nd_gabor(p.xyz, 2.0, 2.5, 0.4, 0.7, vec3(0.3, 0.5, 0.8), ${dims === 3}), 0.0)`,
        cpu: (p) => X.gaborTexture(p, dims, 2, 2.5, 0.4, 0.7, [0.3, 0.5, 0.8], [0, 0, 0]),
        tol: 5e-3,
      });
    cases.push({
      name: 'brick',
      chunks: ['nd_brick'],
      glsl: 'vec4(nd_brick(p.xyz * 3.0, 0.05, 0.3, 0.1, 0.5, 0.25, 0.5, 2.0, 0.7, 3.0), 0.0, 0.0)',
      cpu: (p) => X.brickTexture(f(p[0] * 3), f(p[1] * 3), { mortarSize: 0.05, mortarSmooth: 0.3, bias: 0.1, brickWidth: 0.5, rowHeight: 0.25, offset: 0.5, offsetFrequency: 2, squash: 0.7, squashFrequency: 3 }, [0, 0]),
      tol: 2e-3,
    });
    for (const [i, t] of ['LINEAR', 'QUADRATIC', 'EASING', 'DIAGONAL', 'SPHERICAL', 'QUADRATIC_SPHERE', 'RADIAL'].entries())
      cases.push({
        name: `gradient ${t}`,
        chunks: ['nd_gradient'],
        glsl: `vec4(clamp(nd_gradient(p.xyz * 0.3, ${i}), 0.0, 1.0))`,
        cpu: (p) => [X.gradientTexture(f(p[0] * 0.3), f(p[1] * 0.3), f(p[2] * 0.3), t as never)],
      });
    // color blend modes of the Mix node
    const M = await import('/src/geonodes/mathops.ts');
    const BLENDS = ['MIX', 'DARKEN', 'MULTIPLY', 'BURN', 'LIGHTEN', 'SCREEN', 'DODGE', 'ADD', 'OVERLAY', 'SOFT_LIGHT', 'LINEAR_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'SUBTRACT', 'DIVIDE', 'HUE', 'SATURATION', 'COLOR', 'VALUE'];
    BLENDS.forEach((mode, i) =>
      cases.push({
        name: `mix ${mode}`,
        chunks: ['nd_mix_blend'],
        glsl: `vec4(nd_blend(${i}, 0.7, abs(p.xyz) * 0.4, vec3(0.9, 0.3, 0.55)), 0.0)`,
        cpu: (p) => M.blend(mode, 0.7, [f(Math.abs(p[0]) * 0.4), f(Math.abs(p[1]) * 0.4), f(Math.abs(p[2]) * 0.4)], [0.9, 0.3, 0.55]),
        tol: 2e-3,
      }),
    );
    const fails: string[] = [];
    let compared = 0;
    for (const c of cases) {
      const out = run(c.chunks, c.glsl, c.helper);
      if (typeof out === 'string') {
        fails.push(`${c.name}: ${out.slice(0, 300)}`);
        continue;
      }
      let worst = 0,
        at = -1,
        exp: number[] = [],
        got: number[] = [];
      for (let i = 0; i < COUNT; i++) {
        const e = c.cpu(pts[i]);
        for (let k = 0; k < e.length; k++) {
          const d = Math.abs(e[k] - out[i * 4 + k]) / Math.max(1, Math.abs(e[k]));
          if (d > worst) {
            worst = d;
            at = i;
            exp = e;
            got = Array.from(out.subarray(i * 4, i * 4 + 4));
          }
        }
      }
      compared++;
      // a few points may sit on cell boundaries where single precision picks another cell
      if (worst > (c.tol ?? 1e-3)) {
        let bad = 0;
        for (let i = 0; i < COUNT; i++) {
          const e = c.cpu(pts[i]);
          if (e.some((v, k) => Math.abs(v - out[i * 4 + k]) / Math.max(1, Math.abs(v)) > (c.tol ?? 1e-3))) bad++;
        }
        if (bad > 2) fails.push(`${c.name}: ${bad} points differ, worst at ${at}: cpu ${JSON.stringify(exp)} glsl ${JSON.stringify(got)}`);
      }
    }
    return { compared, fails };
  });
  if ("skip" in report) test.skip(true, String(report.skip));
  expect((report as { fails: string[] }).fails, (report as { fails: string[] }).fails.join('\n')).toEqual([]);
  expect((report as { compared: number }).compared).toBeGreaterThan(40);
});

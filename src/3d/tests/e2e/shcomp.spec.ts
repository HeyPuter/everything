// Shader and compositor nodes of the parity round: generated GLSL compiles on the GPU, the Add
// menus list the new nodes, and compositor nodes produce the expected pixels.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/** Build a material per node type (node → Material Output) and compile it with the renderer. */
async function compileShaderNodes(page: Page, types: string[]): Promise<Record<string, string[]>> {
  return page.evaluate(async (types) => {
    const { addNode, connect, ctxOf, activeOutput } = await import('/src/nodes/tree.ts');
    const { nodeSockets } = await import('/src/nodes/registry.ts');
    const { newMaterial } = await import('/src/data/defaults.ts');
    const { compileMaterial, compileMessages } = await import('/src/nodes/shader/material.ts');
    const { renderContext } = await import('/src/render/context.ts');
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const renderer = renderContext!.engine.renderer;
    const out: Record<string, string[]> = {};
    const errors: string[] = [];
    const prev = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
      prev(...args);
    };
    try {
      for (const type of types) {
        errors.length = 0;
        const ma = newMaterial(`T_${type}`);
        a.doc.materials[ma.id] = ma;
        const t = ma.tree;
        const ctx = ctxOf(a.doc, t);
        const o = activeOutput(t, 'ShaderNodeOutputMaterial')!;
        const bsdf = t.nodes.find((n: { type: string }) => n.type === 'ShaderNodeBsdfPrincipled')!;
        const n = addNode(t, type, [-300, 0]);
        if (type === 'ShaderNodeTexIES') {
          const { newText } = await import('/src/data/defaults.ts');
          const txt = newText('lamp.ies', 'IESNA:LM-63-2002\nTILT=NONE\n1 1000 1 3 2 1 2 0 0 0\n1 1 100\n0 90 180\n0 180\n10 5 1\n8 4 2\n', 'text');
          a.doc.texts[txt.id] = txt;
          n.props.ies = txt.id;
        }
        for (const s of nodeSockets(n, ctx).outputs) {
          if (s.type === 'SHADER') connect(ctx, n.id, s.identifier, o.id, s.identifier === 'Volume' ? 'Volume' : 'Surface');
          else connect(ctx, n.id, s.identifier, bsdf.id, s.type === 'VECTOR' ? 'Normal' : s.type === 'RGBA' ? 'Base Color' : 'Roughness');
        }
        const mat = compileMaterial(a.doc, ma);
        const scene = new THREE.Scene();
        scene.add(new THREE.Mesh(new THREE.BoxGeometry(), mat));
        scene.add(new THREE.DirectionalLight());
        const cam = new THREE.PerspectiveCamera();
        cam.position.set(0, 0, 4);
        renderer.compile(scene, cam);
        const rt = new THREE.WebGLRenderTarget(8, 8);
        renderer.setRenderTarget(rt);
        renderer.render(scene, cam);
        renderer.setRenderTarget(null);
        rt.dispose();
        out[type] = [...errors, ...(compileMessages.get(ma.id) ?? [])];
      }
    } finally {
      console.error = prev;
    }
    return out;
  }, types);
}

test('new shader nodes compile to valid GLSL', async ({ page }) => {
  const errors = await openApp(page);
  const res = await compileShaderNodes(page, [
    'ShaderNodeBsdfHair',
    'ShaderNodeBsdfHairPrincipled',
    'ShaderNodeBsdfRayPortal',
    'ShaderNodeVolumeCoefficients',
    'ShaderNodeHairInfo',
    'ShaderNodeParticleInfo',
    'ShaderNodePointInfo',
    'ShaderNodeVolumeInfo',
    'ShaderNodeRadialTiling',
    'ShaderNodeTexIES',
    'FunctionNodeInputBool',
    'FunctionNodeInputInt',
    'FunctionNodeInputVector',
  ]);
  for (const [type, errs] of Object.entries(res)) expect(errs, type).toEqual([]);
  await expectNoErrors(errors);
});

// ---------------------------------------------------------------------------
// Compositor nodes against expected pixels (tests/fixtures/shcomp/compositor-expected.json)

interface CmpCase {
  W: number;
  H: number;
  image?: string;
  image2?: string;
  combined?: number[][];
  normal?: number[][];
  nodes: Record<string, { type: string; inputs?: Record<string, unknown>; props?: Record<string, unknown>; curve?: Record<string, number[][]> }>;
  links: [string, string, string, string][];
  out: [string, string];
  expected: number[][];
}

/** Run compositor cases in the page; returns bottom-up output pixels and node errors per case. */
async function compose(page: Page, cases: Record<string, CmpCase>): Promise<Record<string, { px: number[][]; errors: string[] }>> {
  return page.evaluate(async (cases) => {
    const { addNode, connect, ctxOf } = await import('/src/nodes/tree.ts');
    const { findSocket } = await import('/src/nodes/registry.ts');
    const { compositingGroup, newCompositingGroup } = await import('/src/compositor/data.ts');
    const { runCompositor } = await import('/src/compositor/run.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const doc = a.doc;
    const out: Record<string, { px: number[][]; errors: string[] }> = {};
    let version = 0;
    for (const [name, c] of Object.entries(cases)) {
      const r = doc.scene.render;
      r.resolution_x = c.W;
      r.resolution_y = c.H;
      r.resolution_percentage = 100;
      r.use_pass_normal = !!c.normal;
      const g = compositingGroup(doc) ?? newCompositingGroup(doc);
      const tree = g.tree;
      tree.nodes = tree.nodes.filter((n: { type: string }) => n.type === 'NodeGroupOutput');
      tree.links = [];
      const gout = tree.nodes[0];
      const ctx = ctxOf(doc, tree);
      const ids: Record<string, string> = {};
      const rl = addNode(tree, 'CompositorNodeRLayers', [-600, 0]);
      for (const [nid, spec] of Object.entries(c.nodes)) {
        const n = addNode(tree, spec.type, [0, 0]);
        ids[nid] = n.id;
        for (const [k, v] of Object.entries(spec.props ?? {})) n.props[k] = v;
        for (const [k, v] of Object.entries(spec.inputs ?? {})) {
          const s = findSocket(n, k, false, ctx);
          if (s) n.inputs[s.identifier] = v;
        }
        if (spec.curve) {
          for (const [ci, pts] of Object.entries(spec.curve)) n.props[`curve_${ci}`] = pts.flatMap((p) => [p[0], p[1], 0]);
        }
      }
      const sock = (nid: string, sname: string, isOut: boolean) => {
        if (nid === c.image) return { node: rl.id, id: 'Image' };
        if (nid === c.image2) return { node: rl.id, id: 'Normal' };
        const n = tree.nodes.find((x: { id: string }) => x.id === ids[nid]);
        const s = findSocket(n, sname, isOut, ctx);
        return { node: ids[nid], id: s?.identifier ?? sname };
      };
      for (const [f, fs, t, ts] of c.links) {
        const A = sock(f, fs, true),
          B = sock(t, ts, false);
        connect(ctx, A.node, A.id, B.node, B.id);
      }
      const O = sock(c.out[0], c.out[1], true);
      connect(ctx, O.node, O.id, gout.id, 'Socket_1');
      const topDown = (px: number[][] | undefined) => {
        if (!px) return undefined;
        const d = new Float32Array(c.W * c.H * 4);
        for (let y = 0; y < c.H; y++) for (let x = 0; x < c.W; x++) d.set(px[y * c.W + x], ((c.H - 1 - y) * c.W + x) * 4);
        return d;
      };
      const passes: Record<string, Float32Array> = { Combined: topDown(c.combined) ?? new Float32Array(c.W * c.H * 4) };
      if (c.normal) passes.Normal = topDown(c.normal)!;
      const res = runCompositor(doc, { layers: { width: c.W, height: c.H, version: `t${version++}`, passes }, composite: true, viewer: false });
      const px: number[][] = [];
      const data = res.composite?.data;
      for (let y = 0; y < c.H; y++)
        for (let x = 0; x < c.W; x++) {
          const k = ((c.H - 1 - y) * c.W + x) * 4;
          px.push(data ? Array.from(data.subarray(k, k + 4)) : [NaN, NaN, NaN, NaN]);
        }
      out[name] = { px, errors: [...res.errors.values(), ...(res.error ? [res.error] : [])] };
    }
    return out;
  }, cases);
}

test('compositor nodes match the expected pixels', async ({ page }) => {
  const { readFileSync } = await import('node:fs');
  const all = JSON.parse(readFileSync('tests/fixtures/shcomp/compositor-expected.json', 'utf8')).cases as Record<string, CmpCase>;
  // color spaces outside the supported set and the (smoothed) inpaint fill are checked elsewhere
  const skip = /AgX|Filmic|Khronos|PQ|^inp|^hc_hramp/;
  const cases = Object.fromEntries(Object.entries(all).filter(([k]) => !skip.test(k)));
  const errors = await openApp(page);
  const res = await compose(page, cases);
  const failures: string[] = [];
  for (const [name, c] of Object.entries(cases)) {
    const got = res[name];
    if (got.errors.length) failures.push(`${name}: ${got.errors.join('; ')}`);
    const tol = name.startsWith('hc_bump') ? 0.12 : name.startsWith('cs_') || name.startsWith('hc_') ? 2e-3 : 1e-3;
    if (name === 'sdfnp') {
      // nearest pixels may differ between equally near candidates: compare the distances
      for (let i = 0; i < c.expected.length; i++) {
        const [x, y] = [i % c.W, Math.floor(i / c.W)];
        const dg = Math.hypot(got.px[i][0] - x, got.px[i][1] - y),
          de = Math.hypot(c.expected[i][0] - x, c.expected[i][1] - y);
        if (Math.abs(dg - de) > 1e-3) failures.push(`${name}: pixel ${x},${y}: nearest at distance ${dg}, expected ${de}`);
      }
      continue;
    }
    for (let i = 0; i < c.expected.length; i++)
      for (let ch = 0; ch < 4; ch++) {
        const d = Math.abs(got.px[i][ch] - c.expected[i][ch]);
        if (!(d <= tol)) {
          failures.push(`${name}: pixel ${i % c.W},${Math.floor(i / c.W)} channel ${ch}: got ${got.px[i][ch]}, expected ${c.expected[i][ch]}`);
          ch = 4;
          i = c.expected.length;
        }
      }
  }
  expect(failures).toEqual([]);
  await expectNoErrors(errors);
});

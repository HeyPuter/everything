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

// @vitest-environment happy-dom
// Realtime subsurface scattering: node code sets the scattering parameters, the realtime shader
// patch captures / gathers diffuse light, and scenes report whether the pass is needed.
import { describe, it, expect } from 'vitest';
import { ShaderLib, Mesh, MeshPhysicalMaterial, MeshBasicMaterial, BoxGeometry, Scene } from 'three';
import '../../src/nodes/common';
import '../../src/nodes/shader/defs';
import '../../src/nodes/shader/nodegen';
import { addNode, connect, activeOutput, ctxOf } from '../../src/nodes/tree';
import { compileTree } from '../../src/nodes/shader/codegen';
import { emptyDocument, newMaterial } from '../../src/data/defaults';
import { patchFx } from '../../src/render/realtime/fxshader';
import { sceneHasSss, isSssMaterial, sssUniforms } from '../../src/render/realtime/sss';

function principled(weight: number) {
  const doc = emptyDocument();
  const ma = newMaterial();
  const p = ma.tree.nodes.find((n) => n.type === 'ShaderNodeBsdfPrincipled')!;
  p.inputs['Subsurface Weight'] = weight;
  return { doc, ma };
}

describe('realtime subsurface scattering', () => {
  it('Principled BSDF with a subsurface weight sets the scattering radius', () => {
    const { doc, ma } = principled(0.5);
    const ct = compileTree(doc, ma.tree, 'MATERIAL');
    expect(ct.errors).toEqual([]);
    expect(ct.lib).toContain('ND_HAS_SSS');
    expect(ct.body).toMatch(/nd_sss_set\(/);
    const off = principled(0);
    expect(compileTree(off.doc, off.ma.tree, 'MATERIAL').lib).not.toContain('ND_HAS_SSS');
  });

  it('the Subsurface Scattering node scatters with full weight; worlds never do', () => {
    const doc = emptyDocument();
    const ma = newMaterial();
    const t = ma.tree;
    const ss = addNode(t, 'ShaderNodeSubsurfaceScattering', [-200, 0]);
    connect(ctxOf(doc, t), ss.id, 'BSSRDF', activeOutput(t, 'ShaderNodeOutputMaterial')!.id, 'Surface');
    const ct = compileTree(doc, t, 'MATERIAL');
    expect(ct.body).toMatch(/nd_sss_set\(1\.0,/);
  });

  it('patches the physical shader with the capture and gather steps', () => {
    const shader = { fragmentShader: ShaderLib.physical.fragmentShader, vertexShader: ShaderLib.physical.vertexShader, uniforms: {} as Record<string, unknown> } as never as Parameters<typeof patchFx>[0];
    patchFx(shader);
    const f = shader.fragmentShader;
    expect(f).toContain('ndSssGather');
    // the gather runs after the lights and before the diffuse total is formed
    expect(f.indexOf('ndSssGather( ndSssIrr')).toBeGreaterThan(f.indexOf('#include <aomap_fragment>'));
    expect(f.indexOf('ndSssGather( ndSssIrr')).toBeLessThan(f.indexOf('vec3 totalDiffuse'));
    // the capture output comes last
    expect(f.lastIndexOf('ndSss.x < 1.5')).toBeGreaterThan(f.indexOf('#include <dithering_fragment>'));
    expect(shader.uniforms).toHaveProperty('ndSss', sssUniforms.ndSss);
    expect(shader.uniforms).toHaveProperty('ndSssTex');
  });

  it('detects scenes with subsurface materials', () => {
    const scene = new Scene();
    const plain = new Mesh(new BoxGeometry(), new MeshPhysicalMaterial());
    scene.add(plain);
    expect(sceneHasSss(scene)).toBe(false);
    const skin = new MeshPhysicalMaterial();
    skin.userData.ndSss = true;
    const m = new Mesh(new BoxGeometry(), [new MeshBasicMaterial(), skin]);
    scene.add(m);
    expect(isSssMaterial(m.material)).toBe(true);
    expect(sceneHasSss(scene)).toBe(true);
    m.visible = false;
    expect(sceneHasSss(scene)).toBe(false);
  });
});

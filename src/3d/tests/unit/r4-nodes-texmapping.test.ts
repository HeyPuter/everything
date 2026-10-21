// @vitest-environment happy-dom
// Texture Mapping of texture nodes: the transform matches the matrix the reference stores for the
// same settings, the GLSL applies it, scripts and .blend files can set it.
import { describe, it, expect } from 'vitest';
import '../../src/nodes/index';
import { texMappingTransform, applyTexMapping, texMapping, setTexMapping, isIdentityMapping, DEFAULT_TEX_MAPPING } from '../../src/nodes/texmapping';
import { compileTree } from '../../src/nodes/shader/codegen';
import { addNode, connect, ctxOf, activeOutput } from '../../src/nodes/tree';
import { emptyDocument, newMaterial } from '../../src/data/defaults';

describe('texture mapping', () => {
  it('composes axis remap and the inverse transform like the reference (Texture type)', () => {
    const m = { ...DEFAULT_TEX_MAPPING, vector_type: 'TEXTURE' as const, translation: [1, 2, 3] as [number, number, number], rotation: [0.1, 0.2, 0.3] as [number, number, number], scale: [2, 3, 4] as [number, number, number], mapping_x: 'Y' as const, mapping_y: 'NONE' as const, mapping_z: 'X' as const };
    // matrix recorded from the reference (column-major 4×4)
    const stored = [-0.09933464229106903, 0.03261445835232735, 0.2437925487756729, 0, 0.4681466221809387, -0.09169860184192657, 0.054587654769420624, 0, 0, 0, 0, 0, -0.45977210998535156, -0.6437614560127258, -0.7674868106842041, 1];
    const { L, t } = texMappingTransform(m);
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) expect(L[r * 3 + c]).toBeCloseTo(stored[c * 4 + r], 5);
    for (let r = 0; r < 3; r++) expect(t[r]).toBeCloseTo(stored[12 + r], 5);
  });

  it('Point mapping scales, rotates, then moves', () => {
    const p = applyTexMapping({ ...DEFAULT_TEX_MAPPING, translation: [1, 0, 0], rotation: [0, 0, Math.PI / 2], scale: [2, 2, 2] }, [1, 0, 0]);
    expect(p[0]).toBeCloseTo(1);
    expect(p[1]).toBeCloseTo(2);
    expect(isIdentityMapping(DEFAULT_TEX_MAPPING)).toBe(true);
  });

  it('the shader compiler applies a non-identity mapping only', () => {
    const doc = emptyDocument();
    const ma = newMaterial('T');
    const t = ma.tree;
    const n = addNode(t, 'ShaderNodeTexNoise', [-300, 0]);
    const bsdf = t.nodes.find((x) => x.type === 'ShaderNodeBsdfPrincipled')!;
    connect(ctxOf(doc, t), n.id, 'Fac', bsdf.id, 'Roughness');
    const plain = compileTree(doc, t, 'MATERIAL');
    expect(texMapping(n).vector_type).toBe('POINT');
    setTexMapping(n, { scale: [3, 3, 3] });
    const mapped = compileTree(doc, t, 'MATERIAL');
    expect(mapped.key).not.toBe(plain.key);
    expect(mapped.uniforms.some((u) => JSON.stringify(u.value) === JSON.stringify([3, 0, 0]))).toBe(true);
    expect(activeOutput(t, 'ShaderNodeOutputMaterial')).toBeDefined();
  });
});

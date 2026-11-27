import { describe, expect, it } from 'vitest';
import { boxMesh, meshFromPrompt, toObj, uvSphereMesh } from '../src/engine/mesh.js';

describe('mesh studio', () => {
  it('builds a box with 8 vertices', () => {
    const m = boxMesh(2, 2, 2);
    expect(m.vertices).toHaveLength(8);
    expect(m.faces.length).toBeGreaterThan(0);
  });

  it('builds a sphere', () => {
    const m = uvSphereMesh(4, 8);
    expect(m.vertices.length).toBeGreaterThan(10);
  });

  it('routes prompts to kinds', () => {
    expect(meshFromPrompt('a red sphere').kind).toBe('sphere');
    expect(meshFromPrompt('rolling hills terrain').kind).toBe('terrain');
    expect(meshFromPrompt('crate').kind).toBe('box');
  });

  it('exports OBJ with v/f lines', () => {
    const obj = toObj(boxMesh());
    expect(obj).toMatch(/^v /m);
    expect(obj).toMatch(/^f /m);
  });
});

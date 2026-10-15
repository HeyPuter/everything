import { describe, it, expect } from 'vitest';
import { readGltf } from '../../src/io/formats/gltf/read';
import { commitScene } from '../../src/io/formats/to-document';
import { Depsgraph } from '../../src/eval/depsgraph';
import { fixture, freshDoc, byName, EXPECTED_BBOX, expectBBox, dumpOutput } from '../fixtures/formats/helpers';
import { buildExportScene } from '../../src/io/formats/scene-builder';
import { writeGltf } from '../../src/io/formats/gltf/write';
// @ts-expect-error no types
import validator from 'gltf-validator';

async function validate(bytes: Uint8Array | string) {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const report = await validator.validateBytes(data, { maxIssues: 50 });
  return report.issues as { numErrors: number; numWarnings: number; messages: { code: string; message: string; severity: number; pointer?: string }[] };
}

describe('glTF import (fixture)', () => {
  it('imports hierarchy, meshes, materials, lights, camera, armature, shape keys and animations', () => {
    const doc = freshDoc();
    const ir = readGltf(fixture('ref_scene.glb'));
    const res = commitScene(doc, ir);
    const names = res.objects.map((o) => o.name).sort();
    expect(names).toEqual(['Cam', 'Cube', 'Ngon', 'Plane', 'Point', 'Rig', 'Skinned', 'Sphere', 'Spot', 'Sun'].sort());
    const cube = byName(doc, 'Cube');
    const me = doc.meshes[cube.data!];
    // glTF triangulates: 6 quads → 12 triangles, vertices split per primitive/normal
    expect(me.offsets.length - 1).toBe(12);
    expect(me.materials.length).toBe(2);
    expect(doc.materials[me.materials[0]!].name).toBe('Red');
    expect(me.smooth!.every((s) => s === 0)).toBe(true);
    const sphere = byName(doc, 'Sphere');
    expect(sphere.parent).toBe(cube.id);
    expect(doc.meshes[sphere.data!].smooth!.some((s) => s === 1)).toBe(true);
    // Z-up: cube at (0,0,1) at frame 1
    expect(cube.location[2]).toBeCloseTo(1, 4);
    // lights round-trip to watts
    const point = byName(doc, 'Point');
    expect(doc.lights[point.data!].energy).toBeCloseTo(500, 2);
    const sun = byName(doc, 'Sun');
    expect(doc.lights[sun.data!].energy).toBeCloseTo(2.5, 3);
    expect(byName(doc, 'Point').location).toEqual([expect.closeTo(0, 4), expect.closeTo(0, 4), expect.closeTo(5, 4)]);
    // expected camera orientation: rotation_euler (1.1, 0, 0.8)
    const cam = byName(doc, 'Cam');
    expect(cam.rotation_euler[0]).toBeCloseTo(1.1, 4);
    expect(cam.rotation_euler[2]).toBeCloseTo(0.8, 4);
    expect(doc.cameras[cam.data!].sensor_fit).toBe('VERTICAL');
    // armature
    const rig = byName(doc, 'Rig');
    const arm = doc.armatures[rig.data!];
    expect(arm.bones.map((b) => b.name).sort()).toEqual(['Mid', 'Root', 'Tip']);
    const mid = arm.bones.find((b) => b.name === 'Mid')!;
    expect(mid.parent).toBe('Root');
    expect(mid.head[2]).toBeCloseTo(1, 4);
    expect(mid.tail[2]).toBeCloseTo(2, 4);
    const skinned = byName(doc, 'Skinned');
    expect(skinned.parent).toBe(rig.id);
    expect(skinned.modifiers[0].type).toBe('ARMATURE');
    expect(doc.meshes[skinned.data!].vertex_groups.map((g) => g.name).sort()).toEqual(['Mid', 'Root', 'Tip']);
    // shape keys + animation
    const plane = byName(doc, 'Plane');
    const pme = doc.meshes[plane.data!];
    expect(pme.shape_keys.map((k) => k.name)).toEqual(['Basis', 'Lift']);
    const pact = doc.actions[plane.animation_data!.action!];
    expect(pact.fcurves[0].data_path).toBe('data.shape_keys.key_blocks["Lift"].value');
    const ract = doc.actions[rig.animation_data!.action!];
    expect(ract.fcurves.some((f) => f.data_path === 'pose.bones["Mid"].rotation_quaternion')).toBe(true);
    // textured material has an image texture node
    const pmat = doc.materials[pme.materials[0]!];
    expect(pmat.tree.nodes.some((n) => n.type === 'ShaderNodeTexImage' && doc.images[n.props.image as string]?.width === 4)).toBe(true);
    expect(res.warnings).toEqual([]);
  });

  it('skinned mesh deforms like the source (rest pose and animated pose)', () => {
    const doc = freshDoc();
    commitScene(doc, readGltf(fixture('ref_scene.glb')));
    const graph = new Depsgraph(doc);
    const skinned = byName(doc, 'Skinned');
    doc.scene.frame_current = 1;
    graph.evaluate(doc);
    const ev = graph.get(skinned.id)!;
    const p = ev.mesh!.positions;
    // rest: cylinder from z=0..2.8 around x=4 in world space
    let minZ = Infinity,
      maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const v = [p[i], p[i + 1], p[i + 2]];
      const w = ev.world.elements;
      const z = w[2] * v[0] + w[6] * v[1] + w[10] * v[2] + w[14];
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    expect(minZ).toBeCloseTo(0, 3);
    expect(maxZ).toBeCloseTo(2.8, 3);
    doc.scene.frame_current = 24;
    graph.evaluate(doc);
    const p2 = graph.get(skinned.id)!.mesh!.positions;
    let maxY = -Infinity;
    for (let i = 0; i < p2.length; i += 3) maxY = Math.max(maxY, Math.abs(p2[i + 1]));
    // Mid bone rotated 45° about X: the tip bends sideways in Y
    expect(maxY).toBeGreaterThan(0.5);
  });

  it('matches the expected evaluated geometry at frames 1/12/24 (skin, shape keys, object animation)', () => {
    const doc = freshDoc();
    commitScene(doc, readGltf(fixture('ref_scene.glb')));
    const graph = new Depsgraph(doc);
    for (const [name, frames] of Object.entries(EXPECTED_BBOX)) for (const [f, bb] of Object.entries(frames)) expectBBox(doc, name, Number(f), bb, 2e-3, graph);
  });

  for (const format of ['GLB', 'GLTF_EMBEDDED'] as const)
    it(`round-trips through ${format} export: valid file, same evaluated geometry`, async () => {
      const src = freshDoc();
      commitScene(src, readGltf(fixture('ref_scene.glb')));
      src.scene.frame_current = 1;
      const graph = new Depsgraph(src).evaluate(src);
      const scene = buildExportScene(src, {}, graph);
      const out = await writeGltf(scene, { format });
      dumpOutput(format === 'GLB' ? 'roundtrip.glb' : 'roundtrip.gltf', out.bytes);
      const issues = await validate(out.bytes);
      if (process.env.FORMATS_OUT) console.log(format, JSON.stringify(issues.messages.map((m) => [m.code, m.pointer])), out.warnings);
      const errors = issues.messages.filter((m) => m.severity === 0);
      expect(errors).toEqual([]);
      const doc = freshDoc();
      const bytes = typeof out.bytes === 'string' ? new TextEncoder().encode(out.bytes) : out.bytes;
      const res = commitScene(doc, readGltf(bytes));
      expect(res.objects.map((o) => o.name).sort()).toEqual(['Cam', 'Cube', 'Ngon', 'Plane', 'Point', 'Rig', 'Skinned', 'Sphere', 'Spot', 'Sun'].sort());
      const g2 = new Depsgraph(doc);
      for (const [name, frames] of Object.entries(EXPECTED_BBOX)) for (const [f, bb] of Object.entries(frames)) expectBBox(doc, name, Number(f), bb, 2e-3, g2);
      const cam = byName(doc, 'Cam');
      expect(cam.rotation_euler[0]).toBeCloseTo(1.1, 4);
      expect(doc.lights[byName(doc, 'Point').data!].energy).toBeCloseTo(500, 2);
      expect(doc.lights[byName(doc, 'Spot').data!].spot_size).toBeCloseTo(Math.PI / 4, 4);
      const pme = doc.meshes[byName(doc, 'Plane').data!];
      expect(doc.materials[pme.materials[0]!].tree.nodes.some((n) => n.type === 'ShaderNodeTexImage')).toBe(true);
    });

  it('Merge Vertices welds split vertices and keeps hard edges sharp', async () => {
    const { cornerNormals } = await import('../../src/mesh/mesh');
    const doc = freshDoc();
    commitScene(doc, readGltf(fixture('ref_scene.glb')), { mergeVertices: true });
    const cube = doc.meshes[byName(doc, 'Cube').data!];
    expect(cube.positions.length / 3).toBe(8);
    const sphere = doc.meshes[byName(doc, 'Sphere').data!];
    expect(sphere.positions.length / 3).toBe(62); // expected vertex count
    // flat cube faces stay flat: every corner normal equals its face normal
    const n = cornerNormals(cube);
    for (let f = 0; f < cube.offsets.length - 1; f++)
      for (let c = cube.offsets[f]; c < cube.offsets[f + 1]; c++)
        expect(n[c * 3] * cube.normals[c * 3] + n[c * 3 + 1] * cube.normals[c * 3 + 1] + n[c * 3 + 2] * cube.normals[c * 3 + 2]).toBeGreaterThan(0.999);
  });

  it('imports CUBICSPLINE (as Bézier keys) and STEP animation exactly', async () => {
    const { evaluateFCurve } = await import('../../src/anim/fcurve');
    // one node, translation X: cubic spline keys at t=0 and t=1 (value 0 → 2, out-tangent 4, in-tangent 0)
    const times = new Float32Array([0, 1]);
    const cubic = new Float32Array([0, 0, 0, 0, 0, 0, 4, 0, 0, /* key1 */ 0, 0, 0, 2, 0, 0, 0, 0, 0]);
    const stepTimes = new Float32Array([0, 0.5]);
    const step = new Float32Array([1, 1, 1, 3, 3, 3]);
    const bin = new Uint8Array([...new Uint8Array(times.buffer), ...new Uint8Array(cubic.buffer), ...new Uint8Array(stepTimes.buffer), ...new Uint8Array(step.buffer)]);
    const b64 = Buffer.from(bin).toString('base64');
    const json = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'N' }],
      buffers: [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${b64}` }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 8 },
        { buffer: 0, byteOffset: 8, byteLength: 72 },
        { buffer: 0, byteOffset: 80, byteLength: 8 },
        { buffer: 0, byteOffset: 88, byteLength: 24 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
        { bufferView: 1, componentType: 5126, count: 6, type: 'VEC3' },
        { bufferView: 2, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [0.5] },
        { bufferView: 3, componentType: 5126, count: 2, type: 'VEC3' },
      ],
      animations: [
        { name: 'A', samplers: [{ input: 0, output: 1, interpolation: 'CUBICSPLINE' }, { input: 2, output: 3, interpolation: 'STEP' }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }, { sampler: 1, target: { node: 0, path: 'scale' } }] },
      ],
    };
    const doc = freshDoc();
    commitScene(doc, readGltf(new TextEncoder().encode(JSON.stringify(json))));
    const ob = byName(doc, 'N');
    const act = doc.actions[ob.animation_data!.action!];
    const lx = act.fcurves.find((f) => f.data_path === 'location' && f.array_index === 0)!;
    // Hermite: p(u) = h00·0 + h10·4 + h01·2, at t = 0.25 s (frame 6 at 24 fps)
    const u = 0.25,
      expected = (u ** 3 - 2 * u ** 2 + u) * 4 + (-2 * u ** 3 + 3 * u ** 2) * 2;
    expect(lx.keyframe_points[0].interpolation).toBe('BEZIER');
    expect(evaluateFCurve(lx, 6)).toBeCloseTo(expected, 3);
    const sx = act.fcurves.find((f) => f.data_path === 'scale' && f.array_index === 0)!;
    expect(sx.keyframe_points[0].interpolation).toBe('CONSTANT');
    expect(evaluateFCurve(sx, 11.9)).toBeCloseTo(1, 6);
    expect(evaluateFCurve(sx, 12)).toBeCloseTo(3, 6);
  });

  it('round-trips KHR_texture_transform through a Mapping node', async () => {
    const png = Buffer.from(fixture('checker.png')).toString('base64');
    const xf = { offset: [0.25, 0.1], rotation: 0.3, scale: [2, 3] };
    const json = {
      asset: { version: '2.0' },
      extensionsUsed: ['KHR_texture_transform'],
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Quad', mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
      materials: [{ name: 'M', pbrMetallicRoughness: { baseColorTexture: { index: 0, extensions: { KHR_texture_transform: xf } } } }],
      textures: [{ source: 0 }],
      images: [{ uri: `data:image/png;base64,${png}` }],
      buffers: [{ byteLength: 60, uri: `data:application/octet-stream;base64,${Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1]).buffer).toString('base64')}` }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 24 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
      ],
    };
    const doc = freshDoc();
    commitScene(doc, readGltf(new TextEncoder().encode(JSON.stringify(json))));
    const ma = Object.values(doc.materials).find((m) => m.name === 'M')!;
    expect(ma.tree.nodes.some((n) => n.type === 'ShaderNodeMapping')).toBe(true);
    const out = await writeGltf(buildExportScene(doc, {}, new Depsgraph(doc).evaluate(doc)), { format: 'GLTF_EMBEDDED' });
    const back = JSON.parse(out.bytes as string);
    const t = back.materials[0].pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform;
    expect(t.offset[0]).toBeCloseTo(0.25, 5);
    expect(t.offset[1]).toBeCloseTo(0.1, 5);
    expect(t.rotation).toBeCloseTo(0.3, 5);
    expect(t.scale[0]).toBeCloseTo(2, 5);
    expect(t.scale[1]).toBeCloseTo(3, 5);
    const issues = await validate(out.bytes);
    expect(issues.numErrors).toBe(0);
  });
});

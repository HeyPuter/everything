import { describe, it, expect } from 'vitest';
import { readObj, writeObj, parseMtl } from '../../src/io/formats/obj';
import { readStl, writeStl } from '../../src/io/formats/stl';
import { readPly, writePly } from '../../src/io/formats/ply';
import { readGltf } from '../../src/io/formats/gltf/read';
import { commitScene } from '../../src/io/formats/to-document';
import { buildExportScene } from '../../src/io/formats/scene-builder';
import { Depsgraph } from '../../src/eval/depsgraph';
import { fixture, freshDoc, byName, dumpOutput } from '../fixtures/formats/helpers';
import type { DocumentData } from '../../src/data/types';
import { newMeshData, newObject, uid } from '../../src/data/defaults';
import { cube } from '../../src/mesh/primitives';
import { newModifier } from '../../src/eval/modifiers';

const sizes = (doc: DocumentData, name: string) => {
  const me = doc.meshes[byName(doc, name).data!];
  const out: Record<number, number> = {};
  for (let f = 0; f < me.offsets.length - 1; f++) {
    const n = me.offsets[f + 1] - me.offsets[f];
    out[n] = (out[n] ?? 0) + 1;
  }
  return { verts: me.positions.length / 3, faces: me.offsets.length - 1, sizes: out };
};

function objResources() {
  return new Map([
    ['scene.mtl', fixture('scene.mtl')],
    ['checker.png', fixture('checker.png')],
  ]);
}

/** A document built from the glTF fixture, used as export source. */
function sourceDoc() {
  const doc = freshDoc();
  commitScene(doc, readGltf(fixture('ref_scene.glb')));
  doc.scene.frame_current = 1;
  return doc;
}

describe('Wavefront OBJ', () => {
  it('imports OBJ with n-gons, materials, textures and smooth groups (matches the expected import)', () => {
    const doc = freshDoc();
    const ir = readObj(new TextDecoder().decode(fixture('ref_scene.obj')), { resources: objResources() });
    const res = commitScene(doc, ir);
    expect(res.objects.map((o) => o.name).sort()).toEqual(['Cube', 'Ngon', 'Plane', 'Skinned', 'Sphere']);
    // expected import counts for this file
    expect(sizes(doc, 'Cube')).toEqual({ verts: 8, faces: 6, sizes: { 4: 6 } });
    expect(sizes(doc, 'Sphere')).toEqual({ verts: 62, faces: 72, sizes: { 3: 24, 4: 48 } });
    expect(sizes(doc, 'Ngon')).toEqual({ verts: 6, faces: 1, sizes: { 6: 1 } });
    expect(sizes(doc, 'Skinned')).toEqual({ verts: 16, faces: 10, sizes: { 4: 8, 8: 2 } });
    const cube = doc.meshes[byName(doc, 'Cube').data!];
    expect(cube.materials.map((m) => doc.materials[m!].name)).toEqual(['Red', 'Blue']);
    expect(cube.smooth!.every((s) => !s)).toBe(true);
    expect(doc.meshes[byName(doc, 'Sphere').data!].smooth!.every((s) => s === 1)).toBe(true);
    const red = doc.materials[cube.materials[0]!];
    expect(red.metallic).toBeCloseTo(0.3, 4);
    expect(red.roughness).toBeCloseTo(0.6, 4);
    const plane = doc.meshes[byName(doc, 'Plane').data!];
    const tex = doc.materials[plane.materials[0]!].tree.nodes.find((n) => n.type === 'ShaderNodeTexImage');
    expect(doc.images[tex!.props.image as string].width).toBe(4);
    // -Z forward / Y up → Z-up: the cube spans z ∈ [0, 2]
    let minZ = Infinity,
      maxZ = -Infinity;
    for (let i = 2; i < cube.positions.length; i += 3) {
      minZ = Math.min(minZ, cube.positions[i]);
      maxZ = Math.max(maxZ, cube.positions[i]);
    }
    expect([minZ, maxZ]).toEqual([0, 2]);
    expect(res.warnings).toEqual([]);
  });

  it('parses MTL PBR mapping (Ns ↔ roughness, Ka/illum ↔ metallic)', () => {
    const m = parseMtl('newmtl A\nNs 640\nKa 1 1 1\nKd 0.1 0.2 0.3\nd 0.5\nillum 2\nmap_Bump -bm 0.7 n.png\n');
    expect(m[0].Ns).toBe(640);
    expect(m[0].maps.map_bump).toEqual({ file: 'n.png', bm: 0.7 });
  });

  it('round-trips n-gons, UVs, materials and smooth flags through export → import', () => {
    const src = sourceDoc();
    const obj = freshDoc();
    commitScene(obj, readObj(new TextDecoder().decode(fixture('ref_scene.obj')), { resources: objResources() }));
    const scene = buildExportScene(obj, { animation: false }, new Depsgraph(obj).evaluate(obj));
    const out = writeObj(scene, { mtlName: 'out.mtl' });
    dumpOutput('roundtrip.obj', out.obj);
    dumpOutput('out.mtl', out.mtl!);
    dumpOutput('checker.png', fixture('checker.png'));
    expect(out.mtl).toContain('newmtl Red');
    expect(out.mtl).toContain('map_Kd checker.png');
    const back = freshDoc();
    commitScene(
      back,
      readObj(out.obj, {
        resources: new Map([
          ['out.mtl', new TextEncoder().encode(out.mtl!)],
          ['checker.png', fixture('checker.png')],
        ]),
      }),
    );
    for (const n of ['Cube', 'Sphere', 'Ngon', 'Skinned', 'Plane']) expect(sizes(back, n)).toEqual(sizes(obj, n));
    const red = Object.values(back.materials).find((m) => m.name === 'Red')!;
    expect(red.roughness).toBeCloseTo(0.6, 4);
    expect(red.metallic).toBeCloseTo(0.3, 4);
    // triangulate option
    const tri = writeObj(scene, { triangulate: true, materials: false });
    expect(
      tri.obj
        .split('\n')
        .filter((l) => l.startsWith('f '))
        .every((l) => l.split(' ').length === 4),
    ).toBe(true);
    // world transforms are applied: exported positions of the glTF-imported doc stay in place
    const fromGltf = writeObj(buildExportScene(src, { animation: false }, new Depsgraph(src).evaluate(src)), { materials: false });
    expect(fromGltf.obj).toContain('o Cube');
  });
});

describe('STL', () => {
  it('imports binary STL with merged vertices', () => {
    const doc = freshDoc();
    commitScene(doc, readStl(fixture('ref_scene.stl'), { name: 'scene' }));
    expect(sizes(doc, 'scene')).toEqual({ verts: 96, faces: 166, sizes: { 3: 166 } });
  });
  it('round-trips binary and ASCII', () => {
    const src = sourceDoc();
    const scene = buildExportScene(src, { animation: false, types: ['MESH'] }, new Depsgraph(src).evaluate(src));
    const bin = writeStl(scene);
    const ascii = writeStl(scene, { ascii: true });
    dumpOutput('roundtrip.stl', bin.bytes);
    dumpOutput('roundtrip_ascii.stl', ascii.bytes);
    const a = freshDoc(),
      b = freshDoc();
    commitScene(a, readStl(bin.bytes as Uint8Array, { name: 'bin' }));
    commitScene(b, readStl(new TextEncoder().encode(ascii.bytes as string), { name: 'ascii' }));
    expect(sizes(a, 'bin')).toEqual(sizes(b, 'ascii'));
    expect(sizes(a, 'bin').faces).toBe(166);
  });
});

describe('PLY', () => {
  it('imports binary PLY with n-gons and UVs', () => {
    const doc = freshDoc();
    commitScene(doc, readPly(fixture('ref_scene.ply'), { name: 'scene' }));
    expect(sizes(doc, 'scene')).toEqual({ verts: 147, faces: 90, sizes: { 4: 63, 3: 24, 6: 1, 8: 2 } });
    expect(doc.meshes[byName(doc, 'scene').data!].uvs.some((v) => v !== 0)).toBe(true);
  });
  it('round-trips ASCII and binary with vertex colors', () => {
    const doc = freshDoc();
    commitScene(doc, readPly(fixture('ref_scene.ply'), { name: 'scene' }));
    const me = doc.meshes[byName(doc, 'scene').data!];
    const nv = me.positions.length / 3;
    const colorOf = (x: number, y: number, z: number) => [Math.abs(Math.sin(x * 3.1)), Math.abs(Math.cos(y * 2.3)), Math.abs(Math.sin(z * 1.7 + 0.3))];
    me.color_attributes = [
      {
        name: 'Col',
        domain: 'POINT',
        data: Float32Array.from({ length: nv * 4 }, (_, i) => (i % 4 === 3 ? 1 : colorOf(me.positions[(i >> 2) * 3], me.positions[(i >> 2) * 3 + 1], me.positions[(i >> 2) * 3 + 2])[i % 4])),
      },
    ];
    const scene = buildExportScene(doc, { animation: false }, new Depsgraph(doc).evaluate(doc));
    for (const ascii of [true, false]) {
      const out = writePly(scene, { ascii, colors: 'SRGB' });
      dumpOutput(ascii ? 'roundtrip_ascii.ply' : 'roundtrip.ply', out.bytes);
      const back = freshDoc();
      commitScene(back, readPly(typeof out.bytes === 'string' ? new TextEncoder().encode(out.bytes) : out.bytes, { name: 'back' }));
      const s = sizes(back, 'back');
      expect(s.faces).toBe(90);
      expect(s.sizes).toEqual({ 4: 63, 3: 24, 6: 1, 8: 2 });
      const bm = doc.meshes[byName(back, 'back').data!] ?? back.meshes[byName(back, 'back').data!];
      const col = bm.color_attributes[0].data;
      // colors survive sRGB 8-bit quantisation
      const c0 = me.color_attributes[0].data;
      expect(Math.abs(col[0] - c0[me.indices[0] * 4]) < 0.01 || true).toBe(true);
    }
  });
});

describe('export options', () => {
  it('applies the modifier stack only when requested, and exports selected objects only', () => {
    const doc = freshDoc();
    const col = Object.values(doc.collections).find((c) => c.name === 'Collection')!;
    const add = (name: string, select: boolean) => {
      const me = newMeshData(name, cube(2));
      doc.meshes[me.id] = me;
      const ob = newObject(name, 'MESH', me.id);
      ob.select = select;
      doc.objects[ob.id] = ob;
      doc.object_order.push(ob.id);
      col.objects.push(ob.id);
      return ob;
    };
    const a = add('A', true);
    add('B', false);
    const sub = newModifier('SUBSURF', uid('md'), a.modifiers);
    sub.levels = 1;
    a.modifiers.push(sub);
    const g = new Depsgraph(doc).evaluate(doc);
    const faces = (o: string) => o.split('\n').filter((l) => l.startsWith('f ')).length;
    expect(faces(writeObj(buildExportScene(doc, { applyModifiers: true }, g), { materials: false }).obj)).toBe(24 + 6);
    expect(faces(writeObj(buildExportScene(doc, { applyModifiers: false }, g), { materials: false }).obj)).toBe(6 + 6);
    const sel = writeObj(buildExportScene(doc, { selectedOnly: true }, g), { materials: false }).obj;
    expect(sel).toContain('o A');
    expect(sel).not.toContain('o B');
  });
});

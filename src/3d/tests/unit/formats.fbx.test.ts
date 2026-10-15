import { describe, it, expect } from 'vitest';
import { readFbx } from '../../src/io/formats/fbx/read';
import { writeFbx } from '../../src/io/formats/fbx/write';
import { parseFbx, type FbxNode } from '../../src/io/formats/fbx/binary';
import { readGltf } from '../../src/io/formats/gltf/read';
import { commitScene } from '../../src/io/formats/to-document';
import { buildExportScene } from '../../src/io/formats/scene-builder';
import { Depsgraph } from '../../src/eval/depsgraph';
import { fixture, freshDoc, byName, EXPECTED_BBOX, expectBBox, dumpOutput } from '../fixtures/formats/helpers';

// Expected import result for this fixture. FBX time t maps to frame t·fps + 1 on import, while the
// fixture's writer stores frame/fps, so a round trip through that writer lands one frame late;
// our importer follows the import convention exactly.
const FBX_EXPECTED: Record<string, Record<number, [number[], number[]]>> = {
  Skinned: {
    1: [
      [3.7, -0.3, 0],
      [4.3, 0.3, 2.8],
    ],
    12: [
      [3.7, -0.8435, 0],
      [4.3, 0.3, 2.8043],
    ],
    24: [
      [3.7, -1.4804, 0],
      [4.3, 0.3, 2.4894],
    ],
  },
  Cube: {
    1: [
      [-1, -1, 0],
      [1, 1, 2],
    ],
    12: [
      [-1, 0.2082, 0],
      [1, 2.2082, 2],
    ],
    24: [
      [-1, 1.9835, 0],
      [1, 3.9835, 2],
    ],
  },
  Plane: {
    1: [
      [-4, -1, 0],
      [-2, 1, 0],
    ],
    12: [
      [-4, -1, 0.2014],
      [-2, 1, 0.2014],
    ],
    24: [
      [-4, -1, 0.4972],
      [-2, 1, 0.4972],
    ],
  },
};

describe('FBX import (binary FBX 7.4 fixture)', () => {
  it('imports objects, n-gons, materials, textures, lights, camera, armature, shape keys', () => {
    const doc = freshDoc();
    const res = commitScene(doc, readFbx(fixture('ref_scene.fbx')));
    const names = res.objects.map((o) => o.name).sort();
    expect(names).toEqual(['Cam', 'Cube', 'Ngon', 'Plane', 'Point', 'Rig', 'Skinned', 'Sphere', 'Spot', 'Sun'].sort());
    const cube = byName(doc, 'Cube');
    const me = doc.meshes[cube.data!];
    expect(me.offsets.length - 1).toBe(6);
    expect(me.materials.map((m) => doc.materials[m!].name)).toEqual(['Red', 'Blue']);
    const red = doc.materials[me.materials[0]!];
    expect(red.metallic).toBeCloseTo(0.3, 3);
    expect(red.roughness).toBeCloseTo(0.6, 3);
    expect(cube.location.map((v) => +v.toFixed(4) + 0)).toEqual([0, 0, 1]);
    expect(cube.scale.map((v) => +v.toFixed(4))).toEqual([1, 1, 1]);
    const ngon = doc.meshes[byName(doc, 'Ngon').data!];
    expect(ngon.offsets[1]).toBe(6);
    const cam = byName(doc, 'Cam');
    expect(cam.location.map((v) => +v.toFixed(3) + 0)).toEqual([7, -7, 5]);
    expect(cam.rotation_euler.map((v) => +v.toFixed(3) + 0)).toEqual([1.1, 0, 0.8]);
    expect(doc.cameras[cam.data!].lens).toBeCloseTo(35, 3);
    expect(doc.cameras[cam.data!].clip_start).toBeCloseTo(0.1, 4);
    const spot = byName(doc, 'Spot');
    expect(spot.rotation_euler.map((v) => +v.toFixed(3) + 0)).toEqual([0.5, 0.2, 0.3]);
    expect(doc.lights[spot.data!].energy).toBeCloseTo(800, 2);
    expect(doc.lights[spot.data!].spot_size).toBeCloseTo(Math.PI / 4, 4);
    expect(doc.lights[spot.data!].spot_blend).toBeCloseTo(0.15, 3);
    const rig = byName(doc, 'Rig');
    const bones = doc.armatures[rig.data!].bones;
    expect(bones.map((b) => b.name).sort()).toEqual(['Mid', 'Root', 'Tip', 'Tip_end']);
    const tip = bones.find((b) => b.name === 'Tip')!;
    expect(tip.head.map((v) => +v.toFixed(3) + 0)).toEqual([0, 0, 2]);
    expect(tip.tail.map((v) => +v.toFixed(3) + 0)).toEqual([0, 0.2, 2.8]);
    const plane = doc.meshes[byName(doc, 'Plane').data!];
    expect(plane.shape_keys.map((k) => k.name)).toEqual(['Basis', 'Lift']);
    const tex = doc.materials[plane.materials[0]!].tree.nodes.find((n) => n.type === 'ShaderNodeTexImage');
    expect(doc.images[tex!.props.image as string].width).toBe(4);
  });

  it('matches the expected import of the same FBX (frames 1/12/24)', () => {
    const doc = freshDoc();
    commitScene(doc, readFbx(fixture('ref_scene.fbx')));
    const g = new Depsgraph(doc);
    for (const [name, frames] of Object.entries(FBX_EXPECTED)) for (const [f, bb] of Object.entries(frames)) expectBBox(doc, name, Number(f), bb, 2e-3, g);
  });
});

describe('FBX export', () => {
  it('writes a valid binary FBX that re-imports with the same scene and animation', async () => {
    const src = freshDoc();
    commitScene(src, readGltf(fixture('ref_scene.glb')));
    src.scene.frame_current = 1;
    const scene = buildExportScene(src, {}, new Depsgraph(src).evaluate(src));
    const out = await writeFbx(scene, {});
    dumpOutput('roundtrip.fbx', out.bytes);
    const parsed = parseFbx(out.bytes);
    expect(parsed.version).toBe(7400);
    expect(parsed.nodes.map((n) => n.name)).toEqual([
      'FBXHeaderExtension',
      'FileId',
      'CreationTime',
      'Creator',
      'GlobalSettings',
      'Documents',
      'References',
      'Definitions',
      'Objects',
      'Connections',
      'Takes',
    ]);
    const doc = freshDoc();
    const res = commitScene(doc, readFbx(out.bytes));
    expect(res.objects.map((o) => o.name).sort()).toEqual(['Cam', 'Cube', 'Ngon', 'Plane', 'Point', 'Rig', 'Skinned', 'Sphere', 'Spot', 'Sun'].sort());
    const g = new Depsgraph(doc);
    for (const [name, frames] of Object.entries(EXPECTED_BBOX)) for (const [f, bb] of Object.entries(frames)) expectBBox(doc, name, Number(f), bb, 3e-3, g);
    const cam = byName(doc, 'Cam');
    expect(cam.rotation_euler.map((v) => +v.toFixed(3) + 0)).toEqual([1.1, 0, 0.8]);
    expect(doc.lights[byName(doc, 'Spot').data!].energy).toBeCloseTo(800, 2);
    // n-gons survive (the glTF source is triangulated, so check the OBJ-like n-gon path separately)
    const obj = freshDoc();
    commitScene(obj, readFbx(fixture('ref_scene.fbx')));
    const out2 = await writeFbx(buildExportScene(obj, {}, new Depsgraph(obj).evaluate(obj)), {});
    dumpOutput('roundtrip_ngons.fbx', out2.bytes);
    const back = freshDoc();
    commitScene(back, readFbx(out2.bytes));
    expect(back.meshes[byName(back, 'Ngon').data!].offsets[1]).toBe(6);
    expect(back.meshes[byName(back, 'Cube').data!].offsets.length - 1).toBe(6);
    const g2 = new Depsgraph(back);
    // timing is preserved exactly: the result equals the source document (= the expected FBX import)
    for (const [name, frames] of Object.entries(FBX_EXPECTED)) for (const [f, bb] of Object.entries(frames)) expectBBox(back, name, Number(f), bb, 3e-3, g2);
  });
});

/** Serialize a parsed FBX tree as ASCII FBX (test helper for the ASCII reader). */
function toAscii(nodes: FbxNode[]): string {
  const val = (v: unknown): string => {
    if (typeof v === 'string') {
      // binary "Name\0\1Class" is written "Class::Name" in ASCII files
      const parts = v.split('\u0000\u0001');
      const s = parts.length === 2 ? `${parts[1]}::${parts[0]}` : v;
      return `"${s.replace(/"/g, '&quot;')}"`;
    }
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'boolean') return v ? 'T' : 'F';
    if (v instanceof Uint8Array) return `"${btoa(String.fromCharCode(...v))}"`;
    if (ArrayBuffer.isView(v) || Array.isArray(v)) {
      const a = Array.from(v as ArrayLike<number | bigint>, (x) => String(x));
      return `*${a.length} {\n a: ${a.join(',')}\n}`;
    }
    return String(v);
  };
  const out: string[] = ['; FBX 7.4.0 project file', ''];
  const walk = (n: FbxNode, d: number) => {
    const pad = '\t'.repeat(d);
    const head = `${pad}${n.name}: ${n.props.map(val).join(', ')}`;
    if (n.children.length) {
      out.push(`${head} {`);
      n.children.forEach((c) => walk(c, d + 1));
      out.push(`${pad}}`);
    } else out.push(head);
  };
  nodes.forEach((n) => walk(n, 0));
  return out.join('\n');
}

describe('FBX ASCII', () => {
  it('parses ASCII FBX into the same scene as the binary file', () => {
    const bin = fixture('ref_scene.fbx');
    const ascii = new TextEncoder().encode(toAscii(parseFbx(bin).nodes));
    const a = freshDoc(),
      b = freshDoc();
    commitScene(a, readFbx(bin));
    commitScene(b, readFbx(ascii));
    const summary = (doc: typeof a) =>
      Object.values(doc.objects)
        .map((o) => `${o.name}:${o.type}:${o.location.map((v) => v.toFixed(3)).join(',')}:${o.data && doc.meshes[o.data] ? doc.meshes[o.data].offsets.length - 1 : ''}`)
        .sort();
    expect(summary(b)).toEqual(summary(a));
  });
});

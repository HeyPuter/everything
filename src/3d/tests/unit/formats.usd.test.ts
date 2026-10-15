import { describe, it, expect } from 'vitest';
import { readUsd } from '../../src/io/formats/usd/read';
import { writeUsda, packUsdz } from '../../src/io/formats/usd/write';
import { parseUsda } from '../../src/io/formats/usd/usda';
import { readZip } from '../../src/io/formats/usd/zip';
import { commitScene } from '../../src/io/formats/to-document';
import { buildExportScene } from '../../src/io/formats/scene-builder';
import { Depsgraph } from '../../src/eval/depsgraph';
import { fixture, freshDoc, byName, EXPECTED_BBOX, expectBBox, dumpOutput } from '../fixtures/formats/helpers';
import type { DocumentData } from '../../src/data/types';

const NAMES = ['Cam', 'Cube', 'Ngon', 'Plane', 'Point', 'Rig', 'Skinned', 'Sphere', 'Spot', 'Sun'].sort();

function checkScene(doc: DocumentData, cubeFaces = 6) {
  const cube = byName(doc, 'Cube');
  const me = doc.meshes[cube.data!];
  expect(me.offsets.length - 1).toBe(cubeFaces);
  expect(me.materials.map((m) => doc.materials[m!].name)).toEqual(['Red', 'Blue']);
  const red = doc.materials[me.materials[0]!];
  expect(red.metallic).toBeCloseTo(0.3, 4);
  expect(red.roughness).toBeCloseTo(0.6, 4);
  expect(byName(doc, 'Sphere').parent).toBe(cube.id);
  expect(doc.meshes[byName(doc, 'Ngon').data!].offsets[1]).toBe(6);
  const cam = byName(doc, 'Cam');
  expect(cam.rotation_euler.map((v) => +v.toFixed(3) + 0)).toEqual([1.1, 0, 0.8]);
  expect(doc.cameras[cam.data!].lens).toBeCloseTo(35, 3);
  expect(doc.lights[byName(doc, 'Point').data!].energy).toBeCloseTo(500, 2);
  expect(doc.lights[byName(doc, 'Sun').data!].energy).toBeCloseTo(2.5, 3);
  const spot = doc.lights[byName(doc, 'Spot').data!];
  expect(spot.spot_size).toBeCloseTo(Math.PI / 4, 4);
  expect(spot.spot_blend).toBeCloseTo(0.15, 4);
  const rig = byName(doc, 'Rig');
  expect(rig.type).toBe('ARMATURE');
  expect(doc.armatures[rig.data!].bones.map((b) => b.name).sort()).toEqual(['Mid', 'Root', 'Tip']);
  const plane = doc.meshes[byName(doc, 'Plane').data!];
  expect(plane.shape_keys.map((k) => k.name)).toEqual(['Basis', 'Lift']);
  const tex = doc.materials[plane.materials[0]!].tree.nodes.find((n) => n.type === 'ShaderNodeTexImage');
  expect(doc.images[tex!.props.image as string].width).toBe(4);
  const g = new Depsgraph(doc);
  for (const [name, frames] of Object.entries(EXPECTED_BBOX)) for (const [f, bb] of Object.entries(frames)) expectBBox(doc, name, Number(f), bb, 2e-3, g);
}

describe('USD import (USDA / USDC / USDZ fixtures)', () => {
  it('USDA text: hierarchy, meshes, materials, lights, camera, UsdSkel skin + animation, blend shapes', () => {
    const doc = freshDoc();
    const res = commitScene(doc, readUsd(fixture('ref_scene.usda'), { resources: new Map([['checker.png', fixture('checker.png')]]) }));
    expect(res.objects.map((o) => o.name).sort()).toEqual(NAMES);
    checkScene(doc);
  });
  it('USDC crate (binary)', () => {
    const doc = freshDoc();
    const res = commitScene(doc, readUsd(fixture('ref_scene.usdc'), { resources: new Map([['checker.png', fixture('checker.png')]]) }));
    expect(res.objects.map((o) => o.name).sort()).toEqual(NAMES);
    checkScene(doc);
  });
  it('USDZ package (crate + textures inside)', () => {
    const doc = freshDoc();
    const res = commitScene(doc, readUsd(fixture('ref_scene.usdz')));
    expect(res.objects.map((o) => o.name).sort()).toEqual(NAMES);
    checkScene(doc);
  });
  it('parses USDA syntax: metadata, typed arrays, quaternions (w,x,y,z → x,y,z,w), timeSamples, connections, variants', () => {
    const { specsByPath } = parseUsda(`#usda 1.0
(
    upAxis = "Y"
    metersPerUnit = 0.01
)
def Xform "A" (
    variants = { string look = "b" }
    prepend variantSets = "look"
)
{
    quatf xformOp:orient = (0.7071068, 0, 0.7071068, 0)
    double3 xformOp:translate.timeSamples = { 1: (0, 0, 0), 10: (5, 0, 0) }
    uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient"]
    variantSet "look" = {
        "a" { def Mesh "OnlyA" {} }
        "b" { def Mesh "OnlyB" { point3f[] points = [(0,0,0),(1,0,0),(0,1,0)] } }
    }
    def Shader "S" { color3f inputs:diffuseColor.connect = <../T.outputs:rgb> }
}`);
    expect(specsByPath['/'].fields.upAxis).toBe('Y');
    expect(Array.from(specsByPath['/A.xformOp:orient'].fields.default as number[]).map((v) => +v.toFixed(4))).toEqual([0, 0.7071, 0, 0.7071]);
    expect(specsByPath['/A.xformOp:translate'].fields.timeSamples.times).toEqual([1, 10]);
    expect(specsByPath['/A/OnlyB']).toBeDefined();
    expect(specsByPath['/A/OnlyA']).toBeUndefined();
    expect(Array.from(specsByPath['/A/OnlyB.points'].fields.default as Float32Array)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(specsByPath['/A/S.inputs:diffuseColor'].fields.connectionPaths).toEqual(['/A/T.outputs:rgb']);
  });
});

describe('USD export', () => {
  it('writes USDA/USDZ that re-import with the same scene, materials, skin and animation', async () => {
    const src = freshDoc();
    commitScene(src, readUsd(fixture('ref_scene.usdz')));
    src.scene.frame_current = 1;
    const scene = buildExportScene(src, {}, new Depsgraph(src).evaluate(src));
    const out = await writeUsda(scene, {});
    dumpOutput('roundtrip.usda', out.usda);
    for (const t of out.textures) dumpOutput(t.path.replace('textures/', ''), t.bytes);
    const usdz = packUsdz(out, 'roundtrip.usda');
    dumpOutput('roundtrip.usdz', usdz);
    // package layout: root layer first, 64-byte aligned data
    const entries = readZip(usdz);
    expect(entries[0].name).toBe('roundtrip.usda');
    expect(entries.some((e) => e.name.startsWith('textures/'))).toBe(true);
    for (const bytes of [new TextEncoder().encode(out.usda), usdz]) {
      const doc = freshDoc();
      const res = commitScene(doc, readUsd(bytes, { resources: new Map(out.textures.map((t) => [t.path, t.bytes])) }));
      expect(res.objects.map((o) => o.name).sort()).toEqual(NAMES);
      checkScene(doc);
    }
  });
});

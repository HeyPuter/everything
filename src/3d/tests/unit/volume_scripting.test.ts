// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { runJavaScript, output } from '../../src/scripting/runner';
import { encodeDocument, decodeDocument } from '../../src/io/native';

function run(code: string) {
  output.clear();
  const r = runJavaScript(code);
  if (!r.ok) throw new Error(`${r.error} (line ${r.line})`);
  return output.lines.map((l) => l.text).join('\n');
}

beforeAll(async () => {
  setApp(new App(startupDocument()));
  await import('./support/all_modules');
  await new Promise((r) => setTimeout(r, 10));
}, 60000);

beforeEach(() => {
  setApp(new App(startupDocument()));
});

describe('volumes and point clouds from scripts', () => {
  it('adds volumes, reads grids from a Mesh to Volume modifier', () => {
    const out = run(`
      bpy.ops.object.volume_add({ location: [0, 0, 0] });
      const vo = bpy.context.object;
      print(vo.type, vo.data.name, vo.data.grids.length);
      const m = vo.modifiers.new('m2v', 'MESH_TO_VOLUME');
      m.object = bpy.data.objects['Cube'];
      print(vo.data.grids.length, vo.data.grids[0].name, vo.data.grids[0].data_type, vo.data.grids[0].channels);
      print(vo.data.display.density, vo.data.render.space);
      vo.data.display.wireframe_type = 'BOUNDS';
      print(bpy.data.volumes.length, bpy.data.volumes.new('Extra').name);
    `);
    expect(out.split('\n')).toEqual(['VOLUME Volume 0', '1 density FLOAT 1', '1 OBJECT', '1 Extra']);
  });

  it('edits point cloud points and attributes', () => {
    const out = run(`
      bpy.ops.object.pointcloud_random_add();
      const pc = bpy.context.object.data;
      print(pc.points.length, pc.attributes.keys().join(','));
      pc.points[0].co = [1, 2, 3];
      pc.points[0].radius = 0.25;
      const a = pc.attributes.new('weight', 'FLOAT', 'POINT');
      a.data[3].value = 7;
      print(pc.points[0].co.x, pc.points[0].radius, pc.attributes['weight'].data[3].value);
      pc.attributes.remove(pc.attributes['weight']);
      pc.points.add(10);
      print(pc.points.length, pc.attributes.keys().join(','));
      const npc = bpy.data.pointclouds.new('Cloud');
      const ob = bpy.data.objects.new('CloudOb', npc);
      print(ob.type);
    `);
    expect(out.split('\n')).toEqual(['400 position,radius', '1 0.25 7', '410 position,radius', 'POINTCLOUD']);
  });

  it('round-trips volume and point cloud data through .p3d', () => {
    run(`
      bpy.ops.object.volume_add();
      const vo = bpy.context.object;
      vo.modifiers.new('m2v', 'MESH_TO_VOLUME').object = bpy.data.objects['Cube'];
      bpy.ops.object.modifier_apply({ modifier: 'm2v' });
      bpy.ops.object.pointcloud_random_add();
    `);
    const vo = Object.values(app.doc.volumes!)[0];
    expect(vo.grids.length).toBe(1);
    const { doc } = decodeDocument(encodeDocument(app.doc));
    const v2 = Object.values(doc.volumes!)[0];
    expect(v2.grids[0].values).toEqual(vo.grids[0].values);
    expect(v2.grids[0].dims).toEqual(vo.grids[0].dims);
    const pc = Object.values(doc.pointclouds!)[0];
    expect(pc.positions.length).toBe(1200);
    expect(pc.attributes.find((a) => a.name === 'radius')!.data.length).toBe(400);
    expect(Object.values(doc.objects).map((o) => o.type).sort()).toContain('VOLUME');
  });
});

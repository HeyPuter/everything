import { describe, it, expect, beforeAll } from 'vitest';
import { emptyDocument, newObject, newMeshData, uid } from '../../src/data/defaults';
import { cube, grid } from '../../src/mesh/primitives';
import { Depsgraph } from '../../src/eval/depsgraph';
import { newModifier } from '../../src/eval/modifiers';
import type { DocumentData, ObjectData } from '../../src/data/types';
import { caches, startBudget } from '../../src/physics/common';
import { defaultBrush, defaultSurface, type DynamicPaintModifier, type DPSurface, type DPBrush } from '../../src/physics/dynpaint';
import '../../src/physics/dynpaint';

function addMesh(doc: DocumentData, name: string, arrays: ReturnType<typeof cube>, loc: [number, number, number] = [0, 0, 0]): ObjectData {
  const me = newMeshData(name, arrays);
  doc.meshes[me.id] = me;
  const ob = newObject(name, 'MESH', me.id);
  ob.location = loc;
  doc.objects[ob.id] = ob;
  doc.object_order.push(ob.id);
  doc.collections[doc.scene.collection].objects.push(ob.id);
  return ob;
}
function keyLocation(doc: DocumentData, ob: ObjectData, axis: number, a: [number, number], b: [number, number]) {
  const act = { id: uid('ac'), name: 'Move', fcurves: [{ data_path: 'location', array_index: axis, keyframe_points: [] as unknown[], extrapolation: 'CONSTANT' as const, modifiers: [] }] };
  const k = (f: number, v: number) => ({ co: [f, v], handle_left: [f - 1, v], handle_right: [f + 1, v], handle_left_type: 'VECTOR', handle_right_type: 'VECTOR', interpolation: 'LINEAR', easing: 'AUTO', type: 'KEYFRAME' });
  act.fcurves[0].keyframe_points.push(k(...a), k(...b));
  doc.actions[act.id] = act as never;
  ob.animation_data = { action: act.id, nla_tracks: [], drivers: [] };
}
function canvas(doc: DocumentData, surface: Partial<DPSurface>) {
  const ob = addMesh(doc, 'Canvas', grid(20, 20, 4));
  const m = newModifier('DYNAMIC_PAINT', uid('md'), []) as DynamicPaintModifier;
  m.ui_type = 'CANVAS';
  m.canvas_settings = { canvas_surfaces: [{ ...defaultSurface('PAINT'), point_cache: { frame_start: 1, frame_end: 100, is_baked: false }, ...surface }], active_index: 0 };
  ob.modifiers.push(m);
  return ob;
}
function brush(doc: DocumentData, settings: Partial<DPBrush>, loc: [number, number, number], size = 1) {
  const ob = addMesh(doc, 'Brush', cube(size), loc);
  const m = newModifier('DYNAMIC_PAINT', uid('md'), []) as DynamicPaintModifier;
  m.ui_type = 'BRUSH';
  m.brush_settings = { ...defaultBrush(), ...settings };
  ob.modifiers.push(m);
  return ob;
}
const at = (g: Depsgraph, doc: DocumentData, f: number) => {
  doc.scene.frame_current = f;
  g.evaluate(doc);
  return g;
};
/** Colour (rgb) of the evaluated vertex nearest a point. */
function colorNear(g: Depsgraph, ob: ObjectData, x: number, y: number) {
  const m = g.get(ob.id)!.mesh!;
  let best = Infinity,
    bv = -1;
  for (let i = 0; i < m.positions.length / 3; i++) {
    const d = (m.positions[i * 3] - x) ** 2 + (m.positions[i * 3 + 1] - y) ** 2;
    if (d < best) {
      best = d;
      bv = i;
    }
  }
  const c = m.indices.indexOf(bv);
  return [m.colors![c * 4], m.colors![c * 4 + 1], m.colors![c * 4 + 2]];
}

beforeAll(() => startBudget(Infinity));

describe('dynamic paint', () => {
  it('a volume brush paints the canvas where it passes', () => {
    caches.clear();
    const doc = emptyDocument();
    const c = canvas(doc, {});
    const b = brush(doc, { paint_color: [1, 0, 0] }, [-1, 0, 0], 0.6);
    keyLocation(doc, b, 0, [1, -1], [20, 1]);
    const g = new Depsgraph(doc);
    at(g, doc, 30);
    // the brush moved along X through the middle: painted red there, white elsewhere
    expect(colorNear(g, c, 0, 0)).toEqual([1, 0, 0]);
    expect(colorNear(g, c, -1, 0)).toEqual([1, 0, 0]);
    expect(colorNear(g, c, 0, 1.5)).toEqual([1, 1, 1]);
    // before the brush arrives nothing is painted
    at(g, doc, 1);
    expect(colorNear(g, c, 0.5, 0)).toEqual([1, 1, 1]);
  });

  it('proximity brushes paint within their distance with a falloff', () => {
    caches.clear();
    const doc = emptyDocument();
    const c = canvas(doc, {});
    brush(doc, { paint_color: [0, 0, 1], paint_source: 'DISTANCE', paint_distance: 1, proximity_falloff: 'SMOOTH' }, [0, 0, 1], 0.2);
    const g = new Depsgraph(doc);
    at(g, doc, 2);
    const under = colorNear(g, c, 0, 0),
      side = colorNear(g, c, 0.4, 0),
      far = colorNear(g, c, 1.8, 0);
    expect(under[2]).toBe(1);
    expect(under[0]).toBeLessThan(side[0]);
    expect(far).toEqual([1, 1, 1]);
  });

  it('dissolving paint fades over time', () => {
    caches.clear();
    const doc = emptyDocument();
    const c = canvas(doc, { use_dissolve: true, dissolve_speed: 20, use_dissolve_log: false });
    const b = brush(doc, { paint_color: [0, 0, 0] }, [0, 0, 0], 0.6);
    keyLocation(doc, b, 2, [2, 0], [4, 10]);
    const g = new Depsgraph(doc);
    const v2 = colorNear(at(g, doc, 3), c, 0, 0)[0];
    const v12 = colorNear(at(g, doc, 13), c, 0, 0)[0];
    expect(v2).toBeLessThan(0.2);
    expect(v12).toBeGreaterThan(v2 + 0.3);
  });

  it('weight surfaces write their vertex group', () => {
    caches.clear();
    const doc = emptyDocument();
    const c = canvas(doc, { surface_type: 'WEIGHT', output_name_a: 'dp_weight' });
    const me = doc.meshes[c.data!];
    me.vertex_groups.push({ name: 'dp_weight' });
    me.weights.push(new Float32Array(me.positions.length / 3));
    brush(doc, { paint_source: 'POINT', paint_distance: 0.5 }, [0, 0, 0]);
    const g = new Depsgraph(doc);
    at(g, doc, 2);
    const w = g.get(c.id)!.mesh!.weights![0];
    expect(Math.max(...w)).toBeCloseTo(1, 2);
    expect(w.filter((x) => x > 0).length).toBeLessThan(w.length / 4);
  });

  it('displace and wave surfaces move the canvas, waves spread out', () => {
    caches.clear();
    const doc = emptyDocument();
    const c = canvas(doc, { surface_type: 'DISPLACE' });
    brush(doc, {}, [0, 0, 0], 0.5);
    const g = new Depsgraph(doc);
    at(g, doc, 2);
    const minZ = (ob: ObjectData) => Math.min(...Array.from(g.get(ob.id)!.mesh!.positions.filter((_, i) => i % 3 === 2)));
    expect(minZ(c)).toBeLessThan(-0.05);

    caches.clear();
    const doc2 = emptyDocument();
    const w = canvas(doc2, { surface_type: 'WAVE', wave_damping: 0.01 });
    const b = brush(doc2, {}, [0, 0, 0], 0.3);
    keyLocation(doc2, b, 2, [2, 0], [3, 5]);
    const g2 = new Depsgraph(doc2);
    const heightAt = (f: number, x: number) => {
      at(g2, doc2, f);
      const m = g2.get(w.id)!.mesh!;
      let best = Infinity,
        z = 0;
      for (let i = 0; i < m.positions.length / 3; i++) {
        const d = (m.positions[i * 3] - x) ** 2 + m.positions[i * 3 + 1] ** 2;
        if (d < best) {
          best = d;
          z = m.positions[i * 3 + 2];
        }
      }
      return z;
    };
    expect(Math.abs(heightAt(3, 1.4))).toBeLessThan(1e-3);
    // a little later the ripple reached further out
    let moved = 0;
    for (let f = 4; f <= 20; f++) moved = Math.max(moved, Math.abs(heightAt(f, 1.4)));
    expect(moved).toBeGreaterThan(1e-3);
    // determinism: the cached frame is reproduced exactly after a cache reset
    const z15 = heightAt(15, 1.0);
    caches.clear();
    const g3 = new Depsgraph(doc2);
    doc2.scene.frame_current = 15;
    g3.evaluate(doc2);
    expect(g3.get(w.id)!.mesh!.positions).toEqual(g2.get(w.id)!.mesh!.positions);
    void z15;
  });
});

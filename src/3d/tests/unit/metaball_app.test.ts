// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { encodeDocument, decodeDocument } from '../../src/io/native';
import { bpy } from '../../src/scripting/api';
import { inScript } from '../../src/scripting/runner';
import '../../src/metaball/index';
import type { ObjectData } from '../../src/data/types';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const B = bpy as Any;

beforeEach(() => {
  setApp(new App(startupDocument()));
});

const byName = (n: string) => Object.values(app.doc.objects).find((o) => o.name === n) as ObjectData;
const faces = (ob: ObjectData) => {
  app.graph.evaluate(app.doc);
  const m = app.graph.get(ob.id)?.mesh;
  return m ? m.offsets.length - 1 : null;
};

function addBall(location: number[], type = 'BALL') {
  app.run('object.metaball_add', { type, location });
  return app.activeObject!;
}

describe('metaball objects', () => {
  it('adds a metaball object with one selected element and an evaluated surface', () => {
    const ob = addBall([0, 0, 0]);
    expect(ob.type).toBe('META');
    expect(ob.name).toBe('Mball');
    const mb = app.doc.metaballs![ob.data!];
    expect(mb.elements.length).toBe(1);
    expect(mb.elements[0]).toMatchObject({ type: 'BALL', radius: 2, stiffness: 2, select: true });
    expect(mb).toMatchObject({ resolution: 0.4, render_resolution: 0.2, threshold: 0.6, update_method: 'UPDATE_ALWAYS' });
    expect(faces(ob)).toBeGreaterThan(100);
  });

  it('joins family members into the basis object; others show no geometry', () => {
    const a = addBall([0, 0, 0]);
    const single = faces(a)!;
    const b = addBall([1.5, 0, 0]);
    expect(b.name).toBe('Mball.001');
    expect(faces(b)).toBeNull();
    const joined = faces(a)!;
    expect(joined).toBeGreaterThan(single);
    // a different family stays separate
    const c = addBall([0, 6, 0]);
    c.name = 'Other';
    expect(faces(c)).toBe(single);
    expect(faces(a)).toBe(joined);
    // moving a member re-polygonizes the basis
    b.location = [6, 0, 0];
    expect(faces(a)).not.toBe(joined);
  });

  it('adds elements in edit mode, deletes, duplicates, hides and reveals them', () => {
    const ob = addBall([0, 0, 0]);
    app.run('object.mode_set', { mode: 'EDIT' });
    expect(app.doc.mode).toBe('EDIT');
    app.doc.scene.cursor.location = [3, 0, 0];
    app.run('object.metaball_add', { type: 'CUBE' });
    const mb = app.doc.metaballs![ob.data!];
    expect(mb.elements.map((e) => e.type)).toEqual(['BALL', 'CUBE']);
    expect(mb.elements[1].co[0]).toBeCloseTo(3);
    expect(mb.elements.map((e) => !!e.select)).toEqual([false, true]);
    app.run('mball.duplicate_move', {}, { invoke: false });
    expect(mb.elements.length).toBe(3);
    app.run('mball.hide_metaelems', { unselected: true });
    expect(mb.elements.map((e) => !!e.hide)).toEqual([true, true, false]);
    app.run('mball.reveal_metaelems');
    expect(mb.elements.every((e) => !e.hide && e.select)).toBe(true);
    app.run('mball.select_all', { action: 'DESELECT' });
    mb.elements[0].select = true;
    app.run('mball.select_similar', { type: 'TYPE' });
    expect(mb.elements.map((e) => !!e.select)).toEqual([true, false, false]);
    app.run('mball.delete_metaelems');
    expect(mb.elements.map((e) => e.type)).toEqual(['CUBE', 'CUBE']);
    app.run('mball.select_random_metaelems', { ratio: 1, seed: 3 });
    expect(mb.elements.every((e) => e.select)).toBe(true);
  });

  it('converting a member converts the family basis and removes the other members', () => {
    const a = addBall([0, 0, 0]);
    const b = addBall([1.5, 0, 0]);
    const n = faces(a);
    for (const o of Object.values(app.doc.objects)) o.select = false;
    b.select = true;
    app.doc.scene.active_object = b.id;
    app.run('object.convert', { target: 'MESH' });
    expect(byName('Mball.001')).toBeUndefined();
    const m = byName('Mball');
    expect(m.type).toBe('MESH');
    expect(app.doc.meshes[m.data!].offsets.length - 1).toBe(n);
    expect(Object.keys(app.doc.metaballs ?? {}).length).toBe(0);
  });

  it('round-trips through the native file format', () => {
    const ob = addBall([0, 0, 0], 'ELLIPSOID');
    const mb = app.doc.metaballs![ob.data!];
    mb.elements[0].use_negative = false;
    mb.threshold = 0.4;
    const back = decodeDocument(encodeDocument(app.doc)).doc;
    expect(back.metaballs![mb.id]).toEqual(mb);
    expect(back.objects[ob.id].type).toBe('META');
    const older = decodeDocument(encodeDocument({ ...app.doc, metaballs: undefined })).doc;
    expect(older.metaballs).toEqual({});
  });

  it('duplicates metaball objects with their own data', () => {
    const ob = addBall([0, 0, 0]);
    app.graph.evaluate(app.doc);
    expect(app.run('object.duplicate_move', {}, { invoke: false })).toBe('FINISHED');
    const copy = Object.values(app.doc.objects).find((o) => o.select && o.id !== ob.id)!;
    expect(copy.name).toBe('Mball.001');
    expect(copy.type).toBe('META');
    expect(copy.data).not.toBe(ob.data);
    expect(app.doc.metaballs![copy.data!].elements.length).toBe(1);
  });

  it('is scriptable through bpy.data.metaballs', () => {
    inScript('Run Script', () => {
      const mb = B.data.metaballs.new('Blob');
      const e = mb.elements.new();
      e.co = [1, 2, 3];
      e.radius = 1.5;
      const c = mb.elements.new('CAPSULE');
      c.use_negative = true;
      mb.threshold = 0.5;
      const ob = B.data.objects.new('Blob', mb);
      B.context.collection.objects.link(ob);
      expect(ob.type).toBe('META');
      expect(mb.elements.length).toBe(2);
      mb.elements.remove(c);
    });
    const mb = Object.values(app.doc.metaballs!).find((m) => m.name === 'Blob')!;
    expect(mb.threshold).toBe(0.5);
    expect(mb.elements.length).toBe(1);
    expect(mb.elements[0].co).toEqual([1, 2, 3]);
    expect(mb.elements[0].radius).toBe(1.5);
    expect(faces(byName('Blob'))).toBeGreaterThan(10);
  });
});

// @vitest-environment happy-dom
// Round-trip fidelity harness against the reference app (manual: needs RT_DIR with scene.py and
// the reference's ref.* exports). Builds the same scene from the same Python script, writes our
// exports (ours.*) and summaries of our scene and of what our importers make of ref.* / ours.*.
// The reference side imports ours.* and the comparison runs outside the test suite.
import { describe, it, beforeAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Euler, Quaternion, Vector3 } from 'three';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { runJavaScript } from '../../src/scripting/runner';
import { vfsRead, vfsWrite, vfsClear } from '../../src/io/vfs';
import { readMaterial } from '../../src/io/formats/material-nodes';
import { Depsgraph } from '../../src/eval/depsgraph';
import { pythonAvailable, runPy } from './support/python';

const RT = process.env.RT_DIR ?? '';
const r3 = (v: number) => Math.round(v * 1000) / 1000 + 0;

function summary(frame: number) {
  const doc = app.doc;
  const g = new Depsgraph(doc);
  const saved = doc.scene.frame_current;
  doc.scene.frame_current = frame;
  g.evaluate(doc);
  const objects = Object.values(doc.objects)
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((o) => {
      const ev = g.get(o.id)!;
      const p = new Vector3(),
        q = new Quaternion(),
        s = new Vector3();
      ev.world.decompose(p, q, s);
      const e = new Euler().setFromQuaternion(q, 'ZYX');
      const d: Record<string, unknown> = { name: o.name, type: o.type, parent: o.parent ? doc.objects[o.parent]?.name ?? null : null, loc: [p.x, p.y, p.z].map(r3), rot: [e.x, e.y, e.z].map(r3), scale: [s.x, s.y, s.z].map(r3) };
      if (o.type === 'MESH' && ev.mesh) {
        const m = ev.mesh;
        const lo = [Infinity, Infinity, Infinity],
          hi = [-Infinity, -Infinity, -Infinity];
        const v = new Vector3();
        for (let i = 0; i < m.positions.length; i += 3) {
          v.set(m.positions[i], m.positions[i + 1], m.positions[i + 2]).applyMatrix4(ev.world);
          [v.x, v.y, v.z].forEach((x, k) => ((lo[k] = Math.min(lo[k], x)), (hi[k] = Math.max(hi[k], x))));
        }
        const nf = m.offsets.length - 1;
        d.verts = m.positions.length / 3;
        d.faces = nf;
        let tris = 0;
        for (let f = 0; f < nf; f++) tris += m.offsets[f + 1] - m.offsets[f] - 2;
        d.tris = tris;
        d.bbox = [lo.map(r3), hi.map(r3)];
        const me = doc.meshes[o.data!];
        d.uv = me.uvs?.some((x) => x !== 0) ? 1 : 0;
        d.smooth = me.smooth ? Array.from(me.smooth).filter(Boolean).length : 0;
        d.mats = me.materials.map((id) => {
          const ma = id ? doc.materials[id] : null;
          if (!ma) return null;
          const r = readMaterial(doc, ma);
          return { name: ma.name, color: r.baseColor.map(r3), rough: r3(r.roughness), metal: r3(r.metallic) };
        });
      }
      if (o.type === 'CAMERA') d.lens = r3(doc.cameras[o.data!].lens);
      if (o.type === 'LIGHT') {
        d.light = doc.lights[o.data!].type;
        d.energy = r3(doc.lights[o.data!].energy);
      }
      return d;
    });
  doc.scene.frame_current = saved;
  return { frame, range: [doc.scene.frame_start, doc.scene.frame_end], objects };
}

const js = (code: string) => {
  const r = runJavaScript(code);
  if (!r.ok) throw new Error(`${r.error}`);
};

const IMPORT: Record<string, string> = { obj: 'wm.obj_import', stl: 'wm.stl_import', ply: 'wm.ply_import', glb: 'import_scene.gltf', fbx: 'import_scene.fbx', usda: 'wm.usd_import', usdz: 'wm.usd_import', abc: 'wm.alembic_import' };

function importAll(prefix: string) {
  const out: Record<string, unknown> = {};
  for (const [ext, op] of Object.entries(IMPORT)) {
    const p = join(RT, `${prefix}.${ext}`);
    if (!existsSync(p)) continue;
    setApp(new App(startupDocument()));
    js(`for (const o of [...bpy.data.objects]) bpy.data.objects.remove(o);`);
    vfsWrite(`/rt/${prefix}.${ext}`, new Uint8Array(readFileSync(p)));
    if (ext === 'obj' && existsSync(join(RT, `${prefix}.mtl`))) vfsWrite(`/rt/${prefix}.mtl`, new Uint8Array(readFileSync(join(RT, `${prefix}.mtl`))));
    try {
      const before = app.reports.length;
      js(`bpy.ops.${op}({ filepath: '/rt/${prefix}.${ext}' })`);
      out[ext] = { warnings: app.reports.slice(before).filter((r) => r.type !== 'INFO').map((r) => r.message), f1: summary(1), f10: summary(10) };
    } catch (e) {
      out[ext] = { error: String(e) };
    }
  }
  return out;
}

describe.skipIf(!RT)('round trip against the reference (manual)', () => {
  let has = false;
  beforeAll(async () => {
    setApp(new App(startupDocument()));
    await import('./support/all_modules');
    has = await pythonAvailable();
  }, 90000);

  it('writes our exports and summaries', () => {
    if (!has) throw new Error('Python is needed to run scene.py');
    setApp(new App(startupDocument()));
    vfsClear();
    runPy(readFileSync(join(RT, 'scene.py'), 'utf8'));
    writeFileSync(join(RT, 'ours_source.json'), JSON.stringify({ f1: summary(1), f10: summary(10) }, null, 1));
    const exp: [string, string][] = [
      ['wm.obj_export', 'obj'],
      ['wm.stl_export', 'stl'],
      ['wm.ply_export', 'ply'],
      ['export_scene.gltf', 'glb'],
      ['export_scene.fbx', 'fbx'],
      ['wm.usd_export', 'usda'],
      ['wm.usd_export', 'usdz'],
      ['wm.alembic_export', 'abc'],
    ];
    for (const [op, ext] of exp) {
      // the reference side writes USD with animation too
      js(`bpy.ops.${op}({ filepath: '/tmp/ours.${ext}'${op === 'wm.usd_export' ? ', export_animation: true' : ''} })`);
      writeFileSync(join(RT, `ours.${ext}`), vfsRead(`/tmp/ours.${ext}`)!);
      if (ext === 'obj') writeFileSync(join(RT, 'ours.mtl'), vfsRead('/tmp/ours.mtl') ?? new Uint8Array());
    }
  }, 120000);

  it('imports the reference exports and our own', () => {
    writeFileSync(join(RT, 'ref_in_ours.json'), JSON.stringify(importAll('ref'), null, 1));
    writeFileSync(join(RT, 'ours_in_ours.json'), JSON.stringify(importAll('ours'), null, 1));
  }, 120000);
});

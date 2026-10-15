// Shared helpers for the interchange-format unit tests.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Vector3 } from 'three';
import { emptyDocument, newCollection } from '../../../src/data/defaults';
import { Depsgraph } from '../../../src/eval/depsgraph';
import type { DocumentData, ObjectData } from '../../../src/data/types';

export const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./${name}`, import.meta.url)));

export function freshDoc(): DocumentData {
  const doc = emptyDocument();
  const col = newCollection('Collection');
  doc.collections[col.id] = col;
  doc.collections[doc.scene.collection].children.push(col.id);
  return doc;
}

export const byName = (doc: DocumentData, name: string): ObjectData => {
  const ob = Object.values(doc.objects).find((o) => o.name === name);
  if (!ob)
    throw new Error(
      `object ${name} not found (have: ${Object.values(doc.objects)
        .map((o) => o.name)
        .join(', ')})`,
    );
  return ob;
};

/** World-space bounding box of an object's evaluated mesh at a frame. */
export function worldBBox(doc: DocumentData, name: string, frame: number, graph = new Depsgraph(doc)) {
  doc.scene.frame_current = frame;
  graph.evaluate(doc);
  const ev = graph.get(byName(doc, name).id)!;
  const p = ev.mesh!.positions;
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  const v = new Vector3();
  for (let i = 0; i < p.length; i += 3) {
    v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(ev.world);
    const a = [v.x, v.y, v.z];
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], a[k]);
      max[k] = Math.max(max[k], a[k]);
    }
  }
  return { min, max };
}

/** Expected bounding boxes of the fixture scene (frames 1/12/24). */
export const EXPECTED_BBOX: Record<string, Record<number, [number[], number[]]>> = {
  Skinned: {
    1: [
      [3.7, -0.3, 0],
      [4.3, 0.3, 2.8],
    ],
    12: [
      [3.7, -0.9255, 0],
      [4.3, 0.3, 2.7879],
    ],
    24: [
      [3.7, -1.4849, 0],
      [4.3, 0.3, 2.4849],
    ],
  },
  Plane: {
    1: [
      [-4, -1, 0],
      [-2, 1, 0],
    ],
    12: [
      [-4, -1, 0.2337],
      [-2, 1, 0.2337],
    ],
    24: [
      [-4, -1, 0.5],
      [-2, 1, 0.5],
    ],
  },
  Cube: {
    1: [
      [-1, -1, 0],
      [1, 1, 2],
    ],
    12: [
      [-1, 0.4022, 0],
      [1, 2.4022, 2],
    ],
    24: [
      [-1, 2, 0],
      [1, 4, 2],
    ],
  },
};

export function expectBBox(doc: DocumentData, name: string, frame: number, expected: [number[], number[]], tol = 2e-3, graph?: Depsgraph) {
  const bb = worldBBox(doc, name, frame, graph);
  const err = Math.max(...bb.min.map((v, i) => Math.abs(v - expected[0][i])), ...bb.max.map((v, i) => Math.abs(v - expected[1][i])));
  if (!(err <= tol)) throw new Error(`${name}@${frame}: bbox ${JSON.stringify(bb)} differs from ${JSON.stringify(expected)} (err ${err})`);
}

/** When FORMATS_OUT is set, write exported files there for external cross-checks. */
export function dumpOutput(name: string, bytes: Uint8Array | string) {
  const dir = process.env.FORMATS_OUT;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}`, bytes);
}

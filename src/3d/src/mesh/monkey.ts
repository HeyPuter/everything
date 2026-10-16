// Monkey primitive: an original, stylised low-poly monkey head built procedurally from a few
// sphere-like shells (head with muzzle, brow and eye sockets, two eyes, two cupped ears).
// Faces -Y like the other primitives' front; about 2 units across the ears at size 2.
import { Matrix4, Vector3 } from 'three';
import { buildMesh, type PolyFace } from './mesh';
import type { PrimitiveArrays } from './primitives';

type Map3 = (dir: Vector3, u: number, v: number) => Vector3;

/**
 * A closed shell with sphere topology: `seg` columns around, `rings` rows from top to bottom;
 * `map` turns a unit-sphere direction into a position. UVs fill the rectangle `uv` = [u0, v0, u1, v1].
 */
function shell(p: number[], faces: PolyFace[], seg: number, rings: number, map: Map3, uv: number[]) {
  const base = p.length / 3;
  const at = (phi: number, th: number) => new Vector3(Math.sin(phi) * Math.cos(th), Math.sin(phi) * Math.sin(th), Math.cos(phi));
  const push = (q: Vector3) => p.push(q.x, q.y, q.z);
  push(map(new Vector3(0, 0, 1), 0.5, 0));
  for (let r = 1; r < rings; r++) for (let s = 0; s < seg; s++) push(map(at((r / rings) * Math.PI, (s / seg) * Math.PI * 2), s / seg, r / rings));
  push(map(new Vector3(0, 0, -1), 0.5, 1));
  const bottom = base + 1 + (rings - 1) * seg;
  const id = (r: number, s: number) => base + 1 + (r - 1) * seg + (s % seg);
  const U = (s: number) => uv[0] + (uv[2] - uv[0]) * (s / seg),
    Vv = (r: number) => uv[3] - (uv[3] - uv[1]) * (r / rings);
  for (let s = 0; s < seg; s++) faces.push({ verts: [base, id(1, s), id(1, s + 1)], uvs: [U(s + 0.5), Vv(0), U(s), Vv(1), U(s + 1), Vv(1)] });
  for (let r = 1; r < rings - 1; r++)
    for (let s = 0; s < seg; s++) faces.push({ verts: [id(r, s), id(r + 1, s), id(r + 1, s + 1), id(r, s + 1)], uvs: [U(s), Vv(r), U(s), Vv(r + 1), U(s + 1), Vv(r + 1), U(s + 1), Vv(r)] });
  for (let s = 0; s < seg; s++) faces.push({ verts: [id(rings - 1, s), bottom, id(rings - 1, s + 1)], uvs: [U(s), Vv(rings - 1), U(s + 0.5), Vv(rings), U(s + 1), Vv(rings - 1)] });
}

const gauss = (x: number, w: number) => Math.exp(-((x / w) ** 2));
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Head surface: a squashed sphere with a forward muzzle, a brow ridge and two eye sockets. */
const EYE_DIRS = [-1, 1].map((sx) => new Vector3(sx * 0.36, -0.86, 0.24).normalize());

function headPoint(d: Vector3): Vector3 {
  const q = new Vector3(d.x * 0.84, d.y * 0.76, d.z * 0.9);
  const front = Math.max(0, -d.y);
  // muzzle: a broad bulge below the eyes
  const muzzleDir = new Vector3(0, -0.8, -0.6).normalize();
  const wm = gauss(d.angleTo(muzzleDir), 0.55);
  q.y -= 0.36 * wm;
  q.x *= 1 + 0.16 * wm;
  q.z -= 0.08 * wm;
  // brow ridge across the front just above the eyes
  q.y -= 0.14 * front * front * gauss(d.z - 0.42, 0.12);
  // eye sockets
  for (const e of EYE_DIRS) q.addScaledVector(d, -0.15 * gauss(d.angleTo(e), 0.28));
  // flatter chin and a slightly fuller cranium at the back
  if (q.z < -0.55) q.z = -0.55 + (q.z + 0.55) * 0.55;
  q.y += 0.06 * Math.max(0, d.y) * smooth(-0.2, 0.6, d.z);
  return q;
}

export function monkey(size = 2): PrimitiveArrays {
  const p: number[] = [];
  const faces: PolyFace[] = [];
  shell(p, faces, 20, 14, (d) => headPoint(d), [0, 0, 0.6, 1]);
  // eyes: flattened domes sitting in the sockets, facing out of them
  EYE_DIRS.forEach((e, i) => {
    const center = headPoint(e).addScaledVector(e, 0.05);
    const look = e.clone();
    const m = new Matrix4().lookAt(new Vector3(), look, new Vector3(0, 0, 1));
    // lookAt aims -Z at the target; the dome's flat axis (z) must point along the eye direction
    m.multiply(new Matrix4().makeRotationX(Math.PI));
    shell(p, faces, 12, 6, (d) => new Vector3(d.x * 0.19, d.y * 0.17, d.z * 0.08).applyMatrix4(m).add(center), [0.62 + i * 0.19, 0, 0.79 + i * 0.19, 0.24]);
  });
  // ears: thin cupped discs on the sides, turned a little to the front
  [-1, 1].forEach((sx, i) => {
    const center = new Vector3(sx * 1.0, 0.1, 0.12);
    const rot = new Matrix4().makeRotationZ(sx * -0.75);
    shell(
      p,
      faces,
      12,
      6,
      (d) => {
        // the outer face (pointing away from the head) is pressed in to make the cup
        const out = d.x * sx;
        const cup = out > 0 ? -0.15 * Math.pow(1 - (d.y * d.y + d.z * d.z), 1.2) : 0;
        return new Vector3(d.x * 0.11 + sx * cup, d.y * 0.34, d.z * 0.38).applyMatrix4(rot).add(center);
      },
      [0.62 + i * 0.19, 0.28, 0.79 + i * 0.19, 0.6],
    );
  });
  const s = size / 2;
  for (let i = 0; i < p.length; i++) p[i] *= s;
  return buildMesh(p, faces);
}

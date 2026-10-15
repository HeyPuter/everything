// bmesh.utils (element-level topology edits) and bmesh.geometry.
import { pyError, kwMethod } from './rna';
import { BMVert, BMEdge, BMFace, BMLoop, describe, splitEdge, splitFace, flipFace, faceLoops, faceNormal, vertLoops, weldVerts, dissolveVertInFaces, edgeBetween, elems, vec3 } from './bmesh_core';
import { mergeRegion, dissolveVerts } from './bmesh_ops';
import { rotateEdge, splitEdgesAt } from './bmesh_ops2';

const need = <T>(v: unknown, cls: abstract new (...a: never[]) => T, what: string): T => {
  if (!(v instanceof (cls as unknown as new () => T))) throw pyError('TypeError', `${what}: expected a ${(cls as unknown as { name: string }).name}, got ${describe(v)}`);
  if (!(v as unknown as BMVert)._bm) throw pyError('ReferenceError', `${what}: the element has been removed`);
  return v as T;
};

export const utils = {
  __type: 'module',
  /** Split an edge at `fac` (0..1 from `vert`): returns [new_edge, new_vert]. */
  edge_split(edge: unknown, vert: unknown, fac: number) {
    const e = need(edge, BMEdge, 'edge_split(edge)');
    const v = need(vert, BMVert, 'edge_split(vert)');
    if (v !== e.v1 && v !== e.v2) throw pyError('ValueError', 'edge_split(): vert must belong to the edge');
    const [nv, ne] = splitEdge(e._m, e, v, Number(fac));
    return [ne, nv];
  },
  /** Rotate an edge between its two faces: returns the new edge or None. */
  edge_rotate(edge: unknown, ccw = false) {
    const e = need(edge, BMEdge, 'edge_rotate(edge)');
    return rotateEdge(e._m, e, !!ccw);
  },
  /** Split a face between two of its vertices: returns [new_face, new_loop]. */
  face_split(face: unknown, vert_a: unknown, vert_b: unknown, _coords: unknown = [], _use_exist = true, example: unknown = null) {
    const f = need(face, BMFace, 'face_split(face)');
    const a = need(vert_a, BMVert, 'face_split(vert_a)'),
      b = need(vert_b, BMVert, 'face_split(vert_b)');
    const ls = faceLoops(f);
    const la = ls.find((l) => l.vert === a),
      lb = ls.find((l) => l.vert === b);
    if (!la || !lb) throw pyError('ValueError', 'face_split(...): vertices must be in the face');
    const r = splitFace(f._m, f, la, lb, example instanceof BMEdge ? example : null);
    if (!r) throw pyError('ValueError', 'face_split(...): the vertices are adjacent (no split possible)');
    r[0]._no = faceNormal(r[0]);
    f._no = faceNormal(f);
    return [r[0], r[1]._l.find((l) => l.face === r[0]) ?? null];
  },
  /** Join faces into one (along the outline of their union): returns the face or None. */
  face_join(faces: unknown, _remove = true) {
    const fs = elems(faces, BMFace, 'face_join(faces)');
    if (!fs.length) return null;
    return mergeRegion(fs[0]._m, fs);
  },
  face_flip(face: unknown) {
    flipFace(need(face, BMFace, 'face_flip(face)'));
  },
  /** Dissolve a vertex into its surrounding faces: returns True on success. */
  vert_dissolve(vert: unknown) {
    const v = need(vert, BMVert, 'vert_dissolve(vert)');
    dissolveVerts(v._m, [v]);
    return !v._bm;
  },
  /** Collapse a vertex with two edges into one edge: returns the resulting edge. */
  vert_collapse_edge(vert: unknown, edge: unknown, _kill_degenerate_faces = true, _kill_loose_edges = true) {
    const v = need(vert, BMVert, 'vert_collapse_edge(vert)');
    const e = need(edge, BMEdge, 'vert_collapse_edge(edge)');
    if (v._e.length !== 2 || !v._e.includes(e)) throw pyError('ValueError', 'vert_collapse_edge(vert, edge): vert must be part of edge and have exactly 2 edges');
    const a = v._e[0].other(v),
      b = v._e[1].other(v);
    dissolveVertInFaces(v._m, v);
    return edgeBetween(a, b);
  },
  /** Merge a vertex into another one. */
  vert_splice(vert: unknown, vert_target: unknown) {
    const v = need(vert, BMVert, 'vert_splice(vert)'),
      t = need(vert_target, BMVert, 'vert_splice(vert_target)');
    if (v === t) throw pyError('ValueError', 'vert_splice(...): vert arguments match');
    weldVerts(v._m, new Map([[v, t]]));
  },
  /** Separate a vertex along the given edges: returns the resulting vertices. */
  vert_separate(vert: unknown, edges: unknown) {
    const v = need(vert, BMVert, 'vert_separate(vert)');
    const es = new Set(elems(edges, BMEdge, 'vert_separate(edges)'));
    const made = splitEdgesAt(v._m, es, new Set([v]));
    return [v, ...(made.get(v) ?? [])];
  },
  /** Give a face corner its own vertex: returns the new vertex. */
  loop_separate(loop: unknown) {
    const l = need(loop, BMLoop, 'loop_separate(loop)');
    const v = l.vert;
    const others = vertLoops(v).filter((x) => x !== l);
    if (!others.length) return v;
    // edges of this corner separate it from the rest of the fan
    const made = splitEdgesAt(v._m, new Set([l.edge, l._prev.edge]), new Set([v]));
    return made.get(v)?.[0] ?? v;
  },
  face_vert_separate(face: unknown, vert: unknown) {
    const f = need(face, BMFace, 'face_vert_separate(face)');
    const l = faceLoops(f).find((x) => x.vert === vert);
    if (!l) throw pyError('ValueError', 'face_vert_separate(...): vertex not found in face');
    return utils.loop_separate(l);
  },
  toString: () => '<module bmesh.utils>',
};
kwMethod(utils, 'edge_split', ['edge', 'vert', 'fac']);
kwMethod(utils, 'edge_rotate', ['edge', 'ccw']);
kwMethod(utils, 'face_split', ['face', 'vert_a', 'vert_b', 'coords', 'use_exist', 'example']);
kwMethod(utils, 'face_join', ['faces', 'remove']);
kwMethod(utils, 'vert_collapse_edge', ['vert', 'edge', 'kill_degenerate_faces', 'kill_loose_edges']);

export const geometry = {
  __type: 'module',
  /** Whether a point projects inside a face (along the face normal). */
  intersect_face_point(face: unknown, point: unknown): boolean {
    const f = need(face, BMFace, 'intersect_face_point(face)');
    const p = vec3(point, 'intersect_face_point(point)');
    const no = faceNormal(f);
    const ax = Math.abs(no[0]),
      ay = Math.abs(no[1]),
      az = Math.abs(no[2]);
    const [u, v] = az >= ax && az >= ay ? [0, 1] : ax >= ay ? [1, 2] : [2, 0];
    const pts = faceLoops(f).map((l) => l.vert._co);
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i],
        b = pts[j];
      if (a[v] > p[v] !== b[v] > p[v] && p[u] < ((b[u] - a[u]) * (p[v] - a[v])) / (b[v] - a[v]) + a[u]) inside = !inside;
    }
    return inside;
  },
  toString: () => '<module bmesh.geometry>',
};

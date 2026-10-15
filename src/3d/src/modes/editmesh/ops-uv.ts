// UV mapping operators for Edit Mode, plus hook / connect / bisect tools.
import { Matrix4, Vector3 } from 'three';
import { app, registerOperators, type PropDef } from '../../app/app';
import { MeshEdit, edgeKey, type EFace } from './meshedit';
import { withEdit, editMeshObjects } from './context';
import { editPoll } from './ops-basic';
import { unwrapUV } from '../../edit/unwrap';
import type { Topology } from '../../edit/topology';
import { buildMesh } from '../../mesh/mesh';
import type { MeshData } from '../../data/types';
import { activeView3D } from '../../editors/view3d/view3d';
import { newObject, uid, IDENTITY } from '../../data/defaults';
import { addObjectToScene } from '../../ops/object';
import { afterUnwrap, repackFaces } from '../../editors/uv/unwrapextra';
import { newModifier } from '../../eval/modifiers';

const V = (a: number[]) => new Vector3(a[0], a[1], a[2]);

/** Pack face islands (lists of faces) into the 0–1 square with a shelf packer. */
export function packIslands(m: MeshEdit, islands: number[][], margin: number) {
  // normalize texel density by 3D area / UV area
  const info = islands.map((faces) => {
    let area3 = 0,
      area2 = 0;
    let minU = Infinity,
      minV = Infinity,
      maxU = -Infinity,
      maxV = -Infinity;
    for (const fi of faces) {
      const f = m.faces[fi];
      const n = f.verts.length;
      for (let i = 1; i < n - 1; i++) {
        const a = V(m.p(f.verts[0])),
          b = V(m.p(f.verts[i])),
          c = V(m.p(f.verts[i + 1]));
        area3 += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
        const ua = [f.uvs[0], f.uvs[1]],
          ub = [f.uvs[i * 2], f.uvs[i * 2 + 1]],
          uc = [f.uvs[(i + 1) * 2], f.uvs[(i + 1) * 2 + 1]];
        area2 += Math.abs((ub[0] - ua[0]) * (uc[1] - ua[1]) - (uc[0] - ua[0]) * (ub[1] - ua[1])) / 2;
      }
      for (let i = 0; i < n; i++) {
        minU = Math.min(minU, f.uvs[i * 2]);
        maxU = Math.max(maxU, f.uvs[i * 2]);
        minV = Math.min(minV, f.uvs[i * 2 + 1]);
        maxV = Math.max(maxV, f.uvs[i * 2 + 1]);
      }
    }
    const scale = area2 > 1e-12 ? Math.sqrt(area3 / area2) : 1;
    return { faces, minU, minV, w: (maxU - minU) * scale, h: (maxV - minV) * scale, scale };
  });
  // try shelf packing at decreasing scales until everything fits
  const order = info.map((_, i) => i).sort((a, b) => info[b].h - info[a].h);
  const totalArea = info.reduce((s, i) => s + (i.w + margin) * (i.h + margin), 0);
  let k = 1 / Math.sqrt(Math.max(totalArea, 1e-9));
  for (let attempt = 0; attempt < 40; attempt++) {
    const place: { x: number; y: number }[] = [];
    let x = margin,
      y = margin,
      row = 0,
      ok = true;
    for (const i of order) {
      const w = info[i].w * k,
        h = info[i].h * k;
      if (x + w + margin > 1) {
        x = margin;
        y += row + margin;
        row = 0;
      }
      if (y + h + margin > 1 + 1e-9) {
        ok = false;
        break;
      }
      place[i] = { x, y };
      x += w + margin;
      row = Math.max(row, h);
    }
    if (ok) {
      for (let i = 0; i < info.length; i++) {
        const it = info[i];
        for (const fi of it.faces) {
          const f = m.faces[fi];
          for (let c = 0; c < f.verts.length; c++) {
            f.uvs[c * 2] = place[i].x + (f.uvs[c * 2] - it.minU) * it.scale * k;
            f.uvs[c * 2 + 1] = place[i].y + (f.uvs[c * 2 + 1] - it.minV) * it.scale * k;
          }
        }
      }
      return;
    }
    k *= 0.95;
  }
}

/** Connected face islands among a set of faces (split at seams). */
function faceIslands(m: MeshEdit, faces: number[], splitAtSeams = true): number[][] {
  const fs = new Set(faces);
  const ef = m.edgeFaces();
  const seen = new Set<number>();
  const out: number[][] = [];
  for (const s of faces) {
    if (seen.has(s)) continue;
    const isl: number[] = [];
    const st = [s];
    seen.add(s);
    while (st.length) {
      const fi = st.pop()!;
      isl.push(fi);
      const f = m.faces[fi];
      for (let i = 0; i < f.verts.length; i++) {
        if (splitAtSeams && f.seams[i]) continue;
        for (const [g, gi] of ef.get(edgeKey(f.verts[i], f.verts[(i + 1) % f.verts.length])) ?? []) {
          if (seen.has(g) || !fs.has(g)) continue;
          if (splitAtSeams && m.faces[g].seams[gi]) continue;
          seen.add(g);
          st.push(g);
        }
      }
    }
    out.push(isl);
  }
  return out;
}

function planarProject(m: MeshEdit, faces: number[], normal: Vector3) {
  const n = normal.clone().normalize();
  const u = (Math.abs(n.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0)).cross(n).normalize();
  const w = n.clone().cross(u);
  for (const fi of faces) {
    const f = m.faces[fi];
    f.verts.forEach((v, i) => {
      const p = V(m.p(v));
      f.uvs[i * 2] = p.dot(u);
      f.uvs[i * 2 + 1] = p.dot(w);
    });
  }
}

function smartProject(m: MeshEdit, faces: number[], angleLimit: number, margin: number, pack = true) {
  // grow charts of faces whose normals stay within the angle limit of the chart's seed
  const ef = m.edgeFaces();
  const fs = new Set(faces);
  const normals = new Map(faces.map((fi) => [fi, V(m.faceNormal(m.faces[fi]))]));
  const seen = new Set<number>();
  const charts: number[][] = [];
  const cosLimit = Math.cos(angleLimit);
  // seeds sorted by area so big flat regions stay together
  for (const seed of faces) {
    if (seen.has(seed)) continue;
    const ref = normals.get(seed)!;
    const chart: number[] = [];
    const st = [seed];
    seen.add(seed);
    while (st.length) {
      const fi = st.pop()!;
      chart.push(fi);
      const f = m.faces[fi];
      for (let i = 0; i < f.verts.length; i++)
        for (const [g] of ef.get(edgeKey(f.verts[i], f.verts[(i + 1) % f.verts.length])) ?? []) {
          if (seen.has(g) || !fs.has(g)) continue;
          if (normals.get(g)!.dot(ref) < cosLimit) continue;
          seen.add(g);
          st.push(g);
        }
    }
    charts.push(chart);
  }
  for (const chart of charts) {
    const n = new Vector3();
    for (const fi of chart) n.add(normals.get(fi)!);
    planarProject(m, chart, n.lengthSq() ? n : new Vector3(0, 0, 1));
  }
  if (pack) packIslands(m, charts, margin);
}

function boxProject(m: MeshEdit, faces: number[], size: number) {
  for (const fi of faces) {
    const f = m.faces[fi];
    const n = V(m.faceNormal(f));
    const ax = Math.abs(n.x),
      ay = Math.abs(n.y),
      az = Math.abs(n.z);
    f.verts.forEach((v, i) => {
      const p = m.p(v);
      let uv: number[];
      if (az >= ax && az >= ay) uv = [p[0], p[1] * Math.sign(n.z || 1)];
      else if (ax >= ay) uv = [p[1] * Math.sign(n.x || 1), p[2]];
      else uv = [-p[0] * Math.sign(n.y || 1), p[2]];
      f.uvs[i * 2] = uv[0] / size + 0.5;
      f.uvs[i * 2 + 1] = uv[1] / size + 0.5;
    });
  }
}

function cylinderProject(m: MeshEdit, faces: number[], sphere: boolean) {
  const c = new Vector3();
  let k = 0;
  for (const fi of faces)
    for (const v of m.faces[fi].verts) {
      c.add(V(m.p(v)));
      k++;
    }
  c.multiplyScalar(1 / Math.max(1, k));
  let minZ = Infinity,
    maxZ = -Infinity;
  for (const fi of faces)
    for (const v of m.faces[fi].verts) {
      minZ = Math.min(minZ, m.p(v)[2]);
      maxZ = Math.max(maxZ, m.p(v)[2]);
    }
  for (const fi of faces) {
    const f = m.faces[fi];
    const us: number[] = [];
    f.verts.forEach((v, i) => {
      const p = V(m.p(v)).sub(c);
      const u = 0.5 + Math.atan2(p.y, p.x) / (Math.PI * 2);
      const vv = sphere ? 0.5 + Math.asin(Math.max(-1, Math.min(1, p.z / (p.length() || 1)))) / Math.PI : (m.p(v)[2] - minZ) / (maxZ - minZ || 1);
      f.uvs[i * 2] = u;
      f.uvs[i * 2 + 1] = vv;
      us.push(u);
    });
    // fix the wrap seam
    if (Math.max(...us) - Math.min(...us) > 0.5) f.verts.forEach((_, i) => f.uvs[i * 2] < 0.5 && (f.uvs[i * 2] += 1));
  }
}

/** Optional bounds fitting after a projection: stretch to fill 0–1, then clamp to it. */
function fitBounds(m: MeshEdit, faces: number[], scale: boolean, clip: boolean) {
  if (scale) {
    let a = Infinity,
      b = Infinity,
      c = -Infinity,
      d = -Infinity;
    for (const fi of faces) {
      const f = m.faces[fi];
      for (let i = 0; i < f.verts.length; i++) {
        a = Math.min(a, f.uvs[i * 2]);
        c = Math.max(c, f.uvs[i * 2]);
        b = Math.min(b, f.uvs[i * 2 + 1]);
        d = Math.max(d, f.uvs[i * 2 + 1]);
      }
    }
    for (const fi of faces) {
      const f = m.faces[fi];
      for (let i = 0; i < f.verts.length; i++) {
        f.uvs[i * 2] = (f.uvs[i * 2] - a) / (c - a || 1);
        f.uvs[i * 2 + 1] = (f.uvs[i * 2 + 1] - b) / (d - b || 1);
      }
    }
  }
  if (clip)
    for (const fi of faces) {
      const f = m.faces[fi];
      for (let i = 0; i < f.uvs.length; i++) f.uvs[i] = Math.max(0, Math.min(1, f.uvs[i]));
    }
}

const boundsProps: PropDef[] = [
  { id: 'clip_to_bounds', label: 'Clip to Bounds', type: 'bool', default: false },
  { id: 'scale_to_bounds', label: 'Scale to Bounds', type: 'bool', default: false },
];

function project(fn: (m: MeshEdit, faces: number[]) => void, p: Record<string, unknown>) {
  return withEdit((m) => {
    const faces = targetFaces(m);
    if (!faces.length) return false;
    fn(m, faces);
    fitBounds(m, faces, !!p.scale_to_bounds, !!p.clip_to_bounds);
  })
    ? 'FINISHED'
    : 'CANCELLED';
}

function targetFaces(m: MeshEdit): number[] {
  const s = m.selectedFaces();
  return s.length ? s : [];
}

registerOperators([
  {
    idname: 'uv.unwrap',
    label: 'Unwrap',
    description: 'Unwrap the mesh of the object being edited, cutting along seams',
    props: [
      { id: 'method', label: 'Method', type: 'enum', default: 'CONFORMAL', items: [['ANGLE_BASED', 'Angle Based'], ['CONFORMAL', 'Conformal'], ['MINIMUM_STRETCH', 'Minimum Stretch']] },
      { id: 'iterations', label: 'Iterations', type: 'int', default: 10, min: 1, max: 1000, showIf: (p) => p.method === 'MINIMUM_STRETCH' },
      { id: 'margin', label: 'Margin', type: 'float', default: 0.001, min: 0, max: 1, subtype: 'factor' },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      let failed = '';
      // pinned UVs and the minimum-stretch relaxation are applied after the solve
      const post: { me: MeshData; before: Float32Array; faces: number[] }[] = [];
      const ok = withEdit((m, _ob, me) => {
        const faces = targetFaces(m);
        if (!faces.length) return false;
        post.push({ me, before: me.uvs, faces });
        // conformal solve per seam-delimited island; closed islands fall back to angle-based charts
        const t = buildMesh(m.pos, m.faces.map((f) => ({ verts: f.verts, uvs: f.uvs, seams: f.seams }))) as unknown as Topology;
        if (!t.seams) (t as { seams?: Uint32Array }).seams = new Uint32Array(t.indices.length);
        try {
          const res = unwrapUV(t, faces, Math.max(0.001, p.margin as number));
          let c = 0;
          m.faces.forEach((f) => {
            for (let i = 0; i < f.verts.length; i++, c++) {
              f.uvs[i * 2] = res.uvs[c * 2];
              f.uvs[i * 2 + 1] = res.uvs[c * 2 + 1];
            }
          });
        } catch (e) {
          failed = e instanceof Error ? e.message : String(e);
          // fallback: split closed shells by angle and project charts
          smartProject(m, faces, (66 * Math.PI) / 180, Math.max(0.001, p.margin as number));
        }
        void me;
      });
      if (!ok) {
        app.report('WARNING', 'Select faces to unwrap');
        return 'CANCELLED';
      }
      for (const x of post) afterUnwrap(x.me, x.before, x.faces, p.method === 'MINIMUM_STRETCH' ? (p.iterations as number) : 0);
      if (failed) app.report('WARNING', `Unwrap: ${failed} Used angle-based charts instead; mark seams for better results.`);
    },
  },
  {
    idname: 'uv.smart_project',
    label: 'Smart UV Project',
    props: [
      { id: 'angle_limit', label: 'Angle Limit', type: 'float', default: (66 * Math.PI) / 180, min: 0, max: Math.PI / 2, subtype: 'angle' },
      { id: 'rotate_method', label: 'Rotation Method', type: 'enum', default: 'AXIS_ALIGNED_Y', items: [['AXIS_ALIGNED', 'Axis-aligned'], ['AXIS_ALIGNED_X', 'Axis-aligned (Horizontal)'], ['AXIS_ALIGNED_Y', 'Axis-aligned (Vertical)']] },
      { id: 'island_margin', label: 'Island Margin', type: 'float', default: 0, min: 0, max: 1, subtype: 'factor' },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      const post: { me: MeshData; faces: number[] }[] = [];
      if (!withEdit((m, _ob, me) => {
        const faces = targetFaces(m);
        if (!faces.length) return false;
        smartProject(m, faces, p.angle_limit as number, 0, false);
        post.push({ me, faces });
      }))
        return 'CANCELLED';
      for (const x of post) repackFaces(x.me, x.faces, { margin: Math.max(0.002, p.island_margin as number), rotate: true, rotateMethod: p.rotate_method as 'AXIS_ALIGNED', scale: true });
    },
  },
  {
    idname: 'uv.lightmap_pack',
    label: 'Lightmap Pack',
    props: [{ id: 'PREF_MARGIN_DIV', label: 'Margin', type: 'float', default: 0.1, min: 0.001, max: 1 }],
    poll: editPoll,
    exec: (_ctx, p) => {
      const post: { me: MeshData; faces: number[] }[] = [];
      if (!withEdit((m, _ob, me) => {
        const faces = targetFaces(m);
        if (!faces.length) return false;
        for (const fi of faces) planarProject(m, [fi], V(m.faceNormal(m.faces[fi])));
        post.push({ me, faces });
      }))
        return 'CANCELLED';
      for (const x of post) repackFaces(x.me, x.faces, { margin: (p.PREF_MARGIN_DIV as number) * 0.02, rotate: true, rotateMethod: 'AXIS_ALIGNED', scale: true });
    },
  },
  {
    idname: 'uv.cube_project',
    label: 'Cube Projection',
    props: [{ id: 'cube_size', label: 'Cube Size', type: 'float', default: 2, min: 0, subtype: 'distance' }, ...boundsProps],
    poll: editPoll,
    exec: (_ctx, p) => project((m, faces) => boxProject(m, faces, p.cube_size as number), p),
  },
  {
    idname: 'uv.cylinder_project',
    label: 'Cylinder Projection',
    props: boundsProps,
    poll: editPoll,
    exec: (_ctx, p) => project((m, faces) => cylinderProject(m, faces, false), p),
  },
  {
    idname: 'uv.sphere_project',
    label: 'Sphere Projection',
    props: boundsProps,
    poll: editPoll,
    exec: (_ctx, p) => project((m, faces) => cylinderProject(m, faces, true), p),
  },
  {
    idname: 'uv.project_from_view',
    label: 'Project from View',
    props: [{ id: 'scale_to_bounds', label: 'Scale to Bounds', type: 'bool', default: false }],
    poll: (ctx) => editPoll(ctx) && !!activeView3D(),
    exec: (_ctx, p) => {
      const v = activeView3D()!;
      withEdit((m, ob) => {
        const faces = targetFaces(m);
        if (!faces.length) return false;
        const world = app.graph.get(ob.id)?.world ?? new Matrix4();
        let minU = Infinity,
          minV = Infinity,
          maxU = -Infinity,
          maxV = -Infinity;
        for (const fi of faces) {
          const f = m.faces[fi];
          f.verts.forEach((vv, i) => {
            const s = v.project(V(m.p(vv)).applyMatrix4(world));
            f.uvs[i * 2] = s.x / v.width;
            f.uvs[i * 2 + 1] = 1 - s.y / v.height;
            minU = Math.min(minU, f.uvs[i * 2]);
            maxU = Math.max(maxU, f.uvs[i * 2]);
            minV = Math.min(minV, f.uvs[i * 2 + 1]);
            maxV = Math.max(maxV, f.uvs[i * 2 + 1]);
          });
        }
        if (p.scale_to_bounds)
          for (const fi of faces) {
            const f = m.faces[fi];
            for (let i = 0; i < f.verts.length; i++) {
              f.uvs[i * 2] = (f.uvs[i * 2] - minU) / (maxU - minU || 1);
              f.uvs[i * 2 + 1] = (f.uvs[i * 2 + 1] - minV) / (maxV - minV || 1);
            }
          }
      });
    },
  },
  {
    idname: 'uv.reset',
    label: 'Reset',
    description: 'Reset UV projection: each face fills the whole UV square',
    poll: editPoll,
    exec: () =>
      void withEdit((m) => {
        const faces = targetFaces(m);
        if (!faces.length) return false;
        for (const fi of faces) {
          const f = m.faces[fi];
          const n = f.verts.length;
          f.verts.forEach((_, i) => {
            if (n === 4) {
              const q = [[0, 0], [1, 0], [1, 1], [0, 1]][i];
              f.uvs[i * 2] = q[0];
              f.uvs[i * 2 + 1] = q[1];
            } else {
              const a = (i / n) * Math.PI * 2;
              f.uvs[i * 2] = 0.5 + Math.cos(a) * 0.5;
              f.uvs[i * 2 + 1] = 0.5 + Math.sin(a) * 0.5;
            }
          });
        }
      }),
  },
  {
    idname: 'uv.follow_active_quads',
    label: 'Follow Active Quads',
    description: 'Unfold quad strips along the selected faces into a rectangular grid',
    poll: editPoll,
    exec: () => {
      if (!withEdit((m) => {
        const faces = targetFaces(m).filter((fi) => m.faces[fi].verts.length === 4);
        if (!faces.length) return false;
        followQuads(m, faces);
        packIslands(m, faceIslands(m, faces, false), 0.002);
      }))
        return 'CANCELLED';
    },
  },
  {
    idname: 'mesh.vert_connect_path',
    label: 'Connect Vertex Path',
    description: 'Split faces by connecting selected vertices that share a face',
    poll: editPoll,
    exec: () => {
      if (!withEdit((m) => {
        const sel = new Set(m.selectedVerts());
        if (sel.size < 2) return false;
        const out: EFace[] = [];
        let changed = false;
        for (const f of m.faces) {
          const idx = f.verts.map((v, i) => (sel.has(v) ? i : -1)).filter((i) => i >= 0);
          if (idx.length !== 2 || (idx[1] - idx[0] + f.verts.length) % f.verts.length === 1 || (idx[0] - idx[1] + f.verts.length) % f.verts.length === 1) {
            out.push(f);
            continue;
          }
          const [i, j] = idx;
          const part = (from: number, to: number) => {
            const verts: number[] = [],
              uvs: number[] = [];
            for (let k = from; ; k = (k + 1) % f.verts.length) {
              verts.push(f.verts[k]);
              uvs.push(f.uvs[k * 2], f.uvs[k * 2 + 1]);
              if (k === to) break;
            }
            return m.makeFace(verts, f, uvs);
          };
          out.push(part(i, j), part(j, i));
          changed = true;
        }
        m.faces = out;
        return changed;
      }))
        return 'CANCELLED';
    },
  },
  {
    idname: 'mesh.bisect',
    label: 'Bisect',
    description: 'Cut the selected geometry along a plane through the 3D cursor facing the view',
    props: [{ id: 'plane_co', label: 'Plane Point', type: 'vec3', default: null, subtype: 'distance' }, { id: 'plane_no', label: 'Plane Normal', type: 'vec3', default: null }, { id: 'clear_inner', label: 'Clear Inner', type: 'bool', default: false }, { id: 'clear_outer', label: 'Clear Outer', type: 'bool', default: false }],
    poll: editPoll,
    exec: (_ctx, p) => {
      const v = activeView3D();
      const co = p.plane_co ? V(p.plane_co as number[]) : V(app.doc.scene.cursor.location);
      let no = p.plane_no ? V(p.plane_no as number[]) : null;
      if (!no) {
        const fwd = v ? new Vector3(0, 0, -1).applyQuaternion(v.camera.quaternion) : new Vector3(0, 0, 1);
        // plane contains the view direction → normal = view right vector
        no = v ? new Vector3(1, 0, 0).applyQuaternion(v.camera.quaternion) : new Vector3(1, 0, 0);
        void fwd;
      }
      p.plane_co = [co.x, co.y, co.z];
      p.plane_no = [no.x, no.y, no.z];
      withEdit((m, ob) => {
        const inv = (app.graph.get(ob.id)?.world ?? new Matrix4()).clone().invert();
        const lc = co.clone().applyMatrix4(inv),
          ln = no!.clone().transformDirection(inv);
        bisectMesh(m, lc, ln, !!p.clear_inner, !!p.clear_outer);
      });
    },
  },
  {
    idname: 'object.hook_add_newob',
    label: 'Hook to New Object',
    description: 'Hook selected vertices to a new empty',
    poll: editPoll,
    exec: (ctx) => {
      const { ob, me } = editMeshObjects()[0] ?? {};
      if (!ob || !me?.select_vert) return 'CANCELLED';
      const idx: number[] = [];
      const c = new Vector3();
      me.select_vert.forEach((s, i) => {
        if (!s) return;
        idx.push(i);
        c.add(new Vector3(me.positions[i * 3], me.positions[i * 3 + 1], me.positions[i * 3 + 2]));
      });
      if (!idx.length) return 'CANCELLED';
      c.multiplyScalar(1 / idx.length);
      const world = app.graph.get(ob.id)?.world ?? new Matrix4();
      const wc = c.clone().applyMatrix4(world);
      const empty = newObject('Empty', 'EMPTY', null);
      const keepActive = ctx.doc.scene.active_object;
      addObjectToScene(ctx.doc, empty, { location: [wc.x, wc.y, wc.z] });
      ctx.doc.scene.active_object = keepActive;
      empty.select = false;
      ob.select = true;
      const md = newModifier('HOOK', uid('md'), ob.modifiers);
      md.object = empty.id;
      md.vertex_indices = idx;
      md.center = [c.x, c.y, c.z];
      // inverse of the empty's world at bind time, in the hook's convention (applied after the object's world)
      const emptyWorld = new Matrix4().makeTranslation(wc.x, wc.y, wc.z);
      md.matrix_inverse = emptyWorld.clone().invert().toArray();
      ob.modifiers.push(md);
      void IDENTITY;
    },
  },
]);


function followQuads(m: MeshEdit, faces: number[]) {
  // BFS over quads assigning grid coordinates; edge lengths averaged per strip
  const fs = new Set(faces);
  const ef = m.edgeFaces();
  const uvOfVert = new Map<string, [number, number]>();
  const start = faces[0];
  const f0 = m.faces[start];
  const l01 = V(m.p(f0.verts[0])).distanceTo(V(m.p(f0.verts[1]))),
    l12 = V(m.p(f0.verts[1])).distanceTo(V(m.p(f0.verts[2])));
  const set = (fi: number, v: number, uv: [number, number]) => uvOfVert.set(`${fi}:${v}`, uv);
  set(start, f0.verts[0], [0, 0]);
  set(start, f0.verts[1], [l01, 0]);
  set(start, f0.verts[2], [l01, l12]);
  set(start, f0.verts[3], [0, l12]);
  const done = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const fi = queue.shift()!;
    const f = m.faces[fi];
    for (let i = 0; i < 4; i++) {
      const a = f.verts[i],
        b = f.verts[(i + 1) % 4];
      for (const [g] of ef.get(edgeKey(a, b)) ?? []) {
        if (done.has(g) || !fs.has(g)) continue;
        const G = m.faces[g];
        const ua = uvOfVert.get(`${fi}:${a}`)!,
          ub = uvOfVert.get(`${fi}:${b}`)!;
        const pa = uvOfVert.get(`${fi}:${f.verts[(i + 3) % 4]}`)!; // opposite side for direction
        const dir = [ua[0] - pa[0], ua[1] - pa[1]];
        const dl = Math.hypot(dir[0], dir[1]) || 1;
        const ga = G.verts.indexOf(a),
          gb = G.verts.indexOf(b);
        const oa = G.verts.find((x, k) => k !== ga && k !== gb && (G.verts[(k + 1) % 4] === a || G.verts[(k + 3) % 4] === a))!;
        const ob2 = G.verts.find((x) => x !== a && x !== b && x !== oa)!;
        const len = V(m.p(a)).distanceTo(V(m.p(oa)));
        set(g, a, ua);
        set(g, b, ub);
        set(g, oa, [ua[0] + (dir[0] / dl) * len, ua[1] + (dir[1] / dl) * len]);
        set(g, ob2, [ub[0] + (dir[0] / dl) * len, ub[1] + (dir[1] / dl) * len]);
        done.add(g);
        queue.push(g);
      }
    }
  }
  for (const fi of faces) {
    const f = m.faces[fi];
    f.verts.forEach((v, i) => {
      const uv = uvOfVert.get(`${fi}:${v}`);
      if (uv) {
        f.uvs[i * 2] = uv[0];
        f.uvs[i * 2 + 1] = uv[1];
      }
    });
  }
}

export function bisectMesh(m: MeshEdit, co: Vector3, no: Vector3, clearInner: boolean, clearOuter: boolean) {
  const n = no.clone().normalize();
  const side = (v: number) => V(m.p(v)).sub(co).dot(n);
  const selFaces = new Set(m.selectedFaces());
  const cut = new Map<string, number>();
  const cutVert = (a: number, b: number) => {
    const k = edgeKey(a, b);
    let id = cut.get(k);
    if (id === undefined) {
      const sa = side(a),
        sb = side(b);
      const t = sa / (sa - sb);
      const p = V(m.p(a)).lerp(V(m.p(b)), t);
      id = m.addVert([p.x, p.y, p.z], [[a, 1 - t], [b, t]], 1);
      cut.set(k, id);
    }
    return id;
  };
  const out: EFace[] = [];
  const eps = 1e-7;
  m.faces.forEach((f, fi) => {
    if (selFaces.size && !selFaces.has(fi)) return out.push(f);
    const sides = f.verts.map(side);
    const pos = sides.some((s) => s > eps),
      neg = sides.some((s) => s < -eps);
    if (!(pos && neg)) {
      if ((clearInner && !pos) || (clearOuter && !neg)) return;
      return out.push(f);
    }
    const halves: { verts: number[]; uvs: number[] }[] = [
      { verts: [], uvs: [] },
      { verts: [], uvs: [] },
    ];
    const nn = f.verts.length;
    for (let i = 0; i < nn; i++) {
      const a = f.verts[i],
        b = f.verts[(i + 1) % nn];
      const sa = sides[i],
        sb = sides[(i + 1) % nn];
      const ua = [f.uvs[i * 2], f.uvs[i * 2 + 1]];
      if (sa >= -eps) {
        halves[0].verts.push(a);
        halves[0].uvs.push(...ua);
      }
      if (sa <= eps) {
        halves[1].verts.push(a);
        halves[1].uvs.push(...ua);
      }
      if ((sa > eps && sb < -eps) || (sa < -eps && sb > eps)) {
        const id = cutVert(a, b);
        const t = sa / (sa - sb);
        const j = (i + 1) % nn;
        const uv = [f.uvs[i * 2] + (f.uvs[j * 2] - f.uvs[i * 2]) * t, f.uvs[i * 2 + 1] + (f.uvs[j * 2 + 1] - f.uvs[i * 2 + 1]) * t];
        halves[0].verts.push(id);
        halves[0].uvs.push(...uv);
        halves[1].verts.push(id);
        halves[1].uvs.push(...uv);
      }
    }
    if (!clearOuter && halves[0].verts.length >= 3) out.push(m.makeFace(halves[0].verts, f, halves[0].uvs));
    if (!clearInner && halves[1].verts.length >= 3) out.push(m.makeFace(halves[1].verts, f, halves[1].uvs));
  });
  m.faces = out;
  m.sel = m.sel.map(() => 0);
  for (const id of cut.values()) m.sel[id] = 1;
  m.compact();
}

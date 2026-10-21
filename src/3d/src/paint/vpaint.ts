// Vertex Paint mode: paints the active color attribute (point or corner domain) with Draw, Blur,
// Average and Smear brushes, plus the set/smooth/dirty/invert vertex color operators.
import { Vector3 } from 'three';
import { app, registerOperators } from '../app/app';
import { cow, own } from '../data/cow';
import type { ColorAttribute, MeshData } from '../data/types';
import type { View3D } from '../editors/view3d/view3d';
import { activeBrush, type PaintBrush } from './brushes';
import { blendColor, type BlendMode } from './math';
import { activeMeshData, beginGeometryStroke, meshSession, reevaluate, type MeshSession } from './session';
import { runStroke } from './stroke';
import { brushRadiusPx, gatherPaint, normalAngleOf, smearSource, type NormalFalloff } from './vgather';
import { dabTexture } from './brushtex';
import { colorJitterOn, colorJitterer, seededRandom, type ColorJitter } from './paintmath';
import { paintFilter } from './fsdata';

/** Make sure the mesh has an active color attribute (point domain 'Color', white). */
export function ensureColorAttribute(me: MeshData): ColorAttribute {
  let a = me.color_attributes[me.active_color_index];
  if (!a) {
    if (me.color_attributes.length) me.active_color_index = 0;
    else {
      const data = own(new Float32Array((me.positions.length / 3) * 4).fill(1));
      me.color_attributes.push({ name: 'Color', domain: 'POINT', data });
      me.active_color_index = 0;
    }
    a = me.color_attributes[me.active_color_index];
  }
  return a;
}

/** Per-vertex RGBA view of a color attribute (corner domain is averaged per vertex). */
export function vertexColors(me: MeshData, a: ColorAttribute): Float32Array {
  const nv = me.positions.length / 3;
  if (a.domain === 'POINT') return a.data;
  const out = new Float32Array(nv * 4),
    cnt = new Uint32Array(nv);
  for (let c = 0; c < me.indices.length; c++) {
    const v = me.indices[c];
    for (let k = 0; k < 4; k++) out[v * 4 + k] += a.data[c * 4 + k];
    cnt[v]++;
  }
  for (let v = 0; v < nv; v++) if (cnt[v]) for (let k = 0; k < 4; k++) out[v * 4 + k] /= cnt[v];
  return out;
}

/** Write a vertex's color into the attribute and the GPU color buffer. */
export function writeVertex(s: MeshSession, a: ColorAttribute, vi: number, rgba: ArrayLike<number>, gpu: Float32Array | null) {
  const o = s.vf.offsets,
    C = s.vf.corners;
  if (a.domain === 'POINT') for (let k = 0; k < 4; k++) a.data[vi * 4 + k] = rgba[k];
  for (let j = o[vi]; j < o[vi + 1]; j++) {
    const c = C[j];
    if (a.domain === 'CORNER') for (let k = 0; k < 4; k++) a.data[c * 4 + k] = rgba[k];
    if (gpu) for (let k = 0; k < 4; k++) gpu[c * 4 + k] = rgba[k];
    s.markColorDirty(c, c);
  }
}

export function gpuColors(s: MeshSession): Float32Array | null {
  const g = s.liveGeometry();
  const a = g?.getAttribute('color');
  return a && a.count === s.nc && a.itemSize === 4 ? (a.array as Float32Array) : null;
}

export function vertexPaintStroke(v: View3D, e: PointerEvent, override?: PaintBrush): boolean {
  const am = activeMeshData();
  const b = override ?? activeBrush('VERTEX_PAINT');
  const s = meshSession();
  if (!am || !b || !s) return false;
  const { me } = am;
  const attr0 = ensureColorAttribute(me);
  const index = me.color_attributes.indexOf(attr0);
  const oldData = attr0.data;
  beginGeometryStroke(s, me, () => cow(me.color_attributes[index], 'data'));
  const a = me.color_attributes[index];
  const ts = app.doc.scene.tool_settings;
  const invert = e.ctrlKey || e.metaKey;
  // sculpt mode paint brushes: Paint / Smear map onto the vertex paint tools
  const sculpt = app.doc.mode === 'SCULPT';
  const tool = e.shiftKey ? 'BLUR' : b.sculpt_tool === 'PAINT' ? 'DRAW' : b.sculpt_tool;
  const sMask = sculpt && me.sculpt_mask && me.sculpt_mask.length === s.nv ? me.sculpt_mask : null;
  const sHidden = sculpt ? s.hiddenV : null;
  const baseColor = invert ? ts.unified_paint.secondary_color : ts.unified_paint.color;
  let color: ArrayLike<number> = baseColor;
  // Randomize Color: a new color per dab (or per stroke)
  const jit = colorJitterOn(ts.unified_paint as ColorJitter) ? colorJitterer(ts.unified_paint as ColorJitter, seededRandom((Date.now() ^ (Math.random() * 1e9)) >>> 0)) : null;
  const mode = (b.blend ?? 'MIX') as BlendMode;
  const orig = vertexColors(me, oldData === a.data ? { ...a, data: a.data.slice() } : { ...a, data: oldData });
  const cur = vertexColors(me, a);
  const strokeAlpha = new Float32Array(s.nv);
  const scratch = {};
  let lastHit: Vector3 | null = null;
  const tmp = [0, 0, 0, 1];
  let dabCount = 0;
  runStroke(v, e, {
    spacing: () => Math.max(1, b.spacing || 10),
    radiusPx: () => b.radius,
    settings: () => b,
    dab: (d) => {
      const hit = s.raycast(v, d.x, d.y);
      if (b.falloff_shape === 'SPHERE' && !hit) return;
      const strength = Math.max(0, b.strength) * d.pressure;
      const n = gatherPaint(
        s,
        v,
        {
          brush: b,
          x: d.x,
          y: d.y,
          hit,
          strength: 1,
          normalAngle: normalAngleOf((app.doc.scene.tool_settings as unknown as { vertex_paint?: NormalFalloff }).vertex_paint),
          sizeFactor: d.sizeFactor,
          tex: dabTexture(b, s, v, d.x, d.y, brushRadiusPx(b, s, v, hit?.world) * (d.sizeFactor ?? 1), dabCount++),
        },
        scratch,
      );
      if (!n) return;
      if (sMask || sHidden)
        for (let k = 0; k < n; k++) {
          const vi = s.gv[k];
          if (sHidden?.[vi]) s.gf[k] = 0;
          else if (sMask) s.gf[k] *= 1 - sMask[vi];
        }
      const gpu = gpuColors(s);
      if (jit) color = jit(baseColor, d.pressure);
      if (tool === 'DRAW') {
        for (let k = 0; k < n; k++) {
          const vi = s.gv[k];
          const f = s.gf[k] * strength;
          // stroke-limited alpha: overlapping dabs never exceed the brush strength
          const sa = b.use_accumulate ? Math.min(1, strokeAlpha[vi] + f) : Math.max(strokeAlpha[vi], f);
          if (sa <= strokeAlpha[vi] && !b.use_accumulate) continue;
          strokeAlpha[vi] = sa;
          blendColor(mode, orig.subarray(vi * 4, vi * 4 + 4), color, sa, tmp);
          cur.set(tmp, vi * 4);
          writeVertex(s, a, vi, tmp, gpu);
        }
      } else if (tool === 'BLUR' || tool === 'AVERAGE' || tool === 'SMEAR') {
        const prev = new Float32Array(n * 4);
        for (let k = 0; k < n; k++) prev.set(cur.subarray(s.gv[k] * 4, s.gv[k] * 4 + 4), k * 4);
        const avg = [0, 0, 0, 0];
        if (tool === 'AVERAGE') {
          let wsum = 0;
          for (let k = 0; k < n; k++) {
            const w = s.gf[k];
            for (let c = 0; c < 4; c++) avg[c] += prev[k * 4 + c] * w;
            wsum += w;
          }
          for (let c = 0; c < 4; c++) avg[c] /= wsum || 1;
        }
        const dir = hit && lastHit ? hit.point.clone().sub(lastHit) : null;
        const nb = s.neighbors;
        const snapshot = tool === 'SMEAR' ? cur.slice() : cur;
        for (let k = 0; k < n; k++) {
          const vi = s.gv[k];
          const f = Math.min(1, s.gf[k] * strength);
          let target: ArrayLike<number> | null = null;
          if (tool === 'AVERAGE') target = avg;
          else if (tool === 'BLUR') {
            const t = [0, 0, 0, 0];
            const s0 = nb.offsets[vi],
              e0 = nb.offsets[vi + 1];
            if (e0 === s0) continue;
            for (let j = s0; j < e0; j++) for (let c = 0; c < 4; c++) t[c] += cur[nb.neighbors[j] * 4 + c];
            for (let c = 0; c < 4; c++) t[c] /= e0 - s0;
            target = t;
          } else if (dir && dir.lengthSq() > 0) {
            const u = smearSource(s, vi, dir.clone().normalize());
            if (u >= 0) target = snapshot.subarray(u * 4, u * 4 + 4);
          }
          if (!target) continue;
          for (let c = 0; c < 4; c++) tmp[c] = prev[k * 4 + c] + (target[c] - prev[k * 4 + c]) * f;
          cur.set(tmp, vi * 4);
          writeVertex(s, a, vi, tmp, gpu);
        }
      }
      if (hit) lastHit = hit.point.clone();
    },
    update: () => {
      if (s.direct && gpuColors(s)) s.flush();
      else reevaluate(s);
    },
    end: () => {
      app.pushUndo(sculpt ? b.name : 'Vertex Paint');
      app.changed('doc');
    },
  });
  return true;
}

/** Sample the color under the cursor into the brush color (Shift X). */
export function sampleVertexColor(v: View3D, x: number, y: number): boolean {
  const am = activeMeshData();
  const s = meshSession();
  if (!am || !s) return false;
  const a = am.me.color_attributes[am.me.active_color_index];
  const hit = s.raycast(v, x, y);
  if (!a || !hit) return false;
  const cols = vertexColors(am.me, a);
  const bc = barycentric(s, hit.tri, hit.point);
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const vi = s.tris[hit.tri * 3 + i];
    for (let c = 0; c < 3; c++) out[c] += cols[vi * 4 + c] * bc[i];
  }
  app.doc.scene.tool_settings.unified_paint.color = out as [number, number, number];
  return true;
}

/** Barycentric coordinates of a point inside triangle `tri`. */
export function barycentric(s: MeshSession, tri: number, p: Vector3): [number, number, number] {
  const P = s.positions;
  const ia = s.tris[tri * 3] * 3,
    ib = s.tris[tri * 3 + 1] * 3,
    ic = s.tris[tri * 3 + 2] * 3;
  const a = new Vector3(P[ia], P[ia + 1], P[ia + 2]),
    b = new Vector3(P[ib], P[ib + 1], P[ib + 2]),
    c = new Vector3(P[ic], P[ic + 1], P[ic + 2]);
  const v0 = b.clone().sub(a),
    v1 = c.clone().sub(a),
    v2 = p.clone().sub(a);
  const d00 = v0.dot(v0),
    d01 = v0.dot(v1),
    d11 = v1.dot(v1),
    d20 = v2.dot(v0),
    d21 = v2.dot(v1);
  const den = d00 * d11 - d01 * d01 || 1;
  const bv = (d11 * d20 - d01 * d21) / den,
    bw = (d00 * d21 - d01 * d20) / den;
  return [1 - bv - bw, bv, bw];
}

// ---------------------------------------------------------------------------
// operators

function vpaintPoll() {
  return app.doc.mode === 'VERTEX_PAINT' && !!activeMeshData();
}

export function editColors(fn: (me: MeshData, cols: Float32Array, a: ColorAttribute) => void) {
  const { me } = activeMeshData()!;
  const a = ensureColorAttribute(me);
  cow(a, 'data');
  const nv = me.positions.length / 3;
  const cols = vertexColors(me, a);
  const allowed = paintFilter(me).verts;
  const before = allowed ? cols.slice() : null;
  fn(me, cols, a);
  // selection masks / hidden vertices keep their colors
  if (allowed && before) for (let v = 0; v < nv; v++) if (!allowed[v]) for (let k = 0; k < 4; k++) cols[v * 4 + k] = before[v * 4 + k];
  if (a.domain === 'POINT') a.data.set(cols.subarray(0, nv * 4));
  else for (let c = 0; c < me.indices.length; c++) a.data.set(cols.subarray(me.indices[c] * 4, me.indices[c] * 4 + 4), c * 4);
}

registerOperators([
  {
    idname: 'paint.vertex_color_set',
    label: 'Set Color Attribute',
    description: 'Fill the active color attribute with the current paint color',
    poll: vpaintPoll,
    exec: () => {
      const c = app.doc.scene.tool_settings.unified_paint.color;
      editColors((_me, cols) => {
        for (let i = 0; i < cols.length; i += 4) {
          cols[i] = c[0];
          cols[i + 1] = c[1];
          cols[i + 2] = c[2];
          cols[i + 3] = 1;
        }
      });
    },
  },
  {
    idname: 'paint.vertex_color_smooth',
    label: 'Smooth Vertex Colors',
    description: 'Smooth colors across vertices',
    poll: vpaintPoll,
    exec: () => {
      const s = meshSession()!;
      editColors((_me, cols) => {
        const nb = s.neighbors;
        const src = cols.slice();
        for (let v = 0; v < s.nv; v++) {
          const a = nb.offsets[v],
            e = nb.offsets[v + 1];
          if (e === a) continue;
          for (let c = 0; c < 4; c++) {
            let sum = src[v * 4 + c];
            for (let j = a; j < e; j++) sum += src[nb.neighbors[j] * 4 + c];
            cols[v * 4 + c] = sum / (e - a + 1);
          }
        }
      });
    },
  },
  {
    idname: 'paint.vertex_color_invert',
    label: 'Invert Colors',
    poll: vpaintPoll,
    exec: () =>
      editColors((_me, cols) => {
        for (let i = 0; i < cols.length; i += 4) for (let c = 0; c < 3; c++) cols[i + c] = 1 - cols[i + c];
      }),
  },
  {
    idname: 'paint.vertex_color_dirt',
    label: 'Dirty Vertex Colors',
    description: 'Darken concave areas based on the angle to neighbouring vertices',
    props: [
      {
        id: 'blur_strength',
        label: 'Blur Strength',
        type: 'float',
        default: 1,
        min: 0.01,
        max: 1,
      },
      {
        id: 'blur_iterations',
        label: 'Blur Iterations',
        type: 'int',
        default: 1,
        min: 0,
        max: 40,
      },
      {
        id: 'clean_angle',
        label: 'Highlight Angle',
        type: 'float',
        default: Math.PI,
        min: 0,
        max: Math.PI,
        subtype: 'angle',
      },
      {
        id: 'dirt_angle',
        label: 'Dirt Angle',
        type: 'float',
        default: 0,
        min: 0,
        max: Math.PI,
        subtype: 'angle',
      },
      { id: 'dirt_only', label: 'Dirt Only', type: 'bool', default: false },
    ],
    poll: vpaintPoll,
    exec: (_ctx, p) => {
      const s = meshSession()!;
      editColors((_me, cols) => dirtyColors(s, cols, p.blur_strength as number, p.blur_iterations as number, p.clean_angle as number, p.dirt_angle as number, !!p.dirt_only));
    },
  },
]);

/** Cavity shading: per-vertex concavity from the angle between the normal and edges to neighbours. */
function dirtyColors(s: MeshSession, cols: Float32Array, blurStrength: number, iterations: number, cleanAngle: number, dirtAngle: number, dirtOnly: boolean) {
  const nb = s.neighbors,
    P = s.positions,
    vn = s.vn;
  let dirt = new Float32Array(s.nv);
  for (let v = 0; v < s.nv; v++) {
    let sum = 0,
      cnt = 0;
    for (let j = nb.offsets[v]; j < nb.offsets[v + 1]; j++) {
      const u = nb.neighbors[j];
      const dx = P[u * 3] - P[v * 3],
        dy = P[u * 3 + 1] - P[v * 3 + 1],
        dz = P[u * 3 + 2] - P[v * 3 + 2];
      const l = Math.hypot(dx, dy, dz) || 1;
      sum += Math.acos(Math.max(-1, Math.min(1, (dx * vn[v * 3] + dy * vn[v * 3 + 1] + dz * vn[v * 3 + 2]) / l)));
      cnt++;
    }
    dirt[v] = cnt ? sum / cnt : Math.PI / 2;
  }
  for (let it = 0; it < iterations; it++) {
    const next = dirt.slice();
    for (let v = 0; v < s.nv; v++) {
      const a = nb.offsets[v],
        e = nb.offsets[v + 1];
      if (e === a) continue;
      let sum = 0;
      for (let j = a; j < e; j++) sum += dirt[nb.neighbors[j]];
      next[v] = dirt[v] + (sum / (e - a) - dirt[v]) * blurStrength;
    }
    dirt = next;
  }
  let lo = Infinity,
    hi = -Infinity;
  for (let v = 0; v < s.nv; v++) {
    lo = Math.min(lo, dirt[v]);
    hi = Math.max(hi, dirt[v]);
  }
  lo = Math.max(lo, dirtAngle);
  hi = Math.min(hi, cleanAngle);
  const range = hi - lo || 1;
  for (let v = 0; v < s.nv; v++) {
    // small angle between normal and edges: neighbours above the tangent plane → concave → darker
    let t = (dirt[v] - lo) / range;
    t = Math.max(0, Math.min(1, t));
    const shade = dirtOnly ? Math.min(1, 2 * t) : t;
    for (let c = 0; c < 3; c++) cols[v * 4 + c] *= shade;
  }
}

export type { PaintBrush };

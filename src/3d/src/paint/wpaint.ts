// Weight Paint mode: paints the active vertex group with Draw / Blur / Average / Smear, auto
// normalize over deform groups, weight sampling and the vertex group cleanup operators.
import { Vector3 } from 'three';
import { app, registerOperators } from '../app/app';
import { cow, own } from '../data/cow';
import type { MeshData, ObjectData } from '../data/types';
import type { View3D } from '../editors/view3d/view3d';
import { activeBrush } from './brushes';
import { blendWeight, normalizeAllWeights, normalizeVertexWeights, type BlendMode } from './math';
import { activeMeshData, beginGeometryStroke, meshSession, reevaluate, type MeshSession } from './session';
import { runStroke } from './stroke';
import { paintFilter } from './fsdata';
import { gatherPaint, NORMAL_ANGLE, smearSource } from './vgather';
import { invalidatePaintAttributes, writeCornerValues } from './display';
import { barycentric } from './vpaint';
import { armatureWeightsFor } from './armweights';

/** Active vertex group of the object, creating 'Group' when the mesh has none. */
export function ensureActiveGroup(ob: ObjectData, me: MeshData): number {
  if (!me.vertex_groups.length) {
    me.vertex_groups.push({ name: 'Group' });
    me.weights.push(own(new Float32Array(me.positions.length / 3)));
    ob.vertex_group_active_index = 0;
  }
  let gi = ob.vertex_group_active_index ?? 0;
  if (gi < 0 || gi >= me.vertex_groups.length) gi = ob.vertex_group_active_index = 0;
  const nv = me.positions.length / 3;
  for (let g = 0; g < me.weights.length; g++) if (!me.weights[g] || me.weights[g].length !== nv) me.weights[g] = own(new Float32Array(nv));
  while (me.weights.length < me.vertex_groups.length) me.weights.push(own(new Float32Array(nv)));
  return gi;
}

/** Groups that deform the mesh: bones of armature modifiers' armatures (all groups without one). */
export function deformGroups(ob: ObjectData, me: MeshData): number[] {
  const names = new Set<string>();
  let hasArm = false;
  for (const m of ob.modifiers) {
    if (m.type !== 'ARMATURE' || !m.object) continue;
    const arm = app.doc.objects[m.object as string];
    const ad = arm?.data ? app.doc.armatures[arm.data] : undefined;
    if (!ad) continue;
    hasArm = true;
    for (const b of ad.bones) if (b.use_deform) names.add(b.name);
  }
  const out: number[] = [];
  me.vertex_groups.forEach((g, i) => {
    if (!hasArm || names.has(g.name)) out.push(i);
  });
  return out;
}

function weightBuffers(s: MeshSession) {
  return s;
}

export function weightPaintStroke(v: View3D, e: PointerEvent): boolean {
  const am = activeMeshData();
  const b = activeBrush('WEIGHT_PAINT');
  const s = meshSession();
  if (!am || !b || !s) return false;
  const { ob, me } = am;
  const ts = app.doc.scene.tool_settings;
  const created = !me.vertex_groups.length;
  const gi = ensureActiveGroup(ob, me);
  if (me.vertex_groups[gi].lock_weight) {
    app.report('WARNING', `Active group "${me.vertex_groups[gi].name}" is locked`);
    return true;
  }
  const autoNormalize = !!ts.use_auto_normalize;
  const groups = autoNormalize ? deformGroups(ob, me) : [gi];
  if (autoNormalize && !groups.includes(gi)) groups.push(gi);
  const oldActive = me.weights[gi];
  beginGeometryStroke(s, me, () => {
    me.weights = me.weights.slice();
    for (const g of groups) cow(me.weights, g);
  });
  if (created) invalidatePaintAttributes();
  const W = me.weights;
  const locked = me.vertex_groups.map((g) => !!g.lock_weight);
  const orig = oldActive !== W[gi] ? oldActive : W[gi].slice();
  const strokeAlpha = new Float32Array(s.nv);
  const invert = e.ctrlKey || e.metaKey;
  const tool = e.shiftKey ? 'BLUR' : b.sculpt_tool;
  let mode = (b.blend ?? 'MIX') as BlendMode;
  if (invert) mode = mode === 'SUB' ? 'ADD' : 'SUB';
  const scratch = {};
  let lastHit: Vector3 | null = null;
  let lastEval = 0;
  const touched: number[] = [];
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
          normalAngle: NORMAL_ANGLE,
          sizeFactor: d.sizeFactor,
        },
        scratch,
      );
      if (!n) return;
      const w = W[gi];
      const weight = ts.unified_paint.weight;
      touched.length = 0;
      if (tool === 'DRAW') {
        for (let k = 0; k < n; k++) {
          const vi = s.gv[k];
          const f = s.gf[k] * strength;
          const sa = b.use_accumulate ? Math.min(1, strokeAlpha[vi] + f) : Math.max(strokeAlpha[vi], f);
          if (sa <= strokeAlpha[vi] && !b.use_accumulate) continue;
          strokeAlpha[vi] = sa;
          w[vi] = blendWeight(mode, orig[vi], weight, sa);
          touched.push(vi);
        }
      } else {
        const prev = new Float32Array(n);
        for (let k = 0; k < n; k++) prev[k] = w[s.gv[k]];
        let avg = 0;
        if (tool === 'AVERAGE') {
          let ws = 0;
          for (let k = 0; k < n; k++) {
            avg += prev[k] * s.gf[k];
            ws += s.gf[k];
          }
          avg /= ws || 1;
        }
        const nb = s.neighbors;
        const dir = hit && lastHit ? hit.point.clone().sub(lastHit) : null;
        const snapshot = tool === 'SMEAR' ? w.slice() : w;
        for (let k = 0; k < n; k++) {
          const vi = s.gv[k];
          const f = Math.min(1, s.gf[k] * strength);
          let target: number | null = null;
          if (tool === 'AVERAGE') target = avg;
          else if (tool === 'BLUR') {
            const a = nb.offsets[vi],
              e2 = nb.offsets[vi + 1];
            if (e2 === a) continue;
            let sum = 0;
            for (let j = a; j < e2; j++) sum += w[nb.neighbors[j]];
            target = sum / (e2 - a);
          } else if (dir && dir.lengthSq() > 0) {
            const u = smearSource(s, vi, dir.clone().normalize());
            if (u >= 0) target = snapshot[u];
          }
          if (target === null) continue;
          w[vi] = prev[k] + (target - prev[k]) * f;
          touched.push(vi);
        }
      }
      if (autoNormalize) for (const vi of touched) normalizeVertexWeights(W, groups, vi, gi, locked);
      writeCornerValues(s, 'paintWeight', w, touched, touched.length);
      if (hit) lastHit = hit.point.clone();
    },
    update: () => {
      weightBuffers(s).flush();
      // deformed meshes (armature modifier): show the new deformation while painting
      const now = performance.now();
      if (!s.direct && now - lastEval > 120) {
        lastEval = now;
        reevaluate(s);
      }
    },
    end: () => {
      app.pushUndo('Weight Paint');
      app.changed('doc');
    },
  });
  return true;
}

/** Interpolated active-group weight under the cursor (Shift X). */
export function sampleWeight(v: View3D, x: number, y: number): number | null {
  const am = activeMeshData();
  const s = meshSession();
  if (!am || !s) return null;
  const gi = am.ob.vertex_group_active_index ?? 0;
  const w = am.me.weights[gi];
  const hit = s.raycast(v, x, y);
  if (!w || !hit) return null;
  const bc = barycentric(s, hit.tri, hit.point);
  let out = 0;
  for (let i = 0; i < 3; i++) out += w[s.tris[hit.tri * 3 + i]] * bc[i];
  return Math.max(0, Math.min(1, out));
}

// ---------------------------------------------------------------------------
// operators

const wpPoll = () => app.doc.mode === 'WEIGHT_PAINT' && !!activeMeshData();
const groupPoll = () => !!activeMeshData() && activeMeshData()!.me.vertex_groups.length > 0 && (app.doc.mode === 'WEIGHT_PAINT' || app.doc.mode === 'OBJECT' || app.doc.mode === 'EDIT');

function editGroups(fn: (ob: ObjectData, me: MeshData, gi: number) => void) {
  const { ob, me } = activeMeshData()!;
  const gi = ensureActiveGroup(ob, me);
  me.weights = me.weights.slice();
  for (let g = 0; g < me.weights.length; g++) cow(me.weights, g);
  fn(ob, me, gi);
  invalidatePaintAttributes();
}

registerOperators([
  {
    idname: 'paint.weight_set',
    label: 'Set Weight',
    description: 'Fill the active vertex group with the current paint weight',
    poll: wpPoll,
    exec: () => {
      const wt = app.doc.scene.tool_settings.unified_paint.weight;
      editGroups((ob, me, gi) => {
        if (me.vertex_groups[gi].lock_weight) return;
        const allowed = paintFilter(me).verts;
        const w = me.weights[gi];
        for (let v = 0; v < w.length; v++) if (!allowed || allowed[v]) w[v] = wt;
        if (app.doc.scene.tool_settings.use_auto_normalize) {
          const groups = deformGroups(ob, me);
          const locked = me.vertex_groups.map((g) => !!g.lock_weight);
          for (let v = 0; v < me.weights[gi].length; v++) if (!allowed || allowed[v]) normalizeVertexWeights(me.weights, groups, v, gi, locked);
        }
      });
    },
  },
  {
    idname: 'object.vertex_group_normalize_all',
    label: 'Normalize All Vertex Groups',
    description: 'Normalize all weights of all vertex groups so the total weight per vertex is 1',
    props: [{ id: 'lock_active', label: 'Lock Active', type: 'bool', default: true }],
    poll: groupPoll,
    exec: (_ctx, p) =>
      editGroups((ob, me, gi) => {
        const groups = deformGroups(ob, me);
        const locked = me.vertex_groups.map((g) => !!g.lock_weight);
        for (let v = 0; v < me.positions.length / 3; v++) {
          if (p.lock_active) normalizeVertexWeights(me.weights, groups, v, gi, locked);
          else {
            // scale all unlocked groups so the total is 1
            let sum = 0;
            for (const g of groups) sum += me.weights[g][v];
            if (sum > 0) for (const g of groups) if (!locked[g]) me.weights[g][v] /= sum;
            normalizeAllWeights(me.weights, groups, v, locked);
          }
        }
      }),
  },
  {
    idname: 'object.vertex_group_normalize',
    label: 'Normalize Vertex Group',
    description: 'Scale the active group so its largest weight is 1',
    poll: groupPoll,
    exec: () =>
      editGroups((_ob, me, gi) => {
        const w = me.weights[gi];
        let max = 0;
        for (let i = 0; i < w.length; i++) max = Math.max(max, w[i]);
        if (max > 0) for (let i = 0; i < w.length; i++) w[i] /= max;
      }),
  },
  {
    idname: 'object.vertex_group_invert',
    label: 'Invert Vertex Group',
    poll: groupPoll,
    exec: () =>
      editGroups((_ob, me, gi) => {
        const w = me.weights[gi];
        for (let i = 0; i < w.length; i++) w[i] = 1 - w[i];
      }),
  },
  {
    idname: 'object.vertex_group_clean',
    label: 'Clean Vertex Group Weights',
    description: 'Remove weights below a limit from the active (or all) groups',
    props: [
      {
        id: 'limit',
        label: 'Limit',
        type: 'float',
        default: 0.01,
        min: 0,
        max: 1,
      },
      {
        id: 'group_select_mode',
        label: 'Subset',
        type: 'enum',
        default: 'ACTIVE',
        items: [
          ['ACTIVE', 'Active Group'],
          ['ALL', 'All Groups'],
        ],
      },
    ],
    poll: groupPoll,
    exec: (_ctx, p) =>
      editGroups((_ob, me, gi) => {
        const lim = p.limit as number;
        const gs = p.group_select_mode === 'ALL' ? me.weights.map((_, i) => i) : [gi];
        for (const g of gs) {
          if (me.vertex_groups[g].lock_weight) continue;
          const w = me.weights[g];
          for (let i = 0; i < w.length; i++) if (w[i] <= lim) w[i] = 0;
        }
      }),
  },
  {
    idname: 'object.vertex_group_smooth',
    label: 'Smooth Vertex Weights',
    props: [
      {
        id: 'factor',
        label: 'Factor',
        type: 'float',
        default: 0.5,
        min: 0,
        max: 1,
      },
      {
        id: 'repeat',
        label: 'Iterations',
        type: 'int',
        default: 1,
        min: 1,
        max: 200,
      },
    ],
    poll: groupPoll,
    exec: (_ctx, p) => {
      const s = meshSession();
      if (!s) return 'CANCELLED';
      editGroups((_ob, me, gi) => {
        const nb = s.neighbors;
        let w = me.weights[gi];
        for (let it = 0; it < (p.repeat as number); it++) {
          const next = w.slice();
          for (let v = 0; v < w.length; v++) {
            const a = nb.offsets[v],
              e = nb.offsets[v + 1];
            if (e === a) continue;
            let sum = 0;
            for (let j = a; j < e; j++) sum += w[nb.neighbors[j]];
            next[v] = w[v] + (sum / (e - a) - w[v]) * (p.factor as number);
          }
          w = next;
        }
        me.weights[gi].set(w);
      });
    },
  },
  {
    idname: 'object.vertex_group_limit_total',
    label: 'Limit Total Vertex Groups',
    description: 'Keep only the largest weights per vertex',
    props: [{ id: 'limit', label: 'Limit', type: 'int', default: 4, min: 1, max: 32 }],
    poll: groupPoll,
    exec: (_ctx, p) =>
      editGroups((_ob, me) => {
        const lim = p.limit as number;
        const nv = me.positions.length / 3;
        for (let v = 0; v < nv; v++) {
          const ws = me.weights.map((w, g) => [w[v], g] as [number, number]).filter((x) => x[0] > 0);
          if (ws.length <= lim) continue;
          ws.sort((a, b) => b[0] - a[0]);
          for (const [, g] of ws.slice(lim)) if (!me.vertex_groups[g].lock_weight) me.weights[g][v] = 0;
        }
      }),
  },
  {
    idname: 'paint.weight_from_bones',
    label: 'Assign Automatic from Bones',
    description: 'Compute weights from the bones of the armature deforming this mesh',
    poll: () => wpPoll() && !!armatureOf(app.activeObject!),
    exec: () => {
      const ob = app.activeObject!;
      const arm = armatureOf(ob)!;
      armatureWeightsFor(ob, arm, true);
      invalidatePaintAttributes();
    },
  },
]);

export function armatureOf(ob: ObjectData): ObjectData | null {
  for (const m of ob.modifiers) if (m.type === 'ARMATURE' && m.object && app.doc.objects[m.object as string]?.type === 'ARMATURE') return app.doc.objects[m.object as string];
  const p = ob.parent ? app.doc.objects[ob.parent] : undefined;
  return p?.type === 'ARMATURE' ? p : null;
}

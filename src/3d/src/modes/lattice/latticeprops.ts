// Lattice Object Data tab (resolution and interpolation per axis, Outside, influence vertex group,
// Vertex Groups list) and lattice vertex groups: the object.vertex_group_* operators get a lattice
// branch (add / remove / assign / remove from / select / deselect) plus lattice.select_ungrouped.
import { h, type Child } from '../../ui/h';
import { app, onAppReady, operators, registerOperator, registerOperators, type OpContext, type Operator } from '../../app/app';
import { panel, enumMenu, numberField, checkbox } from '../../ui/widgets';
import { num, splitRow } from '../../ui/props';
import { dataTabDrawers, dataBlockSelector } from '../../editors/properties/tabs';
import { uiList } from '../../editors/properties/uilist';
import type { LatticeData, LatticeInterpolation, ObjectData } from '../../data/types';

type LatticeSel = LatticeData & { select?: Uint8Array };

function activeLattice(): { ob: ObjectData; lt: LatticeSel } | null {
  const ob = app.activeObject;
  if (!ob || ob.type !== 'LATTICE' || !ob.data) return null;
  const lt = app.doc.lattices[ob.data] as LatticeSel | undefined;
  return lt ? { ob, lt } : null;
}
const inLatticeEdit = () => app.doc.mode === 'EDIT' && !!activeLattice();
const nPoints = (lt: LatticeData) => lt.points.length / 3;
const changed = (label: string) => {
  app.changed('doc', 'geometry');
  app.pushUndo(label);
};

const INTERP: { value: LatticeInterpolation; label: string }[] = [
  { value: 'KEY_LINEAR', label: 'Linear' },
  { value: 'KEY_CARDINAL', label: 'Cardinal' },
  { value: 'KEY_CATMULL_ROM', label: 'Catmull-Rom' },
  { value: 'KEY_BSPLINE', label: 'BSpline' },
];

/** Weights of a lattice group sized to the current points. */
function groupWeights(lt: LatticeData, gi: number): Float32Array {
  const n = nPoints(lt);
  const w = lt.weights?.[gi];
  if (w && w.length === n) return w;
  const out = new Float32Array(n);
  if (w) out.set(w.subarray(0, Math.min(n, w.length)));
  return out;
}

function latticeData(o: ObjectData): Child {
  const lt = o.data ? app.doc.lattices[o.data] : undefined;
  if (!lt) return h('div', { class: 'prop-note' }, 'No data');
  const resize = () => app.run('lattice.resize', {}, { invoke: false });
  const base = lt.interpolation ?? 'KEY_BSPLINE';
  const interp = (axis: 'u' | 'v' | 'w', label: string) => {
    const key = `interpolation_type_${axis}` as const;
    return splitRow(label, enumMenu(`lt-int-${axis}`, INTERP, lt[key] ?? base, (v) => ((lt[key] = v as LatticeInterpolation), changed('Lattice Interpolation'))));
  };
  const groups = lt.vertex_groups ?? [];
  const active = Math.min(lt.active_vertex_group_index ?? 0, Math.max(0, groups.length - 1));
  return [
    dataBlockSelector('lt', 'outliner_ob_lattice', Object.values(app.doc.lattices), lt.id, (id) => id && ((o.data = id), changed('Assign Lattice')), () => {}, { noUnlink: true }),
    panel('lt-groups', 'Vertex Groups', () => [
      uiList(
        'lt-vg',
        groups.map((g) => ({ key: g.name, label: g.name, icon: 'group_vertex' })),
        active,
        (i) => ((lt.active_vertex_group_index = i), app.changed('ui')),
        {
          add: () => app.run('object.vertex_group_add'),
          remove: () => app.run('object.vertex_group_remove'),
          rename: (i, name) => {
            name = name.trim();
            if (!name || groups.some((g, j) => j !== i && g.name === name)) return;
            if (lt.vertex_group === groups[i].name) lt.vertex_group = name;
            groups[i].name = name;
            changed('Rename Vertex Group');
          },
        },
      ),
      inLatticeEdit() && groups.length
        ? h('div', { class: 'btn-row' }, ...['object.vertex_group_assign', 'object.vertex_group_remove_from', 'object.vertex_group_select', 'object.vertex_group_deselect'].map((id, k) => h('button', { class: 'btn', onclick: () => app.run(id) }, ['Assign', 'Remove', 'Select', 'Deselect'][k])))
        : null,
      inLatticeEdit() && groups.length ? splitRow('Weight', numberField({ id: 'lt-vg-weight', value: app.doc.scene.tool_settings.vertex_group_weight ?? 1, min: 0, max: 1, slider: true, set: (x) => ((app.doc.scene.tool_settings.vertex_group_weight = x), app.changed('ui')) })) : null,
    ]),
    panel('lt', 'Lattice', () => [
      num(lt, 'points_u', 'Resolution U', { int: true, min: 1, max: 64, onChange: resize }),
      num(lt, 'points_v', 'V', { int: true, min: 1, max: 64, onChange: resize }),
      num(lt, 'points_w', 'W', { int: true, min: 1, max: 64, onChange: resize }),
      h('div', { class: 'ui-sep' }),
      interp('u', 'Interpolation U'),
      interp('v', 'V'),
      interp('w', 'W'),
      h('div', { class: 'ui-sep' }),
      splitRow('', checkbox('lt-outside', 'Outside', !!lt.use_outside, (v) => ((lt.use_outside = v), changed('Lattice Outside')), { tip: 'Only the outer points deform; the inner ones follow them' })),
      splitRow('Vertex Group', enumMenu('lt-vgroup', [{ value: '', label: '—' }, ...groups.map((g) => ({ value: g.name, label: g.name }))], lt.vertex_group ?? '', (v) => ((lt.vertex_group = v || undefined), changed('Lattice Vertex Group')))),
    ]),
  ];
}

dataTabDrawers.LATTICE = latticeData;

// ---------------------------------------------------------------------------
// lattice branches of the vertex group operators

interface Branch {
  poll: (ctx: OpContext) => boolean;
  exec: (ctx: OpContext, p: Record<string, unknown>) => ReturnType<NonNullable<Operator['exec']>>;
}
const branches: Record<string, Branch> = {
  'object.vertex_group_add': {
    poll: () => true,
    exec: () => {
      const { lt } = activeLattice()!;
      const groups = (lt.vertex_groups ??= []);
      let name = 'Group',
        i = 0;
      while (groups.some((g) => g.name === name)) name = `Group.${String(++i).padStart(3, '0')}`;
      lt.vertex_groups = [...groups, { name }];
      lt.weights = [...(lt.weights ?? []), new Float32Array(nPoints(lt))];
      lt.active_vertex_group_index = lt.vertex_groups.length - 1;
    },
  },
  'object.vertex_group_remove': {
    poll: () => (activeLattice()!.lt.vertex_groups?.length ?? 0) > 0,
    exec: (_c, p) => {
      const { lt } = activeLattice()!;
      if (p.all || p.all_unlocked) {
        lt.vertex_groups = [];
        lt.weights = [];
        lt.vertex_group = undefined;
        lt.active_vertex_group_index = 0;
        return;
      }
      const i = lt.active_vertex_group_index ?? 0;
      if (lt.vertex_group === lt.vertex_groups![i]?.name) lt.vertex_group = undefined;
      lt.vertex_groups = lt.vertex_groups!.filter((_, j) => j !== i);
      lt.weights = (lt.weights ?? []).filter((_, j) => j !== i);
      lt.active_vertex_group_index = Math.max(0, i - 1);
    },
  },
  'object.vertex_group_assign': {
    poll: () => inLatticeEdit() && (activeLattice()!.lt.vertex_groups?.length ?? 0) > 0,
    exec: (ctx) => {
      const { lt } = activeLattice()!;
      const gi = lt.active_vertex_group_index ?? 0;
      const w = groupWeights(lt, gi).slice();
      const wt = ctx.doc.scene.tool_settings.vertex_group_weight ?? 1;
      lt.select?.forEach((s, i) => s && (w[i] = wt));
      lt.weights = (lt.weights ?? []).map((x, j) => (j === gi ? w : x));
      while (lt.weights.length < lt.vertex_groups!.length) lt.weights.push(new Float32Array(nPoints(lt)));
      lt.weights[gi] = w;
    },
  },
  'object.vertex_group_remove_from': {
    poll: () => (activeLattice()!.lt.vertex_groups?.length ?? 0) > 0,
    exec: (_c, p) => {
      const { lt } = activeLattice()!;
      const all = !!p.use_all_verts || app.doc.mode !== 'EDIT';
      const groups = p.use_all_groups ? (lt.vertex_groups ?? []).map((_, i) => i) : [lt.active_vertex_group_index ?? 0];
      lt.weights = (lt.vertex_groups ?? []).map((_, gi) => {
        const w = groupWeights(lt, gi);
        if (!groups.includes(gi)) return w;
        const out = w.slice();
        for (let i = 0; i < out.length; i++) if (all || lt.select?.[i]) out[i] = 0;
        return out;
      });
    },
  },
  'object.vertex_group_select': {
    poll: () => inLatticeEdit() && (activeLattice()!.lt.vertex_groups?.length ?? 0) > 0,
    exec: () => {
      const { lt } = activeLattice()!;
      const w = groupWeights(lt, lt.active_vertex_group_index ?? 0);
      const s = new Uint8Array(lt.select && lt.select.length === w.length ? lt.select : new Uint8Array(w.length));
      w.forEach((x, i) => x > 0 && (s[i] = 1));
      lt.select = s;
    },
  },
  'object.vertex_group_deselect': {
    poll: () => inLatticeEdit() && (activeLattice()!.lt.vertex_groups?.length ?? 0) > 0,
    exec: () => {
      const { lt } = activeLattice()!;
      const w = groupWeights(lt, lt.active_vertex_group_index ?? 0);
      const s = new Uint8Array(lt.select && lt.select.length === w.length ? lt.select : new Uint8Array(w.length));
      w.forEach((x, i) => x > 0 && (s[i] = 0));
      lt.select = s;
    },
  },
};

onAppReady(() => {
  for (const [id, b] of Object.entries(branches)) {
    const base = operators.get(id);
    if (!base) continue;
    registerOperator({
      ...base,
      poll: (ctx) => (activeLattice() ? b.poll(ctx) : base.poll ? base.poll(ctx) : true),
      exec: (ctx, p) => (activeLattice() ? b.exec(ctx, p) : base.exec ? base.exec(ctx, p) : 'CANCELLED'),
    });
  }
});

registerOperators([
  {
    idname: 'lattice.select_ungrouped',
    label: 'Select Ungrouped',
    description: 'Select the points that belong to no vertex group',
    props: [{ id: 'extend', label: 'Extend', type: 'bool', default: false }],
    poll: () => inLatticeEdit() && (activeLattice()!.lt.vertex_groups?.length ?? 0) > 0,
    exec: (_c, p) => {
      const { lt } = activeLattice()!;
      const n = nPoints(lt);
      const s = p.extend && lt.select?.length === n ? lt.select.slice() : new Uint8Array(n);
      const groups = (lt.vertex_groups ?? []).map((_, gi) => groupWeights(lt, gi));
      for (let i = 0; i < n; i++) if (!groups.some((w) => w[i] > 0)) s[i] = 1;
      lt.select = s;
      app.changed('select', 'doc');
    },
  },
]);

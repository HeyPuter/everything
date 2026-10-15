// Smaller animation operators: driver copy/paste (property menu and Drivers editor),
// delete invalid drivers, select keys by type, change frame, clear unused actions,
// delete keyframes with a keying set, view a property's curve in the Graph Editor,
// jump between keys of the active curve and unlink the NLA action line.
import { app, registerOperators, type OpContext, type Operator } from '../app/app';
import type { Driver, DriverVariable, ObjectData } from '../data/types';
import { AnimEditor } from './animeditor';
import { DriversEditor, driverError, addDriver } from './driverseditor';
import { GraphEditor, curveId } from './graph';
import { KEY_TYPES } from './footer';
import { setKeySelected } from './keyedit';
import { activeAction, setExpanded } from './channels';
import { rotationPath } from '../anim/keyframes';
import { BUILTIN_KEYING_SETS, propertyAnimExtraItems } from '../anim/keyingsets';
import { shell } from '../ui/shell';

let driverClipboard: Driver | null = null;
/** Put a driver on the driver clipboard (Copy As New Driver). */
export function setDriverClipboard(d: Driver) {
  driverClipboard = structuredClone(d);
}
export const hasDriverClipboard = () => !!driverClipboard;
let variablesClipboard: DriverVariable[] | null = null;

const targetProps = [
  { id: 'object', label: 'Object', type: 'string' as const, default: '', hidden: true },
  { id: 'data_path', label: 'Data Path', type: 'string' as const, default: '', hidden: true },
  { id: 'index', label: 'Index', type: 'int' as const, default: -1, hidden: true },
];
const targetOb = (p: Record<string, unknown>): ObjectData | null => (p.object ? (app.doc.objects[p.object as string] ?? null) : app.activeObject);

function driversEd(ctx: OpContext): DriversEditor | null {
  const ed = ctx.area?.editor;
  return ed instanceof DriversEditor ? ed : null;
}
/** Driver named by object/data_path/index props, else the active driver of the Drivers editor. */
function driverFor(ctx: OpContext, p: Record<string, unknown>): Driver | null {
  if (p.data_path) {
    const ob = targetOb(p);
    return ob?.animation_data?.drivers.find((x) => x.data_path === p.data_path && ((p.index as number) < 0 || x.array_index === p.index)) ?? null;
  }
  return driversEd(ctx)?.active()?.d ?? null;
}
function animEd(ctx: OpContext): AnimEditor | null {
  const ed = ctx.area?.editor;
  return ed instanceof AnimEditor ? ed : null;
}

const ops: Operator[] = [
  // ---- drivers
  {
    idname: 'anim.copy_driver_button',
    label: 'Copy Driver',
    description: 'Copy the driver of the property',
    props: targetProps,
    undo: false,
    exec: (_ctx, p) => {
      const ob = targetOb(p);
      const d = ob?.animation_data?.drivers.find((x) => x.data_path === p.data_path && ((p.index as number) < 0 || x.array_index === p.index));
      if (!d) return 'CANCELLED';
      driverClipboard = structuredClone(d);
    },
  },
  {
    idname: 'anim.paste_driver_button',
    label: 'Paste Driver',
    description: 'Give the property a copy of the copied driver',
    props: targetProps,
    poll: () => !!driverClipboard,
    exec: (ctx, p) => {
      const ob = targetOb(p);
      if (!ob || !p.data_path) return 'CANCELLED';
      const made = addDriver(ctx.doc, ob, p.data_path as string, p.index as number);
      for (const d of made) {
        Object.assign(d, structuredClone({ ...driverClipboard!, data_path: d.data_path, array_index: d.array_index }));
        if (d.fcurve) Object.assign(d.fcurve, { data_path: d.data_path, array_index: d.array_index });
      }
      if (!made.length) return 'CANCELLED';
    },
  },
  {
    idname: 'graph.driver_variables_copy',
    label: 'Copy Driver Variables',
    description: 'Copy the variables of the active driver',
    props: targetProps,
    undo: false,
    poll: (ctx) => !!driverFor(ctx, {})?.variables.length,
    exec: (ctx, p) => {
      const d = driverFor(ctx, p);
      if (!d?.variables.length) return 'CANCELLED';
      variablesClipboard = structuredClone(d.variables);
      app.report('INFO', `Copied ${d.variables.length} driver variable${d.variables.length === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'graph.driver_variables_paste',
    label: 'Paste Driver Variables',
    description: 'Add the copied variables to the active driver',
    props: [...targetProps, { id: 'replace', label: 'Replace Existing', type: 'bool', default: false }],
    poll: (ctx) => !!variablesClipboard && !!driverFor(ctx, {}),
    exec: (ctx, p) => {
      const d = driverFor(ctx, p);
      if (!d || !variablesClipboard) return 'CANCELLED';
      const vars = structuredClone(variablesClipboard);
      if (p.replace) d.variables = vars;
      else for (const v of vars) if (!d.variables.some((o) => o.name === v.name)) d.variables.push(v);
    },
  },
  {
    idname: 'graph.driver_delete_invalid',
    label: 'Delete Invalid Drivers',
    description: 'Delete the drivers that have errors',
    poll: (ctx) => !!driversEd(ctx),
    exec: (ctx) => {
      let n = 0;
      for (const ob of Object.values(ctx.doc.objects)) {
        const ad = ob.animation_data;
        if (!ad?.drivers.length) continue;
        const before = ad.drivers.length;
        ad.drivers = ad.drivers.filter((d) => !driverError(ctx.doc, ob, d));
        n += before - ad.drivers.length;
      }
      app.report('INFO', n ? `Deleted ${n} invalid driver${n === 1 ? '' : 's'}` : 'No invalid drivers found');
      if (!n) return 'CANCELLED';
    },
  },
  // ---- keys
  {
    idname: 'action.select_by_type',
    label: 'Select By Type',
    description: 'Select all keyframes of one keyframe type',
    props: [
      { id: 'type', label: 'Type', type: 'enum', default: 'KEYFRAME', items: KEY_TYPES },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
    ],
    poll: (ctx) => !!animEd(ctx) && (animEd(ctx) as unknown as { prefix?: string }).prefix === 'action',
    exec: (ctx, p) => {
      const curves = animEd(ctx)!.list.curves;
      for (const { fc } of curves)
        for (const k of fc.keyframe_points) {
          if (k.type === p.type) setKeySelected(k, true);
          else if (!p.extend) setKeySelected(k, false);
        }
    },
  },
  {
    idname: 'graph.keyframe_jump',
    label: 'Jump to Keyframe',
    description: 'Jump to the previous or next key of the active F-Curve',
    props: [{ id: 'next', label: 'Next', type: 'bool', default: true }],
    undo: false,
    poll: (ctx) => ctx.area?.editor instanceof GraphEditor && !!(ctx.area.editor as GraphEditor).activeCurve(),
    exec: (ctx, p) => {
      const ed = ctx.area!.editor as GraphEditor;
      const fc = ed.activeCurve()!.fc;
      const f = ctx.doc.scene.frame_current;
      const frames = fc.keyframe_points.map((k) => k.co[0]);
      const t = p.next ? frames.find((x) => x > f + 1e-4) : [...frames].reverse().find((x) => x < f - 1e-4);
      if (t === undefined) return 'CANCELLED';
      app.setFrame(Math.round(t));
      const k = fc.keyframe_points.find((x) => x.co[0] === t);
      if (k) ed.cursorValue = ed.toDisp(fc, k.co[1]);
      ed.draw();
    },
  },
  {
    idname: 'anim.change_frame',
    label: 'Change Frame',
    description: 'Set the current frame',
    props: [{ id: 'frame', label: 'Frame', type: 'float', default: 0 }],
    undo: false,
    internal: true,
    exec: (_ctx, p) => app.setFrame(Math.round(p.frame as number)),
  },
  {
    idname: 'anim.clear_useless_actions',
    label: 'Clear Useless Actions',
    description: 'Remove actions that nothing uses and that are not kept with a fake user',
    props: [{ id: 'only_unused', label: 'Only Unused', type: 'bool', default: true }],
    exec: (ctx) => {
      const used = new Set<string>();
      for (const ob of Object.values(ctx.doc.objects)) {
        const ad = ob.animation_data;
        if (!ad) continue;
        if (ad.action) used.add(ad.action);
        if (ad.tweak?.prev_action) used.add(ad.tweak.prev_action);
        const visit = (strips: { action: string; strips?: unknown[] }[]) => {
          for (const s of strips) {
            if (s.action) used.add(s.action);
            if (s.strips) visit(s.strips as never);
          }
        };
        for (const t of ad.nla_tracks) visit(t.strips);
      }
      let n = 0;
      for (const [id, a] of Object.entries(ctx.doc.actions))
        if (!used.has(id) && !a.use_fake_user) {
          delete ctx.doc.actions[id];
          n++;
        }
      app.report('INFO', `Removed ${n} empty and/or fake-user-only Actions`);
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'anim.keyframe_delete',
    label: 'Delete Keying-Set Keyframe',
    description: 'Delete the keys on the current frame of the properties in the active keying set',
    exec: (ctx) => {
      const ks = ctx.doc.scene.keying_set ?? 'LocRotScale';
      return deleteWithSet(ctx, ks);
    },
  },
  {
    idname: 'anim.keyframe_delete_by_name',
    label: 'Delete Keying-Set Keyframe (by name)',
    description: 'Delete the keys on the current frame of the properties in a keying set',
    props: [{ id: 'type', label: 'Keying Set', type: 'enum', default: 'LocRotScale', items: BUILTIN_KEYING_SETS }],
    exec: (ctx, p) => deleteWithSet(ctx, p.type as string),
  },
  {
    idname: 'anim.view_curve_in_graph_editor',
    label: 'View In Graph Editor',
    description: 'Show the property’s F-Curve in a Graph Editor (turning the largest animation editor into one if needed)',
    props: [...targetProps, { id: 'isolate', label: 'Isolate', type: 'bool', default: false }],
    undo: false,
    exec: (ctx, p) => {
      const ob = targetOb(p);
      const act = ob ? activeAction(ctx.doc, ob) : undefined;
      const fcs = act?.fcurves.filter((f) => f.data_path === p.data_path && ((p.index as number) < 0 || f.array_index === p.index)) ?? [];
      if (!ob || !act || !fcs.length) {
        app.report('WARNING', 'The property is not animated');
        return 'CANCELLED';
      }
      const areas = shell.screen.areas;
      const area = areas.find((a) => a.type === 'GRAPH') ?? areas.find((a) => a.type === 'DOPESHEET' || a.type === 'TIMELINE' || a.type === 'NLA');
      if (!area) {
        app.report('WARNING', 'Open a Graph Editor (or Dope Sheet) to view the curve in');
        return 'CANCELLED';
      }
      if (area.type !== 'GRAPH') area.setType('GRAPH');
      const ed = area.editor as GraphEditor;
      for (const f of act.fcurves) {
        f.select = fcs.includes(f);
        if (p.isolate) f.hide = !fcs.includes(f);
      }
      setExpanded(`ob:${ob.id}`, true);
      setExpanded(`act:${ob.id}:${act.id}`, true);
      for (const f of fcs) if (f.group) setExpanded(`grp:${act.id}:${f.group}`, true);
      ed.activeKey = curveId({ ob, action: act, fc: fcs[0] });
      ed.refresh();
      ed.fitBounds({ x0: Math.min(...fcs.flatMap((f) => f.keyframe_points.map((k) => k.co[0]))), x1: Math.max(...fcs.flatMap((f) => f.keyframe_points.map((k) => k.co[0]))), y0: 0, y1: 0 }, ed.list.curves.filter((r) => fcs.includes(r.fc)));
    },
  },
  {
    idname: 'action.markers_make_local',
    label: 'Make Markers Local',
    description: 'Move the selected scene markers into the active action as pose markers',
    poll: (ctx) => {
      const ed = ctx.area?.editor as unknown as { mode?: string } | undefined;
      return ed?.mode === 'ACTION' && !!app.activeObject?.animation_data?.action && ctx.doc.scene.timeline_markers.some((m) => m.select);
    },
    exec: (ctx) => {
      const act = ctx.doc.actions[app.activeObject!.animation_data!.action!];
      const sel = ctx.doc.scene.timeline_markers.filter((m) => m.select);
      (act.pose_markers ??= []).push(...sel.map((m) => ({ name: m.name, frame: m.frame, select: true })));
      ctx.doc.scene.timeline_markers = ctx.doc.scene.timeline_markers.filter((m) => !m.select);
      const ed = ctx.area?.editor as unknown as { showPoseMarkers?: boolean; refresh?: () => void };
      if (ed) ed.showPoseMarkers = true;
    },
  },
  {
    idname: 'nla.action_unlink',
    label: 'Unlink Action',
    description: 'Clear the action assigned to the NLA action line',
    props: [{ id: 'force_delete', label: 'Force Delete', type: 'bool', default: false }],
    poll: () => !!app.activeObject?.animation_data?.action && !app.activeObject.animation_data.tweak,
    exec: (ctx, p) => {
      const ad = app.activeObject!.animation_data!;
      const id = ad.action!;
      ad.action = null;
      if (p.force_delete) {
        const a = ctx.doc.actions[id];
        if (a) a.use_fake_user = false;
      }
    },
  },
];

function deleteWithSet(ctx: OpContext, ks: string) {
  const f = ctx.doc.scene.frame_current;
  let n = 0;
  if (ks.startsWith('KS:')) {
    const set = ctx.doc.scene.keying_sets?.find((k) => k.name === ks.slice(3));
    for (const pth of set?.paths ?? []) {
      const ob = pth.id ? ctx.doc.objects[pth.id] : undefined;
      const act = ob ? activeAction(ctx.doc, ob) : undefined;
      for (const fc of act?.fcurves ?? []) {
        if (fc.data_path !== pth.data_path || (pth.index >= 0 && fc.array_index !== pth.index)) continue;
        const before = fc.keyframe_points.length;
        fc.keyframe_points = fc.keyframe_points.filter((k) => Math.abs(k.co[0] - f) > 0.5);
        n += before - fc.keyframe_points.length;
      }
    }
  } else {
    const obs = app.selectedObjects();
    const paths = (ob: ObjectData) => [...(ks.includes('Loc') || ks === 'Location' || ks === 'WholeCharacter' || ks === 'Available' ? ['location'] : []), ...(ks.includes('Rot') || ks === 'Rotation' || ks === 'WholeCharacter' || ks === 'Available' ? [rotationPath(ob)] : []), ...(ks.includes('Scale') || ks === 'WholeCharacter' || ks === 'Available' ? ['scale'] : [])];
    for (const ob of obs) {
      const act = activeAction(ctx.doc, ob);
      const want = new Set(paths(ob));
      for (const fc of act?.fcurves ?? []) {
        const tail = fc.data_path.split('.').pop()!;
        if (!want.has(tail) && ks !== 'Available') continue;
        const before = fc.keyframe_points.length;
        fc.keyframe_points = fc.keyframe_points.filter((k) => Math.abs(k.co[0] - f) > 0.5);
        n += before - fc.keyframe_points.length;
      }
    }
  }
  if (!n) {
    app.report('WARNING', 'No keyframes removed');
    return 'CANCELLED' as const;
  }
  return 'FINISHED' as const;
}

registerOperators(ops);

// property animation menu: driver copy/paste and view in Graph Editor
propertyAnimExtraItems.push((ob, path, index) => {
  const t = { object: ob.id, data_path: path, index };
  const driven = !!ob.animation_data?.drivers.some((d) => d.data_path === path && (index < 0 || d.array_index === index));
  const animated = !!activeAction(app.doc, ob)?.fcurves.some((f) => f.data_path === path && (index < 0 || f.array_index === index));
  return [
    ...(driven ? [{ label: 'Copy Driver', op: 'anim.copy_driver_button', props: t }] : []),
    { label: 'Paste Driver', op: 'anim.paste_driver_button', props: t },
    ...(animated ? [{ separator: true }, { label: 'View in Graph Editor', op: 'anim.view_curve_in_graph_editor', props: { ...t, isolate: false } }] : []),
  ];
});

// Motion paths: sample the evaluated world position of objects (or of pose bone heads/tails)
// over a frame range and draw the paths in the 3D viewport (Object properties ▸ Motion Paths,
// Object / Pose ▸ Motion Paths menu operators).
import { Vector3 } from 'three';
import { app, registerOperators } from '../app/app';
import type { ObjectData } from '../data/types';
import { objectExtraPanels } from '../editors/properties/tabs';
import { editModeHooks } from '../editors/view3d/hooks';
import { h, type VNode } from '../ui/h';
import { panel, opButton } from '../ui/widgets';
import { num, bool, enumProp } from '../ui/props';
import { keyframeFrames } from './keyframes';

export interface MotionPathSettings {
  type: 'RANGE' | 'CURRENT_FRAME';
  frame_start: number;
  frame_end: number;
  frame_before: number;
  frame_after: number;
  frame_step: number;
  show_frame_numbers: boolean;
  show_keyframe_highlight: boolean;
  /** bone paths follow the bone heads or tails */
  bake_location?: 'HEADS' | 'TAILS';
}

export interface MotionPath {
  frame_start: number;
  points: number[]; // world xyz per frame
  step: number;
}

type ObMP = ObjectData & { animation_visualization?: MotionPathSettings; motion_path?: MotionPath | null; bone_paths?: Record<string, MotionPath> | null };

function settings(o: ObMP): MotionPathSettings {
  return (o.animation_visualization ??= {
    type: 'RANGE',
    frame_start: app.doc.scene.frame_start,
    frame_end: app.doc.scene.frame_end,
    frame_before: 10,
    frame_after: 10,
    frame_step: 1,
    show_frame_numbers: false,
    show_keyframe_highlight: true,
  });
}

function rangeOf(o: ObMP): [number, number] {
  const st = settings(o);
  if (st.type === 'CURRENT_FRAME') {
    const f = app.doc.scene.frame_current;
    return [f - st.frame_before, f + st.frame_after];
  }
  return [st.frame_start, Math.max(st.frame_start, st.frame_end)];
}

interface PathTarget {
  range: [number, number];
  step: number;
  /** world position at the current evaluation, or null */
  sample(p: Vector3): boolean;
  store(path: MotionPath): void;
}

/** Sample several paths in one pass over the frames. */
function calculate(targets: PathTarget[]) {
  if (!targets.length) return;
  const saved = app.doc.scene.frame_current;
  const lo = Math.min(...targets.map((t) => t.range[0])),
    hi = Math.max(...targets.map((t) => t.range[1]));
  const paths = targets.map((t) => ({ frame_start: t.range[0], points: [] as number[], step: Math.max(1, t.step) }));
  const p = new Vector3();
  for (let f = lo; f <= hi; f++) {
    app.setFrame(f);
    app.flush();
    targets.forEach((t, i) => {
      const [a, b] = t.range;
      if (f < a || f > b || (f - a) % paths[i].step) return;
      if (t.sample(p)) paths[i].points.push(p.x, p.y, p.z);
    });
  }
  app.setFrame(saved);
  targets.forEach((t, i) => t.store(paths[i]));
}

function objectTarget(o: ObMP): PathTarget {
  return {
    range: rangeOf(o),
    step: settings(o).frame_step,
    sample: (p) => {
      const ev = app.graph.get(o.id);
      if (!ev) return false;
      p.setFromMatrixPosition(ev.world);
      return true;
    },
    store: (path) => (o.motion_path = path),
  };
}

function boneTarget(o: ObMP, bone: string): PathTarget {
  const st = settings(o);
  return {
    range: rangeOf(o),
    step: st.frame_step,
    sample: (p) => {
      const ev = app.graph.get(o.id);
      const b = ev?.pose?.bones.get(bone);
      if (!ev || !b) return false;
      p.set(0, st.bake_location === 'TAILS' ? b.length : 0, 0).applyMatrix4(b.pose).applyMatrix4(ev.world);
      return true;
    },
    store: (path) => ((o.bone_paths ??= {})[bone] = path),
  };
}

function poseArmature(): ObMP | null {
  const o = app.activeObject as ObMP | null;
  return app.doc.mode === 'POSE' && o?.type === 'ARMATURE' && o.pose ? o : null;
}
const selectedBoneNames = (o: ObMP) => Object.entries(o.pose ?? {}).filter(([, pb]) => pb.select).map(([n]) => n);

/** Frame range of an object's keys (all, or only selected keys). */
function keyRange(o: ObMP, selectedOnly: boolean): [number, number] | null {
  const act = o.animation_data?.action ? app.doc.actions[o.animation_data.action] : undefined;
  let a = Infinity,
    b = -Infinity;
  for (const fc of act?.fcurves ?? [])
    for (const k of fc.keyframe_points)
      if (!selectedOnly || k.select_control_point) {
        a = Math.min(a, k.co[0]);
        b = Math.max(b, k.co[0]);
      }
  return a === Infinity ? null : [Math.floor(a), Math.ceil(b)];
}

const rangeProps = [
  {
    id: 'display_type',
    label: 'Display Type',
    type: 'enum' as const,
    default: 'RANGE',
    items: [
      ['CURRENT_FRAME', 'Around Frame', 'Show a path around the current frame'],
      ['RANGE', 'In Range', 'Show the path over a frame range'],
    ] as [string, string, string][],
  },
  {
    id: 'range',
    label: 'Computation Range',
    type: 'enum' as const,
    default: 'SCENE',
    items: [
      ['KEYS_ALL', 'All Keys', 'From the first to the last keyframe'],
      ['KEYS_SELECTED', 'Selected Keys', 'From the first to the last selected keyframe'],
      ['SCENE', 'Scene Frame Range', 'The scene (or preview) frame range'],
      ['MANUAL', 'Manual Frame Range', 'The range set in the Motion Paths panel'],
    ] as [string, string, string][],
  },
];

/** Apply the calculate operator's range options to an object's path settings. */
function applyRangeProps(o: ObMP, p: Record<string, unknown>) {
  const st = settings(o);
  st.type = p.display_type as 'RANGE';
  const s = app.doc.scene;
  if (p.range === 'SCENE') {
    st.frame_start = s.use_preview_range ? s.frame_preview_start ?? s.frame_start : s.frame_start;
    st.frame_end = s.use_preview_range ? s.frame_preview_end ?? s.frame_end : s.frame_end;
  } else if (p.range === 'KEYS_ALL' || p.range === 'KEYS_SELECTED') {
    const r = keyRange(o, p.range === 'KEYS_SELECTED');
    if (r) [st.frame_start, st.frame_end] = r;
  }
  if (p.bake_location) st.bake_location = p.bake_location as 'HEADS';
}

registerOperators([
  {
    idname: 'object.paths_calculate',
    label: 'Calculate Object Motion Paths',
    description: 'Generate motion paths for the selected objects',
    props: [...rangeProps.map((r) => (r.id === 'range' ? { ...r, default: 'MANUAL' } : r))],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: (_ctx, p) => {
      const obs = app.selectedObjects() as ObMP[];
      for (const o of obs) applyRangeProps(o, p);
      calculate(obs.map(objectTarget));
    },
  },
  {
    idname: 'object.paths_update',
    label: 'Update Object Paths',
    description: 'Recalculate motion paths for the selected objects that have them',
    poll: () => app.selectedObjects().some((o) => (o as ObMP).motion_path),
    exec: () => calculate((app.selectedObjects().filter((o) => (o as ObMP).motion_path) as ObMP[]).map(objectTarget)),
  },
  {
    idname: 'object.paths_clear',
    label: 'Clear Object Paths',
    description: 'Remove motion paths of the selected objects (or all objects)',
    props: [{ id: 'only_selected', label: 'Only Selected', type: 'bool', default: true }],
    poll: () => Object.values(app.doc.objects).some((o) => (o as ObMP).motion_path),
    exec: (ctx, p) => {
      for (const o of Object.values(ctx.doc.objects) as ObMP[]) if (!p.only_selected || o.select) o.motion_path = null;
    },
  },
  {
    idname: 'object.paths_update_visible',
    label: 'Update All Motion Paths',
    description: 'Recalculate the motion paths of every visible object and bone',
    poll: () => Object.values(app.doc.objects).some((o) => (o as ObMP).motion_path || Object.keys((o as ObMP).bone_paths ?? {}).length),
    exec: () => {
      const targets: PathTarget[] = [];
      for (const o of Object.values(app.doc.objects) as ObMP[]) {
        if (!app.isVisible(o.id)) continue;
        if (o.motion_path) targets.push(objectTarget(o));
        for (const b of Object.keys(o.bone_paths ?? {})) targets.push(boneTarget(o, b));
      }
      calculate(targets);
    },
  },
  {
    idname: 'pose.paths_calculate',
    label: 'Calculate Bone Paths',
    description: 'Generate motion paths for the selected bones',
    props: [
      ...rangeProps,
      {
        id: 'bake_location',
        label: 'Bake Location',
        type: 'enum',
        default: 'HEADS',
        items: [
          ['HEADS', 'Heads', 'Follow the bone heads'],
          ['TAILS', 'Tails', 'Follow the bone tails'],
        ],
      },
    ],
    poll: () => !!poseArmature() && selectedBoneNames(poseArmature()!).length > 0,
    exec: (_ctx, p) => {
      const o = poseArmature()!;
      applyRangeProps(o, p);
      calculate(selectedBoneNames(o).map((b) => boneTarget(o, b)));
    },
  },
  {
    idname: 'pose.paths_update',
    label: 'Update Bone Paths',
    description: 'Recalculate the paths of the bones that have them',
    poll: () => !!poseArmature() && Object.keys(poseArmature()!.bone_paths ?? {}).length > 0,
    exec: () => {
      const o = poseArmature()!;
      calculate(Object.keys(o.bone_paths ?? {}).map((b) => boneTarget(o, b)));
    },
  },
  {
    idname: 'pose.paths_clear',
    label: 'Clear Bone Paths',
    description: 'Remove the motion paths of the selected bones (or all bones)',
    props: [{ id: 'only_selected', label: 'Only Selected', type: 'bool', default: false }],
    poll: () => !!poseArmature() && Object.keys(poseArmature()!.bone_paths ?? {}).length > 0,
    exec: (_ctx, p) => {
      const o = poseArmature()!;
      if (!p.only_selected) o.bone_paths = null;
      else for (const b of selectedBoneNames(o)) delete o.bone_paths?.[b];
    },
  },
  {
    idname: 'pose.paths_range_update',
    label: 'Update Range from Scene',
    description: 'Set the path frame range to the scene (or preview) range',
    poll: () => !!poseArmature(),
    exec: () => applyRangeProps(poseArmature()!, { display_type: 'RANGE', range: 'SCENE' }),
  },
]);

objectExtraPanels.push((o) => {
  const ob = o as ObMP;
  const st = settings(ob);
  const bones = app.doc.mode === 'POSE' && ob.type === 'ARMATURE' && ob === app.activeObject;
  const hasBonePaths = Object.keys(ob.bone_paths ?? {}).length > 0;
  return panel(
    'ob-motionpaths',
    'Motion Paths',
    () => [
      enumProp(st, 'type', 'Type', [
        ['CURRENT_FRAME', 'Around Frame'],
        ['RANGE', 'In Range'],
      ]),
      st.type === 'RANGE' ? [num(st, 'frame_start', 'Frame Range Start', { int: true }), num(st, 'frame_end', 'End', { int: true })] : [num(st, 'frame_before', 'Frame Range Before', { int: true, min: 0 }), num(st, 'frame_after', 'After', { int: true, min: 0 })],
      num(st, 'frame_step', 'Step', { int: true, min: 1, max: 100 }),
      bones
        ? [
            enumProp(st as never, 'bake_location' as never, 'Cache Bone Paths From', [
              ['HEADS', 'Heads'],
              ['TAILS', 'Tails'],
            ]),
            hasBonePaths
              ? h('div', { class: 'prop-buttons' }, opButton('pose.paths_update', 'Update Paths', {}, { icon: 'file_refresh' }), opButton('pose.paths_clear', '', { only_selected: false }, { icon: 'x', tip: 'Clear Paths' }))
              : h('div', { class: 'prop-buttons' }, opButton('pose.paths_calculate', 'Calculate…', { display_type: st.type, range: 'MANUAL', bake_location: st.bake_location ?? 'HEADS' }, { icon: 'curve_data' })),
          ]
        : ob.motion_path
          ? h('div', { class: 'prop-buttons' }, opButton('object.paths_update', 'Update Paths', {}, { icon: 'file_refresh' }), opButton('object.paths_clear', '', { only_selected: true }, { icon: 'x', tip: 'Clear Paths' }))
          : h('div', { class: 'prop-buttons' }, opButton('object.paths_calculate', 'Calculate…', { display_type: st.type }, { icon: 'curve_data' })),
      bool(st, 'show_frame_numbers', 'Frame Numbers'),
      bool(st, 'show_keyframe_highlight', 'Keyframes'),
    ],
    { closed: true },
  );
});

// viewport drawing
function drawPath(v: Parameters<(typeof editModeHooks.svg)[number]>[0], mp: MotionPath, st: MotionPathSettings, keys: Map<number, boolean> | null, parts: VNode[]) {
  const cur = app.doc.scene.frame_current;
  const pts: { x: number; y: number; f: number }[] = [];
  for (let i = 0; i < mp.points.length / 3; i++) {
    const s = v.project(new Vector3(mp.points[i * 3], mp.points[i * 3 + 1], mp.points[i * 3 + 2]));
    if (s.z > 1) continue;
    pts.push({ x: s.x, y: s.y, f: mp.frame_start + i * mp.step });
  }
  if (pts.length < 2) return;
  // path line: frames before the current frame are drawn darker than those after it
  for (let i = 0; i + 1 < pts.length; i++) {
    const after = pts[i].f >= cur;
    parts.push(h('line', { x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y, stroke: after ? '#8ab3fd' : '#4e68a2', 'stroke-width': 2 }));
  }
  for (const p of pts) {
    const isKey = keys?.has(p.f);
    const isCur = p.f === cur;
    parts.push(h('circle', { cx: p.x, cy: p.y, r: isCur ? 4 : isKey ? 3.5 : 1.8, fill: isCur ? '#ffffff' : isKey ? '#fcc327' : '#000000' }));
    if (st.show_frame_numbers) parts.push(h('text', { x: p.x + 5, y: p.y - 4, fill: '#cdced0', 'font-size': 10 }, String(p.f)));
  }
}

editModeHooks.svg.push((v) => {
  if (!v.overlay.show_overlays || v.overlay.show_motion_paths === false) return null;
  const parts: VNode[] = [];
  for (const o of Object.values(app.doc.objects) as ObMP[]) {
    if ((!o.motion_path && !o.bone_paths) || !app.isVisible(o.id)) continue;
    const st = settings(o);
    const keys = st.show_keyframe_highlight ? keyframeFrames(app.doc, [o]) : null;
    if (o.motion_path) drawPath(v, o.motion_path, st, keys, parts);
    for (const mp of Object.values(o.bone_paths ?? {})) drawPath(v, mp, st, keys, parts);
  }
  return parts.length ? h('g', { class: 'motion-paths' }, parts) : null;
});

// Screen-level operators: undo/redo, frames & playback, search, keyframes, areas.
import { app, registerOperators, operators } from '../app/app';
import { openMenu, openSearch, type SearchEntry, type MenuItem } from '../ui/menu';
import { openRedoPopup } from '../ui/redo';
import { insertKeyframesForObjects, deleteKeyframesAt, type KeyingSet } from '../anim/keyframes';
import { shortcutLabel } from '../app/keymap';

let playRaf = 0;
let playStart = 0;
let playFrameStart = 0;
let lastFrameTime = 0;
export const playbackListeners = new Set<(frame: number) => void>();

function range() {
  const s = app.doc.scene;
  return s.use_preview_range ? [s.frame_preview_start ?? s.frame_start, s.frame_preview_end ?? s.frame_end] : [s.frame_start, s.frame_end];
}

export function stopPlayback(restore = false) {
  cancelAnimationFrame(playRaf);
  if (restore && app.playing) app.setFrame(playFrameStart);
  app.playing = false;
  app.changed('ui', 'frame');
}

function startPlayback(reverse: boolean) {
  const sc = app.doc.scene;
  app.playing = reverse ? 'reverse' : 'forward';
  playFrameStart = sc.frame_current;
  playStart = performance.now();
  lastFrameTime = playStart;
  const fps = sc.render.fps / (sc.render.fps_base || 1);
  let startFrame = sc.frame_current;
  const tick = (now: number) => {
    if (!app.playing) return;
    const [a, b] = range();
    let frame: number;
    if (sc.sync_mode === 'NONE') {
      // play every frame
      frame = sc.frame_current + (reverse ? -1 : 1);
    } else {
      const elapsed = (now - playStart) / 1000;
      frame = startFrame + Math.floor(elapsed * fps) * (reverse ? -1 : 1);
    }
    if (frame > b) {
      frame = a;
      startFrame = a;
      playStart = now;
    }
    if (frame < a) {
      frame = b;
      startFrame = b;
      playStart = now;
    }
    if (frame !== sc.frame_current) {
      app.setFrame(frame);
      lastFrameTime = now;
      playbackListeners.forEach((f) => f(frame));
    }
    playRaf = requestAnimationFrame(tick);
  };
  playRaf = requestAnimationFrame(tick);
  app.changed('ui');
  void lastFrameTime;
}

function allKeyFrames(): number[] {
  const doc = app.doc;
  const obs = app.selectedObjects().length ? app.selectedObjects() : app.activeObject ? [app.activeObject] : [];
  const frames = new Set<number>();
  for (const ob of obs) {
    const act = ob.animation_data?.action ? doc.actions[ob.animation_data.action] : undefined;
    for (const fc of act?.fcurves ?? []) for (const k of fc.keyframe_points) frames.add(k.co[0]);
  }
  for (const m of doc.scene.timeline_markers) frames.add(m.frame);
  return [...frames].sort((a, b) => a - b);
}

registerOperators([
  { idname: 'ed.undo', label: 'Undo', description: 'Undo previous action', undo: false, exec: () => app.undoStep() },
  { idname: 'ed.redo', label: 'Redo', description: 'Redo previous action', undo: false, exec: () => app.redoStep() },
  {
    idname: 'ed.undo_history',
    label: 'Undo History',
    undo: false,
    invoke: () => {
      const items: MenuItem[] = app.undo.history.map((s, i) => ({ label: s.label, active: s.active, action: () => {
        const d = app.undo.jump(i);
        if (d) app.setDocument(d, false);
      } })).reverse();
      openMenu(items, { x: app.pointer.x, y: app.pointer.y }, { title: 'Undo History' });
      return 'CANCELLED';
    },
  },
  {
    idname: 'screen.redo_last',
    label: 'Adjust Last Operation',
    description: 'Display parameters for last action performed',
    undo: false,
    poll: () => !!app.lastOp,
    exec: () => openRedoPopup({ x: app.pointer.x - 140, y: app.pointer.y - 20 }),
  },
  {
    idname: 'screen.repeat_last',
    label: 'Repeat Last',
    undo: true,
    poll: () => !!app.lastOp,
    exec: () => {
      const l = app.lastOp!;
      app.run(l.idname, l.props, { invoke: false });
    },
  },
  {
    idname: 'screen.frame_offset',
    label: 'Frame Offset',
    props: [{ id: 'delta', label: 'Delta', type: 'int', default: 1 }],
    undo: false,
    exec: (ctx, p) => app.setFrame(ctx.doc.scene.frame_current + (p.delta as number)),
  },
  {
    idname: 'screen.frame_jump',
    label: 'Jump to Endpoint',
    props: [{ id: 'end', label: 'Last Frame', type: 'bool', default: false }],
    undo: false,
    exec: (_ctx, p) => {
      const [a, b] = range();
      app.setFrame(p.end ? b : a);
    },
  },
  {
    idname: 'screen.keyframe_jump',
    label: 'Jump to Keyframe',
    props: [{ id: 'next', label: 'Next Keyframe', type: 'bool', default: true }],
    undo: false,
    exec: (ctx, p) => {
      const f = ctx.doc.scene.frame_current;
      const frames = allKeyFrames();
      const t = p.next ? frames.find((x) => x > f + 0.01) : [...frames].reverse().find((x) => x < f - 0.01);
      if (t === undefined) {
        app.report('INFO', 'No more keyframes to jump to in this direction');
        return 'CANCELLED';
      }
      app.setFrame(Math.round(t));
    },
  },
  {
    idname: 'screen.animation_play',
    label: 'Play Animation',
    props: [{ id: 'reverse', label: 'Play in Reverse', type: 'bool', default: false }],
    undo: false,
    exec: (_ctx, p) => {
      if (app.playing) stopPlayback();
      else startPlayback(!!p.reverse);
    },
  },
  {
    idname: 'screen.animation_cancel',
    label: 'Cancel Animation',
    props: [{ id: 'restore_frame', label: 'Restore Frame', type: 'bool', default: true }],
    undo: false,
    poll: () => !!app.playing,
    exec: (_ctx, p) => stopPlayback(!!p.restore_frame),
  },
  {
    idname: 'screen.screen_full_area',
    label: 'Toggle Maximize Area',
    props: [{ id: 'use_hide_panels', label: 'Hide Panels', type: 'bool', default: false }],
    undo: false,
    poll: (ctx) => !!ctx.area,
    exec: (ctx, p) => {
      const area = ctx.area as unknown as { screen: { toggleMaximize(a: unknown, f: boolean): void } };
      area.screen.toggleMaximize(ctx.area, !!p.use_hide_panels);
    },
  },
  {
    idname: 'wm.search_menu',
    label: 'Menu Search',
    description: 'Search all operators',
    undo: false,
    exec: () => {
      openSearch(() => {
        const out: SearchEntry[] = [];
        for (const op of operators.values()) {
          if (op.internal) continue;
          const sc = shortcutLabel(op.idname);
          out.push({ label: op.label, path: op.idname.split('.')[0].replace(/^\w/, (c) => c.toUpperCase()), shortcut: sc, disabled: !app.poll(op.idname), run: () => app.run(op.idname) });
        }
        return out.sort((a, b) => a.label.localeCompare(b.label));
      });
    },
  },
  {
    idname: 'anim.keyframe_insert',
    label: 'Insert Keyframe',
    description: 'Insert keyframes on the current frame using the default keying set',
    poll: () => app.selectedObjects().length > 0 || !!app.activeObject,
    exec: (ctx) => {
      const obs = app.selectedObjects().length ? app.selectedObjects() : [app.activeObject!];
      insertKeyframesForObjects(obs, ctx.doc.scene.keying_set ?? 'LocRotScale');
      app.report('INFO', 'Keyframes inserted');
    },
  },
  {
    idname: 'anim.keyframe_insert_by_name',
    label: 'Insert Keyframe (by Keying Set)',
    props: [{ id: 'type', label: 'Keying Set', type: 'enum', default: 'LocRotScale', items: [['Location', 'Location'], ['Rotation', 'Rotation'], ['Scale', 'Scale'], ['LocRot', 'Location & Rotation'], ['LocScale', 'Location & Scale'], ['RotScale', 'Rotation & Scale'], ['LocRotScale', 'Location, Rotation & Scale'], ['Available', 'Available'], ['WholeCharacter', 'Whole Character']] }],
    poll: () => app.selectedObjects().length > 0,
    exec: (_ctx, p) => insertKeyframesForObjects(app.selectedObjects(), p.type as KeyingSet),
  },
  {
    idname: 'anim.keyframe_insert_menu',
    label: 'Insert Keyframe Menu',
    undo: false,
    poll: () => app.selectedObjects().length > 0,
    invoke: () => {
      const sets: [KeyingSet, string][] = [['Location', 'Location'], ['Rotation', 'Rotation'], ['Scale', 'Scale'], ['LocRot', 'Location & Rotation'], ['LocScale', 'Location & Scale'], ['LocRotScale', 'Location, Rotation & Scale'], ['RotScale', 'Rotation & Scale'], ['Available', 'Available'], ['WholeCharacter', 'Whole Character'], ...(app.doc.scene.keying_sets ?? []).map((k): [KeyingSet, string] => [`KS:${k.name}`, k.name])];
      openMenu(sets.map(([t, l]) => ({ label: l, op: 'anim.keyframe_insert_by_name', props: { type: t } })), { x: app.pointer.x, y: app.pointer.y }, { title: 'Insert Keyframe' });
      return 'CANCELLED';
    },
  },
  {
    idname: 'anim.keyframe_delete_v3d',
    label: 'Delete Keyframe',
    poll: () => app.selectedObjects().length > 0,
    exec: (ctx) => {
      const n = deleteKeyframesAt(app.selectedObjects(), ctx.doc.scene.frame_current);
      if (!n) {
        app.report('WARNING', 'No keyframes removed');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'anim.keyframe_clear_v3d',
    label: 'Clear Keyframes',
    poll: () => app.selectedObjects().length > 0,
    exec: () => {
      for (const ob of app.selectedObjects()) if (ob.animation_data) ob.animation_data.action = null;
    },
  },
  {
    idname: 'screen.marker_add',
    label: 'Add Marker',
    exec: (ctx) => {
      const s = ctx.doc.scene;
      s.timeline_markers.forEach((m) => (m.select = false));
      s.timeline_markers.push({ name: `F_${String(s.frame_current).padStart(2, '0')}`, frame: s.frame_current, select: true });
    },
  },
  {
    idname: 'screen.marker_delete',
    label: 'Delete Markers',
    poll: (ctx) => ctx.doc.scene.timeline_markers.some((m) => m.select),
    exec: (ctx) => {
      ctx.doc.scene.timeline_markers = ctx.doc.scene.timeline_markers.filter((m) => !m.select);
    },
  },
]);

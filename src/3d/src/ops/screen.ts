// Screen-level operators: undo/redo, frames & playback, search, keyframes, areas.
import { app, registerOperators, operators, type AreaLike } from '../app/app';
import { openMenu, openSearch, captureMenuItems, type SearchEntry, type MenuItem } from '../ui/menu';
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
    description: 'Search the menus of the top bar and of the editor under the pointer, and all operators',
    undo: false,
    exec: (ctx) => {
      const area = ctx.area;
      openSearch(() => searchEntries(area));
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
      const sets: [KeyingSet, string][] = [['Location', 'Location'], ['Rotation', 'Rotation'], ['Scale', 'Scale'], ['LocRot', 'Location & Rotation'], ['LocScale', 'Location & Scale'], ['LocRotScale', 'Location, Rotation & Scale'], ['RotScale', 'Rotation & Scale'], ['Available', 'Available'], ['WholeCharacter', 'Whole Character']];
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

// ---------------------------------------------------------------------------
// menu search

/** Menu buttons (top bar and the area's header) with their items, collected without opening them. */
function menuRoots(area: AreaLike | null): { label: string; items: () => MenuItem[] }[] {
  const capture = (b: HTMLElement) => () => captureMenuItems(() => b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })));
  const roots = [...document.querySelectorAll<HTMLElement>('.topbar .tb-menu')].map((b) => ({ label: b.textContent?.trim() ?? '', items: capture(b) }));
  const header = (area?.el as HTMLElement | undefined)?.querySelector<HTMLElement>('.area-header');
  if (header) for (const b of header.querySelectorAll<HTMLElement>('.hdr-menu')) roots.push({ label: b.textContent?.trim() ?? '', items: capture(b) });
  return roots;
}

/** Flatten menus into search entries with their menu path (e.g. "View ▸ Area ▸ Vertical Split"). */
export function menuEntries(roots: { label: string; items: () => MenuItem[] }[], maxDepth = 4): (SearchEntry & { op?: string })[] {
  const out: (SearchEntry & { op?: string })[] = [];
  const walk = (items: MenuItem[], path: string[], depth: number) => {
    for (const it of items) {
      if (it.separator || it.heading || it.custom) continue;
      const label = it.label ?? (it.op ? operators.get(it.op)?.label : undefined);
      if (!label) continue;
      if (it.submenu) {
        if (depth >= maxDepth) continue;
        let sub: MenuItem[] = [];
        try {
          sub = it.submenu();
        } catch {
          sub = [];
        }
        walk(sub, [...path, label], depth + 1);
        continue;
      }
      if (!it.op && !it.action) continue;
      const disabled = !!it.disabled || (!!it.op && !app.poll(it.op));
      out.push({
        label,
        path: path.join(' ▸ '),
        icon: it.icon,
        shortcut: it.shortcut ?? (it.op ? shortcutLabel(it.op, it.props) : ''),
        disabled,
        op: it.op,
        run: () => (it.action ? it.action() : app.run(it.op!, it.props ?? {})),
      });
    }
  };
  for (const r of roots) {
    let items: MenuItem[] = [];
    try {
      items = r.items();
    } catch {
      items = [];
    }
    walk(items, [r.label], 1);
  }
  return out;
}

function searchEntries(area: AreaLike | null): SearchEntry[] {
  const menus = menuEntries(menuRoots(area));
  const seen = new Set<string>();
  const out: SearchEntry[] = [];
  for (const e of menus) {
    const k = `${e.path}|${e.label}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  const inMenus = new Set(menus.map((e) => e.op).filter(Boolean));
  const ops: SearchEntry[] = [];
  for (const op of operators.values()) {
    if (op.internal || inMenus.has(op.idname)) continue;
    ops.push({ label: op.label, path: op.idname.split('.')[0].replace(/^\w/, (c) => c.toUpperCase()), shortcut: shortcutLabel(op.idname), disabled: !app.poll(op.idname, area), run: () => app.run(op.idname, {}, { area }) });
  }
  ops.sort((a, b) => a.label.localeCompare(b.label));
  return [...out, ...ops];
}

// Clip editor operators behind its mouse interactions, usable from search, shortcuts and scripts:
// change frame, select (clip, graph knots, dope sheet channels), 2D cursor, view pan / zoom /
// center on cursor, add marker and move, slide markers, mode and active clip.
import { app, registerOperators, type OpContext } from '../app/app';
import { ClipEditor } from './editor';
import { contextClip, contextEditor } from './ops';
import { graphKnotAt, graphSelection, knotKey, sortedTracks } from './graphs';
import { cloneMarker, enabledMarkerAt, insertMarker, markerAt, sceneToClipFrame, tobj, type MovieClipData } from './types';

const CHANNEL_W = 200,
  ROW_H = 20,
  HEAD_H = 24;

const editorIn = (view?: ClipEditor['view']) => (ctx: OpContext) => {
  const ed = contextEditor(ctx);
  return !!ed && (!view || ed.view === view);
};

/** Pointer position local to the editor of the context. */
function pointer(ed: ClipEditor) {
  const r = ed.el.getBoundingClientRect();
  return { x: app.pointer.x - r.left, y: app.pointer.y - r.top };
}

/** Normalized frame position (0..1, y up) under the pointer. */
function pointerLocation(ed: ClipEditor): [number, number] {
  const p = pointer(ed);
  const [W, H] = ed.frameSize();
  const [ix, iy] = ed.toImage(p.x, p.y);
  return [ix / W, 1 - iy / H];
}

/** Frame under a pointer x in the clip view's cache line / the graph and dope sheet time axis. */
function frameAtX(ed: ClipEditor, x: number): number {
  if (ed.view === 'CLIP') {
    const c = ed.clip;
    const n = Math.max(1, c?.frame_duration ?? 1);
    const x0 = ed.showToolbar ? 230 : 0,
      x1 = ed.el.clientWidth - (ed.showSidebar ? 290 : 0);
    const cf = 1 + Math.floor(((x - x0) / Math.max(1, x1 - x0)) * n);
    return c ? cf + c.frame_start - 1 : cf;
  }
  return Math.round(ed.v2.xf(x - (ed.view === 'DOPESHEET' ? CHANNEL_W : 0)));
}

function selectAt(c: MovieClipData, loc: [number, number], f: number, extend: boolean, deselectAll: boolean): boolean {
  const o = tobj(c);
  const [W, H] = c.size;
  let best: (typeof o.tracks)[number] | null = null,
    bd = Infinity;
  for (const t of o.tracks) {
    if (t.hide) continue;
    const m = enabledMarkerAt(t, f) ?? markerAt(t, f);
    if (!m || f < t.markers[0].frame) continue;
    // inside the pattern counts as distance 0
    const xs = m.pattern_corners.map((p) => p[0]),
      ys = m.pattern_corners.map((p) => p[1]);
    const dx = (loc[0] - m.co[0]) * W,
      dy = (loc[1] - m.co[1]) * H;
    const inside = loc[0] - m.co[0] >= Math.min(...xs) && loc[0] - m.co[0] <= Math.max(...xs) && loc[1] - m.co[1] >= Math.min(...ys) && loc[1] - m.co[1] <= Math.max(...ys);
    const d = inside ? 0 : Math.hypot(dx, dy);
    if (d < bd) ((bd = d), (best = t));
  }
  const limit = Math.max(12, Math.hypot(W, H) * 0.02);
  if (!best || bd > limit) {
    if (deselectAll) for (const t of o.tracks) t.select = false;
    return deselectAll;
  }
  if (extend) {
    if (best.select && o.active_track === best.name) best.select = false;
    else best.select = true;
  } else {
    for (const t of o.tracks) t.select = false;
    for (const p of o.plane_tracks ?? []) p.select = false;
    best.select = true;
  }
  if (best.select) o.active_track = best.name;
  return true;
}

/** Modal drag following the pointer until release (or click); Esc / right click cancel. */
function dragModal(label: string, onMove: (dx: number, dy: number, e: PointerEvent) => void, cancel: () => void, finishOnUp = true) {
  const start = { x: app.pointer.x, y: app.pointer.y };
  app.startModal({
    label,
    onPointerMove: (e) => onMove(e.clientX - start.x, e.clientY - start.y, e),
    onPointerDown: (e) => (e.button === 2 ? 'CANCELLED' : 'FINISHED'),
    onPointerUp: () => (finishOnUp ? 'FINISHED' : undefined),
    onKey: (e) => (e.type !== 'keydown' ? true : e.key === 'Escape' ? 'CANCELLED' : e.key === 'Enter' ? 'FINISHED' : true),
    cancel,
    status: () => [
      ['LMB', 'Confirm'],
      ['Esc', 'Cancel'],
    ],
  });
}

registerOperators([
  {
    idname: 'clip.change_frame',
    label: 'Change Frame',
    description: 'Set the current frame (drag along the time axis to scrub)',
    props: [{ id: 'frame', label: 'Frame', type: 'int', default: 0 }],
    undo: false,
    poll: editorIn(),
    invoke: (ctx, p) => {
      const ed = contextEditor(ctx)!;
      p.frame = frameAtX(ed, pointer(ed).x);
      app.setFrame(Number(p.frame));
      const r = ed.el.getBoundingClientRect();
      app.startModal({
        label: 'Change Frame',
        onPointerMove: (e) => {
          const f = frameAtX(ed, e.clientX - r.left);
          if (f !== app.doc.scene.frame_current) app.setFrame(f);
        },
        onPointerUp: () => 'FINISHED',
        onPointerDown: () => 'FINISHED',
        onKey: (e) => (e.type === 'keydown' && e.key === 'Escape' ? 'FINISHED' : true),
        cancel: () => {},
      });
      return 'RUNNING_MODAL';
    },
    exec: (_ctx, p) => {
      app.setFrame(Number(p.frame));
    },
  },
  {
    idname: 'clip.select',
    label: 'Select',
    description: 'Select the marker nearest to a position (Shift extends)',
    props: [
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
      { id: 'deselect_all', label: 'Deselect On Nothing', type: 'bool', default: false },
      { id: 'location', label: 'Location', type: 'vec2', default: [0, 0] },
    ],
    poll: (ctx) => !!contextClip(ctx),
    invoke: (ctx, p) => {
      const ed = contextEditor(ctx);
      if (ed && ed.view === 'CLIP') p.location = pointerLocation(ed);
      return selectOp(ctx, p);
    },
    exec: (ctx, p) => selectOp(ctx, p),
  },
  {
    idname: 'clip.cursor_set',
    label: 'Set 2D Cursor',
    description: 'Place the 2D cursor (used by mask tools and as a pivot)',
    props: [{ id: 'location', label: 'Location', type: 'vec2', default: [0, 0] }],
    undo: false,
    poll: editorIn('CLIP'),
    invoke: (ctx, p) => {
      p.location = pointerLocation(contextEditor(ctx)!);
      return cursorSet(ctx, p);
    },
    exec: (ctx, p) => cursorSet(ctx, p),
  },
  {
    idname: 'clip.view_center_cursor',
    label: 'Center View to Cursor',
    description: 'Center the view on the 2D cursor',
    undo: false,
    poll: editorIn('CLIP'),
    exec: (ctx) => {
      const ed = contextEditor(ctx)!;
      const [W, H] = ed.frameSize();
      ed.offX = W / 2 - ed.cursor[0] * W;
      ed.offY = H / 2 - (1 - ed.cursor[1]) * H;
      ed.fitted = true;
      ed.draw();
    },
  },
  {
    idname: 'clip.view_pan',
    label: 'Pan View',
    description: 'Move the view (offset in footage pixels)',
    props: [{ id: 'offset', label: 'Offset', type: 'vec2', default: [0, 0] }],
    undo: false,
    poll: editorIn(),
    invoke: (ctx) => {
      const ed = contextEditor(ctx)!;
      const [ox, oy] = [ed.offX, ed.offY];
      const v2 = { ...ed.v2 } as Record<string, unknown>;
      let lx = 0,
        ly = 0;
      dragModal(
        'Pan View',
        (dx, dy) => {
          if (ed.view === 'CLIP') {
            ed.offX = ox + dx / ed.zoom;
            ed.offY = oy + dy / ed.zoom;
          } else {
            ed.v2.panPx(dx - lx, ed.view === 'GRAPH' ? dy - ly : 0);
            lx = dx;
            ly = dy;
          }
          ed.fitted = true;
          ed.draw();
        },
        () => {
          ed.offX = ox;
          ed.offY = oy;
          Object.assign(ed.v2, v2);
          ed.draw();
        },
      );
      return 'RUNNING_MODAL';
    },
    exec: (ctx, p) => {
      const ed = contextEditor(ctx)!;
      const o = p.offset as [number, number];
      if (ed.view === 'CLIP') {
        ed.offX -= o[0];
        ed.offY += o[1];
      } else ed.v2.panPx(-o[0] * ed.zoom, ed.view === 'GRAPH' ? o[1] : 0);
      ed.fitted = true;
      ed.draw();
    },
  },
  {
    idname: 'clip.view_zoom',
    label: 'Zoom View',
    description: 'Zoom the view by a factor (drag to zoom interactively)',
    props: [
      { id: 'factor', label: 'Factor', type: 'float', default: 1, min: 1e-4 },
      { id: 'use_cursor_init', label: 'Use Mouse Position', type: 'bool', default: true },
    ],
    undo: false,
    poll: editorIn(),
    invoke: (ctx) => {
      const ed = contextEditor(ctx)!;
      const at = pointer(ed);
      const [z, ox, oy] = [ed.zoom, ed.offX, ed.offY];
      dragModal(
        'Zoom View',
        (dx, dy) => {
          const f = Math.exp((dx - dy) * 0.01);
          if (ed.view === 'CLIP') {
            ed.zoom = z;
            ed.offX = ox;
            ed.offY = oy;
            ed.zoomAt(f, at.x, at.y);
          } else {
            ed.v2.zoomX(f, at.x);
            ed.draw();
          }
        },
        () => {
          ed.zoom = z;
          ed.offX = ox;
          ed.offY = oy;
          ed.draw();
        },
      );
      return 'RUNNING_MODAL';
    },
    exec: (ctx, p) => {
      const ed = contextEditor(ctx)!;
      const at = p.use_cursor_init ? pointer(ed) : undefined;
      if (ed.view === 'CLIP') ed.zoomAt(Number(p.factor), at?.x, at?.y);
      else {
        ed.v2.zoomX(Number(p.factor), at?.x ?? ed.el.clientWidth / 2);
        ed.draw();
      }
    },
  },
  {
    idname: 'clip.add_marker_move',
    label: 'Add Marker and Move',
    description: 'Add a new marker under the mouse and move it',
    poll: (ctx) => editorIn('CLIP')(ctx) && !!contextClip(ctx)?.size[0],
    invoke: (ctx) => addAndMove(ctx, 'Add Marker and Move'),
  },
  {
    idname: 'clip.add_marker_slide',
    label: 'Add Marker and Slide',
    description: 'Add a new marker under the mouse and slide it',
    poll: (ctx) => editorIn('CLIP')(ctx) && !!contextClip(ctx)?.size[0],
    invoke: (ctx) => addAndMove(ctx, 'Add Marker and Slide'),
  },
  {
    idname: 'clip.slide_marker',
    label: 'Slide Marker',
    description: 'Move the selected markers on the current frame (offset in normalized frame units)',
    props: [{ id: 'offset', label: 'Offset', type: 'vec2', default: [0, 0] }],
    poll: (ctx) => !!contextClip(ctx) && tobj(contextClip(ctx)!).tracks.some((t) => t.select && !t.lock && !t.hide),
    invoke: (ctx) => (editorIn('CLIP')(ctx) ? app.run('clip.transform', { mode: 'TRANSLATE' }, { area: ctx.area }) : 'CANCELLED'),
    exec: (ctx, p) => {
      const c = contextClip(ctx)!;
      const f = sceneToClipFrame(c, ctx.doc.scene.frame_current);
      const off = p.offset as [number, number];
      let n = 0;
      for (const t of tobj(c).tracks) {
        if (!t.select || t.lock || t.hide) continue;
        const held = markerAt(t, f);
        if (!held) continue;
        const m = cloneMarker(held, f);
        m.co = [m.co[0] + off[0], m.co[1] + off[1]];
        m.is_keyed = true;
        insertMarker(t, m);
        n++;
      }
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'clip.graph_select',
    label: 'Select',
    description: 'Select the graph knot nearest to a position (frame, value)',
    props: [
      { id: 'location', label: 'Location', type: 'vec2', default: [0, 0] },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
    ],
    undo: false,
    poll: editorIn('GRAPH'),
    invoke: (ctx, p) => {
      const ed = contextEditor(ctx)!;
      const q = pointer(ed);
      p.location = [ed.v2.xf(q.x), ed.v2.yv(q.y - 24)];
      return graphSelect(ed, q.x, q.y - 24, !!p.extend);
    },
    exec: (ctx, p) => {
      const ed = contextEditor(ctx)!;
      const l = p.location as [number, number];
      return graphSelect(ed, ed.v2.fx(l[0]), ed.v2.vy(l[1]), !!p.extend);
    },
  },
  {
    idname: 'clip.dopesheet_select_channel',
    label: 'Select Channel',
    description: 'Select the track of a dope sheet channel',
    props: [
      { id: 'location', label: 'Location', type: 'vec2', default: [0, 0] },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
    ],
    poll: editorIn('DOPESHEET'),
    invoke: (ctx, p) => {
      const ed = contextEditor(ctx)!;
      const q = pointer(ed);
      p.location = [q.x, q.y];
      return channelSelect(ed, q.y, !!p.extend);
    },
    exec: (ctx, p) => channelSelect(contextEditor(ctx)!, (p.location as number[])[1], !!p.extend),
  },
  {
    idname: 'clip.mode_set',
    label: 'Set Clip Mode',
    description: 'Switch the clip editor between tracking and mask editing',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'TRACKING',
        items: [
          ['TRACKING', 'Tracking', 'Show tracking and solving tools'],
          ['MASK', 'Mask', 'Show mask editing tools'],
        ],
      },
    ],
    undo: false,
    poll: editorIn('CLIP'),
    exec: (ctx, p) => {
      contextEditor(ctx)!.setMode(p.mode === 'MASK' ? 'MASK' : 'TRACKING');
    },
  },
  {
    idname: 'clip.set_active_clip',
    label: 'Set Active Clip',
    description: "Make the editor's clip the scene's active clip (used by constraints and nodes set to the active clip)",
    poll: (ctx) => !!contextEditor(ctx)?.clip,
    exec: (ctx) => {
      ctx.doc.scene.active_clip = contextEditor(ctx)!.clip!.id;
    },
  },
]);

function selectOp(ctx: OpContext, p: Record<string, unknown>) {
  const c = contextClip(ctx)!;
  const f = sceneToClipFrame(c, ctx.doc.scene.frame_current);
  return selectAt(c, p.location as [number, number], f, !!p.extend, !!p.deselect_all) ? 'FINISHED' : 'CANCELLED';
}

function cursorSet(ctx: OpContext, p: Record<string, unknown>) {
  const ed = contextEditor(ctx)!;
  const l = p.location as [number, number];
  ed.cursor = [l[0], l[1]];
  ed.draw();
  app.changed('ui');
}

function addAndMove(ctx: OpContext, label: string) {
  const ed = contextEditor(ctx)!;
  const loc = pointerLocation(ed);
  if (app.run('clip.add_marker', { location: loc }, { area: ctx.area }) !== 'FINISHED') return 'CANCELLED';
  void label;
  return app.run('clip.transform', { mode: 'TRANSLATE' }, { area: ctx.area });
}

function graphSelect(ed: ClipEditor, x: number, y: number, extend: boolean) {
  const c = ed.clip;
  if (!c) return 'CANCELLED';
  const k = graphKnotAt(ed, x, y, 10);
  const sel = graphSelection(ed);
  if (!k) {
    if (!extend) sel.clear();
    ed.draw();
    return 'CANCELLED';
  }
  const key = knotKey(k.track.name, k.frame, k.axis);
  if (extend) {
    if (sel.has(key)) sel.delete(key);
    else sel.add(key);
  } else {
    sel.clear();
    sel.add(key);
  }
  tobj(c).active_track = k.track.name;
  app.changed('ui');
  ed.draw();
  return 'FINISHED';
}

function channelSelect(ed: ClipEditor, y: number, extend: boolean) {
  const c = ed.clip;
  if (!c || y < HEAD_H) return 'CANCELLED';
  const t = sortedTracks(ed)[Math.floor((y - HEAD_H + ed.dopesheetScroll) / ROW_H)];
  if (!t) return 'CANCELLED';
  if (extend) t.select = !t.select;
  else {
    for (const o of tobj(c).tracks) o.select = false;
    t.select = true;
  }
  if (t.select) tobj(c).active_track = t.name;
  return 'FINISHED';
}

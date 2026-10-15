// Clip editor operators for the Graph and Dope Sheet views (knot selection, deleting knots and
// curves, framing) and circle / lasso selection of markers in the Clip view.
import { app, registerOperators, type Operator } from '../app/app';
import { addKeys, keymaps } from '../app/keymap';
import { currentClipEditor, type ClipEditor } from './editor';
import { graphSelection, graphKnots, knotKey, frameGraphAll, frameDopesheetAll } from './graphs';
import { enabledMarkerAt, markerAt, type MovieClipData } from './types';
import { pointInPolygon } from '../sequencer/selection';

const editorIn = (view: string) => () => {
  const ed = currentClipEditor();
  return !!ed && ed.view === view && !!ed.clip;
};
const inGraph = editorIn('GRAPH');
const inDopesheet = editorIn('DOPESHEET');
const inClip = () => {
  const ed = currentClipEditor();
  return !!ed && ed.view === 'CLIP' && ed.mode === 'TRACKING' && !!ed.clip;
};

/** Selected knots resolved to tracks / clip frames. */
function selectedKnots(ed: ClipEditor) {
  const c = ed.clip!;
  const sel = graphSelection(ed);
  const out: { track: MovieClipData['tracking']['tracks'][number]; frame: number }[] = [];
  const seen = new Set<string>();
  for (const k of sel) {
    const [name, f] = k.split('|');
    // the X and Y knots of a frame are the same marker
    if (seen.has(`${name}|${f}`)) continue;
    seen.add(`${name}|${f}`);
    const t = c.tracking.tracks.find((x) => x.name === name);
    if (t) out.push({ track: t, frame: Number(f) });
  }
  return out;
}

/** Marker positions (editor-local px) of the visible tracks at the current frame. */
function markerPoints(ed: ClipEditor) {
  const f = ed.clipFrame;
  const T = ed.stab();
  const out: { t: MovieClipData['tracking']['tracks'][number]; x: number; y: number }[] = [];
  for (const t of ed.tracks()) {
    const m = enabledMarkerAt(t, f) ?? (ed.overlays.show_disabled ? markerAt(t, f) : null);
    if (!m) continue;
    const g = ed.markerGeom(m);
    const [x, y] = ed.toScreen(g.x, g.y, T);
    out.push({ t, x, y });
  }
  return out;
}

function selectMarkers(ed: ClipEditor, test: (x: number, y: number) => boolean, mode: 'SET' | 'ADD' | 'SUB') {
  const c = ed.clip!;
  if (mode === 'SET') for (const t of c.tracking.tracks) t.select = false;
  for (const p of markerPoints(ed))
    if (test(p.x, p.y)) {
      p.t.select = mode !== 'SUB';
      if (p.t.select) c.tracking.active_track = p.t.name;
    }
  app.changed('doc');
}

/** Lasso drawn from a press (editor-local coordinates). */
export function clipLasso(ed: ClipEditor, e: { clientX: number; clientY: number }, mode: 'SET' | 'ADD' | 'SUB') {
  const p0 = ed.local(e);
  const pts: [number, number][] = [[p0.x, p0.y]];
  const move = (ev: PointerEvent) => {
    const q = ed.local(ev);
    pts.push([q.x, q.y]);
    ed.shapeOverlay = { kind: 'lasso', pts };
    ed.draw();
  };
  const up = () => {
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    ed.shapeOverlay = null;
    if (pts.length > 2) selectMarkers(ed, (x, y) => pointInPolygon(x, y, pts), mode);
    app.pushUndo('Lasso Select');
    ed.draw();
    ed.drawUI();
  };
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
}

let circleRadius = 25;

const SELECT_MODES: [string, string][] = [
  ['SET', 'Set'],
  ['ADD', 'Extend'],
  ['SUB', 'Subtract'],
];

const ops: Operator[] = [
  {
    idname: 'clip.select_circle',
    label: 'Circle Select',
    description: 'Select markers by painting over them with a circle',
    props: [{ id: 'mode', label: 'Mode', type: 'enum', default: 'ADD', items: SELECT_MODES }],
    poll: inClip,
    undo: false,
    invoke: (_c, p) => {
      const ed = currentClipEditor()!;
      const mode = p.mode as 'SET' | 'ADD' | 'SUB';
      if (mode === 'SET') for (const t of ed.clip!.tracking.tracks) t.select = false;
      const q = ed.local({ clientX: app.pointer.x, clientY: app.pointer.y });
      const c = { kind: 'circle' as const, x: q.x, y: q.y, r: circleRadius };
      let paint: 'ADD' | 'SUB' | null = null;
      const apply = () => {
        if (paint) selectMarkers(ed, (x, y) => Math.hypot(x - c.x, y - c.y) <= c.r, paint);
        ed.shapeOverlay = c;
        ed.draw();
      };
      apply();
      const end = () => {
        ed.shapeOverlay = null;
        ed.draw();
        ed.drawUI();
      };
      app.startModal({
        label: 'Circle Select',
        cursor: 'crosshair',
        header: () => 'Circle Select: LMB select, Shift / MMB deselect, wheel resize, RMB / Esc confirm',
        onPointerMove(e) {
          const r = ed.local(e);
          c.x = r.x;
          c.y = r.y;
          apply();
        },
        onPointerDown(e) {
          if (e.button === 2) return 'FINISHED';
          paint = e.button === 1 || e.shiftKey || mode === 'SUB' ? 'SUB' : 'ADD';
          apply();
          return undefined;
        },
        onPointerUp() {
          paint = null;
          return undefined;
        },
        onWheel(e) {
          c.r = circleRadius = Math.max(5, Math.min(300, c.r * (e.deltaY > 0 ? 1 / 1.1 : 1.1)));
          apply();
        },
        onKey(e) {
          if (e.type === 'keydown' && (e.key === 'Escape' || e.key === 'Enter')) return 'FINISHED';
          return true;
        },
        cancel: end,
        finish: end,
      });
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'clip.select_lasso',
    label: 'Lasso Select',
    description: 'Select markers inside a freehand shape (also Ctrl Alt drag)',
    props: [{ id: 'mode', label: 'Mode', type: 'enum', default: 'SET', items: SELECT_MODES }],
    poll: inClip,
    undo: false,
    invoke: (_c, p) => {
      const ed = currentClipEditor()!;
      const down = (e: PointerEvent) => {
        removeEventListener('pointerdown', down, true);
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        clipLasso(ed, e, p.mode as 'SET');
      };
      addEventListener('pointerdown', down, true);
      app.report('INFO', 'Lasso Select: drag to draw the shape');
      return 'CANCELLED';
    },
  },
  // ------------------------------------------------------------------ graph view
  {
    idname: 'clip.graph_select_all_markers',
    label: '(De)select All Markers',
    description: 'Change the selection of all curve points in the graph view',
    props: [
      {
        id: 'action',
        label: 'Action',
        type: 'enum',
        default: 'TOGGLE',
        items: [
          ['TOGGLE', 'Toggle'],
          ['SELECT', 'Select'],
          ['DESELECT', 'Deselect'],
          ['INVERT', 'Invert'],
        ],
      },
    ],
    undo: false,
    poll: inGraph,
    exec: (_c, p) => {
      const ed = currentClipEditor()!;
      const sel = graphSelection(ed);
      const all = graphKnots(ed).map((k) => knotKey(k.track.name, k.frame, k.axis));
      let a = p.action as string;
      if (a === 'TOGGLE') a = sel.size ? 'DESELECT' : 'SELECT';
      if (a === 'SELECT') all.forEach((k) => sel.add(k));
      else if (a === 'DESELECT') sel.clear();
      else for (const k of all) sel.has(k) ? sel.delete(k) : sel.add(k);
      ed.draw();
    },
  },
  {
    idname: 'clip.graph_select_box',
    label: 'Box Select',
    description: 'Select curve points with a box drawn by dragging',
    props: [{ id: 'mode', label: 'Mode', type: 'enum', default: 'SET', items: SELECT_MODES }],
    undo: false,
    poll: inGraph,
    invoke: (_c, p) => {
      const ed = currentClipEditor()!;
      const down = (e: PointerEvent) => {
        removeEventListener('pointerdown', down, true);
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const p0 = ed.local(e);
        const move = (ev: PointerEvent) => {
          const q = ed.local(ev);
          ed.boxRect = { x0: p0.x, y0: p0.y, x1: q.x, y1: q.y };
          ed.draw();
        };
        const up = (ev: PointerEvent) => {
          removeEventListener('pointermove', move, true);
          removeEventListener('pointerup', up, true);
          ed.boxRect = null;
          const q = ed.local(ev);
          const [x0, x1, y0, y1] = [Math.min(p0.x, q.x), Math.max(p0.x, q.x), Math.min(p0.y, q.y), Math.max(p0.y, q.y)];
          const sel = graphSelection(ed);
          const mode = ev.shiftKey ? 'ADD' : ev.ctrlKey || ev.metaKey ? 'SUB' : (p.mode as string);
          if (mode === 'SET') sel.clear();
          for (const k of graphKnots(ed))
            if (k.x >= x0 && k.x <= x1 && k.y >= y0 && k.y <= y1) {
              const key = knotKey(k.track.name, k.frame, k.axis);
              if (mode === 'SUB') sel.delete(key);
              else sel.add(key);
            }
          ed.draw();
        };
        addEventListener('pointermove', move, true);
        addEventListener('pointerup', up, true);
      };
      addEventListener('pointerdown', down, true);
      return 'CANCELLED';
    },
  },
  {
    idname: 'clip.graph_delete_knot',
    label: 'Delete Knot',
    description: 'Delete the markers of the selected curve points',
    poll: () => inGraph() && graphSelection(currentClipEditor()!).size > 0,
    exec: () => {
      const ed = currentClipEditor()!;
      const c = ed.clip!;
      let n = 0;
      for (const { track, frame } of selectedKnots(ed)) {
        if (track.lock) continue;
        const before = track.markers.length;
        track.markers = track.markers.filter((m) => m.frame !== frame);
        n += before - track.markers.length;
      }
      graphSelection(ed).clear();
      c.tracking.tracks = c.tracking.tracks.filter((t) => t.markers.length > 0);
      if (!c.tracking.tracks.some((t) => t.name === c.tracking.active_track)) c.tracking.active_track = null;
      return n ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'clip.graph_delete_curve',
    label: 'Delete Curve',
    description: 'Delete the track of the active curve',
    poll: () => inGraph() && !!currentClipEditor()!.clip!.tracking.active_track,
    exec: () => {
      const ed = currentClipEditor()!;
      const c = ed.clip!;
      const name = c.tracking.active_track;
      const t = c.tracking.tracks.find((x) => x.name === name);
      if (!t || t.lock) return 'CANCELLED';
      c.tracking.tracks = c.tracking.tracks.filter((x) => x !== t);
      c.tracking.active_track = null;
      graphSelection(ed).clear();
    },
  },
  {
    idname: 'clip.graph_disable_markers',
    label: 'Disable Markers',
    description: 'Disable or enable the markers of the selected curve points',
    props: [
      {
        id: 'action',
        label: 'Action',
        type: 'enum',
        default: 'TOGGLE',
        items: [
          ['DISABLE', 'Disable'],
          ['ENABLE', 'Enable'],
          ['TOGGLE', 'Toggle'],
        ],
      },
    ],
    poll: () => inGraph() && graphSelection(currentClipEditor()!).size > 0,
    exec: (_c, p) => {
      for (const { track, frame } of selectedKnots(currentClipEditor()!)) {
        if (track.lock) continue;
        const m = track.markers.find((x) => x.frame === frame);
        if (m) m.mute = p.action === 'DISABLE' ? true : p.action === 'ENABLE' ? false : !m.mute;
      }
    },
  },
  {
    idname: 'clip.graph_view_all',
    label: 'Frame All',
    description: 'Fit the curves of the selected tracks in the graph view',
    undo: false,
    poll: inGraph,
    exec: () => {
      const ed = currentClipEditor()!;
      frameGraphAll(ed);
      ed.draw();
    },
  },
  {
    idname: 'clip.graph_center_current_frame',
    label: 'Center Current Frame',
    description: 'Scroll the graph view to the current frame',
    undo: false,
    poll: inGraph,
    exec: () => {
      const ed = currentClipEditor()!;
      const v = ed.v2;
      const w = ed.viewSize().w;
      v.panPx(w / 2 - v.fx(app.doc.scene.frame_current), 0);
      ed.draw();
    },
  },
  // ------------------------------------------------------------------ dope sheet
  {
    idname: 'clip.dopesheet_view_all',
    label: 'Frame All',
    description: 'Fit the tracked range in the dope sheet',
    undo: false,
    poll: inDopesheet,
    exec: () => {
      const ed = currentClipEditor()!;
      frameDopesheetAll(ed);
      ed.draw();
    },
  },
];

registerOperators(ops);

addKeys('Clip Editor', [{ key: 'C', op: 'clip.select_circle' }]);
// graph-view keys come before the generic clip ones in the same keymap
keymaps['Clip Graph Editor'] = [
  { key: 'A', op: 'clip.graph_select_all_markers', props: { action: 'SELECT' } },
  { key: 'A', alt: true, op: 'clip.graph_select_all_markers', props: { action: 'DESELECT' } },
  { key: 'I', ctrl: true, op: 'clip.graph_select_all_markers', props: { action: 'INVERT' } },
  { key: 'B', op: 'clip.graph_select_box' },
  { key: 'X', shift: true, op: 'clip.graph_delete_knot' },
  { key: 'DEL', shift: true, op: 'clip.graph_delete_knot' },
  { key: 'X', op: 'clip.graph_delete_curve' },
  { key: 'DEL', op: 'clip.graph_delete_curve' },
  { key: 'D', shift: true, op: 'clip.graph_disable_markers', props: { action: 'TOGGLE' } },
  { key: 'HOME', op: 'clip.graph_view_all' },
  { key: 'NUMPAD_0', op: 'clip.graph_center_current_frame' },
  ...(keymaps['Clip Graph Editor'] ?? []),
];
keymaps['Clip Dopesheet Editor'] = [{ key: 'HOME', op: 'clip.dopesheet_view_all' }, ...(keymaps['Clip Dopesheet Editor'] ?? [])];

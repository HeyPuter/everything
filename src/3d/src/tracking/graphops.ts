// Clip editor operators for the Graph and Dope Sheet views (knot selection, deleting knots and
// curves, framing) and circle / lasso selection of markers in the Clip view.
import { app, registerOperators, type Operator } from '../app/app';
import { addKeys, keymaps } from '../app/keymap';
import { currentClipEditor, type ClipEditor } from './editor';
import { graphSelection, graphKnots, knotKey, frameGraphAll, frameDopesheetAll } from './graphs';
import { enabledMarkerAt, markerAt, type MovieClipData } from './types';
import { pointInPolygon } from '../sequencer/selection';
import { openPie } from '../ui/menu';
import { isShortTrack, dropShortSegments, maxAcceleration } from './cleanup';

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

// ---------------------------------------------------------------------------
// clean-up, pies and display toggles

const hasClip = () => !!currentClipEditor()?.clip;

registerOperators([
  {
    idname: 'clip.clean_tracks',
    label: 'Clean Tracks',
    description: 'Select, delete or trim tracks whose tracked runs are shorter than a number of frames',
    props: [
      { id: 'frames', label: 'Tracked Frames', type: 'int', default: 0, min: 0 },
      {
        id: 'action',
        label: 'Type',
        type: 'enum',
        default: 'SELECT',
        items: [
          ['SELECT', 'Select'],
          ['DELETE_TRACK', 'Delete Track'],
          ['DELETE_SEGMENTS', 'Delete Segments'],
        ],
      },
    ],
    poll: hasClip,
    exec: (_c, p) => {
      const c = currentClipEditor()!.clip!;
      const frames = p.frames as number;
      const bad = c.tracking.tracks.filter((t) => !t.lock && isShortTrack(t, frames));
      if (p.action === 'SELECT') for (const t of c.tracking.tracks) t.select = bad.includes(t);
      else if (p.action === 'DELETE_TRACK') c.tracking.tracks = c.tracking.tracks.filter((t) => !bad.includes(t));
      else {
        for (const t of c.tracking.tracks) if (!t.lock) dropShortSegments(t, frames);
        c.tracking.tracks = c.tracking.tracks.filter((t) => t.markers.length > 0);
      }
      if (!c.tracking.tracks.some((t) => t.name === c.tracking.active_track)) c.tracking.active_track = null;
      app.report('INFO', `${bad.length} track${bad.length === 1 ? '' : 's'} shorter than ${frames} frames`);
    },
  },
  {
    idname: 'clip.filter_tracks',
    label: 'Filter Tracks',
    description: 'Select tracks whose motion has sudden spikes (likely tracking errors)',
    props: [{ id: 'track_threshold', label: 'Track Threshold', type: 'float', default: 5, min: 0, precision: 2 }],
    poll: hasClip,
    exec: (_c, p) => {
      const c = currentClipEditor()!.clip!;
      let n = 0;
      for (const t of c.tracking.tracks) {
        t.select = !t.hide && maxAcceleration(t, c.size) > (p.track_threshold as number);
        if (t.select) n++;
      }
      app.report('INFO', `${n} track${n === 1 ? '' : 's'} with motion spikes selected`);
    },
  },
]);

/** E: tracking pie. */
function trackingPie() {
  openPie(
    'Tracking',
    [
      { label: 'Track Backwards', op: 'clip.track_markers', props: { backwards: true, sequence: true } },
      { label: 'Track Forwards', op: 'clip.track_markers', props: { backwards: false, sequence: true } },
      { label: 'Disable Markers', op: 'clip.disable_markers', props: { action: 'TOGGLE' } },
      { label: 'Detect Features', op: 'clip.detect_features' },
      { label: 'Clear Path Up To', op: 'clip.clear_track_path', props: { action: 'UPTO', clear_active: false } },
      { label: 'Clear Path Remaining', op: 'clip.clear_track_path', props: { action: 'REMAINED', clear_active: false } },
      { label: 'Refine Backwards', op: 'clip.refine_markers', props: { backwards: true } },
      { label: 'Refine Forwards', op: 'clip.refine_markers', props: { backwards: false } },
    ],
    app.pointer.x,
    app.pointer.y,
    'KeyE',
  );
}

/** `: view pie of the clip view. */
function viewPie() {
  const ed = currentClipEditor();
  openPie(
    'View',
    [
      { label: 'Frame All', op: 'clip.view_all' },
      { label: 'Frame Selected', op: 'clip.view_selected' },
      { label: 'Zoom 1:1', op: 'clip.view_zoom_ratio', props: { ratio: 1 } },
      { label: 'Frame All Fit', op: 'clip.view_all', props: { fit_view: true } },
      null,
      { label: 'Lock to Selection', active: !!ed?.lockSelection, op: 'clip.lock_selection_toggle' },
      null,
      null,
    ],
    app.pointer.x,
    app.pointer.y,
    'Backquote',
  );
}

/** Toggle a display option of the hovered clip editor. */
function toggleOverlay(key: 'show_disabled' | 'show_marker_search' | 'use_mute_footage') {
  const ed = currentClipEditor();
  if (!ed) return;
  ed.overlays[key] = !ed.overlays[key];
  ed.draw();
  app.changed('ui');
}

addKeys('Clip', [
  { key: 'E', when: inClip, action: trackingPie },
  { key: 'ACCENT_GRAVE', when: inClip, action: viewPie },
]);
addKeys('Clip Editor', [
  { key: 'D', alt: true, action: () => toggleOverlay('show_disabled') },
  { key: 'S', alt: true, action: () => toggleOverlay('show_marker_search') },
  { key: 'H', ctrl: true, action: () => toggleOverlay('use_mute_footage') },
]);

/** Shift E: marker settings pie for the selected tracks. */
function markerPie() {
  const ed = currentClipEditor();
  const c = ed?.clip;
  if (!c) return;
  const sel = c.tracking.tracks.filter((t) => t.select && !t.lock);
  const act = sel.find((t) => t.name === c.tracking.active_track) ?? sel[0];
  const set = (label: string, fn: (t: (typeof sel)[number]) => void) => () => {
    for (const t of sel) fn(t);
    app.pushUndo(label);
    app.changed('doc');
  };
  const model = (m: 'Loc' | 'LocRot' | 'LocScale' | 'LocRotScale' | 'Affine', label: string) => ({ label, active: act?.motion_model === m, action: set('Motion Model', (t) => (t.motion_model = m)) });
  openPie(
    'Marker Settings',
    [
      model('Loc', 'Location'),
      model('Affine', 'Affine'),
      { label: 'Match Previous Frame', active: act?.pattern_match === 'PREV_FRAME', action: set('Pattern Match', (t) => (t.pattern_match = 'PREV_FRAME')) },
      { label: 'Match Keyframe', active: act?.pattern_match === 'KEYFRAME', action: set('Pattern Match', (t) => (t.pattern_match = 'KEYFRAME')) },
      { label: act?.use_brute ? 'Prepass: On' : 'Prepass: Off', action: set('Prepass', (t) => (t.use_brute = !act?.use_brute)) },
      { label: act?.use_normalization ? 'Normalize: On' : 'Normalize: Off', action: set('Normalize', (t) => (t.use_normalization = !act?.use_normalization)) },
      model('LocRot', 'Location & Rotation'),
      model('LocRotScale', 'Location, Rotation & Scale'),
    ],
    app.pointer.x,
    app.pointer.y,
    'KeyE',
  );
}

addKeys('Clip', [{ key: 'E', shift: true, when: () => inClip() && !!currentClipEditor()?.clip?.tracking.tracks.some((t) => t.select), action: markerPie }]);

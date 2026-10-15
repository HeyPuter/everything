// Time marker operators shared by the Timeline, Dope Sheet, Graph Editor and NLA editor:
// add (M), delete (X), select (click / box / all / before-after), move (G), duplicate
// (Shift D), rename (F2), jump and bind camera to markers (Ctrl B), plus the Marker menu.
import { app, registerOperators, type OpContext } from '../app/app';
import { promptText, type MenuItem } from '../ui/menu';
import type { TimelineMarker } from '../data/types';
import { hoverEditor } from './animeditor';

const markers = () => app.doc.scene.timeline_markers;
const selectedMarkers = () => markers().filter((m) => m.select);
export const markersLocked = () => !!app.doc.scene.tool_settings.lock_markers;
const unlocked = () => !markersLocked();

/** Pixels per frame of the editor under the pointer (marker drags). */
function pixelsPerFrame() {
  const ed = (app.hoverArea ?? app.activeArea)?.editor as { view?: { ppf?: number } } | undefined;
  return hoverEditor()?.view.ppf ?? ed?.view?.ppf ?? 6;
}

/** Interactive move of the selected markers (follows the pointer horizontally). */
function startMarkerMove(label: string, onCancel?: () => void, redo?: { idname: string; props: Record<string, unknown> }) {
  const sel = selectedMarkers();
  if (!sel.length) return false;
  const orig = sel.map((m) => m.frame);
  const x0 = app.pointer.x;
  const ppf = pixelsPerFrame();
  let delta = 0;
  let numeric = '';
  const apply = () => {
    const d = numeric && numeric !== '-' ? Math.round(Number(numeric)) || 0 : delta;
    sel.forEach((m, i) => (m.frame = orig[i] + d));
    app.changed('ui');
    return d;
  };
  const handler: Parameters<typeof app.startModal>[0] = {
    label,
    cursor: 'ew-resize',
    header: () => `Marker offset ${numeric ? numeric + '|' : delta}`,
    onPointerMove(e) {
      delta = Math.round((e.clientX - x0) / ppf);
      apply();
    },
    onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : e.button === 2 ? 'CANCELLED' : undefined),
    onKey(e) {
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      if (e.type !== 'keydown') return true;
      if (/^[0-9]$/.test(e.key) || (e.key === '-' && !numeric)) numeric += e.key;
      else if (e.key === 'Backspace') numeric = numeric.slice(0, -1);
      apply();
      return true;
    },
    cancel() {
      sel.forEach((m, i) => (m.frame = orig[i]));
      onCancel?.();
    },
    finish() {
      const d = apply();
      if (redo) handler.redoOp = { idname: redo.idname, props: { ...redo.props, frames: d } };
    },
  };
  app.startModal(handler);
  return true;
}

/** Marker nearest to a frame within a pixel tolerance. */
export function markerAt(frame: number, ppf: number, tolPx = 7): TimelineMarker | null {
  let best: TimelineMarker | null = null,
    bd = tolPx;
  for (const m of markers()) {
    const d = Math.abs(m.frame - frame) * ppf;
    if (d < bd) {
      bd = d;
      best = m;
    }
  }
  return best;
}

const markerName = (frame: number) => `F_${String(frame).padStart(2, '0')}`;

function selectMarker(ctx: OpContext, p: Record<string, unknown>) {
  const m = markerAt(p.frame as number, pixelsPerFrame());
  if (!p.extend) markers().forEach((o) => (o.select = false));
  if (!m) return p.extend ? ('CANCELLED' as const) : ('FINISHED' as const);
  m.select = p.extend ? !m.select : true;
  if (p.camera && m.camera && ctx.doc.objects[m.camera]) {
    ctx.doc.scene.camera = m.camera;
    app.changed('select');
  }
  return 'FINISHED' as const;
}

const pollUnlocked = () => unlocked();
const pollSel = () => unlocked() && selectedMarkers().length > 0;

registerOperators([
  {
    idname: 'marker.add',
    label: 'Add Time Marker',
    description: 'Add a marker at the current frame',
    poll: pollUnlocked,
    exec: (ctx) => {
      const s = ctx.doc.scene;
      const f = s.frame_current;
      if (s.timeline_markers.some((m) => m.frame === f)) return 'CANCELLED';
      s.timeline_markers.forEach((m) => (m.select = false));
      s.timeline_markers.push({ name: markerName(f), frame: f, select: true });
    },
  },
  {
    idname: 'marker.delete',
    label: 'Delete Markers',
    description: 'Delete the selected markers',
    props: [{ id: 'confirm', label: 'Confirm', type: 'bool', default: true, hidden: true }],
    poll: pollSel,
    exec: (ctx) => {
      ctx.doc.scene.timeline_markers = ctx.doc.scene.timeline_markers.filter((m) => !m.select);
    },
  },
  {
    idname: 'marker.select',
    label: 'Select Time Marker',
    description: 'Select the marker under the mouse (Shift extends, Ctrl also makes its camera active)',
    props: [
      { id: 'frame', label: 'Frame', type: 'float', default: 0, hidden: true },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
      { id: 'camera', label: 'Camera', type: 'bool', default: false },
    ],
    poll: pollUnlocked,
    invoke: (ctx, p) => {
      const ed = hoverEditor();
      if (!ed) return 'CANCELLED';
      p.frame = ed.view.xf(ed.local({ clientX: app.pointer.x, clientY: app.pointer.y }).x);
      return selectMarker(ctx, p);
    },
    exec: (ctx, p) => selectMarker(ctx, p),
  },
  {
    idname: 'marker.select_all',
    label: '(De)select all Markers',
    description: 'Change the selection of all markers',
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
    poll: () => unlocked() && markers().length > 0,
    exec: (_ctx, p) => {
      let a = p.action as string;
      if (a === 'TOGGLE') a = markers().some((m) => m.select) ? 'DESELECT' : 'SELECT';
      for (const m of markers()) m.select = a === 'SELECT' ? true : a === 'DESELECT' ? false : !m.select;
    },
  },
  {
    idname: 'marker.select_leftright',
    label: 'Select Markers Before/After Current Frame',
    description: 'Select the markers on one side of the current frame',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'LEFT',
        items: [
          ['LEFT', 'Before Current Frame'],
          ['RIGHT', 'After Current Frame'],
        ],
      },
      { id: 'extend', label: 'Extend Select', type: 'bool', default: false },
    ],
    poll: () => unlocked() && markers().length > 0,
    exec: (ctx, p) => {
      const f = ctx.doc.scene.frame_current;
      for (const m of markers()) {
        const hit = p.mode === 'LEFT' ? m.frame <= f : m.frame >= f;
        if (hit) m.select = true;
        else if (!p.extend) m.select = false;
      }
    },
  },
  {
    idname: 'marker.select_box',
    label: 'Marker Box Select',
    description: 'Select the markers inside a frame range (drag in the marker row)',
    props: [
      { id: 'xmin', label: 'From', type: 'float', default: 0, hidden: true },
      { id: 'xmax', label: 'To', type: 'float', default: 0, hidden: true },
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'SET',
        items: [
          ['SET', 'Set'],
          ['ADD', 'Extend'],
          ['SUB', 'Subtract'],
        ],
      },
    ],
    poll: () => unlocked() && !!hoverEditor(),
    invoke: (ctx, p) => {
      const ed = hoverEditor()!;
      app.startModal({
        label: 'Marker Box Select',
        cursor: 'crosshair',
        header: () => 'Box Select Markers: drag across the markers',
        onPointerDown: (e) => {
          if (e.button === 0)
            ed.boxGesture(e, (r, mode) => app.run('marker.select_box', { ...p, mode: mode === 'SET' ? p.mode : mode, xmin: ed.view.xf(r.x0), xmax: ed.view.xf(r.x1) }, { area: ctx.area, invoke: false }));
          return 'CANCELLED';
        },
        onKey: (e) => (e.key === 'Escape' ? 'CANCELLED' : true),
        cancel: () => {},
      });
      return 'RUNNING_MODAL';
    },
    exec: (_ctx, p) => {
      const a = Math.min(p.xmin as number, p.xmax as number),
        b = Math.max(p.xmin as number, p.xmax as number);
      for (const m of markers()) {
        const inside = m.frame >= a && m.frame <= b;
        if (p.mode === 'SET') m.select = inside;
        else if (inside) m.select = p.mode === 'ADD';
      }
    },
  },
  {
    idname: 'marker.duplicate',
    label: 'Duplicate Time Marker',
    description: 'Duplicate the selected markers and move the copies',
    props: [{ id: 'frames', label: 'Frames', type: 'int', default: 0 }],
    poll: pollSel,
    invoke: () => {
      const s = app.doc.scene;
      const sel = selectedMarkers();
      sel.forEach((m) => (m.select = false));
      const copies = sel.map((m) => ({ ...m, select: true }));
      s.timeline_markers.push(...copies);
      startMarkerMove(
        'Duplicate Marker',
        () => {
          s.timeline_markers = s.timeline_markers.filter((m) => !copies.includes(m));
          sel.forEach((m) => (m.select = true));
        },
        { idname: 'marker.duplicate', props: {} },
      );
      return 'RUNNING_MODAL';
    },
    exec: (_ctx, p) => {
      const s = app.doc.scene;
      const sel = selectedMarkers();
      sel.forEach((m) => (m.select = false));
      s.timeline_markers.push(...sel.map((m) => ({ ...m, frame: m.frame + (p.frames as number), select: true })));
    },
  },
  {
    idname: 'marker.rename',
    label: 'Rename Marker',
    description: 'Rename the first selected marker',
    props: [{ id: 'name', label: 'Name', type: 'string', default: 'RenamedMarker' }],
    poll: pollSel,
    invoke: () => {
      const m = selectedMarkers()[0];
      promptText('Rename Marker', m.name, (v) => v && app.run('marker.rename', { name: v }, { invoke: false }));
      return 'CANCELLED';
    },
    exec: (_ctx, p) => {
      const m = selectedMarkers()[0];
      if (!m || !p.name) return 'CANCELLED';
      m.name = String(p.name);
    },
  },
  {
    idname: 'marker.move',
    label: 'Move Time Marker',
    description: 'Move the selected markers',
    props: [{ id: 'frames', label: 'Frames', type: 'int', default: 0 }],
    poll: pollSel,
    invoke: () => (startMarkerMove('Move Marker', undefined, { idname: 'marker.move', props: {} }) ? 'RUNNING_MODAL' : 'CANCELLED'),
    exec: (_ctx, p) => {
      for (const m of selectedMarkers()) m.frame += p.frames as number;
    },
  },
  {
    idname: 'marker.camera_bind',
    label: 'Bind Camera to Markers',
    description: 'Switch to the active camera at the marker on the current frame (adding a marker when there is none)',
    poll: (ctx: OpContext) => unlocked() && (app.activeObject?.type === 'CAMERA' || !!ctx.doc.scene.camera),
    exec: (ctx) => {
      const s = ctx.doc.scene;
      const cam = app.activeObject?.type === 'CAMERA' ? app.activeObject : s.camera ? ctx.doc.objects[s.camera] : null;
      if (!cam) {
        app.report('ERROR', 'Select a camera to bind to a marker on this frame');
        return 'CANCELLED';
      }
      const f = s.frame_current;
      let m = s.timeline_markers.find((o) => o.frame === f);
      if (!m) {
        s.timeline_markers.forEach((o) => (o.select = false));
        m = { name: markerName(f), frame: f, select: true };
        s.timeline_markers.push(m);
      }
      m.camera = cam.id;
      s.camera = cam.id;
    },
  },
  {
    idname: 'screen.marker_jump',
    label: 'Jump to Marker',
    description: 'Jump to the previous or next marker',
    props: [{ id: 'next', label: 'Next Marker', type: 'bool', default: true }],
    undo: false,
    exec: (ctx, p) => {
      const f = ctx.doc.scene.frame_current;
      const frames = ctx.doc.scene.timeline_markers.map((m) => m.frame).sort((a, b) => a - b);
      const t = p.next ? frames.find((x) => x > f) : [...frames].reverse().find((x) => x < f);
      if (t === undefined) {
        app.report('INFO', 'No more markers to jump to in this direction');
        return 'CANCELLED';
      }
      app.setFrame(t);
    },
  },
  {
    idname: 'marker.lock_toggle',
    label: 'Lock Markers',
    description: 'Prevent markers from being selected, moved or deleted',
    internal: true,
    exec: (ctx) => {
      const ts = ctx.doc.scene.tool_settings;
      ts.lock_markers = !ts.lock_markers;
    },
  },
]);

/** The Marker menu of the animation editors and the Timeline. */
export function markerMenu(): MenuItem[] {
  return [
    { label: 'Lock Markers', checked: markersLocked(), op: 'marker.lock_toggle' },
    { separator: true },
    { label: 'Jump to Previous Marker', op: 'screen.marker_jump', props: { next: false } },
    { label: 'Jump to Next Marker', op: 'screen.marker_jump', props: { next: true } },
    { separator: true },
    { label: 'Bind Camera to Markers', op: 'marker.camera_bind', shortcut: 'Ctrl B' },
    { separator: true },
    {
      label: 'Select',
      submenu: () => [
        { label: 'All', op: 'marker.select_all', props: { action: 'SELECT' }, shortcut: 'A' },
        { label: 'None', op: 'marker.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
        { label: 'Invert', op: 'marker.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
        { separator: true },
        { label: 'Before Current Frame', op: 'marker.select_leftright', props: { mode: 'LEFT' }, shortcut: '[' },
        { label: 'After Current Frame', op: 'marker.select_leftright', props: { mode: 'RIGHT' }, shortcut: ']' },
      ],
    },
    { separator: true },
    { label: 'Move Marker', op: 'marker.move', shortcut: 'G' },
    { label: 'Rename Marker', op: 'marker.rename', shortcut: 'F2' },
    { separator: true },
    { label: 'Delete Marker', op: 'marker.delete', shortcut: 'X' },
    { label: 'Duplicate Marker', op: 'marker.duplicate', shortcut: 'Shift D' },
    { label: 'Add Marker', op: 'marker.add', shortcut: 'M' },
  ];
}

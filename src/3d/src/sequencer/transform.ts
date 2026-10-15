// Interactive strip transforms: Sequence Slide (G / drag), handle trims, Time Extend (E),
// Slip (S) and preview image transforms (G/R/S in the preview).
import { app } from '../app/app';
import type { Strip } from './types';
import { finalStart, finalEnd, setLeftHandle, setRightHandle, translateStrip, slip, inputCount, effectInputs, snapTargets, snapOffset, resolveOverlap, overlapsAny, isStill, activeAt, allStrips } from './strips';
import { seqList, isLocked, toolSettings, afterEdit, hoverSeq, type SeqEditorLike, seqEditor } from './context';
import { placementMatrix } from './gpu';
import { layoutTextStrip } from './text';
import { MAX_CHANNELS } from './types';
import { restartPlayback } from './audio';
import { moveKey } from './retime';

interface Snap {
  frame_start: number;
  frame_duration: number;
  frame_offset_start: number;
  frame_offset_end: number;
  channel: number;
}
const snap = (s: Strip): Snap => ({ frame_start: s.frame_start, frame_duration: s.frame_duration, frame_offset_start: s.frame_offset_start, frame_offset_end: s.frame_offset_end, channel: s.channel });
function restore(s: Strip, o: Snap) {
  const d = o.frame_start - s.frame_start;
  if (d) translateStrip(s, d); // keeps meta children in step
  Object.assign(s, o);
}

function numericKeys(state: { text: string }, e: KeyboardEvent): boolean {
  if (e.type !== 'keydown') return false;
  if (/^[0-9]$/.test(e.key) || (e.key === '-' && !state.text) || (e.key === '.' && !state.text.includes('.'))) state.text += e.key;
  else if (e.key === 'Backspace') state.text = state.text.slice(0, -1);
  else return false;
  return true;
}

function snapEnabled(e: { ctrlKey: boolean; metaKey: boolean }) {
  const on = app.doc.scene.tool_settings.use_snap_sequencer ?? true;
  return (e.ctrlKey || e.metaKey) ? !on : on;
}

export interface SlideOptions {
  label?: string;
  /** called when cancelled (e.g. duplicate removes its copies) */
  onCancel?: () => void;
  /** only these strips' handles (handle drag) */
  handleStrip?: Strip;
  handleSide?: 'LEFT' | 'RIGHT';
}

/** Sequence Slide / handle trim modal. Returns false if nothing can be transformed. */
export function startSlide(ed: SeqEditorLike, x0: number, y0: number, opts: SlideOptions = {}): boolean {
  const list = seqList();
  const all = allStrips(seqEditor().strips);
  const ts = toolSettings();
  let handleMode = !!opts.handleStrip;
  let targets: Strip[];
  if (opts.handleStrip) targets = isLocked(opts.handleStrip) ? [] : [opts.handleStrip];
  else {
    const sel = list.filter((s) => s.select && !isLocked(s));
    handleMode = sel.some((s) => s.select_left_handle || s.select_right_handle);
    targets = handleMode ? sel.filter((s) => (s.select_left_handle || s.select_right_handle) && !inputCount(s.type)) : sel;
    if (!handleMode) {
      // effects carry their inputs along
      for (const s of [...targets]) for (const i of effectInputs(all, s)) if (!targets.includes(i) && list.includes(i) && !isLocked(i)) targets.push(i);
    }
  }
  if (!targets.length) return false;
  const orig = new Map(targets.map((s) => [s, snap(s)]));
  const others = new Set(list.filter((s) => !targets.includes(s)));
  const markers = app.doc.scene.timeline_markers.map((m) => m.frame);
  const st = { text: '', df: 0, dc: 0 };
  const side = (s: Strip): 'LEFT' | 'RIGHT' | null => (opts.handleStrip ? opts.handleSide ?? null : s.select_left_handle ? 'LEFT' : s.select_right_handle ? 'RIGHT' : null);
  let lastEvent = { clientX: x0, clientY: y0, ctrlKey: false, metaKey: false };

  const apply = () => {
    for (const [s, o] of orig) restore(s, o);
    let df = Math.round((lastEvent.clientX - x0) / ed.ppf);
    const dc = handleMode ? 0 : Math.round(-(lastEvent.clientY - y0) / ed.chH);
    if (st.text && st.text !== '-') df = Math.round(Number(st.text)) || 0;
    else if (snapEnabled(lastEvent)) {
      const edges: number[] = [];
      for (const [s, o] of orig) {
        const a = o.frame_start + o.frame_offset_start,
          b = o.frame_start + o.frame_duration - o.frame_offset_end;
        const sd = side(s);
        if (!handleMode || sd === 'LEFT') edges.push(a + df);
        if (!handleMode || sd === 'RIGHT') edges.push(b + df);
      }
      const targetsF = snapTargets([...others], new Set(), { current: ts.snap_to_current_frame ? app.doc.scene.frame_current : undefined, markers: ts.snap_to_markers ? markers : [], ignoreMuted: ts.snap_ignore_muted, ignoreSound: ts.snap_ignore_sound });
      const d = snapOffset(edges, targetsF, ts.snap_distance / Math.max(1e-6, ed.ppf));
      if (d !== null) df += d;
    }
    st.df = df;
    st.dc = dc;
    for (const [s, o] of orig) {
      if (handleMode) {
        const sd = side(s);
        if (sd === 'LEFT') setLeftHandle(s, o.frame_start + o.frame_offset_start + df);
        else if (sd === 'RIGHT') setRightHandle(s, o.frame_start + o.frame_duration - o.frame_offset_end + df);
      } else {
        translateStrip(s, df);
        s.channel = Math.max(1, Math.min(MAX_CHANNELS, o.channel + dc));
      }
    }
    afterEdit();
    ed.invalid.clear();
    if (!handleMode) for (const s of targets) if (overlapsAny(list, s, new Set())) ed.invalid.add(s);
    app.changed('doc');
  };

  app.startModal({
    label: opts.label ?? (handleMode ? 'Trim Strips' : 'Move Strips'),
    cursor: handleMode ? 'ew-resize' : 'move',
    header: () => (handleMode ? `Sequence Slide: ${st.text ? st.text + '|' : st.df}` : `Sequence Slide: ${st.text ? st.text + '|' : st.df} (${st.df}, ${st.dc})`),
    status: () => [
      ['LMB', 'Confirm'],
      ['RMB', 'Cancel'],
      ['Ctrl', 'Toggle Snapping'],
    ],
    onPointerMove(e) {
      lastEvent = e;
      apply();
    },
    onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : e.button === 2 ? 'CANCELLED' : undefined),
    onPointerUp: (e) => (e.button === 0 && dragRelease ? 'FINISHED' : undefined),
    onKey(e) {
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      if (e.key === 'Control' || e.key === 'Meta') {
        lastEvent = { ...lastEvent, ctrlKey: e.type === 'keydown', metaKey: false };
        apply();
        return true;
      }
      if (numericKeys(st, e)) apply();
      return true;
    },
    cancel() {
      for (const [s, o] of orig) restore(s, o);
      afterEdit();
      ed.invalid.clear();
      opts.onCancel?.();
      app.changed('doc');
    },
    finish() {
      ed.invalid.clear();
      if (!handleMode) resolveOverlap(list, targets, ts.overlap_mode);
      afterEdit();
      restartPlayback();
    },
  });
  // drag (click-drag) transforms finish on release
  const dragRelease = pointerIsDown;
  apply();
  return true;
}

/** Whether the primary button is held (drag-started transforms confirm on release). */
let pointerIsDown = false;
addEventListener('pointerdown', (e) => e.button === 0 && (pointerIsDown = true), true);
addEventListener('pointerup', (e) => e.button === 0 && (pointerIsDown = false), true);

/** Time Extend (E): strips on the pointer's side of the playhead move; crossing ones extend. */
export function startExtend(ed: SeqEditorLike, x0: number): boolean {
  const list = seqList();
  const cur = app.doc.scene.frame_current;
  const sideRight = ed.pointerFrame(x0) >= cur;
  const sel = list.filter((s) => s.select && !isLocked(s) && !inputCount(s.type));
  const targets = sel.filter((s) => (sideRight ? finalEnd(s) > cur : finalStart(s) < cur));
  if (!targets.length) return false;
  const orig = new Map(targets.map((s) => [s, snap(s)]));
  const st = { text: '', df: 0 };
  let lx = x0;
  const apply = () => {
    for (const [s, o] of orig) restore(s, o);
    const df = st.text && st.text !== '-' ? Math.round(Number(st.text)) || 0 : Math.round((lx - x0) / ed.ppf);
    st.df = df;
    for (const [s] of orig) {
      const a = finalStart(s),
        b = finalEnd(s);
      if (sideRight) {
        if (a >= cur) translateStrip(s, df);
        else setRightHandle(s, b + df);
      } else {
        if (b <= cur) translateStrip(s, df);
        else setLeftHandle(s, a + df);
      }
    }
    afterEdit();
    app.changed('doc');
  };
  app.startModal({
    label: 'Time Extend',
    cursor: 'ew-resize',
    header: () => `Time Extend: ${st.text ? st.text + '|' : st.df}`,
    onPointerMove(e) {
      lx = e.clientX;
      apply();
    },
    onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : e.button === 2 ? 'CANCELLED' : undefined),
    onKey(e) {
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      if (numericKeys(st, e)) apply();
      return true;
    },
    cancel() {
      for (const [s, o] of orig) restore(s, o);
      afterEdit();
      app.changed('doc');
    },
    finish() {
      resolveOverlap(list, targets, toolSettings().overlap_mode);
      afterEdit();
      restartPlayback();
    },
  });
  return true;
}

/** Slip (S / Slip tool): move the content of selected strips under their handles. */
export function startSlip(ed: SeqEditorLike, x0: number, only?: Strip): boolean {
  const list = seqList();
  const targets = (only ? [only] : list.filter((s) => s.select)).filter((s) => !isLocked(s) && !isStill(s) && !inputCount(s.type));
  if (!targets.length) return false;
  const orig = new Map(targets.map((s) => [s, snap(s)]));
  const st = { text: '', df: 0 };
  let lx = x0;
  const apply = () => {
    for (const [s, o] of orig) restore(s, o);
    const df = st.text && st.text !== '-' ? Math.round(Number(st.text)) || 0 : Math.round((lx - x0) / ed.ppf);
    st.df = df;
    for (const s of targets) slip(s, df);
    afterEdit();
    app.changed('doc');
  };
  app.startModal({
    label: 'Slip Strips',
    cursor: 'ew-resize',
    header: () => `Slip Offset: ${st.text ? st.text + '|' : st.df}`,
    onPointerMove(e) {
      lx = e.clientX;
      apply();
    },
    onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : e.button === 2 ? 'CANCELLED' : undefined),
    onPointerUp: (e) => (e.button === 0 && dragRelease ? 'FINISHED' : undefined),
    onKey(e) {
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      if (numericKeys(st, e)) apply();
      return true;
    },
    cancel() {
      for (const [s, o] of orig) restore(s, o);
      afterEdit();
      app.changed('doc');
    },
    finish() {
      restartPlayback();
    },
  });
  const dragRelease = pointerIsDown;
  return true;
}

/** Drag a retiming key: the segment before it speeds up or slows down, later content follows. */
export function startRetimingKeyMove(ed: SeqEditorLike, s: Strip, index: number, x0: number): boolean {
  if (!s.retiming_keys || index <= 0) return false;
  const orig = { keys: s.retiming_keys.map((k) => ({ ...k })), dur: s.frame_duration, oe: s.frame_offset_end, os: s.frame_offset_start };
  const st = { text: '', df: 0 };
  let lx = x0;
  const reset = () => {
    s.retiming_keys = orig.keys.map((k) => ({ ...k }));
    s.frame_duration = orig.dur;
    s.frame_offset_end = orig.oe;
    s.frame_offset_start = orig.os;
  };
  const apply = () => {
    reset();
    const df = st.text && st.text !== '-' ? Math.round(Number(st.text)) || 0 : Math.round((lx - x0) / ed.ppf);
    st.df = df;
    moveKey(s, index, df);
    afterEdit();
    app.changed('doc');
  };
  app.startModal({
    label: 'Move Retiming Key',
    cursor: 'ew-resize',
    header: () => `Retiming Key: ${st.text ? st.text + '|' : st.df}`,
    onPointerMove(e) {
      lx = e.clientX;
      apply();
    },
    onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : e.button === 2 ? 'CANCELLED' : undefined),
    onPointerUp: (e) => (e.button === 0 && dragRelease ? 'FINISHED' : undefined),
    onKey(e) {
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      if (numericKeys(st, e)) apply();
      return true;
    },
    cancel() {
      reset();
      afterEdit();
      app.changed('doc');
    },
    finish() {
      resolveOverlap(seqList(), [s], toolSettings().overlap_mode);
      afterEdit();
      restartPlayback();
    },
  });
  const dragRelease = pointerIsDown;
  return true;
}

// ---------------------------------------------------------------------------
// preview image transforms

/** Corners (output px, y up) of a strip's image in the frame. */
export function stripImageCorners(s: Strip, W: number, H: number): [number, number][] {
  let w = s.orig_width || W,
    h = s.orig_height || H;
  const cr = s.crop;
  let x0 = cr.min_x,
    y0 = cr.min_y,
    x1 = w - cr.max_x,
    y1 = h - cr.max_y;
  if (s.type === 'TEXT') {
    const L = layoutTextStrip(s, W, H, 1);
    w = W;
    h = H;
    x0 = L.left;
    x1 = L.right;
    y0 = L.bottom;
    y1 = L.top;
  } else if (!s.orig_width) {
    w = W;
    h = H;
  }
  const M = placementMatrix(W, H, w, h, s.transform, 1);
  const tf = (x: number, y: number): [number, number] => [M[0] * x + M[3] * y + M[6], M[1] * x + M[4] * y + M[7]];
  return [tf(x0, y0), tf(x1, y0), tf(x1, y1), tf(x0, y1)];
}

export function previewStrips(frame: number): Strip[] {
  return seqList()
    .filter((s) => s.type !== 'SOUND' && !s.mute && activeAt(s, frame))
    .sort((a, b) => b.channel - a.channel);
}

export function pointInPoly(x: number, y: number, poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i],
      [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

export type PreviewMode = 'TRANSLATE' | 'ROTATE' | 'RESIZE';

/** Move / rotate / scale the selected strips' images in the preview. */
export function startPreviewTransform(ed: SeqEditorLike, mode: PreviewMode, cx: number, cy: number, drag = false): boolean {
  const frame = app.doc.scene.frame_current;
  const r = app.doc.scene.render;
  const W = r.resolution_x,
    H = r.resolution_y;
  const targets = previewStrips(frame).filter((s) => s.select && !isLocked(s));
  if (!targets.length) return false;
  const orig = new Map(targets.map((s) => [s, { ...s.transform, origin: [...s.transform.origin] as [number, number] }]));
  // pivot: median of image centres
  let px = 0,
    py = 0;
  for (const s of targets) {
    const c = stripImageCorners(s, W, H);
    px += c.reduce((a, p) => a + p[0], 0) / 4;
    py += c.reduce((a, p) => a + p[1], 0) / 4;
  }
  px /= targets.length;
  py /= targets.length;
  const [fx0, fy0] = ed.previewToFrame(cx, cy);
  const st = { text: '', value: '' };
  let last = { x: cx, y: cy };
  const apply = () => {
    const [fx, fy] = ed.previewToFrame(last.x, last.y);
    const num = st.text && st.text !== '-' ? Number(st.text) : null;
    for (const [s, o] of orig) {
      Object.assign(s.transform, o, { origin: [...o.origin] });
      if (mode === 'TRANSLATE') {
        const dx = num ?? Math.round(fx - fx0),
          dy = num !== null ? 0 : Math.round(fy - fy0);
        s.transform.offset_x = o.offset_x + dx;
        s.transform.offset_y = o.offset_y + dy;
        st.value = `${dx} px, ${dy} px`;
      } else if (mode === 'ROTATE') {
        const a0 = Math.atan2(fy0 - py, fx0 - px),
          a1 = Math.atan2(fy - py, fx - px);
        const d = num !== null ? (num * Math.PI) / 180 : a1 - a0;
        s.transform.rotation = o.rotation + d;
        // rotate the image centre around the pivot
        const c = stripImageCorners({ ...s, transform: o } as Strip, W, H);
        const ccx = c.reduce((a, p) => a + p[0], 0) / 4,
          ccy = c.reduce((a, p) => a + p[1], 0) / 4;
        const rx = ccx - px,
          ry = ccy - py;
        const nx = px + rx * Math.cos(d) - ry * Math.sin(d),
          ny = py + rx * Math.sin(d) + ry * Math.cos(d);
        s.transform.offset_x = o.offset_x + (nx - ccx);
        s.transform.offset_y = o.offset_y + (ny - ccy);
        st.value = `${((d * 180) / Math.PI).toFixed(1)}°`;
      } else {
        const d0 = Math.hypot(fx0 - px, fy0 - py) || 1;
        const k = num ?? Math.hypot(fx - px, fy - py) / d0;
        s.transform.scale_x = o.scale_x * k;
        s.transform.scale_y = o.scale_y * k;
        const c = stripImageCorners({ ...s, transform: o } as Strip, W, H);
        const ccx = c.reduce((a, p) => a + p[0], 0) / 4,
          ccy = c.reduce((a, p) => a + p[1], 0) / 4;
        s.transform.offset_x = o.offset_x + (px + (ccx - px) * k - ccx);
        s.transform.offset_y = o.offset_y + (py + (ccy - py) * k - ccy);
        st.value = `${k.toFixed(3)}`;
      }
    }
    app.changed('doc');
  };
  app.startModal({
    label: mode === 'TRANSLATE' ? 'Move' : mode === 'ROTATE' ? 'Rotate' : 'Resize',
    cursor: mode === 'TRANSLATE' ? 'move' : 'crosshair',
    header: () => `${mode === 'TRANSLATE' ? 'Move' : mode === 'ROTATE' ? 'Rotate' : 'Scale'}: ${st.text ? st.text + '|' : st.value}`,
    onPointerMove(e) {
      last = { x: e.clientX, y: e.clientY };
      apply();
    },
    onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : e.button === 2 ? 'CANCELLED' : undefined),
    onPointerUp: (e) => (e.button === 0 && drag ? 'FINISHED' : undefined),
    onKey(e) {
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      if (numericKeys(st, e)) apply();
      return true;
    },
    cancel() {
      for (const [s, o] of orig) Object.assign(s.transform, o);
      app.changed('doc');
    },
  });
  apply();
  return true;
}

export { hoverSeq };

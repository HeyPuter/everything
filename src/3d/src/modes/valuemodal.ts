// Small modal for single-value interactive edits in edit modes (curve radius / tilt, bone
// envelope distance …): the value follows the mouse around a pivot, numbers can be typed, Ctrl
// snaps, Shift gives precision. The redo panel re-runs the operator's exec with the final value.
import type { Vector3 } from 'three';
import { app } from '../app/app';
import { activeView3D } from '../editors/view3d/view3d';

export interface ValueModalOptions {
  label: string;
  /** ANGLE: rotation of the mouse around the pivot (radians); SCALE: distance ratio; OFFSET: distance difference */
  kind: 'ANGLE' | 'SCALE' | 'OFFSET';
  pivot: Vector3;
  event?: { x: number; y: number };
  apply(value: number): void;
  restore(): void;
  redo(value: number): { idname: string; props: Record<string, unknown> };
  /** status text, e.g. "Tilt: 12.5°" */
  text(value: number, typed: string): string;
  /** finish when the mouse button that started a tool drag is released */
  releaseConfirm?: boolean;
}

export function startValueModal(o: ValueModalOptions): boolean {
  const v = activeView3D();
  if (!v) return false;
  const rect = v.el.getBoundingClientRect();
  const pv = v.project(o.pivot.clone());
  const cx = pv.x + rect.left,
    cy = pv.y + rect.top;
  const start = o.event ?? { ...app.pointer };
  let lastAngle = Math.atan2(start.y - cy, start.x - cx);
  let angle = 0;
  const d0 = Math.max(4, Math.hypot(start.x - cx, start.y - cy));
  let value = o.kind === 'SCALE' ? 1 : 0;
  let typed = '';
  let precisionBase: { raw: number; val: number } | null = null;
  const fromMouse = (e: PointerEvent) => {
    if (o.kind === 'ANGLE') {
      const a = Math.atan2(e.clientY - cy, e.clientX - cx);
      let d = a - lastAngle;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      lastAngle = a;
      angle += d * (e.shiftKey ? 0.1 : 1);
      // screen y points down: counter-clockwise on screen is a positive angle
      let val = -angle;
      if (e.ctrlKey) val = Math.round(val / (Math.PI / 36)) * (Math.PI / 36);
      return val;
    }
    const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
    let raw = o.kind === 'SCALE' ? dist / d0 : (dist - d0) / Math.max(1, Math.hypot(rect.width, rect.height) / 8);
    if (e.shiftKey) {
      precisionBase ??= { raw, val: value };
      raw = precisionBase.val + (raw - precisionBase.raw) * 0.1;
    } else precisionBase = null;
    if (e.ctrlKey) raw = Math.round(raw * 10) / 10;
    return raw;
  };
  const set = (val: number) => {
    value = val;
    o.restore();
    o.apply(value);
    app.changed('doc', 'geometry');
  };
  const handler = {
    label: o.label,
    header: () => o.text(value, typed),
    onPointerMove(e: PointerEvent) {
      if (typed) return;
      set(fromMouse(e));
    },
    onPointerDown(e: PointerEvent) {
      return e.button === 0 ? ('FINISHED' as const) : ('CANCELLED' as const);
    },
    onPointerUp(e: PointerEvent) {
      return o.releaseConfirm && e.button === 0 ? ('FINISHED' as const) : undefined;
    },
    onKey(e: KeyboardEvent) {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Escape') return 'CANCELLED' as const;
      if (e.key === 'Enter') return 'FINISHED' as const;
      if (/^[0-9.\-]$/.test(e.key) || e.key === 'Backspace') {
        typed = e.key === 'Backspace' ? typed.slice(0, -1) : typed + e.key;
        const n = parseFloat(typed);
        if (Number.isFinite(n)) set(o.kind === 'ANGLE' ? (n * Math.PI) / 180 : n);
        else set(o.kind === 'SCALE' ? 1 : 0);
        app.changed('ui');
      }
      return true;
    },
    cancel() {
      o.restore();
      app.changed('doc', 'geometry');
    },
    finish() {
      handler.redoOp = o.redo(value);
    },
    redoOp: undefined as { idname: string; props: Record<string, unknown> } | undefined,
  };
  app.startModal(handler);
  return true;
}

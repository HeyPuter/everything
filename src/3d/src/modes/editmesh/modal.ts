// A small interactive "drag a value" modal for edit-mesh tools that recompute their result from a
// snapshot (offset edge loops, randomize, …). Mouse movement or typed digits set the value; the
// operator's exec reproduces the result from the final props (Adjust Last Operation).
import { app } from '../../app/app';
import { activeView3D } from '../../editors/view3d/view3d';
import { MeshEdit } from './meshedit';
import { editMeshObjects } from './context';

export interface ValueModalOptions {
  label: string;
  idname: string;
  /** property that receives the value */
  prop: string;
  /** other props passed through to the redo operator */
  props?: Record<string, unknown>;
  initial: number;
  min?: number;
  max?: number;
  /** value change per pixel of horizontal mouse movement */
  perPixel: number;
  /** text shown before the value in the header */
  name: string;
  /** apply the tool with a value to a fresh copy; return false when nothing applies */
  apply: (m: MeshEdit, value: number, objectIndex: number) => boolean;
  unit?: string;
}

export function startValueModal(o: ValueModalOptions, event?: { x: number }): 'RUNNING_MODAL' | 'CANCELLED' {
  const v = activeView3D();
  if (!v) return 'CANCELLED';
  const snaps = editMeshObjects().map(({ me }) => ({ me, m: MeshEdit.from(me) }));
  // check the tool applies at all
  if (!snaps.some((s, i) => o.apply(s.m.clone(), o.initial, i))) return 'CANCELLED';
  const x0 = event?.x ?? app.pointer.x;
  let value = o.initial;
  let typed = '';
  const clamp = (x: number) => Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, x));
  const apply = () => {
    snaps.forEach((s, i) => {
      const c = s.m.clone();
      if (o.apply(c, value, i)) c.write(s.me);
    });
    app.changed('geometry');
  };
  const fmt = (x: number) => x.toFixed(4).replace(/\.?0+$/, '') || '0';
  app.startModal({
    label: o.label,
    header: () => `${o.name}: ${typed ? typed + '|' : fmt(value)}${o.unit ?? ''}`,
    status: () => [['LMB', 'Confirm'], ['RMB', 'Cancel'], ['Ctrl', 'Snap'], ['Shift', 'Precision']],
    onPointerMove(e) {
      if (typed) return;
      let x = o.initial + (e.clientX - x0) * o.perPixel * (e.shiftKey ? 0.1 : 1);
      if (e.ctrlKey) x = Math.round(x * 10) / 10;
      value = clamp(x);
      apply();
    },
    onPointerDown(e) {
      return e.button === 0 ? 'FINISHED' : e.button === 2 ? 'CANCELLED' : undefined;
    },
    onKey(e) {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      if (/^[0-9.]$/.test(e.key) || (e.key === '-' && !typed)) typed += e.key;
      else if (e.key === 'Backspace') typed = typed.slice(0, -1);
      else return true;
      const n = parseFloat(typed);
      value = clamp(Number.isFinite(n) ? n : o.initial);
      apply();
      return true;
    },
    cancel() {
      for (const s of snaps) s.m.write(s.me);
      app.changed('geometry');
    },
    finish() {
      this.redoOp = { idname: o.idname, props: { ...(o.props ?? {}), [o.prop]: value } };
    },
  });
  apply();
  void v;
  return 'RUNNING_MODAL';
}

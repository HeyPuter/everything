// Material slots in curve and text Edit Mode: Assign / Select / Deselect act on the splines of
// the selected control points, or on the selected characters of a text object.
import { app, onAppReady, operators, registerOperator, type OpContext } from '../../app/app';
import type { CurveData } from '../../data/types';
import { inCurveEdit, activeCurve } from './curve';
import { inTextEdit, activeText, textState } from '../text/text';
import { formats } from '../text/textops';
import * as K from './curveops';

const ours = () => inCurveEdit() || inTextEdit();

function textRange(): [number, number] | null {
  const st = textState();
  if (!st || st.anchor === null || st.anchor === st.caret) return null;
  return [Math.min(st.anchor, st.caret), Math.max(st.anchor, st.caret)];
}

function splinesWithSelection(cu: CurveData) {
  return cu.splines.filter((sp) => [...Array(K.pointCount(sp)).keys()].some((i) => K.isSel(sp, i)));
}

function assign(ctx: OpContext) {
  const slot = app.activeObject?.active_material_index ?? 0;
  if (inCurveEdit()) {
    const sps = splinesWithSelection(activeCurve()!.cu);
    if (!sps.length) return 'CANCELLED' as const;
    for (const sp of sps) sp.material_index = slot;
  } else {
    const r = textRange();
    if (!r) return 'CANCELLED' as const;
    const f = formats(activeText()!.cu);
    for (let i = r[0]; i < r[1]; i++) f[i].material_index = slot;
  }
  void ctx;
  app.changed('doc', 'geometry');
  return 'FINISHED' as const;
}

function select(on: boolean) {
  const slot = app.activeObject?.active_material_index ?? 0;
  if (!inCurveEdit()) return 'CANCELLED' as const;
  for (const sp of activeCurve()!.cu.splines) if ((sp.material_index ?? 0) === slot) for (let i = 0; i < K.pointCount(sp); i++) K.setSel(sp, i, on);
  return 'FINISHED' as const;
}

onAppReady(() => {
  const wrap = (id: string, exec: (ctx: OpContext) => 'FINISHED' | 'CANCELLED', poll: () => boolean = ours) => {
    const prev = operators.get(id);
    if (!prev) return;
    registerOperator({
      ...prev,
      poll: (ctx) => poll() || (!!prev.poll && prev.poll(ctx)),
      exec: (ctx, p) => (poll() ? exec(ctx) : prev.exec ? prev.exec(ctx, p) : 'CANCELLED'),
    });
  };
  wrap('object.material_slot_assign', assign);
  wrap('object.material_slot_select', () => select(true), inCurveEdit);
  wrap('object.material_slot_deselect', () => select(false), inCurveEdit);
});

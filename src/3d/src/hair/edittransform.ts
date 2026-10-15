// Radius (Alt S) and Tilt (Ctrl T) of the selected control points in Curves Edit Mode. Both
// chain onto the curve-object versions and only take over while a Curves object is edited.
import { Vector3 } from 'three';
import { onAppReady, operators, registerOperator, type OpContext } from '../app/app';
import { transformModes } from '../modes/transformmodes';
import { startValueModal } from '../modes/valuemodal';
import { activeHair, inCurvesEdit, worldOf } from './common';
import { floatAttr, setAttr, DEFAULT_RADIUS } from './data';
import { selectedPointMask } from './edit';

function snapshot(name: 'radius' | 'tilt') {
  const a = activeHair();
  if (!a) return null;
  const pm = selectedPointMask(a.hc);
  if (!pm.some((x) => x)) return null;
  const orig = floatAttr(a.hc, name, 'POINT', name === 'radius' ? DEFAULT_RADIUS : 0).slice();
  const w = worldOf(a.ob);
  const pivot = new Vector3();
  let n = 0;
  for (let i = 0; i < pm.length; i++)
    if (pm[i]) {
      pivot.add(new Vector3().fromArray(a.hc.positions, i * 3).applyMatrix4(w));
      n++;
    }
  pivot.multiplyScalar(1 / n);
  const set = (f: (v: number) => number) => {
    const out = orig.slice();
    for (let i = 0; i < pm.length; i++) if (pm[i]) out[i] = f(orig[i]);
    setAttr(a.hc, name, 'POINT', 'FLOAT', out);
  };
  return { pivot, set, restore: () => setAttr(a.hc, name, 'POINT', 'FLOAT', orig) };
}

const hasSel = () => {
  const a = activeHair();
  return !!a && selectedPointMask(a.hc).some((x) => x);
};

const prevRadius = transformModes.CURVE_SHRINKFATTEN;
transformModes.CURVE_SHRINKFATTEN = {
  label: prevRadius?.label ?? 'Curve Radius',
  poll: (ctx: OpContext) => (inCurvesEdit() ? hasSel() : (prevRadius?.poll(ctx) ?? false)),
  invoke: (ctx, p) => {
    if (!inCurvesEdit()) return prevRadius ? prevRadius.invoke(ctx, p) : 'CANCELLED';
    const s = snapshot('radius');
    if (!s) return 'CANCELLED';
    const ok = startValueModal({
      label: 'Radius',
      kind: 'SCALE',
      pivot: s.pivot,
      event: ctx.event,
      apply: (v) => s.set((r) => Math.max(0, r * v)),
      restore: s.restore,
      redo: (v) => ({ idname: 'transform.transform', props: { mode: 'CURVE_SHRINKFATTEN', value: v } }),
      text: (v, t) => `Radius: ${t ? t + '|' : v.toFixed(3)}`,
      releaseConfirm: !!p.release_confirm,
    });
    return ok ? 'RUNNING_MODAL' : 'CANCELLED';
  },
  exec: (ctx, p) => {
    if (!inCurvesEdit()) return prevRadius ? prevRadius.exec(ctx, p) : 'CANCELLED';
    const s = snapshot('radius');
    if (!s) return 'CANCELLED';
    s.set((r) => Math.max(0, r * ((p.value as number) || 1)));
  },
};

onAppReady(() => {
  const prev = operators.get('transform.tilt');
  if (!prev) return;
  registerOperator({
    ...prev,
    poll: (ctx) => (inCurvesEdit() ? hasSel() : !prev.poll || prev.poll(ctx)),
    invoke: (ctx, p) => {
      if (!inCurvesEdit()) return prev.invoke ? prev.invoke(ctx, p) : prev.exec ? prev.exec(ctx, p) : 'CANCELLED';
      const s = snapshot('tilt');
      if (!s) return 'CANCELLED';
      const ok = startValueModal({
        label: 'Tilt',
        kind: 'ANGLE',
        pivot: s.pivot,
        event: ctx.event,
        apply: (v) => s.set((t) => t + v),
        restore: s.restore,
        redo: (v) => ({ idname: 'transform.tilt', props: { value: v } }),
        text: (v, t) => `Tilt: ${t ? t + '|' : ((v * 180) / Math.PI).toFixed(2) + '°'}`,
        releaseConfirm: !!p.release_confirm,
      });
      return ok ? 'RUNNING_MODAL' : 'CANCELLED';
    },
    exec: (ctx, p) => {
      if (!inCurvesEdit()) return prev.exec ? prev.exec(ctx, p) : 'CANCELLED';
      const s = snapshot('tilt');
      if (!s) return 'CANCELLED';
      s.set((t) => t + (p.value as number));
    },
  });
});

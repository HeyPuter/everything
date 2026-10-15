// Bone tab: the pose bone's Inverse Kinematics settings (stretch, locks, stiffness and limits), shown
// after the Relations panel while posing.
import { h, type Child, type VNode } from '../ui/h';
import { app, onAppReady } from '../app/app';
import { propertiesTabs } from '../editors/properties/properties';
import { panel, numberField } from '../ui/widgets';
import { num, splitRow } from '../ui/props';
import type { ObjectData, PoseBone } from '../data/types';

type PB = PoseBone & Record<string, unknown>;

function axisBlock(pb: PB, a: 'x' | 'y' | 'z'): Child {
  const A = a.toUpperCase();
  const lock = !!pb[`lock_ik_${a}`];
  const limit = !!pb[`use_ik_limit_${a}`];
  const set = (k: string, v: unknown, label: string) => {
    pb[k] = v;
    app.pushUndo(label);
    app.changed('doc');
  };
  const check = (k: string, label: string, value: boolean, disabled = false) =>
    h('label', { class: 'checkbox', style: { padding: '0 4px' } }, h('input', { type: 'checkbox', checked: value, disabled, onchange: (e: Event) => set(k, (e.target as HTMLInputElement).checked, label) }), label);
  return [
    splitRow(`Lock IK ${A}`, check(`lock_ik_${a}`, 'Lock', lock)),
    num(pb, `ik_stiffness_${a}`, 'Stiffness', { min: 0, max: 0.99, slider: true, disabled: lock }),
    splitRow(`Limit ${A}`, check(`use_ik_limit_${a}`, 'Limit', limit, lock)),
    limit && !lock
      ? splitRow(
          '',
          h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px' } },
            numberField({ id: `ikmin.${a}`, label: 'Min', value: (pb[`ik_min_${a}`] as number) ?? 0, unit: 'angle', min: -Math.PI, max: 0, set: (v, final) => ((pb[`ik_min_${a}`] = v), app.changed('doc'), final && app.pushUndo('Change IK Limit')) }),
            numberField({ id: `ikmax.${a}`, label: 'Max', value: (pb[`ik_max_${a}`] as number) ?? 0, unit: 'angle', min: 0, max: Math.PI, set: (v, final) => ((pb[`ik_max_${a}`] = v), app.changed('doc'), final && app.pushUndo('Change IK Limit')) }),
          ),
        )
      : null,
  ];
}

function ikPanel(ob: ObjectData, name: string): Child {
  const pb = ob.pose?.[name] as PB | undefined;
  if (!pb) return null;
  return panel('bone-ik', 'Inverse Kinematics', () => [num(pb, 'ik_stretch', 'IK Stretch', { min: 0, max: 1, slider: true }), axisBlock(pb, 'x'), axisBlock(pb, 'y'), axisBlock(pb, 'z')], { closed: true });
}

onAppReady(() => {
  const tab = propertiesTabs.find((t) => t.id === 'BONE');
  if (!tab) return;
  const prev = tab.draw;
  tab.draw = (p) => {
    const out = prev(p);
    const ob = app.activeObject;
    const arm = ob?.type === 'ARMATURE' && ob.data ? app.doc.armatures[ob.data] : undefined;
    if (!ob || !arm?.active_bone || app.doc.mode === 'EDIT' || !Array.isArray(out)) return out;
    const extra = ikPanel(ob, arm.active_bone);
    const i = out.findIndex((c) => (c as VNode | null)?.key === 'bone-relations');
    const list = out.slice();
    list.splice(i >= 0 ? i + 1 : list.length, 0, extra);
    return list;
  };
});

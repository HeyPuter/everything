// Rigid Body Constraint panels: limits, springs and motor settings per constraint type.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { panel, checkbox, numberField } from '../ui/widgets';
import { num, splitRow } from '../ui/props';
import type { RigidBodyConstraintData } from './types';
import { rbcDefaults } from './rbjoints';

type R = Record<string, unknown>;
const KEYS = ['x', 'y', 'z'] as const;

const set = (c: R, k: string, v: unknown, label: string) => {
  c[k] = v;
  app.pushUndo(label);
  app.changed('doc');
};

/** "X Axis [x]  lower  upper" row. */
function limitRow(c: R, kind: 'lin' | 'ang', a: (typeof KEYS)[number]): Child {
  const use = `use_limit_${kind}_${a}`,
    lo = `limit_${kind}_${a}_lower`,
    hi = `limit_${kind}_${a}_upper`;
  const unit = kind === 'ang' ? 'angle' : 'distance';
  const on = !!c[use];
  const field = (k: string, label: string) =>
    numberField({ id: `rbc.${k}`, label, value: (c[k] as number) ?? 0, unit, disabled: !on, set: (v, final) => ((c[k] = v), app.changed('doc'), final && app.pushUndo('Change Limit')) });
  return [
    h('div', { class: 'split-row check' }, h('div', { class: 'sr-label' }), h('div', { class: 'sr-value' }, checkbox(`rbc.${use}`, `${kind === 'ang' ? `${a.toUpperCase()} Angle` : `${a.toUpperCase()} Axis`}`, on, (v) => set(c, use, v, 'Toggle Limit'))), h('span', { class: 'decorator-space' })),
    splitRow('', h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px' } }, field(lo, 'Lower'), field(hi, 'Upper'))),
  ];
}

function springRows(c: R, kind: 'lin' | 'ang', a: (typeof KEYS)[number]): Child {
  const sfx = kind === 'ang' ? `ang_${a}` : a;
  const use = `use_spring_${sfx}`;
  const on = !!c[use];
  return [
    h('div', { class: 'split-row check' }, h('div', { class: 'sr-label' }), h('div', { class: 'sr-value' }, checkbox(`rbc.${use}`, `${a.toUpperCase()} ${kind === 'ang' ? 'Angle' : 'Axis'}`, on, (v) => set(c, use, v, 'Toggle Spring'))), h('span', { class: 'decorator-space' })),
    num(c, `spring_stiffness_${sfx}`, 'Stiffness', { min: 0, max: 1e6, softMax: 100, disabled: !on }),
    num(c, `spring_damping_${sfx}`, 'Damping', { min: 0, max: 1, slider: true, disabled: !on }),
  ];
}

function motorRows(c: R, kind: 'lin' | 'ang'): Child {
  const use = `use_motor_${kind}`;
  const on = !!c[use];
  return [
    h('div', { class: 'split-row check' }, h('div', { class: 'sr-label' }), h('div', { class: 'sr-value' }, checkbox(`rbc.${use}`, 'Enable', on, (v) => set(c, use, v, 'Toggle Motor'))), h('span', { class: 'decorator-space' })),
    num(c, `motor_${kind}_target_velocity`, 'Target Velocity', { min: -1000, max: 1000, softMin: -100, softMax: 100, unit: kind === 'ang' ? 'angle' : 'distance', disabled: !on }),
    num(c, `motor_${kind}_max_impulse`, 'Max Impulse', { min: 0, max: 1000, softMax: 100, disabled: !on }),
  ];
}

/** Type-specific panels of a rigid body constraint. */
export function rbcTypePanels(c: RigidBodyConstraintData, id: string): Child {
  const r = c as unknown as R;
  // fill settings missing from older files (keeps object identity for the widgets)
  for (const [k, v] of Object.entries(rbcDefaults())) if (r[k] === undefined) r[k] = v;
  const out: Child[] = [];
  const lin = c.type === 'SLIDER' || c.type === 'PISTON' ? ['x'] : c.type === 'GENERIC' || c.type === 'GENERIC_SPRING' ? KEYS : [];
  const ang = c.type === 'HINGE' ? ['z'] : c.type === 'PISTON' ? ['x'] : c.type === 'GENERIC' || c.type === 'GENERIC_SPRING' ? KEYS : [];
  if (lin.length || ang.length)
    out.push(
      panel(`ph-rbc-lim-${id}`, 'Limits', () => [
        lin.length ? panel(`ph-rbc-liml-${id}`, 'Linear', () => lin.map((a) => limitRow(r, 'lin', a as 'x')), { sub: true }) : null,
        ang.length ? panel(`ph-rbc-lima-${id}`, 'Angular', () => ang.map((a) => limitRow(r, 'ang', a as 'x')), { sub: true }) : null,
      ], { sub: true }),
    );
  if (c.type === 'MOTOR')
    out.push(
      panel(`ph-rbc-mot-${id}`, 'Motor', () => [panel(`ph-rbc-mota-${id}`, 'Angular', () => motorRows(r, 'ang'), { sub: true }), panel(`ph-rbc-motl-${id}`, 'Linear', () => motorRows(r, 'lin'), { sub: true })], { sub: true }),
    );
  if (c.type === 'GENERIC_SPRING')
    out.push(
      panel(`ph-rbc-spr-${id}`, 'Springs', () => [
        panel(`ph-rbc-sprl-${id}`, 'Linear', () => KEYS.map((a) => springRows(r, 'lin', a)), { sub: true }),
        panel(`ph-rbc-spra-${id}`, 'Angular', () => KEYS.map((a) => springRows(r, 'ang', a)), { sub: true }),
      ], { sub: true }),
    );
  return out;
}

// Data-bound property widgets for property-split layouts (label column + value).
import { h, type Child } from './h';
import { app } from '../app/app';
import { icon } from './icons';
import { numberField, checkbox, enumMenu, colorSwatch, textField, decorator, type Unit, type EnumItem } from './widgets';
import type { ObjectData } from '../data/types';
import { keyState, keyProperty } from '../anim/keyframes';

const ids = new WeakMap<object, string>();
let n = 0;
export function oid(o: object): string {
  let id = ids.get(o);
  if (!id) {
    id = (o as { id?: string }).id ?? `o${++n}`;
    ids.set(o, id);
  }
  return id;
}

export interface PropOpts {
  unit?: Unit;
  min?: number;
  max?: number;
  softMin?: number;
  softMax?: number;
  step?: number;
  precision?: number;
  int?: boolean;
  slider?: boolean;
  /** object + data path for keyframe decorators */
  anim?: { ob: ObjectData; path: string; index?: number };
  /** called after a change (e.g. to invalidate caches) */
  onChange?: () => void;
  disabled?: boolean;
  tip?: string;
  undo?: string;
  noDecorator?: boolean;
}

function commit(label: string, final: boolean, o?: PropOpts) {
  o?.onChange?.();
  app.changed('doc');
  if (final) app.pushUndo(o?.undo ?? label);
}

/** Right-click menu of an animatable property's decorator (set by the animation module). */
export const propertyAnimMenuHook: { open: ((e: MouseEvent, ob: ObjectData, path: string, index: number) => void) | null } = { open: null };

function deco(o?: PropOpts): Child {
  if (o?.noDecorator) return null;
  if (!o?.anim) return h('span', { class: 'decorator-space' });
  const st = keyState(app.doc, o.anim.ob, o.anim.path, o.anim.index ?? -1);
  const a = o.anim;
  return decorator(
    st,
    () => {
      keyProperty(app.doc, a.ob, a.path, a.index ?? -1);
      app.pushUndo('Insert Keyframe');
      app.changed('doc');
    },
    propertyAnimMenuHook.open ? (e: MouseEvent) => propertyAnimMenuHook.open!(e, a.ob, a.path, a.index ?? -1) : undefined,
  );
}

function animState(o?: PropOpts) {
  if (!o?.anim) return null;
  const st = keyState(app.doc, o.anim.ob, o.anim.path, o.anim.index ?? -1);
  return st === 'none' ? null : st;
}

export function splitRow(label: string, content: Child, decoration: Child = h('span', { class: 'decorator-space' }), className = '') {
  return h('div', { class: `split-row ${className}` }, h('div', { class: 'sr-label' }, label), h('div', { class: 'sr-value' }, content), decoration);
}

export function num<T extends object>(owner: T, key: keyof T & string, label: string, o: PropOpts = {}) {
  const value = owner[key] as unknown as number;
  return splitRow(
    label,
    numberField({
      id: `${oid(owner)}.${key}`,
      value,
      unit: o.unit,
      min: o.min,
      max: o.max,
      softMin: o.softMin,
      softMax: o.softMax,
      step: o.step,
      precision: o.precision,
      int: o.int,
      slider: o.slider,
      disabled: o.disabled,
      tip: o.tip,
      anim: animState(o),
      set: (v, final) => {
        (owner as Record<string, unknown>)[key] = v;
        commit(`Change ${label}`, final, o);
      },
    }),
    deco(o),
  );
}

export function bool<T extends object>(owner: T, key: keyof T & string, label: string, o: PropOpts = {}) {
  return h(
    'div',
    { class: 'split-row check' },
    h('div', { class: 'sr-label' }),
    h(
      'div',
      { class: 'sr-value' },
      checkbox(`${oid(owner)}.${key}`, label, !!owner[key], (v) => {
        (owner as Record<string, unknown>)[key] = v;
        commit(`Change ${label}`, true, o);
      }, { disabled: o.disabled, tip: o.tip, anim: animState(o) }),
    ),
    deco(o),
  );
}

/** Checkbox with the label in the label column (reference "heading" style). */
export function boolHeading<T extends object>(owner: T, key: keyof T & string, heading: string, label = '', o: PropOpts = {}) {
  return splitRow(
    heading,
    checkbox(`${oid(owner)}.${key}`, label, !!owner[key], (v) => {
      (owner as Record<string, unknown>)[key] = v;
      commit(`Change ${heading}`, true, o);
    }, { disabled: o.disabled }),
    deco(o),
  );
}

export function enumProp<T extends object>(owner: T, key: keyof T & string, label: string, items: (EnumItem | [string, string])[], o: PropOpts = {}) {
  const list = items.map((i) => (Array.isArray(i) ? { value: i[0], label: i[1] } : i));
  return splitRow(
    label,
    enumMenu(`${oid(owner)}.${key}`, list, String(owner[key]), (v) => {
      (owner as Record<string, unknown>)[key] = v;
      commit(`Change ${label}`, true, o);
    }, { disabled: o.disabled, tip: o.tip }),
    deco(o),
  );
}

export function colorProp<T extends object>(owner: T, key: keyof T & string, label: string, o: PropOpts & { alpha?: boolean } = {}) {
  return splitRow(
    label,
    colorSwatch(`${oid(owner)}.${key}`, owner[key] as unknown as number[], (v, final) => {
      (owner as Record<string, unknown>)[key] = v.slice(0, (owner[key] as unknown as number[]).length);
      commit(`Change ${label}`, final, o);
    }, { alpha: o.alpha, anim: animState(o) }),
    deco(o),
  );
}

export function textProp<T extends object>(owner: T, key: keyof T & string, label: string, o: PropOpts = {}) {
  return splitRow(
    label,
    textField(`${oid(owner)}.${key}`, String(owner[key] ?? ''), (v) => {
      (owner as Record<string, unknown>)[key] = v;
      commit(`Change ${label}`, true, o);
    }),
  );
}

/** Stacked vector fields: first row carries the label ("Location X"), following rows "Y", "Z". */
export function vecProp<T extends object>(owner: T, key: keyof T & string, label: string, o: PropOpts & { names?: string[]; lock?: { owner: object; key: string; offset?: number } } = {}) {
  const arr = owner[key] as unknown as number[];
  const names = o.names ?? ['X', 'Y', 'Z', 'W'];
  return h(
    'div',
    { class: 'vec-prop' },
    arr.map((v, i) => {
      const field = numberField({
          id: `${oid(owner)}.${key}.${i}`,
          value: v,
          unit: o.unit,
          min: o.min,
          max: o.max,
          softMin: o.softMin,
          softMax: o.softMax,
          step: o.step,
          precision: o.precision,
          slider: o.slider,
          anim: o.anim ? (() => {
            const st = keyState(app.doc, o.anim!.ob, o.anim!.path, i);
            return st === 'none' ? null : st;
          })() : null,
          set: (x, final) => {
            (owner[key] as unknown as number[])[i] = x;
            commit(`Change ${label}`, final, o);
          },
        });
      // optional per-channel lock toggle (e.g. lock_location) next to the field
      const li = i - (o.lock?.offset ?? 0);
      const locks = o.lock ? ((o.lock.owner as Record<string, boolean[] | undefined>)[o.lock.key] ?? null) : null;
      const lockBtn =
        o.lock && li >= 0 && li < 3
          ? h(
              'button',
              {
                class: { 'lock-btn': true, on: !!locks?.[li] },
                'data-tip': `Lock ${label} ${names[i]}\nDisable editing this channel in the 3D viewport`,
                'aria-label': `Lock ${label} ${names[i]}`,
                'aria-pressed': locks?.[li] ? 'true' : 'false',
                onclick: () => {
                  const rec = o.lock!.owner as Record<string, boolean[]>;
                  const cur = [...(rec[o.lock!.key] ?? [false, false, false])];
                  cur[li] = !cur[li];
                  rec[o.lock!.key] = cur;
                  commit(`Lock ${label}`, true, o);
                },
              },
              icon(locks?.[li] ? 'locked' : 'unlocked'),
            )
          : o.lock
            ? h('span', { class: 'lock-btn' })
            : null;
      return splitRow(
        i === 0 ? `${label} ${names[i]}` : names[i],
        lockBtn ? h('div', { class: 'field-with-lock' }, field, lockBtn) : field,
        o.anim
          ? decorator(
              keyState(app.doc, o.anim.ob, o.anim.path, i),
              () => {
                keyProperty(app.doc, o.anim!.ob, o.anim!.path, i);
                app.pushUndo('Insert Keyframe');
                app.changed('doc');
              },
              propertyAnimMenuHook.open ? (e: MouseEvent) => propertyAnimMenuHook.open!(e, o.anim!.ob, o.anim!.path, i) : undefined,
            )
          : h('span', { class: 'decorator-space' }),
        i === 0 ? 'vec-first' : i === arr.length - 1 ? 'vec-last' : 'vec-mid',
      );
    }),
  );
}

/** Row of toggle buttons for a bool[3] (e.g. axis toggles). */
export function axisToggles<T extends object>(owner: T, key: keyof T & string, label: string, names = ['X', 'Y', 'Z']) {
  const arr = owner[key] as unknown as boolean[];
  return splitRow(
    label,
    h(
      'div',
      { class: 'row-aligned' },
      arr.map((b, i) =>
        h(
          'button',
          {
            key: i,
            class: { tbtn: true, on: b },
            onclick: () => {
              (owner[key] as unknown as boolean[])[i] = !b;
              commit(`Change ${label}`, true);
            },
          },
          names[i],
        ),
      ),
    ),
  );
}

export function subLabel(text: string) {
  return h('div', { class: 'sub-label' }, text);
}

// Row helpers for preference sections: each control reads and writes one preference.
import { h, type Child } from '../ui/h';
import { checkbox, colorSwatch, enumMenu, enumRow, numberField, textField, type EnumItem, type Unit } from '../ui/widgets';
import { splitRow } from '../ui/props';
import { prefs, type Preferences } from '../app/prefs';
import { setPref } from './store';

type Keys<T> = Exclude<{ [K in keyof Preferences]-?: Preferences[K] extends T ? K : never }[keyof Preferences], undefined>;

export function pBool(key: Keys<boolean>, label: string, tip?: string, opts: { disabled?: boolean; heading?: string } = {}): Child {
  return splitRow(opts.heading ?? '', checkbox(`pf-${key}`, label, !!prefs[key], (v) => setPref(key, v as never), { tip: tip ? `${label}\n${tip}` : undefined, disabled: opts.disabled }), undefined, 'check');
}

export function pNum(key: Keys<number>, label: string, o: { min?: number; max?: number; softMin?: number; softMax?: number; step?: number; precision?: number; int?: boolean; unit?: Unit; slider?: boolean; disabled?: boolean; tip?: string; scale?: number } = {}): Child {
  const scale = o.scale ?? 1;
  return splitRow(
    label,
    numberField({
      id: `pf-${key}`,
      value: (prefs[key] as number) * scale,
      min: o.min,
      max: o.max,
      softMin: o.softMin,
      softMax: o.softMax,
      step: o.step,
      precision: o.precision ?? (o.int ? 0 : 2),
      int: o.int,
      unit: o.unit,
      slider: o.slider,
      disabled: o.disabled,
      tip: o.tip ? `${label}\n${o.tip}` : undefined,
      set: (v, final) => final && setPref(key, (o.int ? Math.round(v) : v) / scale as never),
    }),
  );
}

export function pEnum<K extends keyof Preferences>(key: K, label: string, items: EnumItem[], o: { expand?: boolean; disabled?: boolean; tip?: string } = {}): Child {
  const set = (v: string) => setPref(key, (typeof prefs[key] === 'number' ? Number(v) : v) as never);
  const value = String(prefs[key]);
  return splitRow(label, o.expand ? enumRow(`pf-${String(key)}`, items, value, set) : enumMenu(`pf-${String(key)}`, items, value, set, { disabled: o.disabled, tip: o.tip }));
}

export function pText(key: Keys<string>, label: string, placeholder = ''): Child {
  return splitRow(label, textField(`pf-${key}`, String(prefs[key] ?? ''), (v) => setPref(key, v as never), { placeholder }));
}

export function pColor(key: Keys<[number, number, number]>, label: string): Child {
  return splitRow(label, colorSwatch(`pf-${key}`, prefs[key] as number[], (v, final) => final && setPref(key, [v[0], v[1], v[2]] as never), { linear: false }));
}

export function note(text: string): Child {
  return h('div', { class: 'prefs-note' }, text);
}

export function infoRow(label: string, value: string): Child {
  return h('div', { class: 'prefs-info-row' }, h('span', { class: 'pi-label' }, label), h('span', { class: 'pi-value' }, value));
}

/** Small heading inside a panel (groups of checkboxes). */
export function subHeading(text: string): Child {
  return h('div', { class: 'prefs-subhead' }, text);
}

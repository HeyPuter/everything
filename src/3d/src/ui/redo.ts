// "Adjust Last Operation" panel (bottom-left of the viewport) and F9 popup.
import { h, type Child } from './h';
import { icon } from './icons';
import { app, operators, type PropDef } from '../app/app';
import { numberField, checkbox, enumMenu, textField, isPanelOpen, setPanelOpen } from './widgets';
import { openPopover } from './menu';
import { opHeader } from './ophooks';

export function propWidget(d: PropDef, value: unknown, set: (v: unknown, final: boolean) => void, idPrefix: string): Child {
  const id = `${idPrefix}.${d.id}`;
  const label = d.label ?? d.id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  switch (d.type) {
    case 'float':
    case 'int':
      return numberField({
        id,
        label,
        value: value as number,
        min: d.min,
        max: d.max,
        softMin: d.softMin,
        softMax: d.softMax,
        step: d.step,
        int: d.type === 'int',
        unit: d.subtype === 'distance' ? 'distance' : d.subtype === 'angle' ? 'angle' : d.subtype === 'factor' ? 'factor' : d.subtype === 'percentage' ? 'percentage' : 'none',
        slider: d.subtype === 'factor',
        set: (v, final) => set(v, final),
      });
    case 'bool':
      return checkbox(id, label, !!value, (v) => set(v, true));
    case 'enum':
      return h('div', { class: 'prop-line' }, h('span', { class: 'pl-label' }, label), enumMenu(id, (d.items ?? []).map(([v, l, desc]) => ({ value: v, label: l, description: desc })), value as string, (v) => set(v, true)));
    case 'string':
      return h('div', { class: 'prop-line' }, h('span', { class: 'pl-label' }, label), textField(id, String(value ?? ''), (v) => set(v, true)));
    case 'vec3':
    case 'vec2': {
      const arr = (value as number[]) ?? [0, 0, 0];
      const names = d.subtype === 'xyz' || d.type === 'vec3' ? ['X', 'Y', 'Z'] : ['X', 'Y'];
      return h(
        'div',
        { class: 'prop-vec' },
        h('div', { class: 'pv-label' }, label),
        h(
          'div',
          { class: 'col' },
          arr.map((x, i) =>
            numberField({
              id: `${id}.${i}`,
              label: names[i],
              value: x,
              unit: d.subtype === 'angle' ? 'angle' : d.subtype === 'distance' ? 'distance' : 'none',
              set: (v, final) => {
                const next = [...arr];
                next[i] = v;
                set(next, final);
              },
            }),
          ),
        ),
      );
    }
    case 'bools': {
      const arr = (value as boolean[]) ?? [false, false, false];
      return h('div', { class: 'prop-line' }, h('span', { class: 'pl-label' }, label), h('div', { class: 'row-aligned' }, arr.map((b, i) => h('button', { key: i, class: { tbtn: true, on: b }, onclick: () => set(arr.map((x, j) => (j === i ? !x : x)), true) }, ['X', 'Y', 'Z'][i]))));
    }
  }
  return null;
}

let pending: Record<string, unknown> = {};
let timer = 0;

function redoProps(): Child {
  const last = app.lastOp;
  if (!last) return null;
  const op = operators.get(last.idname);
  if (!op?.props) return null;
  const props = last.props;
  const header = opHeader(last.idname, props, (p) => app.redoLast(p));
  return [header, op.props
    .filter((d) => !d.hidden && (!d.showIf || d.showIf(props)))
    .map((d) =>
      propWidget(d, pending[d.id] ?? props[d.id], (v, final) => {
        pending[d.id] = v;
        clearTimeout(timer);
        const apply = () => {
          const p = pending;
          pending = {};
          app.redoLast(p);
        };
        if (final) apply();
        else timer = window.setTimeout(apply, 60);
        app.changed('ui');
      }, `redo.${last.idname}`),
    )];
}

export function lastOpPanel(_v: unknown): Child {
  const last = app.lastOp;
  if (!last || app.modal) return null;
  const op = operators.get(last.idname);
  if (!op?.props?.some((d) => !d.hidden)) return null;
  const open = isPanelOpen('redo-panel', false);
  return h(
    'div',
    { key: 'redo', class: { 'redo-panel': true, open } },
    h(
      'div',
      { class: 'redo-header', onclick: () => (setPanelOpen('redo-panel', !open), app.changed('ui')) },
      icon(open ? 'disclosure_tri_down' : 'disclosure_tri_right'),
      h('span', null, last.label),
    ),
    open ? h('div', { class: 'redo-body' }, redoProps()) : null,
  );
}

export function openRedoPopup(at: { x: number; y: number }) {
  if (!app.lastOp) return;
  openPopover(at, () => h('div', { class: 'pop-panel' }, h('div', { class: 'pop-title' }, app.lastOp?.label ?? ''), redoProps()), { width: 280 });
}

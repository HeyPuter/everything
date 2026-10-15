// A small popup that edits an operator's properties before running it (OK runs the operator).
import { h } from '../../ui/h';
import { app, operators, defaultProps, type AreaLike } from '../../app/app';
import { openPopover } from '../../ui/menu';
import { propWidget } from '../../ui/redo';
import { enumRow, numberField } from '../../ui/widgets';

export function operatorDialog(idname: string, opts: { title?: string; ok?: string; props?: Record<string, unknown>; area?: AreaLike | null; at?: { x: number; y: number } } = {}) {
  const op = operators.get(idname);
  if (!op) return;
  const props: Record<string, unknown> = { ...defaultProps(op), ...(opts.props ?? {}) };
  const area = opts.area === undefined ? (app.hoverArea ?? app.activeArea) : opts.area;
  const pop = openPopover(
    opts.at ?? { x: app.pointer.x, y: app.pointer.y },
    () =>
      h(
        'div',
        { class: 'pop-panel op-dialog', 'data-op': idname },
        h('div', { class: 'pop-title' }, opts.title ?? op.label),
        ...(op.props ?? [])
          .filter((d) => !d.hidden && (!d.showIf || d.showIf(props)))
          .map((d) => {
            const set = (v: unknown) => {
              props[d.id] = v;
              pop.redraw();
            };
            // dropdown menus would close the popup: show choices inline
            if (d.type === 'enum')
              return h(
                'div',
                { class: 'prop-line op-dialog-enum' },
                h('span', { class: 'pl-label' }, d.label ?? d.id),
                enumRow(`dlg.${idname}.${d.id}`, (d.items ?? []).map(([value, label]) => ({ value, label: label.replace(/ \(\.[a-z]+\)$/, '') })), String(props[d.id]), set),
              );
            // pixel sizes: whole numbers
            if (d.type === 'vec2' && d.subtype === 'pixel') {
              const v = props[d.id] as number[];
              return h(
                'div',
                { class: 'prop-vec' },
                h('div', { class: 'pv-label' }, d.label ?? d.id),
                h(
                  'div',
                  { class: 'col' },
                  ['X', 'Y'].map((axis, i) => numberField({ id: `dlg.${idname}.${d.id}.${i}`, label: axis, value: v[i], int: true, min: 1, max: 16384, unit: 'pixel', set: (x) => set(i ? [v[0], x] : [x, v[1]]) })),
                ),
              );
            }
            return propWidget(d, props[d.id], set, `dlg.${idname}`);
          }),
        h(
          'div',
          { class: 'ie-dialog-buttons' },
          h(
            'button',
            {
              class: 'btn op-dialog-ok',
              onclick: () => {
                pop.el.remove();
                app.run(idname, props, { invoke: false, area });
              },
            },
            opts.ok ?? 'OK',
          ),
        ),
      ),
    { width: 300 },
  );
  return pop;
}

// Operator dialog: a popup with an operator's properties and an OK button (the properties dialog
// operators open from invoke). Other modules add a row above the properties (e.g. presets).
import { h, type Child } from './h';
import { app, operators, defaultProps } from '../app/app';
import { openPopover, closeMenus } from './menu';
import { propWidget } from './redo';

/** Rows drawn at the top of operator dialogs and redo panels (the preset menu). */
export const opDialogHeaderHooks: ((idname: string, props: Record<string, unknown>, apply: (p: Record<string, unknown>) => void) => Child)[] = [];

export function opHeader(idname: string, props: Record<string, unknown>, apply: (p: Record<string, unknown>) => void): Child {
  return opDialogHeaderHooks.map((f) => f(idname, props, apply));
}

/**
 * Show the operator's properties; OK runs it (non-interactively) with the edited values.
 * `init` fills in values; `title` defaults to the operator's label.
 */
export function operatorDialog(idname: string, init: Record<string, unknown> = {}, opts: { title?: string; confirm?: string; width?: number; at?: { x: number; y: number } } = {}) {
  const op = operators.get(idname);
  if (!op) return;
  const props: Record<string, unknown> = { ...defaultProps(op), ...init };
  const at = opts.at ?? { x: app.pointer.x - 140, y: app.pointer.y - 20 };
  const run = () => {
    closeMenus();
    app.run(idname, { ...props }, { invoke: false });
  };
  const pop = openPopover(
    at,
    () =>
      h(
        'div',
        {
          class: 'pop-panel op-dialog',
          'data-op-dialog': idname,
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' && !(e.target as HTMLElement).closest('input, textarea')) {
              e.preventDefault();
              run();
            }
          },
        },
        h('div', { class: 'pop-title' }, opts.title ?? op.label),
        opHeader(idname, props, (p) => {
          Object.assign(props, p);
          pop.redraw();
        }),
        (op.props ?? [])
          .filter((d) => !d.hidden && (!d.showIf || d.showIf(props)))
          .map((d) =>
            propWidget(
              d,
              props[d.id],
              (v) => {
                props[d.id] = v;
                pop.redraw();
              },
              `dlg.${idname}`,
            ),
          ),
        h('div', { class: 'op-dialog-buttons' }, h('button', { class: 'btn primary', onclick: run }, opts.confirm ?? 'OK')),
      ),
    { width: opts.width ?? 300, className: 'op-dialog-host' },
  );
  return pop;
}

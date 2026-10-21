// Object properties additions: Transform ▸ Parent Inverse Transform (the parent inverse matrix as
// a 4×4 grid of fields with a button that clears it) and Viewport Display ▸ Bounds.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { checkbox, enumMenu, numberField, opButton, panel } from '../ui/widgets';
import { splitRow } from '../ui/props';
import type { ObjectData } from '../data/types';

export function parentInversePanel(o: ObjectData): Child {
  return panel(
    'ob-parent-inverse',
    'Parent Inverse Transform',
    () => [
      h(
        'div',
        { class: 'matrix-grid' },
        // stored column-major: element (row r, column c) is at c * 4 + r
        [0, 1, 2, 3].flatMap((r) =>
          [0, 1, 2, 3].map((c) =>
            numberField({
              id: `${o.id}.mpi.${r}.${c}`,
              value: o.matrix_parent_inverse[c * 4 + r] ?? (r === c ? 1 : 0),
              precision: 3,
              noLabel: true,
              set: (x, final) => {
                const m = [...o.matrix_parent_inverse];
                m[c * 4 + r] = x;
                o.matrix_parent_inverse = m as typeof o.matrix_parent_inverse;
                app.changed('doc');
                if (final) app.pushUndo('Parent Inverse');
              },
            }),
          ),
        ),
      ),
      h('div', { class: 'btn-row' }, opButton('object.parent_clear', 'Clear Parent Inverse Transform', { type: 'CLEAR_INVERSE' })),
    ],
    { sub: true, closed: true },
  );
}

type ObBounds = ObjectData & { show_bounds?: boolean; display_bounds_type?: string };

/** Viewport Display ▸ Bounds: show a bounding shape and pick its kind. */
export function boundsRow(o: ObjectData): Child {
  const ob = o as ObBounds;
  const set = (k: 'show_bounds' | 'display_bounds_type', v: unknown, label: string) => {
    (ob as unknown as Record<string, unknown>)[k] = v;
    app.pushUndo(label);
    app.changed('doc');
  };
  return splitRow(
    'Bounds',
    h(
      'div',
      { class: 'sb-inline' },
      checkbox(`${o.id}.show_bounds`, '', !!ob.show_bounds, (x) => set('show_bounds', x, 'Show Bounds'), { tip: 'Bounds\nDraw a bounding shape around the object' }),
      enumMenu(`${o.id}.bounds_type`, [['BOX', 'Box'], ['SPHERE', 'Sphere'], ['CYLINDER', 'Cylinder'], ['CONE', 'Cone'], ['CAPSULE', 'Capsule']].map(([value, label]) => ({ value, label })), ob.display_bounds_type ?? 'BOX', (x) => set('display_bounds_type', x, 'Bounds Type'), { disabled: !ob.show_bounds }),
    ),
  );
}

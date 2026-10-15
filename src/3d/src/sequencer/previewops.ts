// Preview operators: 2D cursor, pivot point, mirroring images.
import { app, registerOperators, type Operator } from '../app/app';
import { openPie, type MenuItem } from '../ui/menu';
import { hasEditor, hoverSeq, toolSettings } from './context';
import { setCursorPoint, transformPreview, previewTargets, PIVOTS, pivotPoint, type Pivot } from './pvtransform';

const ops: Operator[] = [
  {
    idname: 'sequencer.cursor_set',
    label: 'Set 2D Cursor',
    description: 'Place the preview’s 2D cursor (pivot for transforms) at the pointer',
    props: [{ id: 'location', label: 'Location', type: 'vec2', default: [0, 0] }],
    poll: () => hasEditor() && hoverSeq()?.hover === 'preview',
    invoke: (_c, p) => {
      const ed = hoverSeq()!;
      const [x, y] = ed.previewToFrame(app.pointer.x, app.pointer.y);
      const r = app.doc.scene.render;
      p.location = [Math.round(x - r.resolution_x / 2), Math.round(y - r.resolution_y / 2)];
      toolSettings().cursor_location = [...(p.location as [number, number])];
      return 'FINISHED';
    },
    exec: (_c, p) => {
      toolSettings().cursor_location = [...(p.location as [number, number])];
    },
  },
  {
    idname: 'sequencer.strip_mirror',
    label: 'Mirror Strip Images',
    description: 'Mirror the selected strips’ images across the pivot point',
    props: [
      {
        id: 'axis',
        label: 'Axis',
        type: 'enum',
        default: 'X',
        items: [
          ['X', 'X'],
          ['Y', 'Y'],
        ],
      },
    ],
    poll: () => hasEditor() && previewTargets().length > 0,
    exec: (_c, p) => (transformPreview('MIRROR', p.axis === 'X' ? [1, 0] : [0, 1]) ? 'FINISHED' : 'CANCELLED'),
  },
];

registerOperators(ops);

export function setPivot(p: Pivot) {
  toolSettings().pivot_point = p;
  app.pushUndo('Pivot Point');
  app.changed('ui');
}

/** Pivot point choices (pie on Period, Image menu). */
export const PIVOT_ICONS: Record<Pivot, string> = { BOUNDING_BOX_CENTER: 'pivot_boundbox', CURSOR: 'pivot_cursor', INDIVIDUAL_ORIGINS: 'pivot_individual', MEDIAN_POINT: 'pivot_median' };

export function pivotItems(): MenuItem[] {
  const cur = pivotPoint();
  return PIVOTS.map(([v, label]) => ({ label, icon: PIVOT_ICONS[v], active: v === cur, action: () => setPivot(v) }));
}

export function pivotPie() {
  const cur = pivotPoint();
  const item = (v: Pivot) => ({ label: PIVOTS.find((x) => x[0] === v)![1], icon: PIVOT_ICONS[v], active: v === cur, action: () => setPivot(v) });
  // W E S N
  openPie('Pivot Point', [item('BOUNDING_BOX_CENTER'), item('CURSOR'), item('MEDIAN_POINT'), item('INDIVIDUAL_ORIGINS'), null, null, null, null], app.pointer.x, app.pointer.y, 'Period');
}

/** Ctrl M in the preview: mirror on an axis. */
export function mirrorItems(): MenuItem[] {
  return [
    { label: 'X Axis', op: 'sequencer.strip_mirror', props: { axis: 'X' } },
    { label: 'Y Axis', op: 'sequencer.strip_mirror', props: { axis: 'Y' } },
  ];
}

export { setCursorPoint };

// Material ▸ Preview: the material rendered on a sphere, cube or plane (Material Preview lighting),
// with buttons choosing the shape (stored as `preview_render_type`).
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app, onAppReady } from '../../app/app';
import type { MaterialData } from '../../data/types';
import { materialPreview, onPreviewReady, type PreviewShape } from './preview';

const SHAPES: [PreviewShape, string, string][] = [
  ['FLAT', 'Flat', 'plane'],
  ['SPHERE', 'Sphere', 'sphere'],
  ['CUBE', 'Cube', 'cube'],
];

type WithShape = MaterialData & { preview_render_type?: string };

export function materialPreviewPanel(ma: MaterialData): Child {
  const m = ma as WithShape;
  const shape = (SHAPES.find(([v]) => v === m.preview_render_type)?.[0] ?? 'SPHERE') as PreviewShape;
  const url = materialPreview(app.doc, ma, shape);
  return h(
    'div',
    { class: 'mat-preview-row' },
    url ? h('img', { class: 'mat-preview-img', src: url, alt: '', draggable: false }) : h('div', { class: 'mat-preview-img mat-preview-wait' }),
    h(
      'div',
      { class: 'mat-preview-shapes' },
      SHAPES.map(([v, label, ic]) =>
        h(
          'button',
          {
            key: v,
            class: { 'mat-preview-shape': true, on: v === shape },
            'data-tip': `${label}\nPreview the material on a ${label.toLowerCase()} shape`,
            onclick: () => {
              m.preview_render_type = v;
              app.changed('ui');
            },
          },
          icon(ic),
        ),
      ),
    ),
  );
}

// redraw the Properties editor when a preview image arrives
onAppReady(() => onPreviewReady(() => app.changed('ui')));

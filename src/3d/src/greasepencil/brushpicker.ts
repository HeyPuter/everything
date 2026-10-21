// Space in the Grease Pencil paint modes: the brushes of the shelf as a popup grid at the pointer.
import { app } from '../app/app';
import { addKeys } from '../app/keymap';
import { h } from '../ui/h';
import { openPopover, closeMenus } from '../ui/menu';
import { gpOf } from './data';
import { shelfBrushes } from './brushshelf';

const MODES = new Set(['PAINT_GREASE_PENCIL', 'SCULPT_GREASE_PENCIL', 'VERTEX_GREASE_PENCIL', 'WEIGHT_GREASE_PENCIL']);
const inBrushMode = () => MODES.has(app.doc.mode) && !!gpOf(app.doc, app.activeObject);

export function openGPBrushPicker(anchor: { x: number; y: number }) {
  if (!inBrushMode()) return;
  openPopover(
    anchor,
    () =>
      h(
        'div',
        { class: 'pop-panel gp-brush-pick' },
        shelfBrushes().map((b) =>
          h(
            'button',
            {
              key: b.id,
              class: { 'gp-bp-tile': true, on: b.active },
              'data-tip': b.name,
              'data-brush': b.id,
              onclick: () => {
                b.pick();
                closeMenus();
                app.changed('ui');
              },
            },
            h('img', { src: b.thumb, width: 44, height: 44, draggable: false, alt: '' }),
            h('span', null, b.name),
          ),
        ),
      ),
    { width: 380 },
  );
}

addKeys('Grease Pencil', [
  {
    key: 'SPACE',
    when: inBrushMode,
    action: () => openGPBrushPicker({ x: app.pointer.x - 190, y: app.pointer.y - 20 }),
  },
]);

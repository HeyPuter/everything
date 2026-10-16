// Camera data tab: Background Images panel and the reference panel order (Safe Areas after
// Viewport Display).
import { h, type Child } from '../../../ui/h';
import { icon } from '../../../ui/icons';
import { app } from '../../../app/app';
import { panel, opButton } from '../../../ui/widgets';
import { num, enumProp, vecProp, splitRow } from '../../../ui/props';
import { imageSlot } from '../tabs';
import { headerToggle } from '../../../render/final/props/common';
import type { CameraBackgroundImage, CameraData } from '../../../data/types';
import { extendTab, insertPanels, movePanelAfter } from './insert';
import '../../view3d/camerabg';

const changed = (label: string) => {
  app.pushUndo(label);
  app.changed('doc');
};

function imageBox(ca: CameraData, bg: CameraBackgroundImage, i: number): Child {
  const img = bg.image ? app.doc.images[bg.image] : undefined;
  return h(
    'div',
    { key: `bg${i}`, class: 'bgimg-box' },
    h(
      'div',
      { class: 'bgimg-head' },
      h('button', { class: 'bgimg-expand', 'data-tip': 'Show the settings of this image', onclick: () => ((bg.show_expanded = !bg.show_expanded), app.changed('ui')) }, icon(bg.show_expanded ? 'disclosure_tri_down' : 'disclosure_tri_right')),
      h('span', { class: 'bgimg-name' }, img?.name ?? 'Not Set'),
      h('button', { class: { 'bgimg-btn': true, on: bg.show_background_image }, 'data-tip': 'Show this image in the camera view', onclick: () => ((bg.show_background_image = !bg.show_background_image), changed('Show Background Image')) }, icon(bg.show_background_image ? 'hide_off' : 'hide_on')),
      h('button', { class: 'bgimg-btn', 'data-tip': 'Remove this image', onclick: () => app.run('view3d.camera_background_image_remove', { index: i }) }, icon('x')),
    ),
    bg.show_expanded
      ? h(
          'div',
          { class: 'bgimg-body' },
          imageSlot(bg as unknown as Record<string, unknown>, 'image', 'Image'),
          num(bg, 'alpha', 'Opacity', { min: 0, max: 1, slider: true }),
          enumProp(bg, 'display_depth', 'Depth', [['BACK', 'Back'], ['FRONT', 'Front']]),
          enumProp(bg, 'frame_method', 'Frame Method', [['STRETCH', 'Stretch'], ['FIT', 'Fit'], ['CROP', 'Crop']]),
          vecProp(bg, 'offset', 'Offset', { names: ['X', 'Y'], step: 0.01 }),
          num(bg, 'rotation', 'Rotation', { unit: 'angle' }),
          num(bg, 'scale', 'Scale', { min: 0, softMax: 10 }),
          splitRow(
            'Flip',
            h(
              'div',
              { class: 'enum-row' },
              (['use_flip_x', 'use_flip_y'] as const).map((k) =>
                h('button', { key: k, class: { on: bg[k] }, 'aria-pressed': bg[k] ? 'true' : 'false', 'data-tip': k === 'use_flip_x' ? 'Mirror the image left to right' : 'Mirror the image top to bottom', onclick: () => ((bg[k] = !bg[k]), changed('Flip Background Image')) }, k === 'use_flip_x' ? 'Horizontal' : 'Vertical'),
              ),
            ),
          ),
        )
      : null,
  );
}

export function cameraBackgroundImagesPanel(ca: CameraData): Child {
  return panel(
    'ca-bgimages',
    'Background Images',
    () => [
      h('div', { class: 'btn-row' }, opButton('view3d.camera_background_image_add', 'Add Image', {}, { icon: 'add' })),
      (ca.background_images ?? []).map((bg, i) => imageBox(ca, bg, i)),
      ca.background_images?.length && !ca.show_background_images ? h('div', { class: 'prop-note' }, 'Turn on the panel checkbox to show the images in the camera view.') : null,
    ],
    { closed: true, header: headerToggle(ca, 'show_background_images', 'Background Images') },
  );
}

extendTab('DATA', (out) => {
  const o = app.activeObject;
  if (o?.type !== 'CAMERA' || !o.data) return out;
  const ca = app.doc.cameras[o.data];
  if (!ca) return out;
  const list = insertPanels(out, 'ca-dof', 'after', [cameraBackgroundImagesPanel(ca)]);
  // Safe Areas follow the viewport display settings
  return movePanelAfter(list, 'ca-safe', 'ca-display');
});

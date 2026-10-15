// Outliner filter popover: restriction columns, sorting/sync options, search options and which
// elements the view layer tree shows.
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import { checkbox, enumMenu } from '../../ui/widgets';
import type { Outliner } from '../outliner';
import type { OutlinerFilter } from './tree';

type BoolKey = {
  [K in keyof OutlinerFilter]: OutlinerFilter[K] extends boolean ? K : never;
}[keyof OutlinerFilter];

function set(ol: Outliner, key: keyof OutlinerFilter, v: unknown) {
  (ol.filter as unknown as Record<string, unknown>)[key] = v;
  ol.redraw();
  app.changed('ui');
}

function check(ol: Outliner, key: BoolKey, label: string, ic?: string, disabled = false): Child {
  return h(
    'div',
    { class: 'olf-check', key },
    ic ? h('span', { class: 'olf-ic' }, icon(ic)) : null,
    checkbox(`olf-${key}`, label, ol.filter[key], (v) => set(ol, key, v), {
      disabled,
    }),
  );
}

const COLUMN_TOGGLES: [BoolKey, string, string][] = [
  ['show_restrict_column_enable', 'checkbox_hlt', 'Exclude Checkbox'],
  ['show_restrict_column_select', 'restrict_select_off', 'Selectable'],
  ['show_restrict_column_hide', 'hide_off', 'Hide in Viewport'],
  ['show_restrict_column_viewport', 'restrict_view_off', 'Disable in Viewports'],
  ['show_restrict_column_render', 'restrict_render_off', 'Disable in Renders'],
  ['show_restrict_column_holdout', 'holdout_on', 'Holdout'],
  ['show_restrict_column_indirect_only', 'indirect_only_on', 'Indirect Only'],
];

export function filterPopover(ol: Outliner): Child {
  const f = ol.filter;
  const objOff = !f.use_filter_object;
  return h(
    'div',
    { class: 'olf' },
    h('div', { class: 'olf-head' }, 'Restriction Toggles'),
    h(
      'div',
      { class: 'olf-cols' },
      COLUMN_TOGGLES.map(([key, ic, tip]) =>
        h(
          'button',
          {
            key,
            class: { 'olf-col': true, on: f[key] },
            'data-tip': tip,
            'aria-label': tip,
            'aria-pressed': f[key] ? 'true' : 'false',
            onclick: () => set(ol, key, !f[key]),
          },
          icon(ic),
        ),
      ),
    ),
    check(ol, 'use_sort_alpha', 'Sort Alphabetically'),
    check(ol, 'use_sync_select', 'Sync Selection'),
    check(ol, 'show_mode_column', 'Show Mode Column'),
    h('div', { class: 'olf-head' }, 'Search'),
    check(ol, 'use_filter_complete', 'Exact Match'),
    check(ol, 'use_filter_case_sensitive', 'Case Sensitive'),
    h('div', { class: 'olf-head' }, 'Filter'),
    check(ol, 'use_filter_collection', 'Collections', 'collection'),
    h(
      'div',
      { class: 'olf-row' },
      check(ol, 'use_filter_object', 'Objects', 'object'),
      h(
        'div',
        { class: 'olf-state' },
        enumMenu(
          'olf-state',
          [
            { value: 'ALL', label: 'All' },
            { value: 'VISIBLE', label: 'Visible' },
            { value: 'SELECTED', label: 'Selected' },
            { value: 'ACTIVE', label: 'Active' },
            { value: 'SELECTABLE', label: 'Selectable' },
          ],
          f.filter_state,
          (v) => set(ol, 'filter_state', v),
          { disabled: objOff, tip: 'Object State Filter' },
        ),
        h(
          'button',
          {
            class: { 'olf-invert': true, on: f.filter_invert },
            disabled: objOff || f.filter_state === 'ALL',
            'data-tip': 'Invert the object state filter',
            onclick: () => set(ol, 'filter_invert', !f.filter_invert),
          },
          '⇄',
        ),
      ),
    ),
    h(
      'div',
      { class: 'olf-indent' },
      check(ol, 'use_filter_object_content', 'Object Contents', 'modifier', objOff),
      check(ol, 'use_filter_children', 'Object Children', 'outliner_hierarchy', objOff),
      check(ol, 'use_filter_object_mesh', 'Meshes', 'mesh_data', objOff),
      check(ol, 'use_filter_object_armature', 'Armatures', 'armature_data', objOff),
      check(ol, 'use_filter_object_empty', 'Empties', 'outliner_ob_empty', objOff),
      check(ol, 'use_filter_object_light', 'Lights', 'light_data', objOff),
      check(ol, 'use_filter_object_camera', 'Cameras', 'camera_data', objOff),
      check(ol, 'use_filter_object_grease_pencil', 'Grease Pencil', 'outliner_data_greasepencil', objOff),
      check(ol, 'use_filter_object_others', 'Others', 'outliner_ob_curve', objOff),
    ),
  );
}

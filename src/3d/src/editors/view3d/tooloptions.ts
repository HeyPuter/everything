// Tool options shared by the Options popover at the right of the 3D view's tool settings row
// and the Options panel of the sidebar's Tool tab.
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import { checkbox, numberField } from '../../ui/widgets';
import { openPopover } from '../../ui/menu';

type Ts = ReturnType<typeof tsOf>;
const tsOf = () => app.doc.scene.tool_settings as typeof app.doc.scene.tool_settings & { use_transform_pivot_point_align?: boolean };

/** Extra option sections per mode (e.g. armature or sculpt options), drawn after the built-in ones. */
export const toolOptionSections: ((idp: string) => Child)[] = [];

/** Widgets drawn at the right end of the tool settings row, before the Options button (e.g. mesh symmetry). */
export const toolHeaderRightHooks: (() => Child)[] = [];

function set(ts: Ts, key: string, undoLabel?: string) {
  return (x: unknown) => {
    (ts as unknown as Record<string, unknown>)[key] = x;
    if (undoLabel) app.pushUndo(undoLabel);
    app.changed('ui');
  };
}

const inMeshEdit = () => app.doc.mode === 'EDIT' && app.activeObject?.type === 'MESH';

/** The option rows (`idp` prefixes widget ids so the popover and the sidebar can both be open). */
export function toolOptions(idp: string): Child[] {
  const ts = tsOf();
  const out: Child[] = [];
  if (app.doc.mode === 'OBJECT') {
    out.push(
      h('div', { class: 'opt-head' }, 'Transform'),
      h(
        'div',
        { class: 'opt-split' },
        h('span', { class: 'opt-label' }, 'Affect Only'),
        h(
          'div',
          { class: 'opt-col' },
          checkbox(`${idp}-aff-origins`, 'Origins', !!ts.use_transform_data_origin, set(ts, 'use_transform_data_origin'), { tip: 'Affect Only Origins\nMove object origins without moving the geometry' }),
          checkbox(`${idp}-aff-locations`, 'Locations', !!ts.use_transform_pivot_point_align, set(ts, 'use_transform_pivot_point_align'), { tip: 'Affect Only Locations\nRotate and scale move object positions only; the objects keep their own rotation and size' }),
          checkbox(`${idp}-aff-parents`, 'Parents', !!ts.use_transform_skip_children, set(ts, 'use_transform_skip_children'), { tip: 'Affect Only Parents\nTransform parents while their children stay in place' }),
        ),
      ),
    );
  }
  if (inMeshEdit()) {
    out.push(
      h('div', { class: 'opt-head' }, 'Mesh Options'),
      h(
        'div',
        { class: 'opt-split' },
        h('span', { class: 'opt-label' }, 'Mirror'),
        h(
          'div',
          { class: 'opt-col opt-row' },
          (['x', 'y', 'z'] as const).map((a) => checkbox(`${idp}-mir-${a}`, a.toUpperCase(), !!ts[`use_mesh_mirror_${a}`], set(ts, `use_mesh_mirror_${a}`), { tip: `Mirror editing across the local ${a.toUpperCase()} axis` })),
        ),
      ),
      h('div', { class: 'opt-split' }, h('span', { class: 'opt-label' }), h('div', { class: 'opt-col' }, checkbox(`${idp}-automerge`, 'Auto Merge Vertices', ts.use_mesh_automerge, set(ts, 'use_mesh_automerge', 'Auto Merge'), { tip: 'Auto Merge Vertices\nMerge vertices that end up on top of each other after a transform' }))),
      ts.use_mesh_automerge
        ? h('div', { class: 'opt-split' }, h('span', { class: 'opt-label' }), numberField({ id: `${idp}-merge-dist`, label: 'Threshold', value: ts.double_threshold, min: 0, max: 1, unit: 'distance', set: (x, final) => (set(ts, 'double_threshold', final ? 'Merge Threshold' : undefined))(x) }))
        : null,
    );
  }
  for (const f of toolOptionSections) out.push(f(idp));
  return out;
}

/** The Options dropdown at the right of the tool settings row. */
export function optionsButton(): Child {
  return h(
    'button',
    {
      key: 'tool-options',
      class: 'hdr-drop th-options',
      'data-tip': 'Options\nTransform and editing options of the current mode',
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        openPopover(e.currentTarget as HTMLElement, () => h('div', { class: 'pop-panel tool-options' }, h('div', { class: 'pop-title' }, 'Options'), ...toolOptions('pop')), { width: 240 });
      },
    },
    h('span', null, 'Options'),
    icon('down_arrow_hlt', 'tiny'),
  );
}

/** Whether the current mode has any options to show. */
export function hasToolOptions(): boolean {
  return toolOptions('probe').some((c) => c !== null && c !== undefined && c !== false);
}

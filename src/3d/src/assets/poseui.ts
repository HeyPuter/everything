// Pose Library: in Pose Mode, the 3D view sidebar's Animation tab lists the pose assets of every
// library as thumbnails. Click applies a pose (blended by the Blend factor), right-click offers
// selecting the pose's bones; Create Pose Asset stores the current pose.
import { app } from '../app/app';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { openMenu } from '../ui/menu';
import { numberField, panel } from '../ui/widgets';
import { sidebarTabs } from '../editors/view3d/sidebar';
import { libraries, listAssets, libraryDoc, assetRef, libraryInfo, type AssetEntry } from './library';
import { isPoseAction } from './poselib';

let blend = 1;
let search = '';

function poseAssets(): AssetEntry[] {
  const out: AssetEntry[] = [];
  for (const lib of libraries()) {
    const doc = libraryDoc(lib.id);
    if (!doc) continue;
    for (const e of listAssets(lib.id)) if (e.table === 'actions' && doc.actions[e.id] && isPoseAction(doc.actions[e.id])) out.push(e);
  }
  const q = search.trim().toLowerCase();
  return out.filter((e) => !q || e.block.name.toLowerCase().includes(q) || e.block.asset_data!.tags.some((t) => t.toLowerCase().includes(q))).sort((a, b) => a.block.name.localeCompare(b.block.name));
}

const inPose = () => app.doc.mode === 'POSE' && app.activeObject?.type === 'ARMATURE';

function poseLibrary(): Child {
  const list = poseAssets();
  return [
    h(
      'div',
      { class: 'pl-row' },
      h('button', { class: 'btn pl-create', onclick: () => app.run('poselib.create_pose_asset') }, icon('add'), 'Create Pose Asset'),
    ),
    numberField({ id: 'pl-blend', label: 'Blend', value: blend, min: 0, max: 1, unit: 'none', precision: 2, set: (v) => ((blend = v), app.changed('ui')) }),
    h('label', { class: 'text-field pl-search' }, icon('viewzoom'), h('input', { value: search, placeholder: 'Search poses', spellcheck: 'false', oninput: (e: Event) => ((search = (e.target as HTMLInputElement).value), app.changed('ui')), onkeydown: (e: KeyboardEvent) => e.stopPropagation() })),
    list.length
      ? h(
          'div',
          { class: 'pl-grid' },
          list.map((e) => {
            const ref = assetRef(e);
            const m = e.block.asset_data!;
            return h(
              'button',
              {
                key: ref,
                class: 'pl-pose',
                'data-pose': e.block.name,
                'data-tip': `${e.block.name}\n${libraryInfo(e.library)?.name ?? ''}${m.description ? `\n${m.description}` : ''}\nClick: apply · Right-click: more`,
                onclick: () => app.run('poselib.apply_pose_asset', { asset: ref, blend_factor: blend }),
                oncontextmenu: (ev: MouseEvent) => {
                  ev.preventDefault();
                  openMenu(
                    [
                      { label: 'Apply Pose', op: 'poselib.apply_pose_asset', props: { asset: ref, blend_factor: 1 } },
                      { label: `Blend Pose (${Math.round(blend * 100)}%)`, op: 'poselib.apply_pose_asset', props: { asset: ref, blend_factor: blend } },
                      { separator: true },
                      { label: 'Select Pose Bones', op: 'poselib.pose_asset_select_bones', props: { asset: ref, select: true } },
                      { label: 'Deselect Pose Bones', op: 'poselib.pose_asset_select_bones', props: { asset: ref, select: false } },
                      ...(libraryInfo(e.library)?.editable
                        ? [
                            { separator: true },
                            {
                              label: 'Modify Pose Asset',
                              submenu: () => [
                                { label: 'Replace', op: 'poselib.asset_modify', props: { asset: ref, mode: 'REPLACE' } },
                                { label: 'Add Selected Bones', op: 'poselib.asset_modify', props: { asset: ref, mode: 'ADD' } },
                                { label: 'Remove Selected Bones', op: 'poselib.asset_modify', props: { asset: ref, mode: 'REMOVE' } },
                              ],
                            },
                            { label: 'Delete Pose Asset', icon: 'trash', op: 'poselib.asset_delete', props: { asset: ref } },
                          ]
                        : []),
                    ],
                    { x: ev.clientX, y: ev.clientY },
                    { title: e.block.name },
                  );
                },
              },
              h('span', { class: 'pl-thumb' }, m.preview ? h('img', { src: m.preview, alt: '', draggable: 'false' }) : icon('pose_hlt')),
              h('span', { class: 'pl-name' }, e.block.name),
            );
          }),
        )
      : h('div', { class: 'sb-empty' }, search ? 'No poses match' : 'No pose assets yet: pose the bones and use Create Pose Asset'),
  ];
}

sidebarTabs.push({
  id: 'Animation',
  label: 'Animation',
  poll: inPose,
  draw: () => [panel('sb-pose-library', 'Pose Library', poseLibrary)],
});

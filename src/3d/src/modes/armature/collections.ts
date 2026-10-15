// Bone collections: operators (add / remove / move / assign / unassign / select / deselect /
// show all / unsolo all / remove unused), the M and Shift M menus, and the Bone Collections panel.
import { h } from '../../ui/h';
import { icon, registerIcons } from '../../ui/icons';
import { app, registerOperators, type OpContext } from '../../app/app';
import { opButton, panel } from '../../ui/widgets';
import { uiList } from '../../editors/properties/uilist';
import { armatureDataPanels } from '../../editors/properties/tabs';
import { promptText, type MenuItem } from '../../ui/menu';
import type { ArmatureData, Bone } from '../../data/types';
import { activeArmature } from './armature';
import * as A from './armkernels';

registerIcons({
  bone_collection: '<rect class="s" x="1.5" y="3.5" width="13" height="10" rx="1.5" fill="none" stroke-width="1.1"/><path class="s" d="M1.5 6h13" stroke-width="1"/><path class="f" d="M5 12l2-4.5 1.2 1.2L12 7.2l-1.4 3.6L9.4 9.6z"/>',
});

const hasArm = () => !!activeArmature();
const editOrPose = () => hasArm() && (app.doc.mode === 'EDIT' || app.doc.mode === 'POSE');

/** Selected bones in Edit Mode, or bones of selected pose channels in Pose Mode. */
export function selectedBones(arm: ArmatureData): Bone[] {
  const { ob } = activeArmature()!;
  if (app.doc.mode === 'POSE') return arm.bones.filter((b) => ob.pose?.[b.name]?.select && A.boneVisible(arm, b));
  if (app.doc.mode === 'EDIT') return arm.bones.filter((b) => (b.select || (b.select_head && b.select_tail)) && A.boneVisible(arm, b));
  return [];
}

function activeCollection(arm: ArmatureData) {
  const cols = A.collectionsOf(arm);
  return cols[Math.max(0, Math.min(arm.active_collection_index ?? 0, cols.length - 1))];
}

/** Resolve a collection from the operator props: explicit name, index, or the active one. */
function targetCollection(arm: ArmatureData, p: Record<string, unknown>) {
  const cols = A.collectionsOf(arm);
  if (typeof p.name === 'string' && p.name) return cols.find((c) => c.name === p.name);
  return activeCollection(arm);
}

function setBonesSelected(bones: Bone[], on: boolean) {
  const { ob } = activeArmature()!;
  for (const b of bones) {
    if (app.doc.mode === 'POSE') {
      const pb = ob.pose?.[b.name];
      if (pb) pb.select = on;
    } else A.setBoneSelected(b, on);
  }
}

function moveOrAssign(ctx: OpContext, p: Record<string, unknown>, move: boolean) {
  const { arm } = activeArmature()!;
  const bones = selectedBones(arm);
  if (!bones.length) {
    app.report('WARNING', 'No bones selected');
    return 'CANCELLED' as const;
  }
  let name: string | undefined;
  const idx = p.collection_index as number;
  if (idx < 0 || p.new_collection_name) name = A.addCollection(arm, (p.new_collection_name as string) || 'Bones').name;
  else name = A.collectionsOf(arm)[idx]?.name;
  if (!name) return 'CANCELLED' as const;
  for (const b of bones) {
    if (move) b.collections = [];
    A.assignBone(b, name);
  }
  void ctx;
  return 'FINISHED' as const;
}

registerOperators([
  {
    idname: 'armature.collection_add',
    label: 'Add Bone Collection',
    description: 'Add a new bone collection',
    poll: hasArm,
    exec: () => {
      A.addCollection(activeArmature()!.arm);
    },
  },
  {
    idname: 'armature.collection_remove',
    label: 'Remove Bone Collection',
    description: 'Remove the active bone collection (its bones stay)',
    poll: () => hasArm() && !!activeArmature()!.arm.collections?.length,
    exec: () => {
      const { arm } = activeArmature()!;
      A.removeCollection(arm, arm.active_collection_index ?? 0);
    },
  },
  {
    idname: 'armature.collection_move',
    label: 'Move Bone Collection',
    description: 'Move the active bone collection up or down in the list',
    props: [{ id: 'direction', label: 'Direction', type: 'enum', default: 'UP', items: [['UP', 'Up'], ['DOWN', 'Down']] }],
    poll: () => hasArm() && (activeArmature()!.arm.collections?.length ?? 0) > 1,
    exec: (_c, p) => {
      const { arm } = activeArmature()!;
      const cols = A.collectionsOf(arm);
      const i = arm.active_collection_index ?? 0;
      const j = p.direction === 'UP' ? i - 1 : i + 1;
      if (j < 0 || j >= cols.length) return 'CANCELLED';
      [cols[i], cols[j]] = [cols[j], cols[i]];
      arm.active_collection_index = j;
    },
  },
  {
    idname: 'armature.collection_assign',
    label: 'Assign to Collection',
    description: 'Add the selected bones to the active (or named) bone collection',
    props: [{ id: 'name', label: 'Bone Collection', type: 'string', default: '' }],
    poll: editOrPose,
    exec: (_c, p) => {
      const { arm } = activeArmature()!;
      const c = targetCollection(arm, p) ?? A.addCollection(arm);
      const bones = selectedBones(arm);
      if (!bones.length) return 'CANCELLED';
      for (const b of bones) A.assignBone(b, c.name);
    },
  },
  {
    idname: 'armature.collection_unassign',
    label: 'Remove from Collection',
    description: 'Remove the selected bones from the active (or named) bone collection',
    props: [{ id: 'name', label: 'Bone Collection', type: 'string', default: '' }],
    poll: () => editOrPose() && !!activeArmature()!.arm.collections?.length,
    exec: (_c, p) => {
      const { arm } = activeArmature()!;
      const c = targetCollection(arm, p);
      if (!c) return 'CANCELLED';
      for (const b of selectedBones(arm)) A.unassignBone(b, c.name);
    },
  },
  {
    idname: 'armature.collection_select',
    label: 'Select Bones of Bone Collection',
    description: 'Select the bones of the active bone collection',
    poll: () => editOrPose() && !!activeArmature()!.arm.collections?.length,
    exec: () => {
      const { arm } = activeArmature()!;
      const c = activeCollection(arm);
      setBonesSelected(
        arm.bones.filter((b) => b.collections?.includes(c.name) && A.boneVisible(arm, b)),
        true,
      );
    },
  },
  {
    idname: 'armature.collection_deselect',
    label: 'Deselect Bones of Bone Collection',
    description: 'Deselect the bones of the active bone collection',
    poll: () => editOrPose() && !!activeArmature()!.arm.collections?.length,
    exec: () => {
      const { arm } = activeArmature()!;
      const c = activeCollection(arm);
      setBonesSelected(
        arm.bones.filter((b) => b.collections?.includes(c.name)),
        false,
      );
    },
  },
  {
    idname: 'armature.collection_show_all',
    label: 'Show All',
    description: 'Make all bone collections visible',
    poll: () => hasArm() && !!activeArmature()!.arm.collections?.length,
    exec: () => {
      for (const c of A.collectionsOf(activeArmature()!.arm)) c.is_visible = true;
    },
  },
  {
    idname: 'armature.collection_unsolo_all',
    label: 'Un-solo All',
    description: 'Clear the solo flag of all bone collections',
    poll: () => hasArm() && !!activeArmature()!.arm.collections?.some((c) => c.is_solo),
    exec: () => {
      for (const c of A.collectionsOf(activeArmature()!.arm)) c.is_solo = false;
    },
  },
  {
    idname: 'armature.collection_remove_unused',
    label: 'Remove Unused Bone Collections',
    description: 'Remove bone collections that have no bones assigned',
    poll: () => hasArm() && !!activeArmature()!.arm.collections?.length,
    exec: () => {
      const { arm } = activeArmature()!;
      const used = new Set(arm.bones.flatMap((b) => b.collections ?? []));
      const cols = A.collectionsOf(arm);
      const before = cols.length;
      arm.collections = cols.filter((c) => used.has(c.name));
      arm.active_collection_index = Math.min(arm.active_collection_index ?? 0, Math.max(0, arm.collections.length - 1));
      if (arm.collections.length === before) return 'CANCELLED';
      app.report('INFO', `Removed ${before - arm.collections.length} unused bone collection(s)`);
    },
  },
  {
    idname: 'armature.collection_create_and_assign',
    label: 'Assign to New Collection',
    description: 'Create a bone collection and assign the selected bones to it',
    props: [{ id: 'name', label: 'Name', type: 'string', default: 'Bones' }],
    poll: editOrPose,
    exec: (_c, p) => {
      const { arm } = activeArmature()!;
      const bones = selectedBones(arm);
      const c = A.addCollection(arm, (p.name as string) || 'Bones');
      for (const b of bones) A.assignBone(b, c.name);
    },
  },
  {
    idname: 'armature.move_to_collection',
    label: 'Move to Collection',
    description: 'Move the selected bones to a bone collection (removing them from the others)',
    props: [
      { id: 'collection_index', label: 'Collection Index', type: 'int', default: 0, min: -1 },
      { id: 'new_collection_name', label: 'Name', type: 'string', default: '' },
    ],
    poll: editOrPose,
    invoke: () => {
      collectionMenu(true);
      return 'CANCELLED';
    },
    exec: (ctx, p) => moveOrAssign(ctx, p, true),
  },
  {
    idname: 'armature.assign_to_collection',
    label: 'Add Selected Bones to Collection',
    description: 'Add the selected bones to a bone collection (keeping their other collections)',
    props: [
      { id: 'collection_index', label: 'Collection Index', type: 'int', default: 0, min: -1 },
      { id: 'new_collection_name', label: 'Name', type: 'string', default: '' },
    ],
    poll: editOrPose,
    invoke: () => {
      collectionMenu(false);
      return 'CANCELLED';
    },
    exec: (ctx, p) => moveOrAssign(ctx, p, false),
  },
]);

/** The M / Shift M popup: existing collections, then "New Collection". */
export function collectionMenuItems(move: boolean): MenuItem[] {
  const a = activeArmature();
  if (!a) return [];
  const op = move ? 'armature.move_to_collection' : 'armature.assign_to_collection';
  const sel = selectedBones(a.arm);
  return [
    ...A.collectionsOf(a.arm).map((c, i) => ({ label: c.name, icon: 'bone_collection', op, props: { collection_index: i }, checked: sel.length > 0 && sel.every((b) => b.collections?.includes(c.name)) })),
    { separator: true },
    {
      label: 'New Collection…',
      icon: 'add',
      action: () => promptText('New Bone Collection', 'Bones', (n) => n && app.run(op, { collection_index: -1, new_collection_name: n }, { invoke: false })),
    },
  ];
}

function collectionMenu(move: boolean) {
  void import('../../ui/menu').then(({ openMenu }) => openMenu(collectionMenuItems(move), { x: app.pointer.x, y: app.pointer.y }, { title: move ? 'Move to Collection' : 'Add to Collection' }));
}

// ---------------------------------------------------------------------------
// Bone Collections panel (armature Object Data tab)

function change(label: string) {
  app.pushUndo(label);
  app.changed('doc');
}

armatureDataPanels.push((_ob, arm) =>
  panel('ar-bcolls', 'Bone Collections', () => {
    const cols = A.collectionsOf(arm);
    const editing = app.doc.mode === 'EDIT' || app.doc.mode === 'POSE';
    const count = (name: string) => arm.bones.filter((b) => b.collections?.includes(name)).length;
    return [
      uiList(
        'ar-bcoll-list',
        cols.map((c) => ({
          key: c.name,
          label: c.name,
          icon: 'bone_collection',
          right: [
            h('span', { class: 'ul-count', style: { opacity: '0.6', fontSize: '11px', marginRight: '4px', alignSelf: 'center' }, 'data-tip': 'Bones in this collection' }, String(count(c.name))),
            h(
              'button',
              { class: { 'icon-btn': true, on: !!c.is_solo }, 'data-tip': 'Solo: only show bones of soloed collections', onpointerdown: (e: Event) => e.stopPropagation(), onclick: () => ((c.is_solo = !c.is_solo), A.deselectHidden(arm), change('Solo Bone Collection')) },
              icon(c.is_solo ? 'solo_on' : 'solo_off'),
            ),
            h(
              'button',
              { class: 'icon-btn', 'data-tip': 'Show the bones of this collection', onpointerdown: (e: Event) => e.stopPropagation(), onclick: () => ((c.is_visible = !c.is_visible), A.deselectHidden(arm), change('Bone Collection Visibility')) },
              icon(c.is_visible ? 'hide_off' : 'hide_on'),
            ),
          ],
        })),
        arm.active_collection_index ?? 0,
        (i) => ((arm.active_collection_index = i), app.changed('doc')),
        {
          add: () => app.run('armature.collection_add'),
          remove: () => app.run('armature.collection_remove'),
          up: () => app.run('armature.collection_move', { direction: 'UP' }),
          down: () => app.run('armature.collection_move', { direction: 'DOWN' }),
          rename: (i, n) => {
            A.renameCollection(arm, i, n);
            change('Rename Bone Collection');
          },
          extra: editing
            ? h('div', { class: 'btn-row' }, opButton('armature.collection_assign', 'Assign'), opButton('armature.collection_unassign', 'Remove'), opButton('armature.collection_select', 'Select'), opButton('armature.collection_deselect', 'Deselect'))
            : null,
        },
      ),
    ];
  }),
);

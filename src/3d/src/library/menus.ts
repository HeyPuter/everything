// Menus and markers for linked data: Object ▸ Library Override and Relations ▸ Make Local, the
// link / override marks on Outliner rows and data-block selectors.
import { h } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import type { MenuItem } from '../ui/menu';
import { rowBadgeHooks, rowMenuHooks } from '../editors/outliner/menus';
import { idDecorationHooks } from '../ui/idmenu';
import { libraries, recordOf, tablesOf } from './core';
import type { LinkableID } from './types';
import type { Row } from '../editors/outliner/tree';

/** Object ▸ Library Override */
export function libOverrideMenu(): MenuItem[] {
  return [
    { label: 'Make', icon: 'library_override', op: 'object.make_override_library' },
    { label: 'Reset', op: 'object.reset_override_library' },
    { label: 'Clear', op: 'object.clear_override_library' },
  ];
}

/** Object ▸ Relations ▸ Make Local */
export function makeLocalMenu(): MenuItem[] {
  return [
    { label: 'Selected Objects', op: 'object.make_local', props: { type: 'SELECT_OBJECT' } },
    { label: 'Selected Objects and Data', op: 'object.make_local', props: { type: 'SELECT_OBDATA' } },
    { label: 'Selected Objects, Data and Materials', op: 'object.make_local', props: { type: 'SELECT_OBDATA_MATERIAL' } },
    { label: 'All', op: 'object.make_local', props: { type: 'ALL' } },
  ];
}

/** The data-block a row shows (objects, collections and data-block rows). */
export function rowRecord(r: Row): (LinkableID & Record<string, unknown>) | undefined {
  if (r.kind === 'object' && r.ob) return app.doc.objects[r.ob.id] as never;
  if (r.kind === 'collection' && r.id) return app.doc.collections[r.id] as never;
  if (r.table && r.id) return tablesOf(app.doc)[r.table]?.[r.id];
  return undefined;
}

/** "Linked from …" description of a data-block. */
export function linkTip(rec: LinkableID): string {
  if (rec.library) {
    const lib = libraries(app.doc)[rec.library];
    return `Linked from "${lib?.name ?? '?'}"${lib?.is_missing ? ' (file missing: shown as last loaded)' : ''}\nRead-only: make it local or add a library override to change it`;
  }
  if (rec.override_library) {
    const ref = recordOf(app.doc, rec.override_library.reference);
    const lib = ref?.library ? libraries(app.doc)[ref.library] : undefined;
    return `Library override of "${ref?.name ?? '?'}"${lib ? ` from "${lib.name}"` : ''}\nEditable; its linked data stays read-only`;
  }
  return '';
}

rowBadgeHooks.push((r) => {
  if (r.kind === 'library' || r.kind === 'override' || r.kind === 'rna') return null;
  const rec = rowRecord(r);
  if (!rec || (!rec.library && !rec.override_library)) return null;
  const missing = !!rec.library && !!libraries(app.doc)[rec.library]?.is_missing;
  const ic = rec.library ? (missing ? 'library_data_broken' : 'id_linked') : rec.override_library?.is_system_override ? 'library_override_system' : 'library_override';
  return h('span', { key: 'lib', class: { 'lib-mark': true, missing }, 'data-tip': linkTip(rec) }, icon(ic));
});

// library rows: stored in the project, or missing
rowBadgeHooks.push((r) => {
  if (r.kind !== 'library' || !r.id) return null;
  const lib = libraries(app.doc)[r.id];
  if (!lib) return null;
  return [
    lib.packed_file?.length ? h('span', { key: 'packed', class: 'lib-mark', 'data-tip': 'Packed\nThe library file is stored inside this project' }, icon('library_packed')) : null,
    lib.is_missing ? h('span', { key: 'missing', class: 'lib-tag', 'data-tip': 'The file could not be read: its data is shown as last loaded. Relocate the library to fix it.' }, 'missing') : null,
    h('span', { key: 'path', class: 'lib-tag', 'data-tip': lib.filepath }, lib.filepath === lib.name ? '' : lib.filepath.replace(/\/[^/]*$/, '')),
  ];
});

rowMenuHooks.push((r) => {
  const rec = rowRecord(r);
  if (!rec || (!rec.library && !rec.override_library)) return [];
  return [
    {
      label: 'Library Override',
      submenu: () => [
        { label: 'Make', submenu: () => overrideSelectionItems('OVERRIDE_LIBRARY_CREATE_HIERARCHY') },
        { label: 'Reset', submenu: () => overrideSelectionItems('OVERRIDE_LIBRARY_RESET') },
        { label: 'Clear', submenu: () => overrideSelectionItems('OVERRIDE_LIBRARY_CLEAR_SINGLE') },
        { separator: true },
        {
          label: 'Troubleshoot Hierarchy',
          submenu: () => [
            { label: 'Resync', op: 'outliner.liboverride_troubleshoot_operation', props: { type: 'OVERRIDE_LIBRARY_RESYNC_HIERARCHY' } },
            { label: 'Resync Enforce', op: 'outliner.liboverride_troubleshoot_operation', props: { type: 'OVERRIDE_LIBRARY_RESYNC_HIERARCHY_ENFORCE' } },
            { label: 'Delete', op: 'outliner.liboverride_troubleshoot_operation', props: { type: 'OVERRIDE_LIBRARY_DELETE_HIERARCHY' } },
          ],
        },
      ],
    },
    { separator: true },
  ];
});

export function overrideSelectionItems(type: string): MenuItem[] {
  return [
    { label: 'Selected', op: 'outliner.liboverride_operation', props: { type, selection_set: 'SELECTED' } },
    { label: 'Content', op: 'outliner.liboverride_operation', props: { type, selection_set: 'CONTENT' } },
    { label: 'Selected & Content', op: 'outliner.liboverride_operation', props: { type, selection_set: 'SELECTED_AND_CONTENT' } },
  ];
}

idDecorationHooks.push((id) => {
  const rec = recordOf(app.doc, id);
  if (!rec || (!rec.library && !rec.override_library)) return null;
  const lib = rec.library ? libraries(app.doc)[rec.library] : undefined;
  return { icon: rec.library ? 'id_linked' : 'library_override', tip: linkTip(rec), note: lib?.name, readonly: !!rec.library };
});

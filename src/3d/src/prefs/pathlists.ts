// Preferences lists of paths: Asset Libraries (section), Script Directories (File Paths) and the
// auto-run Excluded Paths (Save & Load).
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import { prefs } from '../app/prefs';
import { panel, textField, enumMenu } from '../ui/widgets';
import { splitRow } from '../ui/props';
import { registerPrefSection } from './editor';
import { setPref } from './store';
import { note } from './ui';
import { libraries, renameLibrary, setLibraryImportMethod, onLibrariesChanged, loadLibraryIndex, type ImportMethod } from '../assets/library';
import { scriptDirs, refreshScriptDirectories } from './scriptdirs';

const IMPORT_METHODS = [
  { value: 'APPEND', label: 'Append', description: 'Copy the asset into the project' },
  { value: 'APPEND_REUSE', label: 'Append (Reuse Data)', description: 'Copy the asset, reusing data that was appended before' },
  { value: 'LINK', label: 'Link', description: 'Reference the asset from its library' },
];

let libsHooked = false;

function assetLibrariesBody(): Child {
  if (!libsHooked) {
    libsHooked = true;
    onLibrariesChanged(() => app.changed('ui'));
    void loadLibraryIndex();
  }
  const list = libraries().filter((l) => l.kind !== 'LOCAL');
  let userIndex = -1;
  return [
    panel('pf-assetlibs', 'Asset Libraries', () => [
      h(
        'div',
        { class: 'pl-list' },
        list.map((l) => {
          const user = l.kind === 'USER';
          const idx = user ? ++userIndex : -1;
          return h(
            'div',
            { key: l.id, class: { 'pl-item': true, builtin: !user } },
            h('span', { class: 'pl-icon' }, icon(user ? 'asset_library' : 'asset_essentials')),
            user ? textField(`pl-name-${l.id}`, l.name, (v) => v.trim() && renameLibrary(l.id, v.trim()), { className: 'pl-name' }) : h('span', { class: 'pl-name pl-fixed' }, l.name),
            enumMenu(`pl-imp-${l.id}`, IMPORT_METHODS, l.import_method, (v) => setLibraryImportMethod(l.id, v as ImportMethod), { disabled: !user && l.kind !== 'ESSENTIALS', tip: 'Import Method\nHow assets of this library are brought into a project by default' }),
            user
              ? h('button', { class: 'btn icon-btn', 'data-tip': 'Remove\nDelete the library and its assets from this browser', 'aria-label': `Remove ${l.name}`, onclick: () => app.run('preferences.asset_library_remove', { index: idx }) }, icon('remove'))
              : h('span', { class: 'pl-badge' }, 'Built-in'),
          );
        }),
      ),
      h('div', { class: 'prefs-btn-row left' }, h('button', { class: 'btn', onclick: () => app.run('preferences.asset_library_add', {}, { invoke: true }) }, icon('add'), 'Add Asset Library')),
      note('Libraries live in this browser’s storage. Mark assets in a project, then add them to a library from the Asset Browser.'),
    ]),
  ];
}

registerPrefSection({ id: 'ASSET_LIBRARIES', label: 'Asset Libraries', group: 1.5, draw: () => assetLibrariesBody() });

/** File Paths ▸ Script Directories panel. */
export function scriptDirectoriesPanel(): Child {
  return panel('pf-fp-scripts', 'Script Directories', () => [
    scriptDirs.length
      ? h(
          'div',
          { class: 'pl-list' },
          scriptDirs.map((d, i) =>
            h('div', { key: `${d.name}${i}`, class: 'pl-item' }, h('span', { class: 'pl-icon' }, icon('file_folder')), h('span', { class: 'pl-name pl-fixed' }, d.name), h('button', { class: 'btn icon-btn', 'data-tip': 'Remove\nForget this script folder', 'aria-label': `Remove ${d.name}`, onclick: () => app.run('preferences.script_directory_remove', { index: i }) }, icon('remove'))),
          ),
        )
      : null,
    h(
      'div',
      { class: 'prefs-btn-row left' },
      h('button', { class: 'btn', onclick: () => app.run('preferences.script_directory_add') }, icon('add'), 'Add'),
      h('button', { class: 'btn', disabled: !scriptDirs.length, 'data-tip': 'Refresh\nInstall add-ons added or changed in the script folders', onclick: () => void refreshScriptDirectories().then((n) => app.report('INFO', n ? `${n} add-on${n === 1 ? '' : 's'} updated` : 'Add-ons are up to date')) }, icon('file_refresh'), 'Refresh'),
    ),
    note('Add-on files (.py, .js) in a folder named "addons" inside a script directory appear in Preferences ▸ Add-ons.'),
  ]);
}

/** Save & Load ▸ Auto Run Scripts ▸ Excluded Paths rows. */
export function excludedPathsRows(): Child {
  const paths = prefs.autoexec_paths ?? [];
  return [
    splitRow(
      'Excluded Paths',
      h(
        'div',
        { class: 'pl-col' },
        paths.map((p, i) =>
          h(
            'div',
            { key: `ae${i}`, class: 'pl-item' },
            textField(`pl-ae-${i}`, p, (v) => setPref('autoexec_paths', paths.map((x, j) => (j === i ? v : x))), { placeholder: 'Project name or pattern (e.g. downloads_*)', className: 'pl-name' }),
            h('button', { class: 'btn icon-btn', 'data-tip': 'Remove', 'aria-label': 'Remove excluded path', onclick: () => app.run('preferences.autoexec_path_remove', { index: i }) }, icon('remove')),
          ),
        ),
        h('button', { class: 'btn pl-add', onclick: () => app.run('preferences.autoexec_path_add') }, icon('add'), 'Add Path'),
      ),
    ),
    note('Registered scripts of projects whose name matches a pattern never run automatically.'),
  ];
}

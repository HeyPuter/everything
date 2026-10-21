// Preferences operators: key map items and key configurations, studio lights, themes, add-ons,
// asset libraries, script directories and auto-run exclusions (used by the Preferences editor's
// buttons, keymaps, F3 search and scripts).
import { app, registerOperators } from '../app/app';
import { keymaps, type KeyItem } from '../app/keymap';
import { prefs } from '../app/prefs';
import { promptText } from '../ui/menu';
import { pickFile } from '../io/native';
import { keyconfig, keyconfigChanged, presetChoices, choosePreset, currentPresetChoice, userPresets, removeUserPreset } from './keyconfig';
import { library } from '../render/studiolights';
import { cleanStudioLight, installMatcap, installHdri, newStudioLight, removeEntry, saveStudioLights, studioLightChanged, studioSelection } from './lights_ui';
import { setThemePreset, themeState } from './theme_ui';
import { addons, expandAddon, setAddonFilter, refreshAddons, setAddonEnabled } from './addons';
import { setPref } from './store';
import { showPreferences } from '../scripting/wmops';
import { userLibraries, createLibrary, deleteLibrary } from '../assets/library';
import { scriptDirs, addScriptDirectory, removeScriptDirectory, refreshScriptDirectories } from './scriptdirs';
import { keyConflicts } from './keyconflicts';

/** Key map item of an operator call: by keymap name and index (or the item's stable id). */
function itemOf(p: Record<string, unknown>): KeyItem | null {
  const id = String(p.item_name ?? '');
  if (id) return keyconfig.itemById(id) ?? null;
  const list = keymaps[String(p.keymap ?? '')];
  const i = Number(p.item_id);
  return list && Number.isInteger(i) && i >= 0 && i < list.length ? list[i] : null;
}

const kmProp = { id: 'keymap', label: 'Keymap', type: 'string' as const, default: '' };
const itemProps = [{ id: 'item_id', label: 'Item Identifier', type: 'int' as const, default: 0, min: 0 }, kmProp, { id: 'item_name', label: 'Item Name', type: 'string' as const, default: '', hidden: true }];

function studioList(type: string) {
  return type === 'MATCAP' ? library.matcaps : type === 'WORLD' ? library.hdris : library.studio;
}
const lightType = { id: 'type', label: 'Type', type: 'enum' as const, default: 'STUDIO', items: [['MATCAP', 'MatCap', 'Sphere images for Solid shading'], ['WORLD', 'World', 'Environment images for Material Preview lighting'], ['STUDIO', 'Studio', 'Studio lights for Solid shading']] as [string, string, string][] };

registerOperators([
  // ------------------------------------------------------------------ keymap
  {
    idname: 'preferences.keyitem_add',
    label: 'Add Key Map Item',
    description: 'Add an empty key binding to a keymap',
    undo: false,
    props: [kmProp],
    poll: () => true,
    exec: (_c, p) => {
      const km = String(p.keymap);
      if (!keymaps[km]) {
        app.report('ERROR', `No keymap named "${km}"`);
        return 'CANCELLED';
      }
      keyconfig.addItem(km, { key: 'NONE', op: '' });
      keyconfigChanged();
      app.changed('ui');
    },
  },
  {
    idname: 'preferences.keyitem_remove',
    label: 'Remove Key Map Item',
    description: 'Remove a key binding (default bindings can be restored)',
    undo: false,
    props: itemProps,
    exec: (_c, p) => {
      const k = itemOf(p);
      if (!k) return 'CANCELLED';
      keyconfig.remove(k);
      keyconfigChanged();
      app.changed('ui');
    },
  },
  {
    idname: 'preferences.keyitem_restore',
    label: 'Restore Key Map Item',
    description: 'Restore a key binding to its default',
    undo: false,
    props: itemProps,
    exec: (_c, p) => {
      const k = itemOf(p);
      if (!k || !keyconfig.isModified(k)) return 'CANCELLED';
      keyconfig.restore(k);
      keyconfigChanged();
      app.changed('ui');
    },
  },
  {
    idname: 'preferences.keymap_restore',
    label: 'Restore Key Map(s)',
    description: 'Restore the default bindings of a keymap, or of all keymaps',
    undo: false,
    props: [{ id: 'all', label: 'All Keymaps', type: 'bool', default: false }, kmProp],
    exec: (_c, p) => {
      if (p.all) keyconfig.restoreAll();
      else {
        const km = String(p.keymap);
        if (!keymaps[km]) return 'CANCELLED';
        keyconfig.restoreKeymap(km);
      }
      keyconfigChanged();
      app.changed('ui');
    },
  },
  {
    idname: 'preferences.keyconfig_activate',
    label: 'Activate Keyconfig',
    description: 'Use a key configuration preset (built-in id or saved name)',
    undo: false,
    props: [{ id: 'filepath', label: 'Preset', type: 'string', default: '' }],
    exec: (_c, p) => {
      const want = String(p.filepath).replace(/^.*[\\/]/, '').replace(/\.json$/i, '');
      const c = presetChoices().find((x) => x.value === want || x.label === want || x.value === `user:${want}`);
      if (!c) {
        app.report('ERROR', `No key configuration "${want}"`);
        return 'CANCELLED';
      }
      choosePreset(c.value);
      app.changed('ui');
    },
  },
  {
    idname: 'preferences.keyconfig_remove',
    label: 'Remove Key Config',
    description: 'Delete the active saved key configuration (the current bindings stay)',
    undo: false,
    poll: () => currentPresetChoice().startsWith('user:'),
    exec: () => {
      const name = currentPresetChoice().slice(5);
      if (!userPresets()[name]) return 'CANCELLED';
      removeUserPreset(name);
      app.changed('ui');
    },
  },
  {
    idname: 'preferences.keyconfig_test',
    label: 'Test Key Configuration for Conflicts',
    description: 'List bindings of a keymap that the same key press would trigger together',
    undo: false,
    exec: () => {
      const found = keyConflicts(keymaps);
      for (const c of found) app.report('WARNING', `${c.keymap}: ${c.key} runs ${c.items.join(' and ')}`);
      app.report('INFO', found.length ? `${found.length} key conflict${found.length === 1 ? '' : 's'} found (see the Info log)` : 'No key conflicts found');
    },
  },
  // ------------------------------------------------------------------ studio lights
  {
    idname: 'preferences.studiolight_install',
    label: 'Install Light',
    description: 'Install a MatCap, an HDRI or a studio light file',
    undo: false,
    props: [lightType],
    exec: (_c, p) => {
      const type = String(p.type);
      void pickFile(type === 'MATCAP' ? 'image/*' : type === 'WORLD' ? '.hdr,.exr,image/*' : '.json,.sl,application/json').then(async (f) => {
        if (!f) return;
        try {
          if (type === 'MATCAP') await installMatcap(f);
          else if (type === 'WORLD') await installHdri(f);
          else {
            const raw = JSON.parse(await f.text()) as unknown;
            const list = (Array.isArray(raw) ? raw : [raw]).map(cleanStudioLight).filter((x): x is NonNullable<typeof x> => !!x);
            if (!list.length) throw new Error('no studio light in the file');
            for (const s of list) newStudioLight(s, s.name);
          }
          app.report('INFO', `Installed "${f.name}"`);
        } catch (e) {
          app.report('ERROR', `Could not install ${f.name}: ${(e as Error).message}`);
        }
      });
    },
  },
  {
    idname: 'preferences.studiolight_new',
    label: 'Save Custom Studio Light',
    description: 'Save the studio light being edited as a new studio light',
    undo: false,
    props: [{ id: 'filename', label: 'Name', type: 'string', default: 'StudioLight' }],
    exec: (_c, p) => {
      const from = library.studio.find((s) => s.id === studioSelection.id) ?? library.studio[0];
      if (!from) return 'CANCELLED';
      studioSelection.id = newStudioLight(from, String(p.filename || 'StudioLight')).id;
      app.changed('ui');
    },
  },
  {
    idname: 'preferences.studiolight_uninstall',
    label: 'Uninstall Studio Light',
    description: 'Remove an installed studio light, MatCap or HDRI (built-in ones stay)',
    undo: false,
    props: [{ id: 'index', label: 'Index', type: 'int', default: 0, min: 0 }, lightType],
    exec: (_c, p) => {
      const type = String(p.type);
      const item = studioList(type)[Number(p.index)] as { id: string; builtin?: boolean } | undefined;
      if (!item || item.builtin) {
        app.report('WARNING', item ? 'Built-in lights cannot be removed' : 'No light at that index');
        return 'CANCELLED';
      }
      if (type === 'STUDIO') {
        library.studio = library.studio.filter((s) => s.id !== item.id);
        if (studioSelection.id === item.id) studioSelection.id = 'default';
        saveStudioLights();
        app.changed('ui', 'view');
      } else void removeEntry(type === 'MATCAP' ? 'matcap' : 'hdri', item.id).then(() => app.changed('ui'));
    },
  },
  {
    idname: 'preferences.studiolight_copy_settings',
    label: 'Copy Studio Light Settings',
    description: 'Copy the lights of a studio light into the one being edited',
    undo: false,
    props: [{ id: 'index', label: 'Index', type: 'int', default: 0, min: 0 }],
    exec: (_c, p) => {
      const src = library.studio[Number(p.index)];
      const dst = library.studio.find((s) => s.id === studioSelection.id);
      if (!src || !dst || src === dst) return 'CANCELLED';
      if (dst.builtin) {
        app.report('WARNING', 'Built-in studio lights cannot be edited; copy one first');
        return 'CANCELLED';
      }
      const { id, name, builtin, standard, ...rest } = JSON.parse(JSON.stringify(src)) as typeof src & { standard?: unknown };
      void id;
      void name;
      void builtin;
      void standard;
      Object.assign(dst, rest);
      studioLightChanged(dst);
      app.changed('ui', 'view');
    },
  },
  // ------------------------------------------------------------------ themes
  {
    idname: 'preferences.reset_default_theme',
    label: 'Reset to Default Theme',
    description: 'Use the default theme without colour changes',
    undo: false,
    exec: () => {
      themeState.edits = {};
      setThemePreset('DEFAULT');
      app.changed('ui');
    },
  },
  // ------------------------------------------------------------------ add-ons
  {
    idname: 'preferences.addon_expand',
    label: 'Expand Add-on',
    description: "Show or hide an add-on's details in the list",
    undo: false,
    internal: true,
    props: [{ id: 'module', label: 'Module', type: 'string', default: '' }],
    exec: (_c, p) => (addons.has(String(p.module)) ? expandAddon(String(p.module)) : 'CANCELLED'),
  },
  {
    idname: 'preferences.addon_show',
    label: 'Show Add-on',
    description: 'Show an add-on in Preferences ▸ Add-ons with its details open',
    undo: false,
    props: [{ id: 'module', label: 'Module', type: 'string', default: '' }],
    exec: (_c, p) => {
      const a = addons.get(String(p.module));
      if (!a) return 'CANCELLED';
      setAddonFilter(a.info.name);
      expandAddon(a.id, true);
      showPreferences('ADDONS');
    },
  },
  {
    idname: 'preferences.addon_refresh',
    label: 'Refresh',
    description: 'Read the installed add-ons again',
    undo: false,
    exec: () => void refreshAddons(),
  },
  {
    idname: 'preferences.start_filter',
    label: 'Filter',
    description: 'Type in the search field of the Preferences',
    undo: false,
    exec: () => {
      const inp = document.querySelector<HTMLInputElement>('.prefs-search input');
      if (!inp) return 'CANCELLED';
      inp.focus();
      inp.select();
    },
  },
  {
    idname: 'preferences.clear_filter',
    label: 'Clear Filter',
    description: 'Clear the search field of the Preferences',
    undo: false,
    exec: () => {
      const inp = document.querySelector<HTMLInputElement>('.prefs-search input');
      if (!inp) return 'CANCELLED';
      inp.value = '';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    },
  },
  {
    idname: 'script.reload',
    label: 'Reload Scripts',
    description: 'Run the enabled add-ons again (after their files changed), picking up changes in the script directories',
    undo: false,
    exec: () => {
      void (async () => {
        const n = await refreshScriptDirectories().catch(() => 0);
        const on = [...addons.values()].filter((a) => a.enabled).map((a) => a.id);
        for (const id of on) {
          await setAddonEnabled(id, false);
          await setAddonEnabled(id, true);
        }
        app.report('INFO', `Reloaded ${on.length} add-on${on.length === 1 ? '' : 's'}${n ? ` (${n} updated from script directories)` : ''}`);
      })();
    },
  },
  // ------------------------------------------------------------------ asset libraries
  {
    idname: 'preferences.asset_library_add',
    label: 'Add Asset Library',
    description: 'Add an asset library kept in this browser’s storage',
    undo: false,
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    invoke: (_c, p) => {
      if (p.name) return app.run('preferences.asset_library_add', p, { invoke: false });
      promptText('New Asset Library', 'User Library', (n) => n && app.run('preferences.asset_library_add', { name: n }, { invoke: false }));
      return 'CANCELLED';
    },
    exec: (_c, p) => void createLibrary(String(p.name || 'User Library')).then(() => app.changed('ui')),
  },
  {
    idname: 'preferences.asset_library_remove',
    label: 'Remove Asset Library',
    description: 'Delete a user asset library and its assets from this browser',
    undo: false,
    props: [{ id: 'index', label: 'Index', type: 'int', default: 0, min: 0 }],
    poll: () => userLibraries().length > 0,
    exec: (_c, p) => {
      const lib = userLibraries()[Number(p.index)];
      if (!lib) return 'CANCELLED';
      void deleteLibrary(lib.id).then(() => {
        app.report('INFO', `Deleted the asset library "${lib.name}"`);
        app.changed('ui');
      });
    },
  },
  // ------------------------------------------------------------------ script directories
  {
    idname: 'preferences.script_directory_add',
    label: 'Add Script Directory',
    description: 'Add a folder whose add-ons (in its "addons" folder) are offered in Preferences ▸ Add-ons',
    undo: false,
    exec: () => void addScriptDirectory(),
  },
  {
    idname: 'preferences.script_directory_remove',
    label: 'Remove Script Directory',
    description: 'Forget a script folder (its installed add-ons stay)',
    undo: false,
    props: [{ id: 'index', label: 'Index', type: 'int', default: 0, min: 0 }],
    poll: () => scriptDirs.length > 0,
    exec: (_c, p) => (removeScriptDirectory(Number(p.index)) ? 'FINISHED' : 'CANCELLED'),
  },
  // ------------------------------------------------------------------ auto run exclusions
  {
    idname: 'preferences.autoexec_path_add',
    label: 'Add Auto-Execution Path',
    description: 'Add a project name pattern whose registered scripts never run automatically',
    undo: false,
    props: [{ id: 'path', label: 'Path', type: 'string', default: '' }],
    exec: (_c, p) => {
      setPref('autoexec_paths', [...prefs.autoexec_paths, String(p.path ?? '')]);
      app.changed('ui');
    },
  },
  {
    idname: 'preferences.autoexec_path_remove',
    label: 'Remove Auto-Execution Path',
    description: 'Remove an excluded project name pattern',
    undo: false,
    props: [{ id: 'index', label: 'Index', type: 'int', default: 0, min: 0 }],
    poll: () => prefs.autoexec_paths.length > 0,
    exec: (_c, p) => {
      const i = Number(p.index);
      if (i < 0 || i >= prefs.autoexec_paths.length) return 'CANCELLED';
      setPref(
        'autoexec_paths',
        prefs.autoexec_paths.filter((_, j) => j !== i),
      );
      app.changed('ui');
    },
  },
]);

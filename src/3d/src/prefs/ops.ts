// Operators for tools and key configurations (usable from keymaps, menus and F3 search).
import { app, registerOperators } from '../app/app';
import { toolsFor, setActiveTool } from '../editors/view3d/toolbar';
import { download, pickFile } from '../io/native';
import { exportKeyconfigText, importKeyconfigText, keyconfig } from './keyconfig';

const SELECT_TOOLS = ['builtin.select', 'builtin.select_box', 'builtin.select_circle', 'builtin.select_lasso'];

function toolAvailable(name: string) {
  if (SELECT_TOOLS.includes(name)) return toolsFor(app.doc.mode).some((t) => !!t && SELECT_TOOLS.includes(t.id));
  return toolsFor(app.doc.mode).some((t) => t?.id === name);
}

registerOperators([
  {
    idname: 'wm.tool_set_by_id',
    label: 'Set Tool by Name',
    description: 'Make a tool of the toolbar the active one',
    undo: false,
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    poll: () => !!app.doc,
    exec: (_c, p) => {
      const name = String(p.name ?? '');
      if (!toolAvailable(name)) {
        app.report('WARNING', `Tool "${name}" is not available in this mode`);
        return 'CANCELLED';
      }
      setActiveTool(name);
    },
  },
  {
    idname: 'preferences.keyconfig_export',
    label: 'Export Key Configuration…',
    description: 'Save the current key bindings to a JSON file',
    undo: false,
    exec: () => {
      const name = keyconfig.data.name ?? 'keymap';
      download(exportKeyconfigText(name), `${name.replace(/[^\w.-]+/g, '_')}.json`, 'application/json');
    },
  },
  {
    idname: 'preferences.keyconfig_import',
    label: 'Import Key Configuration…',
    description: 'Load key bindings from a JSON file',
    undo: false,
    exec: () => {
      void pickFile('.json,application/json').then(async (f) => {
        if (!f) return;
        try {
          importKeyconfigText(await f.text(), f.name.replace(/\.json$/i, ''));
          app.report('INFO', `Key configuration "${f.name}" imported`);
        } catch (e) {
          app.report('ERROR', `Could not import ${f.name}: ${(e as Error).message}`);
        }
        app.changed('ui');
      });
    },
  },
]);

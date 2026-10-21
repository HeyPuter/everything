// Application templates: a project file installed as a starting point for File ▸ New (and the
// splash screen). Installed with preferences.app_template_install from a .p3d project (or a .zip
// holding one); kept in IndexedDB; removed in Preferences ▸ Save & Load ▸ Application Templates.
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, onAppReady, operators, registerOperators } from '../app/app';
import { panel } from '../ui/widgets';
import { pickFile } from '../io/native';
import { decodeDocument, isNativeFile } from '../io/native';
import { fileEvents, projectUiState } from '../io/files';
import { prefs } from '../app/prefs';
import { fileNewTemplates } from '../ui/shell';
import { assetGet, assetPut, assetDelete, assetKeys } from './assetstore';
import { note } from './ui';

const KEY = (name: string) => `apptpl:${name}`;
export const appTemplates = new Map<string, Uint8Array>();

/** Template name from a file name: "my_studio-setup.p3d" → "My Studio Setup". */
export function templateName(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.(p3d|zip)$/i, '');
  return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()) || 'Template';
}

function addMenuEntry(name: string) {
  if (fileNewTemplates.some((t) => t.template === `user:${name}`)) return;
  fileNewTemplates.push({ label: name, icon: 'file_blank', template: `user:${name}` });
}

function removeMenuEntry(name: string) {
  const i = fileNewTemplates.findIndex((t) => t.template === `user:${name}`);
  if (i >= 0) fileNewTemplates.splice(i, 1);
}

/** Install project bytes (or a .zip holding a project) as a template; returns its name. */
export async function installAppTemplate(filename: string, bytes: Uint8Array, overwrite = true): Promise<string> {
  let name = templateName(filename);
  let data = bytes;
  if (/\.zip$/i.test(filename)) {
    const files = unzipSync(bytes);
    const proj = Object.keys(files).find((n) => /\.p3d$/i.test(n) && !n.startsWith('__MACOSX/'));
    if (!proj) throw new Error('The archive holds no .p3d project');
    data = files[proj];
    // a template folder names the template
    const folder = proj.includes('/') ? proj.split('/')[0] : '';
    if (folder) name = templateName(folder);
  }
  if (!isNativeFile(data)) throw new Error('Not a project file');
  decodeDocument(data);
  if (appTemplates.has(name) && !overwrite) throw new Error(`A template named "${name}" is installed already`);
  appTemplates.set(name, data);
  await assetPut(KEY(name), { name, bytes: data });
  addMenuEntry(name);
  app.changed('ui');
  return name;
}

export async function removeAppTemplate(name: string): Promise<boolean> {
  if (!appTemplates.delete(name)) return false;
  await assetDelete(KEY(name));
  removeMenuEntry(name);
  app.changed('ui');
  return true;
}

/** File ▸ New from an installed template. */
function loadTemplate(name: string): boolean {
  const bytes = appTemplates.get(name);
  if (!bytes) return false;
  const { doc, extra } = decodeDocument(bytes);
  fileEvents.beforeReplace('Before New File');
  app.setDocument(doc);
  if (extra.ui && prefs.use_load_ui) projectUiState.load(extra.ui as Record<string, unknown>);
  app.filename = 'untitled.p3d';
  fileEvents.saveTarget = null;
  app.dirty = false;
  return true;
}

onAppReady(() => {
  void (async () => {
    for (const k of ((await assetKeys()) ?? []).map(String).filter((x) => x.startsWith('apptpl:'))) {
      const r = await assetGet<{ name: string; bytes: Uint8Array }>(k);
      if (!r?.bytes) continue;
      appTemplates.set(r.name, r.bytes);
      addMenuEntry(r.name);
    }
  })();
  const op = operators.get('wm.read_homefile');
  if (!op?.exec) return;
  const prev = op.exec;
  op.exec = (ctx, p) => {
    const t = String(p.app_template ?? '');
    if (t.startsWith('user:')) {
      if (loadTemplate(t.slice(5))) return 'FINISHED';
      app.report('ERROR', `The application template "${t.slice(5)}" is not installed`);
      return 'CANCELLED';
    }
    return prev(ctx, p);
  };
});

registerOperators([
  {
    idname: 'preferences.app_template_install',
    label: 'Install Template from File…',
    description: 'Install a project file (.p3d, or a .zip holding one) as a template for File ▸ New',
    undo: false,
    props: [{ id: 'overwrite', label: 'Overwrite', type: 'bool', default: true }],
    exec: (_c, p) => {
      void pickFile('.p3d,.zip').then(async (f) => {
        if (!f) return;
        try {
          const name = await installAppTemplate(f.name, new Uint8Array(await f.arrayBuffer()), p.overwrite !== false);
          app.report('INFO', `Installed the application template "${name}" (File ▸ New)`);
        } catch (e) {
          app.report('ERROR', `Could not install ${f.name}: ${(e as Error).message}`);
        }
      });
    },
  },
  {
    idname: 'preferences.app_template_remove',
    label: 'Remove Application Template',
    description: 'Remove an installed application template',
    undo: false,
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    poll: () => appTemplates.size > 0,
    exec: (_c, p) => {
      if (!appTemplates.has(String(p.name))) return 'CANCELLED';
      void removeAppTemplate(String(p.name));
    },
  },
]);

/** Save & Load ▸ Application Templates panel. */
export function appTemplatesPanel(): Child {
  return panel('pf-apptpl', 'Application Templates', () => [
    appTemplates.size
      ? h(
          'div',
          { class: 'pl-list' },
          [...appTemplates.keys()].sort().map((n) =>
            h('div', { key: n, class: 'pl-item' }, h('span', { class: 'pl-icon' }, icon('file_blank')), h('span', { class: 'pl-name pl-fixed' }, n), h('button', { class: 'btn icon-btn', 'data-tip': 'Remove\nRemove this template', 'aria-label': `Remove ${n}`, onclick: () => app.run('preferences.app_template_remove', { name: n }) }, icon('remove'))),
          ),
        )
      : null,
    h('div', { class: 'prefs-btn-row left' }, h('button', { class: 'btn', onclick: () => app.run('preferences.app_template_install') }, icon('import'), 'Install Template…')),
    note('A template is a project file that File ▸ New starts from, listed under its name.'),
  ], { closed: !appTemplates.size });
}

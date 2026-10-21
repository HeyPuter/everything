// Preferences ▸ Get Extensions: install extension packages (.zip with an extension.json manifest,
// see extensions_core.ts) from disk, list them, enable / disable and uninstall them. There is no
// online repository: packages come from files the user picks or drops. Add-on extensions install
// through the add-on system (Preferences ▸ Add-ons lists them too); theme extensions become saved
// themes. Packages are kept in IndexedDB so they can be repaired or reinstalled.
import { unzipSync, zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, onAppReady, registerOperators } from '../app/app';
import { checkbox, enumMenu, panel } from '../ui/widgets';
import { download, pickFile } from '../io/native';
import { APP_VERSION } from '../scripting/wmops';
import { registerPrefSection } from './editor';
import { assetGet, assetPut, assetDelete, assetKeys } from './assetstore';
import { addons, installAddon, removeAddon, setAddonEnabled } from './addons';
import { importThemeText, removeUserTheme, setThemePreset, themeState, userThemes } from './theme_ui';
import { parseManifest, packageFiles, filterExtensions, allTags, MANIFEST_NAME, type ExtensionRecord, type ExtensionType } from './extensions_core';

export const extensions = new Map<string, ExtensionRecord>();
let loaded = false;
/** last install / uninstall problems (shown until cleared) */
const status: { type: 'INFO' | 'ERROR'; text: string }[] = [];
const ui = { search: '', type: 'ALL' as ExtensionType | 'ALL', tags: [] as string[], expanded: new Set<string>() };

const KEY = (id: string) => `ext:${id}`;
const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const extOf = (entry: string) => (/\.py$/i.test(entry) ? 'py' : 'js');

async function loadInstalled() {
  const keys = ((await assetKeys()) ?? []).map(String).filter((k) => k.startsWith('ext:'));
  for (const k of keys) {
    const r = await assetGet<ExtensionRecord>(k);
    if (r?.manifest?.id) extensions.set(r.manifest.id, r);
  }
  loaded = true;
  app.changed('ui');
}
onAppReady(() => void loadInstalled());

function report(type: 'INFO' | 'ERROR', text: string) {
  status.push({ type, text });
  if (status.length > 6) status.shift();
  app.report(type, text);
}

/** Whether an installed extension is active: an enabled add-on, or the theme in use. */
export function extensionEnabled(r: ExtensionRecord): boolean {
  if (r.manifest.type === 'add-on') return !!addons.get(r.manifest.id)?.enabled;
  return themeState.preset === `user:${r.manifest.name}`;
}

/** Whether what the extension installed is still there (add-on present / theme saved). */
export function extensionIntact(r: ExtensionRecord): boolean {
  return r.manifest.type === 'add-on' ? addons.has(r.manifest.id) : !!userThemes()[r.manifest.name];
}

async function activate(r: ExtensionRecord, enable: boolean) {
  const m = r.manifest;
  const entry = r.files[m.entry];
  if (!entry) throw new Error(`The package has no file "${m.entry}"`);
  if (m.type === 'add-on') {
    await installAddon(`${m.id}.${extOf(m.entry)}`, decode(entry), enable);
    const a = addons.get(m.id);
    if (enable && a?.error) throw new Error(a.error);
  } else {
    const raw = JSON.parse(decode(entry)) as Record<string, unknown>;
    raw.name = m.name;
    const before = themeState.preset;
    importThemeText(JSON.stringify(raw), m.name);
    if (!enable) setThemePreset(before);
  }
}

/** Install a package from the bytes of a .zip; returns the extension id. */
export async function installPackage(bytes: Uint8Array, opts: { enable?: boolean; overwrite?: boolean; filename?: string } = {}): Promise<string> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error(`${opts.filename ?? 'The file'} is not a valid .zip package`);
  }
  const pkg = packageFiles(files);
  if (!pkg) throw new Error(`No ${MANIFEST_NAME} found in ${opts.filename ?? 'the package'}`);
  let raw: unknown;
  try {
    raw = JSON.parse(decode(pkg.files[MANIFEST_NAME]));
  } catch {
    throw new Error(`${MANIFEST_NAME} is not valid JSON`);
  }
  const res = parseManifest(raw, APP_VERSION);
  if (!res.ok) throw new Error(res.error);
  const m = res.manifest;
  if (!pkg.files[m.entry]) throw new Error(`The package has no file "${m.entry}"`);
  const old = extensions.get(m.id);
  if (old && opts.overwrite === false) throw new Error(`"${m.name}" is already installed`);
  // an add-on of the same id that did not come from a package is not replaced silently
  if (!old && m.type === 'add-on' && addons.has(m.id)) throw new Error(`An add-on named "${m.id}" is already installed (remove it in Add-ons first)`);
  const rec: ExtensionRecord = { manifest: m, files: pkg.files, installed: Date.now() };
  await activate(rec, opts.enable !== false);
  extensions.set(m.id, rec);
  await assetPut(KEY(m.id), rec);
  app.changed('ui');
  return m.id;
}

/** Remove an extension and what it installed. */
export async function uninstallExtension(id: string): Promise<boolean> {
  const r = extensions.get(id);
  if (!r) return false;
  if (r.manifest.type === 'add-on') await removeAddon(id);
  else removeUserTheme(r.manifest.name);
  extensions.delete(id);
  await assetDelete(KEY(id));
  app.changed('ui');
  return true;
}

/** Turn an extension on or off (reinstalling what went missing). */
export async function setExtensionEnabled(id: string, on: boolean): Promise<boolean> {
  const r = extensions.get(id);
  if (!r) return false;
  if (!extensionIntact(r)) {
    await activate(r, on);
    return true;
  }
  if (r.manifest.type === 'add-on') return setAddonEnabled(id, on);
  if (on) setThemePreset(`user:${r.manifest.name}`);
  else if (extensionEnabled(r)) setThemePreset('DEFAULT');
  app.changed('ui');
  return true;
}

/** A small example package (an add-on adding a menu operator), to show the format. */
export function examplePackage(): Uint8Array {
  const manifest = { schema: 1, id: 'hello_extension', name: 'Hello Extension', version: '1.0.0', type: 'add-on', entry: 'hello.py', tagline: 'Adds an operator that greets you in the status bar', maintainer: 'Example', tags: ['Example'] };
  const source = [
    'import bpy',
    '',
    'class HELLO_OT_greet(bpy.types.Operator):',
    '    bl_idname = "wm.hello_extension_greet"',
    '    bl_label = "Hello from an Extension"',
    '',
    '    def execute(self, context):',
    '        self.report({"INFO"}, "Hello from an installed extension")',
    '        return {"FINISHED"}',
    '',
    'def register():',
    '    bpy.utils.register_class(HELLO_OT_greet)',
    '',
    'def unregister():',
    '    bpy.utils.unregister_class(HELLO_OT_greet)',
    '',
  ].join('\n');
  return zipSync({ 'hello_extension/extension.json': strToU8(JSON.stringify(manifest, null, 2)), 'hello_extension/hello.py': strToU8(source) });
}

async function installFromPicker(enable: boolean) {
  const f = await pickFile('.zip,application/zip');
  if (!f) return;
  try {
    const id = await installPackage(new Uint8Array(await f.arrayBuffer()), { enable, filename: f.name });
    report('INFO', `Installed extension "${extensions.get(id)?.manifest.name ?? id}"`);
  } catch (e) {
    report('ERROR', `Could not install ${f.name}: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// UI

function row(r: ExtensionRecord, redraw: () => void): Child {
  const m = r.manifest;
  const open = ui.expanded.has(m.id);
  const on = extensionEnabled(r);
  const intact = extensionIntact(r);
  const addon = m.type === 'add-on' ? addons.get(m.id) : undefined;
  return h(
    'div',
    { key: m.id, class: { 'ext-item': true, open, off: !on, marked: !!r.marked } },
    h(
      'div',
      { class: 'ext-row' },
      h('button', { class: 'km-expand', 'aria-label': open ? 'Collapse' : 'Expand', 'aria-expanded': open ? 'true' : 'false', onclick: () => (open ? ui.expanded.delete(m.id) : ui.expanded.add(m.id), redraw()) }, icon(open ? 'disclosure_tri_down' : 'disclosure_tri_right')),
      h('span', { class: 'ext-icon' }, icon(m.type === 'theme' ? 'ext_theme' : 'ext_addon')),
      h('div', { class: 'ext-text' }, h('span', { class: 'ext-name' }, m.name), h('span', { class: 'ext-tagline' }, m.tagline || (m.type === 'theme' ? 'Theme' : 'Add-on'))),
      addon?.error ? h('span', { class: 'ad-err', 'data-tip': addon.error }, icon('error')) : null,
      h('span', { class: 'ext-version' }, m.version),
      m.type === 'theme'
        ? h('button', { class: { btn: true, 'ext-toggle': true, on }, 'data-tip': on ? 'Disable\nGo back to the default theme' : 'Enable\nUse this theme', onclick: () => void app.run(on ? 'extensions.package_theme_disable' : 'extensions.package_theme_enable', { pkg_id: m.id }) }, on ? 'Disable' : 'Enable')
        : checkbox(`ext-on-${m.id}`, '', on, (v) => void setExtensionEnabled(m.id, v).then(redraw), { tip: 'Enable\nRegister the add-on now and whenever the application starts' }),
    ),
    open
      ? h(
          'div',
          { class: 'ext-details' },
          ...[
            ['Type', m.type === 'theme' ? 'Theme' : 'Add-on'],
            ['Version', m.version],
            ['Maintainer', m.maintainer],
            ['Website', m.website],
            ['Tags', m.tags.join(', ')],
            ['Files', Object.keys(r.files).join(', ')],
            ['Installed', new Date(r.installed).toLocaleString()],
          ]
            .filter(([, v]) => v)
            .map(([k, v]) => h('div', { class: 'prefs-info-row' }, h('span', { class: 'pi-label' }, k), h('span', { class: 'pi-value' }, v))),
          !intact ? h('div', { class: 'prefs-note err' }, m.type === 'theme' ? 'The theme was removed from the saved themes; enabling it restores it.' : 'The add-on was removed in Add-ons; enabling it installs it again.') : null,
          h(
            'div',
            { class: 'prefs-btn-row left' },
            m.type === 'add-on' ? h('button', { class: 'btn', disabled: !intact, onclick: () => app.run('extensions.package_show_settings', { pkg_id: m.id }) }, icon('preferences'), 'Settings') : null,
            h('button', { class: 'btn', onclick: () => app.run('extensions.package_uninstall', { pkg_id: m.id }) }, icon('remove'), 'Uninstall'),
            checkbox(`ext-mark-${m.id}`, 'Mark', !!r.marked, () => app.run(r.marked ? 'extensions.package_mark_clear' : 'extensions.package_mark_set', { pkg_id: m.id }), { tip: 'Mark\nMark the extension for Uninstall Marked' }),
          ),
        )
      : null,
  );
}

function body(redraw: () => void): Child {
  const list = [...extensions.values()];
  const shown = filterExtensions(list, { text: ui.search, type: ui.type, tags: ui.tags });
  const tags = allTags(list);
  const marked = list.filter((r) => r.marked).length;
  return [
    h(
      'div',
      { class: 'km-toolbar ext-toolbar' },
      h('label', { class: 'text-field km-search' }, icon('search'), h('input', { value: ui.search, placeholder: 'Search Extensions', spellcheck: 'false', 'aria-label': 'Search extensions', oninput: (e: Event) => ((ui.search = (e.target as HTMLInputElement).value), redraw()) })),
      enumMenu(
        'ext-type',
        [
          { value: 'ALL', label: 'All' },
          { value: 'add-on', label: 'Add-ons' },
          { value: 'theme', label: 'Themes' },
        ],
        ui.type,
        (v) => ((ui.type = v as typeof ui.type), redraw()),
        { tip: 'Type\nShow add-ons, themes or both' },
      ),
      h(
        'button',
        {
          class: { btn: true, 'icon-btn': true, on: ui.tags.length > 0 },
          'data-tip': 'Tags\nShow only extensions with these tags',
          'aria-label': 'Filter by tags',
          disabled: !tags.length,
          onclick: (e: MouseEvent) =>
            void import('../ui/menu').then(({ openMenu }) =>
              openMenu(
                tags.map((t) => ({ label: t, checked: ui.tags.includes(t), keepOpen: true, action: () => app.run('extensions.userpref_tags_set', { value: !ui.tags.includes(t), data_path: t }) })),
                e.currentTarget as HTMLElement,
                { title: 'Tags' },
              ),
            ),
        },
        icon('filter'),
      ),
      h('button', { class: 'btn', 'data-tip': 'Install from Disk\nInstall an extension package (.zip with an extension.json manifest)', onclick: () => app.run('extensions.package_install_files') }, icon('import'), 'Install from Disk…'),
    ),
    status.length
      ? h(
          'div',
          { class: 'ext-status' },
          status.map((s, i) => h('div', { key: `st${i}`, class: { 'prefs-note': true, err: s.type === 'ERROR' } }, s.text)),
          h('button', { class: 'btn', onclick: () => app.run('extensions.status_clear') }, 'Clear Status'),
        )
      : null,
    panel(
      'pf-ext-installed',
      'Installed',
      () => [
        !loaded ? h('div', { class: 'prefs-note' }, 'Loading installed extensions…') : null,
        shown.length ? h('div', { class: 'ext-list' }, shown.map((r) => row(r, redraw))) : h('div', { class: 'prefs-note' }, list.length ? 'No extension matches.' : 'No extensions installed. Install a package from disk to add one.'),
        marked ? h('div', { class: 'prefs-btn-row left' }, h('button', { class: 'btn', onclick: () => app.run('extensions.package_uninstall_marked') }, icon('remove'), `Uninstall Marked (${marked})`), h('button', { class: 'btn', onclick: () => app.run('extensions.package_mark_clear_all') }, 'Clear Marks')) : null,
      ],
    ),
    panel(
      'pf-ext-offline',
      'Package Format',
      () => [
        h('div', { class: 'prefs-note' }, 'Extensions are installed from package files on your computer; no online repository is used. A package is a .zip with an extension.json manifest (schema, id, name, version, type "add-on" or "theme", entry) next to the files it names.'),
        h('div', { class: 'prefs-btn-row left' }, h('button', { class: 'btn', 'data-tip': 'Example Package\nDownload a small add-on package to see the format', onclick: () => download(examplePackage(), 'hello_extension.zip', 'application/zip') }, icon('export'), 'Download Example Package')),
      ],
      { closed: true },
    ),
  ];
}

registerPrefSection({ id: 'EXTENSIONS', label: 'Get Extensions', group: 0.5, draw: (c) => body(c.redraw) });

// ---------------------------------------------------------------------------
// operators

const pkgProp = { id: 'pkg_id', label: 'Package ID', type: 'string' as const, default: '' };
const has = (p: Record<string, unknown>) => extensions.has(String(p.pkg_id));

registerOperators([
  {
    idname: 'extensions.package_install_files',
    label: 'Install from Disk',
    description: 'Install an extension package (.zip) from a file on this computer',
    undo: false,
    props: [{ id: 'enable_on_install', label: 'Enable on Install', type: 'bool', default: true }],
    exec: (_c, p) => void installFromPicker(p.enable_on_install !== false),
  },
  {
    idname: 'extensions.package_uninstall',
    label: 'Uninstall Extension',
    description: 'Remove an installed extension and what it installed',
    undo: false,
    props: [pkgProp],
    poll: () => extensions.size > 0,
    exec: (_c, p) => {
      if (!has(p)) return 'CANCELLED';
      const name = extensions.get(String(p.pkg_id))!.manifest.name;
      void uninstallExtension(String(p.pkg_id)).then(() => report('INFO', `Uninstalled "${name}"`));
    },
  },
  {
    idname: 'extensions.package_disable',
    label: 'Disable Extension',
    description: 'Turn an installed extension off',
    undo: false,
    props: [pkgProp],
    exec: (_c, p) => (has(p) ? void setExtensionEnabled(String(p.pkg_id), false) : 'CANCELLED'),
  },
  {
    idname: 'extensions.package_theme_enable',
    label: 'Enable Theme Extension',
    description: 'Use the theme of an installed theme extension',
    undo: false,
    props: [pkgProp],
    exec: (_c, p) => (has(p) ? void setExtensionEnabled(String(p.pkg_id), true) : 'CANCELLED'),
  },
  {
    idname: 'extensions.package_theme_disable',
    label: 'Disable Theme Extension',
    description: 'Go back to the default theme',
    undo: false,
    props: [pkgProp],
    exec: (_c, p) => (has(p) ? void setExtensionEnabled(String(p.pkg_id), false) : 'CANCELLED'),
  },
  {
    idname: 'extensions.package_show_settings',
    label: 'Show Settings',
    description: "Show the extension's add-on in Preferences ▸ Add-ons",
    undo: false,
    props: [pkgProp],
    exec: (_c, p) => {
      if (!has(p)) return 'CANCELLED';
      app.run('preferences.addon_show', { module: String(p.pkg_id) });
    },
  },
  {
    idname: 'extensions.package_mark_set',
    label: 'Mark Package',
    description: 'Mark an extension for a batch uninstall',
    undo: false,
    props: [pkgProp],
    exec: (_c, p) => {
      if (!has(p)) return 'CANCELLED';
      extensions.get(String(p.pkg_id))!.marked = true;
      app.changed('ui');
    },
  },
  {
    idname: 'extensions.package_mark_clear',
    label: 'Clear Marked Package',
    description: 'Unmark an extension',
    undo: false,
    props: [pkgProp],
    exec: (_c, p) => {
      if (!has(p)) return 'CANCELLED';
      extensions.get(String(p.pkg_id))!.marked = false;
      app.changed('ui');
    },
  },
  {
    idname: 'extensions.package_mark_set_all',
    label: 'Mark All Packages',
    description: 'Mark every extension shown',
    undo: false,
    exec: () => {
      for (const r of filterExtensions([...extensions.values()], { text: ui.search, type: ui.type, tags: ui.tags })) r.marked = true;
      app.changed('ui');
    },
  },
  {
    idname: 'extensions.package_mark_clear_all',
    label: 'Clear All Marked Packages',
    description: 'Unmark every extension',
    undo: false,
    exec: () => {
      for (const r of extensions.values()) r.marked = false;
      app.changed('ui');
    },
  },
  {
    idname: 'extensions.package_uninstall_marked',
    label: 'Uninstall Marked',
    description: 'Uninstall every marked extension',
    undo: false,
    poll: () => [...extensions.values()].some((r) => r.marked),
    exec: () => {
      const ids = [...extensions.values()].filter((r) => r.marked).map((r) => r.manifest.id);
      void (async () => {
        for (const id of ids) await uninstallExtension(id);
        report('INFO', `Uninstalled ${ids.length} extension${ids.length === 1 ? '' : 's'}`);
      })();
    },
  },
  {
    idname: 'extensions.status_clear',
    label: 'Clear Status',
    description: 'Clear the install and uninstall messages',
    undo: false,
    exec: () => {
      status.length = 0;
      app.changed('ui');
    },
  },
  {
    idname: 'extensions.userpref_tags_set',
    label: 'Set Extension Tags',
    description: 'Show or hide extensions with a tag (an empty tag clears the tag filter)',
    undo: false,
    props: [
      { id: 'value', label: 'Value', type: 'bool', default: true },
      { id: 'data_path', label: 'Tag', type: 'string', default: '' },
    ],
    exec: (_c, p) => {
      const t = String(p.data_path);
      ui.tags = ui.tags.filter((x) => x !== t);
      if (!t) ui.tags = [];
      else if (p.value) ui.tags.push(t);
      app.changed('ui');
    },
  },
  {
    idname: 'extensions.repo_refresh_all',
    label: 'Refresh Local',
    description: 'Read the installed extensions again',
    undo: false,
    exec: () => {
      extensions.clear();
      loaded = false;
      void loadInstalled();
    },
  },
]);

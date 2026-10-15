// Preferences ▸ Add-ons: script files (Python or JavaScript) that extend the application by
// registering operators and panels. Installed files live in IndexedDB; enabled add-ons
// register at startup. Disabling calls the add-on's unregister() and removes anything it
// registered.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, onAppReady, registerOperators } from '../app/app';
import { checkbox } from '../ui/widgets';
import { pickFile } from '../io/native';
import { newText } from '../data/defaults';
import { jsGlobals, inScript, output } from '../scripting/runner';
import { loadPython, runPythonText } from '../scripting/python';
import { scriptOperators, scriptPanels, unregisterScriptOperator, unregisterScriptPanel } from '../scripting/registry';
import { registerPrefSection } from './editor';
import { assetGet, assetPut, assetDelete, assetKeys } from './assetstore';
import { addonId, addonLang, parseAddonInfo, type AddonRecord, type AddonInfo } from './addons_core';
import { EXAMPLE_ADDON } from './addon_example';

const ENABLED_KEY = 'p3d.addons.enabled.v1';

interface Addon extends AddonRecord {
  info: AddonInfo;
  enabled: boolean;
  /** operator / panel ids it registered */
  owned: string[];
  error?: string;
  /** JavaScript module functions */
  js?: { register?: () => void; unregister?: () => void };
}

export const addons = new Map<string, Addon>();
let ready = false;

function enabledIds(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ENABLED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function saveEnabled() {
  try {
    localStorage.setItem(ENABLED_KEY, JSON.stringify([...addons.values()].filter((a) => a.enabled).map((a) => a.id)));
  } catch {
    // storage unavailable
  }
}

const registeredIds = () => new Set([...scriptOperators.keys(), ...scriptPanels.keys()]);

function cleanup(a: Addon) {
  for (const id of a.owned) if (!unregisterScriptOperator(id)) unregisterScriptPanel(id);
  a.owned = [];
}

function pyString(s: string) {
  return JSON.stringify(s);
}

async function enableAddon(a: Addon): Promise<boolean> {
  if (a.enabled && !a.error) return true;
  a.error = undefined;
  const before = registeredIds();
  try {
    if (a.lang === 'javascript') {
      const g = jsGlobals();
      const fn = new Function(...Object.keys(g), `"use strict";\n${a.source}\nreturn { register: typeof register === 'function' ? register : undefined, unregister: typeof unregister === 'function' ? unregister : undefined };\n//# sourceURL=addon_${a.id}.js`) as (...x: unknown[]) => Addon['js'];
      inScript(`Enable ${a.info.name}`, () => {
        a.js = fn(...Object.values(g));
        a.js?.register?.();
      });
    } else {
      await loadPython();
      const code = `import builtins as __b\n__ns = {'__name__': ${pyString(a.id)}, '__file__': ${pyString(a.filename)}}\nexec(compile(${pyString(a.source)}, ${pyString(a.filename)}, 'exec'), __ns)\nif not hasattr(__b, '_p3d_addons'):\n    __b._p3d_addons = {}\n__b._p3d_addons[${pyString(a.id)}] = __ns\nif callable(__ns.get('register')):\n    __ns['register']()\n`;
      const r = runPythonText(code, `addon:${a.filename}`, `Enable ${a.info.name}`);
      if (!r.ok) throw new Error(r.error ?? 'error');
    }
  } catch (e) {
    a.error = (e as Error)?.message ?? String(e);
    a.owned = [...registeredIds()].filter((id) => !before.has(id));
    cleanup(a);
    a.enabled = false;
    output.push(`Add-on "${a.info.name}" failed to enable: ${a.error}`, 'ERROR');
    app.report('ERROR', `Add-on "${a.info.name}": ${a.error}`);
    return false;
  }
  a.owned = [...registeredIds()].filter((id) => !before.has(id));
  a.enabled = true;
  return true;
}

function disableAddon(a: Addon) {
  try {
    if (a.lang === 'javascript') inScript(`Disable ${a.info.name}`, () => a.js?.unregister?.());
    else runPythonText(`import builtins as __b\n__ns = getattr(__b, '_p3d_addons', {}).pop(${pyString(a.id)}, None)\nif __ns and callable(__ns.get('unregister')):\n    __ns['unregister']()\n`, `addon:${a.filename}`, `Disable ${a.info.name}`);
  } catch (e) {
    output.push(`Add-on "${a.info.name}" unregister failed: ${(e as Error).message}`, 'ERROR');
  }
  // whatever the add-on left registered goes too
  cleanup(a);
  a.js = undefined;
  a.enabled = false;
  a.error = undefined;
}

export async function setAddonEnabled(id: string, on: boolean) {
  const a = addons.get(id);
  if (!a) return false;
  const ok = on ? await enableAddon(a) : (disableAddon(a), true);
  saveEnabled();
  app.changed('ui');
  return ok;
}

/** Install (or replace) an add-on from file text; returns its id. */
export async function installAddon(filename: string, source: string, enable = true): Promise<string> {
  const id = addonId(filename);
  const old = addons.get(id);
  if (old?.enabled) disableAddon(old);
  const rec: AddonRecord = { id, filename, lang: addonLang(filename, source), source, installed: Date.now() };
  await assetPut(`addon:${id}`, rec);
  const a: Addon = { ...rec, info: parseAddonInfo(source, filename), enabled: false, owned: [] };
  addons.set(id, a);
  if (enable) await enableAddon(a);
  saveEnabled();
  app.changed('ui');
  return id;
}

export async function removeAddon(id: string) {
  const a = addons.get(id);
  if (!a) return;
  if (a.enabled) disableAddon(a);
  addons.delete(id);
  await assetDelete(`addon:${id}`);
  saveEnabled();
  app.changed('ui');
}

async function loadInstalled() {
  const keys = ((await assetKeys()) ?? []).map(String).filter((k) => k.startsWith('addon:'));
  const on = new Set(enabledIds());
  for (const k of keys) {
    const r = await assetGet<AddonRecord>(k);
    if (!r || typeof r.source !== 'string') continue;
    addons.set(r.id, { ...r, info: parseAddonInfo(r.source, r.filename), enabled: false, owned: [] });
  }
  ready = true;
  for (const a of addons.values()) if (on.has(a.id)) await enableAddon(a);
  saveEnabled();
  app.changed('ui');
}

onAppReady(() => void loadInstalled());

/** Open the add-on's source in the Text Editor (as a new text). */
function viewSource(a: Addon) {
  const t = newText(a.filename, a.source, a.lang);
  app.doc.texts[t.id] = t;
  app.pushUndo('Add-on Source');
  app.report('INFO', `"${a.filename}" opened as a text (see the Text Editor)`);
  app.changed('doc', 'ui');
}

// ---------------------------------------------------------------------------
// UI

let filter = '';
let enabledOnly = false;
const expanded = new Set<string>();

function addonRow(a: Addon, redraw: () => void): Child {
  const open = expanded.has(a.id);
  return h(
    'div',
    { key: a.id, class: { 'ad-item': true, open, error: !!a.error } },
    h(
      'div',
      { class: 'ad-row' },
      h('button', { class: 'km-expand', 'aria-label': open ? 'Collapse' : 'Expand', onclick: () => (open ? expanded.delete(a.id) : expanded.add(a.id), redraw()) }, icon(open ? 'disclosure_tri_down' : 'disclosure_tri_right')),
      checkbox(`ad-on-${a.id}`, '', a.enabled, (v) => void setAddonEnabled(a.id, v).then(redraw), { tip: 'Enable\nRegister the add-on now and whenever the application starts' }),
      h('span', { class: 'ad-name' }, `${a.info.category}: ${a.info.name}`),
      h('span', { class: `ad-lang ${a.lang}` }, a.lang === 'python' ? 'Python' : 'JavaScript'),
      a.error ? h('span', { class: 'ad-err', 'data-tip': a.error }, icon('error')) : null,
    ),
    open
      ? h(
          'div',
          { class: 'ad-details' },
          a.info.description ? h('div', { class: 'prefs-info-row' }, h('span', { class: 'pi-label' }, 'Description'), h('span', { class: 'pi-value' }, a.info.description)) : null,
          a.info.author ? h('div', { class: 'prefs-info-row' }, h('span', { class: 'pi-label' }, 'Author'), h('span', { class: 'pi-value' }, a.info.author)) : null,
          a.info.version ? h('div', { class: 'prefs-info-row' }, h('span', { class: 'pi-label' }, 'Version'), h('span', { class: 'pi-value' }, a.info.version)) : null,
          h('div', { class: 'prefs-info-row' }, h('span', { class: 'pi-label' }, 'File'), h('span', { class: 'pi-value' }, a.filename)),
          a.enabled ? h('div', { class: 'prefs-info-row' }, h('span', { class: 'pi-label' }, 'Registers'), h('span', { class: 'pi-value' }, a.owned.join(', ') || 'nothing')) : null,
          a.error ? h('div', { class: 'prefs-note err' }, a.error) : null,
          h(
            'div',
            { class: 'prefs-btn-row left' },
            h('button', { class: 'btn', onclick: () => viewSource(a) }, icon('file_script'), 'View Source'),
            h('button', { class: 'btn', onclick: () => void removeAddon(a.id).then(redraw) }, icon('remove'), 'Remove'),
          ),
        )
      : null,
  );
}

function addonsBody(redraw: () => void): Child {
  const q = filter.trim().toLowerCase();
  const list = [...addons.values()]
    .filter((a) => (!enabledOnly || a.enabled) && (!q || `${a.info.name} ${a.info.category} ${a.info.description} ${a.filename}`.toLowerCase().includes(q)))
    .sort((a, b) => a.info.category.localeCompare(b.info.category) || a.info.name.localeCompare(b.info.name));
  return [
    h(
      'div',
      { class: 'km-toolbar' },
      h('button', { class: 'btn', 'data-tip': 'Install\nAdd a Python (.py) or JavaScript (.js) add-on file', onclick: () => app.run('preferences.addon_install') }, icon('import'), 'Install…'),
      h('button', { class: 'btn', 'data-tip': 'Example\nInstall a small example add-on that adds an operator and a sidebar panel', onclick: () => void installAddon(EXAMPLE_ADDON.filename, EXAMPLE_ADDON.source).then(redraw) }, 'Install Example'),
      h('label', { class: 'text-field km-search' }, icon('search'), h('input', { value: filter, placeholder: 'Search add-ons', spellcheck: 'false', 'aria-label': 'Search add-ons', oninput: (e: Event) => ((filter = (e.target as HTMLInputElement).value), redraw()) })),
      checkbox('ad-enabled-only', 'Enabled Only', enabledOnly, (v) => ((enabledOnly = v), redraw())),
    ),
    !ready ? h('div', { class: 'prefs-note' }, 'Loading installed add-ons…') : null,
    list.length ? h('div', { class: 'ad-list' }, list.map((a) => addonRow(a, redraw))) : h('div', { class: 'prefs-note' }, addons.size ? 'No add-on matches.' : 'No add-ons installed. An add-on is a script with register() and unregister() functions that registers operators and panels (see the Text Editor templates).'),
  ];
}

registerPrefSection({ id: 'ADDONS', label: 'Add-ons', group: 1, draw: (c) => addonsBody(c.redraw) });

registerOperators([
  {
    idname: 'preferences.addon_install',
    label: 'Install Add-on…',
    description: 'Install a Python or JavaScript add-on file and enable it',
    undo: false,
    exec: () => {
      void pickFile('.py,.js,.mjs,text/x-python,text/javascript').then(async (f) => {
        if (!f) return;
        const id = await installAddon(f.name, await f.text());
        const a = addons.get(id);
        if (a?.enabled) app.report('INFO', `Add-on "${a.info.name}" installed and enabled`);
      });
    },
  },
  {
    idname: 'preferences.addon_enable',
    label: 'Enable Add-on',
    description: 'Turn an installed add-on on',
    undo: false,
    props: [{ id: 'module', label: 'Module', type: 'string', default: '' }],
    exec: (_c, p) => void setAddonEnabled(String(p.module), true),
  },
  {
    idname: 'preferences.addon_disable',
    label: 'Disable Add-on',
    description: 'Turn an installed add-on off',
    undo: false,
    props: [{ id: 'module', label: 'Module', type: 'string', default: '' }],
    exec: (_c, p) => void setAddonEnabled(String(p.module), false),
  },
  {
    idname: 'preferences.addon_remove',
    label: 'Remove Add-on',
    description: 'Disable and delete an installed add-on',
    undo: false,
    props: [{ id: 'module', label: 'Module', type: 'string', default: '' }],
    exec: (_c, p) => void removeAddon(String(p.module)),
  },
]);

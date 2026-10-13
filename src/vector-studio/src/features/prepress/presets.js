/**
 * Named presets for transparency flattening, printing and PDF export, and
 * the dialog that manages them (Edit > ... Presets): a list of the
 * built-in presets and the user's own, a summary of the selected preset,
 * and New, Edit, Delete, Import and Export.
 *
 * User presets live in the preferences as { name: values } under the
 * kind's key. Built-in presets cannot be changed or deleted; New starts
 * from the selected preset.
 *
 * A kind is registered with registerPresetKind(id, {
 *   title       dialog title ("Print Presets")
 *   noun        one preset ("Print Preset")
 *   key         preference key
 *   builtins    { name: values }
 *   normalize   (values) -> clean values
 *   summary     (values) -> [[label, value], ...]
 *   edit        (app, { name, values, title, names }) -> Promise<{ name, values } | null>
 * }).
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../ui/icons.js';

export const PRESET_KINDS = {};

export function registerPresetKind(id, def) {
  PRESET_KINDS[id] = { id, ...def };
}

const FILE_FORMAT = 'vector-studio-presets';

function kindOf(id) {
  const k = PRESET_KINDS[id];
  if (!k) throw new Error(`Unknown preset kind ${id}`);
  return k;
}

/** User presets of a kind: { name: values }. */
export function userPresets(app, kind) {
  const v = app.prefs?.get(kindOf(kind).key);
  return v && typeof v === 'object' ? v : {};
}

/** Every preset of a kind: [{ name, values, builtin }], built-ins first. */
export function listPresets(app, kind) {
  const k = kindOf(kind);
  const out = Object.entries(k.builtins || {}).map(([name, values]) => ({ name, values: k.normalize(values), builtin: true }));
  for (const [name, values] of Object.entries(userPresets(app, kind)).sort(([a], [b]) => a.localeCompare(b))) {
    if (k.builtins?.[name]) continue;
    out.push({ name, values: k.normalize(values), builtin: false });
  }
  return out;
}

export function getPreset(app, kind, name) {
  return listPresets(app, kind).find((p) => p.name === name) || null;
}

export function savePreset(app, kind, name, values) {
  const k = kindOf(kind);
  if (k.builtins?.[name]) throw new Error(`"${name}" is a built-in preset.`);
  app.prefs.set(k.key, { ...userPresets(app, kind), [name]: k.normalize(values) });
}

export function deletePreset(app, kind, name) {
  const all = { ...userPresets(app, kind) };
  delete all[name];
  app.prefs.set(kindOf(kind).key, all);
}

/** A name not used yet: "Base", "Base 2", ... (or "Base 1", "Base 2", ... when numbered). */
export function uniqueName(names, base, numbered = false) {
  const taken = new Set(names);
  if (!numbered && !taken.has(base)) return base;
  for (let i = numbered ? 1 : 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** Presets file contents for export. */
export function exportPresetsData(kind, presets) {
  return { format: FILE_FORMAT, kind, version: 1, presets };
}

/** Validate a presets file; returns { name: values } (normalized). */
export function parsePresetsData(kind, data) {
  const k = kindOf(kind);
  if (!data || data.format !== FILE_FORMAT || data.kind !== kind || !data.presets || typeof data.presets !== 'object') throw new Error(`This file does not hold ${k.noun.toLowerCase()}s.`);
  const out = {};
  for (const [name, values] of Object.entries(data.presets)) {
    const nm = String(name).trim().slice(0, 100);
    if (nm && values && typeof values === 'object') out[nm] = k.normalize(values);
  }
  return out;
}

/** Edit > [kind] Presets. Changes apply on OK. */
export async function presetsManagerDialog(app, kind) {
  const k = kindOf(kind);
  let user = { ...userPresets(app, kind) };
  let selected = listPresets(app, kind)[0]?.name || null;
  const all = () => [
    ...Object.entries(k.builtins || {}).map(([name, values]) => ({ name, values: k.normalize(values), builtin: true })),
    ...Object.entries(user).filter(([n]) => !k.builtins?.[n]).sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => ({ name, values: k.normalize(values), builtin: false })),
  ];
  const list = h('ul.pp-preset-list', { role: 'listbox', tabindex: '0', 'aria-label': `${k.noun}s` });
  const summary = h('dl.pp-summary', { 'aria-live': 'polite' });
  const btn = (label, iconName, onclick) => h('button.btn.small', { type: 'button', onclick }, iconName ? icon(iconName, 14) : null, label);
  const editBtn = btn('Edit…', 'pencil', () => edit(false));
  const delBtn = btn('Delete', 'trash', () => {
    const p = current();
    if (!p || p.builtin) return;
    delete user[p.name];
    selected = all()[0]?.name || null;
    render();
  });
  const exportBtn = btn('Export…', 'download', async () => {
    const p = current();
    const presets = p && !p.builtin ? { [p.name]: p.values } : Object.fromEntries(Object.entries(user).map(([n, v]) => [n, k.normalize(v)]));
    if (!Object.keys(presets).length) return;
    const blob = new Blob([JSON.stringify(exportPresetsData(kind, presets), null, 2)], { type: 'application/json' });
    const { deliverFiles } = await import('../io/deliver.js');
    const msg = await deliverFiles(app, [{ name: `${p && !p.builtin ? p.name : k.title}.json`, blob }], { dest: 'device' });
    if (msg) app.notify(msg, { polite: true });
  });
  const importBtn = btn('Import…', 'upload', async () => {
    const { pickWithInput } = await import('../files/service.js');
    const [file] = await pickWithInput('.json,application/json');
    if (!file) return;
    try {
      const got = parsePresetsData(kind, JSON.parse(await file.text()));
      const names = all().map((p) => p.name);
      for (const [name, values] of Object.entries(got)) {
        const nm = k.builtins?.[name] || user[name] ? uniqueName([...names, ...Object.keys(user)], name) : name;
        user[nm] = values;
        selected = nm;
      }
      render();
    } catch (err) {
      app.notify(err?.message || 'The presets could not be read.', { error: true });
    }
  });
  const current = () => all().find((p) => p.name === selected) || null;
  async function edit(isNew) {
    const p = current();
    const names = all().map((x) => x.name);
    const base = p?.values || k.normalize({});
    if (!isNew && (!p || p.builtin)) return;
    const res = await k.edit(app, {
      name: isNew ? uniqueName([...names, ...Object.keys(user)], k.noun, true) : p.name,
      values: base,
      title: `${k.noun} Options${isNew ? ' (New)' : ''}`,
      names: names.filter((n) => isNew || n !== p.name),
    });
    if (!res) return;
    const name = String(res.name || '').trim() || uniqueName(names, k.noun);
    if (k.builtins?.[name]) {
      app.notify(`"${name}" is a built-in preset. Choose another name.`, { error: true });
      return;
    }
    if (!isNew && p.name !== name) delete user[p.name];
    user[name] = k.normalize(res.values);
    selected = name;
    render();
  }
  const newBtn = btn('New…', 'plus', () => edit(true));
  function render() {
    const items = all();
    list.replaceChildren(
      ...items.map((p) => {
        const li = h('li.pp-preset', { role: 'option', id: `pp-preset-${items.indexOf(p)}`, 'aria-selected': String(p.name === selected), onclick: () => ((selected = p.name), render()), ondblclick: () => !p.builtin && edit(false) }, h('span', p.name), p.builtin ? h('span.pp-badge', 'Built-in') : null);
        return li;
      }),
    );
    const sel = items.find((p) => p.name === selected);
    if (sel) list.setAttribute('aria-activedescendant', `pp-preset-${items.indexOf(sel)}`);
    editBtn.disabled = !sel || sel.builtin;
    delBtn.disabled = !sel || sel.builtin;
    exportBtn.disabled = !Object.keys(user).length;
    summary.replaceChildren(...(sel ? k.summary(sel.values).flatMap(([label, value]) => [h('dt', label), h('dd', String(value))]) : []));
  }
  list.addEventListener('keydown', (e) => {
    const items = all();
    const i = items.findIndex((p) => p.name === selected);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const j = Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      selected = items[j]?.name ?? selected;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      edit(false);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      delBtn.click();
    }
  });
  render();
  const ok = await app.dialogs.open({
    title: k.title,
    className: 'pp-dialog pp-presets',
    body: h('div.pp-manager', h('div.pp-label', 'Presets'), list, h('div.pp-preset-buttons', newBtn, editBtn, delBtn, h('span.pp-spacer'), importBtn, exportBtn), h('div.pp-label', 'Preset Settings'), summary),
    initialFocus: () => list,
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: true }],
  });
  if (!ok) return false;
  app.prefs.set(k.key, Object.fromEntries(Object.entries(user).map(([n, v]) => [n, k.normalize(v)])));
  return true;
}

/**
 * A preset picker for dialogs that use presets: a select of every preset
 * plus "Custom" (shown while the values match no preset). onPick(values)
 * runs when a preset is chosen; call sync(values) after edits.
 */
export function presetPicker(app, kind, { values, onPick, label = 'Preset' }) {
  const k = kindOf(kind);
  const sel = h('select.pp-preset-select', { 'aria-label': label });
  const same = (a, b) => JSON.stringify(k.normalize(a)) === JSON.stringify(k.normalize(b));
  const fill = (vals) => {
    const presets = listPresets(app, kind);
    const match = presets.find((p) => same(p.values, vals));
    sel.replaceChildren(...presets.map((p) => h('option', { value: p.name, selected: match?.name === p.name }, p.name)), h('option', { value: '', selected: !match }, 'Custom'));
  };
  sel.addEventListener('change', () => {
    const p = getPreset(app, kind, sel.value);
    if (p) onPick(p.values, p.name);
  });
  fill(values);
  return { el: sel, sync: fill, get name() {
    return sel.value;
  } };
}

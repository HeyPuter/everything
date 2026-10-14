// Preset browsing shared by the effect editors, the mixer's slot menu and the
// instrument editors: built-in presets plus the user's own ("My presets",
// src/storage/user-presets.js), matching the current parameters to a preset
// name ("Custom" once edited), previous/next stepping, and the save, rename
// and delete actions with their dialogs.
//
//   const pc = presetController({ app, kind: 'effect:eq', builtins, defaults,
//     params: () => slot.params, apply: (entry) => ... })
//   pc.current()      // entry or null
//   pc.menuItems()    // items for openMenu / a submenu
//   pc.step(1); pc.saveAs()
//
// An entry is { name, params (full set), category, user (the stored preset or null) }.

import { h, announce } from '../lib/dom.js';
import { confirmDialog, promptDialog } from './dialog.js';
import { openMenu } from './menu.js';
import { icon } from './icons.js';
import { userPresets, MAX_NAME } from '../storage/user-presets.js';
import '../styles/presets.css';

const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** Whether parameter set `params` equals `full` (missing keys read as `defaults`). */
export function paramsEqual(full, params, defaults = {}) {
  for (const k of Object.keys(defaults)) {
    if (!near(Number(params?.[k] ?? defaults[k]), Number(full[k] ?? defaults[k]))) return false;
  }
  for (const k of Object.keys(full)) {
    if (k in defaults) continue;
    if (!near(Number(params?.[k]), Number(full[k]))) return false;
  }
  return true;
}

/**
 * `builtins`: [{ name, params (partial), category? }]. `defaults`: the full
 * default parameter set. `params()`: the current values. `apply(entry)` loads
 * an entry (one undo step). `noun`: how menus and dialogs name the thing.
 */
export function presetController({ app, kind, builtins, defaults, params, apply, noun = 'preset', builtinHeading = 'Built-in' }) {
  const store = userPresets(app);
  let picked = null; // the entry last loaded or saved, preferred when several match

  const builtinEntries = () => builtins.map((b) => ({ name: b.name, category: b.category || builtinHeading, params: { ...defaults, ...b.params }, user: null }));
  const userEntries = () => store.list(kind).map((u) => ({ name: u.name, category: 'My presets', params: { ...defaults, ...u.params }, user: u }));
  const entries = () => [...builtinEntries(), ...userEntries()];

  const same = (a, b) => a && b && a.name === b.name && (a.user?.id ?? null) === (b.user?.id ?? null);

  function current() {
    const now = params() || {};
    const list = entries();
    if (picked) {
      const again = list.find((e) => same(e, picked));
      if (again && paramsEqual(again.params, now, defaults)) return again;
    }
    return list.find((e) => paramsEqual(e.params, now, defaults)) || null;
  }

  function load(entry) {
    if (!entry) return;
    picked = entry;
    apply(entry);
    announce(`Preset ${entry.name}`);
  }

  function step(d) {
    const list = entries();
    if (!list.length) return;
    const cur = current();
    const i = cur ? list.findIndex((e) => same(e, cur)) : d > 0 ? -1 : 0;
    load(list[(i + d + list.length) % list.length]);
  }

  async function saveAs() {
    const cur = current();
    const suggested = cur?.user ? cur.name : '';
    const name = await promptDialog({
      title: `Save ${noun}`,
      label: 'Preset name',
      value: suggested,
      confirm: 'Save',
      validate: (v) => (!v.trim() ? 'Enter a name.' : v.trim().length > MAX_NAME ? `Use at most ${MAX_NAME} characters.` : ''),
    });
    if (name == null) return null;
    const clash = store.findByName(kind, name);
    if (clash && !(cur?.user && clash.id === cur.user.id)) {
      const ok = await confirmDialog({ title: 'Replace preset', message: `You already have a preset called "${clash.name}". Replace it?`, confirm: 'Replace', danger: true });
      if (!ok) return null;
    }
    const saved = store.save(kind, name, params());
    if (!saved) return null;
    picked = { name: saved.name, user: saved };
    app.notify?.(`Saved preset ${saved.name}`);
    return saved;
  }

  async function rename(preset) {
    if (!preset) return null;
    const name = await promptDialog({
      title: 'Rename preset',
      label: 'Preset name',
      value: preset.name,
      confirm: 'Rename',
      validate: (v) => {
        if (!v.trim()) return 'Enter a name.';
        const other = store.findByName(kind, v);
        return other && other.id !== preset.id ? 'Another preset already has this name.' : '';
      },
    });
    if (name == null) return null;
    const next = store.rename(preset.id, name);
    if (next && picked?.user?.id === preset.id) picked = { name: next.name, user: next };
    if (next) announce(`Renamed preset to ${next.name}`);
    return next;
  }

  async function remove(preset) {
    if (!preset) return false;
    const ok = await confirmDialog({ title: 'Delete preset', message: `Delete your preset "${preset.name}"? This cannot be undone.`, confirm: 'Delete', danger: true });
    if (!ok) return false;
    store.remove(preset.id);
    if (picked?.user?.id === preset.id) picked = null;
    app.notify?.(`Deleted preset ${preset.name}`);
    return true;
  }

  /** Menu items: built-ins (grouped), "My presets", then the save, rename and delete actions. */
  function menuItems() {
    const cur = current();
    const items = [];
    let cat = null;
    for (const e of builtinEntries()) {
      if (e.category !== cat) {
        cat = e.category;
        items.push({ type: 'heading', label: cat });
      }
      items.push({ type: 'radio', label: e.name, checked: same(e, cur), run: () => load(e) });
    }
    const mine = userEntries();
    items.push({ type: 'heading', label: 'My presets' });
    if (!mine.length) items.push({ type: 'cmd', label: 'No saved presets yet', enabled: false });
    for (const e of mine) items.push({ type: 'radio', label: e.name, checked: same(e, cur), run: () => load(e) });
    items.push({ type: 'sep' });
    items.push({ type: 'cmd', label: 'Save preset...', icon: 'save', run: () => saveAs().catch((err) => app.reportError?.(err)) });
    const pick = (fn) => mine.map((e) => ({ type: 'cmd', label: e.name, run: () => fn(e.user).catch((err) => app.reportError?.(err)) }));
    if (cur?.user) {
      items.push({ type: 'cmd', label: 'Rename preset...', run: () => rename(cur.user).catch((err) => app.reportError?.(err)) });
      items.push({ type: 'cmd', label: 'Delete preset...', run: () => remove(cur.user).catch((err) => app.reportError?.(err)) });
    } else if (mine.length) {
      items.push({ type: 'submenu', label: 'Rename preset', items: pick(rename) });
      items.push({ type: 'submenu', label: 'Delete preset', items: pick(remove) });
    }
    return items;
  }

  return { store, entries, current, load, step, saveAs, rename, remove, menuItems, label: () => current()?.name || 'Custom' };
}

/**
 * A compact preset strip: previous, the current preset name (opens the
 * preset menu), next and save. `sync()` refreshes the name.
 */
export function createPresetBar(pc, { label = 'Preset', className = '' } = {}) {
  const name = h('span.preset-name');
  const btn = h('button.btn.sm.preset-btn', { type: 'button', 'aria-haspopup': 'menu', title: 'Choose a preset' }, name, icon('chevron-down', 12));
  const prev = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Previous preset', title: 'Previous preset' }, icon('chevron-left', 14));
  const next = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Next preset', title: 'Next preset' }, icon('chevron-right', 14));
  const save = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Save preset', title: 'Save the current settings as a preset' }, icon('save', 14));
  const el = h(`div.preset-bar${className ? `.${className}` : ''}`, { role: 'group', 'aria-label': `${label}s` }, prev, btn, next, save);
  btn.addEventListener('click', () => openMenu(pc.menuItems(), { anchor: btn, label: `${label}s` }));
  prev.addEventListener('click', () => pc.step(-1));
  next.addEventListener('click', () => pc.step(1));
  save.addEventListener('click', () => pc.saveAs().catch(() => {}));
  const sync = () => {
    const n = pc.label();
    if (name.textContent !== n) name.textContent = n;
    btn.setAttribute('aria-label', `${label}: ${n}. Choose a preset`);
    btn.classList.toggle('custom', !pc.current());
  };
  const off = pc.store.on('change', sync);
  sync();
  return { el, sync, destroy: off };
}

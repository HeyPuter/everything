// The live key configuration: binds the keyconfig model to the dispatcher's keymaps,
// persists it, migrates the older override format and offers import / export.
import { keymaps, keymapHooks, type KeyItem } from '../app/keymap';
import { KeyconfigState, emptyKeyconfig, normalizeKeyconfig, fieldsOf, diffFields, type KeyconfigData } from './keyconfig_core';
import { KEY_PRESETS } from './keypresets';

const STORAGE = 'p3d.keyconfig.v2';
const OLD_STORAGE = 'p3d.keymap.overrides.v1';
const USER_PRESETS = 'p3d.keyconfig.presets.v1';

export const keyconfig = new KeyconfigState(keymaps, KEY_PRESETS);
let started = false;
const listeners = new Set<() => void>();

/** Called after any change (the Preferences editor redraws, menus pick up new shortcuts). */
export function onKeyconfigChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, v: unknown) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // storage unavailable: changes last for this session
  }
}

/** Whether the key configuration is written to storage on every change. */
export const keyconfigSaving = { auto: true, dirty: false };

/** Persist and notify after an edit. */
export function keyconfigChanged() {
  if (keyconfigSaving.auto) saveKeyconfig();
  else keyconfigSaving.dirty = true;
  for (const fn of listeners) fn();
}

export function saveKeyconfig() {
  const d = keyconfig.data;
  const empty = d.preset === 'DEFAULT' && !Object.keys(d.edits).length && !d.removed.length && !d.added.length && JSON.stringify(d.options) === JSON.stringify(emptyKeyconfig().options);
  write(STORAGE, empty ? null : d);
  write(OLD_STORAGE, null);
  keyconfigSaving.dirty = false;
}

/** Older builds stored only rebinds (key + modifiers + enabled) by keymap position. */
interface OldOverride {
  km: string;
  index: number;
  op: string;
  orig: { key: string; ctrl: boolean; shift: boolean; alt: boolean };
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  active: boolean;
}

function migrate(old: OldOverride[]): KeyconfigData {
  const d = emptyKeyconfig();
  for (const o of old) {
    if (!o || typeof o.km !== 'string') continue;
    const list = keymaps[o.km] ?? [];
    const same = (k: KeyItem) => (k.op ?? '') === o.op && k.key === o.orig?.key && !!k.ctrl === !!o.orig.ctrl && !!k.shift === !!o.orig.shift && !!k.alt === !!o.orig.alt;
    const k = list[o.index] && same(list[o.index]) ? list[o.index] : list.find(same);
    if (!k) continue;
    const id = keyconfig.idOf(k);
    const base = fieldsOf(k);
    const e = diffFields(base, { ...base, key: o.key, ctrl: !!o.ctrl, shift: !!o.shift, alt: !!o.alt, active: o.active !== false });
    if (id && Object.keys(e).length) d.edits[id] = e;
  }
  return d;
}

/** Snapshot the factory keymaps and apply the stored configuration (once all modules registered keys). */
export function startKeyconfig() {
  if (started) return;
  started = true;
  keyconfig.snapshot();
  const stored = read<unknown>(STORAGE);
  let data: KeyconfigData | null = null;
  if (stored) {
    try {
      data = normalizeKeyconfig(stored);
    } catch {
      data = null;
    }
  } else {
    const old = read<OldOverride[]>(OLD_STORAGE);
    if (Array.isArray(old) && old.length) data = migrate(old);
  }
  keyconfig.load(data ?? emptyKeyconfig());
  // modules loaded later (lazily) still get their defaults recorded and user edits applied
  keymapHooks.added = (km, items) => {
    keyconfig.snapshot(km, items);
    keyconfig.apply();
  };
}

/** Back to the stored configuration (Revert to Saved Preferences). */
export function revertKeyconfig() {
  const stored = read<unknown>(STORAGE);
  try {
    keyconfig.load(stored ? normalizeKeyconfig(stored) : emptyKeyconfig());
  } catch {
    keyconfig.load(emptyKeyconfig());
  }
  keyconfigSaving.dirty = false;
  for (const fn of listeners) fn();
}

export function factoryKeyconfig() {
  keyconfig.load(emptyKeyconfig());
  saveKeyconfig();
  for (const fn of listeners) fn();
}

// ---------------------------------------------------------------------------
// presets: built-in ones are bases; user presets are saved configurations

export function userPresets(): Record<string, KeyconfigData> {
  return read<Record<string, KeyconfigData>>(USER_PRESETS) ?? {};
}

export function presetChoices(): { value: string; label: string; description?: string }[] {
  return [...KEY_PRESETS.map((p) => ({ value: p.id, label: p.label, description: p.description })), ...Object.keys(userPresets()).map((n) => ({ value: `user:${n}`, label: n, description: 'Saved key configuration' }))];
}

/** The preset the current configuration came from. */
export function currentPresetChoice(): string {
  return keyconfig.data.name && userPresets()[keyconfig.data.name] ? `user:${keyconfig.data.name}` : keyconfig.data.preset;
}

export function choosePreset(value: string) {
  if (value.startsWith('user:')) {
    const p = userPresets()[value.slice(5)];
    if (!p) return;
    keyconfig.load({ ...p, name: value.slice(5) });
  } else keyconfig.load({ ...emptyKeyconfig(value), options: keyconfig.data.options });
  keyconfigChanged();
}

export function saveUserPreset(name: string) {
  const all = userPresets();
  all[name] = keyconfig.export(name);
  write(USER_PRESETS, all);
  keyconfig.data.name = name;
  keyconfigChanged();
}

export function removeUserPreset(name: string) {
  const all = userPresets();
  delete all[name];
  write(USER_PRESETS, all);
  if (keyconfig.data.name === name) delete keyconfig.data.name;
  keyconfigChanged();
}

/** JSON text of the current configuration. */
export function exportKeyconfigText(name?: string) {
  return JSON.stringify(keyconfig.export(name), null, 2);
}

/** Load a configuration from JSON text; throws with a readable message on bad input. */
export function importKeyconfigText(text: string, name?: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON');
  }
  const d = normalizeKeyconfig(raw);
  if (name && !d.name) d.name = name;
  keyconfig.load(d);
  keyconfigChanged();
  return d;
}

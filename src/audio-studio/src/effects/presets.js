// User presets and remembered settings for effects, stored in preferences
// (localStorage). Built-in presets come from the effect definition; user
// presets are listed after them and can be saved over or deleted. Each effect
// also remembers the values it was last applied with, as dialogs reopen with
// the previous settings.
//
// Rule: a dialog opens with the settings the effect was last applied with,
// else its defaults. The first built-in preset always equals the defaults
// ("Default", or a name such as "Flat" that says what the defaults do), so the
// preset list shows it selected when a dialog opens fresh.
//
// prefs keys:
//   fxPresets: { [effectId]: [{ name, values }] }
//   fxLast:    { [effectId]: values }

import { normalizeValues, valuesEqual } from './params.js';

const PRESETS = 'fxPresets';
const LAST = 'fxLast';

function read(prefs, key) {
  const v = prefs.get(key);
  return v && typeof v === 'object' ? v : {};
}

export function userPresets(prefs, effectId) {
  const list = read(prefs, PRESETS)[effectId];
  return Array.isArray(list) ? list : [];
}

/** Built-in then user presets: [{ name, values, user }]. */
export function allPresets(prefs, def) {
  const builtIn = (def.presets || []).map((p) => ({ ...p, user: false }));
  const names = new Set(builtIn.map((p) => p.name));
  return [...builtIn, ...userPresets(prefs, def.id).filter((p) => !names.has(p.name)).map((p) => ({ ...p, user: true }))];
}

/** Saves (or replaces by name) a user preset. Built-in names are refused. */
export function savePreset(prefs, def, name, values) {
  name = String(name || '').trim();
  if (!name) throw new Error('Enter a preset name.');
  if ((def.presets || []).some((p) => p.name === name)) throw new Error(`"${name}" is a built-in preset. Choose another name.`);
  const all = { ...read(prefs, PRESETS) };
  const list = userPresets(prefs, def.id).filter((p) => p.name !== name);
  list.push({ name, values: normalizeValues(def, values) });
  list.sort((a, b) => a.name.localeCompare(b.name));
  all[def.id] = list;
  prefs.set(PRESETS, all);
  return name;
}

export function deletePreset(prefs, effectId, name) {
  const all = { ...read(prefs, PRESETS) };
  const list = userPresets(prefs, effectId).filter((p) => p.name !== name);
  if (list.length) all[effectId] = list;
  else delete all[effectId];
  prefs.set(PRESETS, all);
}

/** Name of the preset whose values equal `values`, or '' (custom settings). */
export function matchPreset(prefs, def, values) {
  const v = normalizeValues(def, values);
  return allPresets(prefs, def).find((p) => valuesEqual(normalizeValues(def, p.values), v))?.name || '';
}

export function lastValues(prefs, def) {
  const v = read(prefs, LAST)[def.id];
  return normalizeValues(def, v || {});
}

export function rememberValues(prefs, def, values) {
  prefs.set(LAST, { ...read(prefs, LAST), [def.id]: normalizeValues(def, values) });
}

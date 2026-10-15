// Changing, applying, saving and reverting preferences. Every preference with a runtime
// effect is pushed out by an "apply hook" so modules react without polling.
import { app } from '../app/app';
import { prefs, savePrefs, defaultPreferences, readStoredPrefs, type Preferences } from '../app/prefs';
import { keyconfigSaving, saveKeyconfig, revertKeyconfig, factoryKeyconfig } from './keyconfig';

type Hook = (p: Preferences) => void;
const hooks: Hook[] = [];
/** Extra stores (themes, studio lights, add-ons…) saved / reverted with the preferences. */
interface PrefStore {
  save(): void;
  revert(): void;
  factory(): void;
}
const stores: PrefStore[] = [];

/** Run `fn` now and whenever preferences change. */
export function onPrefsApply(fn: Hook) {
  hooks.push(fn);
}

export function registerPrefStore(s: PrefStore) {
  stores.push(s);
}

let dirty = false;
/** Unsaved changes exist (only when Auto-Save Preferences is off). */
export function prefsDirty() {
  return dirty || keyconfigSaving.dirty;
}

/** Apply every preference with a runtime effect. */
export function applyPreferences() {
  keyconfigSaving.auto = prefs.use_preferences_save;
  for (const fn of hooks) {
    try {
      fn(prefs);
    } catch (e) {
      console.error('preference hook failed', e);
    }
  }
}

/** Persist after a change, or remember that there is something to save. */
export function prefsChanged() {
  if (prefs.use_preferences_save) {
    savePrefs();
    dirty = false;
  } else dirty = true;
}

/** Change a preference, apply it and persist it (when Auto-Save Preferences is on). */
export function setPref<K extends keyof Preferences>(key: K, value: Preferences[K]) {
  prefs[key] = value;
  applyPreferences();
  if (key === 'use_preferences_save') {
    if (value) saveAllPrefs(false);
    else savePrefs();
  } else prefsChanged();
  app.changed('ui');
}

export function saveAllPrefs(report = true) {
  savePrefs();
  saveKeyconfig();
  for (const s of stores) s.save();
  dirty = false;
  if (report) app.report('INFO', 'Preferences saved');
  app.changed('ui');
}

export function revertPrefs() {
  const stored = readStoredPrefs() ?? {};
  const d = defaultPreferences();
  Object.assign(prefs, d, stored, { duplicate: { ...d.duplicate, ...(stored.duplicate ?? {}) } });
  revertKeyconfig();
  for (const s of stores) s.revert();
  dirty = false;
  applyPreferences();
  app.changed('ui', 'view');
}

export function factoryPrefs() {
  Object.assign(prefs, defaultPreferences());
  factoryKeyconfig();
  for (const s of stores) s.factory();
  applyPreferences();
  savePrefs();
  dirty = false;
  app.changed('ui', 'view');
}

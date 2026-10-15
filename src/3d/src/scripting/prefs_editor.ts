// The Preferences editor lives in src/prefs/; this module keeps the scripting package's
// entry point (window + operators in wmops.ts) importing from the same place.
export { PreferencesEditor, type Section, applyPreferences, saveAllPrefs as saveUserPrefs, factoryPrefs, revertPrefs, itemLabel, startPreferences } from '../prefs';

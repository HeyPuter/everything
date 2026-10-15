// Preferences: editor + sections, key configuration, themes and the operators behind them.
//   app/prefs.ts        preference values (persisted)
//   store.ts            set / apply / save / revert / factory
//   effects.ts          interface-wide runtime effects
//   editor.ts           the Preferences editor and section registry
//   sections.ts         simple sections built from rows
//   keyconfig*.ts       key configuration model, presets, persistence; keymap_ui.ts its editor
import './prefs.css';
import './effects';
import './sections';
import './theme_ui';
import './ops';
import { startKeyconfig } from './keyconfig';
import { applyPreferences } from './store';

export { PreferencesEditor, type Section } from './editor';
export { applyPreferences, saveAllPrefs, revertPrefs, factoryPrefs, setPref } from './store';
export { itemLabel } from './keymap_ui';

/** Called once every module registered its keymaps. */
export function startPreferences() {
  startKeyconfig();
  applyPreferences();
}

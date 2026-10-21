// Preferences: editor + sections, key configuration, themes and the operators behind them.
//   app/prefs.ts        preference values (persisted)
//   store.ts            set / apply / save / revert / factory
//   effects.ts          interface-wide runtime effects
//   editor.ts           the Preferences editor and section registry
//   sections.ts         simple sections built from rows
//   keyconfig*.ts       key configuration model, presets, persistence; keymap_ui.ts its editor
//   themes.ts, theme_*.ts  theme colour groups, presets, editor
//   lights_ui.ts        studio lights / MatCaps / HDRIs (library in render/studiolights.ts)
//   addons*.ts          script add-ons
//   ndof.ts             3D mice and game controllers
//   filepaths.ts        default paths and browser storage
//   apply_fx.ts, menus_fx.ts  preferences pushed into other modules
import './prefs.css';
import './icons';
import './effects';
import './menus_fx';
import './apply_fx';
import './sections';
import './theme_ui';
import './lights_ui';
import './addons';
import './extensions';
import './addons_filter';
import './ndof';
import './filepaths';
import './fonts';
import './miniaxes';
import './autorun';
import './ops';
import './prefops';
import './pathlists';
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

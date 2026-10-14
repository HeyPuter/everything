/**
 * The app's options that reach past the editor: how two-digit years are read, and the page-wide accessibility
 * choices (a stronger selection, less motion). Whether AI features are offered, how soon unsaved edits are
 * copied into this browser and whether AutoSave starts on are read where they act (lib/option-state.js). Installed once at start-up; each change is
 * applied as it is made.
 */
import { appOptions, onAppOptions, reloadAppOptions } from './app-options.js';
import { quickAccessStore, ribbonLayoutStore, keymapStore } from './customize.js';
import { session } from './session.js';
import { storageScope } from './account-storage.js';
import { setTwoDigitYearCutoff } from '../core/format.js';

function apply(options) {
  setTwoDigitYearCutoff(options.yearCutoff);
  const html = globalThis.document?.documentElement;
  if (html) {
    html.classList.toggle('reduce-motion', !!options.reduceMotion);
    html.classList.toggle('strong-selection', !!options.highContrastSelection);
  }
}

let installed = false;
/** Apply the options now and after every change (once, however often it is called). */
export function installAppOptions() {
  apply(appOptions());
  if (installed) return;
  installed = true;
  onAppOptions((options) => apply(options));
  // Signing in (or out) changes whose preferences are in force: read them again under the new account.
  let scope = storageScope();
  session.addEventListener?.('change', () => {
    const now = storageScope();
    if (now === scope) return;
    scope = now;
    reloadAppOptions();
    for (const store of [quickAccessStore, ribbonLayoutStore, keymapStore]) store.reload();
  });
}

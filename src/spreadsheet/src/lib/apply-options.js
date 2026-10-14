/**
 * The app's options that reach past the editor: how two-digit years are read, whether AI features are offered,
 * how soon unsaved edits are copied into this browser, whether AutoSave starts on, and the page-wide
 * accessibility choices (a stronger selection, less motion). Installed once at start-up; each change is
 * applied as it is made.
 */
import { appOptions, onAppOptions, reloadAppOptions } from './app-options.js';
import { quickAccessStore, ribbonLayoutStore, keymapStore } from './customize.js';
import { session } from './session.js';
import { storageScope } from './account-storage.js';
import { setTwoDigitYearCutoff } from '../core/format.js';
import { setAIFeaturesAllowed } from './puter.js';
import { setDraftDelay, setAutoSaveDefault } from './doc.js';

function apply(options) {
  setTwoDigitYearCutoff(options.yearCutoff);
  setAIFeaturesAllowed(options.aiFeatures);
  setDraftDelay(options.draftDelay);
  setAutoSaveDefault(options.autoSave);
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

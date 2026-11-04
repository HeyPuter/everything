/**
 * Opening the app again, in place: how a change that is read once per page (the display language)
 * takes effect. main.js installs the way to do it, which saves or keeps the open spreadsheet first,
 * as leaving it for another screen would, and reopens it after the reload.
 */
let relauncher = null;

/** main.js's: resolves to false when the person chose to stay (the open spreadsheet could not be left). */
export function setRelauncher(fn) {
  relauncher = fn;
}

/** Reload the app, keeping what is open. False when it stayed. */
export async function relaunch() {
  if (relauncher) return relauncher();
  globalThis.location?.reload();
  return true;
}

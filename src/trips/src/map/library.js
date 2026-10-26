let pending;
export function loadMapLibre() {
  pending ??= import('./library-runtime.js').then(module => module.library).catch(cause => { pending = null; throw cause; });
  return pending;
}

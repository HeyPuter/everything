import { validateSpaceRef, spaceRoute, WORKER_PATTERN } from '../shared/protocol.js';
import { isId } from '../shared/ids.js';
import { tripTabs } from '../views/registry/tabs.js';
import { routes as pages } from '../views/registry/routes.js';
import { prefs } from './prefs.js';

const JOIN_TOKEN = /^[0-9a-f]{32}$/;

const SLUG = /^[a-z][a-z0-9-]{0,31}$/;
// A registered route with a `load` and a one-segment hash (`#/atlas`) is a page: `{name: 'page', id}`.
const pageFor = (id) => pages.find((item) => typeof item.load === 'function' && item.hash === `#/${id}`);
/** The default trip tab preference when it names a registered trip tab, otherwise `plan`. */
export function defaultTripTab(tab = prefs().tripTab, tabs = tripTabs) {
  return tabs.some((item) => item.id === tab) ? tab : 'plan';
}
export function parseRoute(hash = '') {
  if (hash === '' || hash === '#' || hash === '#/') return { name: 'dashboard' };
  if (typeof hash !== 'string' || hash.length > 1024 || !hash.startsWith('#/') || /[\u0000- \\?]/.test(hash)) return { name: 'notFound' };
  let parts;
  try { parts = hash.slice(2).split('/').map(decodeURIComponent); } catch { return { name: 'notFound' }; }
  if (parts.some((part) => !part || /[\s/#?\\]/.test(part))) return { name: 'notFound' };
  if (parts[0] === 'new' && parts.length === 1) return { name: 'dashboard', create: true };
  if (parts[0] === 'settings' && parts.length <= 2 && (!parts[1] || SLUG.test(parts[1]))) return { name: 'settings', section: parts[1] ?? 'appearance' };
  if (parts[0] === 'collections' && parts.length === 1) return { name: 'collections' };
  if (['t', 'c', 'j'].includes(parts[0]) && [3, 4].includes(parts.length)) {
    const ref = { w: parts[1], s: parts[2], k: { t: 'trip', c: 'collection', j: 'journey' }[parts[0]] };
    try { validateSpaceRef(ref); } catch { return { name: 'notFound' }; }
    if (parts[3] && !SLUG.test(parts[3])) return { name: 'notFound' };
    return { name: 'space', ref, tab: parts[3] ?? ({ c: 'places', j: 'timeline' }[parts[0]] ?? defaultTripTab()) };
  }
  if (parts[0] === 'join' && parts.length === 4 && WORKER_PATTERN.test(parts[1]) && isId(parts[2]) && JOIN_TOKEN.test(parts[3])) {
    return { name: 'join', worker: parts[1], space: parts[2], token: parts[3] };
  }
  if (parts[0] === 's' && parts.length === 4 && WORKER_PATTERN.test(parts[1]) && isId(parts[2]) && JOIN_TOKEN.test(parts[3])) {
    return { name: 'public', worker: parts[1], space: parts[2], token: parts[3] };
  }
  if (parts.length === 1 && SLUG.test(parts[0]) && pageFor(parts[0])) return { name: 'page', id: parts[0] };
  return { name: 'notFound' };
}
export function routeHash(route) {
  if (route.name === 'dashboard') return route.create ? '#/new' : '#/';
  if (route.name === 'collections') return '#/collections';
  if (route.name === 'settings' && SLUG.test(route.section ?? 'appearance')) return `#/settings/${route.section ?? 'appearance'}`;
  if (route.name === 'space' && SLUG.test(route.tab ?? defaultTripTab())) return `${spaceRoute(route.ref)}/${route.tab ?? defaultTripTab()}`;
  if (route.name === 'page' && SLUG.test(route.id ?? '') && pageFor(route.id)) return `#/${route.id}`;
  if (route.name === 'join' && parseRoute(`#/join/${route.worker}/${route.space}/${route.token}`).name === 'join') return `#/join/${route.worker}/${route.space}/${route.token}`;
  if (route.name === 'public' && parseRoute(`#/s/${route.worker}/${route.space}/${route.token}`).name === 'public') return `#/s/${route.worker}/${route.space}/${route.token}`;
  throw new TypeError('Invalid route');
}
export function createRouter({ window = globalThis.window, onRoute } = {}) {
  let started = false;
  const publish = () => onRoute?.(parseRoute(window.location.hash));
  return {
    get route() { return parseRoute(window.location.hash); },
    start() { if (!started) { started = true; window.addEventListener('hashchange', publish); publish(); } },
    navigate(target, { replace = false } = {}) {
      const hash = typeof target === 'string' ? target : routeHash(target);
      if (parseRoute(hash).name === 'notFound') throw new TypeError('Invalid route');
      if (window.location.hash === hash) { if (started) publish(); return; }
      if (replace) { window.history.replaceState(null, '', hash); if (started) publish(); }
      else window.location.hash = hash;
    },
    destroy() { started = false; window.removeEventListener('hashchange', publish); },
  };
}

import { coordinate } from './core.js';
let library;
const load = async () => { library ??= import('@photostructure/tz-lookup').then(module => module.default ?? module); return library; };
export function createTimezone({ loadLookup = load } = {}) {
  return { async zoneAt(lat, lng) { coordinate(lat, lng); const lookup = await loadLookup(); const zone = lookup(lat, lng); new Intl.DateTimeFormat('en', { timeZone: zone }); return zone; } };
}

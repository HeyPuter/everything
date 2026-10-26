// Primary navigation. Settings stays last; append above it.
export const routes = Object.freeze([
  { id: 'dashboard', labelKey: 'app.trips', icon: 'map', hash: '#/', load: () => import('../dashboard/index.js') },
  { id: 'collections', labelKey: 'collections.nav', icon: 'heart', hash: '#/collections', load: () => import('../collections/index.js') },
  { id: 'atlas', labelKey: 'atlas.title', icon: 'globe', hash: '#/atlas', load: () => import('../atlas/index.js') },
  { id: 'week', labelKey: 'week.title', icon: 'calendar', hash: '#/week', load: () => import('../week/index.js') },
  { id: 'vacay', labelKey: 'vacay.nav', icon: 'calendar', hash: '#/vacay', load: () => import('../vacay/index.js') },
  { id: 'journeys', labelKey: 'journey.nav', icon: 'file', hash: '#/journeys', load: () => import('../journey/index.js') },
  { id: 'settings', labelKey: 'app.settings', icon: 'more', hash: '#/settings' },
]);

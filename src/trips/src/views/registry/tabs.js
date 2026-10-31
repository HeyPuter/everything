// Trip tabs in display order. A module adds `load: () => import('../trip/<id>/index.js')` to its line;
// see "Adding a module" in src/lib/README.md for the mount contract.
export const tripTabs = Object.freeze([
  { id: 'plan', labelKey: 'app.plan', icon: 'map', load: () => import('../trip/plan/index.js') },
  { id: 'bookings', labelKey: 'app.bookings', icon: 'plane', load: () => import('../trip/bookings/index.js') },
  { id: 'costs', labelKey: 'app.costs', icon: 'wallet', load: () => import('../trip/costs/index.js') },
  { id: 'lists', labelKey: 'app.lists', icon: 'backpack', load: () => import('../trip/lists/index.js') },
  { id: 'files', labelKey: 'app.files', icon: 'file', load: () => import('../trip/files/index.js') },
  { id: 'collab', labelKey: 'app.collab', icon: 'users', load: () => import('../trip/collab/index.js'), badge: () => import('../trip/collab/badge.js') },
  { id: 'members', labelKey: 'app.members', icon: 'users', load: () => import('../trip/members/index.js') },
  { id: 'settings', labelKey: 'app.settings', icon: 'more', load: () => import('../trip/settings/index.js') },
]);

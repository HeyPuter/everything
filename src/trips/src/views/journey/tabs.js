// Journey page tabs. A tab with `load` mounts a module exporting `mount(container, {space, context, ref, signal})`.
export const JOURNEY_TABS = Object.freeze([
  { id: 'timeline', labelKey: 'journey.tab.timeline', icon: 'write' },
  { id: 'map', labelKey: 'journey.tab.map', icon: 'map' },
  { id: 'gallery', labelKey: 'journey.tab.gallery', icon: 'photos' },
  { id: 'stats', labelKey: 'journey.tab.stats', icon: 'stats' },
  { id: 'book', labelKey: 'book.tab', icon: 'journey', load: () => import('./book/index.js') },
]);

/** The tab for a route segment; unknown or trip-only tabs (the router's default) open the timeline. */
export const tabFor = (id, tabs = JOURNEY_TABS) => (tabs.some((tab) => tab.id === id) ? id : 'timeline');

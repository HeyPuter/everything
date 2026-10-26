// Settings sections in display order. Sections with `load` replace the shell's built-in ones; about stays built in.
const settings = () => import('../settings/index.js');
export const settingsSections = Object.freeze([
  { id: 'appearance', labelKey: 'app.appearance', icon: 'sun', load: settings },
  { id: 'general', labelKey: 'settings.general', icon: 'more', load: settings },
  { id: 'map', labelKey: 'settings.map', icon: 'map', load: settings },
  { id: 'dashboard', labelKey: 'settings.dashboard', icon: 'calendar', load: settings },
  { id: 'templates', labelKey: 'settings.templates', icon: 'backpack', load: settings },
  { id: 'categories', labelKey: 'settings.categories', icon: 'pin', load: settings },
  { id: 'ai', labelKey: 'settings.ai', icon: 'more', load: settings },
  { id: 'vault', labelKey: 'settings.vault', icon: 'file', load: settings },
  { id: 'offline', labelKey: 'settings.offline', icon: 'offline', load: settings },
  { id: 'flight-status', labelKey: 'flightStatus.settingsTitle', icon: 'plane', load: () => import('../settings/flight-status.js') },
  { id: 'integrations', labelKey: 'integrations.settingsTitle', icon: 'globe', load: () => import('../settings/integrations.js') },
  { id: 'data', labelKey: 'io.settingsTitle', icon: 'file', load: () => import('../settings/data-export.js') },
  { id: 'delete', labelKey: 'deleteData.title', icon: 'trash', load: () => import('../settings/delete-data.js') },
  { id: 'notifications', labelKey: 'notifyOut.title', icon: 'clock', load: () => import('../settings/notifications.js') },
  { id: 'calendar', labelKey: 'icsAll.settingsTitle', icon: 'calendar', load: () => import('../ics/all/index.js') },
  { id: 'account', labelKey: 'app.account', icon: 'users', load: settings },
  { id: 'about', labelKey: 'app.about', icon: 'file' },
]);

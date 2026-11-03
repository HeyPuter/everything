// Default commands. Modules append `{ id, labelKey, shortcut?, run(app) }`; `action` names a shell handler.
export const commands = Object.freeze([
  { id: 'home', labelKey: 'app.goTrips', shortcut: 'Alt+h', action: 'home' },
  { id: 'appearance', labelKey: 'app.openAppearance', shortcut: 'Mod+,', action: 'appearance' },
  { id: 'help', labelKey: 'app.shortcuts', shortcut: '?', action: 'help' },
  { id: 'download-data', labelKey: 'io.cmdDownloadData', run: (app) => app.navigate('#/settings/data') },
  { id: 'help-pages', labelKey: 'help.command', run: async () => (await import('../help/index.js')).openHelp() },
  { id: 'journeys', labelKey: 'journey.cmdOpen', run: (app) => app.navigate('#/journeys') },
  { id: 'journey-new', labelKey: 'journey.cmdNew', run: (app) => import('../journey/command.js').then((module) => module.newJourney(app)) },
  { id: 'all-trips-calendar', labelKey: 'icsAll.command', run: (app) => app.navigate('#/settings/calendar') },
  { id: 'palette', labelKey: 'app.commandPalette', shortcut: 'Mod+k', editable: true, action: 'palette', hidden: true },
]);
export function createCommandRegistry(initial = commands) {
  const entries = new Map();
  function register(command) {
    if (!command || !/^[a-z][a-z0-9-]{0,63}$/.test(command.id) || typeof command.labelKey !== 'string' || command.shortcut !== undefined && typeof command.shortcut !== 'string' || entries.has(command.id)) throw new TypeError('Invalid command');
    entries.set(command.id, { ...command });
    return () => entries.delete(command.id);
  }
  initial.forEach(register);
  return { register, list: () => [...entries.values()], get: (id) => entries.get(id) };
}
export function matchesShortcut(event, shortcut, { mac = false } = {}) {
  if (!shortcut || event.isComposing || event.keyCode === 229 || event.repeat || event.altKey && (event.ctrlKey || event.metaKey)) return false;
  const parts = shortcut.split('+'); const key = parts.pop();
  const mod = parts.includes('Mod');
  if (event.ctrlKey !== Boolean(mod && !mac || parts.includes('Ctrl')) || event.metaKey !== Boolean(mod && mac || parts.includes('Meta')) || event.altKey !== parts.includes('Alt')) return false;
  if (key !== '?' && event.shiftKey !== parts.includes('Shift')) return false;
  return event.key.toLocaleLowerCase() === key.toLocaleLowerCase();
}
export function isEditable(target) { return Boolean(target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')); }

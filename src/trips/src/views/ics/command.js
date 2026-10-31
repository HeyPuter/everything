/**
 * Registers the "Add trip to calendar" palette command for a mounted trip view and returns the function that removes
 * it. The dialog loads on first use.
 */
export function registerCalendarCommand(context) {
  const commands = context?.app?.commands;
  if (typeof commands?.register !== 'function' || !context.space) return () => {};
  try {
    return commands.register({ id: 'trip-calendar', labelKey: 'ics.command', run: async () => (await import('./index.js')).openCalendarExport(context) });
  } catch { return () => {}; }
}

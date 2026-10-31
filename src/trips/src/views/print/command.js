// Palette command for printing the open trip. Kept apart from the print view so registering it loads nothing heavy.
export const PRINT_COMMAND = 'trip-print';

/**
 * Registers "Print or save as PDF" (Mod+P) for a trip context and returns its unregister function. A second
 * registration while one is live is a no-op, so the trip shell and a tab can both call it.
 */
export function registerPrintCommand(context) {
  const commands = context?.app?.commands;
  if (typeof commands?.register !== 'function' || commands.get?.(PRINT_COMMAND)) return () => {};
  try {
    return commands.register({
      id: PRINT_COMMAND, labelKey: 'print.command', shortcut: 'Mod+p',
      run: () => import('./index.js').then(({ openPrint }) => openPrint(context)),
    });
  } catch { return () => {}; }
}

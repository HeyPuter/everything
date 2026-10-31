// The "Ask the trip assistant" palette command. Kept apart from the panel so registering it loads nothing heavy.
// Several views may register it at once; the command opens the assistant for the most recent registration.
const registrations = new WeakMap();

/** Registers the command on `context.app.commands` while the caller is mounted; returns the unregister function. */
export function registerAssistantCommand(context) {
  const registry = context?.app?.commands;
  if (!registry?.register || !context.space) return () => {};
  let entry = registrations.get(registry);
  if (!entry) {
    entry = { contexts: [], off: null };
    try {
      entry.off = registry.register({ id: 'trip-assistant', labelKey: 'assistant.command', run: () => open(entry) });
    } catch { return () => {}; }
    registrations.set(registry, entry);
  }
  entry.contexts.push(context);
  return () => {
    const index = entry.contexts.lastIndexOf(context);
    if (index >= 0) entry.contexts.splice(index, 1);
    if (!entry.contexts.length && registrations.get(registry) === entry) { entry.off?.(); registrations.delete(registry); }
  };
}

async function open(entry) {
  const context = entry.contexts.at(-1);
  if (!context) return;
  const { openAssistant } = await import('./index.js');
  openAssistant(context);
}

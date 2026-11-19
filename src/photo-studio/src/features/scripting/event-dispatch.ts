// Runs the Script Events Manager rules when application events happen.
// Loaded at startup; the script runner itself loads only when a rule fires.
import { appEventLabels, type AppEvent } from '../../app/app-events';
import type { DocumentSession } from '../../app/session';
import { findScript, type EventRule, type EventSettings, type ScriptRecord } from './store';

export type EventRunners = {
  script(record: ScriptRecord, event: { name: string; documentId: string | null; documentName: string | null }): Promise<unknown>;
  // The event's document, when it has one (an action plays on it).
  action(actionId: string, session?: DocumentSession): Promise<unknown>;
  // A script or action of a rule is running (events do not nest).
  busy(): boolean;
};

/** The rules an event triggers, in list order. */
export function rulesFor(settings: EventSettings, event: AppEvent): EventRule[] {
  return settings.enabled ? settings.rules.filter((r) => r.enabled && r.event === event) : [];
}

let running = false;
/** Run the rules of an event one after another. Scripts must be installed,
 * listed and already trusted; events raised meanwhile are ignored. */
export async function dispatchEvent(settings: EventSettings, event: AppEvent, session: DocumentSession | undefined, run: EventRunners) {
  const rules = rulesFor(settings, event);
  if (!rules.length || running || run.busy()) return;
  running = true;
  try {
    for (const rule of rules) {
      if (rule.kind === 'action') await run.action(rule.target, session);
      else {
        const record = findScript(rule.target);
        if (!record || !record.enabled) continue;
        await run.script(record, { name: appEventLabels[event], documentId: session?.id ?? null, documentName: session?.doc.name ?? null });
      }
    }
  } finally {
    running = false;
  }
}

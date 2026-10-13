// Application events that automation can react to (File → Scripts → Script
// Events Manager). Features that open, create, save, export or close
// documents announce it here; listeners may be asynchronous, and the
// announcer waits for them where order matters (before a save is written).
import type { DocumentSession } from './session';

export type AppEvent = 'start' | 'new-document' | 'open-document' | 'before-save' | 'after-save' | 'export' | 'close-document';
export const appEventLabels: Record<AppEvent, string> = {
  start: 'Start Application',
  'new-document': 'New Document',
  'open-document': 'Open Document',
  'before-save': 'Before Saving Document',
  'after-save': 'After Saving Document',
  export: 'Export Document',
  'close-document': 'Close Document',
};
export type AppEventListener = (event: AppEvent, session?: DocumentSession) => void | Promise<void>;

const listeners = new Set<AppEventListener>();
// The file a document was opened from (set before "open-document"), for
// listeners that need its bytes (provenance).
export const openedFiles = new WeakMap<DocumentSession, { blob: Blob; name: string }>();
// Batch processing and running scripts open and save documents in bulk;
// events stay quiet meanwhile so automation does not trigger itself.
let quiet = 0;

export function onAppEvent(listener: AppEventListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** Announce an event and wait for its listeners (errors are theirs to report). */
export async function emitAppEvent(event: AppEvent, session?: DocumentSession) {
  if (quiet) return;
  for (const l of [...listeners]) {
    try {
      await l(event, session);
    } catch (error) {
      console.error(error);
    }
  }
}
/** Run work without announcing events (automation that opens many files). */
export async function withoutAppEvents<T>(work: () => Promise<T>): Promise<T> {
  quiet++;
  try {
    return await work();
  } finally {
    quiet--;
  }
}
export const appEventsQuiet = () => quiet > 0;

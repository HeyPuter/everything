// What the user just did in the workspace: a command finished running or a
// tool was chosen. Guided tutorials listen to advance their steps; anything
// that wants to react to user actions without patching each feature can too.
// Emitting is a loop over a usually empty set, so it costs nothing when no
// one listens.
export type Activity = { kind: 'command'; id: string; arg?: unknown } | { kind: 'tool'; id: string };
export type ActivityListener = (a: Activity) => void;

const listeners = new Set<ActivityListener>();

/** Listen to user activity; returns a function that stops listening. */
export function onActivity(listener: ActivityListener) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
export function emitActivity(a: Activity) {
  for (const l of [...listeners]) {
    try {
      l(a);
    } catch (error) {
      console.error(error);
    }
  }
}

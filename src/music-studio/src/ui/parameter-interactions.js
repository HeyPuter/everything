// Only controls with an active pointer, keyboard, or wheel interaction are
// retained. Document/history replacement invalidates even unchanged values.
const active = new Set();

export function trackParameterInteraction(cancel) {
  active.add(cancel);
  return () => active.delete(cancel);
}

export function cancelParameterInteractions() {
  const pending = [...active];
  active.clear();
  for (const cancel of pending) cancel();
}

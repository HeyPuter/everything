// Entry points from outside the journey module: the palette's "New journey" and the trip page's "Create journey".
import { validateSpaceRef } from '../../shared/protocol.js';

export const INTENT_KEY = 'trips:journey:intent';

/** Opens `#/journeys` with the new-journey dialog, preselecting the current trip when the palette ran on one. */
export function newJourney(app) {
  const route = app?.state?.route;
  const trip = route?.name === 'space' && route.ref?.k === 'trip' ? { w: route.ref.w, s: route.ref.s, k: 'trip' } : null;
  try { sessionStorage.setItem(INTENT_KEY, JSON.stringify({ trip, at: Date.now() })); } catch { /* the dialog just won't open by itself */ }
  app.navigate('#/journeys');
}

/** The pending intent (read once, for at most a minute). */
export function readIntent(now = Date.now()) {
  let value = null;
  try { value = JSON.parse(sessionStorage.getItem(INTENT_KEY) ?? 'null'); sessionStorage.removeItem(INTENT_KEY); } catch { return null; }
  if (!value || typeof value !== 'object' || !(now - value.at < 60_000)) return null;
  if (value.trip) { try { validateSpaceRef(value.trip); } catch { value.trip = null; } }
  return value.trip?.k === 'trip' ? { trip: value.trip } : {};
}

/** For the trip page header or menu: starts a journey from that trip. `context` needs `app` and `ref`. */
export function openJourneyFromTrip(context) {
  const ref = context.ref ?? context.route?.ref;
  newJourney({ navigate: (hash) => context.app.navigate(hash), state: { route: { name: 'space', ref } } });
}

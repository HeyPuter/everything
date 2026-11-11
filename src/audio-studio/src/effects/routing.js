// Channel routing for an effect (the dialog's channel map).
//
// A route { in: [a, b], out: [x, y] } feeds the effect's left input from file
// channel `a` and its right input from `b` (-1 = silence), and writes effect
// output `x` to file channel 0 and `y` to file channel 1 (-1 = that channel
// keeps its unprocessed audio). Realtime slots carry the route to FxHost so
// preview and Apply sound the same; offline processes are routed in JS here.

const IDENTITY = { in: [0, 1], out: [0, 1] };

/** Short channel names for a file with n channels. */
export function channelNames(n) {
  if (n <= 1) return ['M'];
  if (n === 2) return ['L', 'R'];
  return Array.from({ length: n }, (_, i) => String(i + 1));
}

/** The route that processes every enabled channel in place (mask: the editor's channel enables). */
export function defaultRoute(mask = null) {
  return { in: [0, 1], out: [0, 1].map((k) => (mask && !mask[k] ? -1 : k)) };
}

export function sameRoute(a, b) {
  return Boolean(a && b) && a.in.every((v, i) => v === b.in[i]) && a.out.every((v, i) => v === b.out[i]);
}

export function isIdentityRoute(route) {
  return !route || (route.in.every((v, i) => v === IDENTITY.in[i]) && route.out.every((v, i) => v === IDENTITY.out[i]));
}

/**
 * "In: L, R | Out: L, R" for a route on a file with n channels. Without a
 * route, a file wider than stereo (5.1) is processed on all its channels,
 * written to those `mask` enables.
 */
export function routeSummary(route, n = 2, mask = null) {
  const names = channelNames(n);
  if (n < 2) return `In: ${names[0]} | Out: ${route && route.out[0] < 0 ? 'None' : names[0]}`;
  if (n > 2 && !route) {
    const outs = names.filter((_, k) => !mask || mask[k]);
    return `In: ${names.join(', ')} | Out: ${outs.length ? outs.join(', ') : 'None'}`;
  }
  const r = route || IDENTITY;
  const ins = r.in.map((s) => (s < 0 ? '-' : names[s]));
  const outs = r.out.map((o, k) => (o < 0 ? null : names[k])).filter(Boolean);
  return `In: ${ins.join(', ')} | Out: ${outs.length ? outs.join(', ') : 'None'}`;
}

/**
 * File channels the route writes, as an edit mask (null = all). The route
 * decides the first two channels (it starts from the editor's channel
 * enables, see defaultRoute); `mask` still limits any further channels.
 */
export function routeMask(route, n, mask = null) {
  if (!route || n < 2) return mask;
  const m = Array.from({ length: n }, (_, k) => (k > 1 ? (mask ? Boolean(mask[k]) : true) : route.out[k] >= 0));
  return m.every(Boolean) ? null : m;
}

/** Effect input channels from file channels (offline processes). */
export function routeInputs(channels, route) {
  if (!route || channels.length < 2) return channels;
  const n = channels[0].length;
  return route.in.map((s) => (s >= 0 && channels[s] ? channels[s] : new Float32Array(n))).concat(channels.slice(2));
}

/** File channel outputs from effect outputs; unrouted channels keep `dry`. */
export function routeOutputs(outs, dry, route) {
  if (!route || dry.length < 2) return outs;
  const pick = (i) => outs[Math.min(i, outs.length - 1)];
  return dry.map((d, k) => (k > 1 ? pick(k) : route.out[k] >= 0 ? pick(route.out[k]) : d));
}

// The last route used per effect this session, so reopening a dialog keeps it.
const remembered = new Map();

/** Remembers `route` for effect `id`; null forgets it (the default applies again). */
export function rememberRoute(id, route) {
  if (!route) remembered.delete(id);
  else remembered.set(id, { in: [...route.in], out: [...route.out] });
}

export function recallRoute(id) {
  const r = remembered.get(id);
  return r ? { in: [...r.in], out: [...r.out] } : null;
}

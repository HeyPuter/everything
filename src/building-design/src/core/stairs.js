/**
 * Stair layout: flights and landings for straight, L-shaped and U-shaped
 * stairs. A stair runs from its base to its top level; the risers are
 * shared between flights and each landing sits at the top of a flight.
 *
 * Flight: { start (center of its first riser line), dir, side (left unit
 * vector), risers, z0 (bottom), run (length) }
 * Landing: { poly, z }
 */
import { add, sub, scale, norm, perp, len } from './geom.js';
import { stairLayout } from './model.js';

export const STAIR_SHAPES = [
  { value: 'straight', label: 'Straight' },
  { value: 'l', label: 'L-shaped' },
  { value: 'u', label: 'U-shaped' },
  { value: 'spiral', label: 'Spiral' },
];

/** Radius of a spiral stair's central column. */
export const SPIRAL_CORE = 100;

/**
 * Spiral geometry: { c, rin, rout, rwalk, a0, step (radians per tread, signed), treads }.
 * The tread depth is measured on the walking line, in the middle of the width.
 */
export function spiralLayout(el, lay) {
  const { risers: R, tread: td, width: W } = lay;
  const rin = SPIRAL_CORE;
  const rout = rin + W;
  const rwalk = rin + W / 2;
  const d0 = sub(el.b, el.a);
  const a0 = Math.atan2(d0[1], d0[0]);
  const sign = el.turn === 'right' ? -1 : 1;
  const step = sign * Math.min(Math.PI / 4, td / rwalk);
  return { c: el.a, rin, rout, rwalk, a0, step, treads: Math.max(1, R) };
}

export function stairFlights(doc, el) {
  const lay = stairLayout(doc, el);
  const { base, risers: R, riserHeight: rh, tread: td, width: W } = lay;
  const d0 = sub(el.b, el.a);
  const dir = len(d0) > 1 ? norm(d0) : [1, 0];
  const left = perp(dir);
  const turn = el.turn === 'right' ? scale(left, -1) : left;
  const shape = el.shape || 'straight';
  const flights = [];
  const landings = [];
  if (shape === 'spiral') return { ...lay, shape, dir, flights, landings, spiral: spiralLayout(el, lay) };
  if (shape === 'straight' || R < 4) {
    flights.push({ start: el.a, dir, side: left, risers: R, z0: base, run: (R - 1) * td });
    return { ...lay, shape: 'straight', dir, flights, landings };
  }
  const r1 = Math.ceil(R / 2);
  const r2 = R - r1;
  const s1 = (r1 - 1) * td;
  const zLanding = base + r1 * rh;
  flights.push({ start: el.a, dir, side: left, risers: r1, z0: base, run: s1 });
  const P = (s, w) => add(add(el.a, scale(dir, s)), scale(turn, w));
  if (shape === 'l') {
    landings.push({ poly: [P(s1, -W / 2), P(s1 + W, -W / 2), P(s1 + W, W / 2), P(s1, W / 2)], z: zLanding });
    const d2 = turn;
    flights.push({ start: P(s1 + W / 2, W / 2), dir: d2, side: perp(d2), risers: r2, z0: zLanding, run: (r2 - 1) * td, fromLanding: true });
  } else {
    const gap = Math.max(0, +el.gap || 100);
    landings.push({ poly: [P(s1, -W / 2), P(s1 + W, -W / 2), P(s1 + W, W * 1.5 + gap), P(s1, W * 1.5 + gap)], z: zLanding });
    const d2 = scale(dir, -1);
    flights.push({ start: P(s1, W + gap), dir: d2, side: perp(d2), risers: r2, z0: zLanding, run: (r2 - 1) * td, fromLanding: true });
  }
  return { ...lay, shape, dir, flights, landings };
}

/** Plan outline corners of a flight: from its first riser to its last. */
export function flightOutline(f, W) {
  const o = add(f.start, scale(f.side, -W / 2));
  const S = (s, w) => add(add(o, scale(f.dir, s)), scale(f.side, w));
  return [S(0, 0), S(f.run, 0), S(f.run, W), S(0, W)];
}

/** Point on a flight at distance s along it and w across from its right edge. */
export function flightPoint(f, W, s, w) {
  const o = add(f.start, scale(f.side, -W / 2));
  return add(add(o, scale(f.dir, s)), scale(f.side, w));
}

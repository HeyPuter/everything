/**
 * Spaces and zones, for building services design. A space is the volume a
 * system serves (bounded like a room); zones group spaces served together
 * (one air handler, one thermostat).
 *
 *   space { levelId, at, name, number, spaceType, height, zoneId, people? }
 *   zone  { name, color, heating, cooling }   setpoints in degrees C
 *
 * Loads are first estimates from typical gains per floor area and
 * occupant, for sizing early; they are not an energy simulation.
 */
import { W, INK } from './plan.js';
import { add } from './geom.js';
import { MEP_KINDS, systemOf } from './mep.js';

export const SPACE_TYPES = [
  { value: 'office', label: 'Office', lighting: 9, equipment: 12, density: 10, air: 10 },
  { value: 'meeting', label: 'Meeting room', lighting: 10, equipment: 5, density: 40, air: 10 },
  { value: 'classroom', label: 'Classroom', lighting: 10, equipment: 6, density: 35, air: 10 },
  { value: 'retail', label: 'Retail', lighting: 14, equipment: 5, density: 15, air: 8 },
  { value: 'dwelling', label: 'Dwelling', lighting: 5, equipment: 5, density: 4, air: 7 },
  { value: 'corridor', label: 'Corridor', lighting: 5, equipment: 0, density: 2, air: 3 },
  { value: 'storage', label: 'Storage', lighting: 4, equipment: 0, density: 0, air: 2 },
  { value: 'plant', label: 'Plant room', lighting: 6, equipment: 30, density: 0, air: 2 },
];

const P = (pc, mm) => mm * pc.scale;

export const PERSON_SENSIBLE = 75;
export const PERSON_LATENT = 55;
/** Fabric and solar gains per floor area for a first cooling estimate, and fabric and air losses for heating. */
export const ENVELOPE_COOLING = 35;
export const ENVELOPE_HEATING = 45;

export function spaceType(space) {
  return SPACE_TYPES.find((t) => t.value === space.spaceType) || SPACE_TYPES[0];
}

/** Area (m²), volume (m³) and estimated loads (W) of a space; null when not enclosed. */
export function spaceLoads(space, region) {
  if (!region) return null;
  const t = spaceType(space);
  const area = region.area / 1e6;
  const volume = area * ((+space.height || 2700) / 1000);
  const people = space.people != null && space.people !== '' ? +space.people : Math.round((area * t.density) / 100);
  const internal = area * (t.lighting + t.equipment) + people * PERSON_SENSIBLE;
  const cooling = internal + people * PERSON_LATENT + area * ENVELOPE_COOLING;
  const heating = area * ENVELOPE_HEATING + people * t.air * 0.02 * 25;
  const outdoorAir = people * t.air;
  return { area, volume, people, internal, cooling, heating, outdoorAir };
}

const hexRgb = (hex) => {
  const n = parseInt(String(hex || '#7a8aa0').replace('#', '').slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export const ZONE_COLORS = ['#4f8fd6', '#e0884f', '#5fb36f', '#b56fd1', '#d6b13f', '#4fc0c0', '#d65f7a', '#8a9a5b'];

/** Plan graphics of a space: a light tint (its zone's colour) and its label. */
export function planSpace(pc, el, b) {
  if (el.levelId !== pc.view.levelId) return;
  const region = pc.rooms.room(el);
  const zone = pc.doc.get(el.zoneId);
  const rgb = hexRgb(zone?.color);
  if (region) {
    b.fill(region.outer, region.holes, [...rgb, zone ? 70 : 28], 0);
    b.poly(region.outer, true, W.thin, 1, [...rgb, 200]);
    b.pick(region.outer);
  } else {
    const s = P(pc, 1.5);
    b.pick([add(el.at, [-s, -s]), add(el.at, [s, -s]), add(el.at, [s, s]), add(el.at, [-s, s])]);
  }
  const sz = P(pc, 2.2);
  // Below the room label, which usually sits at the same point.
  const at = el.tagAt || [el.at[0], el.at[1] - sz * 3.4];
  b.text([at[0], at[1] + sz * 0.8], `${el.number ? `${el.number} ` : ''}${el.name || 'Space'}`, { size: sz, color: INK(220), mask: true });
  const l = spaceLoads(el, region);
  b.text([at[0], at[1] - sz * 0.7], l ? `${l.area.toFixed(1)} m²${zone ? ` · ${zone.name}` : ''}` : 'Not enclosed', { size: sz * 0.85, color: INK(170), mask: true });
}

/** Open ends of ducts and pipes: ends that meet no other run of the same kind and no equipment. */
export function disconnects(doc) {
  const out = [];
  const near = (p, q, tol) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol;
  const terminals = doc.all('component').filter((c) => c.at);
  for (const k of MEP_KINDS) {
    const runs = doc.all(k);
    for (const r of runs) {
      for (const end of ['a', 'b']) {
        const p = r[end];
        const joined = runs.some((o) => o.id !== r.id && o.levelId === r.levelId && (near(o.a, p, 1) || near(o.b, p, 1)));
        if (joined) continue;
        // An end at a fixture, terminal or piece of equipment is connected to it.
        if (terminals.some((c) => c.levelId === r.levelId && near(c.at, p, 450))) continue;
        out.push({ id: r.id, kind: k, end, at: p, system: systemOf(r).label });
      }
    }
  }
  return out;
}

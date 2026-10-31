// The assistant's tools: read tools answer at once from the replica (or a service); propose_ tools only plan a change
// for the user to approve (proposals.js). Every argument object is checked against its schema before use.
import { a, checkArgs, jsonSchema } from './schema.js';
import { clip, compact } from './data.js';
import { proposalPermission } from './proposals.js';
import { BUILTIN_CATEGORIES } from '../../categories.js';
import { dailySummary } from '../../../services/weather.js';
import { daysBetween } from '../../../shared/dates.js';

const o = a.optional;
const CATEGORIES = BUILTIN_CATEGORIES.map((entry) => entry.id);
const BOOKING_TYPES = ['flight', 'train', 'bus', 'car', 'taxi', 'bike', 'cruise', 'ferry', 'transit', 'transport', 'lodging', 'restaurant', 'event', 'tour', 'parking', 'other'];
const offset = () => o(a.integer(0, 100_000));
const limit = (max) => o(a.integer(1, max));
const round = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : undefined);
const located = (value) => Number.isFinite(value?.lat) && Number.isFinite(value?.lng);

function dayOf(reader, ref) {
  const day = reader.findDay(ref);
  if (!day) return { error: 'day_not_found', message: `No day matches "${clip(ref, 40)}".` };
  return { day };
}

export const TOOLS = Object.freeze([
  {
    name: 'get_trip_summary', kind: 'read',
    description: 'The trip at a glance: title, dates, status, currency, what the user may edit, and counts of days, places, bookings and list items.',
    params: a.object({}),
    run: ({ reader }) => reader.summary(),
  },
  {
    name: 'get_days', kind: 'read',
    description: 'Days in plan order with their items (visits, bookings, notes) and ids. Use from and limit to page through long trips.',
    params: a.object({ from: o(a.integer(1, 1000)), limit: limit(31), detail: o(a.enum('full', 'brief')) }),
    run: ({ reader }, args) => {
      const from = (args.from ?? 1) - 1;
      const take = args.limit ?? 14;
      const days = reader.days(args.detail ?? 'full', { from, limit: take });
      const total = reader.summary().days;
      return compact({ total, days, next: from + take < total ? from + take + 1 : undefined });
    },
  },
  {
    name: 'get_day', kind: 'read',
    description: 'One day in full: its notes, where the user sleeps, and every item in order with ids, times, place ids and notes.',
    params: a.object({ day: a.dayRef() }),
    run: ({ reader }, args) => {
      const { day, error, message } = dayOf(reader, args.day);
      return error ? { error, message } : reader.day(day.id);
    },
  },
  {
    name: 'list_places', kind: 'read',
    description: 'Places saved in the trip, by name. Filter by text, category, or only those not yet on any day.',
    params: a.object({ query: o(a.string(200)), category: o(a.enum(...CATEGORIES)), notScheduled: o(a.boolean()), offset: offset(), limit: limit(100) }),
    run: ({ reader }, args) => reader.places(args),
  },
  {
    name: 'get_bookings', kind: 'read',
    description: 'Reservations, transport and lodging in date order, with times, places and legs. Confirmation codes are not shown.',
    params: a.object({ type: o(a.enum(...BOOKING_TYPES)), offset: offset(), limit: limit(60) }),
    run: ({ reader }, args) => reader.bookings(args),
  },
  {
    name: 'get_lists', kind: 'read',
    description: 'The packing list ("pack") or to-dos ("todo"), with list names and what the user has done.',
    params: a.object({ kind: a.enum('pack', 'todo'), list: o(a.string(100)), offset: offset(), limit: limit(200) }),
    run: ({ reader }, args) => reader.lists(args.kind, args),
  },
  {
    name: 'get_costs_summary', kind: 'read',
    description: 'Spending so far in the trip currency, by category, and what the user owes or is owed.',
    params: a.object({}),
    run: ({ reader }) => reader.costs(),
  },
  {
    name: 'get_weather', kind: 'read', needs: 'weather',
    description: 'Weather for a dated day at its first located place: the forecast up to about a week ahead, otherwise the usual weather for that month. Temperatures in °C.',
    params: a.object({ day: a.dayRef() }),
    run: async ({ reader, services, signal }, args) => {
      const { day, error, message } = dayOf(reader, args.day);
      if (error) return { error, message };
      if (!day.date) return { error: 'undated_day', message: 'This day has no date.' };
      const where = reader.dayLocation(day.id);
      if (!where) return { error: 'no_location', message: 'No place in the trip has a location yet.' };
      const ahead = daysBetween(reader.today(), day.date);
      if (ahead >= 0 && ahead <= 8) {
        const result = await services.weather.forecast(where.lat, where.lng, { signal });
        const summary = dailySummary(result?.data?.entries ?? [], where.tz ?? 'UTC').find((entry) => entry.date === day.date);
        if (summary) return compact({ date: day.date, source: 'forecast', condition: summary.condition, lowC: round(summary.minC), highC: round(summary.maxC), rainMm: summary.precipitationMm });
      }
      const month = Number(day.date.slice(5, 7));
      const normals = await services.weather.normals(where.lat, where.lng, month, { signal });
      if (!normals?.data) return { error: 'unavailable', message: 'Weather is not available right now.' };
      return compact({ date: day.date, source: 'usual weather for the month', averageC: round(normals.data.temperatureC), highC: round(normals.data.highC), lowC: round(normals.data.lowC), rainMmPerDay: round(normals.data.precipitationMmDay) });
    },
  },
  {
    name: 'search_map', kind: 'read', needs: 'geocode',
    description: 'Looks up places on the map near the trip (or near a day or place). Returns names, addresses and coordinates; nothing is saved.',
    params: a.object({ query: a.text(200, 'What to look for, such as "pastéis de nata Belém".'), near: o(a.dayRef('Search near this day (id or date) or place (id).')) }),
    run: async ({ reader, services, space, signal }, args) => {
      let near = null;
      if (args.near) {
        const day = reader.findDay(args.near);
        const place = day ? null : space.get('place', args.near);
        near = day ? reader.dayLocation(day.id) : located(place) ? place : null;
      }
      near ??= reader.center();
      const result = await services.geocode.search(args.query, { ...(near ? { bias: { lat: near.lat, lng: near.lng, zoom: 12 } } : {}), signal });
      if (!result) return { error: 'offline', message: 'Map search is not available offline.' };
      return {
        results: (result.data ?? []).slice(0, 8).map((hit) => compact({
          name: clip(hit.name, 100), address: clip(hit.address, 160), lat: round4(hit.lat), lng: round4(hit.lng),
          kind: hit.kind ? `${hit.kind.key}=${hit.kind.value}` : undefined, country: hit.country || undefined,
        })),
      };
    },
  },
  {
    name: 'propose_add_visits', kind: 'propose',
    description: 'Proposes adding items to one day: saved places (by place id) or free-form items (title). Without position, timed items go in time order and others at the end.',
    params: a.object({
      day: a.dayRef(),
      items: a.array(a.object({
        place: o(a.id('A place id from list_places.')), title: o(a.text(200, 'For an item without a place.')),
        start: o(a.time('HH:mm')), end: o(a.time('HH:mm')), notes: o(a.text(1000)),
      }), 30, 1),
      position: o(a.integer(0, 1000)),
    }),
  },
  {
    name: 'propose_move_visits', kind: 'propose',
    description: 'Proposes moving visits to another day or position. Position counts the other items on the target day from 0; without it the visit goes last.',
    params: a.object({ moves: a.array(a.object({ visit: a.id('A visit id from get_day.'), day: a.dayRef(), position: o(a.integer(0, 1000)) }), 30, 1) }),
  },
  {
    name: 'propose_add_places', kind: 'propose',
    description: 'Proposes saving new places to the trip. Each is looked up on the map by name and query; places already saved are reused. Optionally schedules each on a day.',
    params: a.object({
      places: a.array(a.object({
        name: a.text(200, 'The place\'s name.'), query: o(a.text(200, 'Area or address to find it, such as "Belém, Lisbon".')),
        category: o(a.enum(...CATEGORIES)), notes: o(a.text(1000)),
        day: o(a.dayRef('Also add it to this day.')), start: o(a.time('HH:mm')), end: o(a.time('HH:mm')),
      }), 20, 1),
    }),
  },
  {
    name: 'propose_add_packing_items', kind: 'propose',
    description: 'Proposes adding items to the shared packing list, in named lists (such as "Clothes"). Items already on the list are skipped.',
    params: a.object({
      items: a.array(a.object({ name: a.text(200), qty: o(a.integer(1, 999)), list: o(a.text(100)) }), 100, 1),
      assignToMe: o(a.boolean()),
    }),
  },
  {
    name: 'propose_add_todos', kind: 'propose',
    description: 'Proposes adding to-dos, optionally with a due date, list name and priority (1 high to 3 low). To-dos already listed are skipped.',
    params: a.object({
      items: a.array(a.object({ name: a.text(200), due: o(a.date('YYYY-MM-DD')), list: o(a.text(100)), priority: o(a.integer(1, 3)), notes: o(a.text(1000)) }), 50, 1),
    }),
  },
  {
    name: 'propose_redate', kind: 'propose',
    description: 'Suggests new trip dates. Without end the trip keeps its length. The user changes the dates themselves after reviewing the effect on the plan.',
    params: a.object({ start: a.date('YYYY-MM-DD'), end: o(a.date('YYYY-MM-DD')) }),
  },
].map(Object.freeze));

function round4(value) { return Number.isFinite(value) ? Number(value.toFixed(4)) : undefined; }

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
export const toolByName = (name) => BY_NAME.get(name) ?? null;

/** Tools this user can use here, in the function format `puter.ai.chat` takes. */
export function toolList({ space, services }) {
  return TOOLS.filter((tool) => (tool.needs ? Boolean(services?.[tool.needs]) : true) && (tool.kind !== 'propose' || space.can(proposalPermission(tool.name))))
    .map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: jsonSchema(tool.params) } }));
}

/** Validates a call's arguments: `{ok, value}` or `{ok: false, error}` (a message for the model). */
export function validateCall(name, input) {
  const tool = toolByName(name);
  if (!tool) return { ok: false, error: `There is no tool called ${clip(name, 60)}.` };
  if (input?.__unreadable !== undefined) return { ok: false, error: 'The arguments could not be read as JSON.' };
  const checked = checkArgs(tool.params, input);
  return checked.ok ? { ok: true, tool, value: checked.value } : { ok: false, error: `Invalid arguments: ${checked.issues.join('; ')}.` };
}

/** `{key, values}` naming a call for the step list in the panel. */
export function stepLabel(name, args, reader) {
  const day = args?.day ? reader.findDay(args.day) : null;
  const number = day ? reader.days('count').findIndex((entry) => entry.id === day.id) + 1 : null;
  switch (name) {
    case 'get_day': return { key: number ? 'assistant.step.day' : 'assistant.step.days', values: { n: number } };
    case 'get_weather': return { key: number ? 'assistant.step.weatherDay' : 'assistant.step.weather', values: { n: number } };
    case 'search_map': return { key: 'assistant.step.search', values: { query: clip(args?.query, 60) ?? '' } };
    case 'get_lists': return { key: args?.kind === 'todo' ? 'assistant.step.todos' : 'assistant.step.packing', values: {} };
    default: return { key: toolByName(name)?.kind === 'read' ? `assistant.step.${name}` : name.startsWith('propose_') ? 'assistant.step.propose' : 'assistant.step.other', values: {} };
  }
}

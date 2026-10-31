import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataStops, followRouteLink, parseData, parseRouteLink } from '../../src/lib/route-import/google.js';
import { routeDrafts } from '../../src/lib/route-import/plan.js';
import { lodgingLinks } from '../../src/lib/route-import/lodging.js';
import { openRouteImport } from '../../src/views/trip/plan/route-import/index.js';
import { createSelectors } from '../../src/lib/store/query.js';

const STOP = (id, lng, lat) => `!1m5!1m1!1s0x${id}:0x${id}!2m2!1d${lng}!2d${lat}`;
const DATA = `!3m1!4b1!4m20!4m19${STOP('a1', -9.1393366, 38.7222524)}${STOP('b2', -9.3817, 38.8029)}${STOP('c3', -9.4215, 38.6979)}!3e0`;
const DIR = `https://www.google.com/maps/dir/Lisbon,+Portugal/Sintra/Cascais/@38.75,-9.3,11z/data=${DATA}`;
let n = 0;
const makeId = () => `ab${String(++n).padStart(14, '0')}`;
afterEach(() => document.body.replaceChildren());

describe('reading Google Maps directions links', () => {
  it('parses the data blob as a tree of counted messages', () => {
    const tree = parseData('!1m3!1m1!1sx!2b1!3e2');
    expect(tree).toEqual([{ field: 1, type: 'm', value: '3', children: [{ field: 1, type: 'm', value: '1', children: [{ field: 1, type: 's', value: 'x' }] }, { field: 2, type: 'b', value: '1' }] }, { field: 3, type: 'e', value: '2' }]);
    expect(dataStops(DATA)).toEqual({ mode: 'drive', stops: [
      { point: { lat: 38.722252, lng: -9.139337 }, vias: [] }, { point: { lat: 38.8029, lng: -9.3817 }, vias: [] }, { point: { lat: 38.6979, lng: -9.4215 }, vias: [] },
    ] });
  });

  it('takes stop names from the path and coordinates from the data, in order', () => {
    expect(parseRouteLink(DIR)).toEqual({ mode: 'drive', vias: [], stops: [
      { name: 'Lisbon, Portugal', lat: 38.722252, lng: -9.139337 }, { name: 'Sintra', lat: 38.8029, lng: -9.3817 }, { name: 'Cascais', lat: 38.6979, lng: -9.4215 },
    ] });
  });

  it('keeps dragged route points with the stop they follow', () => {
    const via = '!1m10!1m1!1s0xa1:0xa1!2m2!1d-9.1393!2d38.7222!3m4!1m2!1d-9.25!2d38.75!3s0x0:0x0';
    const link = `https://www.google.com/maps/dir/Lisbon/Sintra/data=!4m14!4m13${via}!1m0!3e1`;
    const parsed = parseRouteLink(link);
    expect(parsed.mode).toBe('bike');
    expect(parsed.stops).toEqual([{ name: 'Lisbon', lat: 38.7222, lng: -9.1393 }, { name: 'Sintra' }]);
    expect(parsed.vias).toEqual([{ lat: 38.75, lng: -9.25, after: 0 }]);
  });

  it('reads the URL scheme, the older form and coordinates in the path', () => {
    expect(parseRouteLink('https://www.google.com/maps/dir/?api=1&origin=Porto&destination=Braga&waypoints=Guimar%C3%A3es|41.5,-8.4&travelmode=walking')).toEqual({
      mode: 'walk', vias: [], stops: [{ name: 'Porto' }, { name: 'Guimarães' }, { lat: 41.5, lng: -8.4 }, { name: 'Braga' }],
    });
    expect(parseRouteLink('https://maps.google.com/maps?saddr=Faro&daddr=Lagos+to:Sagres&dirflg=d').stops).toEqual([{ name: 'Faro' }, { name: 'Lagos' }, { name: 'Sagres' }]);
    expect(parseRouteLink('https://www.google.com/maps/dir/38.7,-9.1/38.8,-9.3/').stops).toEqual([{ lat: 38.7, lng: -9.1 }, { lat: 38.8, lng: -9.3 }]);
  });

  it('refuses other links and single stops, and asks to follow short links', () => {
    expect(parseRouteLink('https://www.google.com/maps/dir/Lisbon/')).toBeNull();
    expect(parseRouteLink('https://evil.example/maps/dir/A/B')).toBeNull();
    expect(parseRouteLink('not a link')).toBeNull();
    expect(parseRouteLink('https://maps.app.goo.gl/abc123')).toEqual({ short: 'https://maps.app.goo.gl/abc123' });
  });

  it('follows a short link by its Location header only', async () => {
    const fetch = vi.fn(async () => ({ headers: new Headers({ location: DIR }) }));
    const route = await followRouteLink('https://maps.app.goo.gl/abc123', fetch);
    expect(route.stops).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await followRouteLink('https://maps.app.goo.gl/x', async () => ({ headers: new Headers() }))).toBeNull();
  });
});

describe('route writes', () => {
  const stops = [{ name: 'Lisbon', lat: 38.72, lng: -9.14 }, { name: 'Sintra', lat: 38.8, lng: -9.38 }, { name: 'Nowhere' }, { name: 'Cascais', lat: 38.7, lng: -9.42 }];
  it('adds places and visits in order, reusing the trip’s own places', () => {
    const { drafts, reused, created } = routeDrafts({ stops, dayId: 'dddddddddddddddd', mode: 'drive', after: 'a5', makeId,
      places: [{ id: 'pppppppppppppppp', name: 'Sintra', lat: 38.8001, lng: -9.3801 }] });
    expect([reused, created]).toEqual([1, 2]);
    const visits = drafts.filter((draft) => draft.t === 'visit').map((draft) => draft.put);
    expect(visits.map((visit) => visit.legMode)).toEqual(['drive', 'drive', undefined]);
    expect(visits[1].placeId).toBe('pppppppppppppppp');
    expect(visits.every((visit, index) => visit.order > 'a5' && (index === 0 || visit.order > visits[index - 1].order))).toBe(true);
    expect(drafts.filter((draft) => draft.t === 'place').map((draft) => draft.put.name)).toEqual(['Lisbon', 'Cascais']);
  });

  it('moves route points to the previous kept stop and needs road-trip mode', () => {
    const vias = [{ lat: 38.75, lng: -9.3, after: 2 }, { lat: 38.71, lng: -9.4, after: 3 }];
    const withRoad = routeDrafts({ stops, vias, dayId: 'dddddddddddddddd', roadtrip: true, reuse: false, makeId });
    const visits = withRoad.drafts.filter((draft) => draft.t === 'visit');
    const points = withRoad.drafts.filter((draft) => draft.t === 'via');
    expect(points).toHaveLength(1);
    expect(points[0].put.after).toBe(visits[1].id);
    expect(routeDrafts({ stops, vias, dayId: 'dddddddddddddddd', makeId }).drafts.some((draft) => draft.t === 'via')).toBe(false);
  });
});

describe('lodging links', () => {
  it('prefills the place, dates and guests', () => {
    const links = lodgingLinks({ lat: 38.7, lng: -9.14, name: 'Lisbon', checkIn: '2027-05-01', checkOut: '2027-05-02', adults: 3 });
    expect(links.map((link) => link.id)).toEqual(['booking', 'airbnb', 'maps']);
    const booking = new URL(links[0].url);
    expect(booking.searchParams.get('checkin')).toBe('2027-05-01');
    expect(booking.searchParams.get('group_adults')).toBe('3');
    expect(new URL(links[1].url).searchParams.get('adults')).toBe('3');
    expect(links[2].url).toBe('https://www.google.com/maps/search/hotels/@38.70000,-9.14000,13z');
  });
  it('drops dates out of order and refuses no location', () => {
    expect(new URL(lodgingLinks({ lat: 1, lng: 2, checkIn: '2027-05-02', checkOut: '2027-05-01' })[0].url).searchParams.has('checkin')).toBe(false);
    expect(lodgingLinks({})).toEqual([]);
  });
});

describe('route import dialog', () => {
  function stubSpace() {
    const store = new Map([['day', [{ id: 'dddddddddddddddd', date: '2027-05-01', order: 'a' }]], ['visit', []], ['place', []], ['dayNote', []], ['res', []]]);
    const list = (type) => store.get(type) ?? [];
    const applied = [];
    return {
      applied,
      select: createSelectors({ kind: 'trip', source: list, get: (type, id) => list(type).find((item) => item.id === id), subscribe: () => () => {} }),
      get: () => ({ settings: {} }), can: () => true,
      ops: { create: (t, put, { id }) => ({ t, id, put }) },
      history: { undo: async () => {} },
      async apply(ops) { applied.push(...ops); for (const op of ops) store.set(op.t, [...list(op.t), { id: op.id, ...op.put }]); },
    };
  }

  it('reads a pasted link, looks up named stops and adds them', async () => {
    const space = stubSpace();
    const search = vi.fn(async () => ({ data: [{ name: 'Sintra', lat: 38.8, lng: -9.38 }] }));
    openRouteImport({ space, session: { services: { geocode: { search } } }, puter: {} });
    const dialog = document.querySelector('[role=dialog]');
    const input = dialog.querySelector('input[type=url]');
    input.value = 'https://www.google.com/maps/dir/38.72,-9.14/Sintra/';
    dialog.querySelector('form').requestSubmit();
    await vi.waitFor(() => expect(dialog.querySelectorAll('.route-import-stop')).toHaveLength(2));
    await vi.waitFor(() => expect(search).toHaveBeenCalled());
    const add = [...dialog.querySelectorAll('button')].find((node) => node.textContent.startsWith('Add '));
    await vi.waitFor(() => expect(add.disabled).toBe(false));
    add.click();
    await vi.waitFor(() => expect(space.applied.filter((op) => op.t === 'visit')).toHaveLength(2));
    expect(space.applied.filter((op) => op.t === 'place').map((op) => op.put.name)).toEqual(['Stop 1', 'Sintra']);
  });
});

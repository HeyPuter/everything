import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupStops, nameStops, photoDayDrafts, placeOnDays, validNames } from '../../src/lib/photos/days.js';
import { openPhotoDays } from '../../src/views/trip/plan/photo-days/index.js';
import { createSelectors } from '../../src/lib/store/query.js';
import { exifJpeg } from './helpers/exif-jpeg.js';

const photo = (date, time, lat, lng) => ({ taken: { date, ...(time ? { time } : {}) }, ...(lat !== undefined ? { lat, lng } : {}) });
let n = 0;
const makeId = () => `ab${String(++n).padStart(14, '0')}`;
afterEach(() => document.body.replaceChildren());

describe('grouping photos into stops', () => {
  it('splits by day, time gaps and distance, and keeps untimed photos with their day', () => {
    const { stops, skipped } = groupStops([
      photo('2026-06-01', '10:00', 38.7139, -9.1394), photo('2026-06-01', '10:40', 38.7141, -9.1390),
      photo('2026-06-01', '11:00', 38.6916, -9.2160),
      photo('2026-06-01', '15:00', 38.6917, -9.2161),
      photo('2026-06-01', null),
      photo('2026-06-02', '09:00'),
      { taken: null }, { name: 'no exif' },
    ]);
    expect(skipped).toBe(2);
    expect(stops.map((stop) => [stop.date, stop.start, stop.end, stop.photos.length])).toEqual([
      ['2026-06-01', '10:00', '10:40', 3], ['2026-06-01', '11:00', '11:00', 1], ['2026-06-01', '15:00', '15:00', 1], ['2026-06-02', '09:00', '09:00', 1],
    ]);
    expect(stops[0].lat).toBeCloseTo(38.714, 3);
    expect(stops[3].lat).toBeUndefined();
  });
});

describe('placing stops on days', () => {
  const stops = [{ date: '2026-06-01' }, { date: '2026-06-03' }, { date: '2026-06-09' }];
  it('uses the dates of a dated trip and lists the rest as outside', () => {
    const plan = placeOnDays(stops, [{ id: 'd1', date: '2026-06-01' }, { id: 'd2', date: '2026-06-02' }, { id: 'd3', date: '2026-06-03' }]);
    expect(plan.days.map((entry) => [entry.date, entry.dayId])).toEqual([['2026-06-01', 'd1'], ['2026-06-03', 'd3']]);
    expect(plan.outside).toHaveLength(1);
  });
  it('fills an undated trip in date order and counts the days to add', () => {
    const plan = placeOnDays(stops, [{ id: 'd1', date: null }]);
    expect(plan.days.map((entry) => entry.dayId)).toEqual(['d1', null, null]);
    expect(plan.extra).toBe(2);
  });
});

describe('drafts', () => {
  it('adds undated days, places and timed visits, reusing trip places', () => {
    const plan = { days: [
      { date: '2026-06-01', dayId: 'dddddddddddddd01', stops: [{ date: '2026-06-01', start: '10:00', end: '10:40', lat: 38.7, lng: -9.1, name: 'Belém Tower', cat: 'attraction' }, { date: '2026-06-01', name: 'No place' }] },
      { date: '2026-06-02', dayId: null, stops: [{ date: '2026-06-02', start: '09:00', end: '09:00', lat: 38.8, lng: -9.38, name: '' }] },
    ] };
    const { drafts, created, reused } = photoDayDrafts({ plan, places: [{ id: 'pppppppppppppppp', name: 'Belém Tower', lat: 38.7001, lng: -9.1001 }], ends: new Map([['dddddddddddddd01', 'a5']]), lastDay: 'b', makeId, fallbackName: 'Stop' });
    expect([created, reused]).toEqual([1, 1]);
    const day = drafts.find((draft) => draft.t === 'day');
    expect(day.put).toMatchObject({ date: null });
    expect(day.put.order > 'b').toBe(true);
    const visits = drafts.filter((draft) => draft.t === 'visit').map((draft) => draft.put);
    expect(visits[0]).toMatchObject({ dayId: 'dddddddddddddd01', placeId: 'pppppppppppppppp', start: '10:00', end: '10:40' });
    expect(visits[0].order > 'a5').toBe(true);
    expect(visits[1]).toMatchObject({ dayId: day.id, start: '09:00' });
    expect(visits[1].end).toBeUndefined();
    expect(drafts.find((draft) => draft.t === 'place').put).toMatchObject({ name: 'Stop', src: 'photos' });
  });
});

describe('AI names', () => {
  it('keeps only valid indexes, plain names and known categories', () => {
    const names = validNames({ stops: [{ index: 0, name: ' <b>Belém</b>  Tower ', category: 'attraction' }, { index: 0, name: 'again' }, { index: 7, name: 'x' }, { index: 1, name: 'Café', category: 'evil' }, { index: 2, name: '' }] },
      { count: 3, categories: ['attraction'] });
    expect([...names]).toEqual([[0, { name: 'b Belém /b Tower', cat: 'attraction' }], [1, { name: 'Café' }]]);
  });

  it('asks the model with the stops as data and reads fenced JSON', async () => {
    const chat = vi.fn(async () => ({ message: { content: '```json\n{"stops":[{"index":0,"name":"Sintra Palace","category":"attraction"}]}\n```' } }));
    const names = await nameStops({ chat, model: 'quick', stops: [{ date: '2026-06-01', start: '10:00', lat: 38.79712, lng: -9.39, name: 'Sintra', photos: [1, 2] }], categories: ['attraction'] });
    expect(names.get(0)).toEqual({ name: 'Sintra Palace', cat: 'attraction' });
    const [messages, options] = chat.mock.calls[0];
    expect(JSON.parse(messages[1].content)).toEqual([{ index: 0, date: '2026-06-01', from: '10:00', to: null, photos: 2, near: 'Sintra', lat: 38.797, lng: -9.39 }]);
    expect(options).toMatchObject({ model: 'quick', outputFormat: { type: 'json_schema' } });
    await expect(nameStops({ chat: async () => { throw Object.assign(new Error('x'), { status: 402 }); }, stops: [] })).rejects.toMatchObject({ code: 'credit' });
    await expect(nameStops({ chat: async () => 'not json', stops: [] })).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('the dialog', () => {
  it('reads drive photos, names the stop and adds it to its day', async () => {
    const store = new Map([['day', [{ id: 'dddddddddddddddd', date: '2027-05-02', order: 'a' }]], ['visit', []], ['place', []], ['dayNote', []], ['res', []]]);
    const list = (type) => store.get(type) ?? [];
    const applied = [];
    const space = {
      ref: { w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' },
      select: createSelectors({ kind: 'trip', source: list, get: (type, id) => list(type).find((item) => item.id === id), subscribe: () => () => {} }),
      can: () => true, ops: { create: (t, put, { id }) => ({ t, id, put }) },
      async apply(ops) { applied.push(...ops); },
    };
    const kv = { update: vi.fn(async () => true) };
    const saved = {};
    const puter = {
      kv,
      ui: { showOpenFilePicker: async () => [{ name: 'a.jpg', uid: 'u1', path: '/me/a.jpg' }, { name: 'b.jpg', uid: 'u2', path: '/me/b.jpg' }] },
      fs: { read: async (path) => new Blob([exifJpeg({ date: path.endsWith('a.jpg') ? '2027:05:02 10:00:00' : '2027:05:02 10:30:00' })]) },
    };
    const personal = { get: async (key) => saved[key] ?? null, set: async (key, value) => { saved[key] = value; } };
    const reverse = vi.fn(async () => ({ data: [{ name: 'Belém' }] }));
    openPhotoDays({ space, puter, personal, session: { services: { geocode: { reverse } } } });
    const dialog = document.querySelector('[role=dialog]');
    [...dialog.querySelectorAll('button')].find((node) => node.textContent === 'Choose photos in my drive').click();
    await vi.waitFor(() => expect(dialog.querySelectorAll('.photo-days-stop')).toHaveLength(1));
    expect(dialog.querySelector('.photo-days-stop input.input').value).toBe('Belém');
    const add = [...dialog.querySelectorAll('button')].find((node) => node.textContent === 'Add 1 stops');
    add.click();
    await vi.waitFor(() => expect(applied.filter((op) => op.t === 'visit')).toHaveLength(1));
    expect(applied.find((op) => op.t === 'visit').put).toMatchObject({ dayId: 'dddddddddddddddd', start: '10:00', end: '10:30' });
    await vi.waitFor(() => expect(Object.keys(saved['me:photos:0000000000000001']?.items ?? {})).toHaveLength(2));
  });
});

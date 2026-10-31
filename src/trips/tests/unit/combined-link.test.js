import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanJourneyLink, journeyCard, journeyRoute } from '../../src/views/public/combined/index.js';
import { cleanProjection } from '../../src/views/public/data.js';
import { combinedFields, journeyChoices } from '../../src/views/trip/members/share/combined/index.js';
import { ROAD_PREFS_ID } from '../../src/shared/schema/trip.js';

const LINK = { w: 'trips-bcdefghijk', s: '0000000000000001', token: 'd'.repeat(32) };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => document.body.replaceChildren());

describe('journey link in a trip projection', () => {
  it('accepts only well-formed links', () => {
    expect(cleanJourneyLink(LINK)).toEqual(LINK);
    expect(cleanJourneyLink({ ...LINK, w: 'evil.example' })).toBeNull();
    expect(cleanJourneyLink({ ...LINK, token: 'x' })).toBeNull();
    expect(cleanJourneyLink(null)).toBeNull();
    expect(journeyRoute(LINK)).toBe(`#/s/${LINK.w}/${LINK.s}/${LINK.token}`);
  });

  it('keeps road entities, the road-trip flag and the journey link', () => {
    const projection = cleanProjection({ ok: true, share: { plan: true, road: true }, meta: { title: 'T', currency: 'EUR', settings: { addons: { roadtrip: true, other: 1 } } }, journey: LINK, ents: [
      { t: 'rtPrefs', id: ROAD_PREFS_ID, fuel: 'electric' },
      { t: 'rtPrefs', id: '0000000000000002', fuel: 'electric' },
      { t: 'dayEnd', id: '0000000000000003', day: '0000000000000004', fromVisit: '0000000000000005', toVisit: '0000000000000006', fraction: 2 },
      { t: 'via', id: '0000000000000007', dayId: '0000000000000004', after: '0000000000000005', order: 'a', lat: 1, lng: 2 },
    ] });
    expect(projection.share.road).toBe(true);
    expect(projection.meta.settings).toEqual({ addons: { roadtrip: true } });
    expect(projection.journey).toEqual(LINK);
    expect(projection.ents.map((entity) => entity.t)).toEqual(['rtPrefs', 'via']);
  });
});

describe('share settings for the road trip and a journey', () => {
  const space = (roadtrip) => ({ get: () => ({ settings: { addons: { roadtrip } } }) });
  const db = (records) => ({ get: async (key) => records[key] ?? null });
  const personal = { spaces: { list: async () => [
    { ref: { w: LINK.w, s: LINK.s, k: 'journey' }, title: 'Japan diary' },
    { ref: { w: LINK.w, s: '0000000000000009', k: 'journey' }, title: 'Not here' },
    { ref: { w: LINK.w, s: '0000000000000008', k: 'trip' }, title: 'A trip' },
  ] } };
  const session = { personal, db: db({ [`share:${LINK.w}:${LINK.s}`]: { token: LINK.token, since: 1 }, [`share:${LINK.w}:0000000000000008`]: { token: 'e'.repeat(32) } }) };

  it('lists journeys whose link this device made', async () => {
    expect(await journeyChoices(session)).toEqual([{ ref: { w: LINK.w, s: LINK.s, k: 'journey' }, title: 'Japan diary', token: LINK.token }]);
  });

  it('offers the road trip only with road-trip mode and the itinerary', async () => {
    const change = vi.fn();
    const off = combinedFields({ space: space(false), share: { plan: true }, disabled: false, change, session });
    expect(off.querySelector('[data-focus="share:road"]')).toBeNull();
    const noPlan = combinedFields({ space: space(true), share: { plan: false }, disabled: false, change, session });
    expect(noPlan.querySelector('[data-focus="share:road"]').disabled).toBe(true);
    const node = combinedFields({ space: space(true), share: { plan: true }, disabled: false, change, session });
    document.body.append(node);
    const road = node.querySelector('[data-focus="share:road"]');
    road.checked = true; road.dispatchEvent(new Event('change'));
    expect(change).toHaveBeenCalledWith({ road: true });
    await tick(); await tick();
    const select = node.querySelector('[data-focus="share:journey"]');
    expect(select.disabled).toBe(false);
    select.value = '0'; select.dispatchEvent(new Event('change'));
    expect(change).toHaveBeenCalledWith({ journey: LINK });
  });

  it('removes an attached journey', () => {
    const change = vi.fn();
    const node = combinedFields({ space: space(false), share: { plan: true, journey: true }, disabled: false, change, session });
    node.querySelector('[data-focus="share:journeyOff"]').click();
    expect(change).toHaveBeenCalledWith({ journey: null });
  });
});

describe('journey card in the trip viewer', () => {
  const respond = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  it('shows the journey from its own link and opens it', async () => {
    const exec = vi.fn(async () => respond(200, { ok: true, kind: 'journey', meta: { title: 'Japan diary', status: 'completed' }, files: [], ents: [
      { t: 'entry', id: '0000000000000011', type: 'moment', title: 'Arrived', date: '2027-04-01', order: 'a' },
      { t: 'entry', id: '0000000000000012', type: 'moment', title: 'Temples', date: '2027-04-03', order: 'b' },
    ] }));
    const card = journeyCard({ link: LINK, puter: { workers: { exec } } });
    await vi.waitFor(() => expect(card.textContent).not.toContain('Loading'));
    expect(exec.mock.calls[0][0]).toBe(`https://${LINK.w}.puter.work/pub/${LINK.s}/${LINK.token}`);
    expect(card.textContent).toContain('Japan diary');
    expect(card.textContent).toContain('Completed · 2 entries');
    expect(card.querySelector('a').getAttribute('href')).toBe(journeyRoute(LINK));
  });

  it('says when the journey link stopped working', async () => {
    const card = journeyCard({ link: LINK, puter: { workers: { exec: async () => respond(404, { code: 'not_found' }) } } });
    await vi.waitFor(() => expect(card.textContent).not.toContain('Loading'));
    expect(card.textContent).toContain('no longer works');
  });
});

describe('road trip in the trip viewer', () => {
  it('mounts the road-trip view read-only over the projection', async () => {
    const { readOnlySpace } = await import('../../src/views/public/data.js');
    const { mountPublicRoad } = await import('../../src/views/public/combined/index.js');
    const { createPlanState } = await import('../../src/views/trip/plan/state.js');
    const projection = cleanProjection({ ok: true, share: { plan: true, road: true }, meta: { title: 'T', currency: 'EUR', start: '2027-05-01', end: '2027-05-02', settings: { addons: { roadtrip: true } } }, ents: [
      { t: 'day', id: '0000000000000004', date: '2027-05-01', order: 'a' },
      { t: 'place', id: '0000000000000021', name: 'Lisbon', lat: 38.72, lng: -9.14 },
      { t: 'place', id: '0000000000000022', name: 'Porto', lat: 41.15, lng: -8.61 },
      { t: 'visit', id: '0000000000000005', dayId: '0000000000000004', placeId: '0000000000000021', order: 'a' },
      { t: 'visit', id: '0000000000000006', dayId: '0000000000000004', placeId: '0000000000000022', order: 'b' },
      { t: 'rtPrefs', id: ROAD_PREFS_ID, fuel: 'petrol', start: '08:00', end: '19:00' },
    ] });
    const space = readOnlySpace(projection, { w: LINK.w, s: '0000000000000031', k: 'trip' });
    const slot = document.createElement('div');
    document.body.append(slot);
    const controller = new AbortController();
    const destroy = await mountPublicRoad(slot, { space, plan: createPlanState(), services: null, signal: controller.signal });
    expect(slot.querySelector('.road')).not.toBeNull();
    expect(slot.textContent).toContain('Porto');
    expect(slot.querySelector('[data-drag-handle]')).toBeNull();
    controller.abort();
    destroy();
  });
});

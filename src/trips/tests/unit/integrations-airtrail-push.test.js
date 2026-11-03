import { afterEach, describe, expect, it } from 'vitest';
import { airtrailClient, flightDraft, ownedHash, planFlightSync } from '../../src/lib/integrations/airtrail.js';
import { createFlight, flightPayload, isoPoint, pushBooking, pushedIds, pushedSrc, pushPlan, updateFlight } from '../../src/lib/integrations/airtrail-push.js';
import { pushSection } from '../../src/views/integrations/push/index.js';
import { validateEntity } from '../../src/shared/schema/index.js';
import { fakeNet } from './helpers/fake-net.js';

const config = { url: 'https://air.example.com', key: 'secret-key' };
const leg = (extra = {}) => ({ from: { code: 'LIS', tz: 'Europe/Lisbon' }, to: { code: 'FRA', tz: 'Europe/Berlin' }, dep: { date: '2027-03-28', time: '07:00' }, arr: { date: '2027-03-28', time: '11:00' }, carrier: 'TAP', number: 'TP572', seat: '3C', cls: 'Economy', ...extra });
const flight = (extra = {}) => ({ id: '0000000000000001', type: 'flight', title: 'LIS → FRA', status: 'confirmed', legs: [leg()], notes: 'Aisle', ...extra });
afterEach(() => { localStorage.clear(); document.body.replaceChildren(); });

describe('what can be sent', () => {
  it('sorts flights into new, edited since sending and blocked', () => {
    const sent = flight({ id: '0000000000000002' });
    sent.src = pushedSrc(sent, ['91']);
    const edited = { ...sent, id: '0000000000000003', notes: 'Window', src: sent.src };
    const legsChanged = { ...edited, id: '0000000000000004', legs: [leg(), leg({ from: { code: 'FRA' }, to: { code: 'JFK' } })] };
    const imported = flight({ id: '0000000000000005', src: { kind: 'airtrail', ext: '55', hash: 'x' } });
    const plan = pushPlan([flight(), sent, edited, legsChanged, imported, flight({ id: '0000000000000006', legs: [leg({ to: { name: 'Somewhere' } })] }),
      flight({ id: '0000000000000007', status: 'cancelled' }), { id: '0000000000000008', type: 'train', legs: [leg()] }]);
    expect(plan.add.map((entry) => entry.res.id)).toEqual(['0000000000000001']);
    expect(plan.update.map((entry) => [entry.res.id, entry.ids])).toEqual([['0000000000000003', ['91']]]);
    expect(plan.blocked.map((entry) => [entry.res.id, entry.reason])).toEqual([['0000000000000004', 'legs'], ['0000000000000006', 'codes']]);
    expect(pushedIds(imported)).toBeNull();
    expect(pushedIds(sent)).toEqual(['91']);
  });

  it('keeps a valid src on the booking', () => {
    const res = flight();
    const { id: _id, ...fields } = res;
    expect(() => validateEntity('trip', 'res', { ...fields, src: pushedSrc(res, ['91', '92']) })).not.toThrow();
    expect(pushedSrc(res, ['91']).hash).toBe(ownedHash(res));
  });
});

describe('flight payloads', () => {
  it('writes local times with the airport offset, across DST', () => {
    expect(isoPoint({ date: '2027-03-28', time: '07:00' }, 'Europe/Lisbon')).toBe('2027-03-28T07:00:00+01:00');
    expect(isoPoint({ date: '2027-03-27', time: '07:00' }, 'Europe/Lisbon')).toBe('2027-03-27T07:00:00+00:00');
    expect(isoPoint({ date: '2027-07-01', time: '18:30' }, 'America/New_York')).toBe('2027-07-01T18:30:00-04:00');
    expect(isoPoint({ date: '2027-07-01' }, null)).toBe('2027-07-01T00:00:00');
    expect(isoPoint({}, 'UTC')).toBeNull();
  });

  it('maps one leg to one flight', () => {
    expect(flightPayload(flight(), leg(), { me: 'u-1' })).toEqual({
      from: 'LIS', to: 'FRA', date: '2027-03-28', departure: '2027-03-28T07:00:00+01:00', arrival: '2027-03-28T11:00:00+02:00',
      airline: 'TAP', flightNumber: 'TP572', note: 'Aisle', seats: [{ userId: 'u-1', guestName: null, seat: null, seatNumber: '3C', seatClass: 'Economy' }],
    });
    expect(flightPayload(flight(), leg({ arr: { date: '2027-03-28' } })).arrival).toBeNull();
    expect(() => flightPayload(flight(), leg({ from: { name: 'x' } }))).toThrow();
  });
});

describe('sending', () => {
  it('creates through v1 and falls back to the older save route', async () => {
    const v1 = fakeNet({ 'POST /api/v1/flights': () => ({ json: { data: { id: 91 } } }) });
    expect(await createFlight(airtrailClient(v1.puter, config), { from: 'LIS' })).toBe('91');
    expect(v1.calls[0]).toMatchObject({ method: 'POST', body: { from: 'LIS' } });
    const legacy = fakeNet({ 'POST /api/flight/save': () => ({ json: { id: 'abc' } }) });
    expect(await createFlight(airtrailClient(legacy.puter, config), { from: 'LIS' })).toBe('abc');
    expect(legacy.calls.map((call) => call.url.pathname)).toEqual(['/api/v1/flights', '/api/flight/save']);
    const broken = fakeNet({ 'POST /api/v1/flights': () => ({ json: { ok: true } }) });
    await expect(createFlight(airtrailClient(broken.puter, config), {})).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('updates by id with the same fallback', async () => {
    const v1 = fakeNet({ 'PATCH /api/v1/flights/91': () => ({ json: { ok: true } }) });
    await updateFlight(airtrailClient(v1.puter, config), '91', { from: 'LIS' });
    expect(v1.calls[0].method).toBe('PATCH');
    const legacy = fakeNet({ 'POST /api/flight/save': () => ({ json: { id: '91' } }) });
    await updateFlight(airtrailClient(legacy.puter, config), '91', { from: 'LIS' });
    expect(legacy.calls[1].body).toEqual({ from: 'LIS', id: '91' });
    await expect(updateFlight(airtrailClient(v1.puter, config), '../x', {})).rejects.toMatchObject({ code: 'rejected' });
  });

  it('resumes a booking without making its flights twice', async () => {
    let n = 0;
    const net = fakeNet({ 'POST /api/v1/flights': () => (++n === 2 ? { status: 500, json: {} } : { json: { id: `f${n}` } }) });
    const client = airtrailClient(net.puter, config);
    const res = flight({ legs: [leg(), leg({ from: { code: 'FRA' }, to: { code: 'JFK' } })] });
    const done = [];
    await expect(pushBooking(client, { res }, { done })).rejects.toMatchObject({ code: 'server_error' });
    expect(done).toEqual(['f1']);
    const src = await pushBooking(client, { res }, { done });
    expect(src.ext).toBe('p:f1,f3');
    expect(net.calls.filter((call) => call.method === 'POST')).toHaveLength(3);
  });

  it('keeps sent bookings out of later pulls', () => {
    const res = flight();
    res.src = pushedSrc(res, ['91', '92']);
    const draft = (id) => flightDraft({ id, from: 'LIS', to: 'FRA', date: '2027-03-28', departure: '2027-03-28T07:00:00+01:00' });
    const plan = planFlightSync([draft('91'), draft('92'), draft('93')], [res], { start: '2027-03-27', end: '2027-03-30' });
    expect(plan.unchanged).toBe(2);
    expect(plan.update).toEqual([]);
    expect(plan.add.map((entry) => entry.draft.ext)).toEqual(['93']);
  });
});

describe('send section', () => {
  function stubSpace(list) {
    const items = new Map(list.map((res) => [res.id, { ...res, v: 'v1' }]));
    const applied = [];
    return {
      ref: { w: 'trips-abcdefghij', s: '0000000000000009' }, applied,
      select: { res: { all: () => [...items.values()] } },
      get: (_t, id) => items.get(id) ?? null,
      ops: { patch: (t, id, patch) => ({ t, id, ...patch }) },
      async apply(ops) { for (const op of ops) { items.set(op.id, { ...items.get(op.id), ...op.set }); applied.push(op); } },
    };
  }

  it('sends the chosen flights and marks them as sent', async () => {
    const net = fakeNet({ 'GET /api/v1/me': () => ({ json: { data: { id: 'u-1' } } }), 'POST /api/v1/flights': () => ({ json: { id: '91' } }) });
    const space = stubSpace([flight()]);
    const node = pushSection({ space, puter: net.puter, config });
    document.body.append(node);
    const box = node.querySelector('input[type=checkbox]');
    expect(box.checked).toBe(false);
    box.checked = true; box.dispatchEvent(new Event('change'));
    [...node.querySelectorAll('button')].find((item) => item.textContent === 'Send 1 flight').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(space.applied[0].set.src).toMatchObject({ kind: 'airtrail', ext: 'p:91' });
    expect(net.calls.find((call) => call.method === 'POST').body.seats[0].userId).toBe('u-1');
    expect(localStorage.length).toBe(0);
  });

  it('is absent when there is nothing to send', () => {
    expect(pushSection({ space: stubSpace([]), puter: fakeNet().puter, config })).toBeNull();
  });
});

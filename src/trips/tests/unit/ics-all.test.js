import { beforeEach, describe, expect, it, vi } from 'vitest';
import { calendarComponents, mergeCalendars } from '../../src/lib/ics/merge.js';
import { tripCalendar, tripEvents } from '../../src/lib/ics/index.js';
import { allFeedLinks, feedCandidates, feedChanges, isAllFeedPath, scopedToken } from '../../src/lib/ics/all.js';
import { syncAllTripsFeed, updateAllTripsFeed } from '../../src/views/ics/all/index.js';

const W1 = 'trips-abcdefghij';
const W2 = 'trips-zzzzzzzzzz';
const ME = '11111111-1111-4111-8111-111111111111';
const trip = (s, fields = {}) => ({ ref: { w: W1, s, k: 'trip' }, role: 'owner', title: `Trip ${s.slice(-1)}`, ...fields });

describe('merging calendars', () => {
  const lisbon = tripCalendar({ meta: { title: 'Lisbon', start: '2027-05-01', end: '2027-05-03', reminderDays: [1] }, day: [], visit: [
    { id: 'v1', dayId: 'd1', placeId: 'p1', order: 'a', start: '10:00' },
  ], day2: [], place: [{ id: 'p1', name: 'Belém, Tower', tz: 'Europe/Lisbon' }], res: [], todo: [], listMeta: [] }, { space: 's1', stamp: 0 });

  it('keeps components as written, with nested alarms and folded lines', () => {
    const parts = calendarComponents(lisbon);
    expect(parts.events).toHaveLength(1);
    expect(parts.events[0].join('\n')).toContain('BEGIN:VALARM');
    expect(calendarComponents('not a calendar').events).toEqual([]);
    expect(calendarComponents('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\n').events).toEqual([]);
  });

  it('merges events, skips repeated UIDs and keeps one zone per TZID', () => {
    const zoned = (uid) => `BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Lisbon\r\nBEGIN:STANDARD\r\nTZOFFSETTO:+0000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${uid}\r\nDTSTART;TZID=Europe/Lisbon:20270501T100000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const { text, events } = mergeCalendars([zoned('a'), zoned('b'), zoned('a'), 'garbage', lisbon], { name: 'All, my trips', refresh: 60 });
    expect(events).toBe(3);
    expect(text.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1);
    expect(text.match(/UID:a\r\n/g)).toHaveLength(1);
    expect(text).toContain('X-WR-CALNAME:All\\, my trips');
    expect(text).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H');
    expect(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0')).toBe(true);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('writes IANA zones itself, so a feed cannot redefine a zone other trips use', () => {
    const remote = 'BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Paris\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+1400\r\nTZOFFSETTO:+1400\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n'
      + 'BEGIN:VEVENT\r\nUID:evil\r\nDTSTART;TZID=Europe/Paris:20270601T100000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const mine = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:mine\r\nDTSTART;TZID=Europe/Paris:20270602T090000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const { text } = mergeCalendars([remote, mine]);
    expect(text).not.toContain('+1400');
    expect(text).toContain('TZID:Europe/Paris');
    expect(text).toContain('TZOFFSETTO:+0200');
  });

  it('drops a component that ends something it never began, so a feed cannot close the calendar early', () => {
    const remote = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:evil\r\nSUMMARY:x\r\nEND:VCALENDAR\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:nested\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const mine = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:mine\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const { text, events } = mergeCalendars([remote, mine]);
    expect(events).toBe(1);
    expect(text.match(/END:VCALENDAR/g)).toHaveLength(1);
    expect(text).toContain('UID:mine');
    expect(text).not.toContain('UID:evil');
  });
});

describe('payment due events', () => {
  const data = (extra = {}) => ({ meta: { title: 'T', settings: {} }, exp: [
    { id: 'e1', name: 'Hotel', amount: 90000, currency: 'EUR', payers: [{ who: ME, amount: 30000 }], due: '2027-04-01', upd: 1 },
    { id: 'e2', name: 'Paid', amount: 100, currency: 'EUR', payers: [{ who: ME, amount: 100 }], due: '2027-04-02' },
    { id: 'e3', name: 'Later', amount: 5000, currency: 'JPY', payers: [], due: '2027-04-03' },
    { id: 'e4', name: 'No date', amount: 5000, currency: 'EUR', payers: [] },
  ], ...extra });

  it('adds what is left to pay on the due date with a morning alarm', () => {
    const events = tripEvents(data(), { space: 's1' }).filter((event) => event.uid.includes('-due-'));
    expect(events.map((event) => [event.summary, event.start.date])).toEqual([['Payment due: Hotel (600.00 EUR)', '2027-04-01'], ['Payment due: Later (5000 JPY)', '2027-04-03']]);
    expect(events[0].alarms).toEqual([{ before: -540 }]);
  });

  it('leaves them out when costs are turned off', () => {
    const events = tripEvents(data({ meta: { settings: { addons: { costs: false } } } }), { space: 's1' });
    expect(events.some((event) => event.uid.includes('-due-'))).toBe(false);
  });
});

describe('choosing trips for the feed', () => {
  it('keeps trips ending within 90 days, newest first, and drops other kinds', () => {
    const list = feedCandidates([
      trip('0000000000000001', { start: '2027-01-01', end: '2027-01-05' }),
      trip('0000000000000002', { start: '2027-06-01', end: '2027-06-05' }),
      trip('0000000000000003'),
      trip('0000000000000002', { start: '2027-06-01' }),
      { ref: { w: W1, s: '0000000000000004', k: 'journey' } },
      { ref: { w: 'evil', s: '0000000000000005', k: 'trip' } },
    ], { today: '2027-05-01' });
    expect(list.map((entry) => entry.ref.s)).toEqual(['0000000000000003', '0000000000000002']);
  });

  it('works out what to add and remove', () => {
    const candidates = [trip('0000000000000001'), trip('0000000000000002')];
    expect(feedChanges([{ w: W1, s: '0000000000000002' }, { w: W2, s: '0000000000000009', title: 'Old' }], candidates)).toEqual({
      add: [candidates[0]], remove: [{ w: W2, s: '0000000000000009' }],
    });
  });

  it('builds subscribe links only for feed paths', () => {
    const links = allFeedLinks(W1, `/feed/${'a'.repeat(32)}.ics`);
    expect(links.https).toBe(`https://${W1}.puter.work/feed/${'a'.repeat(32)}.ics`);
    expect(links.webcal.startsWith('webcal://')).toBe(true);
    expect(allFeedLinks(W1, '/feed/../x.ics')).toBeNull();
    expect(isAllFeedPath('/ics/x.ics')).toBe(false);
  });

  it('rotates a scoped token made elsewhere and skips old workers with a feed', async () => {
    const ref = { w: W1, s: '0000000000000001', k: 'trip' };
    const fresh = vi.fn(async (_ref, _op, input) => (input.rotate ? { token: 'b'.repeat(32), scope: 'all' } : { exists: true, scope: 'all' }));
    expect(await scopedToken(fresh, ref)).toMatchObject({ token: 'b'.repeat(32), scoped: true });
    expect(fresh).toHaveBeenCalledTimes(2);
    expect(await scopedToken(async () => ({ exists: true }), ref)).toEqual({ skip: 'outdated' });
    expect(await scopedToken(async () => ({ token: 'c'.repeat(32), path: '/ics/x' }), ref)).toMatchObject({ token: 'c'.repeat(32), scoped: false });
  });
});

describe('keeping the worker up to date', () => {
  let store;
  let worker;
  const session = () => ({
    account: { uuid: ME },
    db: { get: async (key) => store.get(key) ?? null, put: async (key, value) => { store.set(key, value); }, remove: async (key) => { store.delete(key); } },
    deployer: { current: async () => worker, ensure: async () => { worker = { name: W1 }; return { worker }; } },
    api: {
      calls: [],
      async request(name, text) {
        const input = JSON.parse(text);
        this.calls.push(input);
        if (input.op !== 'feed.all') throw new Error('unexpected');
        const feeds = [...(this.feeds ?? []), ...(input.add ?? []).map(({ w, s, title }) => ({ w, s, title }))].filter((item) => !(input.remove ?? []).some((gone) => gone.s === item.s));
        this.feeds = feeds;
        const created = input.rotate || (!this.exists && input.add);
        this.exists ||= Boolean(created);
        return { exists: this.exists, feeds, ...(created ? { token: 'f'.repeat(32), path: `/feed/${'f'.repeat(32)}.ics` } : {}) };
      },
      call: async (ref) => (ref.s.endsWith('3') ? { exists: true } : { token: 'a'.repeat(32), scope: 'all' }),
    },
  });
  const personal = { spaces: { list: async () => [trip('0000000000000001'), trip('0000000000000002'), trip('0000000000000003')] } };
  beforeEach(() => { store = new Map(); worker = null; localStorage.clear(); });

  it('creates the feed with every trip it can reach and remembers the link on this device', async () => {
    const s = session();
    const result = await updateAllTripsFeed({ session: s, personal, create: true, today: '2027-05-01' });
    expect(result.path).toBe(`/feed/${'f'.repeat(32)}.ics`);
    expect(result.feeds.map((item) => item.s)).toEqual(['0000000000000001', '0000000000000002']);
    expect(result.skipped.map((item) => [item.entry.ref.s, item.reason])).toEqual([['0000000000000003', 'outdated']]);
    expect(s.api.calls.at(-1).add.every((item) => item.uuid === ME && item.token.length === 32)).toBe(true);
    expect(store.get(`ics:all:${W1}`).path).toBe(result.path);
  });

  it('syncs in the background only where it was set up, at most twice a day', async () => {
    const s = session();
    expect(await syncAllTripsFeed(s, { personal, now: 1e12 })).toBeNull();
    await updateAllTripsFeed({ session: s, personal, create: true });
    s.api.calls.length = 0;
    expect(await syncAllTripsFeed(s, { personal, now: 1e12 })).not.toBeNull();
    expect(await syncAllTripsFeed(s, { personal, now: 1e12 + 3_600_000 })).toBeNull();
    expect(s.api.calls.every((input) => input.op === 'feed.all')).toBe(true);
  });
});

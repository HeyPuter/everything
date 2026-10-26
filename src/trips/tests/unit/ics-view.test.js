import { afterEach, describe, expect, it, vi } from 'vitest';
import { openCalendarExport, registerCalendarCommand } from '../../src/views/ics/index.js';
import { canOpenInCalendar, openInCalendar } from '../../src/views/ics/handoff.js';
import { errorMessage, exportCalendar, feedLinks, feedStore, fileName } from '../../src/views/ics/model.js';
import { t } from '../../src/lib/i18n/index.js';

const REF = { w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' };
const ME = '00000000-0000-4000-8000-00000000000a';
const PATH = `/ics/${REF.s}/${ME}/${'a'.repeat(32)}.ics`;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function stubSpace(entities = {}) {
  const meta = { title: 'Lisbon: spring', start: '2027-05-01', end: '2027-05-02', ...entities.meta };
  const select = {};
  for (const type of ['day', 'visit', 'place', 'res', 'todo', 'listMeta']) select[type] = { all: () => entities[type] ?? [] };
  return { ref: REF, get: (type) => (type === 'meta' ? meta : null), select };
}
function memoryDb() {
  const map = new Map();
  return { get: async (key) => map.get(key), put: async (key, value) => { map.set(key, value); }, remove: async (key) => { map.delete(key); }, map };
}

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('calendar export model', () => {
  it('builds subscribe links with options', () => {
    const links = feedLinks(REF.w, PATH, { days: false });
    expect(links.https).toBe(`https://trips-abcdefghij.puter.work${PATH}?days=0`);
    expect(links.webcal).toBe(`webcal://trips-abcdefghij.puter.work${PATH}?days=0`);
    expect(links.google).toBe(`https://calendar.google.com/calendar/render?cid=${encodeURIComponent(links.webcal)}`);
    expect(feedLinks(REF.w, PATH, { alarms: false }).https.endsWith('?alarms=0')).toBe(true);
    expect(feedLinks(REF.w, '/pub/x/y')).toBeNull();
    expect(() => feedLinks('evil.example', PATH)).toThrow();
  });

  it('makes safe file names', () => {
    expect(fileName('Lisbon: spring / 2027')).toBe('Lisbon spring 2027.ics');
    expect(fileName('  ')).toBe('trip.ics');
    expect(fileName('x'.repeat(200))).toBe(`${'x'.repeat(80)}.ics`);
  });

  it('keeps the feed path per trip on this device', async () => {
    const db = memoryDb();
    const store = feedStore(db, REF);
    expect(await store.get()).toBeNull();
    await store.set(PATH);
    expect(await feedStore(db, REF).get()).toBe(PATH);
    expect(await feedStore(db, { ...REF, s: '0000000000000002' }).get()).toBeNull();
    await store.clear();
    expect(await store.get()).toBeNull();
    const failing = feedStore({ get: async () => { throw new Error('x'); }, put: async () => { throw new Error('x'); }, remove: async () => {} }, REF);
    await failing.set(PATH);
    expect(await failing.get()).toBe(PATH);
  });

  it('maps worker errors to messages', () => {
    expect(errorMessage({ status: 402, code: 'owner_credit' })).toBe(t('ics.errOwnerCredit'));
    expect(errorMessage({ status: 402, code: 'caller_credit' })).toBe(t('ics.errCallerCredit'));
    expect(errorMessage({ status: 403, code: 'not_member' })).toBe(t('ics.errForbidden'));
    expect(errorMessage({ status: 429, code: 'rate_limited' })).toBe(t('ics.errRateLimited'));
    expect(errorMessage({ status: 0, code: 'network' })).toBe(t('ics.errOffline'));
    expect(errorMessage({ status: 500, code: 'internal' }, { offline: false })).toBe(t('ics.errGeneric'));
  });

  it('exports translated labels', () => {
    const space = stubSpace({ day: [{ id: 'd', order: 'a', date: '2027-05-01', title: 'Arrive' }], res: [{ id: 'r', type: 'parking', start: { date: '2027-05-01' } }] });
    const text = exportCalendar(space, { member: ME, now: 0 });
    expect(text).toContain('SUMMARY:Day 1: Arrive');
    expect(text).toContain(`SUMMARY:${t('bookings.type.parking')}`);
    expect(text).toContain('X-WR-CALNAME:Lisbon: spring');
  });
});

describe('Calendar hand-off', () => {
  it('runs on the desktop only', () => {
    expect(canOpenInCalendar({ env: 'web', ui: { launchApp() {} }, fs: { write() {} } })).toBe(false);
    expect(canOpenInCalendar({ env: 'app', ui: { launchApp() {} }, fs: { write() {} } })).toBe(true);
  });

  it('writes the file and launches Calendar with a signed item, or without one', async () => {
    const launchApp = vi.fn(async () => ({}));
    const puter = {
      env: 'app', ui: { launchApp },
      fs: { write: vi.fn(async () => ({ uid: 'file-1' })), sign: vi.fn(async () => ({ items: { uid: 'file-1', read_url: 'https://r' } })) },
      apps: { get: vi.fn(async () => ({ uid: 'app-cal' })) },
    };
    expect(await openInCalendar(puter, { name: 'trip.ics', text: 'BEGIN:VCALENDAR' })).toEqual({ attached: true });
    expect(puter.fs.write.mock.calls[0][0]).toBe('exports/calendar/trip.ics');
    expect(puter.fs.sign).toHaveBeenCalledWith('app-cal', { uid: 'file-1', action: 'read' });
    expect(launchApp).toHaveBeenLastCalledWith({ name: 'calendar', items: [{ uid: 'file-1', read_url: 'https://r' }] });
    puter.apps.get.mockRejectedValueOnce(new Error('denied'));
    expect(await openInCalendar(puter, { name: 'trip.ics', text: '' })).toEqual({ attached: false });
    expect(launchApp).toHaveBeenLastCalledWith({ name: 'calendar' });
  });
});

describe('calendar export dialog', () => {
  it('creates, shows, rotates and turns off the subscription link', async () => {
    const db = memoryDb();
    const call = vi.fn(async (_ref, _op, input) => (input.revoke ? { revoked: true } : { token: 'a'.repeat(32), path: input.rotate ? PATH.replace('aaaa', 'bbbb') : PATH }));
    const closed = openCalendarExport({ space: stubSpace(), session: { api: { call }, db }, account: { uuid: ME }, puter: { env: 'web' } });
    await flush();
    const dialog = document.querySelector('.ics-dialog');
    expect(dialog).not.toBeNull();
    expect(document.querySelector('[data-ics="calendar"]')).toBeNull();
    document.querySelector('[data-ics="create"]').click();
    await flush(); await flush();
    expect(call).toHaveBeenCalledWith(REF, 'feed.set', {});
    expect(document.querySelector('.ics-feed-url').value).toBe(`https://trips-abcdefghij.puter.work${PATH}`);
    expect(document.querySelector('[data-ics="webcal"]').getAttribute('href')).toMatch(/^webcal:\/\//);
    expect(db.map.size).toBe(1);
    // Turning day events off changes the link.
    dialog.querySelector('.ics-option input').click();
    expect(document.querySelector('.ics-feed-url').value.endsWith('?days=0')).toBe(true);
    document.querySelector('[data-ics="revoke"]').click();
    await flush();
    [...document.querySelectorAll('.modal-actions button')].at(-1).click();
    await flush(); await flush();
    expect(call).toHaveBeenLastCalledWith(REF, 'feed.set', { revoke: true });
    expect(document.querySelector('.ics-feed-url')).toBeNull();
    expect(db.map.size).toBe(0);
    [...document.querySelectorAll('.modal-actions button')].at(-1).click();
    expect(await closed).toBe('done');
  });

  it('explains a link made on another device and shows errors', async () => {
    const call = vi.fn(async (_ref, _op, input) => {
      if (input.rotate) throw Object.assign(new Error('x'), { status: 402, code: 'owner_credit' });
      return { exists: true };
    });
    openCalendarExport({ space: stubSpace(), session: { api: { call }, db: memoryDb() }, account: { uuid: ME } });
    await flush();
    document.querySelector('[data-ics="create"]').click();
    await flush(); await flush();
    expect(document.querySelector('.ics-feed').textContent).toContain(t('ics.feedElsewhere'));
    document.querySelector('[data-ics="renew"]').click();
    await flush(); await flush();
    const alert = document.querySelector('.ics-alert');
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toBe(t('ics.errOwnerCredit'));
  });

  it('registers a palette command for a mounted trip view', () => {
    const entries = new Map();
    const commands = { register: (command) => { if (entries.has(command.id)) throw new TypeError('dup'); entries.set(command.id, command); return () => entries.delete(command.id); } };
    const off = registerCalendarCommand({ app: { commands }, space: stubSpace() });
    expect(entries.get('trip-calendar').labelKey).toBe('ics.command');
    expect(registerCalendarCommand({ app: { commands }, space: stubSpace() })).toBeTypeOf('function');
    off();
    expect(entries.size).toBe(0);
    expect(registerCalendarCommand({ app: {}, space: stubSpace() })).toBeTypeOf('function');
  });
});

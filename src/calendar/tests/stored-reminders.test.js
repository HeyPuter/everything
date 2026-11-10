import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStoredReminders, reminderGroup } from '../src/js/stored-reminders.js';
import { createStore } from '../src/js/store.js';
import { createReminderScheduler } from '../src/js/reminders.js';
import { makeKv } from './helpers/worker-harness.js';

const MIN = 60_000;
const DAY = 86400_000;
const BASE = Date.UTC(2026, 10, 4, 12);

async function setup({ enabled = true, env = 'web', signedIn = () => true, locks = null } = {}) {
  const kv = makeKv();
  const store = createStore(kv);
  await store.load();
  await store.saveSettings({ storedReminders: enabled, holidayCountry: '', clockChanges: false });
  let serial = 0;
  const notifications = {
    notify: vi.fn(async (n) => ({ scheduleId: `s${++serial}`, sendAt: Math.ceil(n.sendAt / 1000) * 1000 })),
    cancel: vi.fn(async () => {}),
    status: vi.fn(async () => 'on'),
  };
  const events = { updateSchedule: vi.fn(async (scheduleId) => ({ scheduleId })) };
  const p = { env, notifications, events };
  const sync = createStoredReminders({ store, kv, getPuter: () => p, signedIn, locks });
  const event = (patch = {}) => store.saveEvent({ title: 'Review', start: BASE + 60 * MIN, end: BASE + 90 * MIN, reminders: [10], ...patch });
  const rows = () => [...kv.map].filter(([key]) => key.startsWith('cal:reminder:')).map(([, value]) => value);
  return { kv, store, notifications, events, p, sync, event, rows };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('stored reminders', () => {
  it('stores future occurrences, with bounded content, then diffs without re-creating', async () => {
    const f = await setup();
    const ev = await f.event({ title: '😀'.repeat(140), location: 'Room '.repeat(100) });
    await f.sync.sync();
    const n = f.notifications.notify.mock.calls[0][0];
    expect(n).toMatchObject({ sendAt: ev.start - 10 * MIN, target: `/?event=${ev.id}`, data: { eventId: ev.id }, channel: 'calendar' });
    expect(Array.from(n.title)).toHaveLength(120);
    expect(Array.from(n.text).length).toBeLessThanOrEqual(240);
    expect(n.text).toContain('Starts in 10 minutes\n');
    expect(n.group).toBe(reminderGroup(`${ev.id}#${ev.start}#10`));
    expect(f.rows()).toEqual([expect.objectContaining({ scheduleId: 's1', sendAt: n.sendAt, hash: expect.any(String) })]);
    await f.sync.sync();
    expect(f.notifications.notify).toHaveBeenCalledTimes(1);
    expect(f.notifications.cancel).not.toHaveBeenCalled();
  });

  it('updates the stored text in place when only the words change', async () => {
    const f = await setup();
    let ev = await f.event();
    await f.sync.sync();
    for (const patch of [{ title: 'Renamed' }, { location: 'Room 2' }, { end: BASE + 100 * MIN }]) {
      ev = await f.store.saveEvent({ ...ev, ...patch });
      await f.sync.sync();
    }
    expect(f.notifications.notify).toHaveBeenCalledTimes(1);
    expect(f.notifications.cancel).not.toHaveBeenCalled();
    expect(f.events.updateSchedule).toHaveBeenCalledTimes(3);
    expect(f.events.updateSchedule).toHaveBeenLastCalledWith('s1', { title: 'Renamed', text: expect.stringContaining('Room 2') });
    await f.sync.sync();
    expect(f.events.updateSchedule).toHaveBeenCalledTimes(3);
    expect(f.rows()).toEqual([expect.objectContaining({ scheduleId: 's1', sendAt: ev.start - 10 * MIN })]);
  });

  it('replaces a stored reminder that already went out or is sending when its words change', async () => {
    const f = await setup();
    let ev = await f.event();
    await f.sync.sync();
    f.events.updateSchedule.mockRejectedValue({ code: 'events_schedule_sending' });
    ev = await f.store.saveEvent({ ...ev, title: 'Renamed' });
    await f.sync.sync();
    expect(f.notifications.cancel).toHaveBeenCalledWith('s1');
    expect(f.notifications.notify).toHaveBeenCalledTimes(2);
    expect(f.rows()).toEqual([expect.objectContaining({ scheduleId: 's2' })]);
  });

  it('cancels and replaces on time edits, and cancels on delete', async () => {
    const f = await setup();
    let ev = await f.event();
    await f.sync.sync();
    for (const patch of [{ start: BASE + 70 * MIN }, { reminders: [5] }]) {
      ev = await f.store.saveEvent({ ...ev, ...patch });
      const count = f.notifications.notify.mock.calls.length;
      await f.sync.sync();
      expect(f.notifications.cancel).toHaveBeenLastCalledWith(`s${count}`);
      expect(f.notifications.notify).toHaveBeenCalledTimes(count + 1);
      expect(f.rows()).toHaveLength(1);
    }
    await f.store.deleteEvent(ev.id);
    await f.sync.sync();
    expect(f.rows()).toHaveLength(0);
    expect(f.notifications.cancel).toHaveBeenLastCalledWith('s3');
  });

  it('shares recurrence, override, all-day, declined and ended filtering with the local scheduler', async () => {
    const f = await setup();
    const ev = await f.event({ recurrence: { freq: 'daily', interval: 1, count: 3 } });
    await f.event({ allDay: true });
    await f.event({ declined: true });
    await f.event({ start: BASE - 100 * MIN, end: BASE - 50 * MIN });
    await f.store.deleteOccurrence(ev.id, ev.start + DAY);
    await f.sync.sync();
    expect(f.notifications.notify).toHaveBeenCalledTimes(2);
    expect(f.notifications.notify.mock.calls.map(([n]) => n.sendAt)).toEqual([BASE + 50 * MIN, BASE + 2 * DAY + 50 * MIN]);
  });

  it('bounds the fire-time horizon, skips near times, but keeps an already-stored near reminder', async () => {
    const f = await setup();
    await f.event({ start: BASE + 20_000, end: BASE + MIN, reminders: [0] });
    await f.event({ start: BASE + 8 * DAY, end: BASE + 8 * DAY + MIN, reminders: [0] });
    // An occurrence beyond seven days has a reminder inside the fire-time horizon.
    await f.event({ start: BASE + 7.5 * DAY, end: BASE + 7.5 * DAY + MIN, reminders: [1440] });
    const ev = await f.event();
    await f.sync.sync();
    expect(f.notifications.notify).toHaveBeenCalledTimes(2);
    vi.setSystemTime(ev.start - 10 * MIN - 20_000);
    await f.sync.sync();
    expect(f.notifications.cancel).not.toHaveBeenCalled();
  });

  it('creates at most fifteen per pass and keeps the earliest fifty waiting', async () => {
    const f = await setup();
    for (let i = 65; i >= 0; i--) await f.event({ start: BASE + (i + 1) * MIN, end: BASE + (i + 2) * MIN, reminders: [0] });
    await f.sync.sync();
    expect(f.notifications.notify).toHaveBeenCalledTimes(15);
    expect(f.notifications.notify.mock.calls.map(([n]) => n.sendAt)).toEqual(Array.from({ length: 15 }, (_, i) => BASE + (i + 1) * MIN));
    await f.sync.sync(); await f.sync.sync(); await f.sync.sync(); await f.sync.sync();
    expect(f.rows()).toHaveLength(50);
    expect(f.notifications.notify).toHaveBeenCalledTimes(50);
    // Adding an earlier event evicts the last waiting reminder.
    await f.event({ start: BASE + 40_000, end: BASE + MIN, reminders: [0] });
    await f.sync.sync();
    expect(f.notifications.cancel).toHaveBeenCalledTimes(1);
    expect(f.rows()).toHaveLength(50);
  });

  it('continues capped batches after sixty seconds', async () => {
    const f = await setup();
    for (let i = 0; i < 31; i++) await f.event();
    await f.sync.sync();
    expect(f.notifications.notify).toHaveBeenCalledTimes(15);
    await vi.advanceTimersByTimeAsync(MIN - 1);
    expect(f.notifications.notify).toHaveBeenCalledTimes(15);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.notifications.notify).toHaveBeenCalledTimes(30);
    await vi.advanceTimersByTimeAsync(MIN - 1);
    expect(f.notifications.notify).toHaveBeenCalledTimes(30);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.rows()).toHaveLength(31);
  });

  it('clears a capped batch retry on stop', async () => {
    const f = await setup();
    for (let i = 0; i < 16; i++) await f.event();
    await f.sync.sync();
    f.sync.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(f.notifications.notify).toHaveBeenCalledTimes(15);
  });

  it.each(['events_disabled', 'forbidden', 'events_durable_requires_account'])('stops for this session on %s and leaves the local fallback enabled', async (code) => {
    const f = await setup();
    const ev = await f.event();
    f.notifications.notify.mockRejectedValue({ code });
    await f.sync.sync(); await f.sync.sync();
    expect(f.notifications.notify).toHaveBeenCalledTimes(1);
    expect(await f.sync.handles(`${ev.id}#${ev.start}#10`)).toBe(false);
  });

  it.each(['events_schedule_limit', 'too_many_requests'])('keeps existing schedules and stops this pass on %s', async (code) => {
    const f = await setup();
    await f.event();
    await f.sync.sync();
    await f.event(); await f.event();
    f.notifications.notify.mockRejectedValueOnce({ code });
    await f.sync.sync();
    expect(f.notifications.notify).toHaveBeenCalledTimes(2);
    expect(f.rows()).toHaveLength(1);
    expect(f.notifications.cancel).not.toHaveBeenCalled();
    await f.sync.sync();
    expect(f.rows()).toHaveLength(3);
  });

  it.each(['events_schedule_not_found', 'events_schedule_sending'])('forgets terminal cancellation error %s', async (code) => {
    const f = await setup();
    const ev = await f.event(); await f.sync.sync();
    await f.store.deleteEvent(ev.id);
    f.notifications.cancel.mockRejectedValue({ code });
    await f.sync.sync();
    expect(f.rows()).toHaveLength(0);
  });

  it('retains failed cancellations and does not create a replacement', async () => {
    const f = await setup();
    const ev = await f.event(); await f.sync.sync();
    await f.store.saveEvent({ ...ev, title: 'Changed' });
    f.notifications.cancel.mockRejectedValue({ code: 'too_many_requests' });
    await f.sync.sync();
    expect(f.rows()).toHaveLength(1);
    expect(f.notifications.notify).toHaveBeenCalledTimes(1);
  });

  it('handles a due-now uid without treating it as a schedule, and does not send it again', async () => {
    const f = await setup();
    await f.event();
    f.notifications.notify.mockResolvedValueOnce('already-sent-uid');
    await f.sync.sync();
    expect(f.rows()).toHaveLength(0);
    await f.sync.sync();
    expect(f.notifications.notify).toHaveBeenCalledTimes(1);
  });

  it('rolls back a failed KV write and retries on the next sync', async () => {
    const f = await setup();
    await f.event();
    f.kv.set.mockRejectedValueOnce(new Error('offline'));
    await f.sync.sync();
    expect(f.notifications.cancel).toHaveBeenCalledWith('s1');
    expect(f.rows()).toHaveLength(0);
    await f.sync.sync();
    expect(f.rows()).toEqual([expect.objectContaining({ scheduleId: 's2' })]);
  });

  it('reads shared mapping in other tabs, suppressing only covered reminders when status is on', async () => {
    const f = await setup();
    const ev = await f.event(); await f.sync.sync();
    const other = createStoredReminders({ store: f.store, kv: f.kv, getPuter: () => f.p, signedIn: () => true });
    const key = `${ev.id}#${ev.start}#10`;
    expect(await other.handles(key)).toBe(true);
    expect(f.notifications.status).toHaveBeenCalledWith({ serviceWorker: './sw.js' });
    expect(await other.handles('uncovered')).toBe(false);
    for (const state of ['off', 'blocked', 'unavailable']) {
      f.notifications.status.mockResolvedValue(state);
      expect(await other.handles(key)).toBe(false);
    }
    f.notifications.status.mockResolvedValue('on');
    vi.setSystemTime(BASE + 51 * MIN);
    await f.sync.sync();
    expect(await f.sync.handles(key)).toBe(true);
  });

  it.each([
    ['visible', true, 1],
    ['visible', false, 0],
    ['hidden', true, 0],
    ['hidden', false, 0],
  ])('checks visibility %s and focus %s at fire time', async (visibility, focused, count) => {
    const f = await setup();
    const ev = await f.event();
    await f.sync.sync();
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const notify = vi.fn();
    vi.stubGlobal('Notification', class {
      static permission = 'granted';
      constructor(title) { notify(title); }
    });
    const scheduler = createReminderScheduler({ store: f.store, isStored: (key) => f.sync.handles(key) });
    try {
      scheduler.start();
      visible.mockReturnValue(visibility);
      focus.mockReturnValue(focused);
      await vi.advanceTimersByTimeAsync(ev.start - 10 * MIN - BASE);
      expect(notify).toHaveBeenCalledTimes(count);
      if (count) expect(notify).toHaveBeenCalledWith('Review');
    } finally {
      scheduler.stop();
      vi.unstubAllGlobals();
    }
  });

  it('cancels all stored entries when the account setting is off', async () => {
    const f = await setup();
    await f.event(); await f.sync.sync();
    await f.store.saveSettings({ storedReminders: false });
    await f.sync.sync();
    expect(f.rows()).toHaveLength(0);
    await f.store.saveSettings({ storedReminders: true });
    await f.sync.sync();
    expect(f.rows()).toHaveLength(1);
    expect(f.notifications.notify).toHaveBeenCalledTimes(2);
  });

  it('merges racing schedule records, keeps one, and cancels the extra id', async () => {
    const f = await setup();
    await f.event(); await f.sync.sync();
    const [storageKey] = [...f.kv.map.keys()].filter((key) => key.startsWith('cal:reminder:'));
    f.kv.map.set(storageKey + '-other', { ...f.rows()[0], scheduleId: 'zz-other-device' });
    await f.sync.sync();
    expect(f.notifications.cancel).toHaveBeenCalledWith('zz-other-device');
    expect(f.rows()).toHaveLength(1);
  });

  it('lets only one of two devices syncing at once store a reminder', async () => {
    const f = await setup();
    await f.event();
    const other = createStoredReminders({ store: f.store, kv: f.kv, getPuter: () => f.p, signedIn: () => true });
    await Promise.all([f.sync.sync(), other.sync()]);
    expect(f.notifications.notify).toHaveBeenCalledTimes(1);
    expect(f.rows()).toHaveLength(1);
    expect(f.kv.expire).toHaveBeenCalledWith(expect.stringMatching(/^cal:reminder-claim:/), 120);
  });

  it('releases the claim when storing fails, so the next sync retries', async () => {
    const f = await setup();
    await f.event();
    f.notifications.notify.mockRejectedValueOnce({ code: 'too_many_requests' });
    await f.sync.sync();
    expect(f.rows()).toHaveLength(0);
    await f.sync.sync();
    expect(f.notifications.notify).toHaveBeenCalledTimes(2);
    expect(f.rows()).toHaveLength(1);
  });

  it('stores a reminder again at once when it is removed and added back unchanged', async () => {
    const f = await setup();
    const ev = await f.event();
    await f.sync.sync();
    await f.store.saveEvent({ ...ev, reminders: [] });
    await f.sync.sync();
    expect(f.rows()).toHaveLength(0);
    await f.store.saveEvent({ ...ev, reminders: [10] });
    await f.sync.sync();
    expect(f.notifications.notify).toHaveBeenCalledTimes(2);
    expect(f.rows()).toHaveLength(1);
  });

  it('does no work while signed out or in another environment', async () => {
    for (const options of [{ signedIn: () => false }, { env: 'node' }]) {
      const f = await setup(options);
      await f.event(); await f.sync.sync();
      expect(f.notifications.notify).not.toHaveBeenCalled();
      expect(f.notifications.cancel).not.toHaveBeenCalled();
    }
  });

  it('uses a nonblocking browser lock, debounces edits, and refreshes every fifteen minutes', async () => {
    const locks = { request: vi.fn(async (name, options, fn) => fn({ name })) };
    const f = await setup({ locks });
    f.sync.start(); await f.sync.sync();
    expect(locks.request).toHaveBeenCalledWith('calendar:stored-reminders', { ifAvailable: true }, expect.any(Function));
    const first = locks.request.mock.calls.length;
    await f.event(); await f.event();
    await vi.advanceTimersByTimeAsync(3100);
    expect(f.notifications.notify).toHaveBeenCalledTimes(2);
    expect(locks.request.mock.calls.length).toBe(first + 1);
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(locks.request.mock.calls.length).toBe(first + 2);
    f.sync.stop();
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(locks.request.mock.calls.length).toBe(first + 2);
  });

  it('skips sync when another tab holds the lock', async () => {
    const locks = { request: vi.fn(async (name, options, fn) => fn(null)) };
    const f = await setup({ locks });
    await f.event(); await f.sync.sync();
    expect(f.notifications.notify).not.toHaveBeenCalled();
  });

  it('derives deterministic, safe, bounded groups from arbitrary occurrence keys', () => {
    const key = 'é # /?💡'.repeat(200);
    expect(reminderGroup(key)).toBe(reminderGroup(key));
    expect(reminderGroup(key)).not.toBe(reminderGroup(key + 'x'));
    expect(reminderGroup(key)).toMatch(/^[A-Za-z0-9._:@-]{1,128}$/);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '../src/js/store.js';
import {
  createReminderScheduler,
  normalizeReminders,
  describeReminder,
  MAX_REMINDER_MIN,
} from '../src/js/reminders.js';

/** In-memory KV matching the subset the store uses. */
function makeKv() {
  const map = new Map();
  const re = (g) => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return {
    set: async (k, v) => (map.set(k, JSON.parse(JSON.stringify(v))), true),
    get: async (k) => (map.has(k) ? map.get(k) : null),
    del: async (k) => (map.delete(k), true),
    list: async (pattern, rv) => {
      let keys = [...map.keys()];
      if (typeof pattern === 'string') keys = keys.filter((k) => re(pattern).test(k));
      else if (pattern === true) rv = true;
      return rv ? keys.map((k) => ({ key: k, value: map.get(k) })) : keys;
    },
  };
}

const MIN = 60_000;

describe('normalizeReminders', () => {
  it('validates, dedupes, sorts, and caps to 5', () => {
    expect(normalizeReminders([10, 10, 5, 0])).toEqual([0, 5, 10]);
    expect(normalizeReminders([-1, 'x', MAX_REMINDER_MIN + 1, 15])).toEqual([15]);
    expect(normalizeReminders([1, 2, 3, 4, 5, 6, 7])).toHaveLength(5);
    expect(normalizeReminders('nope')).toEqual([]);
  });

  it('does not coerce null, booleans, or empty values into reminders', () => {
    // Number(null) === 0 and Number(true) === 1: a hand-edited or foreign
    // backup must not manufacture "at time of event" / "1 minute before".
    expect(normalizeReminders([null, true, false, '', [], {}, undefined])).toEqual([]);
    expect(normalizeReminders([null, 10, '15'])).toEqual([10, 15]);
  });
});

describe('describeReminder', () => {
  it('labels known and derived offsets', () => {
    expect(describeReminder(0)).toBe('At time of event');
    expect(describeReminder(15)).toBe('15 minutes before');
    expect(describeReminder(60)).toBe('1 hour before');
    expect(describeReminder(1440)).toBe('1 day before');
  });

  it('does not mis-round non-whole-hour offsets', () => {
    expect(describeReminder(90)).toBe('90 minutes before');
    expect(describeReminder(100)).toBe('100 minutes before');
    expect(describeReminder(120)).toBe('2 hours before');
  });
});

describe('createReminderScheduler', () => {
  let notes;
  let store;
  const base = new Date(2026, 6, 13, 12, 0, 0).getTime();

  beforeEach(async () => {
    notes = [];
    class FakeNotification {
      constructor(title, opts) {
        notes.push({ title, opts });
      }
      close() {}
    }
    FakeNotification.permission = 'granted';
    FakeNotification.requestPermission = async () => 'granted';
    globalThis.Notification = FakeNotification;

    vi.useFakeTimers();
    vi.setSystemTime(base);
    store = createStore(makeKv());
    await store.load();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.Notification;
  });

  it('fires a notification at the reminder lead time', async () => {
    await store.saveEvent({ title: 'Soon', start: base + 30 * MIN, end: base + 90 * MIN, reminders: [10] });
    const sched = createReminderScheduler({ store });
    sched.start();
    expect(notes).toHaveLength(0);
    // Reminder fires 10 min before start => 20 min from now.
    vi.advanceTimersByTime(20 * MIN + 1000);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Soon');
    sched.stop();
  });

  it('suppresses only reminders covered by Puter, and falls back if the lookup fails', async () => {
    const stored = await store.saveEvent({ title: 'Stored', start: base + MIN, end: base + 5 * MIN, reminders: [0] });
    await store.saveEvent({ title: 'Local', start: base + MIN, end: base + 5 * MIN, reminders: [0] });
    const isStored = vi.fn(async (key) => {
      if (key.startsWith(stored.id + '#')) return true;
      throw new Error('offline');
    });
    const sched = createReminderScheduler({ store, isStored });
    sched.start();
    await vi.advanceTimersByTimeAsync(MIN + 1000);
    expect(notes.map((n) => n.title)).toEqual(['Local']);
    sched.stop();
  });

  it('does not display a pending fallback after the scheduler is stopped', async () => {
    await store.saveEvent({ title: 'Stopped', start: base + MIN, end: base + 5 * MIN, reminders: [0] });
    let release;
    const sched = createReminderScheduler({ store, isStored: () => new Promise((resolve) => { release = resolve; }) });
    sched.start();
    vi.advanceTimersByTime(MIN + 1000);
    sched.stop();
    release(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(notes).toHaveLength(0);
  });

  it('does not replay a reminder whose fire time is already past', async () => {
    // Event started 5 minutes ago; its reminders are all in the past.
    await store.saveEvent({ title: 'Past', start: base - 5 * MIN, end: base + 55 * MIN, reminders: [10, 0] });
    const sched = createReminderScheduler({ store });
    sched.start();
    vi.advanceTimersByTime(60 * MIN);
    expect(notes).toHaveLength(0);
    sched.stop();
  });

  it('ignores reminders on all-day events', async () => {
    await store.saveEvent({ title: 'Holiday', start: base + 60 * MIN, end: base + 120 * MIN, allDay: true, reminders: [10] });
    const sched = createReminderScheduler({ store });
    sched.start();
    vi.advanceTimersByTime(2 * 60 * MIN);
    expect(notes).toHaveLength(0);
    sched.stop();
  });

  it('ignores reminders on declined events, and resumes them once accepted again', async () => {
    // Declined by an out-of-office block, or by answering "No" to the invite:
    // either way the user has said they are not going.
    const ev = await store.saveEvent({
      title: 'Skipped',
      start: base + 60 * MIN,
      end: base + 120 * MIN,
      reminders: [10],
      declined: true,
    });
    const sched = createReminderScheduler({ store });
    sched.start();
    vi.advanceTimersByTime(55 * MIN);
    expect(notes).toHaveLength(0);

    // Restored (accepted) with time to spare: the reminder is armed again.
    await store.setDeclined(ev.id, false);
    await store.saveEvent({ ...store.getEvent(ev.id), start: base + 120 * MIN, end: base + 180 * MIN });
    vi.advanceTimersByTime(56 * MIN);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Skipped');
    sched.stop();
  });

  it('does nothing when permission is not granted', async () => {
    globalThis.Notification.permission = 'default';
    await store.saveEvent({ title: 'Soon', start: base + 30 * MIN, end: base + 90 * MIN, reminders: [10] });
    const sched = createReminderScheduler({ store });
    sched.start();
    vi.advanceTimersByTime(30 * MIN);
    expect(notes).toHaveLength(0);
    sched.stop();
  });

  it('cancels a scheduled reminder when the event is deleted', async () => {
    const ev = await store.saveEvent({ title: 'Soon', start: base + 30 * MIN, end: base + 90 * MIN, reminders: [10] });
    const sched = createReminderScheduler({ store });
    sched.start();
    await store.deleteEvent(ev.id);
    vi.advanceTimersByTime(30 * MIN);
    expect(notes).toHaveLength(0);
    sched.stop();
  });

  it('shows current content when the event was edited after the timer was armed', async () => {
    const ev = await store.saveEvent({
      title: 'Meeting',
      location: 'Room A',
      start: base + 30 * MIN,
      end: base + 90 * MIN,
      reminders: [10],
    });
    const sched = createReminderScheduler({ store });
    sched.start();
    // Edit title + location WITHOUT changing start, so the timer key is unchanged
    // and the timer is not re-armed — the fix re-resolves content at fire time.
    await store.saveEvent({ id: ev.id, title: 'RENAMED', location: 'Room B', start: ev.start, end: ev.end, reminders: [10] });
    vi.advanceTimersByTime(20 * MIN + 1000);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('RENAMED');
    expect(notes[0].opts.body).toContain('Room B');
    sched.stop();
  });

  it('does not fire for an event deleted after the timer was armed', async () => {
    const ev = await store.saveEvent({ title: 'Gone', start: base + 30 * MIN, end: base + 90 * MIN, reminders: [10] });
    const sched = createReminderScheduler({ store });
    sched.start();
    await store.deleteEvent(ev.id);
    vi.advanceTimersByTime(30 * MIN);
    expect(notes).toHaveLength(0);
    sched.stop();
  });

  it('suppresses a reminder replaying after sleep once the event has ended', async () => {
    // Regression: system sleep suspends timeout clocks; on wake the armed
    // timer replayed a stale "Starting now" for an event long over.
    await store.saveEvent({ title: 'Missed', start: base + 30 * MIN, end: base + 60 * MIN, reminders: [10] });
    const sched = createReminderScheduler({ store });
    sched.start();
    // Simulate suspend: the wall clock jumps 10 hours with no timers running…
    vi.setSystemTime(base + 600 * MIN);
    // …then on wake the suspended timeout finally runs.
    vi.advanceTimersByTime(20 * MIN + 1000);
    expect(notes).toHaveLength(0);
    sched.stop();
  });

  it('still shows a late reminder while the event is in progress', async () => {
    await store.saveEvent({ title: 'Ongoing', start: base + 30 * MIN, end: base + 300 * MIN, reminders: [10] });
    const sched = createReminderScheduler({ store });
    sched.start();
    // A shorter nap: wake mid-event.
    vi.setSystemTime(base + 90 * MIN);
    vi.advanceTimersByTime(20 * MIN + 1000);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Ongoing');
    sched.stop();
  });

  it('fires a reminder that was never armed before a long sleep, when the event is still upcoming', async () => {
    // Regression: fireAt was beyond the 12h arming horizon at suspend time, so
    // no timer existed; on wake fireAt was in the past and scan() skipped it —
    // the reminder for a still-upcoming event never fired at all, while the
    // identical reminder WOULD have fired late had it been armed (previous
    // test). Weekend laptop-close swallowed Monday-morning reminders.
    await store.saveEvent({
      title: 'Monday standup',
      start: base + 14 * 60 * MIN, // 14h away
      end: base + 15 * 60 * MIN,
      reminders: [60], // fires 13h away — beyond the 12h horizon, so never armed
    });
    const sched = createReminderScheduler({ store });
    sched.start();
    expect(notes).toHaveLength(0);
    // Sleep 13.5h with no timers running; wake 30 min before the event.
    vi.setSystemTime(base + 13.5 * 60 * MIN);
    vi.advanceTimersByTime(60_000 + 1000); // next scheduler tick after wake
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Monday standup');
    // And never again on later ticks.
    vi.advanceTimersByTime(10 * 60_000);
    expect(notes).toHaveLength(1);
    sched.stop();
  });

  it('does not fire a slept-through reminder once the event has ended', async () => {
    await store.saveEvent({
      title: 'Long past',
      start: base + 14 * 60 * MIN,
      end: base + 15 * 60 * MIN,
      reminders: [60],
    });
    const sched = createReminderScheduler({ store });
    sched.start();
    // Sleep straight past the event's end.
    vi.setSystemTime(base + 20 * 60 * MIN);
    vi.advanceTimersByTime(60_000 + 1000);
    expect(notes).toHaveLength(0);
    sched.stop();
  });

  it('fires per-occurrence reminders for a recurring series', async () => {
    // Daily event; first occurrence is tomorrow at noon (today's noon == base is "now").
    await store.saveEvent({
      title: 'Daily sync',
      start: base + 30 * MIN,
      end: base + 60 * MIN,
      reminders: [5],
      recurrence: { freq: 'daily', interval: 1 },
    });
    const sched = createReminderScheduler({ store });
    sched.start();
    vi.advanceTimersByTime(25 * MIN + 1000); // 5 min before the first occurrence
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Daily sync');
    sched.stop();
  });
});

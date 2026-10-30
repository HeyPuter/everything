import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createStore,
  normalizeEvent,
  normalizeTask,
  eventInRange,
  DEFAULT_SETTINGS,
} from '../src/js/store.js';
import { DEFAULT_COLOR, MAX_CATEGORY_NAME } from '../src/js/colors.js';

/** In-memory stand-in matching the subset of puter.kv the store uses. */
function makeKv(initial = {}) {
  const map = new Map(Object.entries(initial));
  const globToRe = (glob) =>
    new RegExp(
      '^' +
        glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') +
        '$',
    );
  return {
    map,
    set: vi.fn(async (k, v) => {
      // Mirrors puter.kv.set's two forms: (key, value) or a batch array of
      // { key, value } items.
      const items = Array.isArray(k) ? k : [{ key: k, value: v }];
      for (const { key, value } of items) map.set(key, JSON.parse(JSON.stringify(value)));
      return true;
    }),
    get: vi.fn(async (k) => (map.has(k) ? map.get(k) : null)),
    del: vi.fn(async (k) => {
      map.delete(k);
      return true;
    }),
    list: vi.fn(async (pattern, returnValues) => {
      let keys = [...map.keys()];
      if (typeof pattern === 'string') keys = keys.filter((k) => globToRe(pattern).test(k));
      else if (pattern === true) returnValues = true;
      return returnValues ? keys.map((k) => ({ key: k, value: map.get(k) })) : keys;
    }),
  };
}

const H = 3_600_000;
const day = new Date(2026, 6, 12).getTime();

describe('normalizeEvent', () => {
  it('fills defaults and assigns an id', () => {
    const e = normalizeEvent({ title: 'Hi', start: day, end: day + H }, 1000);
    expect(typeof e.id).toBe('string');
    expect(e.id.length).toBeGreaterThan(0);
    expect(e.color).toBe(DEFAULT_COLOR);
    expect(e.allDay).toBe(false);
    expect(e.createdAt).toBe(1000);
  });

  it('keeps a provided id', () => {
    expect(normalizeEvent({ id: 'keep-me', start: day }).id).toBe('keep-me');
  });

  it('rejects invalid colors', () => {
    expect(normalizeEvent({ color: 'chartreuse', start: day }).color).toBe(DEFAULT_COLOR);
    expect(normalizeEvent({ color: 'teal', start: day }).color).toBe('teal');
  });

  it('forces end strictly after start for timed events', () => {
    const e = normalizeEvent({ start: day, end: day - H });
    expect(e.end).toBeGreaterThan(e.start);
  });

  it("an all-day fallback end covers exactly the start's calendar day", () => {
    const e = normalizeEvent({ start: day, end: day, allDay: true });
    expect(e.end).toBeGreaterThan(e.start);
    expect(new Date(e.end).getDate()).toBe(new Date(e.start).getDate());
  });

  // Only meaningful in a zone where Mar 8 2026 is a 23-hour spring-forward
  // day: a fixed 24h fallback span then overshoots into Mar 9, and the event
  // renders on two days (and exports as a 2-day DTEND).
  const mar8 = new Date(2026, 2, 8).getTime();
  const shortDay = new Date(2026, 2, 9).getTime() - mar8 < 24 * 3_600_000;
  it.runIf(shortDay)('…including on a 23-hour spring-forward day', () => {
    const e = normalizeEvent({ start: mar8, end: mar8, allDay: true });
    expect(new Date(e.end).getDate()).toBe(8); // not Mar 9 00:59:59.999
    expect(e.end).toBeGreaterThan(e.start);
  });

  it('reads an exclusive midnight all-day end as "through the day before"', () => {
    // The API and foreign backups send ISO-style exclusive ends; the editor
    // writes the last instant of the last day. Both must mean the same span.
    const aug28 = new Date(2026, 7, 28).getTime();
    const aug29 = new Date(2026, 7, 29).getTime();
    const oneDay = normalizeEvent({ start: aug28, end: aug29, allDay: true });
    expect(new Date(oneDay.end).getDate()).toBe(28);
    expect(oneDay.end).toBe(new Date(2026, 7, 28, 23, 59, 59, 999).getTime());
    const twoDays = normalizeEvent({ start: aug28, end: new Date(2026, 7, 30).getTime(), allDay: true });
    expect(new Date(twoDays.end).getDate()).toBe(29);
    // Canonical input is untouched, and a mid-day end still covers its day.
    const canonical = new Date(2026, 7, 29, 23, 59, 59, 999).getTime();
    expect(normalizeEvent({ start: aug28, end: canonical, allDay: true }).end).toBe(canonical);
    expect(normalizeEvent({ start: aug28, end: new Date(2026, 7, 29, 12).getTime(), allDay: true }).end).toBe(canonical);
  });

  it('clamps overly long strings', () => {
    const e = normalizeEvent({ title: 'x'.repeat(9999), start: day });
    expect(e.title.length).toBeLessThanOrEqual(500);
  });

  it('defaults reminders to an empty array', () => {
    expect(normalizeEvent({ start: day }).reminders).toEqual([]);
  });

  it('validates, dedupes, sorts, and caps reminders', () => {
    const e = normalizeEvent({
      start: day,
      reminders: [30, 10, 10, -5, 'x', 99999, 0, 5, 15, 60, 120, 1440],
    });
    // -5 (negative), 'x' (NaN) and 99999 (> 1 day) dropped; deduped + sorted; capped to 5.
    expect(e.reminders).toEqual([0, 5, 10, 15, 30]);
  });
});

describe('createStore — load() against writes on the wire', () => {
  it('waits for a save that is still in flight before re-reading, so the event does not blink out', async () => {
    // A backend whose set is slow: the save has been ISSUED (memory updated,
    // emit fired) but the cloud has not stored it when a load() begins — the
    // API's freshness re-read, the reconnect refresh and the booking sync all
    // reload at moments like this. The list must not run ahead of the write.
    const kv = makeKv();
    let release;
    const slowSet = new Promise((resolve) => (release = resolve));
    const realSet = kv.set;
    kv.set = async (k, v) => {
      await slowSet;
      return realSet(k, v);
    };
    const store = createStore(kv);
    await store.load();
    const saving = store.saveEvent({ title: 'Just saved', start: Date.now(), end: Date.now() + 3_600_000 });
    expect(store.getAllEvents().map((e) => e.title)).toEqual(['Just saved']);

    let loaded = false;
    const reload = store.load().then(() => (loaded = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(loaded).toBe(false); // still waiting on the write
    release();
    await saving;
    await reload;
    expect(store.getAllEvents().map((e) => e.title)).toEqual(['Just saved']);
  });

  it('does not wait forever on a write the network never answers', async () => {
    vi.useFakeTimers();
    try {
      const kv = makeKv();
      kv.set = () => new Promise(() => {}); // never settles
      const store = createStore(kv);
      await store.load();
      store.saveEvent({ title: 'Lost', start: Date.now(), end: Date.now() + 3_600_000 }).catch(() => {});
      let loaded = false;
      const reload = store.load().then(() => (loaded = true));
      await vi.advanceTimersByTimeAsync(9_000);
      expect(loaded).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      await reload;
      expect(loaded).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('eventInRange', () => {
  const e = { start: day + 9 * H, end: day + 10 * H };
  it('detects overlap with a half-open range', () => {
    expect(eventInRange(e, day, day + 24 * H)).toBe(true);
    expect(eventInRange(e, day + 10 * H, day + 11 * H)).toBe(false); // starts exactly at end
    expect(eventInRange(e, day + 8 * H, day + 9 * H)).toBe(false); // ends exactly at start
    expect(eventInRange(e, day + 9.5 * H, day + 9.6 * H)).toBe(true);
  });
});

describe('createStore', () => {
  let kv;
  let store;

  beforeEach(async () => {
    kv = makeKv();
    store = createStore(kv);
    await store.load();
  });

  it('starts empty with default settings', () => {
    expect(store.getAllEvents()).toEqual([]);
    expect(store.getSettings()).toEqual({ ...DEFAULT_SETTINGS });
  });

  it('creates and persists an event', async () => {
    const saved = await store.saveEvent({ title: 'Standup', start: day + 9 * H, end: day + 9.5 * H });
    expect(store.getAllEvents()).toHaveLength(1);
    expect(kv.set).toHaveBeenCalledWith(`cal:evt:${saved.id}`, expect.objectContaining({ id: saved.id }));
    // Survives a reload from the backing store.
    const store2 = createStore(kv);
    await store2.load();
    expect(store2.getEvent(saved.id).title).toBe('Standup');
  });

  it('updates an existing event in place', async () => {
    const saved = await store.saveEvent({ title: 'Draft', start: day, end: day + H });
    await store.saveEvent({ id: saved.id, title: 'Final', start: day, end: day + H });
    expect(store.getAllEvents()).toHaveLength(1);
    expect(store.getEvent(saved.id).title).toBe('Final');
  });

  it('deletes an event', async () => {
    const saved = await store.saveEvent({ title: 'Temp', start: day, end: day + H });
    await store.deleteEvent(saved.id);
    expect(store.getEvent(saved.id)).toBeNull();
    expect(kv.del).toHaveBeenCalledWith(`cal:evt:${saved.id}`);
  });

  it('queries by range and sorts all-day first, then by start', async () => {
    await store.saveEvent({ title: 'Noon', start: day + 12 * H, end: day + 13 * H });
    await store.saveEvent({ title: 'Morning', start: day + 9 * H, end: day + 10 * H });
    await store.saveEvent({ title: 'Holiday', start: day, end: day, allDay: true });

    const inRange = store.getEventsInRange(day, day + 24 * H);
    expect(inRange.map((e) => e.title)).toEqual(['Holiday', 'Morning', 'Noon']);

    // The all-day event covers the whole day, so it also overlaps the afternoon.
    const narrow = store.getEventsInRange(day + 12 * H, day + 24 * H);
    expect(narrow.map((e) => e.title)).toEqual(['Holiday', 'Noon']);
  });

  it('hides events whose color is filtered out', async () => {
    await store.saveEvent({ title: 'Blue one', start: day + H, end: day + 2 * H, color: 'blue' });
    await store.saveEvent({ title: 'Red one', start: day + H, end: day + 2 * H, color: 'red' });
    await store.saveSettings({ hiddenColors: ['red'] });

    const visible = store.getEventsInRange(day, day + 24 * H);
    expect(visible.map((e) => e.title)).toEqual(['Blue one']);

    const all = store.getEventsInRange(day, day + 24 * H, { includeHidden: true });
    expect(all).toHaveLength(2);
  });

  it('a save landing while load() is reading is not blinked out of memory', async () => {
    const seeded = await store.saveEvent({ title: 'Old', start: day, end: day + H });

    // Hold the reload's FIRST list (the event scan) so its snapshot predates
    // the save that lands mid-flight.
    const realList = kv.list.getMockImplementation();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let gated = false;
    kv.list.mockImplementation(async (pattern, rv) => {
      const out = await realList(pattern, rv);
      if (!gated) {
        gated = true;
        await gate;
      }
      return out;
    });

    const reload = store.load();
    const saved = await store.saveEvent({ title: 'Mid-load', start: day + 2 * H, end: day + 3 * H });
    release();
    await reload;

    // The clear-and-repopulate used to rebuild from the pre-save snapshot,
    // making the event the user just created vanish until the NEXT load.
    expect(store.getEvent(saved.id)).toBeTruthy();
    expect(store.getEvent(saved.id).title).toBe('Mid-load');
    expect(store.getEvent(seeded.id)).toBeTruthy();
  });

  it('persists and reloads settings', async () => {
    await store.saveSettings({ weekStartsOn: 1, theme: 'dark' });
    const store2 = createStore(kv);
    const { settings } = await store2.load();
    expect(settings.weekStartsOn).toBe(1);
    expect(settings.theme).toBe('dark');
  });

  it("a settings save on a stale device keeps another device's newer settings", async () => {
    const deviceB = createStore(kv);
    await deviceB.load();

    await deviceB.saveSettings({ hiddenColors: ['red'] }); // laptop hides red
    await store.saveSettings({ theme: 'dark' }); // stale phone picks a theme

    const fresh = createStore(kv);
    const { settings } = await fresh.load();
    expect(settings.theme).toBe('dark');
    expect(settings.hiddenColors).toEqual(['red']); // not reverted to []
    // The stale device's own memory caught up in the same write.
    expect(store.getSettings().hiddenColors).toEqual(['red']);
  });

  // Renamed categories are a map inside the settings map, so the whole-map
  // merge every other setting gets is not enough for them: see saveSettings.
  it('two devices renaming different categories keep both names', async () => {
    const deviceB = createStore(kv);
    await deviceB.load();

    await deviceB.saveSettings({ categoryNames: { red: 'Bills' } }); // laptop
    await store.saveSettings({ categoryNames: { violet: 'Family' } }); // stale phone

    const fresh = createStore(kv);
    const { settings } = await fresh.load();
    expect(settings.categoryNames).toEqual({ red: 'Bills', violet: 'Family' });
  });

  it("clearing a category name beats the name another device still has", async () => {
    await store.saveSettings({ categoryNames: { violet: 'Family' } });
    const deviceB = createStore(kv);
    await deviceB.load();
    await deviceB.saveSettings({ theme: 'dark' }); // carries 'Family' along

    // Renamed back to the palette default: written as '' precisely so the
    // key-by-key merge above cannot resurrect the older cloud name.
    await store.saveSettings({ categoryNames: { violet: '' } });

    const fresh = createStore(kv);
    const { settings } = await fresh.load();
    expect(settings.categoryNames).toEqual({});
    expect(settings.theme).toBe('dark');
    expect(store.getSettings().categoryNames).toEqual({});

    // And why it has to be '' rather than a dropped key: a patch that merely
    // omits the category has nothing to overrule the cloud's copy with.
    await store.saveSettings({ categoryNames: { red: 'Bills' } });
    const deviceC = createStore(kv);
    await deviceC.load();
    await deviceC.saveSettings({ categoryNames: {} });
    const after = await createStore(kv).load();
    expect(after.settings.categoryNames).toEqual({ red: 'Bills' });
  });

  it('renaming one category leaves one renamed elsewhere alone', async () => {
    await store.saveSettings({ categoryNames: { red: 'Bills' } });
    const deviceB = createStore(kv);
    await deviceB.load();
    await deviceB.saveSettings({ categoryNames: { red: 'Utilities' } });

    // This device never learned about 'Utilities' — its own copy still says
    // 'Bills'. Renaming a *different* category must not carry that stale name
    // along, which is why the patch names only the category it changed.
    await store.saveSettings({ categoryNames: { violet: 'Family' } });

    const fresh = createStore(kv);
    const { settings } = await fresh.load();
    expect(settings.categoryNames).toEqual({ red: 'Utilities', violet: 'Family' });
  });

  it('a categoryNames patch never blanks the names it says nothing about', async () => {
    await store.saveSettings({ categoryNames: { red: 'Bills' } });
    // Every state the sidebar renders from, the optimistic one included: a
    // patch for `violet` may not take 'Bills' off screen, not even for a frame.
    const seen = [];
    store.subscribe(() => seen.push(store.getSettings().categoryNames));
    await store.saveSettings({ categoryNames: { violet: 'Family' } });
    expect(seen.length).toBeGreaterThan(0);
    for (const names of seen) expect(names.red).toBe('Bills');
  });

  it('load() keeps only a string under bookingName, defaulting it to ""', async () => {
    expect(store.getSettings().bookingName).toBe('');
    kv.map.set('cal:settings', { bookingName: 42 });
    expect((await createStore(kv).load()).settings.bookingName).toBe('');
    kv.map.set('cal:settings', { bookingName: 'Nariman Jelveh' });
    expect((await createStore(kv).load()).settings.bookingName).toBe('Nariman Jelveh');
  });

  it('load() rejects the retired "all" mailInvites mode, falling back to "known"', async () => {
    kv.map.set('cal:settings', { mailInvites: 'all' });
    expect((await createStore(kv).load()).settings.mailInvites).toBe('known');
    kv.map.set('cal:settings', { mailInvites: 'never' });
    expect((await createStore(kv).load()).settings.mailInvites).toBe('never');
  });

  it('load() keeps only a real boolean under mailInvitesShowUnknown, defaulting it to false', async () => {
    expect(store.getSettings().mailInvitesShowUnknown).toBe(false);
    kv.map.set('cal:settings', { mailInvitesShowUnknown: 'yes' });
    expect((await createStore(kv).load()).settings.mailInvitesShowUnknown).toBe(false);
    kv.map.set('cal:settings', { mailInvitesShowUnknown: true });
    expect((await createStore(kv).load()).settings.mailInvitesShowUnknown).toBe(true);
  });

  it('load() keeps only a real boolean under showWeekNumbers, defaulting it to false', async () => {
    expect(store.getSettings().showWeekNumbers).toBe(false);
    kv.map.set('cal:settings', { showWeekNumbers: 'yes' });
    expect((await createStore(kv).load()).settings.showWeekNumbers).toBe(false);
    kv.map.set('cal:settings', { showWeekNumbers: true });
    expect((await createStore(kv).load()).settings.showWeekNumbers).toBe(true);
  });

  it('load() cleans a categoryNames map that came in hand-written', async () => {
    kv.map.set('cal:settings', {
      categoryNames: {
        violet: '  Family  ', // trimmed
        chartreuse: 'Nope', // not a palette key
        red: 42, // not a string
        green: 'Green', // the palette default carries no information
        teal: 'x'.repeat(50), // capped
      },
    });

    const fresh = createStore(kv);
    const { settings } = await fresh.load();
    expect(settings.categoryNames).toEqual({
      violet: 'Family',
      teal: 'x'.repeat(MAX_CATEGORY_NAME),
    });
  });

  it('rapid successive settings saves on one device all land', async () => {
    await Promise.all([store.saveSettings({ theme: 'dark' }), store.saveSettings({ hour12: false })]);
    const fresh = createStore(kv);
    const { settings } = await fresh.load();
    expect(settings.theme).toBe('dark');
    expect(settings.hour12).toBe(false);
  });

  it('notifies subscribers on change', async () => {
    const spy = vi.fn();
    const unsub = store.subscribe(spy);
    await store.saveEvent({ title: 'X', start: day, end: day + H });
    expect(spy).toHaveBeenCalled();
    unsub();
    spy.mockClear();
    await store.saveEvent({ title: 'Y', start: day, end: day + H });
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores malformed persisted entries on load', async () => {
    const dirty = makeKv({
      'cal:evt:bad': 'not-json{',
      'cal:evt:ok': { id: 'ok', title: 'Fine', start: day, end: day + H, color: 'teal' },
    });
    const s = createStore(dirty);
    await s.load();
    expect(s.getAllEvents().map((e) => e.id)).toEqual(['ok']);
  });

  it('load survives puter.kv.list silently truncating a big flat result', async () => {
    // Live puter.kv returned 1,085 of 2,139 stored keys for one flat list —
    // deterministically, with no error. Simulate a cut at 550 (the guards sit
    // at half the observed live cut point, so a big flat result always lands
    // in suspect territory). The store must shard by id prefix and see all 600.
    const hex = '0123456789abcdef';
    const seed = {};
    for (let i = 0; i < 600; i++) {
      const id = `${hex[i % 16]}${String(i).padStart(4, '0')}`;
      seed[`cal:evt:${id}`] = { id, title: `E${i}`, start: day + i, end: day + i + H };
    }
    const truncating = makeKv(seed);
    const realList = truncating.list.getMockImplementation();
    truncating.list.mockImplementation(async (pattern, rv) => (await realList(pattern, rv)).slice(0, 550));
    const s = createStore(truncating);
    await s.load();
    expect(s.getAllEvents()).toHaveLength(600);
  });

  it('load shards on payload size too, not just entry count', async () => {
    // The live cut point tracks response size: fat values get truncated at far
    // fewer entries than LIST_SUSPECT_COUNT. 120 events × ~5KB ≈ 600KB must
    // trigger sharding even though 120 is a "small" count.
    const hex = '0123456789abcdef';
    const seed = {};
    for (let i = 0; i < 120; i++) {
      const id = `${hex[i % 16]}${String(i).padStart(4, '0')}`;
      seed[`cal:evt:${id}`] = { id, title: `E${i}`, description: 'x'.repeat(5000), start: day + i, end: day + i + H };
    }
    const truncating = makeKv(seed);
    const realList = truncating.list.getMockImplementation();
    truncating.list.mockImplementation(async (pattern, rv) => (await realList(pattern, rv)).slice(0, 110));
    const s = createStore(truncating);
    await s.load();
    expect(s.getAllEvents()).toHaveLength(120);
  });

  it('load shards when values are big only in UTF-8 bytes (non-ASCII undercount)', async () => {
    // '汉' is one UTF-16 code unit but three UTF-8 bytes. 100 returned entries
    // × 3,000 CJK chars ≈ 310K code units — under the byte guard if measured
    // with .length — but ~910KB on the wire, well past the observed cut point.
    const hex = '0123456789abcdef';
    const seed = {};
    for (let i = 0; i < 150; i++) {
      const id = `${hex[i % 16]}${String(i).padStart(4, '0')}`;
      seed[`cal:evt:${id}`] = { id, title: `E${i}`, description: '汉'.repeat(3000), start: day + i, end: day + i + H };
    }
    const truncating = makeKv(seed);
    const realList = truncating.list.getMockImplementation();
    truncating.list.mockImplementation(async (pattern, rv) => (await realList(pattern, rv)).slice(0, 100));
    const s = createStore(truncating);
    await s.load();
    expect(s.getAllEvents()).toHaveLength(150);
  });

  it('importEvents treats a bare { error: "Too many requests." } rejection as rate-limited', async () => {
    // No `code`, no `message` — only the `error` text. Must still get the full
    // rate-limit retry budget (a generic error would give up after 2 attempts).
    vi.useFakeTimers();
    try {
      let failures = 2;
      kv.set.mockImplementation(async (items) => {
        if (failures > 0) {
          failures--;
          throw { error: 'Too many requests.' };
        }
        for (const { key, value } of items) kv.map.set(key, value);
        return true;
      });
      const p = store.importEvents([{ title: 'A', start: day, end: day + H }]);
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res).toMatchObject({ imported: 1, failed: 0 }); // landed on attempt 3
      expect(kv.set).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('load keeps the single-request fast path for small calendars', async () => {
    const small = makeKv({
      'cal:evt:a1': { id: 'a1', title: 'One', start: day, end: day + H },
    });
    const s = createStore(small);
    await s.load();
    expect(s.getAllEvents()).toHaveLength(1);
    // One flat list for events + one for tasks — no sharded fan-out.
    expect(small.list).toHaveBeenCalledTimes(2);
  });

  it('importEvents skips undated entries instead of stamping them at "now"', async () => {
    // Mirrors an .ics VEVENT with a missing/unparseable DTSTART (start = NaN).
    const res = await store.importEvents([
      { title: 'No start', start: NaN, end: NaN },
      { title: 'No start field' },
      { title: 'Real', start: day + 9 * H, end: day + 10 * H },
    ]);
    expect(res).toMatchObject({ imported: 1, failed: 0 }); // only the dated one; count is honest
    expect(store.getAllEvents().map((e) => e.title)).toEqual(['Real']);
  });

  it('importEvents batches writes into a few sequential requests', async () => {
    // puter.kv 429s an import fired as one request per event; batch-set instead.
    let inflight = 0;
    let maxInflight = 0;
    kv.set.mockImplementation(async (items) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 1));
      inflight--;
      for (const { key, value } of items) kv.map.set(key, value);
      return true;
    });
    const list = Array.from({ length: 60 }, (_, i) => ({
      title: `E${i}`,
      start: day + i * H,
      end: day + (i + 1) * H,
    }));
    const res = await store.importEvents(list);
    expect(res).toMatchObject({ imported: 60, failed: 0 });
    expect(kv.set.mock.calls.map((c) => c[0].length)).toEqual([25, 25, 10]); // 3 requests, not 60
    expect(maxInflight).toBe(1); // strictly sequential — no burst for the limiter to reject
    expect([...kv.map.keys()].filter((k) => k.startsWith('cal:evt:'))).toHaveLength(60);
  });

  it('importEvents reports progress after each persisted batch', async () => {
    const ticks = [];
    const list = Array.from({ length: 30 }, (_, i) => ({
      title: `E${i}`,
      start: day + i * H,
      end: day + (i + 1) * H,
    }));
    const res = await store.importEvents(list, { onProgress: (done, total) => ticks.push([done, total]) });
    expect(res.imported).toBe(30);
    expect(ticks).toEqual([
      [25, 30],
      [30, 30],
    ]);
  });

  it('importEvents retries rate-limited batches and still lands them', async () => {
    vi.useFakeTimers();
    try {
      // puter.kv rejects with a plain object, not an Error — match that shape.
      const rateLimit = { error: 'Too many requests.', message: 'Too many requests.', code: 'too_many_requests' };
      let failures = 1;
      kv.set.mockImplementation(async (items) => {
        if (failures > 0) {
          failures--;
          throw rateLimit;
        }
        for (const { key, value } of items) kv.map.set(key, value);
        return true;
      });
      const p = store.importEvents([
        { title: 'A', start: day, end: day + H },
        { title: 'B', start: day + H, end: day + 2 * H },
      ]);
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res).toMatchObject({ imported: 2, failed: 0 });
      expect(kv.set).toHaveBeenCalledTimes(2); // one 429, one success after backoff
      expect([...kv.map.keys()].filter((k) => k.startsWith('cal:evt:'))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('importEvents drops a chunk whose write never lands, so memory matches the cloud', async () => {
    vi.useFakeTimers();
    try {
      const rateLimit = { error: 'Too many requests.', message: 'Too many requests.', code: 'too_many_requests' };
      // 25 fine events fill the first chunk; 'Doomed' lands alone in the second,
      // which the kv rejects on every attempt.
      kv.set.mockImplementation(async (items) => {
        if (items.some((it) => it.value.title === 'Doomed')) throw rateLimit;
        for (const { key, value } of items) kv.map.set(key, value);
        return true;
      });
      const list = Array.from({ length: 25 }, (_, i) => ({
        title: `Fine ${i}`,
        start: day + i * H,
        end: day + (i + 1) * H,
      }));
      list.push({ title: 'Doomed', start: day, end: day + H });
      const p = store.importEvents(list);
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res.imported).toBe(25);
      expect(res.failed).toBe(1);
      expect(res.failedEvents.map((e) => e.title)).toEqual(['Doomed']);
      expect(store.getAllEvents().some((e) => e.title === 'Doomed')).toBe(false);
      expect(store.getAllEvents()).toHaveLength(25);

      // failedEvents feeds the "Retry failed" flow: importing them once the
      // limit clears adds only the missing event — no duplicates of the rest.
      kv.set.mockImplementation(async (items) => {
        for (const { key, value } of items) kv.map.set(key, value);
        return true;
      });
      const retry = await store.importEvents(res.failedEvents);
      expect(retry.imported).toBe(1);
      expect(store.getAllEvents()).toHaveLength(26);
      expect(store.getAllEvents().filter((e) => e.title === 'Doomed')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('normalizeEvent — recurrence fields', () => {
  it('carries a validated rule plus exdates/overrides', () => {
    const e = normalizeEvent({
      title: 'Sync',
      start: day + 9 * H,
      end: day + 10 * H,
      recurrence: { freq: 'weekly', interval: 1 },
      exdates: [day + 9 * H, 'nope', day + 9 * H],
      overrides: { [day + 9 * H]: { title: 'x', bogus: 1, start: day + 11 * H } },
    });
    expect(e.recurrence).toMatchObject({ freq: 'weekly', interval: 1 });
    expect(e.exdates).toEqual([day + 9 * H]); // finite + deduped
    expect(e.overrides[day + 9 * H]).toEqual({ title: 'x', start: day + 11 * H });
    expect(e.overrides[day + 9 * H].bogus).toBeUndefined();
  });

  it('omits recurrence structure for a plain event', () => {
    const e = normalizeEvent({ title: 'Once', start: day, end: day + H });
    expect(e.recurrence).toBeUndefined();
    expect(e.exdates).toBeUndefined();
    expect(e.overrides).toBeUndefined();
  });
});

describe('createStore — recurring series', () => {
  let kv;
  let store;
  const mon = new Date(2026, 6, 13, 9, 0); // Monday
  const monMs = mon.getTime();

  beforeEach(async () => {
    kv = makeKv();
    store = createStore(kv);
    await store.load();
  });

  async function makeWeekly(extra = {}) {
    return store.saveEvent({
      title: 'Standup',
      start: monMs,
      end: monMs + H,
      color: 'blue',
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] },
      ...extra,
    });
  }

  it('expands a series into occurrences within a range', async () => {
    await makeWeekly();
    const from = new Date(2026, 6, 1).getTime();
    const to = new Date(2026, 6, 31).getTime();
    const occ = store.getEventsInRange(from, to);
    // Mondays in July 2026: 13, 20, 27 (6 is before the series start).
    expect(occ.map((o) => new Date(o.start).getDate())).toEqual([13, 20, 27]);
    expect(occ.every((o) => o.seriesId && o.isOccurrence)).toBe(true);
  });

  it('hides occurrences whose color is filtered out', async () => {
    await makeWeekly();
    await store.saveSettings({ hiddenColors: ['blue'] });
    const occ = store.getEventsInRange(monMs, new Date(2026, 6, 31).getTime());
    expect(occ).toHaveLength(0);
  });

  it('resolves an occurrence id through getEvent', async () => {
    const m = await makeWeekly();
    const rid = new Date(2026, 6, 20, 9, 0).getTime();
    const occ = store.getEvent(`${m.id}::${rid}`);
    expect(occ.recurrenceId).toBe(rid);
    expect(occ.seriesId).toBe(m.id);
    expect(store.getEvent(`${m.id}::not-a-number`)).toBeNull();
  });

  it('updateOccurrence writes an override visible in range', async () => {
    const m = await makeWeekly();
    const rid = new Date(2026, 6, 20, 9, 0).getTime();
    const moved = new Date(2026, 6, 20, 14, 0).getTime();
    await store.updateOccurrence(m.id, rid, { title: 'Moved', start: moved, end: moved + H });

    const occ = store
      .getEventsInRange(monMs, new Date(2026, 6, 31).getTime())
      .find((o) => o.recurrenceId === rid);
    expect(occ.title).toBe('Moved');
    expect(new Date(occ.start).getHours()).toBe(14);
    // Siblings untouched.
    const sib = store.getEventsInRange(monMs, new Date(2026, 6, 31).getTime());
    expect(sib.filter((o) => o.title === 'Standup')).toHaveLength(2); // 13 & 27
  });

  it('deleteOccurrence adds an exdate and its undo restores it', async () => {
    const m = await makeWeekly();
    const rid = new Date(2026, 6, 20, 9, 0).getTime();
    const { undo } = await store.deleteOccurrence(m.id, rid);
    let dates = store
      .getEventsInRange(monMs, new Date(2026, 6, 31).getTime())
      .map((o) => new Date(o.start).getDate());
    expect(dates).toEqual([13, 27]); // 20 gone
    await undo();
    dates = store
      .getEventsInRange(monMs, new Date(2026, 6, 31).getTime())
      .map((o) => new Date(o.start).getDate());
    expect(dates).toEqual([13, 20, 27]); // restored
  });

  it('undo of one occurrence edit preserves a sibling occurrence edited afterward', async () => {
    const m = await makeWeekly();
    const ridA = new Date(2026, 6, 13, 9, 0).getTime();
    const ridB = new Date(2026, 6, 20, 9, 0).getTime();
    const resA = await store.updateOccurrence(m.id, ridA, { title: 'A moved' });
    // A second edit to a DIFFERENT occurrence lands while A's undo is still live.
    await store.updateOccurrence(m.id, ridB, { title: 'B moved' });
    await resA.undo(); // undo only A
    const occ = store.getEventsInRange(monMs, new Date(2026, 6, 31).getTime());
    const byRid = (r) => occ.find((o) => o.recurrenceId === r);
    expect(byRid(ridA).title).toBe('Standup'); // A reverted
    expect(byRid(ridB).title).toBe('B moved'); // B preserved (whole-snapshot undo would wipe it)
  });

  it('undo of a cancelled occurrence preserves a sibling edited afterward', async () => {
    const m = await makeWeekly();
    const ridA = new Date(2026, 6, 13, 9, 0).getTime();
    const ridB = new Date(2026, 6, 20, 9, 0).getTime();
    const resA = await store.deleteOccurrence(m.id, ridA);
    await store.updateOccurrence(m.id, ridB, { title: 'B moved' });
    await resA.undo();
    const occ = store.getEventsInRange(monMs, new Date(2026, 6, 31).getTime());
    expect(occ.map((o) => new Date(o.start).getDate())).toContain(13); // A restored
    expect(occ.find((o) => o.recurrenceId === ridB).title).toBe('B moved'); // B preserved
  });

  it('an override with end <= start still yields a positive-duration occurrence', async () => {
    const m = await makeWeekly();
    const rid = new Date(2026, 6, 20, 9, 0).getTime();
    await store.updateOccurrence(m.id, rid, { start: rid, end: rid - H }); // corrupt: end before start
    const occ = store
      .getEventsInRange(monMs, new Date(2026, 6, 31).getTime())
      .find((o) => o.recurrenceId === rid);
    expect(occ.end).toBeGreaterThan(occ.start);
  });

  it('updateFuture splits the series into two masters', async () => {
    const m = await makeWeekly();
    const rid = new Date(2026, 6, 20, 9, 0).getTime();
    const res = await store.updateFuture(m.id, rid, {
      title: 'Renamed',
      color: 'red',
      start: rid,
      end: rid + H,
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] },
    });
    // Two stored masters now.
    const masters = store.getAllEvents().filter((e) => e.recurrence);
    expect(masters).toHaveLength(2);

    const occ = store.getEventsInRange(monMs, new Date(2026, 6, 31).getTime());
    const byTitle = (t) => occ.filter((o) => o.title === t).map((o) => new Date(o.start).getDate());
    expect(byTitle('Standup')).toEqual([13]); // original truncated before the split
    expect(byTitle('Renamed')).toEqual([20, 27]); // new series from the split
    expect(occ.find((o) => o.title === 'Renamed').color).toBe('red');

    await res.undo();
    const after = store.getAllEvents().filter((e) => e.recurrence);
    expect(after).toHaveLength(1);
    expect(
      store
        .getEventsInRange(monMs, new Date(2026, 6, 31).getTime())
        .map((o) => new Date(o.start).getDate()),
    ).toEqual([13, 20, 27]);
  });

  it('updateFuture fails toward duplication, never loss, when its second write dies', async () => {
    // The split needs two KV writes, which can't be atomic. The tail must land
    // FIRST: if the truncation write then fails, the cloud holds the full
    // original plus the tail (visible duplicates, fixable). The other order —
    // a truncation that lands without its tail — silently and permanently
    // drops every occurrence from the split onward on the next load.
    const m = await makeWeekly();
    const rid = new Date(2026, 6, 20, 9, 0).getTime();
    const realSet = kv.set.getMockImplementation();
    let eventWrites = 0;
    kv.set.mockImplementation(async (k, v) => {
      if (typeof k === 'string' && k.startsWith('cal:evt:') && ++eventWrites === 2) {
        throw new Error('network');
      }
      return realSet(k, v);
    });
    await expect(store.updateFuture(m.id, rid, { title: 'Renamed' })).rejects.toThrow('network');
    kv.set.mockImplementation(realSet);

    // Reload from the cloud alone: the original series must still be whole.
    const fresh = createStore(kv);
    await fresh.load();
    const dates = fresh
      .getEventsInRange(monMs, new Date(2026, 6, 31).getTime())
      .map((o) => new Date(o.start).getDate())
      .sort((a, b) => a - b);
    expect(dates).toEqual([13, 20, 20, 27, 27]); // full original + tail — nothing lost
  });

  it('truncates a split series to the end of the PREVIOUS day (date-semantic until)', async () => {
    // Regression: the truncated rule used `rid - 1`, a mid-morning instant ON
    // the split date for a timed series. The Repeat label / custom dialog then
    // showed the split date as still included, and a no-op round-trip through
    // the dialog (which rebuilds until = endOfDay(shown date)) resurrected the
    // split occurrence.
    const m = await makeWeekly();
    const rid = new Date(2026, 6, 20, 9, 0).getTime();

    const res = await store.updateFuture(m.id, rid, { title: 'Renamed' });
    const endOfJul19 = new Date(2026, 6, 20).getTime() - 1;
    expect(res.truncated.recurrence.until).toBe(endOfJul19);

    // The dialog round-trip must now be a true no-op: rebuilding the bound as
    // end-of-day of the date it displays keeps Jul 20 out of the old series.
    const shownDay = new Date(res.truncated.recurrence.until);
    const rebuiltUntil = new Date(
      shownDay.getFullYear(), shownDay.getMonth(), shownDay.getDate(), 23, 59, 59, 999,
    ).getTime();
    await store.updateSeries(res.truncated.id, {
      recurrence: { ...res.truncated.recurrence, until: rebuiltUntil },
    });
    const occ = store.getEventsInRange(monMs, new Date(2026, 6, 31).getTime());
    const standupDates = occ.filter((o) => o.title === 'Standup').map((o) => new Date(o.start).getDate());
    expect(standupDates).toEqual([13]); // Jul 20 must NOT resurrect on the old series
  });

  it('deleteFuture also writes an end-of-previous-day until', async () => {
    const m = await makeWeekly();
    const rid = new Date(2026, 6, 20, 9, 0).getTime();
    const res = await store.deleteFuture(m.id, rid);
    expect(res.event.recurrence.until).toBe(new Date(2026, 6, 20).getTime() - 1);
  });

  const hasSpringForward =
    new Date(2026, 0, 15, 12).getTimezoneOffset() !== new Date(2026, 2, 8, 12).getTimezoneOffset();
  it.runIf(hasSpringForward)(
    'updateFuture keeps future exceptions when splitting an all-day series on a DST day',
    async () => {
      // Regression: the tail is re-anchored on the split day, so an all-day
      // span covering a DST transition differs from the master's by an hour of
      // real time. The raw-ms duration comparison read that as a time change
      // and silently wiped the carried exdates/overrides.
      const jan15 = new Date(2026, 0, 15).getTime();
      const m = await store.saveEvent({
        title: 'Daily block',
        start: jan15,
        end: new Date(2026, 0, 16).getTime() - 1,
        allDay: true,
        recurrence: { freq: 'daily', interval: 1 },
      });
      const mar8 = new Date(2026, 2, 8).getTime(); // spring-forward day
      const mar10 = new Date(2026, 2, 10).getTime();
      const mar12 = new Date(2026, 2, 12).getTime();
      await store.deleteOccurrence(m.id, mar10);
      await store.updateOccurrence(m.id, mar12, { title: 'Renamed day' });

      // Content-only rename with the displayed span, exactly as the modal sends it.
      const res = await store.updateFuture(m.id, mar8, {
        title: 'Tail',
        start: mar8,
        end: new Date(2026, 2, 9).getTime() - 1,
        allDay: true,
        recurrence: { freq: 'daily', interval: 1 },
      });

      expect(res.event.exdates).toContain(mar10); // cancellation survives
      expect(Object.keys(res.event.overrides).map(Number)).toContain(mar12); // rename survives
      const occ = store.getEventsInRange(mar8, new Date(2026, 2, 14).getTime());
      expect(occ.some((o) => o.recurrenceId === mar10)).toBe(false);
      expect(occ.find((o) => o.recurrenceId === mar12).title).toBe('Renamed day');
    },
  );

  it('updateFuture carries the master ooo/declined flags onto the tail series', async () => {
    const m = await makeWeekly({ ooo: true, declined: true });
    const rid = new Date(2026, 6, 20, 9, 0).getTime();
    const res = await store.updateFuture(m.id, rid, { title: 'Renamed' });
    // Both the truncated original and the new tail must keep the flags.
    expect(res.truncated.ooo).toBe(true);
    expect(res.truncated.declined).toBe(true);
    expect(res.event.ooo).toBe(true);
    expect(res.event.declined).toBe(true);
  });

  it('updateFuture redistributes a count so the total is preserved', async () => {
    // Weekly on Monday, 4 times: Jul 13, 20, 27, Aug 3.
    const m = await store.saveEvent({
      title: 'Limited',
      start: monMs,
      end: monMs + H,
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [1], count: 4 },
    });
    const split = new Date(2026, 6, 27, 9, 0).getTime(); // 3rd occurrence
    await store.updateFuture(m.id, split, {
      title: 'Tail',
      start: split,
      end: split + H,
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [1], count: 4 },
    });
    const masters = store.getAllEvents().filter((e) => e.recurrence);
    const original = masters.find((e) => e.title === 'Limited');
    const tail = masters.find((e) => e.title === 'Tail');
    expect(original.recurrence.count).toBe(2); // Jul 13, 20
    expect(tail.recurrence.count).toBe(2); // Jul 27, Aug 3 — total still 4
    // Whole span shows exactly 4 occurrences.
    const all = store.getEventsInRange(monMs, new Date(2026, 7, 31).getTime());
    expect(all).toHaveLength(4);
  });

  it('updateFuture keeps an until bound when a series has both count and until', async () => {
    // Weekly on Monday bounded by BOTH count:6 and until:Aug 3 — until binds it
    // to 4 occurrences (Jul 13, 20, 27, Aug 3). Splitting must not resurrect the
    // occurrences beyond the until by carrying only the remaining count.
    const until = new Date(2026, 7, 3, 23, 59, 59, 999).getTime();
    const m = await store.saveEvent({
      title: 'Bounded',
      start: monMs,
      end: monMs + H,
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [1], count: 6, until },
    });
    const windowEnd = new Date(2026, 9, 30).getTime();
    expect(store.getEventsInRange(monMs, windowEnd).filter((e) => e.seriesId)).toHaveLength(4);
    const split = new Date(2026, 6, 27, 9, 0).getTime();
    await store.updateFuture(m.id, split, {}); // split only, no field change
    const after = store.getEventsInRange(monMs, windowEnd).filter((e) => e.seriesId);
    expect(after).toHaveLength(4); // still Jul 13, 20, 27, Aug 3 — no phantoms
    expect(after.map((o) => new Date(o.start).getDate())).toEqual([13, 20, 27, 3]);
  });

  it('updateFuture can drop the recurrence (this-and-following becomes a one-off)', async () => {
    const m = await makeWeekly();
    const rid = new Date(2026, 6, 20, 9, 0).getTime(); // 2nd occurrence
    const res = await store.updateFuture(m.id, rid, {
      title: 'Solo',
      start: rid,
      end: rid + H,
      recurrence: null,
    });
    expect(res).toBeTruthy();
    const occ = store.getEventsInRange(monMs, new Date(2026, 6, 31).getTime());
    const byTitle = (t) => occ.filter((o) => o.title === t).map((o) => new Date(o.start).getDate());
    expect(byTitle('Standup')).toEqual([13]); // original truncated before the split
    expect(byTitle('Solo')).toEqual([20]); // just the split occurrence, no repeats after
    const solo = store.getAllEvents().find((e) => e.title === 'Solo');
    expect(solo.recurrence).toBeUndefined(); // it is now a plain, non-recurring event
  });

  it('updateFuture from the first occurrence edits the whole series', async () => {
    const m = await makeWeekly();
    await store.updateFuture(m.id, monMs, {
      title: 'All',
      start: monMs,
      end: monMs + H,
      recurrence: m.recurrence,
    });
    expect(store.getAllEvents().filter((e) => e.recurrence)).toHaveLength(1);
    const occ = store.getEventsInRange(monMs, new Date(2026, 6, 31).getTime());
    expect(occ.every((o) => o.title === 'All')).toBe(true);
  });

  it('deleteFuture truncates the series', async () => {
    const m = await makeWeekly();
    const rid = new Date(2026, 6, 20, 9, 0).getTime();
    const { undo } = await store.deleteFuture(m.id, rid);
    expect(
      store
        .getEventsInRange(monMs, new Date(2026, 6, 31).getTime())
        .map((o) => new Date(o.start).getDate()),
    ).toEqual([13]); // 20 and 27 removed
    await undo();
    expect(
      store
        .getEventsInRange(monMs, new Date(2026, 6, 31).getTime())
        .map((o) => new Date(o.start).getDate()),
    ).toEqual([13, 20, 27]);
  });

  it('deleteFuture from the first occurrence removes the whole series', async () => {
    const m = await makeWeekly();
    await store.deleteFuture(m.id, monMs);
    expect(store.getAllEvents()).toHaveLength(0);
  });

  it('updateSeries changes content across occurrences, keeping exceptions', async () => {
    const m = await makeWeekly();
    const rid = new Date(2026, 6, 20, 9, 0).getTime();
    await store.updateOccurrence(m.id, rid, { title: 'Exception' });
    // Content-only series edit keeps the exception.
    await store.updateSeries(m.id, { color: 'green' });
    const occ = store.getEventsInRange(monMs, new Date(2026, 6, 31).getTime());
    expect(occ.every((o) => o.color === 'green')).toBe(true);
    expect(occ.find((o) => o.recurrenceId === rid).title).toBe('Exception'); // kept
  });

  it('updateSeries keeps exceptions on a content-only edit of a sub-minute-start series', async () => {
    // A series imported from ICS can carry seconds in its start (e.g. T090030).
    // The editor's time input is minute-granularity, so a content-only save
    // sends the minute-truncated start/end. That must NOT read as a time change
    // (which would clear the exception and shift the whole series by the dropped
    // seconds).
    const secStart = new Date(2026, 6, 13, 9, 0, 30).getTime();
    const m = await store.saveEvent({
      title: 'Imported',
      start: secStart,
      end: secStart + H,
      color: 'blue',
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] },
    });
    const rid = new Date(2026, 6, 20, 9, 0, 30).getTime();
    await store.updateOccurrence(m.id, rid, { title: 'Exception' });
    // Color-only edit — modal still sends the (minute-granularity) start/end.
    await store.updateSeries(m.id, {
      color: 'green',
      start: new Date(2026, 6, 13, 9, 0, 0).getTime(),
      end: new Date(2026, 6, 13, 10, 0, 0).getTime(),
      recurrence: m.recurrence,
    });
    const master = store.getEvent(m.id);
    expect(new Date(master.start).getSeconds()).toBe(30); // start not shifted
    expect(master.overrides[rid]).toBeTruthy(); // exception kept
    const occ = store.getEventsInRange(secStart, new Date(2026, 6, 31).getTime());
    expect(occ.every((o) => o.color === 'green')).toBe(true);
    expect(occ.find((o) => o.recurrenceId === rid).title).toBe('Exception');
  });

  it('updateSeries clears exceptions when the rule changes', async () => {
    const m = await makeWeekly();
    const rid = new Date(2026, 6, 20, 9, 0).getTime();
    await store.updateOccurrence(m.id, rid, { title: 'Exception' });
    await store.updateSeries(m.id, {
      start: monMs,
      end: monMs + H,
      recurrence: { freq: 'daily', interval: 1 },
    });
    const occ = store.getEventsInRange(monMs, new Date(2026, 6, 20).getTime());
    expect(occ.some((o) => o.title === 'Exception')).toBe(false); // exception cleared
    // Now daily.
    expect(occ.length).toBeGreaterThan(3);
  });
});

describe('cross-device merge-before-write (occurrence slices)', () => {
  // All per-occurrence state (exdates + overrides) rides in the ONE master KV
  // value, and a device's in-memory master can be a whole session stale — an
  // occurrence edit that rewrites the master from memory silently undoes what
  // every other device recorded since this one last loaded.
  const monMs = new Date(2026, 6, 13, 9, 0).getTime();
  const rid20 = new Date(2026, 6, 20, 9, 0).getTime();
  const rid27 = new Date(2026, 6, 27, 9, 0).getTime();

  async function twoDevices() {
    const kv = makeKv();
    const deviceA = createStore(kv);
    await deviceA.load();
    const m = await deviceA.saveEvent({
      title: 'Standup',
      start: monMs,
      end: monMs + H,
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] },
    });
    const deviceB = createStore(kv);
    await deviceB.load();
    return { kv, deviceA, deviceB, m };
  }

  it("an occurrence edit carries another device's cancellation forward instead of resurrecting it", async () => {
    const { kv, deviceA, deviceB, m } = await twoDevices();

    await deviceB.deleteOccurrence(m.id, rid20); // phone cancels Jul 20

    // Laptop — which never re-loaded and knows nothing of the cancellation —
    // renames Jul 27.
    await deviceA.updateOccurrence(m.id, rid27, { title: 'Retro' });

    const fresh = createStore(kv);
    await fresh.load();
    const master = fresh.getEvent(m.id);
    expect(master.exdates).toEqual([rid20]); // B's cancellation survived
    expect(master.overrides[rid27].title).toBe('Retro'); // A's edit landed
    // A's own memory was pulled forward to the merged truth as well.
    expect(deviceA.getEvent(m.id).exdates).toEqual([rid20]);
  });

  it("a cancellation carries another device's occurrence edit forward too", async () => {
    const { kv, deviceA, deviceB, m } = await twoDevices();

    await deviceB.updateOccurrence(m.id, rid20, { title: 'Moved earlier' });
    await deviceA.deleteOccurrence(m.id, rid27); // stale device cancels a sibling

    const fresh = createStore(kv);
    await fresh.load();
    const master = fresh.getEvent(m.id);
    expect(master.overrides[rid20].title).toBe('Moved earlier');
    expect(master.exdates).toEqual([rid27]);
  });

  it('the undo of an occurrence edit merges the same way', async () => {
    const { kv, deviceA, deviceB, m } = await twoDevices();

    const res = await deviceA.updateOccurrence(m.id, rid27, { title: 'Retro' });
    await deviceB.deleteOccurrence(m.id, rid20); // lands between edit and undo
    await res.undo();

    const fresh = createStore(kv);
    await fresh.load();
    const master = fresh.getEvent(m.id);
    expect(master.overrides[rid27]).toBeUndefined(); // the edit is undone
    expect(master.exdates).toEqual([rid20]); // the remote cancellation stands
  });

  it('still writes from memory when the cloud copy is unreadable (offline fallback)', async () => {
    const { kv, deviceA, m } = await twoDevices();
    kv.get.mockRejectedValue(new Error('net'));
    await deviceA.updateOccurrence(m.id, rid27, { title: 'Retro' });
    expect(kv.map.get('cal:evt:' + m.id).overrides[rid27].title).toBe('Retro');
  });

  it("an RSVP pull on a stale device carries the other device's pulled answers forward", async () => {
    const kv = makeKv();
    const deviceA = createStore(kv);
    await deviceA.load();
    const ev = await deviceA.saveEvent({
      title: 'Party',
      start: monMs,
      end: monMs + H,
      guests: [{ email: 'ada@x.com' }, { email: 'bob@x.com' }],
    });
    const deviceB = createStore(kv);
    await deviceB.load();

    // Device B pulls Ada's answer; stale device A then pulls only Bob's.
    await deviceB.applyRsvpResponses(ev.id, [{ email: 'ada@x.com', status: 'accepted', respondedAt: 5000 }]);
    await deviceA.applyRsvpResponses(ev.id, [{ email: 'bob@x.com', status: 'declined', respondedAt: 6000 }]);

    const fresh = createStore(kv);
    await fresh.load();
    const guests = fresh.getEvent(ev.id).guests;
    expect(guests.find((g) => g.email === 'ada@x.com').status).toBe('accepted');
    expect(guests.find((g) => g.email === 'bob@x.com').status).toBe('declined');
  });

  it("the user's own RSVP carries other guests' answers forward the same way", async () => {
    const kv = makeKv();
    const deviceA = createStore(kv);
    await deviceA.load();
    const ev = await deviceA.saveEvent({
      title: 'Party',
      start: monMs,
      end: monMs + H,
      organizer: { email: 'host@x.com' },
      guests: [{ email: 'me@x.com' }, { email: 'ada@x.com' }],
    });
    const deviceB = createStore(kv);
    await deviceB.load();

    await deviceB.applyRsvpResponses(ev.id, [{ email: 'ada@x.com', status: 'accepted', respondedAt: 5000 }]);
    await deviceA.rsvpEvent(ev.id, 'declined', 'me@x.com'); // stale device answers

    const fresh = createStore(kv);
    await fresh.load();
    const master = fresh.getEvent(ev.id);
    expect(master.guests.find((g) => g.email === 'me@x.com').status).toBe('declined');
    expect(master.guests.find((g) => g.email === 'ada@x.com').status).toBe('accepted');
    expect(master.declined).toBe(true); // the "No" still dims the event
  });
});

describe('normalizeTask', () => {
  it('fills defaults and marks isTask', () => {
    const t = normalizeTask({ title: 'Buy milk' }, day);
    expect(t.id).toBeTruthy();
    expect(t.title).toBe('Buy milk');
    expect(t.done).toBe(false);
    expect(t.color).toBe(DEFAULT_COLOR);
    expect(t.isTask).toBe(true);
    expect(t.due).toBe(day);
  });

  it('snaps an all-day task due to the start of its day', () => {
    const t = normalizeTask({ title: 'x', allDay: true, due: new Date(2026, 6, 12, 15, 30).getTime() });
    expect(t.allDay).toBe(true);
    expect(t.due).toBe(new Date(2026, 6, 12, 0, 0, 0, 0).getTime());
  });

  it('keeps the exact due for a timed task', () => {
    const due = new Date(2026, 6, 12, 15, 30).getTime();
    const t = normalizeTask({ title: 'x', allDay: false, due });
    expect(t.due).toBe(due);
  });

  it('clamps overly long strings and rejects invalid colors', () => {
    const t = normalizeTask({ title: 'a'.repeat(999), notes: 'b'.repeat(9999), color: 'nope' });
    expect(t.title).toHaveLength(500);
    expect(t.notes).toHaveLength(5000);
    expect(t.color).toBe(DEFAULT_COLOR);
  });
});

describe('createStore — tasks', () => {
  let store;
  beforeEach(async () => {
    store = createStore(makeKv());
    await store.load();
  });

  it('creates and persists a task under its own prefix', async () => {
    const t = await store.saveTask({ title: 'Task A', due: day });
    expect(store.getAllTasks()).toHaveLength(1);
    expect(store.getTask(t.id).title).toBe('Task A');
  });

  it('does not surface tasks through event queries (isolation)', async () => {
    await store.saveTask({ title: 'Task', due: new Date(2026, 6, 12, 9).getTime() });
    await store.saveEvent({ title: 'Event', start: new Date(2026, 6, 12, 9).getTime(), end: new Date(2026, 6, 12, 10).getTime() });
    const evs = store.getEventsInRange(day, new Date(2026, 6, 13).getTime());
    expect(evs).toHaveLength(1);
    expect(evs[0].title).toBe('Event');
    expect(evs.some((e) => e.isTask)).toBe(false);
  });

  it('getTasksInRange honors the half-open window and sorts open-before-done', async () => {
    await store.saveTask({ title: 'Done early', due: new Date(2026, 6, 12, 8).getTime(), done: true });
    await store.saveTask({ title: 'Open late', due: new Date(2026, 6, 12, 18).getTime() });
    await store.saveTask({ title: 'Open early', due: new Date(2026, 6, 12, 9).getTime() });
    await store.saveTask({ title: 'Next day', due: new Date(2026, 6, 13, 9).getTime() });
    const inDay = store.getTasksInRange(day, new Date(2026, 6, 13).getTime());
    expect(inDay.map((t) => t.title)).toEqual(['Open early', 'Open late', 'Done early']);
  });

  it('hides tasks whose color is filtered out, like events', async () => {
    // Unchecking "Indigo" in Categories took every Indigo event off the
    // calendar but left the Indigo tasks: the task query skipped the filter.
    const at = new Date(2026, 6, 12, 9).getTime();
    await store.saveTask({ title: 'Indigo task', due: at, color: 'indigo' });
    await store.saveTask({ title: 'Red task', due: at, color: 'red' });
    await store.saveSettings({ hiddenColors: ['indigo'] });

    const visible = store.getTasksInRange(day, new Date(2026, 6, 13).getTime());
    expect(visible.map((t) => t.title)).toEqual(['Red task']);

    const all = store.getTasksInRange(day, new Date(2026, 6, 13).getTime(), { includeHidden: true });
    expect(all.map((t) => t.title).sort()).toEqual(['Indigo task', 'Red task']);
  });

  it('toggleTask flips done and persists', async () => {
    const t = await store.saveTask({ title: 'x', due: day });
    const toggled = await store.toggleTask(t.id);
    expect(toggled.done).toBe(true);
    expect(store.getTask(t.id).done).toBe(true);
    await store.toggleTask(t.id);
    expect(store.getTask(t.id).done).toBe(false);
  });

  it('deleteTask removes it', async () => {
    const t = await store.saveTask({ title: 'x', due: day });
    await store.deleteTask(t.id);
    expect(store.getAllTasks()).toHaveLength(0);
    expect(store.getTask(t.id)).toBeNull();
  });

  it('reloads tasks from the backend', async () => {
    const kv = makeKv();
    const s1 = createStore(kv);
    await s1.load();
    await s1.saveTask({ title: 'Persisted', due: day });
    const s2 = createStore(kv);
    await s2.load();
    expect(s2.getAllTasks().map((t) => t.title)).toEqual(['Persisted']);
  });

  it('notifies subscribers on task change', async () => {
    let n = 0;
    store.subscribe(() => n++);
    await store.saveTask({ title: 'x', due: day });
    expect(n).toBeGreaterThan(0);
  });
});

describe('out of office', () => {
  let kv;
  let store;
  beforeEach(async () => {
    kv = makeKv();
    store = createStore(kv);
    await store.load();
  });

  it('normalizeEvent defaults ooo and declined to false', () => {
    const e = normalizeEvent({ start: day, end: day + H });
    expect(e.ooo).toBe(false);
    expect(e.declined).toBe(false);
    expect(normalizeEvent({ start: day, ooo: true, declined: true }).ooo).toBe(true);
  });

  it('applyOutOfOffice declines overlapping plain timed events, with undo', async () => {
    const ooo = await store.saveEvent({ title: 'OOO', start: day + 9 * H, end: day + 17 * H, ooo: true });
    const inside = await store.saveEvent({ title: 'Meeting', start: day + 10 * H, end: day + 11 * H });
    const outside = await store.saveEvent({ title: 'Evening', start: day + 20 * H, end: day + 21 * H });

    const res = await store.applyOutOfOffice(ooo);
    expect(res.declined).toEqual([inside.id]);
    expect(store.getEvent(inside.id).declined).toBe(true);
    expect(store.getEvent(outside.id).declined).toBe(false);
    expect(store.getEvent(ooo.id).declined).toBe(false); // the OOO itself is never declined

    await res.undo();
    expect(store.getEvent(inside.id).declined).toBe(false);
  });

  it('applyOutOfOffice leaves all-day, recurring, and other OOO events alone', async () => {
    const ooo = await store.saveEvent({ title: 'OOO', start: day, end: day + 24 * H, ooo: true });
    const allDay = await store.saveEvent({ title: 'Holiday', start: day, end: day + 24 * H - 1, allDay: true });
    const series = await store.saveEvent({ title: 'Standup', start: day + 9 * H, end: day + 9.5 * H, recurrence: { freq: 'daily', interval: 1 } });
    const otherOoo = await store.saveEvent({ title: 'OOO2', start: day + 12 * H, end: day + 13 * H, ooo: true });

    const res = await store.applyOutOfOffice(ooo);
    expect(res.declined).toEqual([]);
    expect(store.getEvent(allDay.id).declined).toBe(false);
    expect(store.getEvent(series.id).declined).toBe(false);
    expect(store.getEvent(otherOoo.id).declined).toBe(false);
  });

  it('undo reverts only the declined flag, preserving a concurrent edit', async () => {
    const ooo = await store.saveEvent({ title: 'OOO', start: day + 9 * H, end: day + 17 * H, ooo: true });
    const inside = await store.saveEvent({ title: 'Meeting', start: day + 10 * H, end: day + 11 * H });
    const res = await store.applyOutOfOffice(ooo);
    expect(store.getEvent(inside.id).declined).toBe(true);

    // The user renames the auto-declined event while the Undo toast is still up.
    await store.saveEvent({ ...store.getEvent(inside.id), title: 'Renamed' });

    await res.undo();
    const after = store.getEvent(inside.id);
    expect(after.declined).toBe(false); // the flag we set is reverted
    expect(after.title).toBe('Renamed'); // the concurrent edit is preserved, not clobbered
  });

  it('undo does not resurrect an event deleted during the undo window', async () => {
    const ooo = await store.saveEvent({ title: 'OOO', start: day + 9 * H, end: day + 17 * H, ooo: true });
    const inside = await store.saveEvent({ title: 'Meeting', start: day + 10 * H, end: day + 11 * H });
    const res = await store.applyOutOfOffice(ooo);

    await store.deleteEvent(inside.id); // deleted while the Undo toast is still up
    await res.undo();
    expect(store.getEvent(inside.id)).toBeNull(); // stays deleted
  });

  // Repeating blocks. `day` is a Sunday; Fri Jul 17 2026 is the Friday after it.
  const fri = new Date(2026, 6, 17).getTime();
  const D = 24 * H;
  const W = 7 * D;
  const fridayAfternoons = (extra = {}) =>
    store.saveEvent({
      title: 'Friday afternoons off',
      start: fri + 13 * H,
      end: fri + 17 * H,
      ooo: true,
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [5], count: 3 },
      ...extra,
    });

  it('a repeating block declines under every occurrence, not just the first', async () => {
    const ooo = await fridayAfternoons();
    const wk1 = await store.saveEvent({ title: 'wk1', start: fri + 14 * H, end: fri + 15 * H });
    const wk2 = await store.saveEvent({ title: 'wk2', start: fri + W + 15 * H, end: fri + W + 16 * H });
    const wk3Morning = await store.saveEvent({ title: 'wk3 am', start: fri + 2 * W + 9 * H, end: fri + 2 * W + 10 * H });
    const thursday = await store.saveEvent({ title: 'thu', start: fri + W - D + 14 * H, end: fri + W - D + 15 * H });
    const wk4 = await store.saveEvent({ title: 'wk4', start: fri + 3 * W + 14 * H, end: fri + 3 * W + 15 * H });

    const res = await store.applyOutOfOffice(ooo);
    expect([...res.declined].sort()).toEqual([wk1.id, wk2.id].sort());
    expect(store.getEvent(wk1.id).declined).toBe(true);
    expect(store.getEvent(wk2.id).declined).toBe(true);
    expect(store.getEvent(wk3Morning.id).declined).toBe(false); // outside the afternoon window
    expect(store.getEvent(thursday.id).declined).toBe(false); // wrong day
    expect(store.getEvent(wk4.id).declined).toBe(false); // past the series' count
    expect(store.getEvent(ooo.id).declined).toBe(false);

    await res.undo();
    expect(store.getEvent(wk1.id).declined).toBe(false);
    expect(store.getEvent(wk2.id).declined).toBe(false);
  });

  it('a repeating block skips cancelled occurrences and follows moved ones', async () => {
    const ooo = await fridayAfternoons();
    // Week 2 cancelled; week 3 moved to the Saturday.
    await store.deleteOccurrence(ooo.id, fri + W + 13 * H);
    await store.updateOccurrence(ooo.id, fri + 2 * W + 13 * H, {
      start: fri + 2 * W + D + 13 * H,
      end: fri + 2 * W + D + 17 * H,
    });
    const wk2 = await store.saveEvent({ title: 'wk2', start: fri + W + 14 * H, end: fri + W + 15 * H });
    const wk3Fri = await store.saveEvent({ title: 'wk3 fri', start: fri + 2 * W + 14 * H, end: fri + 2 * W + 15 * H });
    const wk3Sat = await store.saveEvent({ title: 'wk3 sat', start: fri + 2 * W + D + 14 * H, end: fri + 2 * W + D + 15 * H });

    const res = await store.applyOutOfOffice(store.getEvent(ooo.id));
    expect(res.declined).toEqual([wk3Sat.id]);
    expect(store.getEvent(wk2.id).declined).toBe(false);
    expect(store.getEvent(wk3Fri.id).declined).toBe(false);
  });

  it('an endless repeating block sweeps a year past today and no further', async () => {
    const ooo = await fridayAfternoons({ recurrence: { freq: 'daily', interval: 1 } });
    const near = await store.saveEvent({ title: 'near', start: fri + 300 * D + 14 * H, end: fri + 300 * D + 15 * H });
    const far = await store.saveEvent({ title: 'far', start: fri + 400 * D + 14 * H, end: fri + 400 * D + 15 * H });

    const res = await store.applyOutOfOffice(ooo, { now: fri });
    expect(res.declined).toEqual([near.id]);
    expect(store.getEvent(far.id).declined).toBe(false);
  });

  it('a single occurrence of a repeating block declines only its own window', async () => {
    const ooo = await fridayAfternoons();
    const wk1 = await store.saveEvent({ title: 'wk1', start: fri + 14 * H, end: fri + 15 * H });
    const wk2 = await store.saveEvent({ title: 'wk2', start: fri + W + 14 * H, end: fri + W + 15 * H });

    // What the views hand around (and the editor saves with scope "This event").
    const occ = store.getEventsInRange(fri, fri + D).find((e) => e.seriesId === ooo.id);
    expect(occ.ooo).toBe(true); // occurrences inherit the away marker
    const res = await store.applyOutOfOffice(occ);
    expect(res.declined).toEqual([wk1.id]);
    expect(store.getEvent(wk2.id).declined).toBe(false);
  });

  it('setDeclined toggles a single event', async () => {
    const e = await store.saveEvent({ title: 'x', start: day + H, end: day + 2 * H });
    await store.setDeclined(e.id, true);
    expect(store.getEvent(e.id).declined).toBe(true);
    await store.setDeclined(e.id, false);
    expect(store.getEvent(e.id).declined).toBe(false);
  });

  it('persists the declines in batched writes, not one request per event', async () => {
    // puter.kv 429s a burst of one-request-per-event writes (the reason
    // importEvents batches); a wide OOO over a busy calendar must not fire one.
    const ooo = await store.saveEvent({ title: 'OOO', start: day, end: day + 24 * H, ooo: true });
    const insiders = [];
    for (let i = 0; i < 30; i++) {
      insiders.push(await store.saveEvent({ title: `m${i}`, start: day + i * 0.5 * H, end: day + (i * 0.5 + 0.4) * H }));
    }
    kv.set.mockClear();
    const res = await store.applyOutOfOffice(ooo);
    expect(res.declined).toHaveLength(30);
    expect(kv.set.mock.calls.length).toBeLessThanOrEqual(2); // 30 events / 25-chunk = 2 batches
    expect(kv.set.mock.calls.every(([k]) => Array.isArray(k))).toBe(true);

    kv.set.mockClear();
    await res.undo();
    expect(kv.set.mock.calls.length).toBeLessThanOrEqual(2);
    expect(kv.set.mock.calls.every(([k]) => Array.isArray(k))).toBe(true);
  });

  it('rolls everything back when the declines cannot be persisted', async () => {
    const ooo = await store.saveEvent({ title: 'OOO', start: day + 9 * H, end: day + 17 * H, ooo: true });
    const inside = await store.saveEvent({ title: 'Meeting', start: day + 10 * H, end: day + 11 * H });

    // Every write fails hard (not a rate limit — no retry budget to sit out).
    kv.set.mockRejectedValue(new Error('kv down'));
    await expect(store.applyOutOfOffice(ooo)).rejects.toThrow();
    // Memory is reverted: no event left half-declined for the next load to
    // disagree with, and no dangling undo the caller never received.
    expect(store.getEvent(inside.id).declined).toBe(false);
  });
});

describe('RSVP: organizer, guests, rsvpEvent', () => {
  const H2 = 3_600_000;
  const d = new Date(2026, 6, 12).getTime();

  it('normalizes guests: dedupes, lowercases, validates status and email', () => {
    const e = normalizeEvent({
      start: d,
      end: d + H2,
      organizer: { email: ' Boss@Corp.COM ', name: '  Boss  ' },
      guests: [
        { email: 'A@x.com', name: 'Ada', status: 'accepted' },
        { email: 'a@x.com', status: 'declined' }, // dup of the first
        { email: 'not-an-email', status: 'accepted' }, // dropped
        { email: 'b@x.com', status: 'bogus-status' }, // status coerced
        'garbage',
      ],
    });
    expect(e.organizer).toEqual({ email: 'boss@corp.com', name: 'Boss' });
    expect(e.guests).toEqual([
      { email: 'a@x.com', name: 'Ada', status: 'accepted' },
      { email: 'b@x.com', status: 'needs-action' },
    ]);
  });

  it('defaults to no organizer and no guests, leaving existing events untouched', () => {
    const e = normalizeEvent({ start: d, end: d + H2 });
    expect(e.organizer).toBeNull();
    expect(e.guests).toEqual([]);
  });

  it('rsvpEvent updates my guest entry and mirrors No onto declined', async () => {
    const kv = makeKv();
    const store = createStore(kv);
    await store.load();
    const saved = await store.saveEvent({
      title: 'Invite',
      start: d,
      end: d + H2,
      organizer: { email: 'boss@corp.com' },
      guests: [
        { email: 'me@corp.com', status: 'needs-action' },
        { email: 'peer@corp.com', status: 'accepted' },
      ],
    });

    const declinedEv = await store.rsvpEvent(saved.id, 'declined', 'ME@corp.com');
    expect(declinedEv.guests.find((g) => g.email === 'me@corp.com').status).toBe('declined');
    expect(declinedEv.guests.find((g) => g.email === 'peer@corp.com').status).toBe('accepted');
    expect(declinedEv.declined).toBe(true);

    const acceptedEv = await store.rsvpEvent(saved.id, 'accepted', 'me@corp.com');
    expect(acceptedEv.guests.find((g) => g.email === 'me@corp.com').status).toBe('accepted');
    expect(acceptedEv.declined).toBe(false);

    // Not a guest / bad status → no-op.
    expect(await store.rsvpEvent(saved.id, 'accepted', 'stranger@x.com')).toBeNull();
    expect(await store.rsvpEvent(saved.id, 'partying', 'me@corp.com')).toBeNull();
  });

  it('updateSeries carries a guest-list change onto the master', async () => {
    const kv = makeKv();
    const store = createStore(kv);
    await store.load();
    const master = await store.saveEvent({
      title: 'Weekly',
      start: d + 9 * H2,
      end: d + 10 * H2,
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [0] },
    });
    await store.updateSeries(master.id, {
      guests: [{ email: 'team@corp.com', status: 'needs-action' }],
      organizer: { email: 'me@corp.com' },
    });
    const after = store.getEvent(master.id);
    expect(after.guests).toEqual([{ email: 'team@corp.com', status: 'needs-action' }]);
    expect(after.organizer).toEqual({ email: 'me@corp.com' });
    expect(after.recurrence).toBeTruthy();
  });

  it('normalizeEvent keeps a guest\'s rsvpAt and comment (link responses survive)', () => {
    const e = normalizeEvent({
      start: d,
      end: d + H2,
      guests: [
        { email: 'a@x.com', status: 'tentative', rsvpAt: 123.7, comment: '  running late  ' },
        { email: 'b@x.com', status: 'accepted', rsvpAt: 'soon', comment: '' },
      ],
    });
    expect(e.guests[0]).toEqual({
      email: 'a@x.com',
      status: 'tentative',
      rsvpAt: 124,
      comment: 'running late',
    });
    expect(e.guests[1]).toEqual({ email: 'b@x.com', status: 'accepted' });
  });
});

describe('applyRsvpResponses', () => {
  const H2 = 3_600_000;
  const d = new Date(2026, 6, 12).getTime();

  async function seeded() {
    const kv = makeKv();
    const store = createStore(kv);
    await store.load();
    const saved = await store.saveEvent({
      title: 'Party',
      start: d,
      end: d + H2,
      organizer: { email: 'me@corp.com' },
      guests: [
        { email: 'me@corp.com', status: 'accepted' },
        { email: 'a@x.com', status: 'needs-action' },
      ],
    });
    return { store, saved };
  }

  it('applies a newer remote answer (status, timestamp, comment)', async () => {
    const { store, saved } = await seeded();
    const updated = await store.applyRsvpResponses(saved.id, [
      { email: 'A@x.com', status: 'accepted', respondedAt: 5000, comment: 'yay' },
    ]);
    const guest = updated.guests.find((g) => g.email === 'a@x.com');
    expect(guest).toEqual({ email: 'a@x.com', status: 'accepted', rsvpAt: 5000, comment: 'yay' });
    // The host's own entry is untouched.
    expect(updated.guests.find((g) => g.email === 'me@corp.com').status).toBe('accepted');
  });

  it('ignores replays and older answers (idempotent merges)', async () => {
    const { store, saved } = await seeded();
    await store.applyRsvpResponses(saved.id, [
      { email: 'a@x.com', status: 'declined', respondedAt: 5000 },
    ]);
    expect(
      await store.applyRsvpResponses(saved.id, [
        { email: 'a@x.com', status: 'declined', respondedAt: 5000 },
      ]),
    ).toBeNull();
    expect(
      await store.applyRsvpResponses(saved.id, [
        { email: 'a@x.com', status: 'accepted', respondedAt: 4000 },
      ]),
    ).toBeNull();
    expect(store.getEvent(saved.id).guests.find((g) => g.email === 'a@x.com').status).toBe(
      'declined',
    );
  });

  it('a newer answer clears a stale comment', async () => {
    const { store, saved } = await seeded();
    await store.applyRsvpResponses(saved.id, [
      { email: 'a@x.com', status: 'tentative', respondedAt: 5000, comment: 'maybe' },
    ]);
    const updated = await store.applyRsvpResponses(saved.id, [
      { email: 'a@x.com', status: 'accepted', respondedAt: 6000 },
    ]);
    expect(updated.guests.find((g) => g.email === 'a@x.com').comment).toBeUndefined();
  });

  it('ignores unknown guests, bad statuses, and unknown events', async () => {
    const { store, saved } = await seeded();
    expect(
      await store.applyRsvpResponses(saved.id, [
        { email: 'stranger@x.com', status: 'accepted', respondedAt: 5000 },
        { email: 'a@x.com', status: 'partying', respondedAt: 5000 },
      ]),
    ).toBeNull();
    expect(await store.applyRsvpResponses('nope', [])).toBeNull();
    expect(await store.applyRsvpResponses(saved.id, 'garbage')).toBeNull();
  });
});

describe('createStore — a refused write puts memory back', () => {
  // Every single-entry mutator updates memory and emits before awaiting the
  // network, so the UI never waits on a round trip. When the cloud then
  // refuses the write, memory must go back to what the cloud still holds —
  // otherwise the "Could not save" toast sits over an event that still looks
  // saved, and a "deleted" event stays gone until the next load resurrects it.
  const failing = (kv, method) => {
    const real = kv[method].getMockImplementation();
    kv[method].mockImplementationOnce(async () => {
      throw new Error('network');
    });
    return real;
  };
  const titles = (store) => store.getAllEvents().map((e) => e.title).sort();

  it('saveEvent: a new event that never landed leaves memory again', async () => {
    const kv = makeKv();
    const store = createStore(kv);
    await store.load();
    const seen = [];
    store.subscribe(() => seen.push(titles(store)));
    failing(kv, 'set');
    await expect(store.saveEvent({ title: 'Phantom', start: day, end: day + H })).rejects.toThrow('network');
    expect(titles(store)).toEqual([]);
    expect(seen).toEqual([['Phantom'], []]); // shown optimistically, then taken back
  });

  it('saveEvent: an edit that never landed reverts to the stored event', async () => {
    const kv = makeKv();
    const store = createStore(kv);
    await store.load();
    const ev = await store.saveEvent({ title: 'Standup', start: day, end: day + H });
    failing(kv, 'set');
    await expect(store.saveEvent({ ...ev, title: 'Renamed' })).rejects.toThrow('network');
    expect(store.getEvent(ev.id).title).toBe('Standup');
    expect(kv.map.get('cal:evt:' + ev.id).title).toBe('Standup');
  });

  it('deleteEvent: a delete the cloud refused brings the event back', async () => {
    const kv = makeKv();
    const store = createStore(kv);
    await store.load();
    const ev = await store.saveEvent({ title: 'Standup', start: day, end: day + H });
    failing(kv, 'del');
    await expect(store.deleteEvent(ev.id)).rejects.toThrow('network');
    expect(store.getEvent(ev.id)).toMatchObject({ title: 'Standup' });
  });

  it('does not clobber a later write to the same event with an earlier failure', async () => {
    const kv = makeKv();
    const store = createStore(kv);
    await store.load();
    const ev = await store.saveEvent({ title: 'Standup', start: day, end: day + H });
    // First save hangs, then fails; a second save on the same event lands
    // meanwhile. The first one's failure must not revert the second's result.
    let fail;
    const real = kv.set.getMockImplementation();
    kv.set.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    const first = store.saveEvent({ ...ev, title: 'First' });
    await store.saveEvent({ ...ev, title: 'Second' });
    fail(new Error('network'));
    await expect(first).rejects.toThrow('network');
    kv.set.mockImplementation(real);
    expect(store.getEvent(ev.id).title).toBe('Second');
  });

  it('updateOccurrence / deleteOccurrence / updateSeries / deleteFuture revert the master', async () => {
    const kv = makeKv();
    const store = createStore(kv);
    await store.load();
    const monMs = new Date(2026, 6, 13, 9, 0).getTime();
    const m = await store.saveEvent({
      title: 'Weekly',
      start: monMs,
      end: monMs + H,
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] },
    });
    const rid = new Date(2026, 6, 20, 9, 0).getTime();
    const before = JSON.stringify(store.getEvent(m.id));

    failing(kv, 'set');
    await expect(store.updateOccurrence(m.id, rid, { title: 'One-off' })).rejects.toThrow('network');
    expect(JSON.stringify(store.getEvent(m.id))).toBe(before);

    failing(kv, 'set');
    await expect(store.deleteOccurrence(m.id, rid)).rejects.toThrow('network');
    expect(JSON.stringify(store.getEvent(m.id))).toBe(before);

    failing(kv, 'set');
    await expect(store.updateSeries(m.id, { title: 'Renamed' })).rejects.toThrow('network');
    expect(JSON.stringify(store.getEvent(m.id))).toBe(before);

    failing(kv, 'set');
    await expect(store.deleteFuture(m.id, rid)).rejects.toThrow('network');
    expect(JSON.stringify(store.getEvent(m.id))).toBe(before);

    failing(kv, 'del');
    await expect(store.deleteFuture(m.id, monMs)).rejects.toThrow('network');
    expect(JSON.stringify(store.getEvent(m.id))).toBe(before);
  });

  it('updateFuture: a refused tail write leaves the original series untouched', async () => {
    const kv = makeKv();
    const store = createStore(kv);
    await store.load();
    const monMs = new Date(2026, 6, 13, 9, 0).getTime();
    const m = await store.saveEvent({
      title: 'Weekly',
      start: monMs,
      end: monMs + H,
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] },
    });
    const rid = new Date(2026, 6, 20, 9, 0).getTime();
    failing(kv, 'set');
    await expect(store.updateFuture(m.id, rid, { title: 'Renamed' })).rejects.toThrow('network');
    expect(store.getAllEvents()).toHaveLength(1);
    expect(store.getEvent(m.id).title).toBe('Weekly');
    expect(
      store.getEventsInRange(monMs, new Date(2026, 6, 31).getTime()).map((o) => new Date(o.start).getDate()),
    ).toEqual([13, 20, 27]);
  });

  it('updateFuture: a refused truncation mirrors the cloud — full original plus the tail', async () => {
    const kv = makeKv();
    const store = createStore(kv);
    await store.load();
    const monMs = new Date(2026, 6, 13, 9, 0).getTime();
    const m = await store.saveEvent({
      title: 'Weekly',
      start: monMs,
      end: monMs + H,
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] },
    });
    const rid = new Date(2026, 6, 20, 9, 0).getTime();
    const real = kv.set.getMockImplementation();
    let writes = 0;
    kv.set.mockImplementation(async (k, v) => {
      if (++writes === 2) throw new Error('network');
      return real(k, v);
    });
    await expect(store.updateFuture(m.id, rid, { title: 'Renamed' })).rejects.toThrow('network');
    kv.set.mockImplementation(real);
    const fresh = createStore(kv);
    await fresh.load();
    const dates = (s) =>
      s
        .getEventsInRange(monMs, new Date(2026, 6, 31).getTime())
        .map((o) => new Date(o.start).getDate())
        .sort((a, b) => a - b);
    expect(dates(store)).toEqual(dates(fresh)); // memory shows what the cloud holds
    expect(store.getEvent(m.id).title).toBe('Weekly');
  });

  it('saveTask / deleteTask revert too', async () => {
    const kv = makeKv();
    const store = createStore(kv);
    await store.load();
    const t = await store.saveTask({ title: 'Buy milk', due: day });
    failing(kv, 'set');
    await expect(store.toggleTask(t.id)).rejects.toThrow('network');
    expect(store.getTask(t.id).done).toBe(false);
    failing(kv, 'del');
    await expect(store.deleteTask(t.id)).rejects.toThrow('network');
    expect(store.getTask(t.id)).toMatchObject({ title: 'Buy milk' });
    failing(kv, 'set');
    await expect(store.saveTask({ title: 'Phantom', due: day })).rejects.toThrow('network');
    expect(store.getAllTasks().map((x) => x.title)).toEqual(['Buy milk']);
  });
});

describe('createStore — bulk writes survive a load() between chunks', () => {
  it('importEvents keeps every landed chunk in memory when a load() ran mid-import', async () => {
    // Importing emits up front, and that emit reloads the calendar elsewhere
    // (the booking sync, the API's freshness re-read). A load() that lists
    // between two chunks sees a cloud holding only the first, and its
    // clear-and-repopulate drops the rest from memory — while the import goes
    // on to land them and report "Imported N" over a calendar missing most.
    const kv = makeKv();
    const store = createStore(kv);
    await store.load();
    const list = Array.from({ length: 60 }, (_, i) => ({
      title: `E${i}`,
      start: day + i * H,
      end: day + (i + 1) * H,
    }));
    const realSet = kv.set.getMockImplementation();
    let chunks = 0;
    let reload = null;
    kv.set.mockImplementation(async (k, v) => {
      const res = await realSet(k, v);
      // Right after the first chunk lands, another process re-reads the calendar.
      if (Array.isArray(k) && ++chunks === 1) reload = store.load();
      return res;
    });
    const res = await store.importEvents(list);
    await reload;
    kv.set.mockImplementation(realSet);
    expect(res).toMatchObject({ imported: 60, failed: 0 });
    expect(store.getAllEvents()).toHaveLength(60);
    expect(kv.map.size).toBe(60);
  });

  it('applyOutOfOffice keeps every landed chunk declined when a load() ran mid-way', async () => {
    const kv = makeKv();
    const store = createStore(kv);
    await store.load();
    for (let i = 0; i < 40; i++) {
      await store.saveEvent({ title: `M${i}`, start: day + i * H, end: day + i * H + 1800_000 });
    }
    const ooo = await store.saveEvent({ title: 'Away', start: day, end: day + 48 * H, allDay: true, ooo: true });
    const realSet = kv.set.getMockImplementation();
    let chunks = 0;
    let reload = null;
    kv.set.mockImplementation(async (k, v) => {
      const res = await realSet(k, v);
      if (Array.isArray(k) && ++chunks === 1) reload = store.load();
      return res;
    });
    const { declined } = await store.applyOutOfOffice(ooo);
    await reload;
    kv.set.mockImplementation(realSet);
    expect(declined).toHaveLength(40);
    expect(store.getAllEvents().filter((e) => e.declined)).toHaveLength(40);
  });
});

describe('createStore — a second quick settings change is never transiently reverted', () => {
  it('keeps both toggles visible throughout, and lands both in the cloud', async () => {
    // The first save's merge-before-write reads the cloud copy; a second
    // toggle made while that read is in flight must not flip back when the
    // first write's merge replaces the local settings.
    const kv = makeKv({ 'cal:settings': { ...DEFAULT_SETTINGS } });
    const realGet = kv.get.getMockImplementation();
    kv.get.mockImplementation(async (k) => {
      await new Promise((r) => setTimeout(r, 30));
      return realGet(k);
    });
    const store = createStore(kv);
    await store.load();
    const seen = [];
    store.subscribe(() => seen.push([...store.getSettings().hiddenColors].sort()));
    const a = store.saveSettings({ hiddenColors: ['red'] });
    await new Promise((r) => setTimeout(r, 5));
    const b = store.saveSettings({ hiddenColors: ['red', 'blue'] });
    await Promise.all([a, b]);
    // Once blue is hidden it stays hidden — no frame shows only red again.
    const blueAt = seen.findIndex((h) => h.includes('blue'));
    expect(blueAt).toBeGreaterThanOrEqual(0);
    expect(seen.slice(blueAt).every((h) => h.includes('blue'))).toBe(true);
    expect(kv.map.get('cal:settings').hiddenColors.sort()).toEqual(['blue', 'red']);
    kv.get.mockImplementation(realGet);
  });
});

describe('createStore — foreign write stamps', () => {
  it('load() re-stamps a record whose updatedAt is not a number instead of copying it through', async () => {
    const kv = makeKv({
      'cal:evt:x': { id: 'x', title: 'Odd', start: day, end: day + H, updatedAt: '2026-01-01' },
      'cal:task:t': { id: 't', title: 'Odd task', due: day, updatedAt: '2026-01-01' },
    });
    const store = createStore(kv);
    await store.load();
    for (const rec of [store.getEvent('x'), store.getTask('t')]) {
      expect(Number.isFinite(rec.updatedAt)).toBe(true);
      expect(Number.isFinite(rec.createdAt)).toBe(true);
    }
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createContacts } from '../src/js/contacts.js';

// Every client built by harness() below, torn down after each test: a client
// left running can land a background directory read (and its stored snapshot)
// in the middle of the next test.
const clients = [];
afterEach(() => {
  clients.forEach((c) => c.dispose());
  clients.length = 0;
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A stand-in for the Contacts app on the other end of an AppConnection: it
 * speaks the same little protocol (a `ready` notice, then one reply per
 * request), and records what it was launched with.
 */
function makeService({ contacts = [], answer = null, ready = true } = {}) {
  const listeners = new Map();
  let book = contacts;
  const service = {
    launches: [],
    requests: [],
    closed: false,
    /** Push an unsolicited message (e.g. `changed`) at the client. */
    emit(msg) {
      for (const fn of [...(listeners.get('message') || [])]) fn(msg);
    },
    /** Change the address book the service answers with, as an edit in the
     *  Contacts app would. */
    setContacts(next) {
      book = next;
    },
  };

  const connection = {
    usesSDK: true,
    postMessage(msg) {
      service.requests.push(msg);
      setTimeout(() => {
        // `list` pages exactly as Contacts does, so a client that reads a big
        // book in several requests is tested against the real shape.
        const params = msg.params || {};
        const offset = Math.max(0, Number(params.offset) || 0);
        const limit = Number(params.limit) > 0 ? Number(params.limit) : book.length;
        const reply = answer
          ? answer(msg)
          : msg.method === 'list'
            ? {
                ok: true,
                result: { contacts: book.slice(offset, offset + limit), total: book.length, offset },
              }
            : { ok: true, result: {} };
        if (reply) service.emit({ $: 'contacts-api', v: 1, id: msg.id, ...reply });
      }, 0);
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    off(event, fn) {
      if (listeners.has(event)) listeners.get(event).delete(fn);
    },
    close() {
      service.closed = true;
      for (const fn of [...(listeners.get('close') || [])]) fn({ appInstanceID: 'x' });
    },
  };

  const puter = {
    env: 'app',
    ui: {
      launchApp: vi.fn(async (options) => {
        service.launches.push(options);
        // The real service announces itself once it is listening.
        if (ready) setTimeout(() => service.emit({ $: 'contacts-api', v: 1, type: 'ready' }), 0);
        return connection;
      }),
    },
  };

  return { service, connection, puter };
}

const PEOPLE = [
  {
    id: 'c1',
    name: 'Ada Lovelace',
    company: 'Analytical Engines',
    favorite: true,
    emails: [{ label: 'Work', value: 'ada@analytical.co' }],
  },
  {
    id: 'c2',
    name: 'Grace Hopper',
    company: 'US Navy',
    emails: [
      { label: 'Work', value: 'grace@navy.mil' },
      { label: 'Personal', value: 'ghopper@example.com' },
    ],
  },
  { id: 'c3', name: 'Alan Turing', company: 'Bletchley Park', emails: [{ label: 'Work', value: 'alan@bletchley.uk' }] },
  { id: 'c4', name: 'Katherine Johnson', company: 'NASA', emails: [] },
];

/** A client wired to a fake service, with timings short enough to test. */
function harness(opts = {}) {
  const { service, puter, connection } = makeService(opts);
  const contacts = createContacts({
    getPuter: () => puter,
    idleCloseMs: 5,
    requestTimeoutMs: 30,
    launchTimeoutMs: 40,
    retryAfterMs: 1000,
    ...(opts.clientOptions || {}),
  });
  clients.push(contacts);
  return { contacts, service, puter, connection };
}

/** jsdom 29 ships a localStorage without clear(); this is enough for these tests. */
function stubStorage() {
  const map = new Map();
  const store = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  vi.stubGlobal('localStorage', store);
  return map;
}

describe('contacts client — availability', () => {
  it('is unavailable on the open web, where there is no app to launch', () => {
    const contacts = createContacts({ getPuter: () => ({ env: 'web', ui: {} }) });
    expect(contacts.available()).toBe(false);
    expect(contacts.suggest('ada')).toEqual([]);
  });

  it('is unavailable with no Puter SDK at all', () => {
    const contacts = createContacts({ getPuter: () => null });
    expect(contacts.available()).toBe(false);
  });

  it('is available inside the Puter desktop', () => {
    const { contacts } = harness();
    expect(contacts.available()).toBe(true);
  });
});

describe('contacts client — reading the directory', () => {
  let h;
  beforeEach(() => {
    h = harness({ contacts: PEOPLE });
  });

  it('launches Contacts hidden, in service mode, and reads the directory once', async () => {
    await h.contacts.warm();
    expect(h.puter.ui.launchApp).toHaveBeenCalledTimes(1);
    expect(h.service.launches[0]).toEqual({
      name: 'contacts',
      args: { service: 'contacts-api' },
      // No window should appear for a service the user never asked to see.
      background: true,
    });
    expect(h.service.requests.map((r) => r.method)).toEqual(['list']);

    // A second warm with a fresh snapshot launches nothing.
    await h.contacts.warm();
    expect(h.puter.ui.launchApp).toHaveBeenCalledTimes(1);
  });

  it('lets the service window close once it has gone quiet', async () => {
    await h.contacts.warm();
    expect(h.service.closed).toBe(false);
    await sleep(30);
    expect(h.service.closed).toBe(true);
  });

  it('suggests nothing until the snapshot arrives, then filters locally', async () => {
    expect(h.contacts.suggest('ada')).toEqual([]); // kicks off the read
    await sleep(30);
    const hits = h.contacts.suggest('ada');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      contactId: 'c1',
      name: 'Ada Lovelace',
      email: 'ada@analytical.co',
      label: 'Work',
      company: 'Analytical Engines',
    });
    // Filtering is local: no further requests.
    expect(h.service.requests.map((r) => r.method)).toEqual(['list']);
  });

  it('offers one suggestion per email address, in the contact’s own order', async () => {
    await h.contacts.warm();
    expect(h.contacts.suggest('hopper').map((s) => s.email)).toEqual([
      'grace@navy.mil',
      'ghopper@example.com',
    ]);
  });

  it('leaves out people with no email address', async () => {
    await h.contacts.warm();
    expect(h.contacts.suggest('katherine')).toEqual([]);
  });

  it('keeps each address with its own label, past a blank row', async () => {
    const h2 = harness({
      contacts: [
        {
          id: 'c9',
          name: 'Radia Perlman',
          // A blank row is ordinary: the editor leaves one behind when an
          // address is cleared. It must not shift the labels off the real ones.
          emails: [
            { label: 'Old', value: '  ' },
            { label: 'Work', value: 'radia@example.com' },
            { label: 'Home', value: 'radia@home.example' },
            { label: 'Dupe', value: 'RADIA@example.com' },
          ],
        },
      ],
    });
    await h2.contacts.warm();
    expect(h2.contacts.suggest('radia')).toEqual([
      expect.objectContaining({ email: 'radia@example.com', label: 'Work' }),
      expect.objectContaining({ email: 'radia@home.example', label: 'Home' }),
    ]);
  });

  it('ranks a prefix match above a match buried elsewhere', async () => {
    await h.contacts.warm();
    // "na" starts nothing, but appears in "navy.mil", "Analytical" and "NASA".
    const names = h.contacts.suggest('na').map((s) => s.name);
    expect(names).toContain('Grace Hopper');
    // "al" starts "Alan"; Ada only matches through her company.
    expect(h.contacts.suggest('al')[0].name).toBe('Alan Turing');
  });

  it('matches every word of a multi-word query', async () => {
    await h.contacts.warm();
    expect(h.contacts.suggest('grace navy').map((s) => s.name)).toEqual([
      'Grace Hopper',
      'Grace Hopper',
    ]);
    expect(h.contacts.suggest('grace bletchley')).toEqual([]);
  });

  it('honours the limit and puts favorites first on an even match', async () => {
    await h.contacts.warm();
    expect(h.contacts.suggest('a', 2)).toHaveLength(2);
    expect(h.contacts.suggest('a')[0].name).toBe('Ada Lovelace');
  });

  it('re-reads a snapshot that has gone stale, serving the old one meanwhile', async () => {
    let clock = 1000;
    const { contacts, service } = harness({
      contacts: PEOPLE,
      clientOptions: { now: () => clock, refreshAfterMs: 500 },
    });
    const reads = () => service.requests.filter((r) => r.method === 'list').length;
    await contacts.warm();
    clock += 499;
    await contacts.warm();
    expect(reads()).toBe(1);
    clock += 2;
    // Stale: warm resolves off the old copy and re-reads behind it.
    await contacts.warm();
    expect(contacts.suggest('ada')).toHaveLength(1);
    await sleep(20);
    expect(reads()).toBe(2);
  });

  it('re-reads once more when the book changes mid-read', async () => {
    const pendingLists = [];
    const h2 = harness({
      clientOptions: { requestTimeoutMs: 500 },
      answer: (msg) => {
        if (msg.method !== 'list') return { ok: true, result: {} };
        pendingLists.push(msg);
        return null; // replies are sent by hand below
      },
    });
    const answerNext = (book) => {
      const msg = pendingLists.shift();
      h2.service.emit({
        $: 'contacts-api',
        v: 1,
        id: msg.id,
        ok: true,
        result: { contacts: book, total: book.length },
      });
    };

    const first = h2.contacts.warm(); // the read is now in flight
    // Wait for the list request itself — a fixed sleep(10) races the
    // launch/handshake on slower Windows hosts and flakes as "expected 1, got 0".
    await vi.waitFor(() => expect(pendingLists).toHaveLength(1));

    // The book changes while that read is still in flight. The notice must not
    // be satisfied by a read that started before the change — that read lands
    // pre-change data as "fresh", which is exactly what `changed` exists to
    // prevent.
    h2.service.emit({ $: 'contacts-api', v: 1, type: 'changed' });
    answerNext([PEOPLE[0]]); // the stale read lands: just Ada
    await first;
    await vi.waitFor(() => expect(pendingLists).toHaveLength(1)); // one more read went out on its own
    answerNext(PEOPLE);
    await vi.waitFor(() => expect(h2.contacts.suggest('grace')).toHaveLength(2));
  });

  it('re-reads when Contacts says the address book changed', async () => {
    await h.contacts.warm();
    expect(h.contacts.suggest('ada')).toHaveLength(1);
    h.service.emit({ $: 'contacts-api', v: 1, type: 'changed' });
    // The copy we have keeps answering while the fresh one is on its way: there
    // is no moment where the field goes blank.
    expect(h.contacts.suggest('ada')).toHaveLength(1);
    await sleep(30);
    expect(h.service.requests.filter((r) => r.method === 'list')).toHaveLength(2);
    expect(h.contacts.suggest('ada')).toHaveLength(1);
  });

  it('tells subscribers when a re-read actually brought something new', async () => {
    const changes = [];
    h.contacts.onChange(() => changes.push(true));
    // The first read is a change: it is what fills a guest field that was
    // showing nothing.
    await h.contacts.warm();
    expect(changes).toHaveLength(1);

    // A re-read that returns the same book must not wake anyone.
    h.service.emit({ $: 'contacts-api', v: 1, type: 'changed' });
    await sleep(30);
    expect(changes).toHaveLength(1);

    h.service.setContacts([
      ...PEOPLE,
      { id: 'c9', name: 'Nadia Khan', emails: [{ label: 'Work', value: 'nadia@example.com' }] },
    ]);
    h.service.emit({ $: 'contacts-api', v: 1, type: 'changed' });
    await sleep(30);
    expect(changes).toHaveLength(2);
    expect(h.contacts.suggest('nadia')).toHaveLength(1);
  });

  /**
   * A suggestion is more than an id and an address: it draws the name, the
   * company and the label, orders by whether they are starred, and matches on
   * the job title and tags too. An edit to any of those that left the id and
   * the address alone used to read as "the same book" — so the list someone had
   * open kept the old spelling until they pressed another key.
   */
  it('tells subscribers when an edit changed only what a suggestion draws', async () => {
    const changes = [];
    await h.contacts.warm();
    h.contacts.onChange(() => changes.push(true));

    const rename = (patch) => {
      h.service.setContacts([{ ...PEOPLE[0], ...patch }, ...PEOPLE.slice(1)]);
      h.service.emit({ $: 'contacts-api', v: 1, type: 'changed' });
      return sleep(30);
    };

    await rename({ name: 'Ada King' });
    expect(changes).toHaveLength(1);
    expect(h.contacts.suggest('ada')[0].name).toBe('Ada King');

    await rename({ name: 'Ada King', company: 'Analytical Engines Ltd' });
    expect(changes).toHaveLength(2);

    await rename({
      name: 'Ada King',
      company: 'Analytical Engines Ltd',
      emails: [{ label: 'Home', value: 'ada@analytical.co' }],
    });
    expect(changes).toHaveLength(3);

    await rename({
      name: 'Ada King',
      company: 'Analytical Engines Ltd',
      emails: [{ label: 'Home', value: 'ada@analytical.co' }],
      favorite: false,
    });
    expect(changes).toHaveLength(4);

    // …and still says nothing when nothing about them changed.
    await rename({
      name: 'Ada King',
      company: 'Analytical Engines Ltd',
      emails: [{ label: 'Home', value: 'ada@analytical.co' }],
      favorite: false,
    });
    expect(changes).toHaveLength(4);
  });
});

describe('contacts client — the stored snapshot', () => {
  let stored;
  beforeEach(() => {
    stored = stubStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const withUser = (extra = {}) =>
    harness({ contacts: PEOPLE, clientOptions: { userKey: 'user-1', ...extra } });

  it('serves a later session from disk, launching nothing at all', async () => {
    const first = withUser();
    await first.contacts.warm();
    expect(stored.size).toBe(1);

    // A new page load: same storage, a brand-new client.
    const second = withUser();
    await second.contacts.warm();
    expect(second.puter.ui.launchApp).not.toHaveBeenCalled();
    expect(second.contacts.suggest('ada')[0].email).toBe('ada@analytical.co');
  });

  it('keys the snapshot to the account, so another user never sees it', async () => {
    const first = withUser();
    await first.contacts.warm();

    const other = harness({ contacts: [], clientOptions: { userKey: 'user-2' } });
    expect(other.contacts.suggest('ada')).toEqual([]);
    // …and the first account's snapshot leaves the disk with it: one account's
    // address book on this browser at a time (the calendar snapshot's rule).
    expect([...stored.keys()]).toEqual([]);
  });

  it("drops a previous account's snapshot when a different account signs in", async () => {
    // A session that expired and was followed by another sign-in never went
    // through sign-out, which is the only path that cleared the snapshot —
    // so the first account's address book stayed on disk under its own key.
    stored.set('cal:contacts:dir:user-0', JSON.stringify({ v: 1, entries: [] }));
    const first = withUser(); // user-1
    await first.contacts.warm();
    expect([...stored.keys()].sort()).toEqual(['cal:contacts:dir:user-1']);
  });

  it('stores nothing when there is no account to key it to', async () => {
    const h = harness({ contacts: PEOPLE });
    await h.contacts.warm();
    expect(stored.size).toBe(0);
  });

  it('replaces the stored copy when the book changed — and drops it if it can’t', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let failing = false;
    const changed = { $: 'contacts-api', v: 1, type: 'changed' };
    const h = harness({
      contacts: PEOPLE,
      clientOptions: { userKey: 'user-1' },
      answer: (msg) => {
        if (msg.method !== 'list') return { ok: true, result: {} };
        if (failing) return { ok: false, error: { message: 'no' } };
        return { ok: true, result: { contacts: PEOPLE, total: PEOPLE.length } };
      },
    });
    await h.contacts.warm();
    expect(stored.size).toBe(1);

    // A re-read that works: there is a usable copy on disk throughout.
    h.service.emit(changed);
    await sleep(30);
    expect(stored.size).toBe(1);
    expect(h.contacts.suggest('ada')).toHaveLength(1);

    // One that fails leaves us knowingly stale, and that we don't keep.
    failing = true;
    h.service.emit(changed);
    await sleep(30);
    expect(stored.size).toBe(0);
    expect(h.contacts.suggest('ada')).toEqual([]);
    warn.mockRestore();
  });

  it('clears the stored copy on invalidate, for sign-out', async () => {
    const h = withUser();
    await h.contacts.warm();
    h.contacts.invalidate();
    expect(stored.size).toBe(0);
    expect(h.contacts.suggest('ada')).toEqual([]);
  });

  it('re-reads after a query found nobody, but only once the user is done', async () => {
    const h = withUser({ missRefreshMs: 0 });
    await h.contacts.warm();
    const reads = () => h.service.requests.filter((r) => r.method === 'list').length;
    expect(reads()).toBe(1);

    // Typing must never trigger a launch: it is the one thing that can disturb
    // the field being typed into.
    expect(h.contacts.suggest('radia')).toEqual([]);
    await sleep(20);
    expect(reads()).toBe(1);

    // Leaving the field is the safe moment.
    h.contacts.settle();
    await sleep(20);
    expect(reads()).toBe(2);
  });

  it('settles to nothing when every query found somebody', async () => {
    const h = withUser({ missRefreshMs: 0 });
    await h.contacts.warm();
    expect(h.contacts.suggest('ada')).toHaveLength(1);
    h.contacts.settle();
    h.contacts.settle();
    await sleep(20);
    expect(h.service.requests.filter((r) => r.method === 'list')).toHaveLength(1);
  });

  it('does not re-read on a miss more often than the throttle allows', async () => {
    let clock = 10_000;
    const h = withUser({ now: () => clock, missRefreshMs: 1000 });
    await h.contacts.warm();
    const reads = () => h.service.requests.filter((r) => r.method === 'list').length;

    clock += 100;
    h.contacts.suggest('nope');
    h.contacts.settle();
    await sleep(20);
    expect(reads()).toBe(1); // too soon after the read we just did

    clock += 2000;
    h.contacts.suggest('nope');
    h.contacts.settle();
    await sleep(20);
    expect(reads()).toBe(2);
  });

  it('ignores a stored snapshot written by an older version', async () => {
    stored.set('cal:contacts:dir:user-1', JSON.stringify({ v: 0, entries: [{}] }));
    const h = withUser();
    await h.contacts.warm();
    expect(h.puter.ui.launchApp).toHaveBeenCalledTimes(1);
    expect(h.contacts.suggest('ada')).toHaveLength(1);
  });

  it('ignores unreadable stored data instead of throwing', async () => {
    stored.set('cal:contacts:dir:user-1', 'not json');
    const h = withUser();
    expect(h.contacts.suggest('ada')).toEqual([]);
    await h.contacts.warm();
    expect(h.contacts.suggest('ada')).toHaveLength(1);
  });

  it('works with storage unavailable, keeping the snapshot in memory', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    const h = withUser();
    await h.contacts.warm();
    expect(h.contacts.suggest('ada')).toHaveLength(1);
  });
});

describe('contacts client — a big address book', () => {
  const many = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      name: `Person ${String(i).padStart(3, '0')}`,
      emails: [{ label: 'Work', value: `p${i}@example.com` }],
    }));

  it('reads the whole book a page at a time', async () => {
    const h = harness({ contacts: many(5), clientOptions: { pageSize: 2 } });
    await h.contacts.warm();
    const lists = h.service.requests.filter((r) => r.method === 'list');
    expect(lists.map((r) => r.params.offset)).toEqual([0, 2, 4]);
    // Everyone is suggestable — including the tail, which a single capped read
    // would have dropped without telling anybody.
    expect(h.contacts.suggest('p4@example.com')).toHaveLength(1);
    expect(h.contacts.suggest('person', 99)).toHaveLength(5);
  });

  it('stops, without duplicates, if the service ignores the offset', async () => {
    const book = many(5);
    const h = harness({
      contacts: book,
      clientOptions: { pageSize: 2 },
      // A server that pages badly: always the first two, but an honest total.
      answer: (msg) =>
        msg.method === 'list'
          ? { ok: true, result: { contacts: book.slice(0, 2), total: book.length } }
          : { ok: true, result: {} },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await h.contacts.warm();
    expect(h.contacts.suggest('person', 99)).toHaveLength(2);
    // …and it said so, rather than implying the book was fully read.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('of 5 contacts'));
    warn.mockRestore();
  });

  it('gives up after a bounded number of pages', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness({ contacts: many(20), clientOptions: { pageSize: 2, maxPages: 3 } });
    await h.contacts.warm();
    expect(h.service.requests.filter((r) => r.method === 'list')).toHaveLength(3);
    expect(h.contacts.suggest('person', 99)).toHaveLength(6);
    warn.mockRestore();
  });

  it('offers an address two people share once, under the first of them', async () => {
    // Both rows would add the same guest, so the second is a choice with no
    // difference behind it. Contacts answers its own `suggest` the same way, so
    // the two routes to a suggestion agree; `list` comes back sorted, so "the
    // first of them" means the same thing on both sides.
    const h = harness({
      contacts: [
        { id: 'c1', name: 'Abe Ba', emails: [{ label: 'Home', value: 'house@example.com' }] },
        {
          id: 'c2',
          name: 'Zoe Ba',
          emails: [
            { label: 'Home', value: 'house@example.com' },
            { label: 'Work', value: 'zoe@example.com' },
          ],
        },
      ],
    });
    await h.contacts.warm();

    const shared = h.contacts.suggest('house@example.com', 99);
    expect(shared).toHaveLength(1);
    expect(shared[0].name).toBe('Abe Ba');
    // Zoe keeps every address of her own.
    expect(h.contacts.suggest('zoe', 99).map((s) => s.email)).toEqual(['zoe@example.com']);
  });
});

describe('contacts client — staying usable when Contacts is not', () => {
  let stored;
  beforeEach(() => {
    stored = stubStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps suggesting from the snapshot while a launch is failing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let launches = 0;
    const puter = {
      env: 'app',
      ui: {
        launchApp: vi.fn(async () => {
          launches += 1;
          throw new Error('app not found');
        }),
      },
    };
    // A snapshot from an earlier session, and a Contacts app that won't open now.
    stored.set(
      'cal:contacts:dir:user-1',
      JSON.stringify({
        v: 1,
        fetchedAt: Date.now(),
        entries: [
          {
            contactId: 'c1',
            name: 'Ada Lovelace',
            email: 'ada@analytical.co',
            label: 'Work',
            company: 'Analytical Engines',
            favorite: true,
            pos: 0,
            hay: 'ada lovelace\nanalytical engines\nada@analytical.co',
          },
        ],
      }),
    );
    const contacts = createContacts({ getPuter: () => puter, userKey: 'user-1' });
    clients.push(contacts);

    // The guest field asks `ready()`, not `available()`: matching is local, so a
    // Contacts app that can't be launched must not cost the user their combobox.
    expect(contacts.ready()).toBe(true);
    expect(contacts.suggest('ada')).toHaveLength(1);
    await contacts.revalidate({ maxAgeMs: 0 });
    expect(launches).toBe(1);
    expect(contacts.available()).toBe(false); // backed off
    // …and the snapshot still answers.
    expect(contacts.suggest('ada')).toHaveLength(1);
    warn.mockRestore();
  });

  it('backs off after a read that failed post-launch, as it does for a failed launch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness({
      answer: (msg) =>
        msg.method === 'list'
          ? { ok: false, error: { message: 'storage_error' } }
          : { ok: true, result: {} },
    });
    await h.contacts.warm();
    expect(h.puter.ui.launchApp).toHaveBeenCalledTimes(1);
    // Contacts opened but could not answer: that costs it its availability for
    // a while too. Without this, only failed launches backed off, and a service
    // that opens but cannot answer would be relaunched at every safe moment.
    expect(h.contacts.available()).toBe(false);
    await h.contacts.revalidate({ maxAgeMs: 0 });
    await h.contacts.warm();
    expect(h.puter.ui.launchApp).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('keeps the snapshot it has when a re-read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let failing = false;
    const h = harness({
      contacts: PEOPLE,
      clientOptions: { userKey: 'user-1' },
      answer: (msg) => {
        if (msg.method !== 'list') return { ok: true, result: {} };
        if (failing) return { ok: false, error: { message: 'storage_error' } };
        return { ok: true, result: { contacts: PEOPLE, total: PEOPLE.length } };
      },
    });
    await h.contacts.warm();
    failing = true;
    await h.contacts.revalidate({ maxAgeMs: 0 });
    expect(h.contacts.suggest('ada')).toHaveLength(1);
    expect(stored.size).toBe(1);
    warn.mockRestore();
  });

  it('takes an empty address book as an answer, within its short trust window', async () => {
    const h = harness({ contacts: [], clientOptions: { userKey: 'user-1' } });
    await h.contacts.warm();
    expect(h.puter.ui.launchApp).toHaveBeenCalledTimes(1);
    expect(h.contacts.suggest('ada')).toEqual([]);
    // Just read: nothing to be gained from launching Contacts again this second
    // to be told "still nobody".
    await h.contacts.warm();
    await h.contacts.revalidate();
    expect(h.puter.ui.launchApp).toHaveBeenCalledTimes(1);

    // A session that starts inside the window reads the same answer off disk.
    const second = harness({ contacts: [], clientOptions: { userKey: 'user-1' } });
    await second.contacts.warm();
    expect(second.puter.ui.launchApp).not.toHaveBeenCalled();
  });

  it('re-checks an empty book on the next open, so a first import is not missed', async () => {
    // The first-run sequence: open Contacts (empty), open the calendar (nothing
    // to suggest, correctly), import an address book, open the calendar again.
    let clock = 1_000_000;
    const first = harness({
      contacts: [],
      clientOptions: { userKey: 'user-1', now: () => clock },
    });
    await first.contacts.warm();
    expect(first.contacts.suggest('ada')).toEqual([]);

    // The import happens; a couple of minutes pass.
    clock += 2 * 60 * 1000;
    const second = harness({
      contacts: PEOPLE,
      clientOptions: { userKey: 'user-1', now: () => clock },
    });
    // "Nobody yet" has outlived its trust: warm() must re-read, not serve the
    // stored empty book for the rest of the hour.
    await second.contacts.warm();
    expect(second.puter.ui.launchApp).toHaveBeenCalledTimes(1);
    expect(second.contacts.suggest('ada')).toHaveLength(1);
  });

  it('recovers in-session: a miss against an empty book re-reads on settle', async () => {
    const h = harness({ contacts: [] });
    await h.contacts.warm();
    const reads = () => h.service.requests.filter((r) => r.method === 'list').length;
    expect(reads()).toBe(1);

    // The import lands in Contacts while the calendar sits open.
    h.service.setContacts(PEOPLE);
    expect(h.contacts.suggest('ada')).toEqual([]); // still the empty snapshot
    // Leaving the field acts on the miss — the fetchedAt throttle must not
    // shield an empty book, or this exact sequence stays dead for a minute.
    h.contacts.settle();
    await sleep(30);
    expect(reads()).toBe(2);
    expect(h.contacts.suggest('ada')).toHaveLength(1);
  });

  it('has nothing to offer, and says so, with no snapshot and no desktop', () => {
    const contacts = createContacts({ getPuter: () => ({ env: 'web', ui: {} }) });
    expect(contacts.ready()).toBe(false);
    expect(contacts.suggest('ada')).toEqual([]);
  });

  it('does not trust a stored stamp from the future beyond the normal window', async () => {
    // The clock moved back since the snapshot was written (a timezone fix, a
    // corrected clock): its stamp is now hours in the future. Unclamped, that
    // snapshot would read as "fresh" until the clock caught up.
    let clock = 1_000_000;
    stored.set(
      'cal:contacts:dir:user-1',
      JSON.stringify({
        v: 1,
        fetchedAt: clock + 12 * 60 * 60 * 1000,
        entries: [{ contactId: 'c1', name: 'Ada Lovelace', email: 'ada@analytical.co' }],
      }),
    );
    const h = harness({
      contacts: PEOPLE,
      clientOptions: { userKey: 'user-1', now: () => clock, refreshAfterMs: 1000 },
    });
    expect(h.contacts.suggest('ada')).toHaveLength(1); // served, like any snapshot
    clock += 1001; // past the trust window measured from the restore, not the bogus stamp
    await h.contacts.warm();
    expect(h.puter.ui.launchApp).toHaveBeenCalledTimes(1);
  });

  it('repairs a snapshot that is missing its derived fields', async () => {
    stored.set(
      'cal:contacts:dir:user-1',
      JSON.stringify({
        v: 1,
        fetchedAt: Date.now(),
        entries: [
          // No `hay` (an older build, or a truncated write) and junk alongside.
          { contactId: 'c1', name: 'Ada Lovelace', email: 'ADA@analytical.co' },
          { contactId: 'c2', name: 'No Address' },
          null,
          'nonsense',
        ],
      }),
    );
    const h = harness({ contacts: PEOPLE, clientOptions: { userKey: 'user-1' } });
    // Matched on a rebuilt haystack, from disk, without launching anything.
    expect(h.contacts.suggest('lovelace')[0].email).toBe('ada@analytical.co');
    expect(h.puter.ui.launchApp).not.toHaveBeenCalled();
    expect(h.contacts.suggest('no address')).toEqual([]);
  });

  it('re-reads after the user types in an address it has never seen', async () => {
    const h = harness({ contacts: PEOPLE, clientOptions: { missRefreshMs: 0 } });
    await h.contacts.warm();
    const reads = () => h.service.requests.filter((r) => r.method === 'list').length;

    // A known address tells us nothing.
    h.contacts.noteTyped('ada@analytical.co');
    h.contacts.settle();
    await sleep(20);
    expect(reads()).toBe(1);

    // One we've never heard of is the clearest sign our copy is behind — but it
    // is still acted on only once typing is over.
    h.contacts.noteTyped('nadia@example.com');
    await sleep(20);
    expect(reads()).toBe(1);
    h.contacts.settle();
    await sleep(20);
    expect(reads()).toBe(2);
  });

  it('re-reads at a safe moment only once the snapshot has aged', async () => {
    let clock = 5000;
    const h = harness({
      contacts: PEOPLE,
      clientOptions: { now: () => clock, revalidateMs: 1000, refreshAfterMs: 60_000 },
    });
    const reads = () => h.service.requests.filter((r) => r.method === 'list').length;
    await h.contacts.warm();
    expect(reads()).toBe(1);

    clock += 999;
    await h.contacts.revalidate();
    expect(reads()).toBe(1); // fresh enough; nothing launched

    clock += 2;
    await h.contacts.revalidate();
    await sleep(20);
    expect(reads()).toBe(2);
  });

  it('forgets its subscribers when it is disposed', async () => {
    const h = harness({ contacts: PEOPLE });
    let calls = 0;
    const off = h.contacts.onChange(() => calls++);
    h.contacts.dispose();
    h.contacts.invalidate();
    expect(calls).toBe(0);
    expect(() => off()).not.toThrow();
  });
});

describe('contacts client — the rest of the API', () => {
  it('round-trips a live read and returns the contact', async () => {
    const { contacts, service } = harness({
      answer: (msg) =>
        msg.method === 'get'
          ? { ok: true, result: { contact: { id: 'c9', firstName: 'Radia' } } }
          : { ok: true, result: {} },
    });
    const found = await contacts.get('c9');
    expect(found).toEqual({ id: 'c9', firstName: 'Radia' });
    expect(service.requests[0]).toMatchObject({
      $: 'contacts-api',
      v: 1,
      method: 'get',
      params: { id: 'c9' },
    });
  });

  it('offers no way to change the address book', () => {
    // Contacts grants the calendar its read methods only, so a `create` here
    // would be a wrapper around a refusal. Suggesting guests is not a reason to
    // be able to rename or delete the people being suggested.
    const { contacts } = harness();
    for (const write of ['create', 'update', 'remove', 'delete']) {
      expect(contacts[write]).toBeUndefined();
    }
  });

  it('surfaces the error Contacts sent back', async () => {
    const { contacts } = harness({
      answer: () => ({ ok: false, error: { code: 'invalid', message: 'That is not a contact' } }),
    });
    await expect(contacts.get('nope')).rejects.toThrow('That is not a contact');
  });

  it('gives up on a request the service never answers', async () => {
    const { contacts } = harness({ answer: () => null });
    await expect(contacts.call('ping')).rejects.toThrow(/timed out/);
  });

  it('rejects, backs off, and stops relaunching when the launch fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const launchApp = vi.fn(async () => {
      throw new Error('app not found');
    });
    const contacts = createContacts({
      getPuter: () => ({ env: 'app', ui: { launchApp } }),
      retryAfterMs: 10_000,
    });
    await expect(contacts.call('ping')).rejects.toThrow('app not found');
    expect(contacts.available()).toBe(false);
    expect(contacts.suggest('ada')).toEqual([]);
    await contacts.warm();
    expect(launchApp).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('gives up when the launched app never says hello', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { contacts, service } = harness({ ready: false });
    await expect(contacts.call('ping')).rejects.toThrow(/did not respond/);
    // …and doesn't leave the window it opened behind.
    expect(service.closed).toBe(true);
    warn.mockRestore();
  });

  it('gives up as soon as the service window closes on us', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A Contacts that will not serve us — not installed, not allowed, nobody
    // signed in — exits as soon as it works that out, without ever saying
    // hello. `launchTimeoutMs` is long here so that waiting it out would show.
    const { contacts, connection } = harness({
      ready: false,
      clientOptions: { launchTimeoutMs: 5000 },
    });
    const asked = contacts.call('ping');
    await sleep(5); // the launch resolves and our listeners go on
    const started = Date.now();
    connection.close();

    await expect(asked).rejects.toThrow(/closed before it was ready/);
    expect(Date.now() - started).toBeLessThan(500); // not the five seconds
    expect(contacts.available()).toBe(false); // and backed off straight away
    warn.mockRestore();
  });

  it('cleans up after a send the transport rejects, letting the window close', async () => {
    const h = harness({ contacts: PEOPLE, clientOptions: { idleCloseMs: 10 } });
    await h.contacts.warm(); // the connection is open and idle
    // The window can close under us before its `close` event is delivered, in
    // which case postMessage throws synchronously.
    h.connection.postMessage = () => {
      throw new Error('gone');
    };
    await expect(h.contacts.call('ping')).rejects.toThrow('gone');
    // The failed send must not cancel the idle close (a window left open
    // forever) or orphan its timeout (a rejection nobody is holding).
    await sleep(40);
    expect(h.service.closed).toBe(true);
  });

  it('fails in-flight requests when the service window closes', async () => {
    const { contacts, connection } = harness({ answer: () => null });
    const inFlight = contacts.call('list');
    await sleep(10);
    connection.close();
    await expect(inFlight).rejects.toThrow(/closed/);
  });

  it('reconnects for a later call after the service went away', async () => {
    const h = harness({ contacts: PEOPLE });
    await h.contacts.warm();
    h.connection.close();
    await h.contacts.search('ada');
    expect(h.puter.ui.launchApp).toHaveBeenCalledTimes(2);
  });

  it('closes the service and forgets the snapshot on dispose', async () => {
    const h = harness({ contacts: PEOPLE });
    await h.contacts.warm();
    h.contacts.dispose();
    expect(h.service.closed).toBe(true);
    expect(h.contacts.suggest('ada')).toEqual([]);
  });

  it('abandons a launch that is still in flight when it is disposed', async () => {
    const h = harness({ contacts: PEOPLE });
    h.contacts.warm(); // deliberately not awaited: the launch is mid-flight
    h.contacts.dispose();
    await sleep(30);
    // No window left running, and nothing was read behind our back.
    expect(h.service.closed).toBe(true);
    expect(h.service.requests).toEqual([]);
    expect(h.contacts.suggest('ada')).toEqual([]);
  });
});

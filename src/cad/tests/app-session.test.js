// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = { session: undefined, docs: new Map(), failReads: 0, deleted: [] };
const read = (fn) => async () => {
  if (db.failReads > 0) {
    db.failReads--;
    return null;
  }
  return fn();
};
vi.mock('../src/io/storage.js', () => ({
  recovery: {
    getSession: read(() => db.session),
    all: read(() => (db.failAll ? null : [...db.docs.values()])),
    setSession: async (v) => void (db.session = v),
    put: async (r) => (db.docs.set(r.id, r), true),
    delete: async (id) => void (db.deleted.push(id), db.docs.delete(id)),
  },
  errorText: () => '',
}));
const { App } = await import('../src/app.js');

function setup() {
  const app = Object.create(App.prototype);
  Object.assign(app, { docs: [], doc: null, ownsSession: true, _autosaveTimers: new Map(), _autosaving: new Set() });
  app.autosave = vi.fn(async () => {});
  return app;
}

/** What the next start would do with the stored session, as restoreSession does. */
const nextStart = () => {
  for (const id of [...db.docs.keys()]) if (!db.session.docs.includes(id)) db.docs.delete(id);
  return [...db.docs.keys()];
};

describe('recovery copies that cannot be read at start', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    db.session = { docs: ['a', 'b'], active: 'a' };
    db.docs = new Map([
      ['a', { id: 'a' }],
      ['b', { id: 'b' }],
    ]);
    db.failReads = 0;
    db.failAll = false;
    db.deleted = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  for (const [what, fails] of [
    ['the list of copies', 1],
    ['the session', 2],
  ]) {
    it(`are still there at the next start (${what} failed to load)`, async () => {
      const app = setup();
      db.failReads = fails === 2 ? 1 : 0;
      db.failAll = fails === 1;
      await app.restoreSession();
      db.failAll = false;
      expect(app.docs).toEqual([]);
      // The app goes on with a new drawing and records its session.
      app.docs.push({ id: 'new', drawing: {} });
      app.doc = app.docs[0];
      db.docs.set('new', { id: 'new' });
      app.saveSession();
      await vi.advanceTimersByTimeAsync(1000);
      expect(db.deleted).toEqual([]);
      expect(nextStart().sort()).toEqual(['a', 'b', 'new']);
      expect(db.session.active).toBe('new');
    });
  }

  it('leave the stored session alone while it still cannot be read', async () => {
    const app = setup();
    db.failReads = 99;
    await app.restoreSession();
    app.docs.push({ id: 'new', drawing: {} });
    app.saveSession();
    await vi.advanceTimersByTimeAsync(1000);
    expect(db.session.docs).toEqual(['a', 'b']);
    // Readable again later: the old drawings are kept beside the new one.
    db.failReads = 0;
    app.saveSession();
    await vi.advanceTimersByTimeAsync(1000);
    expect(db.session.docs).toEqual(['a', 'b', 'new']);
  });
});

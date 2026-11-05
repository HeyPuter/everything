/**
 * Signing out has to let go of the Contacts app, not just of its cache.
 *
 * Reading the address book means launching Contacts as a headless service and
 * holding that window open. It runs in the session being ended, so leaving it
 * behind means an invisible window still signed in as the previous user —
 * exactly what the snapshot is cleared to avoid.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { signOut } from '../src/js/auth.js';

// signOut never settles, so the reload in handleSignOut's `finally` is never
// reached and jsdom's location is left alone. Everything under test happens
// before the await.
vi.mock(import('../src/js/auth.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  signOut: vi.fn(() => new Promise(() => {})),
}));

const { createApp } = await import('../src/js/app.js');

function makeStore() {
  const s = { ...DEFAULT_SETTINGS, defaultView: 'agenda' };
  const listeners = new Set();
  return {
    getSettings: () => ({ ...s }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getAllEvents: () => [],
    getEventsInRange: () => [],
    getAllTasks: () => [],
    getTasksInRange: () => [],
    getTask: () => null,
    getEvent: () => null,
    saveSettings: async (patch) => (Object.assign(s, patch), { ...s }),
    toggleTask: async () => {},
  };
}

/** Only what createApp/modal.js touch on the contacts client. */
function makeContacts() {
  return {
    ready: () => false,
    inUse: () => false,
    warm: () => Promise.resolve(),
    revalidate: () => Promise.resolve(null),
    suggest: () => [],
    noteTyped: () => {},
    settle: () => {},
    onChange: () => () => {},
    invalidate: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('app — signing out', () => {
  let app;
  let root;

  beforeEach(() => {
    signOut.mockClear();
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
    root = document.createElement('div');
    document.body.append(root);
  });

  afterEach(() => {
    if (app) app.destroy();
    app = null;
    document.body.replaceChildren();
  });

  it('drops the cached address book and closes the Contacts service window', () => {
    const contacts = makeContacts();
    // A leftover profile-picture cache must go too — same shared-machine reason.
    // (Keyed to another account, so rendering never touches it in this test.)
    localStorage.setItem(
      'cal:profile-pic',
      JSON.stringify({ user: 'previous-account', picture: 'data:image/png;base64,AA==' }),
    );
    app = createApp(root, { store: makeStore(), user: { username: 'x' }, contacts });

    // Open the user menu and press Sign out, the way someone would.
    root.querySelector('button.avatar').click();
    const signOutBtn = [...document.querySelectorAll('.popover .menu-item')].find((b) =>
      b.textContent.includes('Sign out'),
    );
    expect(signOutBtn).toBeTruthy();
    signOutBtn.click();

    expect(contacts.invalidate).toHaveBeenCalledTimes(1);
    expect(contacts.dispose).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('cal:profile-pic')).toBe(null);
  });

  it('leaves the account\'s stored reminders in place for its other devices', async () => {
    const storedReminders = { handles: async () => false, stop: vi.fn(), sync: vi.fn() };
    const store = makeStore();
    await store.saveSettings({ storedReminders: true });
    const settings = store.getSettings();
    const saveSettings = vi.spyOn(store, 'saveSettings');
    app = createApp(root, { store, user: { username: 'x' }, storedReminders });
    root.querySelector('button.avatar').click();
    [...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent.includes('Sign out')).click();
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(storedReminders.stop).toHaveBeenCalledTimes(1);
    expect(store.getSettings()).toEqual(settings);
    expect(saveSettings).not.toHaveBeenCalled();
  });
});

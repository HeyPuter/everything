/**
 * A clicked push notification opens what it names, and the account menu's
 * push switch reflects and changes puter.notifications.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const { createApp } = await import('../src/js/app.js');

const HOUR = 3_600_000;
const START = Date.UTC(2026, 10, 3, 15);
const EVENT = { id: 'evt-1', title: 'Team offsite', start: START, end: START + HOUR, allDay: false, color: 'blue' };

function makeStore(events = [EVENT]) {
  const s = { ...DEFAULT_SETTINGS, defaultView: 'agenda' };
  return {
    getSettings: () => ({ ...s }),
    subscribe: () => () => {},
    getAllEvents: () => events,
    getEventsInRange: () => [],
    getAllTasks: () => [],
    getTasksInRange: () => [],
    getTask: () => null,
    getEvent: (id) => events.find((e) => e.id === id) || null,
    saveSettings: async (patch) => (Object.assign(s, patch), { ...s }),
    toggleTask: async () => {},
  };
}

function makeMail({ findByUid = () => null, pump = async () => {} } = {}) {
  return {
    mailbox: { available: () => false, onChange: () => () => {} },
    intake: { findByUid: vi.fn(findByUid), pump: vi.fn(pump), getPending: () => [], onChange: () => () => {} },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('app — notifications', () => {
  let app;
  let root;

  beforeEach(() => {
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
    delete globalThis.puter;
    document.body.replaceChildren();
  });

  it("a click naming an event id opens that event's card", () => {
    app = createApp(root, { store: makeStore(), user: { username: 'x' } });
    app.openNotification({ uid: 'n1', target: '/?event=evt-1', data: { eventId: 'evt-1' } });
    expect(document.querySelector('.modal-scrim')?.textContent).toContain('Team offsite');
  });

  it('reloads once for a clicked event created on another device', async () => {
    const events = [];
    const store = makeStore(events);
    store.load = vi.fn(async () => { events.push(EVENT); });
    app = createApp(root, { store, user: { username: 'x' } });
    await app.openNotification({ data: { eventId: EVENT.id } });
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.modal-scrim')?.textContent).toContain('Team offsite');
  });

  it('gives up after one reload if the clicked event is still missing', async () => {
    const store = makeStore([]);
    store.load = vi.fn(async () => {});
    app = createApp(root, { store, user: { username: 'x' } });
    await app.openNotification({ data: { eventId: EVENT.id } });
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.modal-scrim')).toBeNull();
  });

  it('a click naming an invitation UID opens its event once the intake has it, else the tray', async () => {
    // A phone, where the tray lives in the drawer.
    window.matchMedia = (query) => ({
      matches: query.includes('max-width: 720px'),
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
    const mail = makeMail();
    app = createApp(root, { store: makeStore(), user: { username: 'x' }, mail });
    app.openNotification({ uid: 'n1', target: '/?uid=x%40google.com', data: { uid: 'x@google.com' } });
    await flush();
    expect(mail.intake.pump).toHaveBeenCalled();
    expect(document.querySelector('.modal-scrim')).toBeNull();
    expect(root.querySelector('.app').classList.contains('sidebar-open')).toBe(true);

    app.destroy();
    root.replaceChildren();
    const found = makeMail({ findByUid: (uid) => (uid === 'x@google.com' ? EVENT : null) });
    app = createApp(root, { store: makeStore(), user: { username: 'x' }, mail: found });
    app.openNotification({ uid: 'n2', target: null, data: { uid: 'x@google.com' } });
    expect(document.querySelector('.modal-scrim')?.textContent).toContain('Team offsite');
  });

  it('the account menu shows the switch with the permission state, and turns pushes on from it', async () => {
    const notifications = {
      status: vi.fn(async () => 'off'),
      requestPermission: vi.fn(async () => true),
      enable: vi.fn(async () => true),
    };
    globalThis.puter = { env: 'app', notifications };
    app = createApp(root, { store: makeStore(), user: { username: 'x' } });
    root.querySelector('button.avatar').click();
    const input = document.querySelector('.popover input[data-setting="push"]');
    expect(input).toBeTruthy();
    await flush();
    expect(input.checked).toBe(false);
    expect(input.disabled).toBe(false);

    notifications.status.mockResolvedValue('on');
    input.click();
    expect(notifications.requestPermission).not.toHaveBeenCalled();
    await flush();
    await flush();
    expect(notifications.enable).toHaveBeenCalledTimes(1);
    expect(input.checked).toBe(true);
  });

  it('on an iPhone outside the Home Screen, the menu explains how to get notifications', () => {
    globalThis.puter = { env: 'web', notifications: {} };
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    try {
      app = createApp(root, { store: makeStore(), user: { username: 'x' } });
      root.querySelector('button.avatar').click();
      expect(document.querySelector('.popover input[data-setting="push"]')).toBeNull();
      expect(document.querySelector('.popover').textContent).toContain('Add to Home Screen');
    } finally {
      ua.mockRestore();
    }
  });

  it('uses blocked status for the site-settings toast, including inside the desktop', async () => {
    globalThis.puter = { env: 'app', notifications: {
      status: vi.fn(async () => 'blocked'),
      enable: vi.fn(async () => false),
    } };
    app = createApp(root, { store: makeStore(), user: { username: 'x' } });
    root.querySelector('button.avatar').click();
    const input = document.querySelector('.popover input[data-setting="push"]');
    await flush();
    input.click();
    await flush();
    expect(document.body.textContent).toContain('Notifications are blocked for this site');
    expect(input.checked).toBe(false);
  });
});

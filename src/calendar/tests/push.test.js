import { describe, it, expect, vi, beforeEach } from 'vitest';

async function freshPush() {
  vi.resetModules();
  return import('../src/js/push.js');
}

function makeNotifications(overrides = {}) {
  return {
    on: vi.fn(),
    onPush: vi.fn(async () => ({ off() {} })),
    enable: vi.fn(async () => true),
    disable: vi.fn(async () => true),
    requestPermission: vi.fn(async () => true),
    status: vi.fn(async () => 'on'),
    ...overrides,
  };
}

describe('push: startPush()', () => {
  it('registers the calendar channel against the app worker, once', async () => {
    const { startPush } = await freshPush();
    const notifications = makeNotifications();
    startPush({ env: 'web', notifications });
    startPush({ env: 'web', notifications });
    expect(notifications.onPush).toHaveBeenCalledTimes(1);
    const [key, handler, options] = notifications.onPush.mock.calls[0];
    expect(key).toBe('calendar');
    expect(options).toEqual({ serviceWorker: './sw.js' });
    // The worker rebuilds it from source, so it must stand on its own.
    const rebuilt = new Function(`"use strict"; return (${handler.toString()});`)();
    expect(rebuilt({ title: 'Ana invited you to Team sync', text: 'ana@example.com', target: '/?uid=x' })).toEqual({
      title: 'Ana invited you to Team sync',
      body: 'ana@example.com',
      url: '/?uid=x',
    });
    expect(rebuilt({ title: 'T', text: null, target: null })).toEqual({ title: 'T', body: '', url: '/' });
    expect(rebuilt({ title: 'Review', text: 'Starts in 10 minutes\n9:00 – 10:00 · Room 2', target: '/?event=e1' })).toEqual({
      title: 'Review', body: 'Starts in 10 minutes\n9:00 – 10:00 · Room 2', url: '/?event=e1',
    });
  });

  it('holds the launching click until the app routes clicks', async () => {
    const { startPush, routeNotificationClicks } = await freshPush();
    const notifications = makeNotifications();
    startPush({ env: 'web', notifications });
    const onClick = notifications.on.mock.calls[0][1];
    onClick({ uid: 'n1', target: '/?event=e1', data: { eventId: 'e1' } });

    const route = vi.fn();
    routeNotificationClicks(route);
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0][0].uid).toBe('n1');

    onClick({ uid: 'n2', target: null, data: null });
    expect(route).toHaveBeenCalledTimes(2);
  });
});

describe('push: notificationTarget()', () => {
  it('reads ids from data first, then from the target query', async () => {
    const { notificationTarget } = await freshPush();
    expect(notificationTarget({ data: { eventId: 'e1' }, target: '/?event=e2' })).toEqual({ eventId: 'e1', uid: '' });
    expect(notificationTarget({ data: null, target: '/?event=e2' })).toEqual({ eventId: 'e2', uid: '' });
    expect(notificationTarget({ data: null, target: '/?uid=a%40b.com' })).toEqual({ eventId: '', uid: 'a@b.com' });
    // A sensitive push carries neither.
    expect(notificationTarget({ uid: 'n', target: null, data: null })).toEqual({ eventId: '', uid: '' });
  });
});

describe('push: needsHomeScreen()', () => {
  const win = (standalone) => ({ matchMedia: () => ({ matches: standalone }) });
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 };

  it('is true for iPhone Safari and false once opened from the Home Screen', async () => {
    const { needsHomeScreen } = await freshPush();
    expect(needsHomeScreen(iphone, win(false))).toBe(true);
    expect(needsHomeScreen(iphone, win(true))).toBe(false);
    expect(needsHomeScreen({ ...iphone, standalone: true }, win(false))).toBe(false);
  });

  it('counts an iPad that reports itself as a Mac, and never a desktop', async () => {
    const { needsHomeScreen } = await freshPush();
    expect(needsHomeScreen({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 }, win(false))).toBe(true);
    expect(needsHomeScreen({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 }, win(false))).toBe(false);
  });
});

describe('push: the settings switch', () => {
  beforeEach(() => localStorage.removeItem('cal:push-off'));

  it('turning on calls enable() with the app worker, before anything else', async () => {
    const { turnPushOn, pushOffHere } = await freshPush();
    localStorage.setItem('cal:push-off', '1');
    const notifications = makeNotifications();
    const pending = turnPushOn({ env: 'web', notifications });
    expect(notifications.enable).toHaveBeenCalledWith({ serviceWorker: './sw.js' });
    expect(await pending).toBe(true);
    expect(pushOffHere()).toBe(false);
  });

  it('after push_revoked, asks Puter again and retries', async () => {
    const { turnPushOn } = await freshPush();
    const revoked = Object.assign(new Error('revoked'), { code: 'push_revoked' });
    const notifications = makeNotifications({ enable: vi.fn().mockRejectedValueOnce(revoked).mockResolvedValue(true) });
    expect(await turnPushOn({ env: 'web', notifications })).toBe(true);
    expect(notifications.requestPermission).toHaveBeenCalledTimes(1);
    expect(notifications.enable).toHaveBeenCalledTimes(2);
  });

  it("inside the Puter desktop, asks with Puter's dialog", async () => {
    const { turnPushOn } = await freshPush();
    const notifications = makeNotifications({ enable: vi.fn(async () => false) });
    expect(await turnPushOn({ env: 'app', notifications })).toBe(false);
    expect(notifications.enable).toHaveBeenCalledWith({ serviceWorker: './sw.js' });
    expect(notifications.requestPermission).not.toHaveBeenCalled();
  });

  it('turning off calls disable() on the web and desktop and remembers the choice', async () => {
    const { turnPushOff, pushOffHere } = await freshPush();
    const notifications = makeNotifications();
    expect(await turnPushOff({ env: 'web', notifications })).toBe(true);
    expect(notifications.disable).toHaveBeenCalledWith({ serviceWorker: './sw.js' });
    expect(pushOffHere()).toBe(true);

    localStorage.removeItem('cal:push-off');
    const desktop = makeNotifications();
    expect(await turnPushOff({ env: 'app', notifications: desktop })).toBe(true);
    expect(desktop.disable).toHaveBeenCalledWith({ serviceWorker: './sw.js' });
    expect(pushOffHere()).toBe(true);
  });

  it('reads status() for both the desktop and web', async () => {
    const { pushEnabled } = await freshPush();
    for (const env of ['app', 'web']) {
      const notifications = makeNotifications();
      expect(await pushEnabled({ env, notifications })).toBe(true);
      expect(notifications.status).toHaveBeenCalledWith({ serviceWorker: './sw.js' });
      for (const status of ['off', 'blocked', 'unavailable']) {
        notifications.status.mockResolvedValue(status);
        expect(await pushEnabled({ env, notifications })).toBe(false);
      }
    }
  });

  it('enables the account reminder setting only after a successful enable, and leaves it on when disabling', async () => {
    const { turnPushOn, turnPushOff } = await freshPush();
    const notifications = makeNotifications();
    const store = { saveSettings: vi.fn(async () => {}) };
    await turnPushOn({ env: 'web', notifications }, store);
    expect(store.saveSettings).toHaveBeenCalledExactlyOnceWith({ storedReminders: true });
    await turnPushOff({ env: 'web', notifications });
    notifications.enable.mockResolvedValue(false);
    await turnPushOn({ env: 'web', notifications }, store);
    expect(store.saveSettings).toHaveBeenCalledTimes(1);
  });
});

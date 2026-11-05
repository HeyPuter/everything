/**
 * The notice shown when pushes don't reach this device and the user didn't
 * turn them off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function web(permission, overrides = {}) {
  vi.stubGlobal('Notification', { permission });
  vi.stubGlobal('PushManager', function PushManager() {});
  Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
  return {
    env: 'web',
    notifications: {
      on: vi.fn(),
      onPush: vi.fn(async () => ({ off() {} })),
      enable: vi.fn(async () => true),
      disable: vi.fn(async () => true),
      requestPermission: vi.fn(async () => true),
      status: vi.fn(async () => 'off'),
      ...overrides,
    },
  };
}

async function load() {
  vi.resetModules();
  return import('../src/js/push-notice.js');
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const notice = () => document.querySelector('.toast');

describe('push notice', () => {
  let watcher;

  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  afterEach(() => {
    watcher?.stop();
    watcher = null;
    vi.restoreAllMocks();
  });

  it('says pushes are off once this device was asked, and turns them on from the click', async () => {
    localStorage.setItem('cal:notify-asked', '1');
    const { watchPushHealth } = await load();
    const p = web('default');
    watcher = watchPushHealth(p, null);
    await flush();
    expect(notice().textContent).toContain('Notifications are off on this device');
    p.notifications.status.mockResolvedValue('on');
    notice().querySelector('.toast__action').click();
    // From the click itself, so the browser can still ask.
    expect(p.notifications.enable).toHaveBeenCalledTimes(1);
    await flush();
    expect(document.querySelector('.toast:not(.is-leaving)')).toBeNull();
  });

  it('waits while the first-click prompt is still to come', async () => {
    const { watchPushHealth } = await load();
    const { autoEnablePush } = await import('../src/js/push.js');
    const p = web('default');
    await autoEnablePush(p, null);
    watcher = watchPushHealth(p, null);
    await flush();
    expect(notice()).toBeNull();
  });

  it('explains a block with no button, and closing it hides it for a week', async () => {
    const { watchPushHealth } = await load();
    const p = web('denied', { status: vi.fn(async () => 'blocked') });
    watcher = watchPushHealth(p, null);
    await flush();
    expect(notice().textContent).toContain('site settings');
    expect(notice().querySelector('.toast__action')).toBeNull();
    notice().querySelector('.toast__close').click();
    expect(Number(localStorage.getItem('cal:push-notice'))).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);
    watcher.stop();
    document.body.replaceChildren();
    watcher = (await load()).watchPushHealth(p, null);
    await flush();
    expect(notice()).toBeNull();
  });

  it('stays quiet when pushes are on or were turned off here', async () => {
    const { watchPushHealth } = await load();
    watcher = watchPushHealth(web('granted', { status: vi.fn(async () => 'on') }), null);
    await flush();
    expect(notice()).toBeNull();
    watcher.stop();
    localStorage.setItem('cal:push-off', '1');
    watcher = watchPushHealth(web('granted'), null);
    await flush();
    expect(notice()).toBeNull();
  });

  it('repairs and re-checks when the tab comes back, at most once a minute', async () => {
    localStorage.setItem('cal:notify-asked', '1');
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { watchPushHealth } = await load();
    const p = web('denied', { status: vi.fn(async () => 'blocked') });
    watcher = watchPushHealth(p, null);
    await flush();
    expect(notice()).not.toBeNull();
    // Allowed in the site settings meanwhile.
    vi.stubGlobal('Notification', { permission: 'granted' });
    p.notifications.status.mockResolvedValue('off');
    p.notifications.enable.mockImplementation(async () => {
      p.notifications.status.mockResolvedValue('on');
      return true;
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(p.notifications.enable).not.toHaveBeenCalled();
    now += 61_000;
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(p.notifications.enable).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.toast:not(.is-leaving)')).toBeNull();
  });
});

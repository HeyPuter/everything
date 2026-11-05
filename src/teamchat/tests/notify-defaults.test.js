import { describe, it, expect, vi, afterEach } from 'vitest';
import { installDom } from './helpers/dom.js';

const REF = 'abc123def0@teamchat-test';
let dom;
afterEach(() => {
  vi.restoreAllMocks();
  dom?.uninstall(); dom = null;
  delete globalThis.puter;
  delete globalThis.Notification;
});

async function setup({ env = 'web', permission = 'default', status = 'off', prefs = {}, allowed = false } = {}) {
  dom = installDom();
  vi.resetModules();
  const calls = [];
  globalThis.Notification = { permission, requestPermission: vi.fn(async () => { calls.push('browser'); return 'granted'; }) };
  const off = vi.fn(async () => { calls.push('off'); });
  const notifications = {
    enable: vi.fn(async () => { calls.push('enable'); return true; }),
    status: vi.fn(async () => status), disable: vi.fn(async () => { calls.push('disable'); return true; }),
    hasPermission: vi.fn(async () => allowed),
    onPush: vi.fn(async () => ({ off })),
  };
  globalThis.puter = {
    env, notifications,
    auth: { signOut: vi.fn(async () => { calls.push('signOut'); }) },
    workers: { exec: vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })) },
  };
  const { store } = await import('../src/lib/store.js');
  const pwa = await import('../src/lib/pwa.js');
  store.profile = { uuid: 'u-me', prefs };
  store.workspaces = [{ ref: REF }];
  vi.spyOn(store, 'updatePrefs').mockImplementation(async (patch) => Object.assign(store.profile.prefs, patch));
  return { store, pwa, notifications, calls, off };
}

const click = () => document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

describe('notifications on by default', () => {
  it('turns pushes on without asking where the browser already allows them', async () => {
    const { store, notifications } = await setup({ permission: 'granted' });
    await store.autoEnablePush();
    expect(notifications.enable).toHaveBeenCalledTimes(1);
    expect(store.profile.prefs.push).toBe(true);
  });

  it('does nothing when pushes are already on here', async () => {
    const { store, notifications } = await setup({ permission: 'granted', status: 'on' });
    await store.autoEnablePush();
    expect(notifications.enable).not.toHaveBeenCalled();
  });

  it('asks once, from the first click, synchronously', async () => {
    const { store, notifications } = await setup();
    await store.autoEnablePush();
    expect(notifications.enable).not.toHaveBeenCalled();
    click();
    expect(notifications.enable).toHaveBeenCalledTimes(1);
    click();
    expect(notifications.enable).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('tc:notify-asked')).toBe('1');
  });

  it('does not ask again on a device that was asked before', async () => {
    const { store, notifications } = await setup();
    localStorage.setItem('tc:notify-asked', '1');
    await store.autoEnablePush();
    click();
    expect(notifications.enable).not.toHaveBeenCalled();
  });

  it.each([
    ['pushes are turned off', { prefs: { push: false } }],
    ['the browser blocks notifications', { permission: 'denied' }],
  ])('neither asks nor enables when %s', async (_name, opts) => {
    const { store, notifications } = await setup(opts);
    await store.autoEnablePush();
    click();
    expect(notifications.enable).not.toHaveBeenCalled();
    expect(Notification.requestPermission).not.toHaveBeenCalled();
  });

  it('turns pushes on inside the desktop when the app is already allowed', async () => {
    const { store, notifications } = await setup({ env: 'app', allowed: true });
    await store.autoEnablePush();
    expect(notifications.enable).toHaveBeenCalledTimes(1);
  });
});

describe('signing out', () => {
  it('removes this browser\'s push handler and subscription before the session ends', async () => {
    const { store, pwa, calls } = await setup();
    await pwa.listenForPushes();
    await store.signOut();
    expect(calls).toEqual(['off', 'disable', 'signOut']);
  });

  it('inside the desktop removes the handler but leaves the app\'s permission alone', async () => {
    const { store, pwa, calls, notifications } = await setup({ env: 'app' });
    await pwa.listenForPushes();
    await store.signOut();
    expect(notifications.disable).not.toHaveBeenCalled();
    expect(calls).toEqual(['off', 'signOut']);
  });
});

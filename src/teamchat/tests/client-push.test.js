import { describe, it, expect, vi, afterEach } from 'vitest';
import { installDom } from './helpers/dom.js';

const REF = 'abc123def0@teamchat-test';
let dom;
afterEach(() => {
  vi.restoreAllMocks();
  dom?.uninstall(); dom = null;
  delete globalThis.puter;
});

async function setup(env = 'web') {
  dom = installDom();
  vi.resetModules();
  const calls = [];
  const notifications = {
    enable: vi.fn(async () => { calls.push('enable'); return true; }),
    status: vi.fn(async () => 'on'), disable: vi.fn(async () => true),
    onPush: vi.fn(async () => ({ off: async () => {} })),
  };
  const perms = { request: vi.fn(async (extra) => { calls.push('extra'); return extra.map(() => true); }) };
  globalThis.puter = {
    env, notifications, perms,
    workers: { exec: vi.fn(async (url, init) => {
      calls.push([init.method, new URL(url).pathname]);
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) },
  };
  const { store } = await import('../src/lib/store.js');
  store.profile = { uuid: 'u-me', prefs: {} };
  store.workspaces = [{ ref: REF }];
  vi.spyOn(store, 'updatePrefs').mockImplementation(async (patch) => Object.assign(store.profile.prefs, patch));
  return { store, notifications, perms, calls, pwa: await import('../src/lib/pwa.js') };
}

describe('push controls', () => {
  it.each(['web', 'app'])('enables from the click in %s without background consent or subscriptions', async (env) => {
    const { store, notifications, perms, calls } = await setup(env);
    const enabling = store.setPush(true);
    if (env === 'web') expect(notifications.enable).toHaveBeenCalledTimes(1);
    expect(await enabling).toMatchObject({ on: true, device: true });
    expect(calls[0]).toBe('enable');
    expect(perms.request).not.toHaveBeenCalled();
    expect(puter.workers.exec).toHaveBeenCalledWith(expect.stringContaining('/pn'), expect.objectContaining({ method: 'POST' }));
    expect(store.pushStatus).toBe('on');
    expect(notifications.status).toHaveBeenCalledWith({ serviceWorker: expect.stringContaining('sw.js') });
  });

  it('retires legacy push before opening the desktop permission dialog', async () => {
    const { pwa, notifications, calls } = await setup('app');
    let release;
    const retire = vi.fn(() => new Promise((resolve) => { calls.push('retire'); release = resolve; }));
    const enabling = pwa.enablePuterPush(retire);
    expect(notifications.enable).not.toHaveBeenCalled();
    release();
    expect(await enabling).toBe(true);
    expect(calls).toEqual(['retire', 'enable']);
  });

  it('enables immediately on the web and retires a conflicting legacy subscription before retrying', async () => {
    const { pwa, notifications, calls } = await setup();
    notifications.enable.mockImplementationOnce(async () => {
      calls.push('enable');
      throw { code: 'push_subscription_conflict' };
    });
    const retire = vi.fn(async () => { calls.push('retire'); });
    const enabling = pwa.enablePuterPush(retire);
    expect(calls).toEqual(['enable']);
    expect(await enabling).toBe(true);
    expect(calls).toEqual(['enable', 'retire', 'enable']);
  });

  it.each([true, false])('remembers a declined owner sharing grant (push offered: %s)', async (push) => {
    const { store, perms } = await setup();
    puter.appID = 'app-teamchat-test';
    store.profile.prefs.push = !push;
    perms.request.mockResolvedValue([false]);
    expect(await store.offerPush({ owner: true })).toMatchObject({ grant: false });
    expect(store.updatePrefs).toHaveBeenCalledWith({ evConsent: 'declined' });
    expect(store.profile.prefs.evConsent).toBe('declined');
    expect(store.offerPush({ owner: true })).toBeNull();
    expect(perms.request).toHaveBeenCalledTimes(1);
  });

  it('does not record a sharing refusal when no grant was requested or when it was granted', async () => {
    const { store } = await setup();
    await store.offerPush();
    puter.appID = 'app-teamchat-test';
    expect(await store.offerPush({ owner: true })).toMatchObject({ grant: true });
    expect(store.profile.prefs.evConsent).toBeUndefined();
    expect(store.updatePrefs).not.toHaveBeenCalledWith({ evConsent: 'declined' });
  });

  it('asks only for extra sharing consent when supplied', async () => {
    const { store, perms, calls } = await setup();
    const extra = [{ resource: 'kvShare', prefix: 'tc:ws', access: 'watch' }];
    expect((await store.setPush(true, { extra })).granted).toEqual([true]);
    expect(perms.request).toHaveBeenCalledWith(extra);
    expect(calls.slice(0, 2)).toEqual(['enable', 'extra']);
  });

  it('keeps the switch off when enable is declined', async () => {
    const { store, notifications } = await setup();
    notifications.enable.mockResolvedValue(false);
    notifications.status.mockResolvedValue('off');
    expect((await store.setPush(true)).on).toBe(false);
    expect(store.profile.prefs.pushDeclined).toBe(true);
    expect(store.pushStatus).toBe('off');
    expect(puter.workers.exec).not.toHaveBeenCalled();
  });

  it.each(['web', 'app'])('unregisters opt-in and disables Puter pushes in %s', async (env) => {
    const { store, notifications } = await setup(env);
    notifications.status.mockResolvedValue('off');
    await store.setPush(false);
    expect(puter.workers.exec).toHaveBeenCalledWith(expect.stringContaining('/pn'), expect.objectContaining({ method: 'DELETE' }));
    expect(notifications.disable).toHaveBeenCalledTimes(1);
    expect(store.pushStatus).toBe('off');
  });

  it('registers only the chat channel on each load, even when opt-in is off', async () => {
    const { pwa, notifications } = await setup();
    await pwa.listenForPushes();
    await pwa.listenForPushes();
    expect(notifications.onPush).toHaveBeenCalledTimes(1);
    const [channel, show] = notifications.onPush.mock.calls[0];
    expect(channel).toBe('chat');
    expect(await show({ target: '/#/ws/room', data: { g: 'tag' } })).toEqual({ tag: 'tag', url: '/#/ws/room' });
    expect(await show({ target: '/#/ws/room', data: { g: 'tag', c: 1 } })).toEqual({ tag: 'tag', requireInteraction: true, url: '/#/ws/room' });
    vi.resetModules();
    await (await import('../src/lib/pwa.js')).listenForPushes();
    expect(notifications.onPush).toHaveBeenCalledTimes(2);
  });
});

describe('dismissing shown notifications', () => {
  it('dismisses only the ones under the given tags', async () => {
    const { pwa, notifications } = await setup();
    notifications.dismiss = vi.fn(async () => true);
    const shown = [
      { tag: `${REF}:message-c1`, data: { puter: { uid: 'n1' } } },
      { tag: `${REF}:message-c2`, data: { puter: { uid: 'n2' } } },
      { tag: `${REF}:message-c1`, data: { route: '#/' } },
    ];
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true, value: { getRegistration: async () => ({ getNotifications: async () => shown }) },
    });
    try {
      await pwa.dismissShown(new Set([`${REF}:message-c1`]));
      expect(notifications.dismiss.mock.calls).toEqual([['n1']]);
    } finally {
      delete navigator.serviceWorker;
    }
  });
});

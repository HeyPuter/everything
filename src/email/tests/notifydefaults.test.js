import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { createSampleMailbox } from '../src/lib/sample.js';
import { createDraftStore } from '../src/lib/drafts.js';
import { memoryStorage } from '../src/lib/readstate.js';
import { stopListening, releasePushHere, listenForPushes } from '../src/ui/push.js';

/** New-mail notifications are on unless turned off: asked once, or turned on silently. */

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
let root;
let sdk;

const mount = async ({ permission = 'default', status = 'off', env = 'web', allowed = false, subs = [] } = {}) => {
  window.Notification = { permission, requestPermission: vi.fn(async () => 'granted') };
  sdk = {
    env,
    notifications: {
      status: vi.fn(async () => status),
      enable: vi.fn(async () => true),
      disable: vi.fn(async () => true),
      hasPermission: vi.fn(async () => allowed),
      onPush: vi.fn(async () => ({ off: async () => {} })),
    },
    perms: { request: vi.fn(async () => true) },
    events: {
      list: vi.fn(async () => subs),
      onPersistent: vi.fn(async (options) => ({ subId: 'sub-1', queue: true, ...options })),
      unsubscribe: vi.fn(async () => {}),
    },
  };
  vi.stubGlobal('puter', sdk);
  const mailbox = createSampleMailbox();
  renderApp(root, {
    ...mailbox,
    sample: false,
    canPush: true,
    account: { username: 'tester' },
    drafts: createDraftStore('tester', memoryStorage()),
    onCompose: () => {},
  });
  await settle();
};

const click = () => document.dispatchEvent(new Event('pointerdown', { bubbles: true }));

beforeEach(() => {
  window.localStorage.clear();
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(async () => {
  click(); // disarm a listener a test left waiting
  await stopListening();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  root.remove();
  delete window.Notification;
  document.querySelectorAll('.toast').forEach((node) => node.remove());
  window.localStorage.clear();
});

describe('new-mail notifications on by default', () => {
  it('turns pushes on without asking where the browser already allows them', async () => {
    await mount({ permission: 'granted' });
    expect(sdk.notifications.enable).toHaveBeenCalledTimes(1);
    expect(sdk.events.onPersistent).toHaveBeenCalled();
  });

  it('does nothing when pushes are already on here', async () => {
    await mount({ permission: 'granted', status: 'on' });
    expect(sdk.notifications.enable).not.toHaveBeenCalled();
  });

  it('asks once, from the first click, synchronously', async () => {
    await mount();
    expect(sdk.notifications.enable).not.toHaveBeenCalled();
    click();
    expect(sdk.notifications.enable).toHaveBeenCalledTimes(1);
    click();
    expect(sdk.notifications.enable).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('puter-mail:notify-asked')).toBe('1');
  });

  it.each([
    ['this device was asked before', () => window.localStorage.setItem('puter-mail:notify-asked', '1'), {}],
    ['notifications were turned off here', () => window.localStorage.setItem('puter-mail:notify-off', '1'), { permission: 'granted' }],
    ['the browser blocks them', () => {}, { permission: 'denied' }],
  ])('neither asks nor enables when %s', async (_name, before, opts) => {
    before();
    await mount(opts);
    click();
    expect(sdk.notifications.enable).not.toHaveBeenCalled();
  });

  it('turns pushes on inside the desktop when the app is already allowed', async () => {
    await mount({ env: 'app', allowed: true });
    expect(sdk.notifications.enable).toHaveBeenCalledTimes(1);
  });
});

describe('signing out', () => {
  it.each([
    ['web', ['off', 'disable']],
    ['app', ['off']],
  ])('in %s removes this browser\'s push handler first, and its subscription only on a website', async (env, expected) => {
    const calls = [];
    vi.stubGlobal('puter', {
      env,
      notifications: {
        onPush: vi.fn(async () => ({ off: async () => { calls.push('off'); } })),
        disable: vi.fn(async () => { calls.push('disable'); }),
      },
      events: { list: vi.fn(), unsubscribe: vi.fn() },
    });
    await listenForPushes();
    await releasePushHere();
    expect(calls).toEqual(expected);
    expect(puter.events.unsubscribe).not.toHaveBeenCalled();
  });
});

describe('saying when new mail cannot reach this device', () => {
  const notice = () => root.querySelector('.push-notice');
  const asked = () => window.localStorage.setItem('puter-mail:notify-asked', '1');

  it('says nothing before this device was asked: the first click asks', async () => {
    await mount();
    expect(notice().hidden).toBe(true);
  });

  it('offers Turn on once asked and still off, which enables from the click', async () => {
    asked();
    await mount();
    expect(notice().hidden).toBe(false);
    expect(notice().textContent).toMatch(/off in this browser/);
    const button = [...notice().querySelectorAll('button')].find((b) => b.textContent === 'Turn on');
    button.click();
    expect(sdk.notifications.enable).toHaveBeenCalledTimes(1);
  });

  it('explains how to allow them when the browser blocks them', async () => {
    await mount({ permission: 'denied' });
    expect(notice().hidden).toBe(false);
    expect(notice().textContent).toMatch(/blocks them/);
    expect(notice().textContent).toMatch(/How to allow/);
  });

  it('names a suspended subscription, with nothing to press', async () => {
    const subs = [{
      subId: 'sub-1', subject: 'fs:~/.mail/objects/*/*:add', handlerName: 'mail-notify-v1', queue: true, suspendedReason: 'no_credit',
    }];
    await mount({ permission: 'granted', status: 'on', subs });
    expect(notice().hidden).toBe(false);
    expect(notice().textContent).toMatch(/credit/);
    expect(notice().querySelector('.btn')).toBeNull();
  });

  it('remakes a lapsed subscription without saying anything', async () => {
    await mount({ permission: 'granted', status: 'on' });
    expect(sdk.events.onPersistent).toHaveBeenCalledTimes(1);
    expect(notice().hidden).toBe(true);
  });

  it('says nothing when turned off here', async () => {
    window.localStorage.setItem('puter-mail:notify-off', '1');
    await mount({ permission: 'denied' });
    expect(notice().hidden).toBe(true);
  });

  it('stays away for a week once dismissed', async () => {
    asked();
    await mount();
    notice().querySelector('[aria-label="Dismiss"]').click();
    expect(notice().hidden).toBe(true);
    const put = JSON.parse(window.localStorage.getItem('puter-mail:push-notice'));
    expect(put.health).toBe('not-set-up');
    expect(put.until - Date.now()).toBeGreaterThan(6 * 24 * 3600_000);
  });

  it('turns pushes back on when the tab returns and the browser now allows them', async () => {
    asked();
    await mount();
    expect(sdk.notifications.enable).not.toHaveBeenCalled();
    window.Notification.permission = 'granted';
    const real = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => real() + 120_000);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(sdk.notifications.enable).toHaveBeenCalledTimes(1);
  });
});

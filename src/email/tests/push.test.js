import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { turnOnPush, turnOffPush, ensureSubscription, stopListening, listenForPushes, dismissNewMail } from '../src/ui/push.js';
import { NOTIFY_HANDLER, NEW_MAIL_SUBJECT, clickedMessage, needsHomeScreen } from '../src/lib/notify.js';

/**
 * Turning new-mail pushes on and off, over `puter` stubbed at the calls the
 * flow makes. The order is the point: the browser's prompt only shows inside
 * the click, so enable() has to come before anything else is awaited.
 */

const CONTEXT = { previews: true, self: ['tester@puter.email'] };
let order;
let subs;

const stubPuter = ({ env = 'web', enable = async () => true, granted = true } = {}) => {
  order = [];
  subs = [];
  const step = (name, fn) => vi.fn(async (...args) => {
    order.push(name);
    return fn(...args);
  });
  const sdk = {
    env,
    notifications: {
      enable: step('enable', enable),
      disable: step('disable', async () => true),
      onPush: step('onPush', async () => ({ off: async () => {} })),
    },
    perms: { request: step('perms', async (request) => Array.isArray(request) ? [granted, granted] : granted) },
    events: {
      list: step('list', async () => subs),
      update: step('update', async (subId, { context }) => {
        const sub = subs.find((sub) => sub.subId === subId);
        Object.assign(sub, { context });
        return sub;
      }),
      onPersistent: step('subscribe', async (options) => {
        const sub = { subId: `sub-${subs.length + 1}`, subject: options.subject, handlerName: options.handlerName, queue: true };
        subs.push(sub);
        return sub;
      }),
      unsubscribe: step('unsubscribe', async (subId) => {
        subs = subs.filter((sub) => sub.subId !== subId);
      }),
    },
  };
  vi.stubGlobal('puter', sdk);
  return sdk;
};

beforeEach(() => stubPuter());
afterEach(async () => {
  await stopListening();
  vi.unstubAllGlobals();
});

describe('turning pushes on', () => {
  it('asks the browser first, then Puter once, then subscribes as a queue', async () => {
    const sdk = puter;
    await expect(turnOnPush(CONTEXT)).resolves.toBe('on');
    expect(order.slice(0, 4)).toEqual(['enable', 'perms', 'list', 'subscribe']);
    expect(sdk.perms.request).toHaveBeenCalledWith('backgroundEvents');
    expect(sdk.events.onPersistent).toHaveBeenCalledWith({
      subject: NEW_MAIL_SUBJECT, handlerName: NOTIFY_HANDLER, queue: true, context: CONTEXT,
    });
    expect(sdk.notifications.onPush).toHaveBeenCalledWith('mail', expect.any(Function));
  });

  it('calls enable() inside the click, before anything is awaited', async () => {
    const done = turnOnPush(CONTEXT);
    expect(order).toEqual(['enable']);
    await done;
  });

  it('keeps the subscription it finds rather than adding another', async () => {
    subs = [{ subId: 'old', subject: NEW_MAIL_SUBJECT, handlerName: NOTIFY_HANDLER, queue: true }];
    await turnOnPush(CONTEXT);
    expect(puter.events.onPersistent).not.toHaveBeenCalled();
    expect(subs.map((sub) => sub.subId)).toEqual(['old']);
  });

  it('replaces one a withdrawn permission suspended, and drops duplicates', async () => {
    subs = [
      { subId: 'revoked', subject: NEW_MAIL_SUBJECT, handlerName: NOTIFY_HANDLER, suspendedReason: 'permission_revoked' },
      { subId: 'other', subject: 'fs:~/Documents', handlerName: 'someone-else' },
    ];
    await ensureSubscription(CONTEXT);
    expect(subs.map((sub) => sub.subId)).toEqual(['other', 'sub-3']);

    subs.push({ subId: 'twin', subject: NEW_MAIL_SUBJECT, handlerName: NOTIFY_HANDLER, queue: true });
    await ensureSubscription(CONTEXT);
    expect(subs.filter((sub) => sub.handlerName === NOTIFY_HANDLER)).toHaveLength(1);
  });

  it('updates the existing subscription for new context', async () => {
    subs = [{ subId: 'old', subject: NEW_MAIL_SUBJECT, handlerName: NOTIFY_HANDLER, queue: true }];
    await ensureSubscription({ ...CONTEXT, previews: false }, { replace: true });
    expect(order).toEqual(['list', 'update']);
    expect(subs.map((sub) => sub.subId)).toEqual(['old']);
  });

  it('stops at a browser that says no', async () => {
    stubPuter({ enable: async () => false });
    await expect(turnOnPush(CONTEXT)).resolves.toBe('blocked');
    expect(order).toEqual(['enable']);
  });

  it('turns the browser off again when Puter is told no', async () => {
    stubPuter({ granted: false });
    await expect(turnOnPush(CONTEXT)).resolves.toBe('declined');
    expect(order).toEqual(['enable', 'perms', 'disable']);
  });

  it('asks Puter again when the user had turned the app off there', async () => {
    let first = true;
    stubPuter({
      enable: async () => {
        if (!first) return true;
        first = false;
        throw Object.assign(new Error('revoked'), { code: 'push_revoked' });
      },
    });
    await expect(turnOnPush(CONTEXT)).resolves.toBe('on');
    expect(order.slice(0, 3)).toEqual(['enable', 'perms', 'enable']);
    expect(puter.perms.request).toHaveBeenCalledWith([
      { resource: 'backgroundEvents' }, { resource: 'pushNotifications' },
    ]);
  });

  it('says so where the server sends no pushes', async () => {
    stubPuter({ enable: async () => { throw Object.assign(new Error('no'), { code: 'push_unavailable' }); } });
    await expect(turnOnPush(CONTEXT)).resolves.toBe('unavailable');
  });

  it('lets enable() open the Puter desktop dialog once', async () => {
    stubPuter({ env: 'app' });
    await expect(turnOnPush(CONTEXT)).resolves.toBe('on');
    expect(order.slice(0, 4)).toEqual(['enable', 'perms', 'list', 'subscribe']);
    expect(puter.notifications.enable).toHaveBeenCalledTimes(1);
    expect(puter.perms.request).toHaveBeenCalledWith('backgroundEvents');
  });

  it.each(['handler_not_found', 'failures', 'no_credit'])('keeps resumable suspended subscriptions: %s', async (reason) => {
    subs = [{ subId: 'paused', subject: NEW_MAIL_SUBJECT, handlerName: NOTIFY_HANDLER,
      queue: true, suspendedAt: 123, suspendedReason: reason }];
    await expect(ensureSubscription(CONTEXT)).rejects.toHaveProperty('code');
    expect(puter.events.onPersistent).not.toHaveBeenCalled();
    expect(puter.events.unsubscribe).not.toHaveBeenCalled();
  });

  it('recognizes resolved home paths and replaces broadcast subscriptions', async () => {
    subs = [{ subId: 'absolute', subject: 'fs:/tester/.mail/objects/*/*:add', handlerName: NOTIFY_HANDLER, queue: true }];
    await ensureSubscription(CONTEXT);
    expect(puter.events.onPersistent).not.toHaveBeenCalled();
    subs[0].queue = false;
    await ensureSubscription(CONTEXT);
    expect(puter.events.onPersistent).toHaveBeenCalledTimes(1);
  });

  it('reconciles subscriptions created concurrently', async () => {
    await Promise.all([ensureSubscription(CONTEXT), ensureSubscription(CONTEXT)]);
    expect(subs).toHaveLength(1);
  });

  it('updates previews in place while another tab starts', async () => {
    subs = [{ subId: 'old', subject: NEW_MAIL_SUBJECT, handlerName: NOTIFY_HANDLER, queue: true }];
    const context = { ...CONTEXT, previews: false };
    await Promise.all([ensureSubscription(context, { replace: true }), ensureSubscription(CONTEXT)]);
    expect(puter.events.update).toHaveBeenCalledWith('old', { context });
    expect(puter.events.onPersistent).not.toHaveBeenCalled();
    expect(puter.events.unsubscribe).not.toHaveBeenCalled();
    expect(subs).toEqual([expect.objectContaining({ subId: 'old', context })]);
  });

  it.each(['handler_not_found', 'failures', 'no_credit'])('updates a suspended subscription without replacing it: %s', async (reason) => {
    subs = [{ subId: 'paused', subject: NEW_MAIL_SUBJECT, handlerName: NOTIFY_HANDLER,
      queue: true, suspendedReason: reason }];
    const context = { ...CONTEXT, previews: false };
    await expect(ensureSubscription(context, { replace: true })).rejects.toHaveProperty('code');
    expect(puter.events.update).toHaveBeenCalledWith('paused', { context });
    expect(puter.events.onPersistent).not.toHaveBeenCalled();
    expect(puter.events.unsubscribe).not.toHaveBeenCalled();
  });

  it('creates a subscription for a preview change when none exists', async () => {
    await ensureSubscription(CONTEXT, { replace: true });
    expect(puter.events.update).not.toHaveBeenCalled();
    expect(puter.events.onPersistent).toHaveBeenCalledTimes(1);
  });

  it('creates a subscription when the one being updated has disappeared', async () => {
    subs = [{ subId: 'gone', subject: NEW_MAIL_SUBJECT, handlerName: NOTIFY_HANDLER, queue: true }];
    puter.events.update.mockImplementationOnce(async () => {
      subs = [];
      throw { code: 'subscription_does_not_exist' };
    });
    await ensureSubscription(CONTEXT, { replace: true });
    expect(puter.events.onPersistent).toHaveBeenCalledTimes(1);
    expect(subs).toHaveLength(1);
  });

  it.each(['too_many_requests', 'events_context_invalid', 'events_context_too_large', 'events_disabled'])(
    'preserves the subscription when updating fails: %s', async (code) => {
      subs = [{ subId: 'old', subject: NEW_MAIL_SUBJECT, handlerName: NOTIFY_HANDLER, queue: true }];
      puter.events.update.mockRejectedValueOnce({ code });
      await expect(ensureSubscription(CONTEXT, { replace: true })).rejects.toMatchObject({ code });
      expect(puter.events.onPersistent).not.toHaveBeenCalled();
      expect(puter.events.unsubscribe).not.toHaveBeenCalled();
    });

  it('rebuilds the display function without closures and keeps sensitive data out', async () => {
    await listenForPushes();
    const callback = puter.notifications.onPush.mock.calls[0][1];
    const isolated = new Function(`return (${callback.toString()})`)();
    expect(isolated({ title: 'Sender', text: 'Subject', target: '/?message=1' }))
      .toMatchObject({ title: 'Sender', body: 'Subject', url: '/?message=1' });
    expect(isolated({ sensitive: true, title: 'Secret sender', text: 'Secret subject', target: '/?message=secret' }))
      .toEqual({ title: 'Puter Mail', body: 'New message', url: '/' });
  });

  it('leaves the browser off when the subscription cannot be made', async () => {
    puter.events.onPersistent.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'events_handler_not_found' }));
    await expect(turnOnPush(CONTEXT)).rejects.toMatchObject({ code: 'events_handler_not_found' });
    expect(puter.notifications.disable).toHaveBeenCalled();
  });
});

describe('turning pushes off', () => {
  it('disables only this browser on a website and stops listening', async () => {
    const off = vi.fn();
    puter.notifications.onPush.mockResolvedValueOnce({ off });
    await listenForPushes();
    subs = [{ subId: 'mine', subject: NEW_MAIL_SUBJECT, handlerName: NOTIFY_HANDLER, queue: true }];
    await turnOffPush();
    expect(puter.notifications.disable).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledTimes(1);
    expect(puter.events.list).not.toHaveBeenCalled();
    expect(puter.events.unsubscribe).not.toHaveBeenCalled();
    expect(subs.map((sub) => sub.subId)).toEqual(['mine']);
  });

  it('revokes app pushes and ends the account subscription on the desktop', async () => {
    stubPuter({ env: 'app' });
    subs = [
      { subId: 'mine', subject: NEW_MAIL_SUBJECT, handlerName: NOTIFY_HANDLER, queue: true },
      { subId: 'other', subject: 'fs:~/Documents', handlerName: 'someone-else' },
    ];
    await turnOffPush();
    expect(puter.notifications.disable).toHaveBeenCalled();
    expect(subs.map((sub) => sub.subId)).toEqual(['other']);
  });
});

describe('notification helpers', () => {
  it('finds the message a click is about', () => {
    const id = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    expect(clickedMessage({ target: null, data: { id } })).toBe(id);
    expect(clickedMessage({ target: `/?message=${id.toUpperCase()}`, data: null })).toBe(id);
    expect(clickedMessage({ target: null, data: null })).toBe(null);
  });

  it('knows an iPhone needs the Home Screen first', () => {
    const media = (standalone) => () => ({ matches: standalone });
    const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' };
    const ipad = { userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 };
    expect(needsHomeScreen(iphone, media(false))).toBe(true);
    expect(needsHomeScreen(ipad, media(false))).toBe(true);
    expect(needsHomeScreen(iphone, media(true))).toBe(false);
    expect(needsHomeScreen({ ...iphone, standalone: true }, media(false))).toBe(false);
    expect(needsHomeScreen({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' }, media(false))).toBe(false);
  });
});

describe('dismissNewMail()', () => {
  it('dismisses the new-mail notification shown here, and nothing else', async () => {
    const dismiss = vi.fn(async () => true);
    globalThis.puter = { notifications: { dismiss } };
    const shown = [
      { tag: 'app-uid:inbox', data: { puter: { uid: 'n1' } } },
      { tag: 'app-uid:snooze-1', data: { puter: { uid: 'n2' } } },
      { tag: 'app-uid:inbox', data: {} },
    ];
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true, value: { getRegistration: async () => ({ getNotifications: async () => shown }) },
    });
    try {
      await dismissNewMail();
      expect(dismiss.mock.calls).toEqual([['n1']]);
    } finally {
      delete navigator.serviceWorker;
      delete globalThis.puter;
    }
  });
});

import { el } from './dom.js';
import { openModal } from './modal.js';
import {
  NOTIFY_HANDLER, NEW_MAIL_SUBJECT, MAIL_CHANNEL, needsHomeScreen,
} from '../lib/notify.js';

/**
 * New-mail push notifications. The published handler sends them, run by a
 * persistent subscription on the account; this side turns pushes on and off
 * in this browser, keeps that subscription, and says what a push shows.
 */

export const pushErrorCode = (error) => error?.code ?? error?.error?.code ?? '';

const ours = (sub) => sub?.handlerName === NOTIFY_HANDLER && sub.handlerScope !== 'user'
  && (sub.subject === NEW_MAIL_SUBJECT || /^fs:\/[^/]+\/\.mail\/objects\/\*\/\*:add$/.test(sub.subject));

export const notificationStatus = () => puter.notifications.status();

/** Keep resumable subscriptions; only withdrawn permissions require replacement. */
export async function ensureSubscription(context, { replace = false } = {}) {
  const found = (await puter.events.list()).filter(ours);
  let keep = found.find((sub) => sub.queue === true && !sub.suspendedReason)
    || found.find((sub) => sub.queue === true && sub.suspendedReason !== 'permission_revoked');
  if (keep && replace) {
    try { await puter.events.update(keep.subId, { context }); }
    catch (error) {
      if (error?.code !== 'subscription_does_not_exist') throw error;
      keep = null;
    }
  }
  if (keep?.suspendedReason) {
    const code = keep.suspendedReason === 'handler_not_found' ? 'events_handler_not_found'
      : keep.suspendedReason === 'no_credit' ? 'insufficient_funds' : 'events_handler_suspended';
    throw Object.assign(new Error('The notification subscription is suspended.'), { code });
  }
  let active = keep || await puter.events.onPersistent({
    subject: NEW_MAIL_SUBJECT, handlerName: NOTIFY_HANDLER, queue: true, context,
  });
  // Re-list after creating: another tab may have subscribed at the same time.
  const candidates = keep ? found : [...new Map([active, ...(await puter.events.list()).filter(ours)]
    .map((sub) => [sub.subId, sub])).values()];
  if (!keep) {
    active = candidates.filter((sub) => sub.queue === true
      && !sub.suspendedReason && sub.contextHash === active.contextHash)
      .sort((a, b) => a.subId.localeCompare(b.subId))[0] ?? active;
  }
  await Promise.all(candidates.filter((sub) => sub.subId !== active.subId)
    .map((sub) => puter.events.unsubscribe(sub.subId).catch((error) => {
      if (error?.code !== 'subscription_does_not_exist') throw error;
    })));
}

let listening = null;

/**
 * Say what a push shows, on every load while pushes are on. On a website the
 * handler is also rebuilt from its source in /puter-sw.js, so it can use
 * nothing but its argument.
 */
export function listenForPushes() {
  listening ??= puter.notifications.onPush(MAIL_CHANNEL, (n) => n.sensitive ? {
    title: 'Puter Mail', body: 'New message', url: '/',
  } : ({
    title: n.title,
    body: n.text || '',
    icon: n.icon || '/icon-192.png',
    url: n.target || '/',
  })).catch((error) => {
    console.warn('[puter-mail] new-mail pushes are not handled here', error);
    listening = null;
    return null;
  });
  return listening;
}

/**
 * The inbox is on screen: the new-mail notification this browser shows is
 * dismissed, which closes it on the user's other devices too, and the next
 * new mail alerts afresh rather than replacing it.
 */
export async function dismissNewMail() {
  if (!globalThis.puter?.notifications || !navigator.serviceWorker) return;
  const registration = await navigator.serviceWorker.getRegistration().catch(() => null);
  for (const shown of (await registration?.getNotifications().catch(() => null)) ?? []) {
    const uid = shown.data?.puter?.uid;
    if (uid && /(^|:)inbox$/.test(shown.tag)) puter.notifications.dismiss(uid).catch(() => {});
  }
}

export async function stopListening() {
  const listener = listening;
  listening = null;
  await (await listener)?.off();
}

/** Called from a click: enable() must reach the browser before the first await. */
export async function turnOnPush(context) {
  let here = false;
  let revoked = false;
  try {
    here = await puter.notifications.enable();
  } catch (error) {
    const code = pushErrorCode(error);
    if (code === 'push_unavailable' || code === 'push_disabled') return 'unavailable';
    if (code !== 'push_revoked') throw error;
    revoked = true;
  }
  if (!here && !revoked) return 'blocked';
  // Website enable() grants app pushes; desktop enable() opens Puter's dialog.
  const granted = revoked
    ? (await puter.perms.request([
      { resource: 'backgroundEvents' }, { resource: 'pushNotifications' },
    ])).every(Boolean)
    : await puter.perms.request('backgroundEvents');
  if (!granted) {
    if (here) await puter.notifications.disable().catch(() => {});
    return 'declined';
  }
  if (revoked && !await puter.notifications.enable()) return 'blocked';
  try {
    await ensureSubscription(context);
  } catch (error) {
    await puter.notifications.disable().catch(() => {});
    throw error;
  }
  listenForPushes();
  return 'on';
}

/**
 * Before signing out: this browser's push handler and subscription go first.
 * Inside the desktop disable() would revoke every device, so there only the
 * handler goes. The account's new-mail subscription stays for other devices.
 */
export async function releasePushHere(timeoutMs = 4000) {
  await stopListening().catch(() => {});
  if (puter.env !== 'web' || !puter.notifications?.disable) return;
  let timer;
  await Promise.race([
    puter.notifications.disable().catch(() => {}),
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  clearTimeout(timer);
}

/** Website switches affect this browser; desktop disable revokes app pushes. */
export async function turnOffPush() {
  await Promise.allSettled([
    stopListening(),
    puter.notifications.disable(),
    ...(puter.env === 'web' ? [] : [puter.events.list().then((subs) =>
      Promise.all(subs.filter(ours).map((sub) => puter.events.unsubscribe(sub.subId))))]),
  ]);
}

/**
 * A website on iPhone or iPad outside the Home Screen, where enable() resolves
 * false without asking. Inside the Puter desktop pushes go through Puter.
 */
export const pushNeedsHomeScreen = () => puter.env === 'web' && needsHomeScreen();

/** What to do instead, on an iPhone or iPad. */
export function openHomeScreenHint() {
  const body = el('div', {},
    el('p.onboard-lead', {},
      'On iPhone and iPad, Puter Mail can notify you once it is on your Home Screen.'),
    el('ol.push-steps', {},
      el('li', {}, 'In Safari, tap Share, then Add to Home Screen.'),
      el('li', {}, 'Open Puter Mail from its new icon and sign in.'),
      el('li', {}, 'Turn on notifications under Settings, New mail.'),
    ),
  );
  const modal = openModal({ title: 'Add to Home Screen', content: body });
  body.append(el('button.btn.btn-primary.btn-block', {
    type: 'button', onclick: () => modal.close(),
  }, 'Got it'));
  return modal;
}

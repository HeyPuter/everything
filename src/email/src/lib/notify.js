/**
 * The contract between the app and the published new-mail handler
 * (src/workers/notify-handler.js): which events run it, the name it is
 * published under, and how its notifications name a message. Constants and
 * pure helpers only, so scripts/publish-notify-handler.mjs can import the name.
 */

/** Change the version with the handler's `ctx` or what it sends. */
export const NOTIFY_HANDLER = 'mail-notify-v1';

/**
 * A file added to a day folder of `objects/`, which only delivery does:
 * archive, delete and restore are moves, and a sent copy goes to `sent/`.
 * `*` stops at a slash, so a new day folder runs nothing.
 */
export const NEW_MAIL_SUBJECT = 'fs:~/.mail/objects/*/*:add';

/** The `channel` the handler sends with, and the key `onPush()` handles. */
export const MAIL_CHANNEL = 'mail';

/**
 * The message a notification click is about, from `data` or from the
 * `target` the handler wrote. Null for a tap on a sensitive push, which
 * carries neither.
 */
export const clickedMessage = ({ target, data } = {}) => {
  if (typeof data?.id === 'string' && data.id) return data.id;
  const match = /[?&]message=([0-9a-f-]{36})(?:&|$)/i.exec(target ?? '');
  return match ? match[1].toLowerCase() : null;
};

/**
 * iPhone and iPad take pushes only in a site added to the Home Screen and
 * opened from there. iPadOS reports itself as a Mac, with touch.
 */
export const needsHomeScreen = (nav = navigator, media = matchMedia) => {
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent ?? '')
    || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  return ios && nav.standalone !== true && !media('(display-mode: standalone)').matches;
};

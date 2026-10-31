import { el } from '../../../ui/dom.js';
import { avatar } from '../../../ui/avatar.js';
import { t } from '../../../lib/i18n/index.js';
import { tripTabs } from '../../registry/tabs.js';

const USERNAME = /^[A-Za-z0-9_.-]{1,64}$/;
// Raster data only; anything else (URLs, SVG, text) reads as no picture.
const PICTURE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const PICTURE_CHARS = 512 * 1024;
const FOUND_TTL = 30 * 60_000;
const MISSING_TTL = 10 * 60_000;
const pictures = new WeakMap();

export const validPicture = (value) => typeof value === 'string' && value.length <= PICTURE_CHARS && PICTURE.test(value);

/** Best effort: `puter.auth.getProfilePicture(username)`, cached per session; null when unavailable. */
export function profilePicture(puter, username, now = Date.now()) {
  const fetcher = puter?.auth?.getProfilePicture;
  if (typeof fetcher !== 'function' || !USERNAME.test(username ?? '') || username.startsWith('.')) return Promise.resolve(null);
  let cache = pictures.get(puter);
  if (!cache) { cache = new Map(); pictures.set(puter, cache); }
  const hit = cache.get(username);
  if (hit && now < hit.until) return hit.promise;
  if (globalThis.navigator?.onLine === false) return Promise.resolve(null);
  const entry = { until: Infinity, promise: null };
  entry.promise = Promise.resolve().then(() => fetcher.call(puter.auth, username)).catch(() => null).then((value) => {
    const picture = validPicture(value) ? value : null;
    entry.until = Date.now() + (picture ? FOUND_TTL : MISSING_TTL);
    return picture;
  });
  if (cache.size >= 200) cache.delete(cache.keys().next().value);
  cache.set(username, entry);
  return entry.promise;
}

const colorOf = (value) => (Number.isInteger(value) && value >= 1 && value <= 8 ? String(value) : null);

/** A member or guest avatar in their trip color, with the profile picture once it loads. */
export function personAvatar(person, { puter, size = 36, presence = false } = {}) {
  const node = avatar({ id: person.uid ?? person.id, name: person.name || t('ui.unknown'), photo: person.avatar, size, presence: presence ? (person.active ? 'online' : null) : null });
  const color = colorOf(person.color);
  if (color) node.dataset.color = color;
  if (puter && !node.querySelector('img') && person.uid) {
    void profilePicture(puter, person.name).then((src) => {
      if (src && !node.querySelector('img')) node.prepend(el('img.avatar-img', { src, alt: '', onerror: (event) => event.target.remove() }));
    });
  }
  return node;
}

export const nameList = (names) => new Intl.ListFormat(undefined, { type: 'conjunction' }).format(names);

export const roleLabel = (role) => t(`members.role.${['owner', 'editor', 'viewer'].includes(role) ? role : 'viewer'}`);

/** The tab a member is looking at, when it is a known one (region values are untrusted). */
export function viewLabel(view) {
  const tab = tripTabs.find((item) => item.id === view);
  return tab ? t(tab.labelKey) : '';
}

/** Avatars of the other members here now, for trip headers. Re-renders on presence and member changes. */
export function presenceStack(space, { uid, puter, max = 4, size = 28 } = {}) {
  const node = el('div.members-presence');
  const render = () => {
    const here = space.members().filter((member) => member.active && member.uid !== uid);
    node.hidden = !here.length;
    node.setAttribute('aria-label', here.length ? t('members.hereNowList', { names: nameList(here.map((member) => member.name)) }) : '');
    node.setAttribute('role', 'img');
    const stack = el('div.avatar-stack', { 'aria-hidden': 'true' }, here.slice(0, max).map((member) => personAvatar(member, { puter, size })));
    if (here.length > max) stack.append(el('span.avatar-extra', { style: { '--size': `${size}px` } }, `+${here.length - max}`));
    node.replaceChildren(stack);
  };
  render();
  const offs = [space.subscribe('presence', render), space.subscribe('member', render)];
  return { element: node, destroy: () => { for (const off of offs) off(); } };
}

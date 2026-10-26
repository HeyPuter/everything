import { el, safeURL } from './dom.js';
import { t } from '../lib/i18n/index.js';
export function avatar({ id = '', name = t('ui.unknown'), photo, size = 36, presence: input } = {}) {
  const presence = ['online', 'away', 'offline'].includes(input) ? input : null;
  const initials = name.trim().split(/\s+/u).slice(0, 2).map((word) => [...word][0]).join('').toLocaleUpperCase();
  let hash = 0;
  for (const char of String(id || name)) hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0;
  const node = el('span.avatar', { role: 'img', 'aria-label': presence ? `${name} · ${t(`ui.${presence}`)}` : name,
    title: name, dataset: { color: String(hash % 8 + 1) }, style: { '--size': `${size}px` } }, el('span', { 'aria-hidden': 'true' }, initials));
  const src = safeURL(photo);
  if (src) node.append(el('img.avatar-img', { src, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', onerror: (event) => event.target.remove() }));
  if (presence) node.append(el(`span.presence.${presence}`, { 'aria-hidden': 'true' }));
  return node;
}
export function avatarStack(people, { max = 3, size = 28 } = {}) {
  const count = Math.max(0, Math.floor(max));
  return el('div.avatar-stack', {}, people.slice(0, count).map((person) => avatar({ ...person, size })),
    people.length > count && el('span.avatar-extra', { role: 'img', 'aria-label': t('ui.moreMembers', { count: people.length - count }), style: { '--size': `${size}px` } }, `+${people.length - count}`));
}

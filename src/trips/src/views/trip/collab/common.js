import {
  createElement, MessageCircle, StickyNote, Link, ChartColumn, Activity, Pin, PinOff, SmilePlus, Smile, Reply, SendHorizontal,
  Globe, ExternalLink, Paperclip, ArrowDown, Lock, LockOpen, Maximize2, Copy,
} from 'lucide';
import { el, safeURL } from '../../../ui/dom.js';
import { icon as kitIcon } from '../../../ui/icons.js';
import { avatar } from '../../../ui/avatar.js';
import { button } from '../../../ui/bits.js';
import { openModal } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { displayLocale } from '../../../lib/prefs.js';
import { formatDate, formatInstant } from '../../../lib/format.js';
import { routeHash } from '../../../lib/router.js';
import { authorOf, canManage, dayOf, localZone } from './model.js';

const extra = {
  chat: MessageCircle, note: StickyNote, link: Link, poll: ChartColumn, activity: Activity, pinned: Pin, unpin: PinOff,
  react: SmilePlus, emoji: Smile, reply: Reply, send: SendHorizontal, globe: Globe, external: ExternalLink, attach: Paperclip,
  down: ArrowDown, lock: Lock, unlock: LockOpen, expand: Maximize2, copy: Copy,
};
export function icon(name, size = 18) {
  if (!Object.hasOwn(extra, name)) return kitIcon(name, size);
  return createElement(extra[name], { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}

/** An icon-only button for icons outside the kit set. */
export function iconAction(name, label, attrs = {}) {
  return el('button.icon-btn', { type: 'button', title: label, 'aria-label': label, ...attrs }, icon(name));
}

/** `{count}` in the singular or plural key, by the display locale's rules. */
export function plural(count, one, other) {
  const locale = displayLocale();
  return t(new Intl.PluralRules(locale).select(count) === 'one' ? one : other, { count: new Intl.NumberFormat(locale).format(count) });
}

const serials = new WeakMap();
let serial = 0;
/** A number that changes whenever the store hands out a new entity object (local edits keep `v`). */
export function revisionOf(entity) {
  if (!entity) return 0;
  if (!serials.has(entity)) serials.set(entity, ++serial);
  return serials.get(entity);
}

/** Moves existing nodes only when their order changed, so focus and scroll survive re-renders. */
export function reconcile(parent, nodes) {
  nodes.forEach((node, index) => {
    const current = parent.childNodes[index];
    if (current !== node) parent.insertBefore(node, current ?? null);
  });
  while (parent.childNodes.length > nodes.length) parent.lastChild.remove();
}

const FOCUSABLE = 'button, a[href], input, textarea, select, [tabindex]';
/**
 * Runs a re-render of `root`; when it replaced the node holding focus, focuses the control at the same position in the
 * rebuilt item with the same `data-key` (entity ids), so voting or pinning keeps the keyboard in place.
 */
export function keepFocus(root, run) {
  const active = root.ownerDocument.activeElement;
  const host = active && root.contains(active) ? active.closest('[data-key]') : null;
  const position = host ? [...host.querySelectorAll(FOCUSABLE)].indexOf(active) : -1;
  run();
  if (!host || active.isConnected) return;
  const next = [...root.querySelectorAll('[data-key]')].find((node) => node.dataset.key === host.dataset.key);
  const target = next ? (next.querySelectorAll(FOCUSABLE)[position] ?? next.querySelector(FOCUSABLE)) : null;
  target?.focus({ preventScroll: true });
}

/** Translated message for a failed write or read. */
export function errorText(error) {
  const code = error?.code ?? error?.error?.code;
  if (error?.status === 402 || code === 'owner_credit' || code === 'caller_credit') return t(code === 'caller_credit' ? 'collab.error.callerCredit' : 'collab.error.ownerCredit');
  if (error?.status === 403 || code === 'forbidden') return t('collab.error.forbidden');
  if (error?.status === 429 || code === 'rate_limited') return t('collab.error.rateLimited');
  if (error?.status === 413 || code === 'entity_too_large' || code === 'body_too_large') return t('collab.error.tooLarge');
  if (globalThis.navigator?.onLine === false || code === 'offline' || code === 'network') return t('collab.error.offline');
  if (error?.status === 400 || code === 'invalid') return t('collab.error.invalid');
  return t('collab.error.generic');
}

/** Shared state for the Collab panels: who is signed in, member names, permissions and writes. */
export function createCollabContext({ space, uid, route = null, document = globalThis.document }) {
  const zone = localZone();
  let directory = null;
  const dialogs = new Set();
  const offMembers = space.subscribe('member', () => { directory = null; });
  const members = () => {
    if (!directory) directory = new Map(space.members().map((member) => [member.uid, member]));
    return directory;
  };
  const ctx = {
    space, uid, zone, route, document,
    now: () => Date.now(),
    canPost: () => space.can('collab.post'),
    canManage: (entity) => canManage(entity, { uid, role: space.role }),
    person(id) {
      const member = id ? members().get(id) : null;
      if (member) return { id, name: member.name, photo: member.avatar, known: true };
      return { id: id ?? '', name: t(id === uid ? 'collab.you' : 'collab.formerMember'), photo: null, known: false };
    },
    author: (entity) => ctx.person(authorOf(entity)),
    avatarOf(id, size = 32) { const person = ctx.person(id); return avatar({ id: person.id, name: person.name, photo: person.photo, size }); },
    time: (epoch) => (Number.isSafeInteger(epoch) ? formatInstant(epoch, zone, { date: false }) : ''),
    dateTime(epoch) {
      if (!Number.isSafeInteger(epoch)) return '';
      const today = dayOf(Date.now(), zone);
      return dayOf(epoch, zone) === today ? formatInstant(epoch, zone, { date: false }) : formatInstant(epoch, zone, { year: dayOf(epoch, zone).slice(0, 4) !== today.slice(0, 4) });
    },
    day: (date) => formatDate(date, { weekday: true, style: 'long' }),
    timeNode: (epoch, text = ctx.dateTime(epoch)) => el('time', { dateTime: Number.isSafeInteger(epoch) ? new Date(epoch).toISOString() : null, title: Number.isSafeInteger(epoch) ? formatInstant(epoch, zone) : null }, text),
    tabHash(tab) {
      try { return route?.name === 'space' ? routeHash({ ...route, tab }) : null; } catch { return null; }
    },
    /** Applies ops locally (queued while offline); refusals before sending are toasted. */
    async apply(ops, { history, flush = false } = {}) {
      try {
        await space.apply(ops, history ? { history } : {});
        // Send failures surface through `space.state` and the shell's sync indicator.
        if (flush) void Promise.resolve().then(() => space.flush()).catch(() => {});
        return true;
      } catch (error) {
        toast(errorText(error));
        return false;
      }
    },
    /** Dialogs opened by the tab close when it unmounts. */
    track(dialog) { dialogs.add(dialog); void dialog.closed.then(() => dialogs.delete(dialog)); return dialog; },
    destroy() {
      offMembers();
      for (const dialog of [...dialogs].reverse()) dialog.close('navigation');
      dialogs.clear();
    },
  };
  return ctx;
}

/** A favicon from the site itself, replaced by a globe when it does not load. */
export function favicon(url, size = 16) {
  const href = safeURL(url);
  const fallback = () => el('span.collab-favicon', { 'aria-hidden': 'true' }, icon('globe', size));
  if (!href) return fallback();
  const holder = el('span.collab-favicon', { 'aria-hidden': 'true', style: { '--size': `${size}px` } });
  const img = el('img', { src: new URL('/favicon.ico', href).href, alt: '', width: size, height: size, loading: 'lazy', referrerPolicy: 'no-referrer', decoding: 'async',
    onerror: () => holder.replaceChildren(icon('globe', size)) });
  holder.append(img);
  return holder;
}

/** An external link that names its host (links are http(s) only). */
export function externalLink(url, label, attrs = {}) {
  const href = safeURL(url);
  if (!href) return el('span', {}, label);
  const host = new URL(href).hostname.replace(/^www\./, '');
  return el('a.collab-external', { href, target: '_blank', rel: 'noopener noreferrer', ...attrs }, el('bdi', {}, label),
    label !== host && el('span.collab-host', { dir: 'ltr' }, host));
}

/**
 * A modal form. `onSubmit()` resolves `true` to close, a string to show as the form error, or `false` to stay open
 * (field errors already shown).
 */
export function formDialog(ctx, { title, content, submitLabel, onSubmit, wide = false }) {
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const submit = button(submitLabel, { type: 'submit', variant: 'primary' });
  let dialog;
  const form = el('form.collab-form', { noValidate: true, onsubmit: async (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.setAttribute('aria-busy', 'true');
    try {
      const result = await onSubmit();
      if (result === true) dialog.close('saved');
      else if (typeof result === 'string') { error.textContent = result; error.hidden = false; }
    } finally { submit.setAttribute('aria-busy', 'false'); }
  } }, content, error, el('div.modal-actions', {}, button(t('collab.cancel'), { onclick: () => dialog.close('cancel') }), submit));
  dialog = ctx.track(openModal({ title, content: form, wide }));
  return dialog;
}

export function statusChip(text, tone = '') {
  return el(`span.chip${tone ? `.chip-${tone}` : ''}.collab-chip`, {}, text);
}

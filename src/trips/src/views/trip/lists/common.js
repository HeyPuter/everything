import { el } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { displayLocale } from '../../../lib/prefs.js';
import { icon } from './icons.js';

/** Kit buttons with this module's extra icons. */
export function btn(label, { icon: name, ...options } = {}) {
  const node = button(label, options);
  if (name) node.prepend(icon(name));
  return node;
}
export function iconBtn(name, label, attrs = {}) {
  return el('button.icon-btn', { type: 'button', title: label, 'aria-label': label, ...attrs }, icon(name));
}

const ERRORS = {
  forbidden: 'lists.errorForbidden', gone: 'lists.errorGone', entity_too_large: 'lists.errorTooLarge', space_full: 'lists.errorFull',
  private_items_unavailable: 'lists.errorPrivate', account_changed: 'lists.errorAccount', template_too_large: 'lists.errorTemplateLarge',
  invalid_template_file: 'lists.errorTemplateFile', template_file_too_large: 'lists.errorTemplateFile', rate_limited: 'lists.errorBusy',
};
export function errorText(error) {
  const code = error?.code;
  if (Object.hasOwn(ERRORS, code)) return t(ERRORS[code]);
  if (error?.status === 402) return t('lists.errorCredit');
  if (error?.status === 0 || globalThis.navigator?.onLine === false) return t('lists.errorOffline');
  return t('lists.errorSave');
}
/** Runs a write; a failure becomes a toast. Resolves true on success. */
export async function attempt(task) {
  try { await task(); return true; } catch (error) { toast(errorText(error)); return false; }
}

export function plural(count, one, other, values = {}) {
  const locale = displayLocale();
  return t(new Intl.PluralRules(locale).select(count) === 'one' ? one : other, { ...values, count: new Intl.NumberFormat(locale).format(count) });
}

/** Members (with presence) and guests by id: `{id, name, kind, avatar?}`. */
export function people(space) {
  const map = new Map();
  for (const member of space.members()) map.set(member.uid, { id: member.uid, name: member.name || t('lists.unknownPerson'), kind: 'member', avatar: member.avatar, role: member.role });
  for (const guest of space.select.guest?.all() ?? []) if (!map.has(guest.id)) map.set(guest.id, { id: guest.id, name: guest.name, kind: 'guest' });
  return map;
}
export const personOf = (map, id) => map.get(id) ?? { id, name: t('lists.unknownPerson'), kind: 'unknown' };

/** Coalesces render requests into one per frame. */
export function scheduler(render) {
  let queued = false;
  let stopped = false;
  const frame = globalThis.requestAnimationFrame ?? ((fn) => setTimeout(fn, 16));
  return {
    request() {
      if (queued || stopped) return;
      queued = true;
      frame(() => { queued = false; if (!stopped) render(); });
    },
    stop() { stopped = true; },
  };
}

/**
 * Re-renders `root` and puts focus back: the same node when it survived, otherwise the node with the same
 * `data-focus` key, otherwise nothing (focus stays where the browser left it).
 */
export function keepFocus(root, render) {
  const active = document.activeElement;
  const inside = active && root.contains(active);
  const key = inside ? active.closest('[data-focus]')?.dataset.focus : null;
  const selection = inside && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  render();
  if (!inside || root.contains(document.activeElement)) return;
  let target = active.isConnected && root.contains(active) ? active : null;
  if (!target && key) target = [...root.querySelectorAll('[data-focus]')].find((node) => node.dataset.focus === key) ?? null;
  if (!target) return;
  target.focus({ preventScroll: true });
  if (selection && target === active) try { target.setSelectionRange(...selection); } catch { /* not a text input */ }
}

export function readState(key, fallback) {
  try { const value = JSON.parse(globalThis.localStorage?.getItem(key) ?? 'null'); return value && typeof value === 'object' ? { ...fallback, ...value } : { ...fallback }; } catch { return { ...fallback }; }
}
export function writeState(key, value) {
  try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); } catch { /* private mode or quota */ }
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, hidden: true });
    let settled = false;
    const done = (file) => { if (settled) return; settled = true; input.remove(); resolve(file); };
    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => done(null));
    document.body.append(input);
    input.click();
  });
}

/** A color dot for list and bag colors 1–8 (day tokens); other values fall back to the neutral dot. */
export function colorDot(color, label) {
  const tone = Number.isInteger(color) && color >= 1 && color <= 8 ? color : null;
  return el('span.lists-dot', { 'aria-hidden': label ? null : 'true', role: label ? 'img' : null, 'aria-label': label ?? null,
    style: tone ? { '--lists-color': `var(--day-${tone})` } : null });
}
export const colorName = (color) => t(`lists.color${Number.isInteger(color) && color >= 1 && color <= 8 ? color : 1}`);

/** Fields of a private item without the store's bookkeeping, ready for `privateItems.put`. */
export function privateFields(item) {
  const { id: _id, upd: _upd, private: _private, ...fields } = item;
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

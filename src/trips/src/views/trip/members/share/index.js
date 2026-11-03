import './share.css';
import { el, uid as uniqueId } from '../../../../ui/dom.js';
import { button } from '../../../../ui/bits.js';
import { confirmDialog } from '../../../../ui/modal.js';
import { toast } from '../../../../ui/toast.js';
import { t } from '../../../../lib/i18n/index.js';
import { prefs } from '../../../../lib/prefs.js';
import { formatInstant } from '../../../../lib/format.js';
import { icon } from '../icons.js';
import { errorMessage } from '../errors.js';
import { keepFocus } from '../focus.js';
import {
  DEFAULT_TOGGLES, SHARE_EXPIRY_DAYS, TOGGLES, canShare, currentToken, expiryAt, publicURL, shareOf, togglePatch, tokenKey, visibleSections,
} from './logic.js';
import { combinedFields } from './combined/index.js';

const SAVE_DELAY = 600;
const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };
const when = (ms) => { try { return formatInstant(ms, localZone(), { style: 'medium' }); } catch { return ''; } };
const count = (value) => new Intl.NumberFormat().format(value);

/**
 * Public read-only link settings for the Members tab: create, sections, display currency, expiry, new link and
 * turn off. Changes go through `share.set` (batched), so the worker re-mints and invalidates its caches.
 * Returns `{element, update, destroy}`.
 */
export function shareSection({ space, session, account, ref = space.ref, location = globalThis.location, window: win = globalThis.window }) {
  const api = session.api;
  const db = session.db ?? null;
  const uid = account.uuid;
  const titleId = uniqueId('share-title');
  const body = el('div.share-body');
  const status = el('p.members-status', { role: 'status' });
  const element = el('section.members-section.share-section', { 'aria-labelledby': titleId },
    el('div.members-section-head', {}, el('h3', { id: titleId }, t('public.share.title'))), body, status);
  let record = null;
  let result = null;
  let pending = {};
  let timer = 0;
  let saving = Promise.resolve();
  let busy = false;
  let destroyed = false;

  const meta = () => space.get('meta', 'meta');
  // A share.set answer is newer than the replica until sync brings its commit.
  function server() {
    const entity = meta();
    if (result && !(Number.isSafeInteger(entity?.rev) && entity.rev >= result.rev)) return shareOf({ share: result.share });
    return shareOf(entity);
  }
  const current = () => ({ ...server(), ...pending });
  // Raw share fields with pending edits, for the settings that reach past the trip (road trip, journey).
  const rawShare = () => ({ ...((result && !(Number.isSafeInteger(meta()?.rev) && meta().rev >= result.rev)) ? result.share : meta()?.share ?? {}), ...pending });
  const offline = () => win?.navigator?.onLine === false;
  const setStatus = (text, state = '') => { status.textContent = text; status.dataset.state = state; };

  async function remember(token, since) {
    record = token ? { token, since } : null;
    if (!db) return;
    try { if (record) await db.put(tokenKey(ref), record); else await db.remove(tokenKey(ref)); } catch { /* The link still works; it just cannot be shown again. */ }
  }

  async function send(input, { success } = {}) {
    busy = true; render();
    setStatus(t('public.share.saving'));
    try {
      const answer = await api.call(ref, 'share.set', input);
      if (destroyed) return null;
      result = { share: answer.share ?? {}, rev: Number.isSafeInteger(answer.rev) ? answer.rev : 0 };
      if (answer.token) await remember(answer.token, result.share.since ?? null);
      else if (input.revoke) await remember(null);
      setStatus(success ?? t('public.share.saved'));
      void space.sync?.().catch(() => {});
      return answer;
    } catch (error) {
      if (!destroyed) setStatus(t('public.share.error', { reason: errorMessage(error) }), 'error');
      return null;
    } finally {
      busy = false;
      if (!destroyed) render();
    }
  }

  function flush() {
    clearTimeout(timer);
    const input = { ...pending };
    if (!Object.keys(input).length) return saving;
    saving = saving.then(async () => {
      const answer = await send(input);
      // Keep edits made while this one was in flight; drop the rest (sent, or refused and shown as an error).
      for (const [key, value] of Object.entries(input)) if (pending[key] === value) delete pending[key];
      if (!answer) pending = {};
      if (!destroyed) render();
    });
    return saving;
  }
  function change(patch) {
    Object.assign(pending, patch);
    render();
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), SAVE_DELAY);
  }

  async function create() {
    const share = server();
    const explicit = TOGGLES.some((key) => Object.hasOwn(meta()?.share ?? {}, key));
    const toggles = explicit ? Object.fromEntries(TOGGLES.map((key) => [key, share[key]])) : DEFAULT_TOGGLES;
    const answer = await send({ on: true, rotate: true, ...toggles, cur: share.cur ?? prefs().currency ?? null }, { success: t('public.share.ready') });
    if (answer?.token) body.querySelector('.share-url')?.select?.();
  }
  async function rotate() {
    const ok = await confirmDialog({ title: t('public.share.rotateTitle'), body: t('public.share.rotateBody'), confirmLabel: t('public.share.rotate') });
    if (ok && !destroyed) await send({ rotate: true }, { success: t('public.share.rotated') });
  }
  async function turnOff() {
    const ok = await confirmDialog({ title: t('public.share.offTitle'), body: t('public.share.offBody'), confirmLabel: t('public.share.turnOff'), danger: true });
    if (!ok || destroyed) return;
    clearTimeout(timer); pending = {};
    await send({ revoke: true }, { success: t('public.share.turnedOff') });
  }
  async function copy(url, input) {
    try { await navigator.clipboard.writeText(url); toast(t('public.share.copied')); }
    catch { input.focus(); input.select(); toast(t('public.share.copyManual')); }
  }

  function linkBlock(share) {
    const token = currentToken(record, share);
    if (!token) {
      return el('div.share-link', {}, el('p.members-hint', {}, t('public.share.hidden')),
        button(t('public.share.rotate'), { size: 'sm', disabled: busy || offline(), dataset: { focus: 'share:rotate' }, onclick: () => void rotate() }));
    }
    const url = publicURL(location.href, ref, token);
    const id = uniqueId('share-url');
    const input = el('input.input.invite-url.share-url', { id, readOnly: true, value: url, spellcheck: false, onfocus: (event) => event.target.select() });
    const actions = el('div.invite-result-actions', {},
      button(t('public.share.copy'), { variant: 'primary', icon: 'copy', size: 'sm', dataset: { focus: 'share:copy' }, onclick: () => copy(url, input) }),
      el('a.btn.btn-outline.btn-sm', { href: url, target: '_blank', rel: 'noopener noreferrer' }, icon('link', 16), t('public.share.open')));
    if (typeof navigator.share === 'function') {
      const title = meta()?.title ?? '';
      actions.append(button(t('public.share.share'), { variant: 'outline', size: 'sm', onclick: () => navigator.share({ title, url }).catch(() => {}) }));
    }
    return el('div.share-link', {}, el('div.field', {}, el('label.field-label', { htmlFor: id }, t('public.share.link')), input), actions);
  }

  function toggles(share, disabled) {
    const legendId = uniqueId('share-sections');
    const rows = TOGGLES.map((key) => {
      const needs = key === 'codes' ? !share.bookings : key === 'map' ? !(share.plan || share.bookings) : false;
      const hintId = uniqueId('share-hint');
      return el('label.check-field.share-toggle', {},
        el('input', { type: 'checkbox', checked: share[key] && !needs, disabled: disabled || needs, 'aria-describedby': hintId, dataset: { focus: `share:${key}` },
          onchange: (event) => change(togglePatch(share, key, event.target.checked)) }),
        el('span.share-toggle-text', {}, el('span', {}, t(`public.share.toggle.${key}`)), el('span.field-hint', { id: hintId }, t(`public.share.hint.${key}`))));
    });
    const group = el('fieldset.share-toggles', { 'aria-labelledby': legendId }, el('legend.field-label', { id: legendId }, t('public.share.sections')), rows);
    if (share.costs) group.append(currencyField(share, disabled));
    group.append(combinedFields({ space, share: rawShare(), disabled, change, session }));
    if (!visibleSections(share).length) group.append(el('p.members-alert', { role: 'note' }, t('public.share.nothing')));
    return group;
  }

  function currencyField(share, disabled) {
    const trip = meta()?.currency;
    const codes = [...new Set([trip, prefs().currency, share.cur].filter(Boolean))];
    const id = uniqueId('share-cur');
    const select = el('select.select', { id, disabled, dataset: { focus: 'share:cur' }, onchange: (event) => change({ cur: event.target.value === trip ? null : event.target.value }) },
      codes.map((code) => el('option', { value: code }, code === trip ? t('public.share.tripCurrency', { code }) : code)));
    select.value = share.cur ?? trip ?? '';
    return el('div.field.share-currency', {}, el('label.field-label', { htmlFor: id }, t('public.share.currency')), select, el('span.field-hint', {}, t('public.share.currencyHint')));
  }

  function expiryField(share, disabled) {
    const id = uniqueId('share-exp');
    const options = [el('option', { value: 'never' }, t('public.share.never')),
      ...SHARE_EXPIRY_DAYS.map((days) => el('option', { value: String(days) }, days === 1 ? t('public.share.inDay') : t('public.share.inDays', { count: count(days) })))];
    if (share.exp) options.unshift(el('option', { value: 'current' }, t('public.share.expiresOn', { date: when(share.exp) })));
    const select = el('select.select', { id, disabled, dataset: { focus: 'share:exp' }, onchange: (event) => {
      const value = event.target.value;
      if (value === 'current') return;
      clearTimeout(timer);
      void flush().then(() => send({ exp: value === 'never' ? null : expiryAt(Number(value)) }));
    } }, options);
    select.value = share.exp ? 'current' : 'never';
    return el('div.field.share-expiry', {}, el('label.field-label', { htmlFor: id }, t('public.share.expiry')), select);
  }

  function render() {
    if (destroyed) return;
    const manage = canShare(space, uid);
    const share = current();
    let content;
    if (!manage) {
      element.hidden = !share.on;
      const sections = visibleSections(share).map((key) => t(`public.share.toggle.${key}`));
      content = el('p.members-hint', {}, sections.length ? t('public.share.memberNote', { sections: sections.join(', ') }) : t('public.share.memberNoteEmpty'));
    } else {
      element.hidden = false;
      const disabled = busy || offline();
      if (!share.on) {
        content = el('div.share-off', {}, el('p.members-hint', {}, t('public.share.hint')),
          el('div', {}, button(t('public.share.create'), { variant: 'primary', icon: 'plus', disabled, dataset: { focus: 'share:create' }, onclick: () => void create() })));
      } else {
        const facts = [share.since && t('public.share.since', { date: when(share.since) }),
          share.exp ? t('public.share.expiresAt', { date: when(share.exp) }) : t('public.share.noExpiry')].filter(Boolean).join(' · ');
        content = el('div.share-on', {},
          el('p.members-hint', {}, t('public.share.hint')),
          linkBlock(share), el('p.members-hint.share-facts', {}, facts),
          toggles(share, disabled), expiryField(share, disabled),
          el('div.share-actions', {},
            share.since && currentToken(record, share) && button(t('public.share.rotate'), { size: 'sm', variant: 'ghost', disabled, dataset: { focus: 'share:rotate2' }, onclick: () => void rotate() }),
            button(t('public.share.turnOff'), { size: 'sm', variant: 'danger', disabled, dataset: { focus: 'share:off' }, onclick: () => void turnOff() })));
      }
      if (offline()) content.prepend(el('p.members-hint', {}, t('public.share.offline')));
    }
    keepFocus(body, () => body.replaceChildren(content));
  }

  const connectivity = () => render();
  win?.addEventListener('online', connectivity);
  win?.addEventListener('offline', connectivity);
  if (db) {
    void db.get(tokenKey(ref)).then((value) => {
      if (destroyed || !value || typeof value !== 'object') return;
      record = { token: value.token, since: value.since };
      render();
    }).catch(() => {});
  }
  render();
  return {
    element,
    update: render,
    destroy() {
      destroyed = true;
      if (Object.keys(pending).length) void flush();
      clearTimeout(timer);
      win?.removeEventListener('online', connectivity);
      win?.removeEventListener('offline', connectivity);
    },
  };
}

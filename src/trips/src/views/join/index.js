import './join.css';
import { el } from '../../ui/dom.js';
import { button, spinner } from '../../ui/bits.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { spaceRoute } from '../../shared/protocol.js';
import { icon } from '../trip/members/icons.js';
import { errorMessage, retryable } from '../trip/members/errors.js';
import { formatExpiry } from '../trip/members/invites.js';
import { joinWithToken, previewInvite } from './link.js';

const roleText = (role) => t(`members.roleLower.${role === 'editor' ? 'editor' : 'viewer'}`);
const HINTS = Object.freeze({ trip: 'members.roleHint', collection: 'collections.roleHint', journey: 'journey.roleHint' });
const roleHint = (kind, role) => t(`${HINTS[kind] ?? HINTS.trip}.${role === 'editor' ? 'editor' : 'viewer'}`);

/** `#/join/<worker>/<space>/<token>`: shows the trip, owner and role, then joins on confirmation. Never deploys. */
export async function mount(container, context) {
  const { route, session, app, signal } = context;
  const target = { worker: route?.worker, space: route?.space, token: route?.token };
  const spaces = (session?.personal ?? context.personal)?.spaces;
  const card = el('section.card.join-card');
  container.replaceChildren(el('div.join-view', {}, card));
  let preview = null;

  const heading = (text) => el('h2.join-title', { tabIndex: -1 }, text);
  function show(...children) {
    if (signal?.aborted) return;
    const hadFocus = card.contains(document.activeElement) || document.activeElement === document.body;
    card.removeAttribute('aria-busy');
    card.replaceChildren(...children);
    if (hadFocus) card.querySelector('.join-title')?.focus({ preventScroll: true });
  }
  const home = (label = t('join.back')) => button(label, { variant: 'ghost', onclick: () => app?.navigate('#/', { replace: true }) });

  function loading() {
    card.setAttribute('aria-busy', 'true');
    card.replaceChildren(el('p.join-loading', { role: 'status' }, spinner(), t('join.loading')));
  }
  function failure(error, key) {
    const actions = el('div.join-actions');
    if (error && retryable(error)) actions.append(button(t('members.retry'), { variant: 'primary', onclick: () => void start() }));
    actions.append(home());
    show(el('div.join-icon.join-icon-warn', {}, icon('warning', 22)), heading(t('join.failed')),
      el('p.join-message', { role: 'alert' }, key ? t(key) : errorMessage(error)), actions);
  }
  function already(entry) {
    show(el('div.join-icon', {}, icon('check', 22)), heading(t('join.already')),
      entry.title && el('p.join-trip', {}, entry.title), el('p.join-message', {}, t('join.alreadyBody')),
      el('div.join-actions', {}, button(t('join.open'), { variant: 'primary', onclick: () => app?.navigate(spaceRoute(entry.ref), { replace: true }) }), home()));
  }
  function invitation(info) {
    const alert = el('p.members-alert', { role: 'alert', hidden: true });
    const accept = button(t('join.accept'), { variant: 'primary', onclick: () => void join(accept, alert) });
    const expiry = info.exp ? formatExpiry(info.exp) : '';
    show(el('div.join-icon', {}, icon('invite', 22)), heading(info.title || t('join.untitled')),
      el('p.join-message', {}, info.owner ? t('join.invited', { owner: info.owner, role: roleText(info.role) }) : t('join.invitedNoOwner', { role: roleText(info.role) })),
      el('p.join-hint', {}, roleHint(info.kind, info.role)),
      expiry && el('p.join-hint', {}, t('join.expires', { date: expiry })),
      el('p.join-hint', {}, t('join.privacy')),
      alert,
      el('div.join-actions', {}, accept, home(t('join.notNow'))));
  }
  async function join(control, alert) {
    control.setAttribute('aria-busy', 'true');
    control.textContent = t('join.joining');
    alert.hidden = true;
    try {
      const joined = await joinWithToken({ api: session.api, spaces, ...target, title: preview?.title ?? '' });
      if (signal?.aborted) return;
      if (!joined.indexed) toast(t('join.notIndexed'), { duration: 10_000 });
      // Replacing the entry keeps the token out of history.
      app?.navigate(spaceRoute(joined.ref), { replace: true });
    } catch (error) {
      if (signal?.aborted) return;
      if (!retryable(error)) { failure(error); return; }
      control.setAttribute('aria-busy', 'false');
      control.textContent = t('join.accept');
      alert.textContent = errorMessage(error); alert.hidden = false;
    }
  }
  async function start() {
    loading();
    if (!session?.api || !spaces) { failure(null, 'join.unavailable'); return; }
    let entry = null;
    try { entry = (await spaces.list()).find((item) => item.ref.w === target.worker && item.ref.s === target.space); } catch { /* the cache is optional here */ }
    if (signal?.aborted) return;
    if (entry) { already(entry); return; }
    try { preview = await previewInvite(session.api, target); } catch (error) { failure(error); return; }
    invitation(preview);
  }
  await start();
  return undefined;
}

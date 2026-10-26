// Sharing a journey: contributors and roles, invite links (the trip invite mechanics), the public link and leaving.
import { el, uid as uniqueId } from '../../ui/dom.js';
import { button, iconButton, spinner } from '../../ui/bits.js';
import { openMenu } from '../../ui/menu.js';
import { openModal, confirmDialog } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { formatInstant, formatNumber } from '../../lib/format.js';
import { browserTimeZone } from '../../shared/dates.js';
import { can } from '../../shared/perms.js';
import { canManage, grantable, roleIn, sortMembers } from '../trip/members/logic.js';
import { personAvatar, roleLabel } from '../trip/members/people.js';
import { cleanInvites, inviteRow, openInviteDialog } from '../trip/members/invites.js';
import { errorMessage } from '../trip/members/errors.js';
import { keepFocus, menuOpen } from '../trip/members/focus.js';
import { SHARE_EXPIRY_DAYS, currentToken, expiryAt, publicURL, tokenKey } from '../trip/members/share/logic.js';
import { SHARE_TOGGLES } from './constants.js';
import { icon } from './icons.js';
import { errorText, leaveJourney } from './spaces.js';

export const INVITE_COPY = Object.freeze({ shareText: 'journey.shareText', emailBody: 'journey.emailBody', roleHint: 'journey.roleHint' });
const SAVE_DELAY = 600;
const when = (ms) => { try { return formatInstant(ms, browserTimeZone(), { style: 'medium' }); } catch { return ''; } };

/** The journey's share settings with absent fields read the way the worker reads them. */
export function journeyShare(meta) {
  const share = meta?.share && typeof meta.share === 'object' ? meta.share : {};
  return {
    on: share.on === true, timeline: share.timeline !== false, gallery: share.gallery === true, map: share.map === true, newestFirst: share.newestFirst === true,
    exp: Number.isSafeInteger(share.exp) ? share.exp : null, since: Number.isSafeInteger(share.since) ? share.since : null,
  };
}

/** Public link settings: create, sections, newest first, expiry, new link and turn off. Returns `{element, update, destroy}`. */
export function publicSection({ space, session, ref, uid, location = globalThis.location }) {
  const api = session.api;
  const db = session.db ?? null;
  const titleId = uniqueId('jr-public');
  const body = el('div');
  const status = el('p.jr-hint', { role: 'status' });
  const element = el('section.jr-share-section', { 'aria-labelledby': titleId }, el('h3', { id: titleId }, t('journey.publicTitle')), body, status);
  let record = null;
  let result = null;
  let pending = {};
  let timer = 0;
  let busy = false;
  let destroyed = false;
  let saving = Promise.resolve();

  const meta = () => space.get('meta', 'meta');
  const server = () => (result && !(Number.isSafeInteger(meta()?.rev) && meta().rev >= result.rev) ? journeyShare({ share: result.share }) : journeyShare(meta()));
  const current = () => ({ ...server(), ...pending });
  const offline = () => globalThis.navigator?.onLine === false;

  async function remember(token, since) {
    record = token ? { token, since } : null;
    if (!db) return;
    try { if (record) await db.put(tokenKey(ref), record); else await db.remove(tokenKey(ref)); } catch { /* the link still works */ }
  }
  async function send(input, success) {
    busy = true; render();
    status.textContent = t('journey.publicSaving');
    try {
      const answer = await api.call(ref, 'share.set', input);
      if (destroyed) return null;
      result = { share: answer.share ?? {}, rev: Number.isSafeInteger(answer.rev) ? answer.rev : 0 };
      if (answer.token) await remember(answer.token, result.share.since ?? null);
      else if (input.revoke) await remember(null);
      status.textContent = success ?? t('journey.publicSaved');
      void space.sync?.().catch(() => {});
      return answer;
    } catch (error) {
      if (!destroyed) status.textContent = t('journey.publicError', { reason: errorText(error) });
      return null;
    } finally { busy = false; if (!destroyed) render(); }
  }
  function flush() {
    clearTimeout(timer);
    const input = { ...pending };
    if (!Object.keys(input).length) return saving;
    saving = saving.then(async () => {
      const answer = await send(input);
      for (const [key, value] of Object.entries(input)) if (pending[key] === value) delete pending[key];
      if (!answer) pending = {};
      if (!destroyed) render();
    });
    return saving;
  }
  function change(patch) { Object.assign(pending, patch); render(); clearTimeout(timer); timer = setTimeout(() => void flush(), SAVE_DELAY); }
  async function create() {
    const share = server();
    const answer = await send({ on: true, rotate: true, timeline: share.timeline, gallery: share.gallery || !meta()?.share, map: share.map, newestFirst: share.newestFirst }, t('journey.publicReady'));
    if (answer?.token) body.querySelector('.jr-public-url')?.select?.();
  }
  async function rotate() {
    const ok = await confirmDialog({ title: t('journey.publicRotateTitle'), body: t('journey.publicRotateBody'), confirmLabel: t('journey.publicRotate') });
    if (ok && !destroyed) await send({ rotate: true }, t('journey.publicRotated'));
  }
  async function turnOff() {
    const ok = await confirmDialog({ title: t('journey.publicOffTitle'), body: t('journey.publicOffBody'), confirmLabel: t('journey.publicTurnOff'), danger: true });
    if (!ok || destroyed) return;
    clearTimeout(timer); pending = {};
    await send({ revoke: true }, t('journey.publicTurnedOff'));
  }
  async function copy(url, input) {
    try { await navigator.clipboard.writeText(url); toast(t('journey.copied')); } catch { input.focus(); input.select(); toast(t('journey.copyManual')); }
  }

  function linkBlock(share) {
    const token = currentToken(record, share);
    if (!token) return el('div.jr-public-link', {}, el('p.jr-hint', {}, t('journey.publicHidden')), button(t('journey.publicRotate'), { size: 'sm', disabled: busy || offline(), dataset: { focus: 'share:rotate' }, onclick: () => void rotate() }));
    const url = publicURL(location.href, ref, token);
    const id = uniqueId('jr-url');
    const input = el('input.input.jr-public-url', { id, readOnly: true, value: url, spellcheck: false, onfocus: (event) => event.target.select() });
    return el('div.jr-public-link', {}, el('label.field-label', { htmlFor: id }, t('journey.publicLink')), input,
      el('div.jr-row', {}, button(t('journey.copy'), { variant: 'primary', icon: 'copy', size: 'sm', dataset: { focus: 'share:copy' }, onclick: () => copy(url, input) }),
        el('a.btn.btn-outline.btn-sm', { href: url, target: '_blank', rel: 'noopener noreferrer' }, icon('link', 16), t('journey.publicOpen'))));
  }
  function toggles(share, disabled) {
    const legendId = uniqueId('jr-sections');
    return el('fieldset.jr-share-toggles', { 'aria-labelledby': legendId }, el('legend.field-label', { id: legendId }, t('journey.publicSections')),
      SHARE_TOGGLES.map((key) => {
        const hintId = uniqueId('jr-hint');
        return el('label.check-field', {},
          el('input', { type: 'checkbox', checked: share[key], disabled, 'aria-describedby': hintId, dataset: { focus: `share:${key}` }, onchange: (event) => change({ [key]: event.target.checked }) }),
          el('span', {}, el('span', {}, t(`journey.publicToggle.${key}`)), el('span.field-hint', { id: hintId }, t(`journey.publicHint.${key}`))));
      }),
      !share.timeline && !share.gallery && !share.map && el('p.jr-alert', { role: 'note' }, t('journey.publicNothing')));
  }
  function expiryField(share, disabled) {
    const id = uniqueId('jr-exp');
    const options = [el('option', { value: 'never' }, t('journey.publicNever')),
      ...SHARE_EXPIRY_DAYS.map((days) => el('option', { value: String(days) }, days === 1 ? t('journey.publicInDay') : t('journey.publicInDays', { count: formatNumber(days) })))];
    if (share.exp) options.unshift(el('option', { value: 'current' }, t('journey.publicExpiresOn', { date: when(share.exp) })));
    const select = el('select.select', { id, disabled, dataset: { focus: 'share:exp' }, onchange: (event) => {
      const value = event.target.value;
      if (value === 'current') return;
      clearTimeout(timer);
      void flush().then(() => send({ exp: value === 'never' ? null : expiryAt(Number(value)) }));
    } }, options);
    select.value = share.exp ? 'current' : 'never';
    return el('div.field', {}, el('label.field-label', { htmlFor: id }, t('journey.publicExpiry')), select);
  }
  function render() {
    if (destroyed) return;
    const share = current();
    const manage = can(roleIn(space, uid), 'share.manage');
    let content;
    if (!manage) {
      element.hidden = !share.on;
      const sections = SHARE_TOGGLES.filter((key) => key !== 'newestFirst' && share[key]).map((key) => t(`journey.publicToggle.${key}`));
      content = el('p.jr-hint', {}, sections.length ? t('journey.publicMemberNote', { sections: sections.join(', ') }) : t('journey.publicMemberNoteEmpty'));
    } else if (!share.on) {
      element.hidden = false;
      content = el('div', {}, el('p.jr-hint', {}, t('journey.publicHint')),
        button(t('journey.publicCreate'), { variant: 'primary', icon: 'plus', disabled: busy || offline(), dataset: { focus: 'share:create' }, onclick: () => void create() }));
    } else {
      element.hidden = false;
      const disabled = busy || offline();
      const facts = [share.since && t('journey.publicSince', { date: when(share.since) }), share.exp ? t('journey.publicExpiresAt', { date: when(share.exp) }) : t('journey.publicNoExpiry')].filter(Boolean).join(' · ');
      content = el('div', {}, el('p.jr-hint', {}, t('journey.publicHint')), linkBlock(share), el('p.jr-hint', {}, facts),
        toggles(share, disabled), expiryField(share, disabled),
        el('div.jr-row', {}, currentToken(record, share) && button(t('journey.publicRotate'), { size: 'sm', variant: 'ghost', disabled, onclick: () => void rotate() }),
          button(t('journey.publicTurnOff'), { size: 'sm', variant: 'danger', disabled, dataset: { focus: 'share:off' }, onclick: () => void turnOff() })));
      if (offline()) content.prepend(el('p.jr-hint', {}, t('journey.publicOffline')));
    }
    keepFocus(body, () => body.replaceChildren(content));
  }
  const connectivity = () => render();
  globalThis.addEventListener?.('online', connectivity);
  globalThis.addEventListener?.('offline', connectivity);
  if (db) void db.get(tokenKey(ref)).then((value) => { if (!destroyed && value && typeof value === 'object') { record = { token: value.token, since: value.since }; render(); } }).catch(() => {});
  render();
  return {
    element, update: render,
    destroy() {
      destroyed = true;
      if (Object.keys(pending).length) void flush();
      clearTimeout(timer);
      globalThis.removeEventListener?.('online', connectivity);
      globalThis.removeEventListener?.('offline', connectivity);
    },
  };
}

/** The sharing dialog. `onLeft` runs after this member left. */
export function openSharing({ space, context, ref, onLeft }) {
  const { session, account, puter } = context;
  const api = session.api;
  const uid = account?.uuid ?? session.account?.uuid;
  const offs = [];
  const busy = new Set();
  let invites = { status: 'idle', items: [] };
  let me = access();
  let closed = false;
  let deferred = 0;

  function access() {
    const role = roleIn(space, uid);
    return { uid, role, perms: {}, manage: can(role, 'members.manage'), share: can(role, 'share.manage') };
  }
  const name = () => space.get('meta', 'meta')?.title || t('journey.untitled');

  const membersId = uniqueId('jr-members');
  const list = el('ul.card.members-list', { 'aria-labelledby': membersId });
  const inviteButton = button(t('journey.invite'), { variant: 'primary', onclick: () => invite() });
  inviteButton.prepend(icon('invite', 16));
  const linksId = uniqueId('jr-links');
  const linksBody = el('div');
  const links = el('section.jr-share-section', { 'aria-labelledby': linksId }, el('h3', { id: linksId }, t('journey.inviteLinks')), linksBody);
  const pub = publicSection({ space, session, ref, uid });
  const leaveSection = el('section.jr-share-section');
  const content = el('div.jr-sharing', {},
    el('section.jr-share-section', { 'aria-labelledby': membersId },
      el('div.jr-row.jr-row-between', {}, el('h3', { id: membersId }, t('journey.contributors')), inviteButton), list),
    links, pub.element, leaveSection);

  function memberRow(member) {
    return el('li.list-row.member-row', { dataset: { key: member.uid } },
      personAvatar(member, { puter, presence: true }),
      el('div.member-text', {}, el('span.member-name', {}, member.name, member.uid === uid && el('span.chip.chip-accent.member-you', {}, t('journey.you')))),
      el('span.chip.member-role', { dataset: { role: member.role } }, roleLabel(member.role)),
      canManage(me, member) && iconButton('more', t('journey.memberActions', { name: member.name }), {
        dataset: { focus: `member:${member.uid}` }, disabled: busy.has(member.uid), onclick: (event) => memberMenu(event.currentTarget, member),
      }));
  }
  function renderMembers() {
    if (closed) return;
    if (menuOpen(list)) { clearTimeout(deferred); deferred = setTimeout(renderMembers, 1000); return; }
    keepFocus(list, () => list.replaceChildren(...sortMembers(space.members().filter((member) => member.role), uid).map(memberRow)));
  }
  function memberMenu(anchor, member) {
    openMenu(anchor, [
      ...grantable(me.role).map((role) => ({ label: t('journey.makeRole', { role: roleLabel(role) }), checked: member.role === role,
        onSelect: () => { if (member.role !== role) void act(member, 'member.role', { uuid: member.uid, role }, t('journey.roleChanged', { name: member.name, role: roleLabel(role) })); } })),
      { separator: true },
      { label: t('journey.removeMember'), icon: 'trash', danger: true, onSelect: () => void remove(member) },
    ]);
  }
  async function act(member, op, input, success) {
    busy.add(member.uid); renderMembers();
    try { await api.call(ref, op, input); toast(success); } catch (error) { toast(errorMessage(error, { context: 'member' })); } finally {
      busy.delete(member.uid);
      if (!closed) { renderMembers(); void space.sync?.().catch(() => {}); }
    }
  }
  async function remove(member) {
    const ok = await confirmDialog({ title: t('journey.removeTitle', { name: member.name }), body: t('journey.removeBody', { name: member.name }), confirmLabel: t('journey.removeMember'), danger: true });
    if (ok && !closed) await act(member, 'member.remove', { uuid: member.uid }, t('journey.removed', { name: member.name }));
  }
  function renderLinks() {
    links.hidden = !me.manage;
    if (!me.manage) return;
    let body;
    if (invites.status === 'loading' || invites.status === 'idle') body = el('p.jr-hint', {}, spinner(), t('journey.linksLoading'));
    else if (invites.status === 'error') body = el('div.jr-row', {}, el('p', {}, errorMessage(invites.error)), button(t('journey.retry'), { size: 'sm', onclick: () => void loadInvites() }));
    else if (!invites.items.length) body = el('p.jr-hint', {}, t('journey.linksEmpty'));
    else body = el('ul.card.members-list', { 'aria-labelledby': linksId }, invites.items.map((item) => inviteRow(item, { me, members: space.members(), onRevoke: revoke })));
    keepFocus(linksBody, () => linksBody.replaceChildren(body));
  }
  async function loadInvites() {
    if (closed || !me.manage) return;
    if (navigator.onLine === false) { invites = { status: 'error', items: [], error: { code: 'network', status: 0 } }; renderLinks(); return; }
    invites = { ...invites, status: 'loading' }; renderLinks();
    try { invites = { status: 'ready', items: cleanInvites((await api.call(ref, 'invite.list'))?.invites) }; } catch (error) { invites = { status: 'error', items: [], error }; }
    if (!closed) renderLinks();
  }
  async function revoke(item) {
    const ok = await confirmDialog({ title: t('journey.revokeTitle'), body: t('journey.revokeBody'), confirmLabel: t('journey.revoke'), danger: true });
    if (!ok || closed) return;
    try { await api.call(ref, 'invite.revoke', { id: item.id }); toast(t('journey.revoked')); } catch (error) { if (error?.code !== 'not_found') toast(errorMessage(error)); }
    void loadInvites();
  }
  function invite() {
    openInviteDialog({ api, session, puter, uid, me, ref, tripTitle: name(), copy: INVITE_COPY, onCreated: () => void loadInvites() });
  }
  function renderLeave() {
    if (me.role === 'owner') { leaveSection.replaceChildren(el('p.jr-hint', {}, t('journey.ownerNote'))); return; }
    const control = button(t('journey.leave'), { variant: 'danger', onclick: () => void leave(control) });
    control.prepend(icon('leave', 16));
    leaveSection.replaceChildren(el('p.jr-hint', {}, t('journey.leaveHint')), control);
  }
  async function leave(control) {
    const ok = await confirmDialog({ title: t('journey.leaveTitle', { name: name() }), body: t('journey.leaveBody'), confirmLabel: t('journey.leave'), danger: true });
    if (!ok || closed) return;
    control.setAttribute('aria-busy', 'true');
    try { await leaveJourney(context, ref); } catch (error) { control.setAttribute('aria-busy', 'false'); toast(errorText(error)); return; }
    toast(t('journey.left', { name: name() }));
    dialog.close('left');
    onLeft?.();
  }
  function update() {
    const before = me;
    me = access();
    inviteButton.hidden = !me.manage;
    renderMembers(); pub.update();
    if (before.role !== me.role || before.manage !== me.manage) { renderLeave(); if (me.manage) void loadInvites(); else renderLinks(); }
  }
  offs.push(space.subscribe('member', update), space.subscribe({ type: 'meta', id: 'meta' }, update), space.subscribe('presence', renderMembers));
  inviteButton.hidden = !me.manage;
  renderMembers(); renderLinks(); renderLeave();
  void loadInvites();
  const dialog = openModal({ title: t('journey.sharingTitle', { name: name() }), content, wide: true,
    onClose: () => { closed = true; clearTimeout(deferred); pub.destroy(); for (const off of offs.splice(0)) off(); } });
  return dialog;
}

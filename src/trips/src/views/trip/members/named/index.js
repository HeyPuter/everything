// Invite by Puter username: the worker shares an invite stub with that account (KV share with a label), so the
// invitation reaches their Trips inbox without a link.
import { el } from '../../../../ui/dom.js';
import { button } from '../../../../ui/bits.js';
import { field } from '../../../../ui/fields.js';
import { t } from '../../../../lib/i18n/index.js';
import { errorMessage } from '../errors.js';
import { icon } from '../icons.js';
import { looksLikeEmail } from '../logic.js';

const USERNAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** `{value}` or `{error}` (`required|email|invalid|self`) for a typed username; a leading `@` is ignored. */
export function cleanUsername(raw, self = '') {
  const text = typeof raw === 'string' ? raw.trim().replace(/^@/, '') : '';
  if (!text) return { error: 'required' };
  if (looksLikeEmail(text) || text.includes('@')) return { error: 'email' };
  if (!USERNAME.test(text)) return { error: 'invalid' };
  if (self && text.toLowerCase() === self.toLowerCase()) return { error: 'self' };
  return { value: text };
}

const FIELD_ERRORS = Object.freeze({ required: 'sharing.usernameRequired', email: 'sharing.usernameEmail', invalid: 'sharing.usernameInvalid', self: 'sharing.usernameSelf' });

/** Worker refusals specific to named invites; everything else reads like other invite errors. */
export function namedErrorMessage(error) {
  const code = error?.code;
  if (code === 'user_not_found' || code === 'invalid_username') return t('sharing.errNotFound');
  if (code === 'already_member') return t('sharing.errAlreadyMember');
  if (code === 'named_invites_unavailable' || code === 'kv_handles_disabled') return t('sharing.errUnavailable');
  if (code === 'recipient_refused') return t('sharing.errRefused');
  if (code === 'share_consent_required') return t('sharing.errConsent');
  if (code === 'share_limit') return t('sharing.errLimit');
  return errorMessage(error, { context: 'invite' });
}

/** The username field for the invite dialog. `read()` validates and returns the username or null. */
export function usernameField({ self = '' } = {}) {
  const input = field({ label: t('sharing.username'), hint: t('sharing.usernameHint'), autocomplete: 'off', autocapitalize: 'none', spellcheck: false, maxLength: 80 });
  return {
    element: input.element,
    clear: () => input.setError(''),
    read() {
      const cleaned = cleanUsername(input.input.value, self);
      if (cleaned.error) { input.setError(t(FIELD_ERRORS[cleaned.error])); input.input.focus(); return null; }
      input.setError('');
      return cleaned.value;
    },
  };
}

/** Creates the named invite; the worker resolves the username and shares the stub. */
export function sendNamedInvite(api, ref, { role, exp, username }) {
  return api.call(ref, 'invite.create', { role, exp, named: username });
}

/** Confirmation shown in place of the form. */
export function sentView({ username, close }) {
  const name = `@${username}`;
  return el('div.invite-result', {},
    el('p.invite-result-title', {}, icon('mail'), ' ', t('sharing.sent', { name })),
    el('p.members-hint', {}, t('sharing.sentBody', { name })),
    el('div.modal-actions', {}, button(t('members.done'), { variant: 'primary', onclick: () => close() })));
}

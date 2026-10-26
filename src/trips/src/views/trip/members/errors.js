import { t } from '../../../lib/i18n/index.js';

const REASONS = Object.freeze({ expired: 'members.errExpired', revoked: 'members.errRevoked', used: 'members.errUsed' });

/**
 * A translated message for a worker or client error. `context` adjusts codes whose meaning depends on the call:
 * `invite` (429 is the daily invite budget) and `member` (404 `not_member` is about the target).
 */
export function errorMessage(error, { context = '', offline = globalThis.navigator?.onLine === false } = {}) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const status = Number.isInteger(error?.status) ? error.status : null;
  if (code === 'invite_invalid') return t(REASONS[error.reason] ?? 'members.errInvalid');
  if (code === 'space_full') return t('members.errFull');
  if (code === 'space_not_found' || code === 'gone') return t('members.errGone');
  if (code === 'owner_credit') return t('members.errOwnerCredit');
  if (status === 402) return t('members.errCallerCredit');
  if (code === 'rate_limited' || status === 429) {
    if (context === 'invite') return t('members.errInviteBudget');
    const minutes = Number.isFinite(error?.retryAfter) && error.retryAfter > 0 ? Math.ceil(error.retryAfter / 60) : 0;
    return minutes > 1 ? t('members.errRateLimitedIn', { minutes: new Intl.NumberFormat().format(minutes) }) : t('members.errRateLimited');
  }
  if (code === 'worker_outdated' || status === 426) return t('members.errOutdated');
  if (code === 'not_member') return t(context === 'member' && status === 404 ? 'members.errTargetGone' : 'members.errNotMember');
  if (code === 'invite_limit') return t('members.errInviteLimit');
  if (code === 'invalid_expiry') return t('members.errClock');
  if (code === 'owner_cannot_leave') return t('members.errOwnerLeave');
  if (code === 'untrusted_worker' || code === 'invalid_space_ref' || code === 'invalid_space') return t('members.errBadLink');
  if (status === 403) return t('members.errForbidden');
  if (status === 401 || code === 'account_changed') return t('members.errCredential');
  if (code === 'busy' || status === 503) return t('members.errBusy');
  if (offline || status === 0 || code === 'network' || code === 'timeout') return t('members.errOffline');
  return t('members.errGeneric');
}

/** Errors worth a retry button: the request may succeed unchanged later. */
export function retryable(error) {
  const status = Number.isInteger(error?.status) ? error.status : 0;
  return status === 0 || status === 503 || status === 429 || status === 402 || status >= 500 || ['network', 'timeout', 'busy'].includes(error?.code);
}

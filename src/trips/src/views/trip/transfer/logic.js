// View helpers shared by the transfer dialog, the Members section and the trip notice.
import { t } from '../../../lib/i18n/index.js';
import { formatDate } from '../../../lib/format.js';
import { transferState } from '../../../lib/transfer/index.js';

/** The caller's role from their member entity (`space.can` keeps the role from open time). */
export function roleOf(space, uid) {
  return space.members().find((member) => member.uid === uid)?.role ?? null;
}

export function nameOf(space, uid, fallback = '') {
  return space.members().find((member) => member.uid === uid)?.name || fallback;
}

export const ownerName = (space) => space.members().find((member) => member.role === 'owner')?.name || '';

/** `transferState` for this viewer, plus display names. */
export function viewState(space, uid, now = Date.now()) {
  const state = transferState(space.get('meta', 'meta'), uid, { now });
  const target = state.transfer ? (state.transfer.name || nameOf(space, state.transfer.to, t('transfer.someone'))) : '';
  const movedName = state.movedTo?.name || t('transfer.someone');
  return { ...state, target, movedName, owner: ownerName(space), role: roleOf(space, uid) };
}

/** A failure as a translated reason (`transfer.error.*`). */
export function reasonText(error) {
  const cause = error?.cause ?? error;
  const code = error?.reason ?? cause?.code ?? error?.code;
  const status = cause?.status ?? error?.status;
  let key = 'generic';
  if (code === 'busy') key = 'busy';
  else if (status === 402 || ['owner_credit', 'caller_credit', 'insufficient_funds'].includes(code)) key = 'credit';
  else if (status === 429 || code === 'rate_limited') key = 'limit';
  else if (code === 'space_not_found') key = 'gone';
  else if (status === 403 || ['forbidden', 'not_member'].includes(code)) key = 'forbidden';
  else if (code === 'email_unverified') key = 'email';
  else if (code === 'worker_outdated' || status === 426) key = 'outdated';
  else if (['space_moved', 'already_moved'].includes(code)) key = 'moved';
  else if (status === 0 || ['network', 'timeout', 'offline'].includes(code) || globalThis.navigator?.onLine === false) key = 'offline';
  return t(`transfer.error.${key}`);
}

const pad = (value) => String(value).padStart(2, '0');
/** A ms timestamp as a date in this device's zone. */
export function localDate(ms) {
  const date = new Date(ms);
  return formatDate(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`);
}

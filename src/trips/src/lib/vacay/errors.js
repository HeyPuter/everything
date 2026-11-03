// Maps Puter and KV-handle failures to the short codes the view translates (`vacay.error.<code>`).
const BY_CODE = Object.freeze({
  kv_handle_not_found: 'gone',
  // Unknown or stopped handle on unshare or subscribe; `shareTo` maps an unknown user itself.
  subject_does_not_exist: 'gone',
  kv_handle_access_denied: 'denied',
  kv_handles_disabled: 'disabled',
  kv_handle_option_invalid: 'failed',
  kv_handle_key_invalid: 'failed',
  kv_share_access_invalid: 'failed',
  kv_share_label_invalid: 'failed',
  invalid_kv_share_prefix: 'failed',
  events_kv_handle_limit_reached: 'limit',
  events_kv_handle_not_delegated: 'consent',
  recipient_not_accepting_shares: 'refused',
  invalid_recipient: 'recipient',
  rate_limit_exceeded: 'rate',
  too_many_requests: 'rate',
  insufficient_funds: 'credit',
  offline: 'offline',
  account_changed: 'account',
});

export function errorCode(error) {
  if (error instanceof VacayError) return error.code;
  if (globalThis.navigator?.onLine === false) return 'offline';
  const code = error?.code ?? error?.error?.code;
  if (code && Object.hasOwn(BY_CODE, code)) return BY_CODE[code];
  const status = error?.status ?? error?.statusCode;
  if (status === 0) return 'offline';
  if (status === 402) return 'credit';
  if (status === 429) return 'rate';
  if (status === 401 || status === 403) return 'denied';
  return 'failed';
}

export class VacayError extends Error {
  constructor(code, cause) { super(code); this.code = code; this.cause = cause; }
}

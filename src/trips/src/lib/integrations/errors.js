/** A call to one of the user's own servers failed; `code` names an `integrations.error.<code>` string. */
export class IntegrationError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'IntegrationError';
    this.code = code;
    Object.assign(this, details);
  }
}

const CODES = new Set([
  'unavailable', 'not_configured', 'invalid_url', 'offline', 'unreachable', 'timeout', 'aborted', 'redirected',
  'unauthorized', 'forbidden', 'scope', 'not_found', 'rate_limited', 'server_error', 'rejected', 'too_large', 'bad_response',
  'account_changed',
]);

/** The `integrations.error.*` code for any error thrown by an adapter or the store. */
export function errorCode(error) {
  if (!error) return 'unknown';
  if (error.name === 'AbortError' || error.code === 'aborted') return 'aborted';
  if (error instanceof IntegrationError) return CODES.has(error.code) ? error.code : 'unknown';
  if (globalThis.navigator?.onLine === false) return 'offline';
  if (error.status === 401 && error.code === 'account_changed') return 'account_changed';
  if (error.status === 402) return 'credit';
  return 'unknown';
}

export const errorKey = (error) => `integrations.error.${errorCode(error)}`;

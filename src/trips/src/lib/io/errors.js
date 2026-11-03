/** An import or export problem; `code` names an `io.error.<code>` string. */
export class IoError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'IoError';
    this.code = code;
    Object.assign(this, details);
  }
}

const LOCAL = new Set([
  'file_empty', 'file_too_large', 'unsupported_format', 'invalid_xml', 'invalid_kmz', 'no_features', 'invalid_json',
  'not_trip_export', 'newer_version', 'unsupported_kind', 'too_many_items', 'forbidden', 'offline',
  'session_unavailable', 'needs_trip', 'invalid_track', 'drive_unavailable', 'aborted',
]);

/** Normalizes worker, network and local errors to an `io.error.*` code. */
export function errorCode(error) {
  if (!error) return 'unknown';
  if (error.name === 'AbortError') return 'aborted';
  const code = typeof error.code === 'string' ? error.code : '';
  if (error instanceof IoError) return LOCAL.has(code) ? code : 'unknown';
  if (code === 'email_unverified') return code;
  const status = error.status;
  if (status === 0 || status === undefined) {
    if (code === 'aborted') return code;
    if (globalThis.navigator?.onLine === false || ['offline', 'network', 'timeout'].includes(code)) return 'offline';
    return 'unknown';
  }
  if (status === 402) return 'credit';
  if (status === 403) return 'forbidden';
  if (status === 409 && ['space_limit', 'space_full'].includes(code)) return 'trip_full';
  if (status === 413) return code === 'space_too_large' ? 'space_too_large' : 'file_too_large';
  if (status === 415) return 'unsupported_format';
  if (status === 426) return 'worker_outdated';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'busy';
  return 'unknown';
}

export const errorKey = (error) => `io.error.${errorCode(error)}`;

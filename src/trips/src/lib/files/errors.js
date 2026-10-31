/** A file problem found in the browser; `code` names a `files.error.<code>` string. */
export class FileError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'FileError';
    this.code = code;
    Object.assign(this, details);
  }
}

const PASS = new Set([
  'file_type', 'file_empty', 'file_too_large', 'video_direct', 'video_too_large', 'video_format', 'space_quota', 'upload_missing', 'direct_required', 'exists', 'gone',
  'owner_credit', 'caller_credit', 'rate_limited', 'busy', 'timeout', 'network', 'aborted', 'offline', 'worker_outdated',
  'thumb_unsupported', 'cover_type', 'image_type', 'heic_unsupported', 'drive_unavailable', 'files_unbound', 'invalid_links', 'not_trashed', 'forbidden', 'not_found',
]);

/** Normalizes worker, network and local errors to one of the `files.error.*` codes. */
export function errorCode(error) {
  if (!error) return 'unknown';
  if (error.name === 'AbortError') return 'aborted';
  const code = typeof error.code === 'string' ? error.code : '';
  if (error instanceof FileError) return PASS.has(code) ? code : 'unknown';
  const status = error.status;
  if (status === 0 || status === undefined) {
    if (code === 'aborted') return code;
    if (globalThis.navigator?.onLine === false) return 'offline';
    return PASS.has(code) ? code : 'network';
  }
  if (status === 402) return code === 'caller_credit' ? 'caller_credit' : 'owner_credit';
  if (status === 403) return 'forbidden';
  if (status === 404) return code === 'upload_missing' ? 'upload_missing' : 'not_found';
  if (status === 413) return code === 'space_quota' ? 'space_quota' : 'file_too_large';
  if (status === 415) return code === 'thumb_unsupported' ? code : 'file_type';
  if (status === 426) return 'worker_outdated';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'busy';
  return PASS.has(code) ? code : 'unknown';
}

export const errorKey = (error) => `files.error.${errorCode(error)}`;

/** Errors worth an automatic or one-tap retry. */
export const retryable = (error) => ['network', 'timeout', 'busy', 'offline', 'upload_missing', 'rate_limited', 'unknown'].includes(errorCode(error));

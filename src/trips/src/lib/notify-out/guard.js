// Reach rules for webhook and ntfy URLs, checked when they are saved and again before every send (personal KV is
// editable by its user outside the app): the shared rules in `src/shared/reach.js` with `RECEIVER` (https on 443 or
// 8443, public hosts only). Redirects are never followed.
import { DomainError } from '../../shared/errors.js';
import { RECEIVER, reachProblem } from '../../shared/reach.js';

export { URL_CHARS, isBlockedIp } from '../../shared/reach.js';

const CODES = Object.freeze({ invalid: 'url_invalid', scheme: 'url_https', credentials: 'url_credentials', port: 'url_port', private: 'url_private' });

/** Why `raw` may not be sent to (`url_invalid`, `url_https`, `url_credentials`, `url_port`, `url_private`), or null. */
export function urlProblem(raw) {
  const problem = reachProblem(raw, RECEIVER);
  return problem ? CODES[problem] : null;
}

/** The URL without its fragment, or a `DomainError` naming the problem. */
export function safeUrl(raw) {
  const problem = urlProblem(raw);
  if (problem) throw new DomainError(problem, 400);
  const url = new URL(raw);
  url.hash = '';
  return url.href;
}

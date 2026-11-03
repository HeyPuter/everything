// Delivery retries. Inside one handler run (30 s platform limit) a send is tried up to three times; a send that still
// fails transiently is kept in `me:notify:retry` and tried again by later runs on the persisted schedule. There is no
// timer: a later run happens on the next event (trip activity, a reminder write or a test).
export const INLINE_DELAYS = Object.freeze([0, 1000, 3000]);
export const PERSIST_DELAYS = Object.freeze([60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]);
export const MAX_RETRY_AGE = 86_400_000;
export const MAX_INLINE_WAIT = 5000;
export const SEND_TIMEOUT = 5000;

/** `ok`, `retry` (worth trying again) or `fail` for an HTTP status; 0 is a network error or timeout. */
export function classify(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 0 || status === 408 || status === 425 || status === 429 || status >= 500) return 'retry';
  return 'fail';
}

/** Milliseconds a `Retry-After` header asks for (seconds or an HTTP date), or null. */
export function retryAfterMs(header, now = Date.now()) {
  if (header == null || header === '') return null;
  const text = String(header).trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * When persisted attempt `attempt` (0-based) is due, or null when the delivery should be dropped: after the last
 * scheduled attempt, or once it is more than a day old. A longer `Retry-After` pushes the time out.
 */
export function nextAttempt(attempt, { first, now, retryAfter = null }) {
  if (attempt >= PERSIST_DELAYS.length) return null;
  const at = now + Math.max(PERSIST_DELAYS[attempt], retryAfter ?? 0);
  return at - first > MAX_RETRY_AGE ? null : at;
}

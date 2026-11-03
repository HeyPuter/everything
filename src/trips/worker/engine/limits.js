import { fail } from '../http.js';
import { K } from '../keys.js';

/**
 * KV window counter for budgets the owner pays for (invites, uploads, public reads).
 * The window number is in the key; `expire` only cleans up.
 */
export async function kvBudget(w, sid, bucket, who, { windowMs, limit, amount = 1 }) {
  const window = Math.floor(w.now() / windowMs);
  const key = K.rl(sid, bucket, who, window);
  const count = await w.kv.incr(key, amount);
  if (count === amount) w.waitUntil(w.kv.expire(key, Math.ceil((2 * windowMs) / 1000)).catch(() => {}));
  if (count > limit) fail('rate_limited', 429, { retryAfter: Math.ceil(((window + 1) * windowMs - w.now()) / 1000) });
  return count;
}

const windowEnd = (w, windowMs) => Math.ceil(((Math.floor(w.now() / windowMs) + 1) * windowMs - w.now()) / 1000);
const meterKey = (w, sid, bucket, who, windowMs) => `${sid}:${bucket}:${who}:${Math.floor(w.now() / windowMs)}`;

/** Refuses without any read once this isolate has seen the member's `meter` budget run out. */
export function metered(w, sid, bucket, who, { windowMs }) {
  if (w.meters.get(meterKey(w, sid, bucket, who, windowMs))?.over) fail('rate_limited', 429, { retryAfter: windowEnd(w, windowMs) });
}

/**
 * A `kvBudget` for amounts too small to pay a counter write each time (bytes read for a member): they add up in
 * isolate memory and reach the KV counter once they pass `floor`.
 */
export async function meter(w, sid, bucket, who, amount, { windowMs, limit, floor }) {
  const key = meterKey(w, sid, bucket, who, windowMs);
  const entry = w.meters.get(key) ?? { debt: 0, over: false };
  w.meters.set(key, entry);
  if (entry.over) fail('rate_limited', 429, { retryAfter: windowEnd(w, windowMs) });
  entry.debt += amount;
  if (entry.debt < floor) return;
  const debt = entry.debt;
  entry.debt = 0;
  try { await kvBudget(w, sid, bucket, who, { windowMs, limit, amount: debt }); } catch (error) {
    if (error?.status === 429) entry.over = true;
    throw error;
  }
}

/** Isolate-memory limit (cheap, approximate across isolates); a refusal says when the window ends. */
export function throttle(w, key, limit, windowMs, weight = 1) {
  if (w.limiter.take(key, limit, windowMs, weight)) return;
  const time = w.now();
  fail('rate_limited', 429, { retryAfter: Math.max(1, Math.ceil(((Math.floor(time / windowMs) + 1) * windowMs - time) / 1000)) });
}

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

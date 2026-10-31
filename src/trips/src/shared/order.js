import { invariant } from './errors.js';
import { LIMITS } from './limits.js';

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function isOrder(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= LIMITS.orderChars
    && /^[0-9A-Za-z]+$/.test(value) && !value.endsWith('0');
}

export function orderBetween(left = null, right = null) {
  invariant(left === null || isOrder(left), 'invalid_order');
  invariant(right === null || isOrder(right), 'invalid_order');
  invariant(left === null || right === null || left < right, 'invalid_order_bounds');
  let prefix = '';
  let a = left ?? '';
  let b = right;
  for (let i = 0; prefix.length < LIMITS.orderChars; i++) {
    const low = a[i] === undefined ? 0 : DIGITS.indexOf(a[i]);
    const high = b === null ? DIGITS.length : DIGITS.indexOf(b[i]);
    invariant(high >= low, 'invalid_order_bounds');
    if (high - low > 1) return prefix + DIGITS[Math.floor((low + high) / 2)];
    prefix += DIGITS[low];
    if (high !== low) {
      a = a.slice(i + 1);
      b = null;
      i = -1;
    }
  }
  invariant(false, 'order_exhausted');
}

export function orderKeys(count, left = null, right = null) {
  invariant(Number.isSafeInteger(count) && count >= 0 && count <= LIMITS.entities, 'invalid_count');
  if (!count) return [];
  const middle = orderBetween(left, right);
  const before = Math.floor(count / 2);
  return [...orderKeys(before, left, middle), middle, ...orderKeys(count - before - 1, middle, right)];
}

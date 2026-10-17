/**
 * Fractional order keys. Every block and page carries a string key; sorting
 * the keys gives the order, and a key can always be made between two others
 * without renumbering anything. Two people inserting at the same spot get
 * different keys (a random tail breaks ties), so concurrent edits merge.
 *
 * Keys never end in the zero digit, so something always fits before them.
 * Appending, prepending, or inserting again and again next to the key just
 * made (typing a list) grows keys logarithmically, not linearly: 10,000
 * appends stay under 10 characters.
 */
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
const MID = DIGITS[Math.floor(BASE / 2)];
const TOP = DIGITS[BASE - 1];

function digit(c) {
  const i = DIGITS.indexOf(c);
  if (i < 0) throw new Error(`bad order key character: ${c}`);
  return i;
}

/**
 * A short key above a. Leading top digits are used up; after them, count up
 * in a field one digit wider than that run, so each time the field fills,
 * the next one holds vastly more keys.
 */
function after(a) {
  if (!a) return MID;
  let run = 0;
  while (a[run] === TOP) run++;
  const field = [...a.slice(run, 2 * run + 1).padEnd(run + 1, '0')].map(digit);
  let i = field.length - 1;
  // field[0] is below the top digit, so the carry stops inside the field.
  while (field[i] === BASE - 1) field[i--] = 0;
  field[i]++;
  return (TOP.repeat(run) + field.map((d) => DIGITS[d]).join('')).replace(/0+$/, '');
}

/** A short key below b (the mirror of after). */
function before(b) {
  let run = 0;
  while (b[run] === '0') run++;
  const field = [...b.slice(run, 2 * run + 1).padEnd(run + 1, '0')].map(digit);
  if (field.every((d) => d === 0)) throw new Error(`bad order key: ${b}`);
  let i = field.length - 1;
  while (field[i] === 0) field[i--] = BASE - 1;
  field[i]--;
  const key = '0'.repeat(run) + field.map((d) => DIGITS[d]).join('');
  return key.endsWith('0') ? key + TOP : key;
}

/** A key that sorts strictly between a and b ('' means open-ended). */
export function between(a = '', b = '') {
  if (!b) return after(a);
  if (!a) return before(b);
  if (a >= b) throw new Error(`order keys out of order: ${a} >= ${b}`);
  let i = 0;
  while (a[i] === b[i]) i++;
  const prefix = a.slice(0, i);
  const hi = digit(b[i]);
  // a is a prefix of b: extend a with something below the rest of b.
  if (i >= a.length) return hi > 1 ? prefix + DIGITS[Math.floor(hi / 2)] : prefix + before(b.slice(i));
  const lo = digit(a[i]);
  if (hi - lo > 1) return prefix + DIGITS[Math.floor((lo + hi) / 2)];
  // Adjacent digits: keep a's digit and go above the rest of a, unbounded.
  return prefix + a[i] + after(a.slice(i + 1));
}

/** A random tail so keys minted at the same spot by two clients differ. */
function jitter() {
  const n = new Uint8Array(2);
  crypto.getRandomValues(n);
  return DIGITS[1 + (n[0] % (BASE - 1))] + DIGITS[1 + (n[1] % (BASE - 1))];
}

/** Between, with a collision-resistant tail. */
export function keyBetween(a = '', b = '') {
  const k = between(a, b);
  const withTail = k + jitter();
  // The tail only lengthens k, so it stays above a; it must stay below b too.
  return !b || withTail < b ? withTail : k;
}

/** n keys spread evenly after a (or from the start). */
export function keysAfter(a = '', n = 1) {
  const keys = [];
  let prev = a;
  for (let i = 0; i < n; i++) {
    prev = keyBetween(prev, '');
    keys.push(prev);
  }
  return keys;
}

export function compareOrder(x, y) {
  const a = x.order || '';
  const b = y.order || '';
  if (a !== b) return a < b ? -1 : 1;
  return (x.id || '') < (y.id || '') ? -1 : (x.id || '') > (y.id || '') ? 1 : 0;
}

export { MID };

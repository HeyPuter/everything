export const MIN_NORMAL = 2 ** -1022;

/** Multiplication and division flush subnormal results, but addition and
 * some functions preserve them. Apply this only at the relevant operations.
 */
export function flushUnderflow(value) {
  return Math.abs(value) < MIN_NORMAL ? 0 : value;
}

/** Product aggregation seeds from the first number without multiplying it by
 * one: a single subnormal input survives, but subsequent products can underflow.
 */
export function product(values) {
  if (!values.length) return 0;
  let result = values[0];
  for (let i = 1; i < values.length; i++) result = flushUnderflow(result * values[i]);
  return result;
}

/** The largest of `values` and `floor`, as Math.max(floor, ...values) gives it (NaN included) without
 * spreading the values into arguments: a spread of some 125,000 or more overflows the call stack.
 */
export function maxOf(values, floor = -Infinity) {
  let result = floor;
  for (const v of values) result = Math.max(result, v);
  return result;
}

/** The smallest of `values` and `ceiling`, as Math.min(ceiling, ...values) gives it, without the spread. */
export function minOf(values, ceiling = Infinity) {
  let result = ceiling;
  for (const v of values) result = Math.min(result, v);
  return result;
}

/** Average two values without overflowing their sum or underflowing tiny halves. */
export function midpoint(a, b) {
  const total = a + b;
  return Number.isFinite(total) ? total / 2 : a / 2 + b / 2;
}

const bits = new DataView(new ArrayBuffer(8));
const fractionMask = (1n << 52n) - 1n;

/** Match native POWER domain checks and unary negation using the high 16-bit
 * word, including the sign. Positive subnormals below 2^-1026 therefore
 * take their zero branch; negative subnormals do not. This is not the zero
 * predicate for comparisons, addition, division, or other functions.
 */
export function hasZeroHighWord(value) {
  bits.setFloat64(0, value);
  return bits.getUint16(0) === 0;
}

/** The final + or - discards a residual whose stored binary exponent
 * is at least 50 below the left operand's (less than eight ULPs for normal
 * results). This is directional at powers of two. Subnormals share exponent
 * field zero: correction does not normalize them or use a subnormal epsilon.
 * Read the bits: log2 rounds values just below powers of two up.
 * Intermediate arithmetic keeps its residual.
 */
export function finalCancellation(left, result) {
  if (!Number.isFinite(result) || !left || !result) return result;
  bits.setFloat64(0, left);
  const leftExponent = (bits.getUint32(0) >>> 20) & 2047;
  bits.setFloat64(0, result);
  const resultExponent = (bits.getUint32(0) >>> 20) & 2047;
  return leftExponent - resultExponent >= 50 ? 0 : result;
}

/** A finite double as an integer multiple of the smallest positive double. */
function units(value) {
  bits.setFloat64(0, value);
  const raw = bits.getBigUint64(0);
  const exponent = Number((raw >> 52n) & 2047n);
  const fraction = raw & fractionMask;
  const magnitude = exponent ? (fraction | (1n << 52n)) << BigInt(exponent - 1) : fraction;
  return raw >> 63n ? -magnitude : magnitude;
}

/** Round an exact sum divided by a count, including subnormal values and ties. */
function divideUnits(total, count) {
  const negative = total < 0n;
  const magnitude = negative ? -total : total;
  const divisor = BigInt(count);
  const shift = Math.max(0, (magnitude / divisor).toString(2).length - 53);
  const step = divisor << BigInt(shift);
  let rounded = magnitude / step;
  const remainder = magnitude % step;
  if (2n * remainder > step || (2n * remainder === step && rounded % 2n)) rounded++;
  const value = Number(rounded) * 2 ** (shift - 1074);
  return negative ? -value : value;
}

/**
 * Keep ordinary averaging unchanged. If its sum overflowed, recover from
 * the original values exactly before division; scaling each value first
 * can erase small remainders after cancellation or still overflow.
 * `values` may be a lazy iterable: it is only read for an overflowing sum.
 */
export function meanFromSum(total, count, values) {
  if (!count || Number.isFinite(total)) return total / count;
  let exact = 0n;
  for (const value of values) {
    if (!Number.isFinite(value)) return total / count;
    exact += units(value);
  }
  return divideUnits(exact, count);
}

export function mean(values) {
  return meanFromSum(values.reduce((a, b) => a + b, 0), values.length, values);
}

/** Each squared deviation is a multiplication, so it can underflow before
 * the sum becomes large enough to be a normal number.
 */
export function squaredDeviations(values, center = mean(values)) {
  return values.reduce((total, value) => total + flushUnderflow((value - center) ** 2), 0);
}

/** Population variance by default; a correction of one gives sample variance.
 * Underflow occurs before square rooting this result for standard deviation.
 * Callers handle insufficient sample sizes and their own error conventions.
 */
export function variance(values, correction = 0, center = mean(values)) {
  return flushUnderflow(squaredDeviations(values, center) / (values.length - correction));
}

/** Recover a finite sum after intermediate overflow, using the original values. */
export function sumFromTotal(total, values) {
  return meanFromSum(total, 1, values);
}

export function sum(values) {
  return sumFromTotal(values.reduce((a, b) => a + b, 0), values);
}

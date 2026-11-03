import { invariant } from './errors.js';

export const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export const ID_PATTERN = /^[0-9abcdefghjkmnpqrstvwxyz]{16}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isId = (value) => typeof value === 'string' && ID_PATTERN.test(value);
export const isUuid = (value) => typeof value === 'string' && UUID_PATTERN.test(value);

function encode(value, length) {
  let result = '';
  for (let i = 0; i < length; i++) {
    result = ID_ALPHABET[Number(value & 31n)] + result;
    value >>= 5n;
  }
  invariant(value === 0n, 'id_overflow');
  return result;
}

export function createIdGenerator({ now = Date.now, random = (bytes) => crypto.getRandomValues(bytes) } = {}) {
  let lastTime = -1;
  let suffix = 0n;
  return () => {
    const time = now();
    invariant(Number.isSafeInteger(time) && time >= 0 && time < 2 ** 45, 'invalid_time');
    if (time > lastTime) {
      const bytes = random(new Uint8Array(5));
      invariant(bytes?.length === 5, 'invalid_random');
      suffix = bytes.reduce((n, byte) => (n << 8n) | BigInt(byte), 0n) & ((1n << 35n) - 1n);
      lastTime = time;
    } else {
      suffix += 1n;
      if (suffix === 1n << 35n) {
        suffix = 0n;
        lastTime += 1;
      }
    }
    return encode(BigInt(lastTime), 9) + encode(suffix, 7);
  };
}

export const newId = createIdGenerator();

import { invariant } from './errors.js';
import { isId, newId } from './ids.js';

const CLOCK = /^([0-9a-z]{10}):([0-9a-z]{6}):([0-9abcdefghjkmnpqrstvwxyz]{16})$/;
const MAX_COUNTER = 36 ** 6 - 1;

export function parseHlc(value) {
  invariant(typeof value === 'string' && CLOCK.test(value), 'invalid_version');
  const [, time, counter, node] = CLOCK.exec(value);
  return { time: parseInt(time, 36), counter: parseInt(counter, 36), node };
}

export function isHlc(value) {
  return typeof value === 'string' && CLOCK.test(value);
}

export function compareHlc(a, b) {
  parseHlc(a);
  parseHlc(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createClock({ node = newId(), now = Date.now } = {}) {
  invariant(isId(node), 'invalid_node');
  let time = 0;
  let counter = 0;
  return {
    tick(remote) {
      const wall = now();
      invariant(Number.isSafeInteger(wall) && wall >= 0 && wall < 36 ** 10, 'invalid_time');
      const other = remote === undefined ? { time: 0, counter: -1 } : parseHlc(remote);
      const next = Math.max(time, wall, other.time);
      if (next === time && next === other.time) counter = Math.max(counter, other.counter) + 1;
      else if (next === time) counter += 1;
      else if (next === other.time) counter = other.counter + 1;
      else counter = 0;
      time = next;
      if (counter > MAX_COUNTER) { time += 1; counter = 0; }
      invariant(time < 36 ** 10, 'clock_overflow');
      return `${time.toString(36).padStart(10, '0')}:${counter.toString(36).padStart(6, '0')}:${node}`;
    },
  };
}

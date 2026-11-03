import { s } from './dsl.js';
import * as f from './fields.js';
import { isDate } from '../dates.js';
import { isId, isUuid } from '../ids.js';

const o = s.optional;
// Shares, grants and invite records are keyed by a hash of the handle id, so handle ids never appear in keys.
const isHash = (key) => /^[0-9a-f]{32}$/.test(key);
const isYear = (key) => /^\d{4}$/.test(key);
const stamps = (key, max) => o(s.record(s.integer(0), key, max));
const mode = s.enum('fused', 'view');
const handle = s.string(256, { nonempty: true });

export const vacaySchemas = Object.freeze({
  plan: s.object({
    weekendDays: s.array(s.integer(0, 6), 7), weekStart: s.integer(0, 6),
    holidays: o(s.object({ country: f.short, region: o(f.short) })), school: o(s.object({ country: f.short, subdivision: o(f.short) })),
    carryOver: o(s.number(0, 1000)), yearType: s.enum('calendar', 'fiscal', 'hire'), startMonth: o(s.integer(1, 12)), startDay: o(s.integer(1, 31)), hireDate: o(f.date), color: o(f.color),
  }, { refine: (value) => new Set(value.weekendDays).size === value.weekendDays.length }),
  entry: s.object({ fraction: s.enum(1, 0.5), kind: s.enum('vacation', 'comp'), note: o(f.text) }),
  // `carried` absent: computed from the previous leave year.
  allowance: s.object({ days: s.number(0, 1000), carried: o(s.number(0, 1000)) }),
  company: s.object({ note: o(f.text) }),
  calendar: s.object({ type: f.short, region: o(f.short), label: f.name, color: o(f.color), periods: s.array(s.object({ start: f.date, end: f.date }), 1000) }),
  // Received shares; uuid keys are the earlier form.
  shares: s.record(s.object({ handle, mode, name: o(f.short), uid: o(f.uid), color: o(s.integer(1, 8)), at: o(s.integer(0)) }), (key) => isHash(key) || isUuid(key), 500),
  // `holder` is the username Puter returned when sharing (a uuid in earlier records); `uid` once known.
  grants: s.record(s.object({ handle, holder: f.short, uid: o(f.uid), mode, name: o(f.short), at: o(s.integer(0)) }), isHash, 500),
  invite: s.object({ mode, name: o(f.short), uid: o(f.uid), at: o(s.integer(0)), ack: o(s.string(64, { pattern: /^[0-9a-f]{64}$/ })) }),
  index: s.object({ e: stamps(isDate, 5000), company: stamps(isDate, 2000), allow: stamps(isYear, 200), cal: stamps(isId, 100), inv: stamps(isHash, 500) }),
});

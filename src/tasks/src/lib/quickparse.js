/**
 * Natural-language quick-add parser.
 *
 * Turns one typed line into a task draft: dates ("tomorrow", "next mon",
 * "aug 12", "2026-08-12"), times ("9am", "15:30", "at 9"), recurrence
 * ("every day", "every 2 weeks", "every mon,wed", "daily"), priority
 * ("!high", "!p1"), and a list ("#work"). Matched fragments come back as
 * tokens so the UI can show removable chips; anything unrecognized stays
 * in the title, never silently dropped. Matched types can be ignored
 * (chip dismissed) — their text returns to the title.
 *
 * English keywords only, by design: the full form remains for everything
 * else, and dates parse conservatively (no ambiguous "12/8").
 */

import { todayISO, addDays, nextWeekday, weekdayOf, pad2, daysInMonth } from './dates.js';
import { normalizeRule } from './recur.js';

const WD = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};
const WD_ALT = Object.keys(WD).sort((a, b) => b.length - a.length).join('|');

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

const PRIORITY = { high: 3, medium: 2, med: 2, low: 1, p1: 3, p2: 2, p3: 1, 1: 3, 2: 2, 3: 1 };

/* Every matcher's full match is blanked out of the working string; a
   trailing boundary keeps "mon" from eating into "monica". */
const B = String.raw`(?=[\s,.!?;]|$)`;

function monthDayISO(month, day, year, today) {
  const y = year || Number(today.slice(0, 4));
  const d = Math.min(day, daysInMonth(y, month));
  let iso = `${y}-${pad2(month)}-${pad2(d)}`;
  // "aug 12" typed in September means next August.
  if (!year && iso < today) iso = `${y + 1}-${pad2(month)}-${pad2(Math.min(day, daysInMonth(y + 1, month)))}`;
  return iso;
}

/** Where a freshly created rule starts: today if it qualifies, else next. */
export function initialDue(rule, today = todayISO()) {
  const norm = normalizeRule(rule);
  if (!norm) return null;
  if (norm.weekdays?.length) {
    return norm.weekdays.includes(weekdayOf(today)) ? today : nextWeekday(today, norm.weekdays.sort((a, b) => {
      // nearest upcoming of the chosen weekdays
      const dist = (d) => (d - weekdayOf(today) + 7) % 7 || 7;
      return dist(a) - dist(b);
    })[0]);
  }
  return today;
}

/**
 * parseQuickAdd('pay rent friday 9am !high #home', { lists, today })
 *   → { title, due, dueTime, priority, repeat, listId, tokens }
 * tokens: [{ type, key?, label, text }] in match order; `ignore` is a Set
 * of token keys to leave in the title (dismissed chips) — a token's key
 * defaults to its type; tags carry per-tag keys ('tag:home') so one
 * dismissal doesn't take every tag chip with it. `startMonday` mirrors the
 * user's week-start setting ("next week" lands on it).
 */
export function parseQuickAdd(text, { lists = [], today = todayISO(), ignore = new Set(), startMonday = true } = {}) {
  let work = String(text || '');
  const tokens = [];
  const out = { title: '', due: null, dueTime: null, priority: 0, repeat: null, listId: null, tags: [], tokens };

  const grab = (re, type, apply) => {
    if (ignore.has(type)) return false;
    const m = re.exec(work);
    if (!m) return false;
    const label = apply(m);
    if (label === false) return false; // matcher declined (e.g. unknown list)
    tokens.push({ type, label, text: m[0].trim() });
    work = work.slice(0, m.index) + ' '.repeat(m[0].length) + work.slice(m.index + m[0].length);
    return true;
  };

  /* --- recurrence (before dates: "every monday" is a rule, not a date) --- */

  grab(new RegExp(String.raw`(^|\s)every\s+(weekday|(?:${WD_ALT})(?:\s*,\s*(?:${WD_ALT}))*)${B}`, 'i'), 'repeat', (m) => {
    const days = m[2].toLowerCase() === 'weekday'
      ? [1, 2, 3, 4, 5]
      : m[2].toLowerCase().split(/\s*,\s*/).map((w) => WD[w]);
    out.repeat = normalizeRule({ freq: 'weekly', interval: 1, weekdays: days, mode: 'due' });
    return 'repeats';
  }) || grab(new RegExp(String.raw`(^|\s)every\s+(?:(\d+)\s+)?(day|week|month|year)s?(?:\s+on\s+((?:${WD_ALT})(?:\s*,\s*(?:${WD_ALT}))*))?${B}`, 'i'), 'repeat', (m) => {
    const rule = { freq: `${m[3].toLowerCase()}ly`, interval: Number(m[2]) || 1, mode: 'due' };
    if (rule.freq === 'dayly') rule.freq = 'daily';
    if (m[4]) {
      rule.freq = 'weekly';
      rule.weekdays = m[4].toLowerCase().split(/\s*,\s*/).map((w) => WD[w]);
    }
    out.repeat = normalizeRule(rule);
    return 'repeats';
  }) || grab(new RegExp(String.raw`(^|\s)(daily|weekly|monthly|yearly|annually)${B}`, 'i'), 'repeat', (m) => {
    const freq = { daily: 'daily', weekly: 'weekly', monthly: 'monthly', yearly: 'yearly', annually: 'yearly' }[m[2].toLowerCase()];
    out.repeat = normalizeRule({ freq, interval: 1, mode: 'due' });
    return 'repeats';
  });

  /* --- dates --- */

  // Years below 1000 are declined everywhere: '0099-05-05' hits the Date
  // constructor's two-digit-year remapping (1999), and 'aug 12 0099' would
  // mint the malformed ISO '99-08-12' — a chip showing a date the save
  // then silently drops.
  grab(new RegExp(String.raw`(^|\s)(\d{4})-(\d{2})-(\d{2})${B}`), 'due', (m) => {
    // "2026-13-45" is date-shaped but not a date; declining keeps the text.
    if (Number(m[2]) < 1000) return false;
    if (Number(m[3]) < 1 || Number(m[3]) > 12) return false;
    if (Number(m[4]) < 1 || Number(m[4]) > daysInMonth(Number(m[2]), Number(m[3]))) return false;
    out.due = `${m[2]}-${m[3]}-${m[4]}`;
    return out.due;
  })
    || grab(new RegExp(String.raw`(^|\s)(?:on\s+)?(${MONTH_ALT})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?${B}`, 'i'), 'due', (m) => {
      if (Number(m[3]) < 1) return false; // "aug 0" is not a date
      if (m[4] && Number(m[4]) < 1000) return false;
      out.due = monthDayISO(MONTHS[m[2].toLowerCase()], Number(m[3]), m[4] ? Number(m[4]) : null, today);
      return out.due;
    })
    || grab(new RegExp(String.raw`(^|\s)(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALT})(?:,?\s+(\d{4}))?${B}`, 'i'), 'due', (m) => {
      if (Number(m[2]) < 1) return false; // "0 aug" is not a date
      if (m[4] && Number(m[4]) < 1000) return false;
      out.due = monthDayISO(MONTHS[m[3].toLowerCase()], Number(m[2]), m[4] ? Number(m[4]) : null, today);
      return out.due;
    })
    || grab(new RegExp(String.raw`(^|\s)(today|tod|tonight)${B}`, 'i'), 'due', () => { out.due = today; return 'today'; })
    || grab(new RegExp(String.raw`(^|\s)(tomorrow|tmrw|tmr|tom)${B}`, 'i'), 'due', () => { out.due = addDays(today, 1); return 'tomorrow'; })
    || grab(new RegExp(String.raw`(^|\s)next\s+week${B}`, 'i'), 'due', () => { out.due = nextWeekday(today, startMonday ? 1 : 0); return 'next week'; })
    || grab(new RegExp(String.raw`(^|\s)next\s+(${WD_ALT})${B}`, 'i'), 'due', (m) => {
      out.due = nextWeekday(today, WD[m[2].toLowerCase()]);
      return out.due;
    })
    || grab(new RegExp(String.raw`(^|\s)(?:on\s+)?(${WD_ALT})${B}`, 'i'), 'due', (m) => {
      const wd = WD[m[2].toLowerCase()];
      out.due = weekdayOf(today) === wd ? today : nextWeekday(today, wd);
      return out.due;
    });

  /* --- time --- */

  grab(new RegExp(String.raw`(^|\s)(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)${B}`, 'i'), 'time', (m) => {
    const hour = Number(m[2]);
    if (hour < 1 || hour > 12) return false;
    let h = hour % 12;
    if (m[4].toLowerCase() === 'pm') h += 12;
    if (m[3] && Number(m[3]) > 59) return false; // "9:99am" is not a time
    out.dueTime = `${pad2(h)}:${m[3] || '00'}`;
    return out.dueTime;
  }) || grab(new RegExp(String.raw`(^|\s)(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)${B}`), 'time', (m) => {
    out.dueTime = `${pad2(Number(m[2]))}:${m[3]}`;
    return out.dueTime;
  }) || grab(new RegExp(String.raw`(^|\s)at\s+([01]?\d|2[0-3])${B}`, 'i'), 'time', (m) => {
    out.dueTime = `${pad2(Number(m[2]))}:00`;
    return out.dueTime;
  });

  /* --- priority --- */

  grab(new RegExp(String.raw`(^|\s)!(high|medium|med|low|p[123]|[123])${B}`, 'i'), 'priority', (m) => {
    out.priority = PRIORITY[m[2].toLowerCase()] || 0;
    return ['', 'Low', 'Medium', 'High'][out.priority];
  });

  /* --- #words: a matching list name wins, anything else is a tag --- */

  {
    const re = new RegExp(String.raw`(^|\s)#([\p{L}\p{N}_-]+)${B}`, 'giu');
    const blanks = [];
    let m;
    while ((m = re.exec(work))) {
      const word = m[2].toLowerCase();
      // The list check runs for every #word — a match must not be lost
      // just because five tags already filled the cap before it.
      const list = !out.listId && !ignore.has('list')
        ? (lists.find((l) => l.name.toLowerCase() === word)
          || lists.find((l) => l.name.toLowerCase().startsWith(word)))
        : null;
      if (list) {
        out.listId = list.id;
        tokens.push({ type: 'list', label: list.name, text: m[0].trim() });
        blanks.push([m.index, m[0].length]);
      } else if (!ignore.has('tag') && !ignore.has(`tag:${word}`)) {
        if (out.tags.includes(word)) {
          blanks.push([m.index, m[0].length]); // duplicate: its chip already stands
        } else if (out.tags.length < 5) {
          out.tags.push(word);
          tokens.push({ type: 'tag', key: `tag:${word}`, label: `#${word}`, text: m[0].trim() });
          blanks.push([m.index, m[0].length]);
        }
        // Past the cap: the text stays in the title, never silently dropped.
      }
    }
    for (const [i, len] of blanks) {
      work = work.slice(0, i) + ' '.repeat(len) + work.slice(i + len);
    }
  }

  /* --- derived defaults --- */

  // A rule needs an anchor date to roll from, and it must be applied
  // before the time default below: "gym every monday 9am" anchors to the
  // next Monday, not to "9am today" on a day the rule never selects.
  if (out.repeat && !out.due) out.due = initialDue(out.repeat, today);
  // A time means "that time today" unless a date or rule said otherwise.
  if (out.dueTime && !out.due) out.due = today;

  out.title = work.replace(/\s+/g, ' ').trim();
  return out;
}

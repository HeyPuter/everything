import { describe, it, expect } from 'vitest';
import { parseQuickAdd } from '../src/lib/quickparse.js';

const TODAY = '2026-08-04'; // a Tuesday
const lists = [
  { id: 'l-work', name: 'Work' },
  { id: 'l-home', name: 'Household' },
];
const parse = (text, opts = {}) => parseQuickAdd(text, { lists, today: TODAY, ...opts });

describe('dates', () => {
  it('understands relative words', () => {
    expect(parse('call mom today').due).toBe('2026-08-04');
    expect(parse('call mom tomorrow').due).toBe('2026-08-05');
    expect(parse('call mom tmr').due).toBe('2026-08-05');
    expect(parse('call mom next week').due).toBe('2026-08-10'); // Monday
  });

  it('"next week" respects the week-start setting', () => {
    expect(parse('plan sprint next week', { startMonday: true }).due).toBe('2026-08-10'); // Monday
    expect(parse('plan sprint next week', { startMonday: false }).due).toBe('2026-08-09'); // Sunday
  });

  it('weekday names pick the upcoming occurrence (today counts)', () => {
    expect(parse('gym friday').due).toBe('2026-08-07');
    expect(parse('gym tuesday').due).toBe('2026-08-04'); // today is Tuesday
    expect(parse('gym next tuesday').due).toBe('2026-08-11'); // strictly after
    expect(parse('gym on wed').due).toBe('2026-08-05');
  });

  it('explicit dates, with past month-days rolling to next year', () => {
    expect(parse('renew passport aug 12').due).toBe('2026-08-12');
    expect(parse('renew passport 12 aug').due).toBe('2026-08-12');
    expect(parse('renew passport august 3rd').due).toBe('2027-08-03'); // already past
    expect(parse('renew passport jan 5 2027').due).toBe('2027-01-05');
    expect(parse('renew passport 2026-12-24').due).toBe('2026-12-24');
  });

  it('extracts the date out of the title', () => {
    const p = parse('pay rent friday');
    expect(p.title).toBe('pay rent');
    expect(p.tokens.map((t) => t.type)).toContain('due');
  });

  it('does not fire inside words', () => {
    expect(parse('call monica').due).toBeNull();
    expect(parse('call monica').title).toBe('call monica');
    expect(parse('buy saturn poster').due).toBeNull();
  });

  it('rejects impossible dates and keeps them in the title', () => {
    const p = parse('pay bill 2026-13-45');
    expect(p.due).toBeNull();
    expect(p.title).toBe('pay bill 2026-13-45');
    expect(parse('audit 2026-02-30').due).toBeNull();
    expect(parse('audit 2028-02-29').due).toBe('2028-02-29'); // leap day is real
    expect(parse('meet aug 0').due).toBeNull();
    expect(parse('meet 0 aug').due).toBeNull();
    // Overshooting month-days still clamp to the month's length.
    expect(parse('rent feb 31').due).toBe('2027-02-28');
  });

  it('declines years below 1000 instead of minting garbage', () => {
    // '0099-05-05' would remap to 1999 in the Date constructor…
    const iso = parse('pay tithe 0099-05-05');
    expect(iso.due).toBeNull();
    expect(iso.title).toBe('pay tithe 0099-05-05');
    // …and 'aug 12 0099' used to mint the malformed ISO '99-08-12' —
    // a chip showing a date that the save then silently dropped.
    const spelled = parse('crusade aug 12 0099');
    expect(spelled.due).toBeNull();
    expect(spelled.title).toBe('crusade aug 12 0099');
    expect(parse('launch aug 12 2199').due).toBe('2199-08-12');
  });
});

describe('times', () => {
  it('parses am/pm, 24h, and "at H"', () => {
    expect(parse('standup 9am').dueTime).toBe('09:00');
    expect(parse('dinner 7:30pm').dueTime).toBe('19:30');
    expect(parse('review 15:30').dueTime).toBe('15:30');
    expect(parse('call at 9').dueTime).toBe('09:00');
    expect(parse('call at 21').dueTime).toBe('21:00');
  });

  it('a bare time implies today', () => {
    const p = parse('standup 9am');
    expect(p.due).toBe('2026-08-04');
  });

  it('rejects impossible times and keeps them in the title', () => {
    const p = parse('meet 9:99am');
    expect(p.dueTime).toBeNull();
    expect(p.title).toBe('meet 9:99am');
    expect(parse('lunch 13pm').dueTime).toBeNull();
    expect(parse('lunch 0pm').dueTime).toBeNull();
    expect(parse('meet 0am').dueTime).toBeNull();
    expect(parse('call 0:30am').dueTime).toBeNull();
    expect(parse('meet 0am').title).toBe('meet 0am');
  });

  it('combines date and time', () => {
    const p = parse('dentist tomorrow 14:00');
    expect(p.due).toBe('2026-08-05');
    expect(p.dueTime).toBe('14:00');
    expect(p.title).toBe('dentist');
  });
});

describe('recurrence', () => {
  it('parses simple and interval rules', () => {
    expect(parse('water plants every day').repeat).toEqual({ freq: 'daily', interval: 1, mode: 'due' });
    expect(parse('review every 2 weeks').repeat).toEqual({ freq: 'weekly', interval: 2, mode: 'due' });
    expect(parse('backup monthly').repeat).toEqual({ freq: 'monthly', interval: 1, mode: 'due' });
  });

  it('parses weekday rules and anchors the first due date', () => {
    const p = parse('trash every mon,thu');
    expect(p.repeat).toEqual({ freq: 'weekly', interval: 1, mode: 'due', weekdays: [1, 4] });
    expect(p.due).toBe('2026-08-06'); // Thursday is the nearest of Mon/Thu after Tue
    expect(parse('standup every weekday').repeat.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(parse('sync every 2 weeks on fri').repeat).toEqual({ freq: 'weekly', interval: 2, mode: 'due', weekdays: [5] });
  });

  it('"every monday" is a rule, not a date', () => {
    const p = parse('gym every monday');
    expect(p.repeat.weekdays).toEqual([1]);
    expect(p.due).toBe('2026-08-10');
    expect(p.title).toBe('gym');
  });

  it('"every day" anchors to today', () => {
    expect(parse('stretch every day').due).toBe('2026-08-04');
  });

  it('a time token does not steal the anchor from a weekday rule', () => {
    const p = parse('gym every monday 9am');
    expect(p.repeat.weekdays).toEqual([1]);
    expect(p.dueTime).toBe('09:00');
    expect(p.due).toBe('2026-08-10'); // next Monday, not "9am today" (a Tuesday)
  });
});

describe('priority and list', () => {
  it('parses priority spellings', () => {
    expect(parse('fix bug !high').priority).toBe(3);
    expect(parse('fix bug !p1').priority).toBe(3);
    expect(parse('fix bug !med').priority).toBe(2);
    expect(parse('fix bug !low').priority).toBe(1);
    expect(parse('fix bug !3').priority).toBe(1);
  });

  it('matches lists by name or prefix, case-insensitively', () => {
    expect(parse('send report #work').listId).toBe('l-work');
    expect(parse('buy soap #house').listId).toBe('l-home');
    expect(parse('send report #work').title).toBe('send report');
  });

  it('#words that match no list become tags', () => {
    const p = parse('read #someday');
    expect(p.listId).toBeNull();
    expect(p.tags).toEqual(['someday']);
    expect(p.title).toBe('read');
  });

  it('mixes one list with several tags', () => {
    const p = parse('fix sink #house #urgent #diy');
    expect(p.listId).toBe('l-home');
    expect(p.tags).toEqual(['urgent', 'diy']);
    expect(p.title).toBe('fix sink');
  });

  it('ignoring tags returns them to the title', () => {
    const p = parse('read #someday', { ignore: new Set(['tag']) });
    expect(p.tags).toEqual([]);
    expect(p.title).toBe('read #someday');
  });

  it('dismissing one tag leaves the others standing', () => {
    const p = parse('fix sink #urgent #diy', { ignore: new Set(['tag:urgent']) });
    expect(p.tags).toEqual(['diy']);
    expect(p.title).toBe('fix sink #urgent');
    expect(p.tokens.find((t) => t.type === 'tag').key).toBe('tag:diy');
  });

  it('absorbs duplicate tags into one chip', () => {
    const p = parse('read #a #a');
    expect(p.tags).toEqual(['a']);
    expect(p.tokens.filter((t) => t.type === 'tag')).toHaveLength(1);
    expect(p.title).toBe('read');
  });

  it('a list name after five tags still routes the task', () => {
    const p = parse('do it #t1 #t2 #t3 #t4 #t5 #work');
    expect(p.listId).toBe('l-work');
    expect(p.tags).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(p.title).toBe('do it');
  });

  it('tags past the cap stay visible in the title', () => {
    const p = parse('do it #t1 #t2 #t3 #t4 #t5 #t6');
    expect(p.tags).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(p.title).toBe('do it #t6');
  });
});

describe('composition and chips', () => {
  it('parses the kitchen sink', () => {
    const p = parse('pay rent friday 9am every month !high #house');
    expect(p.title).toBe('pay rent');
    expect(p.due).toBe('2026-08-07');
    expect(p.dueTime).toBe('09:00');
    expect(p.repeat).toEqual({ freq: 'monthly', interval: 1, mode: 'due' });
    expect(p.priority).toBe(3);
    expect(p.listId).toBe('l-home');
    expect(p.tokens.map((t) => t.type).sort()).toEqual(['due', 'list', 'priority', 'repeat', 'time']);
  });

  it('ignored types return their text to the title', () => {
    const p = parse('pay rent friday !high', { ignore: new Set(['due']) });
    expect(p.due).toBeNull();
    expect(p.title).toBe('pay rent friday');
    expect(p.priority).toBe(3);
  });

  it('never drops unrecognized text', () => {
    const p = parse('weird !urgency on the 32nd of nevermber');
    expect(p.title).toBe('weird !urgency on the 32nd of nevermber');
    expect(p.due).toBeNull();
    expect(p.priority).toBe(0);
  });
});

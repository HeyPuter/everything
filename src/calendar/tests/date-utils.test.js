import { describe, it, expect } from 'vitest';
import {
  addDays,
  addWeeks,
  addMonths,
  addYears,
  addMinutes,
  daysInMonth,
  startOfDay,
  minutesIntoDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  isSameDay,
  isSameMonth,
  isToday,
  isWeekend,
  diffCalendarDays,
  getMonthGrid,
  getWeekDays,
  isoWeekNumber,
  displayedWeekNumber,
  orderedWeekdays,
  minutesSinceMidnight,
  formatTime,
  formatTimeRange,
  formatHourLabel,
  formatMonthYear,
  formatWeekRange,
  formatDayTitle,
  toDateInputValue,
  toTimeInputValue,
  fromDateTimeInputs,
  roundToNearestMinutes,
  isValidTimeZone,
  formatTimeInZone,
  zonedTimeToUTC,
  tzLabel,
  tzCityLabel,
  tzOffsetMinutes,
  tzOffsetLabel,
  tzPickerGroups,
} from '../src/js/date-utils.js';

// 2026-07-12 is a Sunday (matches the app's "today").
const SUN = new Date(2026, 6, 12, 10, 30, 0);

describe('arithmetic', () => {
  it('adds days across a month boundary', () => {
    expect(isSameDay(addDays(new Date(2026, 6, 31), 1), new Date(2026, 7, 1))).toBe(true);
  });

  it('adds weeks', () => {
    expect(isSameDay(addWeeks(SUN, 1), new Date(2026, 6, 19))).toBe(true);
  });

  it('clamps addMonths to the last valid day', () => {
    // Jan 31 + 1 month -> Feb 28 (2026 is not a leap year)
    const r = addMonths(new Date(2026, 0, 31), 1);
    expect(r.getMonth()).toBe(1);
    expect(r.getDate()).toBe(28);
  });

  it('addMonths handles year rollover', () => {
    const r = addMonths(new Date(2026, 11, 15), 1);
    expect(r.getFullYear()).toBe(2027);
    expect(r.getMonth()).toBe(0);
  });

  it('addMinutes adds real minutes', () => {
    expect(addMinutes(new Date(2026, 6, 12, 10, 0), 90).getHours()).toBe(11);
  });

  it('clamps addYears from a leap day to Feb 28 in a non-leap year', () => {
    const r = addYears(new Date(2024, 1, 29), 1); // Feb 29, 2024 + 1yr
    expect(r.getFullYear()).toBe(2025);
    expect(r.getMonth()).toBe(1);
    expect(r.getDate()).toBe(28);
  });

  it('addYears keeps Feb 29 when landing on another leap year', () => {
    const r = addYears(new Date(2024, 1, 29), 4); // 2028 is a leap year
    expect(r.getFullYear()).toBe(2028);
    expect(r.getMonth()).toBe(1);
    expect(r.getDate()).toBe(29);
  });

  it('daysInMonth', () => {
    expect(daysInMonth(2026, 1)).toBe(28); // Feb 2026
    expect(daysInMonth(2024, 1)).toBe(29); // Feb 2024 (leap)
    expect(daysInMonth(2026, 3)).toBe(30); // Apr
  });

  it('does not mutate its input', () => {
    const d = new Date(2026, 6, 12);
    addDays(d, 5);
    expect(d.getDate()).toBe(12);
  });
});

describe('boundaries', () => {
  it('startOfDay / endOfDay', () => {
    const s = startOfDay(SUN);
    expect([s.getHours(), s.getMinutes(), s.getSeconds(), s.getMilliseconds()]).toEqual([0, 0, 0, 0]);
    const e = endOfDay(SUN);
    expect([e.getHours(), e.getMinutes(), e.getSeconds(), e.getMilliseconds()]).toEqual([23, 59, 59, 999]);
  });

  it('startOfWeek respects Sunday start', () => {
    expect(isSameDay(startOfWeek(SUN, 0), new Date(2026, 6, 12))).toBe(true);
  });

  it('startOfWeek respects Monday start', () => {
    // The Monday-anchored week containing Sun Jul 12 begins Mon Jul 6.
    expect(isSameDay(startOfWeek(SUN, 1), new Date(2026, 6, 6))).toBe(true);
  });

  it('endOfWeek is six days after the start', () => {
    expect(isSameDay(endOfWeek(SUN, 0), new Date(2026, 6, 18))).toBe(true);
  });

  it('startOfMonth / endOfMonth', () => {
    expect(isSameDay(startOfMonth(SUN), new Date(2026, 6, 1))).toBe(true);
    expect(isSameDay(endOfMonth(SUN), new Date(2026, 6, 31))).toBe(true);
  });
});

describe('comparisons', () => {
  it('isSameDay / isSameMonth', () => {
    expect(isSameDay(new Date(2026, 6, 12, 1), new Date(2026, 6, 12, 23))).toBe(true);
    expect(isSameDay(new Date(2026, 6, 12), new Date(2026, 6, 13))).toBe(false);
    expect(isSameMonth(new Date(2026, 6, 1), new Date(2026, 6, 31))).toBe(true);
    expect(isSameMonth(new Date(2026, 6, 31), new Date(2026, 7, 1))).toBe(false);
  });

  it('isToday', () => {
    const now = new Date(2026, 6, 12, 9, 0);
    expect(isToday(new Date(2026, 6, 12, 20, 0), now)).toBe(true);
    expect(isToday(new Date(2026, 6, 13), now)).toBe(false);
  });

  it('isWeekend', () => {
    expect(isWeekend(new Date(2026, 6, 12))).toBe(true); // Sunday
    expect(isWeekend(new Date(2026, 6, 18))).toBe(true); // Saturday
    expect(isWeekend(new Date(2026, 6, 15))).toBe(false); // Wednesday
  });

  it('diffCalendarDays ignores time of day', () => {
    expect(diffCalendarDays(new Date(2026, 6, 12, 23), new Date(2026, 6, 15, 1))).toBe(3);
    expect(diffCalendarDays(new Date(2026, 6, 15), new Date(2026, 6, 12))).toBe(-3);
  });
});

describe('ranges', () => {
  it('getMonthGrid snaps to whole weeks and covers the month', () => {
    const grid = getMonthGrid(SUN, 0);
    expect(grid.length % 7).toBe(0);
    expect(grid.length).toBe(35); // July 2026 fits in five weeks
    expect(isSameDay(grid[0], new Date(2026, 5, 28))).toBe(true); // Sun Jun 28
    expect(grid.some((d) => isSameDay(d, new Date(2026, 6, 1)))).toBe(true);
    expect(grid.some((d) => isSameDay(d, new Date(2026, 6, 31)))).toBe(true);
    // First cell must land on the configured week-start.
    expect(grid[0].getDay()).toBe(0);
  });

  it('getMonthGrid with Monday start begins on Monday', () => {
    const grid = getMonthGrid(SUN, 1);
    expect(grid[0].getDay()).toBe(1);
  });

  it('getWeekDays returns seven consecutive days', () => {
    const days = getWeekDays(SUN, 0);
    expect(days).toHaveLength(7);
    expect(days[0].getDay()).toBe(0);
    expect(days[6].getDay()).toBe(6);
  });

  it('orderedWeekdays rotates by week start', () => {
    expect(orderedWeekdays(0)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(orderedWeekdays(1)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it('orderedWeekdays coerces a stringy week start instead of concatenating', () => {
    // A malformed persisted "1" must not become ("1"+0)%7 === 3 (Wed-first).
    expect(orderedWeekdays('1')).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(orderedWeekdays('0')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(orderedWeekdays(undefined)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('minutesSinceMidnight', () => {
    expect(minutesSinceMidnight(new Date(2026, 6, 12, 0, 0))).toBe(0);
    expect(minutesSinceMidnight(new Date(2026, 6, 12, 9, 30))).toBe(570);
    expect(minutesSinceMidnight(new Date(2026, 6, 12, 23, 59))).toBe(1439);
  });
});

describe('ISO week numbers', () => {
  it('week 1 is the week containing the first Thursday', () => {
    // 1 Jan 2026 is a Thursday, so it is week 1.
    expect(isoWeekNumber(new Date(2026, 0, 1))).toBe(1);
    // That week's Monday is still week 1, even though it sits in 2025.
    expect(isoWeekNumber(new Date(2025, 11, 29))).toBe(1);
  });

  it('a late December day can belong to week 1 of the next year', () => {
    expect(isoWeekNumber(new Date(2025, 11, 29))).toBe(1); // Mon, week 1 of 2026
    expect(isoWeekNumber(new Date(2025, 11, 28))).toBe(52); // Sun, last week of 2025
  });

  it('a 53-week year keeps 1 Jan of the next year in week 53', () => {
    // 2020 has 53 ISO weeks; 1 Jan 2021 is a Friday in week 53 of 2020.
    expect(isoWeekNumber(new Date(2020, 11, 31))).toBe(53);
    expect(isoWeekNumber(new Date(2021, 0, 1))).toBe(53);
    expect(isoWeekNumber(new Date(2021, 0, 4))).toBe(1); // Monday, week 1 of 2021
  });

  it('mid-year Thursdays land on the expected week', () => {
    // 16 Jul 2026 is a Thursday, 28 weeks after 1 Jan (also a Thursday) → week 29.
    expect(isoWeekNumber(new Date(2026, 6, 16))).toBe(29);
    expect(isoWeekNumber(new Date(2026, 6, 12, 23, 59))).toBe(28); // Sun of the previous ISO week
  });

  it('does not mutate its input', () => {
    const d = new Date(2026, 6, 12, 10, 30);
    isoWeekNumber(d);
    expect(d.getDate()).toBe(12);
    expect(d.getHours()).toBe(10);
  });

  it('displayedWeekNumber uses the Thursday of the shown 7-day row', () => {
    // Sunday-start row 12–18 Jul 2026: Thursday is the 16th → week 29.
    expect(displayedWeekNumber(new Date(2026, 6, 12))).toBe(29);
    // Monday-start row 6–12 Jul 2026: Thursday is the 9th → week 28.
    expect(displayedWeekNumber(new Date(2026, 6, 6))).toBe(28);
    // Sunday-start row 28 Dec 2025 – 3 Jan 2026: Thursday is 1 Jan → week 1 of 2026.
    expect(displayedWeekNumber(new Date(2025, 11, 28))).toBe(1);
  });
});

describe('formatting', () => {
  // A 12-hour time joins its AM/PM with U+00A0, so no box narrow enough can
  // break "3 PM" into "3" over "PM". Spelled as an escape here because the
  // character is invisible in source — and it is the thing under test.
  const NBSP = '\u00a0';

  it('formatTime 12-hour edge cases', () => {
    expect(formatTime(new Date(2026, 6, 12, 0, 0))).toBe(`12${NBSP}AM`);
    expect(formatTime(new Date(2026, 6, 12, 12, 0))).toBe(`12${NBSP}PM`);
    expect(formatTime(new Date(2026, 6, 12, 9, 5))).toBe(`9:05${NBSP}AM`);
    expect(formatTime(new Date(2026, 6, 12, 13, 0))).toBe(`1${NBSP}PM`);
    expect(formatTime(new Date(2026, 6, 12, 23, 45))).toBe(`11:45${NBSP}PM`);
  });

  it('never leaves a plain space for a line breaker to split a time on', () => {
    expect(formatTime(new Date(2026, 6, 12, 15, 0))).not.toContain(' ');
    expect(formatHourLabel(15)).not.toContain(' ');
    // A range may wrap at its dash — that reads fine — but not inside either end.
    expect(
      formatTimeRange(new Date(2026, 6, 12, 15, 0), new Date(2026, 6, 12, 15, 30)),
    ).toBe(`3${NBSP}PM – 3:30${NBSP}PM`);
  });

  it('formatTime 24-hour', () => {
    expect(formatTime(new Date(2026, 6, 12, 9, 5), { hour12: false })).toBe('09:05');
    expect(formatTime(new Date(2026, 6, 12, 0, 0), { hour12: false })).toBe('00:00');
  });

  it('formatHourLabel', () => {
    expect(formatHourLabel(0)).toBe(`12${NBSP}AM`);
    expect(formatHourLabel(13)).toBe(`1${NBSP}PM`);
    expect(formatHourLabel(13, { hour12: false })).toBe('13:00');
  });

  it('formatMonthYear', () => {
    expect(formatMonthYear(SUN)).toBe('July 2026');
  });

  it('formatWeekRange within one month', () => {
    expect(formatWeekRange(SUN, 0)).toBe('Jul 12 – 18, 2026');
  });

  it('formatWeekRange across months', () => {
    expect(formatWeekRange(new Date(2026, 5, 30), 0)).toBe('Jun 28 – Jul 4, 2026');
  });

  it('formatWeekRange across years', () => {
    expect(formatWeekRange(new Date(2026, 11, 30), 0)).toBe('Dec 27, 2026 – Jan 2, 2027');
  });

  it('formatDayTitle', () => {
    expect(formatDayTitle(SUN)).toBe('Sunday, July 12');
  });
});

describe('input bridges', () => {
  it('toDateInputValue pads correctly', () => {
    expect(toDateInputValue(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(toDateInputValue(new Date(2026, 6, 12))).toBe('2026-07-12');
  });

  it('toTimeInputValue pads correctly', () => {
    expect(toTimeInputValue(new Date(2026, 6, 12, 9, 5))).toBe('09:05');
    expect(toTimeInputValue(new Date(2026, 6, 12, 18, 0))).toBe('18:00');
  });

  it('fromDateTimeInputs round-trips', () => {
    const d = fromDateTimeInputs('2026-07-12', '14:30');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6);
    expect(d.getDate()).toBe(12);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });

  it('fromDateTimeInputs defaults time to midnight', () => {
    const d = fromDateTimeInputs('2026-07-12');
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it('date <input> values round-trip through fromDateTimeInputs', () => {
    const original = new Date(2026, 2, 9, 7, 45);
    const restored = fromDateTimeInputs(toDateInputValue(original), toTimeInputValue(original));
    expect(restored.getTime()).toBe(original.getTime());
  });

});

describe('roundToNearestMinutes', () => {
  it('rounds to the nearest 30 minutes', () => {
    expect(toTimeInputValue(roundToNearestMinutes(new Date(2026, 6, 12, 9, 10), 30))).toBe('09:00');
    expect(toTimeInputValue(roundToNearestMinutes(new Date(2026, 6, 12, 9, 20), 30))).toBe('09:30');
    expect(toTimeInputValue(roundToNearestMinutes(new Date(2026, 6, 12, 9, 45), 30))).toBe('10:00');
  });

  it('clamps within the same day instead of rolling past midnight', () => {
    // A time in the final half-hour would round up to 24:00 and spill onto the
    // next calendar day; it must stay on the input's day (used as the default
    // start for New event / New task).
    const late = roundToNearestMinutes(new Date(2026, 6, 12, 23, 50), 30);
    expect(late.getDate()).toBe(12);
    expect(toTimeInputValue(late)).toBe('23:30');
    const edge = roundToNearestMinutes(new Date(2026, 6, 12, 23, 45), 30);
    expect(edge.getDate()).toBe(12);
    expect(toTimeInputValue(edge)).toBe('23:30');
  });
});

describe('minutesIntoDay (DST-at-midnight safety)', () => {
  it('holds the wall clock on a day whose midnight does not exist', () => {
    // Chile's spring-forward lands AT midnight: on 2022-09-11 (a fixed,
    // historical transition) clocks jumped 00:00 -> 01:00 in Santiago, so
    // startOfDay can only land on 01:00. Building times off that with a bare
    // setMinutes shifted the whole day one hour; minutesIntoDay must not.
    const savedTZ = process.env.TZ;
    process.env.TZ = 'America/Santiago';
    try {
      const day = new Date(2022, 8, 11, 12, 0);
      expect(startOfDay(day).getHours()).toBe(1); // the trap this guards against
      const at = minutesIntoDay(day, 10 * 60 + 30);
      expect(at.getHours()).toBe(10);
      expect(at.getMinutes()).toBe(30);
      expect(at.getDate()).toBe(11);
      // …and the callers that delegate to it: rounding stays on the wall clock.
      const rounded = roundToNearestMinutes(new Date(2022, 8, 11, 10, 20), 30);
      expect(rounded.getHours()).toBe(10);
      expect(rounded.getMinutes()).toBe(30);
    } finally {
      // Restore precisely: assigning `undefined` would set TZ to "undefined" (→UTC).
      if (savedTZ === undefined) delete process.env.TZ;
      else process.env.TZ = savedTZ;
    }
  });

  it('is a plain minutes offset on ordinary days', () => {
    const at = minutesIntoDay(new Date(2026, 6, 12, 17, 45), 9 * 60 + 15);
    expect(toTimeInputValue(at)).toBe('09:15');
    expect(at.getDate()).toBe(12);
  });
});

describe('time zones (secondary-zone display)', () => {
  it('isValidTimeZone accepts real IANA ids and rejects junk', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
  });

  it('formatTimeInZone converts an instant to that zone, matching formatTime style', () => {
    const utcNoon = Date.UTC(2026, 0, 15, 12, 0); // Jan (New York = EST, UTC-5)
    expect(formatTimeInZone(utcNoon, 'UTC', { hour12: true })).toBe('12\u00a0PM');
    expect(formatTimeInZone(utcNoon, 'America/New_York', { hour12: true })).toBe('7\u00a0AM');
    expect(formatTimeInZone(utcNoon, 'America/New_York', { hour12: false })).toBe('07:00');
  });

  it('formatTimeInZone handles fractional offsets and shows minutes', () => {
    // Kolkata is UTC+5:30.
    expect(formatTimeInZone(Date.UTC(2026, 0, 15, 12, 0), 'Asia/Kolkata', { hour12: true })).toBe(
      '5:30\u00a0PM',
    );
    expect(formatTimeInZone(Date.UTC(2026, 0, 15, 12, 30), 'Asia/Kolkata', { hour12: true })).toBe(
      '6\u00a0PM',
    );
  });

  it('formatTimeInZone returns empty string for an invalid zone', () => {
    expect(formatTimeInZone(Date.now(), 'Bad/Zone')).toBe('');
  });

  it('zonedTimeToUTC recovers the instant from a zone wall-clock', () => {
    // 09:00 in New York on 2026-07-13 (EDT, UTC-4) → 13:00 UTC.
    expect(zonedTimeToUTC(2026, 6, 13, 9, 0, 0, 'America/New_York')).toBe(Date.UTC(2026, 6, 13, 13, 0, 0));
    // 09:00 in New York on 2026-01-13 (EST, UTC-5) → 14:00 UTC.
    expect(zonedTimeToUTC(2026, 0, 13, 9, 0, 0, 'America/New_York')).toBe(Date.UTC(2026, 0, 13, 14, 0, 0));
    // Fractional offset: 09:00 Kolkata (UTC+5:30) → 03:30 UTC.
    expect(zonedTimeToUTC(2026, 6, 13, 9, 0, 0, 'Asia/Kolkata')).toBe(Date.UTC(2026, 6, 13, 3, 30, 0));
    // UTC is identity.
    expect(zonedTimeToUTC(2026, 6, 13, 9, 0, 0, 'UTC')).toBe(Date.UTC(2026, 6, 13, 9, 0, 0));
    // Invalid zone → NaN.
    expect(Number.isNaN(zonedTimeToUTC(2026, 6, 13, 9, 0, 0, 'Bad/Zone'))).toBe(true);
  });

  it('zonedTimeToUTC lands on the asked-for wall clock across a DST change', () => {
    const wall = (ms, tz) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(ms));
    // The hours a single offset pass slid: the guess (wall clock read as UTC)
    // falls on the other side of the transition from the answer.
    // 2027-03-14 is the US spring forward, 2027-11-07 the fall back.
    expect(wall(zonedTimeToUTC(2027, 2, 14, 9, 0, 0, 'America/Los_Angeles'), 'America/Los_Angeles'))
      .toBe('2027-03-14, 09:00');
    expect(wall(zonedTimeToUTC(2027, 10, 7, 7, 0, 0, 'America/Los_Angeles'), 'America/Los_Angeles'))
      .toBe('2027-11-07, 07:00');
    expect(wall(zonedTimeToUTC(2027, 2, 28, 1, 0, 0, 'Europe/Berlin'), 'Europe/Berlin'))
      .toBe('2027-03-28, 01:00');
    expect(wall(zonedTimeToUTC(2027, 3, 4, 0, 0, 0, 'Australia/Sydney'), 'Australia/Sydney'))
      .toBe('2027-04-04, 00:00');
    // A nonexistent wall clock (02:00 on the spring-forward day) resolves
    // forward to the instant the clock jumped to, not an hour past it.
    expect(wall(zonedTimeToUTC(2027, 2, 14, 2, 0, 0, 'America/New_York'), 'America/New_York'))
      .toBe('2027-03-14, 03:00');
  });

  it('tzLabel prettifies an IANA id', () => {
    expect(tzLabel('America/New_York')).toBe('New York');
    expect(tzLabel('UTC')).toBe('UTC');
    expect(tzLabel('Asia/Kolkata')).toBe('Kolkata');
  });

  it('tzCityLabel puts the city first and sub-regions after', () => {
    expect(tzCityLabel('America/New_York')).toBe('New York');
    expect(tzCityLabel('America/North_Dakota/New_Salem')).toBe('New Salem, North Dakota');
    expect(tzCityLabel('America/Argentina/Buenos_Aires')).toBe('Buenos Aires, Argentina');
    expect(tzCityLabel('UTC')).toBe('UTC');
  });

  it('tzOffsetMinutes tracks DST at the given instant', () => {
    expect(tzOffsetMinutes('UTC', SUN)).toBe(0);
    expect(tzOffsetMinutes('America/New_York', new Date(2026, 6, 12))).toBe(-240); // EDT
    expect(tzOffsetMinutes('America/New_York', new Date(2026, 0, 12))).toBe(-300); // EST
    expect(tzOffsetMinutes('Asia/Kolkata', SUN)).toBe(330);
    expect(tzOffsetMinutes('Asia/Kathmandu', SUN)).toBe(345);
    expect(tzOffsetMinutes('Not/A_Zone', SUN)).toBeNaN();
  });

  it('tzOffsetLabel renders compact GMT offsets', () => {
    expect(tzOffsetLabel(0)).toBe('GMT+0');
    expect(tzOffsetLabel(-420)).toBe('GMT-7');
    expect(tzOffsetLabel(330)).toBe('GMT+5:30');
    expect(tzOffsetLabel(345)).toBe('GMT+5:45');
    expect(tzOffsetLabel(NaN)).toBe('');
  });

  it('tzPickerGroups groups every zone by region, cities A-Z', () => {
    const groups = tzPickerGroups();
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    expect(labels).toContain('Americas');
    expect(labels).not.toContain('Arctic'); // folded into Europe

    const europe = groups.find((g) => g.label === 'Europe');
    expect(europe.zones.some((z) => z.id === 'Arctic/Longyearbyen')).toBe(true);

    const americas = groups.find((g) => g.label === 'Americas');
    const ny = americas.zones.find((z) => z.id === 'America/New_York');
    expect(ny.city).toBe('New York');
    expect(Number.isFinite(ny.offset)).toBe(true);
    const cities = americas.zones.map((z) => z.city);
    expect(cities).toEqual([...cities].sort((a, b) => a.localeCompare(b)));

    // UTC is pinned by the picker itself, never duplicated inside a group.
    expect(groups.every((g) => g.zones.every((z) => z.id !== 'UTC'))).toBe(true);
  });

  it('tzPickerGroups merges in a valid selected zone the list lacks', () => {
    const withOrphan = tzPickerGroups('Etc/GMT+5');
    expect(withOrphan.some((g) => g.zones.some((z) => z.id === 'Etc/GMT+5'))).toBe(true);
    // ...without polluting the cached list for later calls.
    const clean = tzPickerGroups();
    expect(clean.some((g) => g.zones.some((z) => z.id === 'Etc/GMT+5'))).toBe(false);
  });
});

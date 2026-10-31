import { el, uid } from './dom.js';
import { field } from './fields.js';
import { iconButton } from './bits.js';
import { t, locale } from '../lib/i18n/index.js';
import { localDate as today } from '../shared/dates.js';

function parse(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return null;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}
const iso = (date) => date.toISOString().slice(0, 10);
function shift(date, days) { const result = new Date(date); result.setUTCDate(result.getUTCDate() + days); return result; }
function monthStart(date) { const result = new Date(date); result.setUTCDate(1); return result; }
function shiftMonth(date, delta) { const result = monthStart(date); result.setUTCMonth(result.getUTCMonth() + delta); return result; }
export function dateField(options) { return field({ ...options, type: 'date' }); }

/** One-month, UTC calendar-date picker. Values are ISO dates without time zones. */
export function dateRangePicker({ label = t('ui.dateRange'), start = '', end = '', min = '', max = '', onChange } = {}) {
  let month = monthStart(parse(start) ?? parse(today()));
  let pickingEnd = Boolean(start && !end);
  const monthId = uid('month');
  const startField = dateField({ label: t('ui.startDate'), value: start, min, max });
  const endField = dateField({ label: t('ui.endDate'), value: end, min, max });
  const calendar = el('div.mini');
  const element = el('fieldset.date-range', {}, el('legend.field-label', {}, label),
    el('div.field-row', {}, startField.element, endField.element), calendar);
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' });
  const monthFormat = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  function changed() {
    start = startField.input.value; end = endField.input.value;
    const invalid = Boolean(start && end && end < start);
    endField.setError(invalid ? t('ui.rangeError') : '');
    endField.input.min = start || min;
    if (!invalid && startField.input.validity.valid && endField.input.validity.valid) onChange?.({ start, end });
    render();
  }
  for (const control of [startField, endField]) control.input.addEventListener('change', () => {
    const date = parse(control.input.value);
    if (date) month = monthStart(date);
    pickingEnd = Boolean(startField.input.value && !endField.input.value);
    changed();
  });
  function render(focusDate) {
    const localToday = today();
    const activeDate = focusDate || start || localToday;
    const head = el('div.mini-head', {},
      iconButton('chevronLeft', t('ui.previousMonth'), { onclick: () => { month = shiftMonth(month, -1); render(); calendar.querySelector('button').focus(); } }),
      el('h3', { id: monthId, 'aria-live': 'polite' }, monthFormat.format(month)),
      iconButton('chevronRight', t('ui.nextMonth'), { onclick: () => { month = shiftMonth(month, 1); render(); calendar.querySelector('.mini-head button:last-child').focus(); } }));
    const table = el('table.mini-grid', { 'aria-labelledby': monthId });
    const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
    const weekdayLong = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
    const monday = new Date('2026-01-05T12:00:00Z');
    table.append(el('thead', {}, el('tr', {}, Array.from({ length: 7 }, (_, index) => {
      const date = shift(monday, index);
      return el('th', { scope: 'col' }, el('abbr', { title: weekdayLong.format(date) }, weekdayFormat.format(date)));
    }))));
    const body = el('tbody');
    const offset = (month.getUTCDay() + 6) % 7;
    const first = shift(month, -offset);
    const nextMonth = shiftMonth(month, 1);
    const weeks = Math.ceil((Math.round((nextMonth - month) / 86400000) + offset) / 7);
    const dayButtons = [];
    for (let week = 0; week < weeks; week++) {
      const row = el('tr');
      for (let day = 0; day < 7; day++) {
        const date = shift(first, week * 7 + day); const value = iso(date);
        if (date.getUTCMonth() !== month.getUTCMonth()) { row.append(el('td')); continue; }
        const selected = value === start || value === end;
        const inRange = start && end && value >= start && value <= end;
        const node = el(`button.mini-cell${selected ? '.is-selected' : ''}${inRange ? '.in-range' : ''}`, {
          type: 'button', 'aria-label': dateFormat.format(date), 'aria-pressed': selected,
          'aria-current': value === localToday ? 'date' : null,
          disabled: Boolean((min && value < min) || (max && value > max)), tabIndex: -1,
          dataset: { date: value },
          onclick: () => {
            if (pickingEnd && value >= startField.input.value) { endField.input.value = value; pickingEnd = false; }
            else { startField.input.value = value; endField.input.value = ''; pickingEnd = true; }
            changed(); calendar.querySelector(`[data-date="${value}"]`)?.focus();
          },
          onkeydown: (event) => {
            const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
            if (step === undefined && !['Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
            event.preventDefault();
            let target = step !== undefined ? shift(date, step * (['ArrowLeft', 'ArrowRight'].includes(event.key) && getComputedStyle(element).direction === 'rtl' ? -1 : 1)) : new Date(date);
            if (event.key === 'Home') target = shift(date, -((date.getUTCDay() + 6) % 7));
            if (event.key === 'End') target = shift(date, 6 - ((date.getUTCDay() + 6) % 7));
            if (event.key === 'PageUp' || event.key === 'PageDown') target = shiftMonth(date, event.key === 'PageUp' ? -1 : 1);
            const targetValue = iso(target);
            if ((min && targetValue < min) || (max && targetValue > max)) return;
            month = monthStart(target); render(targetValue);
            calendar.querySelector(`[data-date="${targetValue}"]`)?.focus();
          },
        }, new Intl.NumberFormat(locale).format(date.getUTCDate()));
        dayButtons.push(node); row.append(el('td', {}, node));
      }
      body.append(row);
    }
    table.append(body); calendar.replaceChildren(head, table);
    const tabstop = dayButtons.find((node) => node.dataset.date === activeDate && !node.disabled) ?? dayButtons.find((node) => !node.disabled);
    if (tabstop) tabstop.tabIndex = 0;
  }
  endField.input.min = start || min;
  endField.setError(start && end && end < start ? t('ui.rangeError') : '');
  render();
  return { element, startInput: startField.input, endInput: endField.input,
    get value() { return { start: startField.input.value, end: endField.input.value }; },
    setValue(value) { startField.input.value = value.start || ''; endField.input.value = value.end || ''; month = monthStart(parse(value.start) ?? parse(today())); pickingEnd = Boolean(value.start && !value.end); changed(); },
  };
}

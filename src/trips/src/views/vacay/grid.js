// The year grid: one mini month per month of the leave year, one button per day, a single tab stop with arrow keys.
import { el } from '../../ui/dom.js';
import { addDays } from '../../shared/dates.js';
import { displayLocale } from '../../lib/prefs.js';
import { leaveMonths, monthDates, weekday } from '../../lib/vacay/days.js';

const formatters = new Map();
function intl(options) {
  const key = JSON.stringify(options);
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat(displayLocale(), { timeZone: 'UTC', ...options }));
  return formatters.get(key);
}
const utc = (date) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
export const monthTitle = (year, month) => intl({ month: 'long', year: 'numeric' }).format(Date.UTC(year, month - 1, 1));

function weekdayHeads(first) {
  return Array.from({ length: 7 }, (_, index) => {
    const day = (first + index) % 7;
    const at = Date.UTC(2023, 0, 1 + day);
    return el('abbr.vacay-weekday', { title: intl({ weekday: 'long' }).format(at) }, intl({ weekday: 'narrow' }).format(at));
  });
}

function dayNode(date, cell, { focusDate, today }) {
  const classes = ['vacay-day'];
  if (cell.status === 'weekend') classes.push('is-weekend');
  if (cell.status === 'holiday') classes.push('is-holiday');
  if (cell.company) classes.push('is-company');
  if (cell.own) classes.push(cell.own.kind === 'comp' ? 'own-comp' : 'own-vacation', cell.own.fraction === 0.5 ? 'own-half' : 'own-full');
  if (cell.selected) classes.push('is-selected');
  const marks = el('span.vacay-marks', { 'aria-hidden': 'true' },
    cell.peers.slice(0, 4).map((peer) => el(`span.vacay-bar${peer.fraction === 0.5 ? '.is-half' : ''}`, { style: { '--mark': `var(--day-${peer.color})` } })),
    cell.rings.slice(0, 3).map((ring) => el('span.vacay-ring', { style: { '--mark': `var(--day-${ring.color})` } })));
  const bands = el('span.vacay-bands', { 'aria-hidden': 'true' },
    cell.bands.slice(0, 3).map((band) => el('span.vacay-band', { style: { '--mark': `var(--day-${band.color})` } })));
  return el(`button.${classes.join('.')}`, {
    type: 'button', dataset: { date }, tabIndex: date === focusDate ? 0 : -1,
    'aria-pressed': cell.own ? 'true' : 'false', 'aria-label': cell.label, 'aria-current': date === today ? 'date' : null,
    style: cell.own ? { '--own': `var(--day-${cell.ownColor})` } : null,
  }, bands, el('span.vacay-num', { 'aria-hidden': 'true' }, String(Number(date.slice(8)))), marks,
  cell.trips.length ? el('span.vacay-trip', { 'aria-hidden': 'true' }) : null);
}

/**
 * `cellFor(date)` returns `{label, status, own, ownColor, company, peers, rings, bands, trips, selected}`.
 * `onActivate(date, event)` runs on click or Enter/Space; `onFocus(date)` when arrow keys move.
 */
export function renderGrid({ plan, year, range, weekStart, cellFor, focusDate, today, onActivate, onFocus }) {
  const months = leaveMonths(plan, year).map(({ year: y, month }) => {
    const dates = monthDates(y, month);
    const lead = (weekday(dates[0]) - weekStart + 7) % 7;
    const titleId = `vacay-month-${y}-${month}`;
    return el('section.vacay-month', { 'aria-labelledby': titleId },
      el('h3.vacay-month-title', { id: titleId }, monthTitle(y, month)),
      el('div.vacay-week', { 'aria-hidden': 'true' }, weekdayHeads(weekStart)),
      el('div.vacay-days', {},
        Array.from({ length: lead }, () => el('span.vacay-blank', { 'aria-hidden': 'true' })),
        dates.map((date) => (date < range.start || date > range.end
          ? el('span.vacay-day.is-out', { 'aria-hidden': 'true' }, el('span.vacay-num', {}, String(Number(date.slice(8)))))
          : dayNode(date, cellFor(date), { focusDate, today })))));
  });
  const root = el('div.vacay-grid', {
    onclick: (event) => {
      const node = event.target.closest?.('button.vacay-day');
      if (node && root.contains(node)) onActivate(node.dataset.date, event);
    },
    onkeydown: (event) => {
      const node = event.target.closest?.('button.vacay-day');
      if (!node) return;
      const rtl = getComputedStyle(root).direction === 'rtl';
      const date = node.dataset.date;
      const steps = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: 7, ArrowUp: -7 };
      let next = null;
      if (Object.hasOwn(steps, event.key)) next = addDays(date, steps[event.key]);
      else if (event.key === 'Home') next = addDays(date, -((weekday(date) - weekStart + 7) % 7));
      else if (event.key === 'End') next = addDays(date, 6 - ((weekday(date) - weekStart + 7) % 7));
      else if (event.key === 'PageDown' || event.key === 'PageUp') {
        const shifted = new Date(utc(date)); shifted.setUTCMonth(shifted.getUTCMonth() + (event.key === 'PageDown' ? 1 : -1));
        next = shifted.toISOString().slice(0, 10);
      }
      if (!next) return;
      event.preventDefault();
      if (next < range.start) next = range.start;
      if (next > range.end) next = range.end;
      moveFocus(root, next);
      onFocus(next);
    },
  }, months);
  return root;
}

/** Moves the roving tab stop to `date` and focuses it. */
export function moveFocus(root, date, { focus = true } = {}) {
  const target = root.querySelector(`button.vacay-day[data-date="${date}"]`);
  if (!target) return;
  for (const node of root.querySelectorAll('button.vacay-day[tabindex="0"]')) node.tabIndex = -1;
  target.tabIndex = 0;
  if (focus) target.focus({ preventScroll: false });
}

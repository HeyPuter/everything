// Plan settings, per-year allowance and extra calendars.
import { el, uid } from '../../ui/dom.js';
import { button, iconButton } from '../../ui/bits.js';
import { checkbox, field, segmented } from '../../ui/fields.js';
import { openModal } from '../../ui/modal.js';
import { t } from '../../lib/i18n/index.js';
import { displayLocale } from '../../lib/prefs.js';
import { COUNTRY_CODES, countryName } from '../../lib/atlas/countries.js';
import { newId } from '../../shared/ids.js';
import { isDate } from '../../shared/dates.js';
import { COLORS, NAME_MAX, isCountry, isRegion, valid } from '../../lib/vacay/model.js';
import { errorText, plural } from './text.js';

const weekdayName = (day) => new Intl.DateTimeFormat(displayLocale(), { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2023, 0, 1 + day));
const monthName = (month) => new Intl.DateTimeFormat(displayLocale(), { month: 'long', timeZone: 'UTC' }).format(Date.UTC(2023, month - 1, 1));
const colorOptions = () => Array.from({ length: COLORS }, (_, index) => ({ value: String(index + 1), label: t(`vacay.color.${index + 1}`) }));
let countries;
function countryOptions(none) {
  countries ??= COUNTRY_CODES.map((code) => ({ value: code, label: countryName(code, displayLocale()) })).sort((a, b) => a.label.localeCompare(b.label));
  return [{ value: '', label: none }, ...countries];
}

function formDialog({ title, content, onSubmit, extra = [] }) {
  const save = button(t('vacay.save'), { type: 'submit', variant: 'primary' });
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const form = el('form.vacay-form', {
    onsubmit: async (event) => {
      event.preventDefault();
      error.hidden = true;
      if (!form.reportValidity()) return;
      save.setAttribute('aria-busy', 'true');
      try { if (await onSubmit() !== false) dialog.close('done'); }
      catch (cause) { error.textContent = errorText(cause); error.hidden = false; }
      finally { save.setAttribute('aria-busy', 'false'); }
    },
  }, content, error, el('div.modal-actions', {}, ...extra, button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), save));
  const dialog = openModal({ title, content: form });
  return { dialog, fail: (message) => { error.textContent = message; error.hidden = false; } };
}

/**
 * Country plus optional region. Regions come from `services.holidays.subdivisions` when it answers; otherwise a
 * code field (`DE-BY`). `value()` is `{country, region}` with empty strings for none.
 */
function regionPicker({ label, regionLabel, country = '', region = '', services, lang }) {
  const countryField = field({ label, type: 'select', value: country, options: countryOptions(t('vacay.none')) });
  const slot = el('div');
  let read = () => '';
  let token = 0;
  async function renderRegion(code, current) {
    const mine = ++token;
    slot.replaceChildren();
    read = () => '';
    if (!code) return;
    let list = null;
    try { list = (await services?.holidays?.subdivisions?.(code, { lang }))?.data ?? null; } catch { list = null; }
    if (mine !== token) return;
    if (Array.isArray(list) && list.length) {
      const options = [{ value: '', label: t('vacay.wholeCountry') }, ...list.map((item) => ({ value: item.code, label: item.name || item.code }))];
      if (current && !options.some((option) => option.value === current)) options.push({ value: current, label: current });
      const select = field({ label: regionLabel, type: 'select', value: current ?? '', options });
      read = () => select.input.value;
      slot.replaceChildren(select.element);
    } else {
      const input = field({ label: regionLabel, hint: t('vacay.regionHint'), value: current ?? '', maxLength: 20, pattern: '[A-Z]{2}-[A-Z0-9]{1,6}(-[A-Z0-9]{1,6})?', autocomplete: 'off', spellcheck: false });
      read = () => input.input.value.trim().toUpperCase();
      slot.replaceChildren(input.element);
    }
  }
  countryField.input.addEventListener('change', () => { void renderRegion(countryField.input.value, ''); });
  void renderRegion(country, region);
  return { element: el('div.vacay-region', {}, countryField.element, slot), value: () => ({ country: countryField.input.value, region: read() }) };
}

/** Plan settings. `submit(plan)` saves it. */
export function openSettingsDialog({ plan, services, lang, submit }) {
  const color = field({ label: t('vacay.myColor'), type: 'select', value: String(plan.color ?? 1), options: colorOptions() });
  const order = Array.from({ length: 7 }, (_, index) => (plan.weekStart + index) % 7);
  const weekend = new Set(plan.weekendDays);
  const weekendBoxes = order.map((day) => checkbox(weekdayName(day), { checked: weekend.has(day), onChange: (on) => { if (on) weekend.add(day); else weekend.delete(day); } }));
  const weekStart = field({ label: t('vacay.weekStart'), type: 'select', value: String(plan.weekStart), options: [1, 0, 6].map((day) => ({ value: String(day), label: weekdayName(day) })) });
  const holidays = regionPicker({ label: t('vacay.publicHolidays'), regionLabel: t('vacay.region'), country: plan.holidays?.country ?? '', region: plan.holidays?.region ?? '', services, lang });
  const school = regionPicker({ label: t('vacay.schoolHolidays'), regionLabel: t('vacay.subdivision'), country: plan.school?.country ?? '', region: plan.school?.subdivision ?? '', services, lang });
  const yearType = field({ label: t('vacay.leaveYear'), type: 'select', value: plan.yearType, options: ['calendar', 'fiscal', 'hire'].map((value) => ({ value, label: t(`vacay.yearType.${value}`) })) });
  const startMonth = field({ label: t('vacay.startMonth'), type: 'select', value: String(plan.startMonth ?? 1), options: Array.from({ length: 12 }, (_, index) => ({ value: String(index + 1), label: monthName(index + 1) })) });
  const startDay = field({ label: t('vacay.startDay'), type: 'number', value: String(plan.startDay ?? 1), min: 1, max: 31, step: 1, inputMode: 'numeric' });
  const hireDate = field({ label: t('vacay.hireDate'), type: 'date', value: plan.hireDate ?? '' });
  const fiscalRow = el('div.field-row', {}, startMonth.element, startDay.element);
  const sync = () => { fiscalRow.hidden = yearType.input.value !== 'fiscal'; hireDate.element.hidden = yearType.input.value !== 'hire'; hireDate.input.required = yearType.input.value === 'hire'; };
  yearType.input.addEventListener('change', sync); sync();
  const carry = field({ label: t('vacay.carryOver'), hint: t('vacay.carryOverHint'), type: 'number', value: String(plan.carryOver ?? 0), min: 0, max: 1000, step: 0.5, inputMode: 'decimal' });
  const content = el('div.vacay-form-body', {}, color.element,
    el('fieldset.vacay-fieldset', {}, el('legend.field-label', {}, t('vacay.weekendDays')), el('div.vacay-checks', {}, weekendBoxes)),
    weekStart.element, holidays.element, school.element, yearType.element, fiscalRow, hireDate.element, carry.element);
  const { fail } = formDialog({ title: t('vacay.settings'), content, onSubmit: async () => {
    const hol = holidays.value(); const sch = school.value();
    const next = {
      weekendDays: order.filter((day) => weekend.has(day)), weekStart: Number(weekStart.input.value), yearType: yearType.input.value, color: Number(color.input.value),
      ...(isCountry(hol.country) ? { holidays: { country: hol.country, ...(isRegion(hol.region) ? { region: hol.region } : {}) } } : {}),
      ...(isCountry(sch.country) ? { school: { country: sch.country, ...(isRegion(sch.region) ? { subdivision: sch.region } : {}) } } : {}),
      ...(Number(carry.input.value) > 0 ? { carryOver: Math.round(Number(carry.input.value) * 2) / 2 } : {}),
      ...(yearType.input.value === 'fiscal' ? { startMonth: Number(startMonth.input.value), startDay: Number(startDay.input.value) } : {}),
      ...(yearType.input.value === 'hire' && isDate(hireDate.input.value) ? { hireDate: hireDate.input.value } : {}),
    };
    if (next.weekendDays.length === 7) { fail(t('vacay.error.allWeekend')); return false; }
    if (!valid('plan', next)) { fail(t('vacay.error.invalidSettings')); return false; }
    await submit(next);
  } });
}

/** Days for one leave year, and an optional carried-over value set by hand. */
export function openAllowanceDialog({ yearText, days, carried, stored, computedCarry, submit, remove }) {
  const daysField = field({ label: t('vacay.allowanceDays', { year: yearText }), type: 'number', value: String(days), min: 0, max: 1000, step: 0.5, inputMode: 'decimal', required: true });
  const carriedField = field({ label: t('vacay.carriedDays'), type: 'number', value: String(carried ?? computedCarry ?? 0), min: 0, max: 1000, step: 0.5, inputMode: 'decimal' });
  let manual = Number.isFinite(carried);
  carriedField.input.disabled = !manual;
  const manualBox = checkbox(t('vacay.carriedManual'), { checked: manual, onChange: (on) => { manual = on; carriedField.input.disabled = !on; } });
  const extra = stored ? [button(t('vacay.allowanceReset'), { variant: 'ghost', onclick: async () => { try { await remove(); handle.dialog.close('done'); } catch (error) { handle.fail(errorText(error)); } } })] : [];
  const handle = formDialog({ title: t('vacay.allowanceTitle'), extra, content: el('div.vacay-form-body', {}, daysField.element, manualBox, carriedField.element,
    el('p.vacay-hint', {}, t('vacay.carriedAuto', { days: String(computedCarry ?? 0) }))),
  onSubmit: () => submit({ days: Math.round(Number(daysField.input.value) * 2) / 2, ...(manual ? { carried: Math.round(Number(carriedField.input.value) * 2) / 2 } : {}) }) });
}

function periodRows(periods) {
  const list = el('ul.vacay-periods');
  const add = (period = { start: '', end: '' }) => {
    const start = field({ label: t('vacay.periodStart'), type: 'date', value: period.start, required: true });
    const end = field({ label: t('vacay.periodEnd'), type: 'date', value: period.end, required: true });
    const row = el('li.field-row', {}, start.element, end.element, iconButton('trash', t('vacay.removePeriod'), { onclick: () => row.remove() }));
    row.read = () => ({ start: start.input.value, end: end.input.value });
    list.append(row);
  };
  periods.forEach(add);
  return { element: el('div', {}, list, button(t('vacay.addPeriod'), { size: 'sm', icon: 'plus', onclick: () => add() })), read: () => [...list.children].map((row) => row.read()) };
}

/** Extra calendars: list, add, edit and delete. `save(id, value|null)` writes one. */
export function openCalendarsDialog({ calendars, services, lang, save }) {
  const body = el('div.vacay-form-body');
  const dialog = openModal({ title: t('vacay.calendars'), content: body });
  const showList = () => {
    const rows = [...calendars()].map(([id, calendar]) => el('li.vacay-person', {},
      el('span.vacay-swatch', { 'aria-hidden': 'true', style: { '--mark': `var(--day-${calendar.color})` } }),
      el('span.vacay-person-text', {}, el('strong', {}, calendar.label),
        el('span', {}, calendar.type === 'custom' ? plural('vacay.periods', calendar.periods.length) : `${t(`vacay.calendarType.${calendar.type}`)} · ${calendar.region}`)),
      iconButton('pencil', t('vacay.editCalendar', { name: calendar.label }), { onclick: () => showForm(id, calendar) }),
      iconButton('trash', t('vacay.deleteCalendar', { name: calendar.label }), { onclick: async () => {
        try { await save(id, null); showList(); } catch (error) { status.textContent = errorText(error); }
      } })));
    const status = el('p.field-error', { role: 'alert' });
    body.replaceChildren(el('p.vacay-hint', {}, t('vacay.calendarsHint')),
      rows.length ? el('ul.vacay-list', {}, rows) : el('p', {}, t('vacay.noCalendars')), status,
      el('div.modal-actions', {}, button(t('vacay.addCalendar'), { icon: 'plus', variant: 'primary', onclick: () => showForm(null, null) })));
  };
  const showForm = (id, calendar) => {
    const labelId = uid('vacay-cal');
    const label = field({ label: t('vacay.calendarLabel'), value: calendar?.label ?? '', required: true, maxLength: NAME_MAX, id: labelId });
    let type = calendar?.type ?? 'school';
    const region = el('div');
    const periods = periodRows(calendar?.periods ?? []);
    let picker = null;
    const renderType = () => {
      if (type === 'custom') { region.replaceChildren(periods.element); picker = null; return; }
      const [country, sub] = [calendar?.region?.slice(0, 2) ?? '', isRegion(calendar?.region) ? calendar.region : ''];
      picker = regionPicker({ label: t('vacay.country'), regionLabel: t(type === 'school' ? 'vacay.subdivision' : 'vacay.region'), country, region: sub, services, lang });
      region.replaceChildren(picker.element);
    };
    const typeControl = segmented({ label: t('vacay.calendarTypeLabel'), value: type, radio: true, items: ['school', 'public', 'custom'].map((value) => ({ value, label: t(`vacay.calendarType.${value}`) })), onChange: (value) => { type = value; renderType(); } });
    const color = field({ label: t('vacay.calendarColor'), type: 'select', value: String(calendar?.color ?? 2), options: colorOptions() });
    const error = el('p.field-error', { role: 'alert', hidden: true });
    const form = el('form.vacay-form', { onsubmit: async (event) => {
      event.preventDefault();
      error.hidden = true;
      if (!form.reportValidity()) return;
      const place = picker?.value();
      const value = { type, label: label.input.value.trim(), color: Number(color.input.value), periods: type === 'custom' ? periods.read() : [],
        ...(type !== 'custom' ? { region: isRegion(place?.region) ? place.region : place?.country ?? '' } : {}) };
      if (type !== 'custom' && !isCountry(value.region) && !isRegion(value.region)) { error.textContent = t('vacay.error.calendarRegion'); error.hidden = false; return; }
      if (type === 'custom' && (!value.periods.length || value.periods.some((period) => !isDate(period.start) || !isDate(period.end) || period.end < period.start))) { error.textContent = t('vacay.error.calendarPeriods'); error.hidden = false; return; }
      try { await save(id ?? newId(), value); showList(); } catch (cause) { error.textContent = errorText(cause); error.hidden = false; }
    } }, label.element, el('fieldset.vacay-fieldset', {}, el('legend.field-label', {}, t('vacay.calendarTypeLabel')), typeControl.element), region, color.element, error,
    el('div.modal-actions', {}, button(t('ui.cancel'), { onclick: showList }), button(t('vacay.save'), { type: 'submit', variant: 'primary' })));
    renderType();
    body.replaceChildren(form);
    label.input.focus();
  };
  showList();
  return dialog;
}

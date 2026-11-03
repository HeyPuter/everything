import { el, uid } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { segmented } from '../../../ui/fields.js';
import { openModal } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDistance, formatNumber } from '../../../lib/format.js';
import { AVOIDS, CORRIDORS, ROAD_PREFS_ID, rangeKm, rangeKnown, readPrefs } from '../../../lib/road/index.js';
import { isCurrency } from '../../../shared/money.js';
import { isTime, timeMinutes } from '../../../shared/dates.js';

const CURRENCIES = (() => { try { return Intl.supportedValuesOf('currency'); } catch { return ['EUR', 'USD', 'GBP']; } })();

function numberField(label, { value, min, max, step = 'any', hint, unit }) {
  const id = uid('road-field');
  const input = el('input.input.num', { id, type: 'number', inputMode: 'decimal', min: String(min), max: String(max), step: String(step), value: value ?? '' });
  const error = el('span.field-error', { hidden: true, 'aria-live': 'polite' });
  const element = el('div.field', {}, el('label.field-label', { htmlFor: id }, unit ? t('road.settings.withUnit', { label, unit }) : label), input, hint && el('span.field-hint', {}, hint), error);
  return {
    element, input,
    read() {
      const raw = input.value.trim();
      if (!raw) { error.hidden = true; input.removeAttribute('aria-invalid'); return null; }
      const number = Number(raw);
      const ok = Number.isFinite(number) && number >= min && number <= max && (step !== 1 || Number.isInteger(number));
      error.hidden = ok; error.textContent = ok ? '' : t('road.settings.range', { min: formatNumber(min), max: formatNumber(max) });
      input.setAttribute('aria-invalid', String(!ok));
      return ok ? number : undefined;
    },
  };
}
function timeField(label, value) {
  const id = uid('road-time');
  const input = el('input.input', { id, type: 'time', value, required: true });
  return { element: el('div.field', {}, el('label.field-label', { htmlFor: id }, label), input), input };
}

/** Vehicle, costs, driving day and route settings. Viewers see them read-only. */
export function openRoadSettings({ space, ops, tripCurrency, onSaved }) {
  const stored = space.get('rtPrefs', ROAD_PREFS_ID);
  const prefs = readPrefs(stored);
  const canEdit = space.can('plan.edit');
  let fuel = prefs.fuel;
  const fuelChoice = segmented({ label: t('road.settings.fuel'), radio: true, value: fuel, items: ['petrol', 'electric', 'either'].map((value) => ({ value, label: t(`road.fuel.${value}`) })),
    onChange: (value) => { fuel = value; sync(); } });
  const range = numberField(t('road.settings.rangeLabel'), { value: stored?.range, min: 10, max: 3000, step: 1, unit: 'km', hint: t('road.settings.rangeHint') });
  const tank = numberField(t('road.settings.tank'), { value: stored?.tank, min: 1, max: 500, unit: 'L' });
  const battery = numberField(t('road.settings.battery'), { value: stored?.battery, min: 1, max: 500, unit: 'kWh' });
  const degrade = numberField(t('road.settings.degrade'), { value: stored?.degrade, min: 0, max: 60, step: 1, unit: '%' });
  const use = numberField(t('road.settings.use'), { value: stored?.use, min: 0.5, max: 100 });
  const fill = numberField(t('road.settings.fill'), { value: stored?.fill, min: 10, max: 100, step: 1, unit: '%', hint: t('road.settings.fillHint') });
  const reserve = numberField(t('road.settings.reserve'), { value: stored?.reserve, min: 0, max: 50, step: 1, unit: '%', hint: t('road.settings.reserveHint') });
  const price = numberField(t('road.settings.price'), { value: stored?.price ? Number(stored.price) : null, min: 0.000001, max: 999999 });
  const currencyId = uid('road-currency');
  const currency = el('select.select', { id: currencyId }, [...new Set([prefs.currency, tripCurrency, ...CURRENCIES].filter(isCurrency))].map((code) => el('option', { value: code }, code)));
  currency.value = prefs.currency ?? tripCurrency ?? 'EUR';
  const computed = el('p.field-hint.road-computed', { 'aria-live': 'polite' });
  const start = timeField(t('road.settings.start'), prefs.start);
  const end = timeField(t('road.settings.end'), prefs.end);
  const stint = numberField(t('road.settings.stint'), { value: stored?.stint ?? prefs.stint, min: 15, max: 720, step: 1, unit: t('road.unit.min') });
  const daily = numberField(t('road.settings.daily'), { value: stored?.daily ?? prefs.daily, min: 30, max: 1440, step: 1, unit: t('road.unit.min') });
  const pause = numberField(t('road.settings.pause'), { value: stored?.pause ?? prefs.pause, min: 0, max: 240, step: 1, unit: t('road.unit.min') });
  const avoid = new Set(prefs.avoid);
  const avoidBoxes = AVOIDS.map((name) => el('label.check-field', {}, el('input', { type: 'checkbox', checked: avoid.has(name), onchange: (event) => { if (event.target.checked) avoid.add(name); else avoid.delete(name); } }), el('span', {}, t(`road.avoid.${name}`))));
  let corridor = CORRIDORS.includes(prefs.corridor) ? prefs.corridor : 5;
  const corridorChoice = segmented({ label: t('road.settings.corridor'), radio: true, value: corridor, items: CORRIDORS.map((value) => ({ value, label: formatDistance(value * 1000) })), onChange: (value) => { corridor = value; } });
  const showStops = el('input', { type: 'checkbox', checked: prefs.showStops });
  const timeError = el('p.field-error', { role: 'alert', hidden: true });

  function sync() {
    const electric = fuel === 'electric';
    tank.element.hidden = electric; battery.element.hidden = !electric; degrade.element.hidden = !electric;
    use.element.querySelector('label').textContent = t('road.settings.withUnit', { label: t('road.settings.use'), unit: electric ? t('road.unit.kwhPer100') : t('road.unit.lPer100') });
    price.element.querySelector('label').textContent = t(electric ? 'road.settings.priceKwh' : 'road.settings.priceL');
    const draft = readPrefs({ fuel, range: range.read() ?? undefined, tank: tank.read() ?? undefined, battery: battery.read() ?? undefined, use: use.read() ?? undefined, degrade: degrade.read() ?? undefined });
    computed.textContent = rangeKnown(draft) ? t('road.settings.rangeComputed', { range: formatDistance(rangeKm(draft) * 1000) }) : t('road.settings.rangeDefault', { range: formatDistance(rangeKm(draft) * 1000) });
  }
  for (const field of [range, tank, battery, use, degrade]) field.input.addEventListener('input', sync);

  const section = (title, ...children) => el('fieldset.road-settings-group', { disabled: !canEdit }, el('legend.field-label', {}, title), ...children);
  const content = el('div.road-settings',
    {},
    !canEdit && el('p.plan-note', {}, t('road.settings.viewOnly')),
    section(t('road.settings.vehicle'), fuelChoice.element, el('div.field-row', {}, tank.element, battery.element, degrade.element), el('div.field-row', {}, use.element, range.element), computed, el('div.field-row', {}, fill.element, reserve.element)),
    section(t('road.settings.costs'), el('div.field-row', {}, price.element, el('div.field', {}, el('label.field-label', { htmlFor: currencyId }, t('road.settings.currency')), currency))),
    section(t('road.settings.day'), el('div.field-row', {}, start.element, end.element), timeError, el('div.field-row', {}, stint.element, daily.element, pause.element)),
    section(t('road.settings.route'), el('div.road-checks', {}, avoidBoxes), corridorChoice.element, el('label.check-field', {}, showStops, el('span', {}, t('road.settings.showStops')))),
  );
  sync();

  async function save() {
    const values = { range: range.read(), tank: tank.read(), battery: battery.read(), degrade: degrade.read(), use: use.read(), fill: fill.read(), reserve: reserve.read(), price: price.read(), stint: stint.read(), daily: daily.read(), pause: pause.read() };
    if (Object.values(values).some((value) => value === undefined)) return;
    const okTimes = isTime(start.input.value) && isTime(end.input.value) && timeMinutes(end.input.value) > timeMinutes(start.input.value);
    timeError.hidden = okTimes; timeError.textContent = okTimes ? '' : t('road.settings.timeError');
    if (!okTimes) return;
    const priceText = values.price === null ? null : String(Math.round(values.price * 1e6) / 1e6);
    const changes = {
      ...values, fuel, price: priceText, currency: priceText ? currency.value : null, start: start.input.value, end: end.input.value,
      avoid: AVOIDS.filter((name) => avoid.has(name)), corridor, showStops: showStops.checked,
      ...(fuel === 'electric' ? { tank: null } : { battery: null, degrade: null }),
    };
    if (changes.range !== null) changes.range = Math.round(changes.range);
    try { await ops.setPrefs(changes); dialog.close('saved'); onSaved?.(); } catch { toast(t('road.saveFailed')); }
  }
  const dialog = openModal({
    title: t('road.settings.title'), content, wide: true,
    actions: canEdit ? [button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), button(t('ui.save'), { variant: 'primary', onclick: save })] : [button(t('ui.close'), { onclick: () => dialog.close() })],
  });
  return dialog;
}

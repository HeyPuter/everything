import { el } from '../../../ui/dom.js';
import { t, locale as uiLocale, availableLocales, automaticLocale, requestedLocale } from '../../../lib/i18n/index.js';
import { prefs, displayLocale } from '../../../lib/prefs.js';
import { formatDate, formatTime, weekdays, unitLabel } from '../../../lib/format.js';
import { tripTabs } from '../../registry/tabs.js';
import { group, prefChoice, prefSelect, prefSwitch, keepInSync, statusLine } from '../ui.js';

function currencies() {
  const locale = displayLocale();
  let names;
  try { names = new Intl.DisplayNames([locale], { type: 'currency' }); } catch { names = null; }
  return Intl.supportedValuesOf('currency').map((code) => ({ value: code, label: names ? `${code} · ${names.of(code)}` : code }))
    .sort((a, b) => a.value.localeCompare(b.value));
}
function dayName(day) { return weekdays({ style: 'long', prefs: { ...prefs(), weekStart: 'sun' } })[day].label; }
let languageChanged = 0;
/** Each language under its own name, plus its name in the current language when that differs. */
function languages() {
  let names;
  try { names = new Intl.DisplayNames([uiLocale], { type: 'language' }); } catch { names = null; }
  const label = (entry) => { const local = names?.of(entry.tag); return local && local !== entry.name ? `${entry.name} · ${local}` : entry.name; };
  const auto = availableLocales().find((entry) => entry.tag === automaticLocale());
  return [{ value: 'auto', label: t('settings.languageAuto', { language: auto?.name ?? 'English' }) },
    ...availableLocales().map((entry) => ({ value: entry.tag, label: label(entry), lang: entry.tag }))];
}

export function render(container, { signal }) {
  const sample = `${new Date().getFullYear()}-12-31`;
  const dateExample = (dateFormat) => formatDate(sample, { style: 'numeric', prefs: { ...prefs(), dateFormat } });
  const timeExample = (timeFormat) => formatTime('14:30', { prefs: { ...prefs(), timeFormat } });
  const autoWeek = dayName(weekdays({ prefs: { ...prefs(), weekStart: 'auto' } })[0].day);
  const options = languages();
  // Shows this device's choice when the account has none saved.
  const language = prefSelect('lang', t('settings.language'), options, { hint: t('settings.languageHint'), fromValue: (value) => (value === 'auto' ? requestedLocale() : value) });
  const select = language.node.querySelector('select');
  options.forEach((option, index) => { if (option.lang) select.options[index].lang = option.lang; });
  // The shell redraws every view after a language change; focus returns to the picker.
  select.addEventListener('change', () => { languageChanged = Date.now(); });
  if (Date.now() - languageChanged < 10_000) { languageChanged = 0; queueMicrotask(() => select.focus()); }
  const controls = [
    prefChoice('distanceUnit', t('settings.distance'), [{ value: 'km', label: unitLabel('km') }, { value: 'mi', label: unitLabel('mi') }]),
    prefChoice('tempUnit', t('settings.temperature'), [{ value: 'c', label: unitLabel('c') }, { value: 'f', label: unitLabel('f') }]),
    prefChoice('weightUnit', t('settings.weight'), [{ value: 'kg', label: unitLabel('kg') }, { value: 'lb', label: unitLabel('lb') }]),
  ];
  const formats = [
    prefSelect('dateFormat', t('settings.dateFormat'), [
      { value: 'auto', label: t('settings.dateAuto', { example: dateExample('auto') }) },
      { value: 'dmy', label: t('settings.dateDmy', { example: dateExample('dmy') }) },
      { value: 'mdy', label: t('settings.dateMdy', { example: dateExample('mdy') }) },
      { value: 'iso', label: t('settings.dateIso', { example: dateExample('iso') }) },
    ]),
    prefChoice('timeFormat', t('settings.timeFormat'), [
      { value: 'auto', label: t('settings.timeAuto', { example: timeExample('auto') }) },
      { value: '24', label: t('settings.time24', { example: timeExample('24') }) },
      { value: '12', label: t('settings.time12', { example: timeExample('12') }) },
    ]),
    prefSelect('weekStart', t('settings.weekStart'), [
      { value: 'auto', label: t('settings.weekAuto', { day: autoWeek }) },
      { value: 'mon', label: dayName(1) }, { value: 'sun', label: dayName(0) }, { value: 'sat', label: dayName(6) },
    ]),
  ];
  const money = [
    prefSelect('currency', t('settings.currency'), [{ value: '', label: t('settings.currencyTrip') }, ...currencies()], {
      hint: t('settings.currencyHint'), toValue: (value) => value || null, fromValue: (value) => value ?? '',
    }),
  ];
  const behaviour = [
    prefSelect('startPage', t('settings.startPage'), [
      { value: 'trips', label: t('settings.startTrips') }, { value: 'last', label: t('settings.startLast') }, { value: 'current', label: t('settings.startCurrent') },
    ], { hint: t('settings.startPageHint') }),
    prefSelect('tripTab', t('settings.tripTab'), tripTabs.filter((tab) => tab.id !== 'settings').map((tab) => ({ value: tab.id, label: t(tab.labelKey) })), { hint: t('settings.tripTabHint') }),
    prefSwitch('placeDescriptions', t('settings.placeDescriptions'), t('settings.placeDescriptionsHint')),
    prefSwitch('blurCodes', t('settings.blurCodes'), t('settings.blurCodesHint')),
  ];
  keepInSync([language, ...controls, ...formats, ...money, ...behaviour], signal);
  container.replaceChildren(el('div.settings-stack', {},
    group(t('settings.languageTitle'), language.node),
    group(t('settings.units'), ...controls.map((control) => control.node)),
    group(t('settings.formats'), ...formats.map((control) => control.node)),
    group(t('settings.money'), ...money.map((control) => control.node)),
    group(t('settings.behaviour'), ...behaviour.map((control) => control.node)),
    statusLine(signal)));
}

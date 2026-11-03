// "Reminders" for one open trip: the trip's `reminderDays` (needs `trip.edit`), browser notifications on this device
// (permission asked from the switch) and the trip's next reminders.
import './notify.css';
import { el, uid } from '../../ui/dom.js';
import { button } from '../../ui/bits.js';
import { openModal } from '../../ui/modal.js';
import { t } from '../i18n/index.js';
import { displayLocale } from '../prefs.js';
import { formatInstant } from '../format.js';
import { isDate } from '../../shared/dates.js';
import { tripReminders, upcoming } from './schedule.js';
import { reminderLabels, reminderText } from './text.js';
import { browserChoice, onBrowserChange, permission, setBrowserNotifications } from './browser.js';
import { activeReminders } from './notifier.js';

export const REMINDER_CHOICES = Object.freeze([0, 1, 2, 3, 7, 14, 30]);
const zoneNow = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const choiceLabel = (days) => (days === 0 ? t('notify.daysSame') : t(new Intl.PluralRules(displayLocale()).select(days) === 'one' ? 'notify.daysBeforeOne' : 'notify.daysBefore', { count: new Intl.NumberFormat(displayLocale()).format(days) }));

/** The browser-notification switch with its state line; `{node, destroy}`. */
export function browserSwitch({ window: win = globalThis.window } = {}) {
  const labelId = uid('notify-browser');
  const hintId = uid('notify-browser-hint');
  const control = el('button.switch', { type: 'button', role: 'switch', 'aria-labelledby': labelId, 'aria-describedby': hintId, onclick: async () => {
    control.setAttribute('aria-busy', 'true');
    try { await setBrowserNotifications(!(browserChoice() && permission(win) === 'granted'), win); } finally { control.removeAttribute('aria-busy'); render(); }
  } }, el('span.switch-thumb'));
  const hint = el('span.pref-hint', { id: hintId });
  function render() {
    const state = permission(win);
    const on = browserChoice() && state === 'granted';
    control.setAttribute('aria-checked', String(on));
    control.disabled = state === 'unsupported' || state === 'denied';
    hint.textContent = t(state === 'unsupported' ? 'notify.browserUnsupported' : state === 'denied' ? 'notify.browserDenied' : on ? 'notify.browserOn' : 'notify.browserOff');
  }
  render();
  const off = onBrowserChange(render);
  return {
    node: el('div.notify-row', {}, el('span.notify-row-text', {}, el('span.pref-label', { id: labelId }, t('notify.browser')), hint), control),
    destroy: off,
  };
}

/** `[{title, body, when}]` rows for upcoming reminders, worded as they will read when they fire. */
export function reminderRows(items, { now = Date.now(), zone = zoneNow() } = {}) {
  return items.map((item) => {
    const at = Math.max(item.fireAt, now);
    return { ...reminderText(item, { now: at, zone }), when: formatInstant(at, zone), item };
  });
}

export function reminderList(items, options = {}) {
  const rows = reminderRows(items, options);
  if (!rows.length) return el('p.pref-hint.notify-empty', {}, t('notify.noneUpcoming'));
  return el('ul.notify-list', {}, rows.map((row) => el('li.notify-item', {},
    el('span.notify-item-when', {}, row.when),
    el('span.notify-item-text', {}, el('bdi.notify-item-title', {}, row.title), el('span.notify-item-body', {}, row.body)))));
}

function liveData(space) {
  const all = (type) => space.select?.[type]?.all?.() ?? [];
  return { meta: space.get('meta', 'meta'), day: all('day'), visit: all('visit'), place: all('place'), res: all('res'), todo: all('todo'), listMeta: all('listMeta') };
}

/** Opens the trip's reminder settings. Needs `context.space`; returns the modal handle. */
export function openReminderSettings(context) {
  const { space } = context;
  const uidSelf = context.account?.uuid ?? context.session?.account?.uuid;
  const meta = space.get('meta', 'meta') ?? {};
  const editable = space.can('trip.edit');
  let chosen = new Set(Array.isArray(meta.reminderDays) ? meta.reminderDays : []);
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const choices = el('div.notify-choices', { role: 'group', 'aria-label': t('notify.tripReminder') }, REMINDER_CHOICES.map((days) => el('label.check-field', {},
    el('input', { type: 'checkbox', checked: chosen.has(days), disabled: !editable, onchange: (event) => { if (event.target.checked) chosen.add(days); else chosen.delete(days); } }),
    el('span', {}, choiceLabel(days)))));
  const browser = browserSwitch();
  const zone = zoneNow();
  const entry = { ref: space.ref, title: meta.title };
  const items = upcoming(tripReminders({ entry, data: liveData(space) }, { uid: uidSelf, zone, labels: reminderLabels }), { limit: 8 });
  const content = el('div.notify-settings', {},
    el('section.notify-section', {},
      el('h3.notify-heading', {}, t('notify.tripReminder')),
      el('p.pref-hint', {}, t(isDate(meta.start) ? 'notify.tripReminderHint' : 'notify.tripReminderUndated')),
      choices,
      !editable && el('p.pref-hint', {}, t('notify.tripReminderReadOnly'))),
    el('p.pref-hint.notify-rules', {}, t('notify.rules')),
    el('section.notify-section', {}, el('h3.notify-heading', {}, t('notify.thisBrowser')), browser.node, el('p.pref-hint', {}, t('notify.openOnly'))),
    el('section.notify-section', {}, el('h3.notify-heading', {}, t('notify.upcoming')), reminderList(items, { zone })),
    error);
  const save = editable && button(t('notify.save'), { variant: 'primary', onclick: async () => {
    error.hidden = true;
    const days = [...chosen].sort((a, b) => a - b);
    save.setAttribute('aria-busy', 'true');
    try {
      await space.apply([space.ops.patch('meta', 'meta', days.length ? { set: { reminderDays: days } } : { unset: ['reminderDays'] })], { history: t('notify.historyLabel') });
      void activeReminders()?.refresh();
      dialog.close('saved');
    } catch (problem) {
      error.textContent = t(problem?.status === 403 ? 'notify.errorForbidden' : 'notify.errorSave');
      error.hidden = false;
    } finally { save.removeAttribute('aria-busy'); }
  } });
  const dialog = openModal({ title: t('notify.title'), content, actions: [button(t(editable ? 'notify.cancel' : 'notify.close'), { onclick: () => dialog.close('cancel') }), save].filter(Boolean),
    onClose: () => browser.destroy() });
  return dialog;
}

/** Registers the "Trip reminders" palette command for a mounted trip view; returns the function that removes it. */
export function registerReminderCommand(context) {
  const commands = context?.app?.commands;
  if (typeof commands?.register !== 'function' || !context.space) return () => {};
  try { return commands.register({ id: 'trip-reminders', labelKey: 'notify.command', run: () => openReminderSettings(context) }); } catch { return () => {}; }
}

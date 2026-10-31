import { append, clear, el } from '../../../ui/dom.js';
import { t } from '../../../lib/i18n/index.js';
import { formatTime } from '../../../lib/format.js';
import { phaseLabelKey } from '../../../lib/timeline/index.js';
import { icon, RES_ICONS } from './icons.js';
import { timelineOf } from './ops.js';
import { dayLabel } from './forms.js';
import { callHook } from './hooks.js';

/** The selected day's stay and bookings, over the map, then whatever the `dayPanel` hook adds. */
export function mountDayPanel(container, { space, plan }) {
  let frame = 0;
  function render() {
    frame = 0;
    const dayId = plan.get().day;
    const entry = dayId ? timelineOf(space).byDay.get(dayId) : null;
    container.hidden = !entry;
    if (!entry) { container.replaceChildren(); return; }
    const bookings = entry.rows.filter((row) => row.kind === 'res');
    const stays = entry.stays.filter((stay) => stay.res.status !== 'cancelled');
    const line = (name, label, title, time) => el('li.plan-panel-item', {}, icon(name, 15), el('span.plan-panel-label', {}, label), el('span', {}, title), time && el('span.num.plan-time', {}, time));
    append(clear(container), [
      el('header.plan-panel-head', { style: { '--day-color': `var(--day-${entry.color})` } }, el('span.day-dot', { 'aria-hidden': 'true' }),
        el('h2', {}, dayLabel(entry)),
        el('button.icon-btn.icon-btn-sm', { type: 'button', 'aria-label': t('plan.closePanel'), title: t('plan.closePanel'), onclick: () => plan.set({ day: null, visit: null }) }, icon('close', 16))),
      entry.day.title && entry.date && el('p.plan-panel-title', {}, entry.day.title),
      stays.length || bookings.length
        ? el('ul.plan-panel-list', {},
          stays.map((stay) => line('bed-double', t(phaseLabelKey('stay', stay.phase)), stay.res.title,
            formatTime(stay.phase === 'checkout' ? stay.res.stay?.checkOut : stay.phase === 'checkin' ? stay.res.stay?.checkInFrom : null))),
          bookings.map((row) => line(RES_ICONS[row.entity.type] ?? 'bookmark', row.phase ? t(phaseLabelKey(row.family, row.phase)) : t(`plan.resType.${row.entity.type}`), row.entity.title, formatTime(row.time))))
        : el('p.field-hint', {}, t('plan.panelEmpty')),
      callHook('dayPanel', { entry, context: { space, plan } }),
    ]);
  }
  const schedule = () => { if (!frame) frame = setTimeout(render, 0); };
  const offs = [
    plan.subscribe((_state, patch) => { if ('day' in patch) schedule(); }),
    space.subscribe((event) => { if (['day', 'res', 'visit', 'dayNote'].some((type) => event.types.has(type))) schedule(); }),
  ];
  render();
  return () => { clearTimeout(frame); for (const off of offs) off(); };
}

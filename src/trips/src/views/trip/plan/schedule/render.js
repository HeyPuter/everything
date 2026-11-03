import { el } from '../../../../ui/dom.js';
import { t } from '../../../../lib/i18n/index.js';
import { formatDistance, formatDuration, formatTime } from '../../../../lib/format.js';
import { icon } from '../icons.js';

/** A local time, with `(+1)` when it falls after midnight (or `(-1)` before the day, past the date line). */
export function wallText(wall) {
  if (!wall) return '';
  const time = formatTime(wall.time);
  return wall.offset ? t('schedule.nextDay', { time, offset: wall.offset > 0 ? `+${wall.offset}` : String(wall.offset) }) : time;
}

export function warningText(warning, nameOf = () => '') {
  switch (warning.code) {
    case 'overlap': return t('schedule.warn.overlap', { name: nameOf(warning.with) });
    case 'endBeforeStart': return t('schedule.warn.endBeforeStart');
    case 'closed': return t(warning.allDay ? 'schedule.warn.closedDay' : 'schedule.warn.closed');
    case 'travel': return t(warning.estimated ? 'schedule.warn.travelEstimated' : 'schedule.warn.travel', { needed: formatDuration(warning.needed), available: formatDuration(warning.available) });
    case 'late': return t('schedule.warn.late', { duration: formatDuration(warning.minutes) });
    case 'checkin': return t('schedule.warn.checkin', { name: warning.res?.title ?? '', time: formatTime(warning.until) });
    case 'overrun':
      if (warning.day) return warning.until ? t('schedule.warn.overrunUntil', { time: formatTime(warning.until) }) : t('schedule.warn.overrun');
      return t('schedule.warn.overrunItem');
    default: return '';
  }
}

const warningNode = (text) => el('p.sched-warn', {}, icon('warning', 14), el('span.sr-only', {}, `${t('schedule.warning')}: `), el('span', {}, text));
const line = (name, text) => el('p.sched-line', {}, icon(name, 14), el('span', {}, text));

/** Travel to a stop: "12 min · 1.1 km", prefixed with "About" for straight-line estimates. */
export function travelText(travel) {
  if (!travel) return '';
  const duration = formatDuration(travel.minutes);
  if (Number.isFinite(travel.distance) && travel.distance > 0) {
    return t(travel.estimated ? 'schedule.legEstimated' : 'schedule.leg', { duration, distance: formatDistance(travel.distance) });
  }
  return t(travel.estimated ? 'schedule.legTimeEstimated' : 'schedule.legTime', { duration });
}

/**
 * Details under a timeline row: estimated times for untimed items, time spent, travel when no connector shows it,
 * leaving and returning to the stay, and warnings. `info` is one entry of the `annotate` map.
 */
export function rowDetail(info, nameOf) {
  if (!info) return null;
  const { day } = info;
  const meta = [];
  const lines = [];
  if (info.first && day.leave) {
    const values = { name: day.leave.res.title, time: wallText(day.leave.wall) };
    lines.push(line('bed-double', day.leave.travel ? t('schedule.leaveTravel', { ...values, duration: travelText(day.leave.travel) }) : t('schedule.leave', values)));
  } else if (!info.connected && info.travel?.minutes > 0) meta.push(t('schedule.travelBefore', { duration: travelText(info.travel) }));
  const stored = info.kind === 'visit' ? info.entity.start : info.row.time;
  if (info.flexible && info.startWall && !stored) meta.push(t('schedule.estimate', { start: wallText(info.startWall), end: wallText(info.endWall) }));
  else if (info.kind === 'visit' && info.fixed && info.endWall && !info.row.end && !info.openEnd) meta.push(t('schedule.until', { time: wallText(info.endWall) }));
  if (info.kind === 'visit' && !info.openEnd && !info.openStart && !(info.row.time && info.row.end)) meta.push(t('schedule.dwell', { duration: formatDuration(info.dwell) }));
  if (info.fixed && !info.first && !info.connected && info.wait >= 15) meta.push(t('schedule.free', { duration: formatDuration(info.wait) }));
  for (const warning of info.warnings) lines.push(warningNode(warningText(warning, nameOf)));
  if (info.last && day.back) lines.push(line('bed-double', t('schedule.back', { name: day.back.res.title, time: wallText(day.back.wall) })));
  if (info.last) for (const warning of day.warnings) lines.push(warningNode(warningText({ ...warning, day: true }, nameOf)));
  if (!meta.length && !lines.length) return null;
  return el('div.sched-detail', {}, meta.length ? el('p.sched-meta.num', {}, meta.join(' · ')) : null, lines);
}

/** Travel time and distance on the connector between two visits. */
export function connector(target) {
  if (!target?.travel) return null;
  const parts = [travelText(target.travel)];
  if (target.fixed && target.wait >= 5) parts.push(t('schedule.free', { duration: formatDuration(target.wait) }));
  return el('span.sched-leg.num', {}, parts.join(' · '));
}

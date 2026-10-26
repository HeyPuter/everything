// A proposal as a diff-style card: one row per change with its sign, then Apply/Reject while it waits.
// Every value from the model or the trip is set as text.
import { el, uid } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDate, formatNumber, formatTime } from '../../../lib/format.js';
import { icon } from './icons.js';

const SIGNS = { add: '+', move: '→', change: '~', skip: '=', warn: '!' };

export function dayText(day) {
  if (!day) return '';
  return day.date ? t('assistant.dayDate', { n: day.n, date: formatDate(day.date, { weekday: true, year: false }) }) : t('assistant.dayNumber', { n: day.n });
}
const timeRange = (start, end) => [formatTime(start), formatTime(end)].filter(Boolean).join('–');
const dateRange = (start, end) => [formatDate(start), end && end !== start ? formatDate(end) : ''].filter(Boolean).join(' – ');

/** `{main, meta}` for one preview row. */
export function rowText({ key, values = {} }) {
  const name = values.name ?? '';
  switch (key) {
    case 'assistant.row.visit':
    case 'assistant.row.item': return { main: name, meta: timeRange(values.time, values.end) };
    case 'assistant.row.schedule': return { main: t(key, { name, day: dayText(values.day) }), meta: timeRange(values.time, values.end) };
    case 'assistant.row.move': return { main: t(key, { name, from: dayText(values.from), to: dayText(values.to) }), meta: t('assistant.row.position', { n: formatNumber(values.position) }) };
    case 'assistant.row.reorder': return { main: t(key, { name, day: dayText(values.day) }), meta: t('assistant.row.position', { n: formatNumber(values.position) }) };
    case 'assistant.row.place': return { main: name, meta: values.address ?? '' };
    case 'assistant.row.pack': return {
      main: values.qty > 1 ? t('assistant.row.packQty', { name, qty: formatNumber(values.qty) }) : name,
      meta: [values.list ? t('assistant.row.inList', { list: values.list }) : '', values.assigned ? t('assistant.row.assignedToYou') : ''].filter(Boolean).join(' · '),
    };
    case 'assistant.row.todo': return {
      main: name,
      meta: [values.due ? t('assistant.row.due', { date: formatDate(values.due) }) : '', values.list ? t('assistant.row.inList', { list: values.list }) : ''].filter(Boolean).join(' · '),
    };
    case 'assistant.row.dates': return { main: t(key, { from: dateRange(values.fromStart, values.fromEnd), to: dateRange(values.toStart, values.toEnd) }), meta: '' };
    case 'assistant.row.datesNew': return { main: t(key, { to: dateRange(values.toStart, values.toEnd) }), meta: '' };
    default: return { main: t(key, { name, list: values.list ?? '' }), meta: '' };
  }
}

function noteText({ key, values = {} }) {
  if (key === 'assistant.note.shift') {
    const days = Math.abs(values.days);
    return t(values.days >= 0 ? 'assistant.note.later' : 'assistant.note.earlier', { days: formatNumber(days) });
  }
  if (key === 'assistant.note.length') return t(key, { from: formatNumber(values.from), to: formatNumber(values.to) });
  return t(key, values);
}

function titleText(proposal) {
  const { key, values = {} } = proposal.title;
  return t(key, { ...values, day: dayText(values.day) });
}

const STATUS = {
  planning: 'assistant.status.planning', waiting: 'assistant.status.waiting', applying: 'assistant.status.applying', applied: 'assistant.status.applied',
  declined: 'assistant.status.declined', failed: 'assistant.status.failed', skipped: 'assistant.status.skipped', suggested: 'assistant.status.suggested',
};

/**
 * `step` is a proposal step from the assistant. Handlers: `onDecide(step, approved)`, `onUndo(step)`; `undo` is
 * `'available' | 'done' | null`; `handoff` says a date suggestion opens the trip's re-date flow.
 */
export function proposalCard(step, { onDecide, onUndo, undo = null, handoff = false }) {
  const titleId = uid('as-card');
  const proposal = step.proposal;
  const card = el('section.as-card', { 'aria-labelledby': titleId, dataset: { status: step.status, step: step.id } });
  const suggestion = Boolean(proposal?.suggestion);
  card.append(el('header.as-card-head', {},
    icon(suggestion ? 'dates' : 'sparkles', 16),
    el('h3.as-card-title', { id: titleId }, proposal ? titleText(proposal) : t('assistant.status.planning')),
    el('span.as-chip', { dataset: { status: step.status } }, t(STATUS[step.status] ?? 'assistant.status.planning'))));
  if (!proposal) return card;
  if (step.changed && step.status === 'waiting') card.append(el('p.as-card-note', { role: 'status' }, t('assistant.changedNotice')));
  card.append(el('ul.as-diff', { 'aria-label': t('assistant.changes') }, proposal.rows.map((row) => {
    const { main, meta } = rowText(row);
    return el('li.as-row', { dataset: { sign: row.sign } },
      el('span.as-sign', { 'aria-hidden': 'true' }, SIGNS[row.sign] ?? '•'),
      el('span.as-row-text', {}, el('span.sr-only', {}, `${t(`assistant.sign.${row.sign}`)}: `), el('span', {}, main), meta && el('span.as-row-meta', {}, ` · ${meta}`)));
  })));
  if (proposal.notes?.length) card.append(el('ul.as-notes', {}, proposal.notes.map((note) => el('li', {}, noteText(note)))));
  if (suggestion) card.append(el('p.as-card-note', {}, t(handoff ? 'assistant.redateHint' : 'assistant.redateManual')));
  if (step.status === 'waiting') {
    card.append(el('div.as-card-actions', {},
      button(t(suggestion ? (handoff ? 'assistant.openRedate' : 'assistant.noted') : 'assistant.approve'), { variant: 'primary', size: 'sm', icon: 'check', dataset: { action: 'approve' }, onclick: () => onDecide(step, true) }),
      button(t(suggestion ? 'assistant.dismiss' : 'assistant.reject'), { variant: 'outline', size: 'sm', dataset: { action: 'reject' }, onclick: () => onDecide(step, false) })));
  } else if (step.status === 'failed' && step.error) {
    card.append(el('p.as-card-error', {}, t('assistant.applyFailed')));
  } else if (step.status === 'applied' && undo) {
    card.append(el('div.as-card-actions', {}, undo === 'done'
      ? el('span.as-card-note', {}, t('assistant.undone'))
      : button(t('assistant.undo'), { variant: 'ghost', size: 'sm', dataset: { action: 'undo' }, onclick: () => onUndo(step) })));
  }
  return card;
}

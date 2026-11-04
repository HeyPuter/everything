/**
 * Column stats: a quick profile of one column — counts, sum and average,
 * spread, the most frequent values, and a small distribution.
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { colName } from '../core/cell.js';
import { formatGeneral, formatValue, dateTimeKind } from '../core/format.js';
import { columnStats } from '../core/stats.js';
import { looksLikeHeader } from './sortdialog.js';
import { t, formatList } from '../i18n/index.js';

export function openColumnStats(ctx, col) {
  const sheetId = ctx.sheetId();
  const wb = ctx.wb;
  const sheet = wb.sheet(sheetId);
  const used = wb.usedRange(sheetId);
  if (!used) return null;
  const body = el('div.colstats');
  let c = Math.max(used.c1, Math.min(used.c2, col));
  // The date or time style most of the column's numbers carry, if any: its
  // summary then reads as dates, as the cells do, not as their serial numbers.
  const dateStyleOf = (range) => {
    const kinds = new Map();
    for (let r = range.r1; r <= range.r2; r++) {
      const cell = wb.getCell(sheetId, r, c);
      if (!cell || (cell.v == null && cell.f == null)) continue;
      const v = cell.f != null ? wb.getValue(sheetId, r, c) : cell.v;
      if (typeof v !== 'number') continue;
      const kind = dateTimeKind(cell.s, v);
      const entry = kinds.get(kind) || { count: 0, style: cell.s };
      entry.count++;
      kinds.set(kind, entry);
    }
    let best = null;
    for (const [kind, entry] of kinds) if (!best || entry.count > best.entry.count) best = { kind, entry };
    return best?.kind ? { kind: best.kind, style: best.entry.style } : null;
  };
  const render = (focusStep = null) => {
    const wholeUsed = { r1: used.r1, c1: c, r2: used.r2, c2: c };
    const header = looksLikeHeader(wb, sheetId, { r1: used.r1, c1: used.c1, r2: used.r2, c2: used.c2 });
    const range = header ? { ...wholeUsed, r1: used.r1 + 1 } : wholeUsed;
    const title = header ? wb.getDisplay(sheetId, used.r1, c) : '';
    const s = columnStats(wb, sheetId, c, range);
    const dated = s.numbers ? dateStyleOf(range) : null;
    const fmt = (n) => (n == null ? '–' : dated ? formatValue(n, dated.style) : formatGeneral(n));
    // Dates do not add up; the distance between two of them is a number of days.
    const spread = dated && dated.kind !== 'time' ? t('colstats.days', { days: formatGeneral(s.max - s.min) }) : fmt(s.max - s.min);
    const stat = (label, value) => el('div.stat', {}, el('span.stat-label', {}, label), el('span.stat-value', {}, value));
    const maxCount = Math.max(1, ...s.top.map((top) => top.count));
    const maxBucket = Math.max(1, ...s.buckets.map((b) => b.count));
    const bucketText = (b) => t('colstats.bucket', { from: fmt(b.from), to: fmt(b.to), count: b.count });
    body.replaceChildren(...[
      el('div.colstats-head', {},
        el('button.icon-btn', { type: 'button', html: icon('chevL', 16), 'aria-label': t('colstats.previousColumn'), dataset: { step: 'previous' }, disabled: c <= used.c1, onclick: () => { c--; render('previous'); } }),
        el('div.colstats-title', {}, el('strong', {}, t('colstats.column', { name: colName(c) })), title ? el('span.muted', {}, ` · ${title}`) : null),
        el('button.icon-btn', { type: 'button', html: icon('chevR', 16), 'aria-label': t('colstats.nextColumn'), dataset: { step: 'next' }, disabled: c >= used.c2, onclick: () => { c++; render('next'); } })),
      el('div.stat-grid', {},
        stat(t('colstats.filled'), String(s.count)), stat(t('colstats.empty'), String(s.empty)), stat(t('colstats.unique'), String(s.unique)),
        stat(t('colstats.numbers'), String(s.numbers)), stat(t('colstats.text'), String(s.textCount)), stat(t('colstats.errors'), String(s.errors))),
      s.numbers ? el('div.stat-grid', {},
        dated ? null : stat(t('colstats.sum'), fmt(s.sum)), stat(t('colstats.average'), fmt(s.avg)), stat(t('colstats.median'), fmt(s.median)),
        stat(t('colstats.min'), fmt(s.min)), stat(t('colstats.max'), fmt(s.max)), stat(t('colstats.range'), spread)) : null,
      s.buckets.length ? el('div.field', {}, el('span.field-label', {}, t('colstats.distribution')),
        // The bars are a picture; its words are the buckets, as the tooltips give them.
        el('div.hist', { role: 'img', 'aria-label': t('colstats.distributionLabel', { buckets: formatList(s.buckets.map(bucketText), { type: 'conjunction', style: 'narrow' }) }) }, ...s.buckets.map((b) => el('div.hist-bar', { title: bucketText(b), style: { height: `${Math.max(2, (b.count / maxBucket) * 100)}%` } }))),
        el('div.hist-axis', {}, el('span', {}, fmt(s.buckets[0].from)), el('span', {}, fmt(s.buckets[s.buckets.length - 1].to)))) : null,
      s.top.length ? el('div.field', {}, el('span.field-label', {}, t('colstats.mostFrequent')),
        el('div.freq', {}, ...s.top.map((top) => el('div.freq-row', {},
          el('span.freq-value', { title: top.value }, top.value),
          el('span.freq-bar', {}, el('span.freq-fill', { style: { width: `${(top.count / maxCount) * 100}%` } })),
          el('span.freq-count', {}, String(top.count)))))) : el('p.small.muted', {}, t('colstats.columnEmpty')),
      el('p.small.muted', {}, header ? t('colstats.rowsBelowHeaderOn', { count: range.r2 - range.r1 + 1, sheet: sheet.name }) : t('colstats.rowsOn', { count: range.r2 - range.r1 + 1, sheet: sheet.name })),
    ].filter(Boolean));
    if (focusStep) {
      const target = body.querySelector(`button[data-step="${focusStep}"]:not(:disabled)`)
        || body.querySelector('.colstats-head button:not(:disabled)');
      target?.focus({ preventScroll: true });
    }
  };
  render();
  return openModal({ title: t('colstats.title'), content: body, onClose: () => ctx.grid?.focus?.() });
}

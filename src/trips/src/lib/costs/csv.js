import { fromMinor } from '../../shared/money.js';
import { decimalSeparator } from './input.js';
import { expenseView, toTrip } from './ledger.js';

const NUMBER = /^-?\d+(?:[.,]\d+)?$/;

/** One CSV cell: quoted when needed, and text that a spreadsheet would run as a formula is prefixed with '. */
export function csvCell(value) {
  let text = value === undefined || value === null ? '' : String(value);
  if (!NUMBER.test(text) && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Semicolon-separated rows with a UTF-8 byte order mark and CRLF line ends. */
export function toCsv(rows) {
  return `﻿${rows.map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`;
}

/**
 * The ledger as CSV rows. `label(key)` translates the fixed words (keys listed in `CSV_LABELS`), `name(who)` and
 * `category(id)` resolve display names, and `people` sets the per-person share columns (trip currency).
 */
export function costsRows({ expenses = [], privateExpenses = [], settlements = [], tripCurrency, people = [], name, category, label, locale = 'en' }) {
  const comma = decimalSeparator(locale) === ',';
  const decimal = (text) => (comma ? text.replace('.', ',') : text);
  const money = (amount, currency) => (amount === null || amount === undefined ? '' : decimal(fromMinor(amount, currency)));
  const rate = (entity) => (entity.currency === tripCurrency ? '' : typeof entity.rate === 'string' ? decimal(entity.rate) : label('pending'));
  const header = [label('type'), label('date'), label('name'), label('category'), label('amount'), label('currency'), label('rate'),
    `${label('tripAmount')} (${tripCurrency})`, label('paidBy'), label('split'), ...people.map((who) => name(who)), label('note')];
  const rows = [header];
  const sortKey = (entity) => `${entity.date ?? '9999-99-99'}|${entity.order ?? ''}|${entity.cr ?? entity.upd ?? 0}`;
  const all = [...expenses.map((exp) => ({ exp, kind: 'expense' })), ...privateExpenses.map((exp) => ({ exp, kind: 'private' }))]
    .sort((a, b) => (sortKey(a.exp) < sortKey(b.exp) ? -1 : sortKey(a.exp) > sortKey(b.exp) ? 1 : 0));
  for (const { exp, kind } of all) {
    let view = null;
    try { view = expenseView(exp, tripCurrency); } catch { view = null; }
    const shares = new Map((view?.trip?.shares ?? []).map((share) => [share.who, share.amount]));
    const paidBy = exp.payers.length ? exp.payers.map((payer) => `${name(payer.who)} ${money(payer.amount, exp.currency)}`).join(', ') : label('unpaid');
    rows.push([
      label(kind), exp.date ?? '', exp.name, category(exp.cat), money(exp.amount, exp.currency), exp.currency,
      rate(exp), view ? money(view.total, tripCurrency) : '',
      paidBy, label(`mode.${exp.split.mode}`), ...people.map((who) => (shares.has(who) ? money(shares.get(who), tripCurrency) : '')), exp.note ?? '',
    ]);
  }
  for (const settle of [...settlements].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))) {
    let amount = null;
    try { amount = toTrip(settle.amount, settle, tripCurrency); } catch { amount = null; }
    rows.push([
      label('settlement'), settle.date ?? '', `${name(settle.from)} → ${name(settle.to)}`, '', money(settle.amount, settle.currency), settle.currency,
      rate(settle), money(amount, tripCurrency), name(settle.from), '',
      ...people.map(() => ''), settle.note ?? '',
    ]);
  }
  return rows;
}

export const CSV_LABELS = Object.freeze(['type', 'date', 'name', 'category', 'amount', 'currency', 'rate', 'tripAmount', 'paidBy', 'split', 'note',
  'expense', 'private', 'settlement', 'unpaid', 'pending', 'mode.equal', 'mode.amounts', 'mode.percent', 'mode.shares', 'mode.items']);

/** A file name for the export from the trip title. */
export function csvFileName(title, today) {
  const base = String(title ?? '').normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'trip';
  return `${base} costs ${today}.csv`;
}

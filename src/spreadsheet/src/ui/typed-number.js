/**
 * Numbers typed into the fields of the what-if and analysis dialogs (Solver, Data Analysis, Forecast Sheet): read
 * as a cell reads them in the regional format, and shown in it.
 */
import { parseInput, editText, typedDateKind } from '../core/format.js';

/**
 * A number typed into a field: in the regional format, as a cell reads one (1,5 where the decimal mark is a comma,
 * 1.234,5 grouped, 5%), or written with a full stop as stored models and defaults write them; null when the text
 * is no number (or reads as a date or time, which no such field asks for).
 */
export function typedNumber(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const parsed = parseInput(t);
  if (typeof parsed.v === 'number' && !typedDateKind(parsed)) return parsed.v;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A number as such a field shows it: in the regional format, every digit kept (as a cell opened for editing). */
export const numberShown = (v) => editText({ v, f: null });

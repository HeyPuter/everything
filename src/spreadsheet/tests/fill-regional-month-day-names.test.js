import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { setLocale } from '../src/core/format.js';

afterEach(() => setLocale('en-US'));

// The fill handle went round English month and weekday names only: under Deutsch a dragged Januar or
// Montag was repeated (Januar, Januar, Januar), where Excel continues Februar, März, as it does Jan, Feb.
function filled(seeds, target) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  seeds.forEach((seed, i) => wb.setInput(id, i, 0, seed));
  wb.fill(id, parseRange(`A1:A${seeds.length}`), parseRange(target));
  const n = parseRange(target);
  return Array.from({ length: n.r2 - n.r1 + 1 }, (_, i) => wb.getValue(id, n.r1 + i, 0));
}

it('continues the regional format\'s month and weekday names', () => {
  setLocale('de-DE');
  expect(filled(['Januar'], 'A1:A4')).toEqual(['Januar', 'Februar', 'März', 'April']);
  expect(filled(['Samstag'], 'A1:A3')).toEqual(['Samstag', 'Sonntag', 'Montag']);
  expect(filled(['Nov', 'Dez'], 'A1:A4')).toEqual(['Nov', 'Dez', 'Jan', 'Feb']);
  setLocale('fr-FR');
  expect(filled(['lundi', 'mercredi'], 'A1:A4')).toEqual(['lundi', 'mercredi', 'vendredi', 'dimanche']);
  expect(filled(['mars'], 'A1:A3')).toEqual(['mars', 'avril', 'mai']);
  setLocale('es-ES');
  expect(filled(['Diciembre'], 'A1:A3')).toEqual(['Diciembre', 'Enero', 'Febrero']);
});

it('keeps English names on their English series in every regional format', () => {
  setLocale('de-DE');
  expect(filled(['Mar'], 'A1:A3')).toEqual(['Mar', 'Apr', 'May']);
  expect(filled(['Friday'], 'A1:A3')).toEqual(['Friday', 'Saturday', 'Sunday']);
  setLocale('en-US');
  expect(filled(['Januar'], 'A1:A3')).toEqual(['Januar', 'Januar', 'Januar']);
});

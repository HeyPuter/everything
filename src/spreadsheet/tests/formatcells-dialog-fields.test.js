// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { openFormatCellsDialog } from '../src/ui/formatcells.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  closeAllModals();
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** Opens the dialog on A1 of a fresh workbook styled `style`, on `panel`, recording what Apply runs. */
function open(style, panel) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '1234.5');
  wb.applyStyle(id, parseRange('A1'), style);
  const runs = [];
  const ctx = {
    wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }), range: () => parseRange('A1:A1'),
    style: () => wb.getCell(id, 0, 0)?.s || {}, run: (cmd, arg) => runs.push([cmd, arg]), grid: { editing: false, focus() {}, commitEdit() {} },
  };
  const modal = openFormatCellsDialog(ctx, { panel });
  const field = (label) => modal.panel.querySelector(`[aria-label="${label}"]`);
  const check = (label) => [...modal.panel.querySelectorAll('label')].find((node) => node.textContent.trim() === label).querySelector('input');
  const apply = () => modal.panel.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  return { modal, runs, field, check, apply };
}

// A size or font the lists did not carry showed as the first entry (9, Default), so the tab
// misreported the cell, and picking that first entry changed nothing.
it('shows a size and a font missing from the lists as the cell has them, and applies a change away from them', () => {
  const { runs, field, apply } = open({ size: 15, font: 'Comic Sans' }, 'font');
  expect(field('Size').value).toBe('11.25'); // 15px, shown in points
  expect(field('Font').value).toBe('Comic Sans');
  const sizes = [...field('Size').options].map((option) => Number(option.value));
  expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  expect(sizes.filter((size) => size === 11.25)).toHaveLength(1);
  field('Size').value = '9';
  field('Size').dispatchEvent(new Event('change'));
  apply();
  expect(runs).toEqual([['applyFormat', { patch: { size: 12 }, border: null }]]); // 9pt
});

// The Custom category with nothing typed applied the code 0, rounding the cell to a whole number.
it('asks for a format code before applying a custom format that has none', () => {
  const { modal, runs, field, apply } = open({}, 'align');
  field('Category').value = 'custom';
  field('Category').dispatchEvent(new Event('change'));
  apply();
  expect(runs).toEqual([]);
  expect(modal.panel.closest('.modal-root').classList.contains('closing')).toBe(false);
  const error = modal.panel.querySelector('.field-error');
  expect(error.hidden).toBe(false);
  expect(error.textContent).toBe('Enter a format code');
  expect(modal.panel.querySelector('[role="tab"][aria-selected="true"]').textContent).toBe('Number');
  expect(document.activeElement).toBe(field('Format code'));
  field('Format code').value = '0.0';
  field('Format code').dispatchEvent(new Event('input'));
  expect(error.hidden).toBe(true);
  apply();
  expect(runs).toEqual([['applyFormat', { patch: { fmt: 'custom', code: '0.0', dec: null, dateStyle: null, group: null, cur: null, sec: null }, border: null }]]);
});

// Unchecking No fill, Automatic color or Default color without touching the swatch left the
// colour empty, which reads as none or automatic again, so Apply changed nothing.
it('applies the swatch colour when a none or automatic box is unchecked and the swatch is left alone', () => {
  const fill = open({}, 'fill');
  fill.check('No fill').click();
  fill.apply();
  expect(fill.runs).toEqual([['applyFormat', { patch: { bg: '#fef3c7' }, border: null }]]);
  const font = open({}, 'font');
  font.check('Automatic color').click();
  font.apply();
  expect(font.runs).toEqual([['applyFormat', { patch: { color: '#0b0b0b' }, border: null }]]);
  const border = open({}, 'border');
  border.check('Default color').click();
  [...border.field('Border presets').querySelectorAll('button')].find((b) => b.textContent === 'Outline').click();
  border.apply();
  expect(border.runs).toEqual([['applyFormat', { patch: {}, border: null, borders: ['top', 'bottom', 'left', 'right'].map((kind) => ({ kind, color: '#0b0b0b', style: 'thin', perSide: true })) }]]);
});

it('shows imported automatic text color and applies an explicit swatch when unchecked', () => {
  const font = open({ color: 'windowtext' }, 'font');
  expect(font.check('Automatic color').checked).toBe(true);
  font.check('Automatic color').click();
  font.apply();
  expect(font.runs).toEqual([['applyFormat', { patch: { color: '#0b0b0b' }, border: null }]]);
});

it('sets automatic color explicitly when replacing an RGB color', () => {
  const font = open({ color: '#327689' }, 'font');
  expect(font.check('Automatic color').checked).toBe(false);
  font.check('Automatic color').click();
  font.apply();
  expect(font.runs).toEqual([['applyFormat', { patch: { color: 'windowtext' }, border: null }]]);
});

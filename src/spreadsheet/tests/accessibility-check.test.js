// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { checkAccessibility, accessibilityStatus, contrastRatio, groupFindings } from '../src/core/accessibility-check.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { openAltTextDialog } from '../src/ui/alttext.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as X from '../src/vendor/xlsx.mjs';

vi.stubGlobal('Blob', NodeBlob);
vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { closeAllModals(); document.body.replaceChildren(); });

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const rules = (wb) => checkAccessibility(wb).map((f) => `${f.severity}:${f.rule}:${f.label}`);

describe('Check Accessibility', () => {
  it('reports no issues on a plain workbook', () => {
    const wb = new Workbook();
    wb.setInput(wb.activeSheetId, 0, 0, 'Synthetic');
    expect(checkAccessibility(wb)).toEqual([]);
    expect(accessibilityStatus([])).toBe('No issues');
  });

  it('finds objects without alt text, merged cells, low contrast text and default sheet names, errors first', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'Light'); wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { color: '#bbbbbb' });
    wb.setInput(id, 1, 0, 'Readable'); wb.applyStyle(id, { r1: 1, c1: 0, r2: 1, c2: 0 }, { color: '#333333', bg: '#ffffff' });
    wb.setInput(id, 2, 0, 'Merged'); wb.mergeCells(id, { r1: 2, c1: 0, r2: 2, c2: 2 });
    const chart = wb.addChart(id, { type: 'text', text: 'Callout', anchor: { r: 5, c: 5 }, w: 120, h: 40 });
    wb.addChart(id, { type: 'text', text: 'Flourish', anchor: { r: 8, c: 5 }, w: 120, h: 40, decorative: true });
    wb.addSheet();
    const found = rules(wb);
    expect(found).toEqual([
      'error:altText:Text Box 1 (Sheet1)',
      'warning:merged:A3:C3 (Sheet1)',
      'warning:contrast:A1 (Sheet1)',
      'tip:sheetName:Sheet1',
    ]);
    expect(accessibilityStatus(checkAccessibility(wb))).toBe('Review suggested');
    const groups = groupFindings(checkAccessibility(wb));
    expect(groups.map((g) => [g.severity, g.count])).toEqual([['error', 1], ['warning', 2], ['tip', 1]]);
    expect(groups[0].rules[0]).toMatchObject({ label: 'Object has no description', how: expect.stringContaining('alt text') });
    // Describing the object clears its error.
    wb.updateChart(id, chart, { description: 'A note on the totals' }, 'Edit alt text');
    expect(rules(wb).some((f) => f.startsWith('error:'))).toBe(false);
  });

  it('measures contrast as WCAG does and lets large text pass at 3:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'Heading');
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { color: '#777777', size: 24 }); // 18pt
    expect(checkAccessibility(wb)).toEqual([]);
  });
});

describe('Alt Text', () => {
  it('describes an object or marks it decorative, as one undo step each', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const box = wb.addChart(id, { type: 'text', text: 'Callout', anchor: { r: 1, c: 1 }, w: 120, h: 40 });
    wb.clearHistory();
    const ctx = { wb, sheetId: () => id, grid: { focus: vi.fn() } };
    let modal = openAltTextDialog(ctx, box);
    const text = modal.panel.querySelector('[aria-label="Alt text description"]');
    text.value = 'Totals are estimates';
    modal.panel.querySelector('form').requestSubmit();
    expect(wb.chartById(id, box).description).toBe('Totals are estimates');
    expect(wb.undoLabels()).toEqual(['Edit alt text']);
    modal = openAltTextDialog(ctx, box);
    expect(modal.panel.querySelector('[aria-label="Alt text description"]').value).toBe('Totals are estimates');
    const decorative = [...modal.panel.querySelectorAll('label.find-option')].find((n) => n.textContent === 'Mark as decorative').querySelector('input');
    decorative.click();
    modal.panel.querySelector('form').requestSubmit();
    expect(wb.chartById(id, box).decorative).toBe(true);
    wb.undo();
    expect(wb.chartById(id, box).decorative).toBeUndefined();
  });

  it('saves a picture\'s and a text box\'s alt text in the XLSX drawing', async () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.addChart(id, { type: 'image', src: PNG, anchor: { r: 1, c: 1 }, w: 40, h: 40, description: 'Company logo' });
    wb.addChart(id, { type: 'text', text: 'Callout', anchor: { r: 6, c: 1 }, w: 120, h: 40, description: 'Callout about totals' });
    const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
    const zip = X.CFB.read(bytes, { type: 'array' });
    const drawing = new TextDecoder().decode(X.CFB.find(zip, '/xl/drawings/drawing1.xml').content);
    expect(drawing).toContain('descr="Company logo"');
    expect(drawing).toContain('descr="Callout about totals"');
    const back = await workbookFromFile(bytes, 'alt.xlsx');
    const objects = back.sheets[0].charts;
    expect(objects.find((o) => o.type === 'image')).toMatchObject({ description: 'Company logo' });
    expect(objects.find((o) => o.type === 'text')).toMatchObject({ description: 'Callout about totals' });
    expect(checkAccessibility(back).filter((f) => f.rule === 'altText')).toEqual([]);
  });
});

describe('object order', () => {
  it('brings an object to the front or sends it to the back, with undo', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const a = wb.addChart(id, { type: 'text', text: 'A', anchor: { r: 0, c: 0 } });
    const b = wb.addChart(id, { type: 'text', text: 'B', anchor: { r: 0, c: 0 } });
    const order = () => wb.sheet(id).charts.map((ch) => ch.text);
    expect(order()).toEqual(['A', 'B']);
    expect(wb.orderChart(id, a, 'front')).toBe(true);
    expect(order()).toEqual(['B', 'A']);
    expect(wb.orderChart(id, a, 'front')).toBe(false);
    expect(wb.orderChart(id, a, 'back')).toBe(true);
    expect(order()).toEqual(['A', 'B']);
    wb.undo();
    expect(order()).toEqual(['B', 'A']);
    expect(b).toBeTruthy();
  });
});

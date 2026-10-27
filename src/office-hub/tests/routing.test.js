import { describe, expect, it } from 'vitest';
import { OFFICE_APPS, routeFile, suggestOpenUrl } from '../src/engine/routing.js';

describe('office hub routing', () => {
  it('lists core office apps', () => {
    expect(OFFICE_APPS.map((a) => a.id).sort()).toEqual([
      'documents',
      'pdf',
      'presentation',
      'spreadsheet',
    ]);
  });

  it('routes extensions', () => {
    expect(routeFile('Report.DOCX')?.id).toBe('documents');
    expect(routeFile('budget.xlsx')?.id).toBe('spreadsheet');
    expect(routeFile('deck.pptx')?.id).toBe('presentation');
    expect(routeFile('scan.PDF')?.id).toBe('pdf');
    expect(routeFile('nope.bin')).toBeNull();
  });

  it('suggests open URLs', () => {
    expect(suggestOpenUrl('a.csv')).toMatch(/spreadsheet/);
    expect(suggestOpenUrl('x')).toBeNull();
  });
});

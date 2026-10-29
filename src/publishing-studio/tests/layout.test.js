import { describe, expect, it } from 'vitest';
import {
  addMasterFrame,
  addPage,
  addPageFrame,
  columnize,
  createDocument,
  exportPdf,
  resolvedFrames,
} from '../src/engine/layout.js';

describe('publishing layout', () => {
  it('creates a document with a master and page', () => {
    const doc = createDocument();
    expect(doc.masters).toHaveLength(1);
    expect(doc.pages).toHaveLength(1);
  });

  it('resolves master + page frames', () => {
    let doc = createDocument();
    doc = addPageFrame(doc, 'page-1', {
      x: 54,
      y: 100,
      w: 500,
      h: 200,
      text: 'Body copy here',
      columns: 2,
    });
    expect(resolvedFrames(doc, 'page-1').length).toBeGreaterThanOrEqual(2);
  });

  it('columnizes text', () => {
    const cols = columnize('one two three four five six', 2);
    expect(cols).toHaveLength(2);
    expect(cols[0]).toContain('one');
  });

  it('exports a PDF string with header', () => {
    const pdf = exportPdf(createDocument());
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('%%EOF');
  });

  it('adds pages and master frames', () => {
    let doc = createDocument();
    doc = addPage(doc, 'master-a');
    doc = addMasterFrame(doc, 'master-a', {
      x: 54,
      y: 700,
      w: 500,
      h: 20,
      text: 'Footer',
      columns: 1,
    });
    expect(doc.pages).toHaveLength(2);
    expect(doc.masters[0].frames.some((f) => f.text === 'Footer')).toBe(true);
  });
});

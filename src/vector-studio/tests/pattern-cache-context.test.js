import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCanvasStub } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { addPattern, updatePattern, findPattern, patternView, PATTERN_DEFAULTS } from '../src/features/patterns/model.js';
import { cellBitmap, patternCss, rememberPatterns } from '../src/features/patterns/render.js';

function colorOf(canvas) {
  const fill = canvas.getContext('2d').fillStyle;
  return typeof fill === 'string' ? fill : fill?.canvas ? colorOf(fill.canvas) : null;
}
beforeEach(() => {
  installCanvasStub();
  const getContext = HTMLCanvasElement.prototype.getContext;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
    const ctx = getContext.call(this);
    ctx.createPattern = (canvas) => ({ canvas, setTransform() {} });
    return ctx;
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function () { return `data:image/png,${colorOf(this)}`; });
  vi.stubGlobal('navigator', { userAgent: 'Pattern preview test' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function art(fill) {
  const node = createPath(rectangle(0, 0, 10, 10), true, { fill, stroke: null });
  return { roots: [node.id], nodes: [node] };
}
function setup() {
  const doc = VDocument.create();
  let inner, outer;
  doc.transact('Patterns', () => {
    inner = addPattern(doc, { ...PATTERN_DEFAULTS, id: 'inner', width: 10, height: 10, art: art({ type: 'solid', color: '#ff0000' }) });
    outer = addPattern(doc, { ...PATTERN_DEFAULTS, id: 'outer', width: 10, height: 10, art: art({ type: 'pattern', id: 'inner' }) });
  });
  const blue = () => doc.transact('Blue', () => updatePattern(doc, inner.id, { art: art({ type: 'solid', color: '#0000ff' }) }));
  return { doc, inner, outer, blue };
}

describe('Pattern cache document context', () => {
  it('refreshes nested definitions in a cached artwork view', () => {
    const { doc, inner, outer, blue } = setup();
    patternView(doc, outer);
    blue();
    expect(findPattern(patternView(doc, outer), inner.id)).toBe(findPattern(doc, inner.id));
  });
  it('redraws nested pattern colors and follows undo/redo', () => {
    const { doc, outer, blue } = setup();
    expect(colorOf(cellBitmap(doc, outer, 1).canvas)).toBe('#ff0000');
    blue();
    expect(colorOf(cellBitmap(doc, outer, 1).canvas)).toBe('#0000ff');
    doc.undo();
    expect(colorOf(cellBitmap(doc, outer, 1).canvas)).toBe('#ff0000');
    doc.redo();
    expect(colorOf(cellBitmap(doc, outer, 1).canvas)).toBe('#0000ff');
  });
  it('does not share bitmaps across documents with different nested definitions', () => {
    const { doc, outer } = setup();
    expect(colorOf(cellBitmap(doc, outer, 1).canvas)).toBe('#ff0000');
    const other = VDocument.create();
    other.transact('Patterns', () => {
      addPattern(other, { ...PATTERN_DEFAULTS, id: 'inner', width: 10, height: 10, art: art({ type: 'solid', color: '#0000ff' }) });
      // Library definitions can be shared objects across documents.
      other.updateRoot({ patterns: [...other.root.patterns, outer] });
    });
    expect(colorOf(cellBitmap(other, outer, 1).canvas)).toBe('#0000ff');
  });
  it('refreshes document swatch thumbnails after an inner pattern changes', () => {
    const { doc, outer, blue } = setup();
    const paint = { type: 'pattern', id: outer.id };
    expect(patternCss(paint, doc)).toContain('#ff0000');
    blue();
    expect(patternCss(paint, doc)).toContain('#0000ff');
  });
  it('refreshes library thumbnails when remembered nested definitions change', () => {
    const { doc, outer, blue } = setup();
    const paint = { type: 'pattern', id: outer.id };
    rememberPatterns(doc.root.patterns);
    expect(patternCss(paint)).toContain('#ff0000');
    blue();
    rememberPatterns(doc.root.patterns);
    expect(patternCss(paint)).toContain('#0000ff');
  });
  it('reuses the bitmap and view when the document context is unchanged', () => {
    const { doc, outer } = setup();
    const view = patternView(doc, outer);
    const bitmap = cellBitmap(doc, outer, 1);
    expect(patternView(doc, outer)).toBe(view);
    expect(cellBitmap(doc, outer, 1)).toBe(bitmap);
  });
  it('keeps cached bitmaps when an unrelated pattern is edited', () => {
    const { doc, outer } = setup();
    const bitmap = cellBitmap(doc, outer, 1);
    doc.transact('Unrelated', () => addPattern(doc, { ...PATTERN_DEFAULTS, id: 'unrelated', art: art({ type: 'solid', color: '#00ff00' }) }));
    expect(cellBitmap(doc, outer, 1)).toBe(bitmap);
  });
});

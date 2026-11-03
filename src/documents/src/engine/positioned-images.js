import { EMU_PER_PX, drawingOffsetPixels, normalizedRotation, ANGLE_PER_DEGREE } from './images.js';
import { referencePageGeometry } from './page-settings.js';

export function positionedImageContains(frame, x, y) {
  const rotation = normalizedRotation(frame.image.rotation);
  if (!rotation) return x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height;
  const angle = rotation / ANGLE_PER_DEGREE * Math.PI / 180;
  const dx = x - frame.x - frame.width / 2, dy = y - frame.y - frame.height / 2;
  const localX = dx * Math.cos(angle) + dy * Math.sin(angle), localY = -dx * Math.sin(angle) + dy * Math.cos(angle);
  return Math.abs(localX) <= frame.width / 2 + 1e-7 && Math.abs(localY) <= frame.height / 2 + 1e-7;
}

/**
 * A shape or group drawing's own rotation (its a:xfrm rot, §20.1.7.6), which its image does not carry: the
 * drawing's frame is the unrotated extent, turned about its center. 0 for pictures, lines and other drawings.
 */
export function drawingOwnRotation(image, assets) {
  if (!image?.retainedDrawing || image.rotation || image.flatLine || image.flatGroup) return 0;
  const scene = assets?.[image.assetId]?.scene;
  return normalizedRotation(scene?.shapeRotation || scene?.groupRotation || 0);
}

export function positionedImageBounds(frame) {
  const rotation = normalizedRotation(frame.image.rotation);
  if (!rotation) return { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
  const angle = rotation / ANGLE_PER_DEGREE * Math.PI / 180;
  const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  const width = frame.width * c + frame.height * s, height = frame.width * s + frame.height * c;
  return { x: frame.x + (frame.width - width) / 2, y: frame.y + (frame.height - height) / 2, width, height };
}

// Resolve retained DrawingML coordinates after pagination, using the geometry
// of the anchor's section/page. Frame dimensions exclude effect extents.
export function positionedImageFrame(fragment, first, page, cell = null) {
  const image = fragment.image, a = image.anchor;
  if (a.horizontal === 'margin') page = referencePageGeometry(page);
  const dimension = (axis, leading, trailing) => {
    const relative = a.relativeSize?.[axis];
    const size = relative ? (page[axis] - (relative.base === 'margin' ? page[leading] + page[trailing] : 0)) * relative.percentage / 100000 - ((image.effectExtent?.[leading] || 0) + (image.effectExtent?.[trailing] || 0)) / EMU_PER_PX : image[axis] / EMU_PER_PX;
    if (!(size <= 22 * 96 && (size > 0 || size === 0 && (image.flatLine || image.flatGroup) && !relative))) throw new Error('Relative image dimensions must be positive and no larger than 22 inches.');
    return size;
  };
  const width = dimension('width', 'left', 'right'), height = dimension('height', 'top', 'bottom');
  // A standalone picture fits into the relative box without stretching.
  // Alignment still uses the requested box; groups scale each axis separately.
  const scale = image.relativeSizeFit ? Math.min(width * EMU_PER_PX / image.width, height * EMU_PER_PX / image.height) : null;
  const frameSize = scale === null ? { width, height } : { width: image.width * scale / EMU_PER_PX, height: image.height * scale / EMU_PER_PX };
  const outsideCell = cell && a.layoutInCell === false && (page.compatibilityMode ?? 12) < 15;
  const left = a.horizontal === 'page' ? 0 : a.horizontal === 'column' && !outsideCell ? first.columnLeft ?? page.left : page.left;
  const right = a.horizontal === 'column' && !outsideCell ? first.columnRight ?? page.width - page.right : page.width - (a.horizontal === 'page' ? 0 : page.right);
  // Legacy out-of-cell page/paragraph anchors use the physical row's top,
  // excluding cell padding and preceding paragraphs (native multirow controls).
  // Body margin coordinates follow header/footer-expanded writing bounds.
  // Page-edge and margin-band coordinates retain the physical page geometry.
  const top = ['page', 'topMargin'].includes(a.vertical) ? 0 : a.vertical === 'bottomMargin' ? page.height - page.bottom : a.vertical === 'paragraph'
    ? outsideCell && ['page', 'margin'].includes(a.horizontal) ? cell.y : first.y - (first.anchorBefore || 0)
    : a.vertical === 'line' ? first.y
    : a.vertical === 'margin' ? page.drawingBounds?.top ?? page.top : page.top;
  const bottom = a.vertical === 'topMargin' ? page.top : a.vertical === 'margin' ? page.drawingBounds?.bottom ?? page.height - page.bottom : page.height - (['page', 'bottomMargin'].includes(a.vertical) ? 0 : page.bottom);
  const align = (value, start, end, size, offset) => value === 'center' ? (start + end - size) / 2 : ['right', 'bottom'].includes(value) ? end - size : start + drawingOffsetPixels(offset);
  const extent = image.effectExtent || {};
  const leadingX = (extent.left || 0) / EMU_PER_PX, leadingY = (extent.top || 0) / EMU_PER_PX;
  // A positive relative size on either axis makes numeric offsets address the
  // effect box on both axes. Fixed-size offsets still address the shape itself.
  // Independent reference controls: tests/fixtures/relative-anchor-effects.
  const relativeOffset = !!a.relativeSize;
  const percentX = a.xPercentage !== undefined, percentY = a.yPercentage !== undefined;
  if (cell && isPageBasedCellPosition(image) && (a.layoutInCell !== false || (page.compatibilityMode ?? 12) >= 15)) {
    // Page/margin coordinates resolve against the physical cell. Column
    // coordinates, and margin X paired with paragraph Y, include the left cell
    // margin. Page-relative vertical offsets include the top margin.
    // Anchor alignment is ignored; cell alignment translates both content and
    // drawing bounds. wrapNone neither grows nor clips to the row. Compatibility mode 15
    // and later also applies this with layoutInCell=false.
    const cellLeft = cell.x + (a.horizontal === 'column' || a.horizontal === 'margin' && a.vertical === 'paragraph' ? (cell.margins?.left || 0) / 15 : 0);
    const percentLeft = cell.x + (a.horizontal === 'page' ? 0 : (cell.margins?.left || 0) / 15);
    const percentWidth = cell.width - (a.horizontal === 'page' ? 0 : ((cell.margins?.left || 0) + (cell.margins?.right || 0)) / 15);
    const x = (percentX ? percentLeft + percentWidth * a.xPercentage / 100000 : align(a.xAlign, cellLeft, cell.x + cell.width, width + leadingX + (extent.right || 0) / EMU_PER_PX, a.x)) + (a.xAlign || relativeOffset || percentX ? leadingX : 0);
    // A paragraph-relative Y follows the actual anchor paragraph, including
    // cell alignment. Page-relative Y remains tied to the physical cell top.
    // The vertical percentage is ignored inside a cell, retaining the
    // content's top and the effect-box inset. A numeric companion axis still
    // uses its ordinary offset (native mixed-axis controls).
    const y = (a.vertical === 'paragraph' && !percentY ? top : cell.y + (cell.margins?.top || 0) / 15 + (first.cellAlignmentShift || 0)) + drawingOffsetPixels(a.y) + (relativeOffset || percentY ? leadingY : 0);
    return { ...fragment, page: first.page, x, y, ...frameSize };
  }
  // A column percentage spans the full writing width, starting at the
  // anchor column's left edge (independent two-column native control).
  const percentageWidth = a.horizontal === 'column' ? page.width - page.left - page.right : right - left;
  let x = (percentX ? left + percentageWidth * a.xPercentage / 100000 : align(a.xAlign, left, right, width + leadingX + (extent.right || 0) / EMU_PER_PX, a.x)) + (a.xAlign || relativeOffset || percentX ? leadingX : 0);
  // Paragraph/line percentages use the writing span as their scale, starting
  // at the paragraph/line origin. Header/footer clearance changes that span.
  const writingSpan = (page.drawingBounds?.bottom ?? page.height - page.bottom) - (page.drawingBounds?.top ?? page.top);
  const percentageHeight = ['paragraph', 'line'].includes(a.vertical) ? writingSpan : bottom - top;
  const y = (percentY ? top + percentageHeight * a.yPercentage / 100000 : align(a.yAlign, top, bottom, height + leadingY + (extent.bottom || 0) / EMU_PER_PX, a.y)) + (a.yAlign || relativeOffset || percentY ? leadingY : 0);
  // Compatibility modes before 15 (also the absent-mode default) clamps page-right
  // alignment at the writing area's right edge. Numeric offsets are unaffected.
  if ((page.compatibilityMode ?? 12) < 15 && a.horizontal === 'page' && a.xAlign === 'right') x = Math.min(x, page.width - page.right);
  return { ...fragment, page: first.page, x, y, ...frameSize };
}

export function isPageBasedCellPosition(image) {
  const a = image.anchor;
  return a?.wrap === 'none' && (a.xPercentage !== undefined || a.yPercentage !== undefined || ['page', 'margin'].includes(a.horizontal) && ['page', 'margin', 'topMargin', 'bottomMargin'].includes(a.vertical)
    // Numeric column/page coordinates use the same physical-cell reference in
    // compatibility mode 15 and later; legacy layoutInCell=false still uses the page's column.
    || a.horizontal === 'column' && a.vertical === 'page' && !a.xAlign && !a.yAlign
    || ['page', 'margin'].includes(a.horizontal) && a.vertical === 'paragraph' && !a.xAlign && !a.yAlign);
}

export function isCellRelativePosition(image) {
  const a = image.anchor;
  return a.horizontal === 'column' && a.vertical === 'paragraph' && !a.xAlign && !a.yAlign;
}

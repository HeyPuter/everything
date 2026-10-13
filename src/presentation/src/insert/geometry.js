// Layout arithmetic for photo albums and zooms, in EMU (or any unit).

export const ALBUM_LAYOUTS = [
  ["fit", "Fit to slide", 1, false],
  ["1", "1 picture", 1, false],
  ["2", "2 pictures", 2, false],
  ["4", "4 pictures", 4, false],
  ["1t", "1 picture with title", 1, true],
  ["2t", "2 pictures with title", 2, true],
  ["4t", "4 pictures with title", 4, true],
];
export const ALBUM_FRAMES = [
  ["rect", "Rectangle"],
  ["roundRect", "Rounded Rectangle"],
  ["whiteFrame", "Simple Frame, White"],
  ["blackFrame", "Simple Frame, Black"],
  ["shadow", "Soft Shadow"],
  ["ellipse", "Oval"],
];

/**
 * Where pictures go on an album slide, in EMU: one box per picture, inside
 * the area the layout leaves (below a title when it has one, above captions).
 */
export function albumBoxes(layout, count, size, captions) {
  const [, , perSlide, titled] = ALBUM_LAYOUTS.find(([id]) => id === layout);
  const cx = size.cx,
    cy = size.cy;
  if (layout === "fit") return [{ x: 0, y: 0, w: cx, h: cy }];
  const margin = cx * 0.05;
  const top = titled ? cy * 0.2 : cy * 0.07;
  const bottom = cy * 0.06 + (captions ? cy * 0.07 : 0);
  const area = { x: margin, y: top, w: cx - margin * 2, h: cy - top - bottom };
  const gap = cx * 0.025;
  const cols = perSlide === 1 ? 1 : 2;
  const rows = perSlide === 4 ? 2 : 1;
  const cellW = (area.w - gap * (cols - 1)) / cols;
  const cellH =
    (area.h - gap * (rows - 1) - (captions && rows > 1 ? cy * 0.07 : 0)) / rows;
  const boxes = [];
  for (let i = 0; i < Math.min(count, perSlide); i++) {
    const c = i % cols,
      r = Math.floor(i / cols);
    boxes.push({
      x: area.x + c * (cellW + gap),
      y: area.y + r * (cellH + gap + (captions && rows > 1 ? cy * 0.07 : 0)),
      w: cellW,
      h: cellH,
    });
  }
  return boxes;
}

/** A picture's box inside a cell, keeping its proportions. */
export function containBox(cell, width, height) {
  const scale = Math.min(cell.w / width, cell.h / height);
  const w = width * scale,
    h = height * scale;
  return { x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - h) / 2, w, h };
}

/** A grid of slide boxes of the given aspect inside an area. */
export function zoomGrid(count, area, aspect) {
  const cols = Math.max(
    1,
    Math.ceil(Math.sqrt((count * (area.w / area.h)) / aspect)),
  );
  const rows = Math.ceil(count / cols);
  const gap = area.w * 0.03;
  const w = Math.min(
    (area.w - gap * (cols - 1)) / cols,
    ((area.h - gap * (rows - 1)) / rows) * aspect,
  );
  const h = w / aspect;
  const totalW = cols * w + (cols - 1) * gap,
    totalH = rows * h + (rows - 1) * gap;
  return Array.from({ length: count }, (_, i) => ({
    x: Math.round(area.x + (area.w - totalW) / 2 + (i % cols) * (w + gap)),
    y: Math.round(
      area.y + (area.h - totalH) / 2 + Math.floor(i / cols) * (h + gap),
    ),
    w: Math.round(w),
    h: Math.round(h),
  }));
}

// Page layouts for printing and PDF export: full-page slides, notes pages,
// an outline, and handouts with 1 to 9 slides a page. Pure geometry: a page
// is a size in points (1/72 inch) and a list of items placed on it, which
// the print preview, the printed pages and the PDF writer each draw.
//
//   layoutPages(slides, options) → [{ width, height, items }]
//
// slides: [{ number, title, notes, outline: [{ text, level }] }], in order.
// Items:
//   { kind: "slide", slide, x, y, w, h, frame }   slide = index into `slides`
//   { kind: "text", text, x, y, size, bold, color, align }   y = baseline
//   { kind: "line", x1, y1, x2, y2, width, color }
//   { kind: "rect", x, y, w, h, width, color }

export const PAPER_SIZES = {
  slide: { label: "Slide size", width: null, height: null },
  letter: { label: "US Letter", width: 612, height: 792 },
  legal: { label: "US Legal", width: 612, height: 1008 },
  a4: { label: "A4", width: 595.28, height: 841.89 },
  a3: { label: "A3", width: 841.89, height: 1190.55 },
};

export const LAYOUTS = [
  ["slides", "Full page slides"],
  ["notes", "Notes pages"],
  ["outline", "Outline"],
  ["handouts", "Handouts"],
];
export const HANDOUT_COUNTS = [1, 2, 3, 4, 6, 9];

const EMU_PER_PT = 12700;
const MARGIN = 36;
const TEXT = "#000000";
const RULE = "#9a9a9a";
const FRAME = "#5f5f5f";

// Default orientation for a layout on paper: notes pages, outlines and most
// handouts read top to bottom on a portrait sheet.
export function defaultOrientation(layout, perPage, slideAspect = 16 / 9) {
  if (layout === "slides") return slideAspect >= 1 ? "landscape" : "portrait";
  if (layout === "handouts" && perPage === 1)
    return slideAspect >= 1 ? "landscape" : "portrait";
  return "portrait";
}

export function pageSize({
  paper = "slide",
  orientation,
  layout = "slides",
  perPage = 6,
  slideWidth,
  slideHeight,
}) {
  const sw = slideWidth / EMU_PER_PT,
    sh = slideHeight / EMU_PER_PT;
  const size = PAPER_SIZES[paper] || PAPER_SIZES.slide;
  if (!size.width) {
    // "Slide size" paper is the slide itself for slides; other layouts
    // use a page with the slide's long edge on the portrait sheet's short side.
    if (layout === "slides") return { width: sw, height: sh };
    const long = Math.max(sw, sh);
    const portrait = { width: long, height: long * (11 / 8.5) };
    const orient =
      orientation || defaultOrientation(layout, perPage, sw / sh) || "portrait";
    return orient === "landscape"
      ? { width: portrait.height, height: portrait.width }
      : portrait;
  }
  const orient =
    orientation || defaultOrientation(layout, perPage, sw / sh) || "portrait";
  const [a, b] = [size.width, size.height];
  return orient === "landscape"
    ? { width: Math.max(a, b), height: Math.min(a, b) }
    : { width: Math.min(a, b), height: Math.max(a, b) };
}

// Fits a w×h box inside the area, centered.
function fit(area, aspect) {
  let w = area.w,
    h = w / aspect;
  if (h > area.h) {
    h = area.h;
    w = h * aspect;
  }
  return {
    x: area.x + (area.w - w) / 2,
    y: area.y + (area.h - h) / 2,
    w,
    h,
  };
}

// Greedy word wrap; a word wider than the line breaks between characters.
export function wrapText(text, maxWidth, measure) {
  const lines = [];
  for (const paragraph of String(text ?? "").split(/\r\n|\r|\n|\v/)) {
    const words = paragraph.split(/(\s+)/).filter((w) => w.length);
    let line = "";
    const push = () => {
      lines.push(line.replace(/\s+$/, ""));
      line = "";
    };
    if (!words.length) {
      lines.push("");
      continue;
    }
    for (const word of words) {
      const candidate = line + word;
      if (!line || measure(candidate) <= maxWidth) {
        if (!line && /^\s+$/.test(word)) continue;
        if (measure(candidate) <= maxWidth) {
          line = candidate;
          continue;
        }
      } else if (/^\s+$/.test(word)) {
        push();
        continue;
      } else {
        push();
        if (measure(word) <= maxWidth) {
          line = word;
          continue;
        }
      }
      // A word too long for a whole line breaks between characters.
      for (const ch of Array.from(word)) {
        if (line && measure(line + ch) > maxWidth) push();
        line += ch;
      }
    }
    push();
  }
  return lines;
}

// A rough measure for when no font metrics are at hand: an average
// proportional glyph is about half an em wide.
export const approximateMeasure = (text, size = 12, bold = false) =>
  Array.from(String(text)).length * size * (bold ? 0.56 : 0.52);

function headerFooterItems(page, options, pageNumber) {
  const items = [];
  const { header, footer, date, pageNumbers } = options.headerFooter || {};
  const size = 9;
  const top = MARGIN / 2 + size;
  const bottom = page.height - MARGIN / 2;
  if (header)
    items.push({
      kind: "text",
      text: header,
      x: MARGIN,
      y: top,
      size,
      color: TEXT,
    });
  if (date)
    items.push({
      kind: "text",
      text: date,
      x: page.width - MARGIN,
      y: top,
      size,
      color: TEXT,
      align: "right",
    });
  if (footer)
    items.push({
      kind: "text",
      text: footer,
      x: MARGIN,
      y: bottom,
      size,
      color: TEXT,
    });
  if (pageNumbers)
    items.push({
      kind: "text",
      text: String(pageNumber),
      x: page.width - MARGIN,
      y: bottom,
      size,
      color: TEXT,
      align: "right",
    });
  return items;
}

function slidePages(slides, options, page) {
  const aspect = options.slideWidth / options.slideHeight;
  const paper = options.paper || "slide";
  const margin = paper === "slide" ? 0 : options.scaleToFit ? 18 : 0;
  return slides.map((_, i) => {
    let box;
    if (paper === "slide") box = { x: 0, y: 0, w: page.width, h: page.height };
    else if (options.scaleToFit)
      box = fit(
        {
          x: margin,
          y: margin,
          w: page.width - margin * 2,
          h: page.height - margin * 2,
        },
        aspect,
      );
    else {
      // Actual size, centered; a slide larger than the paper is cut off.
      const w = options.slideWidth / EMU_PER_PT,
        h = options.slideHeight / EMU_PER_PT;
      box = { x: (page.width - w) / 2, y: (page.height - h) / 2, w, h };
    }
    return {
      ...page,
      items: [{ kind: "slide", slide: i, ...box, frame: !!options.frame }],
    };
  });
}

function textBlock(lines, { x, width, size, bold, measure, indent = 0 }) {
  const out = [];
  for (const line of wrapText(lines, width - indent, (t) =>
    measure(t, size, bold),
  ))
    out.push({ text: line, x: x + indent, size, bold });
  return out;
}

// Lays text lines down a page, starting new pages as they fill. `first`
// is the page already started (with its top already used up to `top`).
function flow(lines, { page, top, bottom, newPage, lineGap = 1.35 }) {
  const pages = [page];
  let y = top,
    pageTop = top;
  for (const line of lines) {
    const advance = line.size * lineGap + (line.spaceBefore || 0);
    // A line that would cross the bottom starts a new page, unless the page
    // is still empty (a line taller than a page is placed anyway).
    if (y + advance > bottom && y > pageTop) {
      page = newPage();
      pages.push(page);
      y = pageTop = page.top;
    }
    y += advance;
    const baseline = y - line.size * (lineGap - 1);
    if (line.number)
      page.items.push({
        kind: "text",
        text: line.number,
        x: MARGIN + 12,
        y: baseline,
        size: line.size,
        bold: true,
        color: TEXT,
      });
    if (line.text)
      page.items.push({
        kind: "text",
        text: line.text,
        x: line.x,
        y: baseline,
        size: line.size,
        bold: !!line.bold,
        color: TEXT,
      });
  }
  return pages;
}

function notesPages(slides, options, size, measure) {
  const aspect = options.slideWidth / options.slideHeight;
  const pages = [];
  const textX = MARGIN + 18;
  const textWidth = size.width - textX * 2;
  for (const [i, s] of slides.entries()) {
    const half = size.height * 0.46;
    const box = fit(
      {
        x: MARGIN + 18,
        y: MARGIN + 18,
        w: size.width - (MARGIN + 18) * 2,
        h: half - MARGIN - 18,
      },
      aspect,
    );
    const page = {
      ...size,
      items: [{ kind: "slide", slide: i, ...box, frame: true }],
    };
    const lines = textBlock(s.notes || "", {
      x: textX,
      width: textWidth,
      size: 12,
      measure,
    });
    const top = box.y + box.h + 28;
    const bottom = size.height - MARGIN - 12;
    const made = flow(s.notes && s.notes.trim() ? lines : [], {
      page,
      top,
      bottom,
      newPage: () => ({ ...size, items: [], top: MARGIN + 12 }),
    });
    pages.push(...made);
  }
  return pages;
}

function outlinePages(slides, options, size, measure) {
  const x = MARGIN + 12;
  const width = size.width - x * 2;
  const lines = [];
  for (const s of slides) {
    const titleLines = textBlock(s.title || `Slide ${s.number}`, {
      x,
      width,
      size: 14,
      bold: true,
      measure,
      indent: 28,
    });
    titleLines[0].number = String(s.number);
    titleLines[0].spaceBefore = lines.length ? 10 : 0;
    lines.push(...titleLines);
    for (const p of s.outline || [])
      lines.push(
        ...textBlock(p.text, {
          x,
          width,
          size: 12,
          measure,
          indent: 28 + 22 * (Math.max(0, p.level || 0) + 1),
        }),
      );
  }
  return flow(lines, {
    page: { ...size, items: [] },
    top: MARGIN + 12,
    bottom: size.height - MARGIN - 12,
    newPage: () => ({ ...size, items: [], top: MARGIN + 12 }),
  });
}

// Handout grids: how many columns and rows each count takes on a portrait
// sheet; a landscape sheet turns the grid.
const HANDOUT_GRID = {
  1: [1, 1],
  2: [1, 2],
  3: [1, 3],
  4: [2, 2],
  6: [2, 3],
  9: [3, 3],
};
export function handoutGrid(perPage, orientation) {
  const [cols, rows] = HANDOUT_GRID[perPage] || HANDOUT_GRID[6];
  return orientation === "landscape" && perPage !== 3
    ? [rows, cols]
    : [cols, rows];
}

function handoutPages(slides, options, size) {
  const perPage = HANDOUT_GRID[options.perPage] ? options.perPage : 6;
  const orientation = size.width > size.height ? "landscape" : "portrait";
  const aspect = options.slideWidth / options.slideHeight;
  const [cols, rows] = handoutGrid(perPage, orientation);
  const hasHeader =
    options.headerFooter?.header || options.headerFooter?.date ? 18 : 0;
  const hasFooter =
    options.headerFooter?.footer || options.headerFooter?.pageNumbers ? 18 : 0;
  const area = {
    x: MARGIN,
    y: MARGIN + hasHeader,
    w: size.width - MARGIN * 2,
    h: size.height - MARGIN * 2 - hasHeader - hasFooter,
  };
  const withLines = perPage === 3;
  const gap = 18;
  const pages = [];
  for (let start = 0; start < slides.length; start += perPage) {
    const page = { ...size, items: [] };
    const count = Math.min(perPage, slides.length - start);
    for (let k = 0; k < count; k++) {
      // Horizontal order fills each row in turn, vertical each column.
      const col =
        options.order === "vertical" ? Math.floor(k / rows) : k % cols;
      const row =
        options.order === "vertical" ? k % rows : Math.floor(k / cols);
      let cell;
      let lineArea = null;
      if (withLines && orientation === "portrait") {
        const h = (area.h - gap * (rows - 1)) / rows;
        const w = area.w * 0.48;
        cell = { x: area.x, y: area.y + row * (h + gap), w, h };
        lineArea = {
          x: area.x + w + gap,
          y: cell.y,
          w: area.w - w - gap,
          h,
        };
      } else if (withLines) {
        const w = (area.w - gap * 2) / 3;
        cell = { x: area.x + k * (w + gap), y: area.y, w, h: area.h * 0.42 };
        lineArea = {
          x: cell.x,
          y: area.y + area.h * 0.42 + gap,
          w,
          h: area.h * 0.58 - gap,
        };
      } else {
        const w = (area.w - gap * (cols - 1)) / cols;
        const h = (area.h - gap * (rows - 1)) / rows;
        cell = {
          x: area.x + col * (w + gap),
          y: area.y + row * (h + gap),
          w,
          h,
        };
      }
      const box = fit(cell, aspect);
      if (withLines && orientation === "portrait") box.x = cell.x;
      if (withLines && orientation === "landscape") box.y = cell.y;
      page.items.push({
        kind: "slide",
        slide: start + k,
        ...box,
        frame: !!options.frame,
      });
      if (options.slideNumbers)
        page.items.push({
          kind: "text",
          text: String(slides[start + k].number),
          x: box.x,
          y: box.y + box.h + 11,
          size: 8,
          color: TEXT,
        });
      if (lineArea) {
        const top =
          withLines && orientation === "portrait" ? box.y : lineArea.y;
        const bottom =
          withLines && orientation === "portrait"
            ? box.y + box.h
            : lineArea.y + lineArea.h;
        const spacing = 22;
        for (let y = top + spacing; y <= bottom + 0.5; y += spacing)
          page.items.push({
            kind: "line",
            x1: lineArea.x,
            y1: y,
            x2: lineArea.x + lineArea.w,
            y2: y,
            width: 0.6,
            color: RULE,
          });
      }
    }
    pages.push(page);
  }
  return pages;
}

export function layoutPages(slides, options) {
  const measure = options.measure || approximateMeasure;
  const layout = options.layout || "slides";
  const size = pageSize({ ...options, layout });
  let pages;
  if (layout === "notes") pages = notesPages(slides, options, size, measure);
  else if (layout === "outline")
    pages = outlinePages(slides, options, size, measure);
  else if (layout === "handouts") pages = handoutPages(slides, options, size);
  else pages = slidePages(slides, options, size);
  if (!pages.length) return pages;
  const decorate = layout !== "slides";
  pages.forEach((page, n) => {
    delete page.top;
    if (decorate) page.items.push(...headerFooterItems(page, options, n + 1));
    if (options.frame && layout === "slides")
      for (const item of page.items)
        if (item.kind === "slide") item.frame = true;
  });
  return pages;
}

export const FRAME_COLOR = FRAME;

// Picks slides by a range such as "1-3, 5, 8-": numbers are 1-based slide
// numbers in the deck. Returns sorted unique indices, or null when the text
// is not a range.
export function parseSlideRange(text, total) {
  const value = String(text || "").trim();
  if (!value) return null;
  const out = new Set();
  for (const part of value.split(/[,;]+/)) {
    const piece = part.trim();
    if (!piece) continue;
    const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(piece);
    if (m) {
      const from = m[1] ? Number(m[1]) : 1;
      const to = m[2] ? Number(m[2]) : total;
      if (from < 1 || to < from) return null;
      for (let n = from; n <= Math.min(to, total); n++) out.add(n - 1);
    } else if (/^\d+$/.test(piece)) {
      const n = Number(piece);
      if (n < 1) return null;
      if (n <= total) out.add(n - 1);
    } else return null;
  }
  return [...out].sort((a, b) => a - b);
}

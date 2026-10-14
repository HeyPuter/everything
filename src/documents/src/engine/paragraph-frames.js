import { paragraphText } from './model.js';
import { shiftTableItem } from './table-overlap.js';
import { borderOutset } from './paragraph-borders.js';

// §17.3.1.11: adjacent paragraphs with identical frame properties share a
// frame. Keep attribute presence: an omitted value and an explicit value are
// not interchangeable when deciding ownership or serializing the package.
export const frameSignature = properties => JSON.stringify(Object.entries(properties).sort(([a], [b]) => a.localeCompare(b)));
// Native inline-flow, cell-inline and footer controls establish that this
// legacy declaration remains an ordinary paragraph. Explicit x/y or sizing
// still creates a frame; do not discard the retained property element.
export const inlineFrameDeclaration = properties => properties?.yAlign === 'inline' &&
  !['x','y','w','h'].some(key => Object.hasOwn(properties, key));
export class UnsupportedParagraphFrameError extends Error {
  constructor(message, paragraphs) { super(message); this.paragraphIds = paragraphs.map(p => p.id); }
}
export function paragraphFrameGroups(blocks) {
  const groups = [], byParagraph = new Map();
  for (let index = 0; index < blocks.length;) {
    // Shape text has its own text-box flow. Explicit framePr inside a shape
    // remains rejected by the shape reader; inherited legacy declarations
    // must not turn an existing text box into a body floating frame.
    const block = blocks[index], properties = !block.paragraph?.drawingText && block.paragraph?.frameProperties;
    if (!properties || inlineFrameDeclaration(properties)) { index++; continue; }
    const signature = frameSignature(properties), members = [block];
    let end = index + 1;
    while (end < blocks.length && !blocks[end].paragraph?.drawingText && blocks[end].paragraph?.frameProperties &&
      !members.at(-1).paragraph.sectionEnd && frameSignature(blocks[end].paragraph.frameProperties) === signature) members.push(blocks[end++]);
    let next = end;
    while (!blocks[next]?.paragraph?.drawingText && blocks[next]?.paragraph?.frameProperties && !inlineFrameDeclaration(blocks[next].paragraph.frameProperties)) next++;
    const anchor = blocks[next]?.paragraph;
    const group = { properties, members, anchorId: anchor?.id || `frame-anchor:${members.at(-1).paragraph.id}`, terminal: !anchor };
    groups.push(group); for (const member of members) byParagraph.set(member.paragraph.id, group);
    index = end;
  }
  return { groups, byParagraph };
}

function distance(properties, name, signed = false) {
  const raw = properties[name] ?? '0';
  if (!/^[+-]?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || !signed && Number(raw) < 0) throw new Error(`Invalid paragraph-frame ${name}.`);
  return Number(raw) / 15;
}
export function frameDimensions(properties) {
  const width = distance(properties, 'w'), declaredHeight = distance(properties, 'h');
  const hSpace = distance(properties, 'hSpace'), vSpace = distance(properties, 'vSpace');
  // Documented deviations from §17.3.1.11 ([MS-OI29500]), confirmed by independent
  // native controls: omitted anchors use text; a positive height defaults to
  // atLeast; zero height uses automatic sizing even with an explicit rule.
  // Resolve layout defaults here without adding attributes to the source.
  const declaredHRule = properties.hRule || (declaredHeight ? 'atLeast' : 'auto'), wrap = properties.wrap || 'around';
  const hAnchor = properties.hAnchor || 'text', vAnchor = properties.vAnchor || 'text';
  if (!['auto', 'atLeast', 'exact'].includes(declaredHRule) || !['around', 'notBeside', 'auto', 'none'].includes(wrap) ||
    !['page', 'margin', 'column', 'text'].includes(hAnchor) || !['page', 'margin', 'text'].includes(vAnchor)) throw new Error('These paragraph-frame dimensions, wrapping or anchors are not supported yet.');
  const dropCap = properties.dropCap && properties.dropCap !== 'none' ? properties.dropCap : null;
  if (dropCap && !['drop', 'margin'].includes(dropCap)) throw new Error(`Drop-cap frames of type "${dropCap}" are not supported.`);
  // §17.3.1.11 lines: an omitted count is one line. Larger counts are not
  // produced by desktop word processors and would only enlarge the exclusion.
  const lines = dropCap ? Number(properties.lines ?? 1) : 0;
  if (dropCap && (!/^\d+$/.test(properties.lines ?? '1') || lines < 1 || lines > 10)) throw new Error('Drop-cap frames must span 1–10 lines.');
  if (properties.xAlign && !['left', 'right', 'center', 'inside', 'outside'].includes(properties.xAlign) ||
    properties.yAlign && !['top', 'bottom', 'center', 'inside', 'outside', 'inline'].includes(properties.yAlign)) throw new Error('This paragraph-frame alignment is not supported yet.');
  // With an explicit size rule but no h, w is used as the requested height.
  // Preserve the distinction between omission and an explicit zero height.
  const height = Object.hasOwn(properties, 'h') ? declaredHeight : declaredHRule === 'auto' ? 0 : width;
  const hRule = height ? declaredHRule : 'auto';
  // A drop cap is located at the start of the next paragraph; its anchors and
  // offsets are retained in the source but do not position it (see dropCapBox).
  if (dropCap) return { width, height, hSpace, vSpace, hRule, wrap, hAnchor, vAnchor: 'text', x: 0, y: 0, dropCap, lines };
  return { width, height, hSpace, vSpace, hRule, wrap, hAnchor, vAnchor, x: distance(properties, 'x', true), y: distance(properties, 'y', true) };
}

/**
 * §17.3.1.11 dropCap, §17.18.20 ST_DropCap: the frame starts at the top of the
 * following paragraph's first line and is exactly `lines` of its lines tall.
 * The cap's visible baseline (including any w:position lowering) is aligned to
 * the baseline of line `lines`, so the frame paragraph's exact spacing and
 * position only need to be approximately right. "drop" sits at the text
 * column's leading edge and text wraps around it; "margin" ends hSpace before
 * that edge and does not displace text. Lines beyond a short paragraph are
 * extrapolated from its first line's pitch.
 */
function dropCapBox(frame, placed, anchor, page) {
  const { lines: count, dropCap, hSpace } = frame.dimensions;
  const own = placed.lines.filter(l => l.paragraphId === frame.anchorId && l.page === anchor.page && !l.frameId);
  const first = own[0] || anchor, before = first.wrapBefore || 0, pitch = first.height - before, nth = own[count - 1];
  const top = first.y + before, bottom = nth ? nth.y + nth.height : top + count * pitch;
  const baseline = nth ? nth.baseline : first.baseline + (count - 1) * pitch;
  const capLine = frame.lines[0], text = capLine?.fragments.find(f => !f.image);
  const capBaseline = capLine ? capLine.baseline - (text?.baselineShift || 0) * 4 / 3 : 0;
  const left = anchor.columnLeft ?? page.left;
  return { x: dropCap === 'margin' ? left - frame.width - hSpace : left, y: baseline - capBaseline, top, bottom };
}

// Native independent controls establish absolute-position precedence
// when x/y and xAlign/yAlign are both supplied, contrary to §17.3.1.11.
export function paragraphFramePosition(properties, dimensions, page, anchor, width, height) {
  const { hAnchor, vAnchor } = dimensions;
  const left = hAnchor === 'page' ? 0 : hAnchor === 'margin' ? page.left : anchor.columnLeft ?? page.left;
  const right = hAnchor === 'page' ? page.width : hAnchor === 'margin' ? page.width - page.right : left + (anchor.columnWidth ?? page.width - page.left - page.right);
  const top = vAnchor === 'page' ? 0 : vAnchor === 'margin' ? page.top : anchor.y - (anchor.anchorBefore || 0);
  const bottom = vAnchor === 'page' ? page.height : page.height - page.bottom;
  let x = left + dimensions.x, y = top + dimensions.y;
  let horizontal = properties.xAlign, vertical = properties.yAlign;
  if (horizontal === 'inside') horizontal = (anchor.page % 2) ? 'right' : 'left';
  if (horizontal === 'outside') horizontal = (anchor.page % 2) ? 'left' : 'right';
  if (vertical === 'inside') vertical = (anchor.page % 2) ? 'bottom' : 'top';
  if (vertical === 'outside') vertical = (anchor.page % 2) ? 'top' : 'bottom';
  if (!Object.hasOwn(properties, 'x')) x = horizontal === 'center' ? (left + right - width) / 2 : horizontal === 'right' ? right - width : left;
  if (!Object.hasOwn(properties, 'y') && vAnchor !== 'text') y = vertical === 'center' ? (top + bottom - height) / 2 : vertical === 'bottom' ? bottom - height : top;
  return { x, y };
}

/** Measure in an independent flow while retaining the original document offsets. */
export function measureParagraphFrame(group, page, measureParagraph, paginate, maximumPages) {
  const paragraphs = group.members.map(b => b.paragraph);
  try {
    if (page.columns) throw new Error('Paragraph frames in section columns are not supported yet.');
    if (paragraphs.some(p => p.sectionEnd)) throw new Error('Paragraph frames on section-ending paragraphs require additional anchor handling.');
    if (paragraphs.some(p => /[\f\u000e]/.test(paragraphText(p)))) throw new Error('Page/column breaks inside paragraph frames are not supported yet.');
    const dimensions = frameDimensions(group.properties);
    const naturalPage = { ...page, left: 0, right: 0, top: 0, bottom: 0, height: 1e9,
      pageBounds: undefined, columns: undefined, flowColumns: undefined, verticalAlignment: 'top',
      paragraphFrameFlow: true, width: dimensions.width || page.width - page.left - page.right };
    let measured = group.members.flatMap(b => measureParagraph(b, naturalPage));
    if (!dimensions.width) {
      const lines = measured.flatMap(b => b.lines), width = Math.max(1, ...lines.map(l => Math.max(...l.stops.map(s => s.x))));
      naturalPage.width = width;
      measured = group.members.flatMap(b => measureParagraph(b, naturalPage));
    }
    const natural = paginate(measured, naturalPage, maximumPages, 0);
    if (natural.pageCount !== 1) throw new Error('Multi-page paragraph frames are not supported yet.');
    const height = dimensions.hRule === 'exact' ? dimensions.height : dimensions.hRule === 'atLeast' ? Math.max(dimensions.height, natural.endY) : natural.endY;
    return { ...group, dimensions, width: naturalPage.width, height, lines: natural.lines };
  } catch (error) { throw new UnsupportedParagraphFrameError(error.message, paragraphs); }
}

export function placeParagraphFrames(frames, placed, frameGeometry) {
  placed.paragraphFrames = [];
  for (const frame of frames) {
    const anchor = placed.lines.find(l => l.paragraphId === frame.anchorId);
    if (!anchor) throw new UnsupportedParagraphFrameError('Missing paragraph-frame anchor.', frame.members.map(b => b.paragraph));
    const page = frameGeometry || placed.pageRegions[anchor.page]?.[anchor.region]?.geometry || placed.pages[anchor.page];
    const cap = frame.dimensions.dropCap && dropCapBox(frame, placed, anchor, page);
    const position = cap || paragraphFramePosition(frame.properties, frame.dimensions, page, anchor, frame.width, frame.height);
    const box = { ...frame.dimensions, frameId: frame.members[0].paragraph.id, anchorId: frame.anchorId,
      paragraphIds: frame.members.map(b => b.paragraph.id), start: anchor.start, page: anchor.page, region: anchor.region,
      left: position.x, right: position.x + frame.width, top: cap ? cap.top : position.y, bottom: cap ? cap.bottom : position.y + frame.height,
      // A margin cap lies outside the text column: it never displaces text.
      ...(frame.dimensions.dropCap === 'margin' ? { wrap: 'none' } : {}) };
    const decorationOutset = side => Math.max(0, ...frame.lines.map(line =>
      line.paragraphFrame ? borderOutset(line.paragraphFrame.borders[side]) + 2 : line.paragraphBackground ? 2 : 0));
    const leftOutset = decorationOutset('left'), rightOutset = decorationOutset('right');
    const lines = frame.lines.map(line => ({ ...shiftTableItem(line, position.x, position.y),
      page: anchor.page, region: anchor.region, frameId: box.frameId,
      cellClip: { left: box.left - leftOutset, right: box.right + rightOutset, top: box.top, bottom: box.bottom } }));
    // A cap glyph is sized to its lines, not to its exact-height line box:
    // keep its whole line visible rather than clipping it to the frame.
    if (cap) for (const line of lines) line.cellClip = { ...line.cellClip, top: Math.min(box.top, line.y), bottom: Math.max(box.bottom, line.y + line.height) };
    // A specified frame height is also the physical shading/border extent;
    // it does not enlarge the text's line box or change caret navigation.
    for (const line of lines) if (line.paragraphBackground && !line.paragraphFrame) {
      line.paragraphBackground = { ...line.paragraphBackground, x: box.left, width: box.right - box.left };
    }
    const last = lines.at(-1);
    if (last?.paragraphBackground) last.paragraphBackground = { ...last.paragraphBackground,
      after: Math.max(last.paragraphBackground.after, box.bottom - last.y - last.height) };
    placed.lines.push(...lines);
    placed.paragraphFrames.push(box);
  }
  if (frames.length) placed.lines.sort((a, b) => a.start - b.start);
}

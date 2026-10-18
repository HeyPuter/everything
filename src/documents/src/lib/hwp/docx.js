/** Translate the shared Hanword model to an editable OOXML package. */
import { zipSync, strToU8 } from 'fflate';
import { check, LIMITS } from './binary.js';
import { xml } from './xml.js';
import { equationToOmml } from './equation.js';
import { IMAGE_MIMES, imageDimensions, imageResource } from './image.js';
import { gradientImage } from './fill.js';
import { highlightNames } from './formatting.js';
import { NATIVE_FORMATS, docxNumberFormat, levelLabel, advanceCounters } from './numbering.js';

/** A paragraph of no height: what keeps two tables apart without adding a line between them. */
const TABLE_SEPARATOR = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="1" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>';
/** DOCX requires every story (a cell, a text box, a note, a comment) to end with a paragraph. */
const endsWithParagraph = (xml) => (xml.endsWith('</w:p>') ? xml : xml + '<w:p/>');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = `xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"`;
// Resolved Hanword formatting is verbose in OOXML: a 10 MB report of 147,000 paragraphs writes about 150 MB of XML before compression.
const outputCheck = (size) => check(size <= LIMITS.output, 'The converted Hanword document exceeds the 256 MB output limit.');
// Bound each aggregate before joining it: small source definitions can be reused
// by thousands of paragraphs, runs, and styles in the generated package.
class XmlBuffer {
  constructor() { this.chunks = []; this.length = 0; }
  append(text) { this.length += text.length; outputCheck(this.length); this.chunks.push(text); }
  finish() { return this.chunks.join(''); }
}
function joinXml(items, render = (text) => text) {
  const buffer = new XmlBuffer(); let i = 0;
  for (const item of items) buffer.append(render(item, i++));
  return buffer.finish();
}
export { xml } from './xml.js';
const val = (tag, value) => `<w:${tag} w:val="${xml(value)}"/>`;
const twips = (n) => Math.round((Number(n) || 0) / 5);
/** DOCX readers take measurements up to 22 inches (31680 twips); a damaged or absurd value must not put the whole part beyond them. */
const DOCX_MAX_TWIPS = 31680;
const bounded = (value, min = 0) => Math.max(min, Math.min(DOCX_MAX_TWIPS, value));
// Only table cells take the diagonal lines; DOCX paragraph and table borders have no place for them.
// Border spacing is the Hanword offset in points (DOCX allows up to 31).
const borderSpace = (offset) => offset === undefined ? '' : ` w:space="${Math.max(0, Math.min(31, Math.round((Number(offset) || 0) / 100)))}"`;
// A paragraph without a border needs "nil" sides only to cancel a visible border its style would give it; a cell's nil sides always cancel the table's.
const visibleBorder = (b) => !!b && ['top', 'left', 'bottom', 'right'].some((side) => b[side] && b[side].style !== 'nil');
/** A border width in eighths of a point within the DOCX range; a width the file left out or broke is the thin default. */
const borderSize = (size) => (Number.isFinite(size) && size > 0 ? Math.max(2, Math.min(96, Math.round(size))) : 4);
const borderXml = (b, tag, offsets, keepNil = true) => {
  if (!b) return '';
  const sides = ['top', 'left', 'bottom', 'right', ...(tag === 'tcBorders' ? ['tl2br', 'tr2bl'] : [])].filter((side) => b[side] && (keepNil || b[side].style !== 'nil'));
  return sides.length ? `<w:${tag}>${sides.map((side) => `<w:${side} w:val="${xml(b[side].style || 'nil')}" w:sz="${borderSize(b[side].size)}"${borderSpace(offsets?.[side])} w:color="${xml(b[side].color || 'auto')}"/>`).join('')}</w:${tag}>` : '';
};
const shadeXml = (b) => b?.fill ? `<w:shd w:val="clear" w:fill="${xml(b.fill)}"/>` : '';
const marginXml = (m, tag) => !m ? '' : `<w:${tag}>${['top', 'left', 'bottom', 'right'].map((s) => `<w:${s} w:w="${Math.max(0, twips(m[s]))}" w:type="dxa"/>`).join('')}</w:${tag}>`;
// Runs inherit the language from the document defaults and styles, which state it; only those two carry it.
// Styles and defaults leave strikethrough to the runs: a property set may hold only one of strike and dstrike,
// so a run could not turn off an inherited one of the other kind.
function runProperties(c = {}, { withLang = false, style = false } = {}) {
  let out = '';
  if (c.font || c.eastAsia) out += `<w:rFonts w:ascii="${xml(c.font || c.eastAsia)}" w:hAnsi="${xml(c.font || c.eastAsia)}" w:eastAsia="${xml(c.eastAsia || c.font)}"/>`;
  out += val('b', c.bold ? 1 : 0) + val('i', c.italic ? 1 : 0);
  if (!style) out += c.doubleStrike ? val('dstrike', 1) : val('strike', c.strike ? 1 : 0);
  for (const key of ['outline', 'shadow', 'emboss', 'imprint']) out += val(key, c[key] ? 1 : 0);
  // Hanword character shapes are resolved formatting. Neutral values must
  // override the DOCX paragraph style and document defaults as well.
  out += val('color', c.color || 'auto');
  // Source values are unbounded; the DOCX limits keep the file valid (ST_TextScale tops out at 600).
  out += val('spacing', Math.max(-31680, Math.min(31680, twips(c.spacing))));
  out += val('w', Math.max(1, Math.min(600, Math.round(c.scale || 100))));
  // w:kern is the smallest size kerned, in half-points; 0 turns kerning off.
  out += val('kern', c.kerning ? 2 : 0);
  out += val('position', Math.max(-3168, Math.min(3168, Math.round(-((c.position || 0) / 50)))));
  if (c.size) { const size = Math.max(1, Math.min(3276, Math.round(c.size * (c.relativeSize || 100) / 5000))); out += val('sz', size) + val('szCs', size); }
  // A highlighter mark in one of the named DOCX highlight colors is a highlight; any other color paints the run background.
  const highlightName = c.highlight && highlightNames[String(c.highlight).toUpperCase()];
  if (highlightName) out += val('highlight', highlightName);
  out += `<w:u w:val="${xml(typeof c.underline === 'string' ? c.underline : c.underline ? 'single' : 'none')}"${c.underlineColor ? ` w:color="${xml(c.underlineColor)}"` : ''}/>`;
  // A character border fill draws one line around the run; DOCX has a single run border, so the first drawn side stands for all.
  const edge = c.border && ['left', 'top', 'right', 'bottom'].map((side) => c.border[side]).find((line) => line && line.style !== 'nil');
  if (edge) out += `<w:bdr w:val="${xml(edge.style)}" w:sz="${borderSize(edge.size)}" w:space="0" w:color="${xml(edge.color || 'auto')}"/>`;
  const shade = c.highlight && !highlightName ? c.highlight : c.shade || c.border?.fill;
  // Clear with an automatic fill is no shading, and still overrides a style's.
  out += `<w:shd w:val="clear" w:color="auto" w:fill="${xml(shade || 'auto')}"/>`;
  out += val('vertAlign', c.vert || 'baseline');
  if (c.emphasis) out += val('em', c.emphasis);
  return `<w:rPr>${out}${withLang ? '<w:lang w:val="en-US" w:eastAsia="ko-KR"/>' : ''}</w:rPr>`;
}
function buildParagraphProperties(p = {}, tabCache, base) {
  let out = '';
  for (const key of ['keepNext', 'keepLines', 'pageBreak']) out += val(key === 'pageBreak' ? 'pageBreakBefore' : key, p[key] ? 1 : 0);
  if (p.widow !== undefined) out += val('widowControl', p.widow ? 1 : 0);
  out += `<w:numPr>${p.numId ? val('ilvl', Math.min(8, Math.max(0, p.level || 0))) : ''}${val('numId', p.numId || 0)}</w:numPr>`;
  if (p.suppressLineNumbers) out += '<w:suppressLineNumbers/>';
  out += borderXml(p.border, 'pBdr', p.borderOffset, visibleBorder(base?.border)) + shadeXml(p.border);
  if (p.tabs?.length) {
    let tabs = tabCache.get(p.tabs);
    if (tabs === undefined) {
      const stops = p.tabs.filter((t) => Math.abs(twips(t.pos)) <= 31680);
      tabs = stops.length ? `<w:tabs>${joinXml(stops, (t) => `<w:tab w:val="${xml(t.align)}" w:pos="${twips(t.pos)}" w:leader="${xml(t.leader || 'none')}"/>`)}</w:tabs>` : '';
      tabCache.set(p.tabs, tabs);
    }
    out += tabs;
  }
  // Hanword documents choose these per paragraph; the DOCX defaults (on) would otherwise apply.
  if (p.autoSpaceLatin !== undefined) out += val('autoSpaceDE', p.autoSpaceLatin ? 1 : 0) + val('autoSpaceDN', p.autoSpaceNumber ? 1 : 0);
  if (p.snapToGrid !== undefined) out += val('snapToGrid', p.snapToGrid ? 1 : 0);
  let line = '';
  // DOCX readers take at most 22 inches of line height; a damaged value would otherwise put the whole part beyond it.
  if (p.line) line = ` w:line="${Math.min(31680, Math.max(1, p.lineType === 0 ? Math.round(p.line * 2.4) : twips(p.line)))}" w:lineRule="${p.lineType === 0 ? 'auto' : p.lineType === 1 ? 'exact' : 'atLeast'}"`;
  out += `<w:spacing w:before="${bounded(twips(p.before))}" w:after="${bounded(twips(p.after))}"${line}/>`;
  // HWP's left margin locates the first line; a hanging indent moves later
  // lines inward. The DOCX left indent locates those later lines instead.
  out += `<w:ind w:left="${bounded(twips((p.left || 0) + Math.max(0, -(p.indent || 0))), -DOCX_MAX_TWIPS)}" w:right="${bounded(twips(p.right), -DOCX_MAX_TWIPS)}"${p.indent < 0 ? ` w:hanging="${bounded(-twips(p.indent))}"` : ` w:firstLine="${bounded(twips(p.indent))}"`}/>`;
  if (p.align) out += val('jc', p.align);
  out += val('outlineLvl', p.heading === 1 ? Math.min(8, Math.max(0, p.level || 0)) : 9);
  return out;
}

export function modelToDocx(model) {
  const files = {}, types = [], parts = new Map(), media = new Map(); let drawingId = 0, headerId = 0;
  // Parsed paragraph definitions share tab arrays. Serialize each array once,
  // but keep the cache local so later conversions can reflect model edits.
  const tabCache = new WeakMap();
  const paragraphProperties = (props, base) => buildParagraphProperties(props, tabCache, base);
  let outputBytes = 0;
  function addFile(name, content) {
    // UTF-16 length is a lower bound on UTF-8 size. Check it before encoding,
    // then enforce the byte budget across XML, relationships, and media together.
    outputCheck(outputBytes + content.length);
    const bytes = typeof content === 'string' ? strToU8(content) : content;
    outputBytes += bytes.length; outputCheck(outputBytes); files[name] = bytes;
  }
  const lists = new Map();
  const gradientImages = new Map(); let gradientPixelsUsed = 0;
  const decorativeGradient = (c) => c.border?.gradient && ['LINEAR', 'RADIAL', 'SQUARE'].includes(c.border.gradient.type)
    && c.border.gradient.colors.length > 1 && !c.border.pictureFill && c.width > 0 && c.height > 0 && c.rowSpan === 1
    && c.blocks.every((p) => p.kind === 'p' && p.runs.every((r) => r.kind === 'text' && !r.text.trim()));
  function checkFill(border, preserved = false) {
    if (border?.gradient && !preserved) model.warnings.add('Gradient fills behind text or in complex tables retain their base color.');
    if (border?.pictureFill && !preserved) model.warnings.add('Picture fills behind text in paragraph and table backgrounds retain their base color.');
  }
  /** A gradient rasterized at twice screen resolution, shared by identical fills of the same size. */
  function gradientRaster(gradient, width, height) {
    const key = JSON.stringify([gradient, width, height]);
    if (!gradientImages.has(key)) {
      const scale = Math.min(2 / 75, 2048 / Math.max(width, height));
      gradientPixelsUsed += Math.max(1, Math.round(width * scale)) * Math.max(1, Math.round(height * scale));
      check(gradientPixelsUsed <= 16000000, 'The Hanword decorative fills exceed the image conversion limit.');
      gradientImages.set(key, gradientImage(gradient, width, height));
    }
    return gradientImages.get(key);
  }
  const gradientPicture = (c) => ({ kind: 'image', image: gradientRaster(c.border.gradient, c.width, c.height), width: c.width, height: c.height, alt: 'Gradient fill' });
  // An empty cell can show its background picture as the cell's content; text over a picture has no DOCX equivalent.
  const decorativePicture = (c) => c.pictureFill?.kind === 'image' && c.width > 0 && c.height > 0 && c.rowSpan === 1
    && c.blocks.every((p) => p.kind === 'p' && p.runs.every((r) => r.kind === 'text' && !r.text.trim()));
  if (model.paras.some((p) => p?.tabs?.some((t) => Math.abs(twips(t.pos)) > 31680))) model.warnings.add('Tab stops beyond the 22-inch DOCX positioning limit are omitted.');
  for (const p of model.paras) if (p?.heading) {
    const key = `${p.heading === 3 ? 'b' : 'n'}${p.numbering || 1}`;
    if (!lists.has(key)) lists.set(key, { id: lists.size + 1, levels: model.listDefinitions?.[key] || Array.from({ length: 7 }, (_, level) => ({ level, start: 1, format: p.heading === 3 ? 'bullet' : 'decimal', text: p.heading === 3 ? '•' : `^${level + 1}.` })) });
    if (!model.listDefinitions?.[key]) model.warnings.add('Some list numbering definitions were missing; default markers were used.');
    p.numId = lists.get(key).id;
  }
  // The editor paints only decimal, roman, letter and bullet list markers; other
  // Hanword formats (가나다, ㄱㄴㄷ, ①, 一, 갑을병...) are counted here and written as text.
  const levelsById = new Map([...lists.values()].map((list) => [list.id, list.levels])), listCounters = new Map();
  function listMarker(props, level) {
    const levels = levelsById.get(props.numId); if (!levels) return null;
    const counters = advanceCounters(listCounters.get(props.numId) || [], levels, level); listCounters.set(props.numId, counters);
    const format = levels[level]?.format || 'decimal';
    // A level under one written as text is written as text too: DOCX numbering and the editor restart a list level only
    // under a shallower list item, and the text levels are no longer items, so "1) 2)" under "나." would count
    // on from "가."'s items instead of starting again.
    const textAbove = levels.slice(0, level).some((l) => !NATIVE_FORMATS.has(l?.format || 'decimal'));
    if (NATIVE_FORMATS.has(format) && !textAbove) return null;
    model.warnings.add('Korean, circled and ideographic list numbers are written as text so the editor can show them.');
    return { text: levelLabel(levels, level, counters), char: levels[level]?.char };
  }
  // The editor paints no line numbers; each numbered line receives a small text
  // box in the left margin, anchored to its paragraph at the recorded line
  // position. The DOCX lnNumType is left out so readers do not number twice.
  let lineNumbering = null;
  // Each emulated line number is a text box of a few kilobytes: a very long numbered document would swell past the output limit.
  const LINE_NUMBER_BOXES = 5000;
  let lineNumberBoxes = 0;
  function lineNumberRuns(b, props) {
    const positions = b.linePositions; if (!lineNumbering || !positions?.length || props.suppressLineNumbers) return [];
    const state = lineNumbering, runs = [], width = 2400, height = Math.max(400, Math.min(4000, b.lineHeight || 1400));
    positions.forEach((y, i) => {
      if (state.restart === 'newPage' && state.previousY !== undefined && y < state.previousY) state.n = state.start - 1;
      state.previousY = y; state.n += 1;
      if (i && y < positions[0]) return; // a line on the next page cannot be placed from this paragraph
      if (state.n % state.countBy) return;
      if (lineNumberBoxes >= LINE_NUMBER_BOXES) { model.warnings.add(`Line numbers beyond the first ${LINE_NUMBER_BOXES.toLocaleString('en-US')} numbered lines were left out.`); return; }
      lineNumberBoxes += 1;
      runs.push({ kind: 'shape', shape: 'rect', width, height, fill: null, line: { style: 'NONE', width: 0 }, textAlign: 'center', padding: { left: 0, right: 0, top: 0, bottom: 0 },
        blocks: [{ kind: 'p', props: { align: 'right', line: height, lineType: 1 }, runs: [{ kind: 'text', text: String(state.n), props: { size: 800, color: '595959', relativeSize: 100, bold: false, italic: false } }] }],
        layout: { h: 'margin', v: 'paragraph', x: -(state.distance || 1417) - width, y: y - positions[0], hAlign: 'left', vAlign: 'top', wrap: 'none', overlap: true, zOrder: 0 } });
    });
    if (runs.length) model.warnings.add('Line numbers are drawn beside their lines at the positions Hanword recorded.');
    return runs;
  }
  const notes = { footnotes: [], endnotes: [] }, comments = [];
  let bookmarkId = 0, revisionId = 0;
  const bookmarks = new Map(), bookmarkNames = new Set(), emittedBookmarks = new Set();
  // Names that share a base take numbered suffixes; the next free number per base is kept so a
  // document with thousands of alike names does not try every earlier number again for each one.
  const suffixes = new Map();
  const unique = (base, taken, key = base) => {
    if (!taken.has(base)) return base;
    let n = suffixes.get(key) || 1;
    while (taken.has(`${base}_${n}`)) n++;
    suffixes.set(key, n + 1);
    return `${base}_${n}`;
  };
  function bookmarkName(name) {
    if (!name) return null;
    if (!bookmarks.has(name)) {
      // DOCX requires a unique name, at most 40 characters, without spaces.
      let base = String(name).normalize('NFC').replace(/[^\p{L}\p{N}_]/gu, '_');
      if (!/^\p{L}/u.test(base)) base = `Hwp_${base}`;
      const candidate = unique(base.slice(0, 32), bookmarkNames);
      bookmarkNames.add(candidate); bookmarks.set(name, candidate);
    }
    return bookmarks.get(name);
  }
  function uniqueBookmark(name) {
    const base = bookmarkName(name); if (!base) return null;
    const candidate = emittedBookmarks.has(base) ? unique(base.slice(0, 30), emittedBookmarks, `emitted:${base.slice(0, 30)}`) : base;
    emittedBookmarks.add(candidate); return candidate;
  }
  // Register targets before rendering so forward links use the same sanitized
  // name as the eventual bookmark, including targets in notes and table cells.
  function collect(blocks, depth = 0) {
    check(depth <= LIMITS.depth);
    for (const b of blocks || []) {
      if (b.kind === 'p') checkFill((b.props || model.paras[b.para])?.border);
      if (b.kind === 'table') checkFill(b.border);
      if (b.kind === 'bookmark') bookmarkName(b.name);
      if (b.bookmark) bookmarkName(b.bookmark);
      if (b.runs) collect(b.runs, depth + 1);
      if (b.blocks) collect(b.blocks, depth + 1);
      if (b.children) collect(b.children, depth + 1);
      if (b.cells) for (const c of b.cells) { checkFill(c.border, decorativeGradient(c) || decorativePicture(c)); collect(c.blocks, depth + 1); }
      if (b.caption) collect(b.caption, depth + 1);
      if (b.comment) collect(b.comment.blocks, depth + 1);
    }
  }
  for (const s of model.sections) { collect(s.blocks); for (const h of [...(s.headers || []), ...(s.footers || [])]) collect(h.blocks); }
  const story = () => ({ fields: [], revisions: [] });
  const closeField = (f) => f?.bookmarkId !== undefined ? `<w:bookmarkEnd w:id="${f.bookmarkId}"/>` : f?.commentId !== undefined ? `<w:commentRangeEnd w:id="${f.commentId}"/><w:r><w:commentReference w:id="${f.commentId}"/></w:r>` : '';
  function closeStory(state) {
    const ending = joinXml([...state.fields].reverse(), closeField);
    if (state.fields.length || state.revisions.length) model.warnings.add('An unterminated field or revision range was closed at the end of its text content.');
    state.fields.length = 0; state.revisions.length = 0;
    return ending;
  }
  const part = (name) => { if (!parts.has(name)) parts.set(name, new Map()); return parts.get(name); };
  function rel(owner, type, target, external = false) {
    const list = part(owner), key = JSON.stringify([type, target, external]), found = list.get(key);
    if (found) return found.id;
    const id = `rId${list.size + 1}`; list.set(key, { id, type, target, external }); return id;
  }
  function addPart(name, type, body, root) {
    addFile(`word/${name}.xml`, `${XML}<w:${root} ${NS}>${body}</w:${root}>`);
    types.push(`<Override PartName="/word/${name}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${type}+xml"/>`);
  }
  /** The owning part's relationship to a picture's media, adding the media part once; null when the bytes are not a picture. */
  const resources = new Map();
  /** The media extension of a picture's bytes, sniffed once per picture; null when the bytes are not a picture. */
  function pictureExt(img) {
    if (!img?.bytes) return null;
    if (!resources.has(img)) resources.set(img, imageResource(img.bytes, img.ext).ext);
    const ext = resources.get(img);
    return IMAGE_MIMES[ext] ? ext : null;
  }
  function mediaId(img, owner) {
    const ext = pictureExt(img);
    if (!ext) return null;
    if (!media.has(img)) {
      const target = `media/image${media.size + 1}.${ext}`; media.set(img, target); addFile(`word/${target}`, img.bytes);
      types.push(`<Override PartName="/word/${target}" ContentType="${IMAGE_MIMES[ext]}"/>`);
    }
    return rel(owner, 'image', media.get(img));
  }
  function picture(run, owner, child = false) {
    const img = run.image, rid = mediaId(img, owner);
    if (!rid) { model.warnings.add('A picture could not be decoded; a labeled placeholder is retained.'); return `<w:r><w:t>${xml(`[Unsupported picture${run.alt ? ': ' + run.alt : ''}]`)}</w:t></w:r>`; }
    const id = ++drawingId;
    run = { ...run, ...imageDimensions(run) };
    const cx = extent(run.width), cy = extent(run.height);
    const crop = run.crop ? `<a:srcRect ${['l', 't', 'r', 'b'].map((s) => `${s}="${Math.round(run.crop[s] || 0)}"`).join(' ')}/>` : '';
    const transform = `${run.rotation ? ` rot="${angle(run.rotation)}"` : ''}${run.flipH ? ' flipH="1"' : ''}${run.flipV ? ' flipV="1"' : ''}`;
    const adjustments = run.adjustments || {}, clamp = (n, max) => Math.max(-max, Math.min(max, Number(n) || 0));
    let effects = adjustments.effect === 'GRAY_SCALE' ? '<a:grayscl/>' : adjustments.effect === 'BLACK_WHITE' ? '<a:biLevel thresh="50000"/>' : '';
    if (adjustments.brightness || adjustments.contrast) effects += `<a:lum bright="${Math.round(clamp(adjustments.brightness, 100) * 1000)}" contrast="${Math.round(clamp(adjustments.contrast, 100) * 1000)}"/>`;
    if (adjustments.transparency) effects += `<a:alphaModFix amt="${Math.round((1 - Math.max(0, clamp(adjustments.transparency, 1))) * 100000)}"/>`;
    const graphic = `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}" descr="${xml(run.alt || '')}"/><pic:cNvPicPr><a:picLocks noChangeAspect="1"/></pic:cNvPicPr></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}">${effects}</a:blip>${crop}<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm${transform}><a:off x="${child ? offset(run.x) : 0}" y="${child ? offset(run.y) : 0}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${run.line ? lineXml(run.line) : ''}${pictureEffectsXml(run.effects)}</pic:spPr></pic:pic>`;
    return child ? graphic : drawing(run, id, `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">${graphic}</a:graphicData>`);

  }
  const angle = (n) => Math.round(((n % 360 + 360) % 360) * 60000);
  // Sizes and offsets are written as whole EMUs within the DOCX range. A group
  // transform can scale a child to an absurd or non-finite size; that must
  // become a bounded number, never "Infinity" or exponent notation.
  const emu = (n, fallback) => { const v = Number(n); return Math.round((Number.isFinite(v) ? v : fallback) * 127); };
  const extent = (n) => Math.max(127, Math.min(2147483647, emu(n, 14400)));
  const offset = (n) => Math.max(-2147483647, Math.min(2147483647, emu(n, 0)));
  function pictureEffectsXml(effects = {}) {
    const percent = (n) => Math.round(Math.max(0, Math.min(1, n || 0)) * 100000), length = (n) => Math.max(0, Math.min(2147483647, Math.round((n || 0) * 127)));
    function effectColor(effect) {
      const transforms = effect.color?.transforms || [], allowed = new Set(['alpha', 'alphaMod', 'alphaOff', 'red', 'redMod', 'redOff', 'green', 'greenMod', 'greenOff', 'blue', 'blueMod', 'blueOff', 'hue', 'hueMod', 'hueOff', 'sat', 'satMod', 'satOff', 'lum', 'lumMod', 'lumOff', 'shade', 'tint', 'gray', 'comp', 'gamma', 'invGamma', 'inv']);
      return `<a:srgbClr val="${xml(effect.color?.value || '000000')}"><a:alpha val="${percent(1 - (effect.transparency || 0))}"/>${transforms.filter((t) => allowed.has(t.name)).map((t) => ['gray', 'comp', 'gamma', 'invGamma', 'inv'].includes(t.name) ? `<a:${t.name}/>` : `<a:${t.name} val="${t.name === 'hue' ? angle(t.value) : Math.round(Math.max(t.name.endsWith('Off') ? -1 : 0, Math.min(t.name.endsWith('Mod') ? 100 : 1, t.value)) * 100000)}"/>`).join('')}</a:srgbClr>`;
    }
    function transform(effect) {
      const align = { TOP_LEFT: 'tl', TOP: 't', TOP_RIGHT: 'tr', LEFT: 'l', CENTER: 'ctr', RIGHT: 'r', BOTTOM_LEFT: 'bl', BOTTOM: 'b', BOTTOM_RIGHT: 'br' }[effect.align] || 'ctr';
      const scale = (n) => Math.round(Math.max(-21474, Math.min(21474, n ?? 1)) * 100000), skew = (n) => Math.round(Math.max(-89.999, Math.min(89.999, n || 0)) * 60000);
      return ` sx="${scale(effect.scaleX)}" sy="${scale(effect.scaleY)}" kx="${skew(effect.skewX)}" ky="${skew(effect.skewY)}" algn="${align}" rotWithShape="${effect.rotate ? 1 : 0}"`;
    }
    let out = '';
    if (effects.glow) out += `<a:glow rad="${length(effects.glow.radius)}">${effectColor(effects.glow)}</a:glow>`;
    if (effects.shadow) {
      const e = effects.shadow, tag = e.style === 'INSIDE' ? 'innerShdw' : 'outerShdw';
      out += `<a:${tag} blurRad="${length(e.radius)}" dist="${length(e.distance)}" dir="${angle(e.direction || 0)}"${tag === 'outerShdw' ? transform(e) : ''}>${effectColor(e)}</a:${tag}>`;
    }
    if (effects.reflection) { const e = effects.reflection; out += `<a:reflection blurRad="${length(e.radius)}" stA="${percent(1 - e.startAlpha)}" stPos="${percent(e.startPos)}" endA="${percent(1 - e.endAlpha)}" endPos="${percent(e.endPos)}" dist="${length(e.distance)}" dir="${angle(e.direction || 0)}" fadeDir="${angle(e.fadeDirection ?? 90)}"${transform(e)}/>`; }
    if (effects.softEdge) out += `<a:softEdge rad="${length(effects.softEdge.radius)}"/>`;
    return out ? `<a:effectLst>${out}</a:effectLst>` : '';
  }
  function lineXml(line) {
    const dash = { DOT: 'dot', DASH: 'dash', DASH_DOT: 'dashDot', DASH_DOT_DOT: 'lgDashDotDot', LONG_DASH: 'lgDash' }[line.style];
    const opacity = Math.round((1 - Math.max(0, Math.min(1, line.transparency || 0))) * 100000);
    return `<a:ln w="${Math.max(0, Math.min(20116800, Math.round((line.width || 0) * 127)))}">${line.style === 'NONE' || !line.width ? '<a:noFill/>' : `<a:solidFill><a:srgbClr val="${xml(line.color || '000000')}">${opacity < 100000 ? `<a:alpha val="${opacity}"/>` : ''}</a:srgbClr></a:solidFill>`}${dash ? `<a:prstDash val="${dash}"/>` : ''}</a:ln>`;
  }
  function drawing(run, id, graphic) {
    const cx = extent(run.width), cy = extent(run.height);
    const layout = run.layout, type = layout ? 'anchor' : 'inline';
    const distances = ['top', 'bottom', 'left', 'right'].map((side) => `dist${side[0].toUpperCase()}="${Math.max(0, Math.min(4294967295, Math.round((layout?.margins?.[side] || 0) * 127)))}"`).join(' ');
    const position = (axis, relative, offset = 0, align) => {
      const emu = Math.round(offset * 127), bounded = Math.max(-2147483648, Math.min(2147483647, emu));
      if (emu !== bounded) model.warnings.add('A drawing position exceeds the supported DOCX range and was limited.');
      return `<wp:position${axis} relativeFrom="${xml(relative)}">${['center', 'right', 'bottom', 'inside', 'outside'].includes(align) && !offset ? `<wp:align>${align}</wp:align>` : `<wp:posOffset>${bounded}</wp:posOffset>`}</wp:position${axis}>`;
    };
    const positioning = layout ? '<wp:simplePos x="0" y="0"/>' + position('H', layout.h, layout.x, layout.hAlign) + position('V', layout.v, layout.y, layout.vAlign) : '';
    const wrap = !layout ? '' : layout.wrap === 'square' ? `<wp:wrapSquare wrapText="${xml(layout.wrapText || 'bothSides')}"/>` : layout.wrap === 'topAndBottom' ? '<wp:wrapTopAndBottom/>' : '<wp:wrapNone/>';
    return `<w:r><w:drawing><wp:${type} ${distances}${layout ? ` simplePos="0" relativeHeight="${Math.max(0, Math.min(0xffffffff, Math.round(layout.zOrder ?? id)))}" behindDoc="${layout.behind ? 1 : 0}" locked="0" layoutInCell="${layout.inCell === false ? 0 : 1}" allowOverlap="${layout.overlap === false ? 0 : 1}"` : ''}>${positioning}<wp:extent cx="${cx}" cy="${cy}"/>${wrap}<wp:docPr id="${id}" name="Object ${id}" descr="${xml(run.alt || '')}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic>${graphic}</a:graphic></wp:${type}></w:drawing></w:r>`;
  }
  function shapeXml(run, owner, child = false) {
    const id = ++drawingId, cx = extent(run.width), cy = extent(run.height);
    // Hanword's corner ratio is a percentage of the shorter side's half; the DrawingML adj tops out at 50000 for a stadium.
    let geometry = `<a:prstGeom prst="${xml(run.shape || 'rect')}"><a:avLst>${run.shape === 'roundRect' && run.roundness > 0 ? `<a:gd name="adj" fmla="val ${Math.round(Math.max(0, Math.min(100, run.roundness)) * 500)}"/>` : ''}</a:avLst></a:prstGeom>`;
    const coordinate = (n) => Math.max(-27273042316900, Math.min(27273042316900, Math.round(Number.isFinite(n) ? n : 0)));
    // A path's coordinate space falls back to the shape's own size, then to a nominal one: a negative or missing size read from the file must not become "NaN".
    const pathDim = (value, fallback) => Math.max(1, Math.round(Number.isFinite(value) && value > 0 ? value : Number.isFinite(fallback) && fallback > 0 ? fallback : 14400));
    const custom = (commands, closed) => `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${pathDim(run.coordWidth, run.width)}" h="${pathDim(run.coordHeight, run.height)}"${closed ? '' : ' fill="none"'}>${commands}</a:path></a:pathLst></a:custGeom>`;
    const point = (x, y) => `<a:pt x="${coordinate(x)}" y="${coordinate(y)}"/>`;
    let closed = true;
    if (run.shape === 'polygon') {
      if (!run.points?.length) {
        model.warnings.add('A drawing has no readable geometry.');
        return child ? shapeXml({ ...run, shape: 'rect', line: { style: 'NONE' }, blocks: [{ kind: 'p', runs: [{ kind: 'text', text: '[Empty polygon]' }] }] }, owner, true)
          : '<w:r><w:t>[Empty polygon]</w:t></w:r>';
      }
      geometry = custom(joinXml(run.points, (p, i) => `<a:${i ? 'lnTo' : 'moveTo'}>${point(p.x, p.y)}</a:${i ? 'lnTo' : 'moveTo'}>`) + '<a:close/>', true);
    }
    if (run.shape === 'custom') {
      // Arcs, curves and connectors: moveTo, lnTo, cubicBezTo and close, which the editor's geometry extractor draws.
      check(Array.isArray(run.path) && run.path.length > 0 && run.path.length <= 20000, 'A Hanword drawing has no readable geometry.');
      closed = run.path.some((c) => c.kind === 'close');
      geometry = custom(joinXml(run.path, (c) => c.kind === 'move' ? `<a:moveTo>${point(c.x, c.y)}</a:moveTo>` : c.kind === 'line' ? `<a:lnTo>${point(c.x, c.y)}</a:lnTo>`
        : c.kind === 'cubic' ? `<a:cubicBezTo>${point(c.x1, c.y1)}${point(c.x2, c.y2)}${point(c.x, c.y)}</a:cubicBezTo>` : '<a:close/>'), closed);
    }
    const alpha = run.fillAlpha !== undefined ? `<a:alpha val="${Math.round(Math.max(0, Math.min(1, run.fillAlpha)) * 100000)}"/>` : '';
    let fill = run.fill && closed ? `<a:solidFill><a:srgbClr val="${xml(run.fill)}">${alpha}</a:srgbClr></a:solidFill>` : '<a:noFill/>';
    if (run.hatch && run.fill && closed) {
      // The editor paints a pattern fill as its foreground color alone; a blend keeps the hatch's density readable.
      const mix = (a, b) => [0, 2, 4].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * 0.75 + parseInt(b.slice(i, i + 2), 16) * 0.25).toString(16).padStart(2, '0')).join('');
      fill = `<a:solidFill><a:srgbClr val="${xml(mix(run.fill, run.hatch.color || '000000'))}"/></a:solidFill>`;
      model.warnings.add('Hatched fills are approximated with a blended solid color.');
    }
    if (run.gradient?.colors.length > 1 && closed) {
      if (!run.gradient.type || run.gradient.type === 'LINEAR') fill = `<a:gradFill><a:gsLst>${run.gradient.colors.map((color, i, all) => `<a:gs pos="${Math.round(i * 100000 / (all.length - 1))}"><a:srgbClr val="${xml(color)}"/></a:gs>`).join('')}</a:gsLst><a:lin ang="${Math.round(((run.gradient.angle % 360 + 360) % 360) * 60000)}" scaled="1"/></a:gradFill>`;
      else {
        // Radial and square gradients are rasterized like decorative cells: the editor paints path gradients poorly.
        const rid = run.width > 0 && run.height > 0 && mediaId(gradientRaster(run.gradient, run.width, run.height), owner);
        if (rid) fill = `<a:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>`;
      }
    }
    if (run.pictureFill?.kind === 'image' && closed) {
      const rid = mediaId(run.pictureFill.image, owner);
      if (rid) fill = `<a:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>`;
      else model.warnings.add('A picture fill could not be decoded; the shape keeps its base color.');
    }
    const line = run.line || {}, dash = { DOT: 'dot', DASH: 'dash', DASH_DOT: 'dashDot', DASH_DOT_DOT: 'lgDashDotDot', LONG_DASH: 'lgDash' }[line.style];
    const arrow = (end) => {
      const value = line[end];
      let type = { ARROW: 'triangle', EMPTY_ARROW: 'triangle', CONCAVE_ARROW: 'stealth', EMPTY_CONCAVE_ARROW: 'stealth', DIAMOND: 'diamond', EMPTY_DIAMOND: 'diamond', CIRCLE: 'oval', EMPTY_CIRCLE: 'oval', SPEAR: 'arrow', OPEN_ARROW: 'arrow', BOX: 'diamond', EMPTY_BOX: 'diamond' }[value];
      if (!type) return '';
      if (value === 'BOX' || value === 'EMPTY_BOX') model.warnings.add('Square line ends are approximated with diamond ends.');
      if (line[end + 'Fill'] === false && ['triangle', 'stealth'].includes(type)) type = 'arrow';
      else if (line[end + 'Fill'] === false && value.startsWith('EMPTY_')) model.warnings.add('Hollow closed line ends are approximated with filled ends.');
      const sizes = String(line[end + 'Size'] || '').split('_'), dimension = (s) => ({ SMALL: 'sm', MEDIUM: 'med', LARGE: 'lg' })[s] || 'med';
      return `<a:${end}End type="${type}" w="${dimension(sizes[0])}" len="${dimension(sizes[1])}"/>`;
    };
    const stroke = `<a:ln w="${Math.max(0, Math.min(20116800, Math.round((line.width || 0) * 127)))}" cap="${line.cap === 'ROUND' ? 'rnd' : 'flat'}">${line.style === 'NONE' ? '<a:noFill/>' : `<a:solidFill><a:srgbClr val="${xml(line.color || '000000')}"/></a:solidFill>`}${dash ? `<a:prstDash val="${dash}"/>` : ''}${arrow('head')}${arrow('tail')}</a:ln>`;
    const transform = `<a:xfrm rot="${angle(run.rotation || 0)}" flipH="${run.flipH ? 1 : 0}" flipV="${run.flipV ? 1 : 0}"><a:off x="${child ? offset(run.x) : 0}" y="${child ? offset(run.y) : 0}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
    // Inside a text box no drawing may be written (the editor cannot address the document's paragraphs then):
    // the table emulations that draw one (diagonal borders, decorative cells) stay plain there.
    inTextBox += 1;
    let text;
    try { text = run.blocks?.length ? `<wps:txbx><w:txbxContent>${endsWithParagraph(blocksXml(run.blocks, owner))}</w:txbxContent></wps:txbx>` : ''; }
    finally { inTextBox -= 1; }
    const insets = ['left', 'top', 'right', 'bottom'].map((side) => `${side[0]}Ins="${Math.max(0, Math.min(2147483647, Math.round((run.padding?.[side] || 0) * 127)))}"`).join(' ');
    const graphic = `<wps:wsp><wps:cNvSpPr${text ? ' txBox="1"' : ''}/><wps:spPr>${transform}${geometry}${fill}${stroke}</wps:spPr>${text}<wps:bodyPr ${insets} anchor="${{ top: 't', center: 'ctr', bottom: 'b' }[run.textAlign] || 't'}"/></wps:wsp>`;
    return child ? graphic : drawing(run, id, `<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">${graphic}</a:graphicData>`);
  }
  /**
   * The editor paints no shape or picture effects, so a drop shadow becomes a
   * second shape behind the object: the same geometry offset by the shadow
   * distance, filled with the shadow color. A standalone object with a shadow
   * therefore becomes a two-member group; grouped objects gain a sibling.
   */
  function shadowOf(run) {
    const shadow = run.shadow || (run.effects?.shadow && run.effects.shadow.style !== 'INSIDE' && run.effects.shadow);
    if (!shadow) return null;
    const distance = shadow.x !== undefined ? null : Math.max(0, Number(shadow.distance) || 0);
    const dx = distance === null ? shadow.x || 0 : distance * Math.cos((shadow.direction || 0) * Math.PI / 180), dy = distance === null ? shadow.y || 0 : distance * Math.sin((shadow.direction || 0) * Math.PI / 180);
    if (![dx, dy].every(Number.isFinite) || (!dx && !dy)) return null;
    const color = shadow.color?.value || shadow.color || '808080';
    return { dx, dy, copy: { kind: 'shape', shape: run.kind === 'image' ? 'rect' : run.shape, path: run.path, points: run.points, coordWidth: run.coordWidth, coordHeight: run.coordHeight, roundness: run.roundness,
      rotation: run.rotation, flipH: run.flipH, flipV: run.flipV, width: run.width, height: run.height, fill: typeof color === 'string' ? color : '808080', fillAlpha: 1 - Math.max(0, Math.min(1, shadow.transparency || 0)), line: { style: 'NONE', width: 0 }, blocks: [] } };
  }
  function shadowed(run, owner) {
    const shadow = shadowOf(run); if (!shadow) return null;
    const { copy, dx, dy } = shadow, base = { ...run, shadow: undefined, effects: run.effects ? { ...run.effects, shadow: undefined } : run.effects, layout: undefined, x: Math.max(0, -dx), y: Math.max(0, -dy) };
    const child = { ...copy, x: Math.max(0, dx), y: Math.max(0, dy) };
    model.warnings.add('Drop shadows are drawn as a shadow-colored copy behind the object, grouped with it.');
    return groupXml({ kind: 'group', width: run.width + Math.abs(dx), height: run.height + Math.abs(dy), layout: run.layout, alt: run.alt, children: [child, base] }, owner);
  }
  /**
   * A drawing inside a text box's own paragraphs (a picture framed by a box, a
   * shape drawn in one) leaves the editor unable to address any paragraph of
   * the document that carries a drawing. Such drawings are lifted out of the
   * box into a group beside it: the box first, then each drawing where it sat
   * in the box (its own offset for a floating one, the box's text corner for
   * one in the text). Returns null for a box without drawings in it.
   */
  function liftDrawings(box, base = { x: 0, y: 0 }) {
    if (box.kind !== 'shape' || !box.blocks?.length) return null;
    const size = (n) => (Number.isFinite(n) && n > 0 ? n : 14400), pad = (side) => Math.max(0, Number(box.padding?.[side]) || 0);
    // A line keeps a zero height (or width) as long as its other extent is real; anything else without a size gets a default.
    const extentOf = (n, other) => (Number.isFinite(n) && n >= 0 && (n > 0 || other > 0) ? n : 14400);
    const width = size(box.width), height = size(box.height), lifted = [];
    const isDrawing = (r) => r.kind === 'shape' || r.kind === 'group' || (r.kind === 'image' && !!pictureExt(r.image));
    const place = (r) => {
      const d = r.kind === 'image' ? { ...r, ...imageDimensions(r) } : { ...r, width: extentOf(r.width, r.height), height: extentOf(r.height, r.width) };
      const layout = d.layout || {}, dx = Number(layout.x) || 0, dy = Number(layout.y) || 0;
      let x = pad('left') + dx, y = pad('top') + dy;
      if (d.layout && !dx && layout.hAlign === 'center') x = (width - d.width) / 2;
      if (d.layout && !dx && layout.hAlign === 'right') x = width - pad('right') - d.width;
      if (d.layout && !dy && layout.vAlign === 'center') y = (height - d.height) / 2;
      if (d.layout && !dy && layout.vAlign === 'bottom') y = height - pad('bottom') - d.height;
      return { ...d, layout: undefined, x: base.x + x, y: base.y + y };
    };
    const stripTable = (table) => ({ ...table, cells: table.cells.map((cell) => ({ ...cell, blocks: strip(cell.blocks) })) });
    const strip = (blocks) => (blocks || []).map((b) => {
      if (b.kind === 'table') return stripTable(b);
      if (b.kind !== 'p') return b;
      return { ...b, runs: b.runs.flatMap((r) => {
        if (isDrawing(r)) { lifted.push(place(r)); return []; }
        if (r.kind === 'blocks') return [{ ...r, blocks: strip(r.blocks) }];
        if (r.kind === 'table') return [stripTable(r)];
        return [r];
      }) };
    });
    const blocks = strip(box.blocks);
    if (!lifted.length) return null;
    model.warnings.add('Drawings inside a text box are grouped beside the box, at their place in it.');
    return { box: { ...box, blocks, width, height, layout: undefined, x: base.x, y: base.y }, lifted };
  }
  /** A text box with drawings in it, as the group of the box and the lifted drawings; null for any other shape. */
  function liftedGroup(run, owner) {
    const lift = liftDrawings(run);
    if (!lift) return null;
    const members = [lift.box, ...lift.lifted];
    const minX = members.reduce((min, m) => Math.min(min, m.x), 0), minY = members.reduce((min, m) => Math.min(min, m.y), 0);
    for (const m of members) { m.x -= minX; m.y -= minY; }
    const width = members.reduce((max, m) => Math.max(max, m.x + m.width), 0), height = members.reduce((max, m) => Math.max(max, m.y + m.height), 0);
    const layout = run.layout && (minX || minY) ? { ...run.layout, x: (Number(run.layout.x) || 0) + minX, y: (Number(run.layout.y) || 0) + minY } : run.layout;
    return groupXml({ kind: 'group', width, height, layout, alt: run.alt, children: members }, owner);
  }
  function groupXml(run, owner) {
    const id = ++drawingId, cx = extent(run.width), cy = extent(run.height);
    // A text box among the members keeps its drawings beside it, in the group's coordinates.
    const expand = (child) => {
      // A group lifted out of a text box (or nested by a reader) has no writer of its own here: its members join this group at its offset.
      if (child.kind === 'group') return (child.children || []).flatMap((member) => expand({ ...member, x: (Number(member.x) || 0) + (Number(child.x) || 0), y: (Number(member.y) || 0) + (Number(child.y) || 0) }));
      const lift = child.kind === 'shape' ? liftDrawings(child, { x: Number(child.x) || 0, y: Number(child.y) || 0 }) : null;
      return lift ? [lift.box, ...lift.lifted.flatMap(expand)] : [child];
    };
    const members = run.children.flatMap(expand).flatMap((child) => {
      const shadow = shadowOf(child);
      if (!shadow) return [child];
      model.warnings.add('Drop shadows are drawn as a shadow-colored copy behind the object, grouped with it.');
      return [{ ...shadow.copy, x: (child.x || 0) + shadow.dx, y: (child.y || 0) + shadow.dy }, { ...child, shadow: undefined, effects: child.effects ? { ...child.effects, shadow: undefined } : child.effects }];
    });
    const children = joinXml(members, (child) => child.kind === 'image' ? picture(child, owner, true) : shapeXml(child.kind === 'text'
      ? { ...child, kind: 'shape', shape: 'rect', line: { style: 'NONE' }, blocks: [{ kind: 'p', runs: [{ kind: 'text', text: child.text }] }] }
      : child, owner, true));
    return drawing(run, id, `<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"><wpg:wgp><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/><a:chOff x="0" y="0"/><a:chExt cx="${cx}" cy="${cy}"/></a:xfrm></wpg:grpSpPr>${children}</wpg:wgp></a:graphicData>`);
  }
  function runsXml(runs, owner, state) {
    const { fields, revisions } = state;
    // Text inside a deletion is written as deleted text, whatever kind of run carries it.
    const textTag = () => (revisions.some((v) => v.revision.type === 'del') ? 'delText' : 't');
    const textRun = (properties, text) => `<w:r>${properties}<w:${textTag()} xml:space="preserve">${xml(text)}</w:${textTag()}></w:r>`;
    function wrap(content, r) {
      // A revision holds runs, and a hyperlink holds revisions: the WordprocessingML schema has no revision around a hyperlink.
      for (const change of revisions) {
        const rev = change.revision, date = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(rev.date || '') ? ` w:date="${xml(rev.date)}"` : '';
        content = `<w:${rev.type} w:id="${revisionId++}" w:author="${xml(rev.author || '')}"${date}>${content}</w:${rev.type}>`;
      }
      const link = r.href || r.anchor ? r : fields.findLast((f) => f.href || f.anchor);
      if (link?.href && /^(https?:|mailto:)/i.test(link.href)) content = `<w:hyperlink r:id="${rel(owner, 'hyperlink', link.href, true)}">${content}</w:hyperlink>`;
      else if (link?.anchor) {
        const name = bookmarks.get(link.anchor);
        if (name) content = `<w:hyperlink w:anchor="${xml(name)}" w:history="1">${content}</w:hyperlink>`;
        else model.warnings.add('Some internal hyperlinks refer to missing bookmarks and remain plain text.');
      }
      return content;
    }
    return joinXml(runs, (r) => {
      if (r.kind === 'fieldStart') {
        check(fields.length < LIMITS.depth, 'This Hanword document has too many overlapping fields.');
        const field = { ...r }; fields.push(field);
        if (r.bookmark) { field.bookmarkId = bookmarkId++; return `<w:bookmarkStart w:id="${field.bookmarkId}" w:name="${xml(uniqueBookmark(r.bookmark))}"/>`; }
        if (r.comment) { field.commentId = comments.length; comments.push({ ...r.comment, id: field.commentId }); rel('document', 'comments', 'comments.xml'); return `<w:commentRangeStart w:id="${field.commentId}"/>`; }
        return '';
      }
      if (r.kind === 'fieldEnd') {
        const index = r.id ? fields.findLastIndex((f) => f.id === r.id) : fields.length - 1;
        if (index < 0) return '';
        return closeField(fields.splice(index, 1)[0]);
      }
      if (r.kind === 'bookmark') { const name = uniqueBookmark(r.name); if (!name) return ''; const id = bookmarkId++; return `<w:bookmarkStart w:id="${id}" w:name="${xml(name)}"/><w:bookmarkEnd w:id="${id}"/>`; }
      if (r.kind === 'revisionStart') { check(revisions.length < LIMITS.depth, 'This Hanword document has too many overlapping revisions.'); revisions.push(r); return ''; }
      if (r.kind === 'revisionEnd') { const index = revisions.findLastIndex((v) => v.id === r.id); if (index >= 0) revisions.splice(index, 1); return ''; }
      if (r.kind === 'image') return wrap(shadowed(r, owner) || picture(r, owner), r);
      if (r.kind === 'shape') return wrap(liftedGroup(r, owner) || shadowed(r, owner) || shapeXml(r, owner), r);
      if (r.kind === 'group') return wrap(groupXml(r, owner), r);
      if (r.kind === 'equation') {
        const math = equationToOmml(r.text, r);
        // The WordprocessingML schema admits math inside a deletion and a hyperlink alike: an equation goes with the text around it.
        if (math) return wrap(math, r);
        model.warnings.add('Some equations use unsupported syntax; their complete Hanword source is retained as text.');
        return wrap(textRun(runProperties(model.chars[r.char]), r.text || '[Equation]'), r);
      }
      if (r.kind === 'ruby') {
        // The editor drops w:ruby, including its base text. The annotation
        // follows the base as small raised text, the nearest painted form.
        model.warnings.add('Ruby annotations are shown as small raised text after their base text.');
        const c = model.chars[r.char] || {}, size = Math.max(200, Math.round((c.size || 1000) * (c.relativeSize || 100) / 100 / 2));
        const annotation = r.ruby ? textRun(runProperties({ ...c, size, relativeSize: 100, vert: r.below ? 'subscript' : 'superscript' }), r.ruby) : '';
        return wrap(`${textRun(runProperties(c), r.text)}${annotation}`, r);
      }
      if (r.kind === 'noteLabel') return `<w:r><w:rPr>${val('vertAlign', 'superscript')}</w:rPr><w:${r.end ? 'endnote' : 'footnote'}Ref/></w:r>`;
      if (r.kind === 'field') return wrap(`<w:fldSimple w:instr="${xml(r.instruction)}">${textRun(runProperties(model.chars[r.char]), r.text || '1')}</w:fldSimple>`, r);
      if (r.kind === 'note') {
        const kind = r.end ? 'endnotes' : 'footnotes', id = notes[kind].length + 1;
        notes[kind].push({ id, blocks: r.blocks }); rel('document', kind, `${kind}.xml`);
        return wrap(`<w:r><w:${r.end ? 'endnote' : 'footnote'}Reference w:id="${id}"/></w:r>`, r);
      }
      if (r.kind !== 'text') return '';
      const tag = textTag();
      const content = joinXml(String(r.text || '').split(/([\t\n])/), (s) => s === '\t' ? '<w:tab/>' : s === '\n' ? '<w:br/>' : `<w:${tag} xml:space="preserve">${xml(s)}</w:${tag}>`);
      const run = `<w:r>${runProperties({ ...(model.chars[r.char] || {}), ...r.props, ...(r.highlight ? { highlight: r.highlight } : {}) })}${content}</w:r>`;
      return wrap(run, r);
    });
  }
  function blocksXml(blocks, owner, depth = 0, state = null) {
    check(depth <= LIMITS.depth);
    const ownStory = !state; state ||= story();
    // Readers join tables written back to back into one; a zero-height paragraph keeps them apart.
    let endedWithTable = false;
    const result = joinXml(blocks, (b) => {
      if (b.kind === 'table') { const table = (endedWithTable ? TABLE_SEPARATOR : '') + tableXml(b, owner, depth + 1); endedWithTable = true; return table; }
      if (b.kind !== 'p') return '';
      // A block with properties of its own copied them before the list numbers were assigned to the definitions; the number still comes from its definition.
      const definition = model.paras[b.para] || {};
      let props = { ...(b.props ? { numId: definition.numId, ...b.props } : definition), ...(b.lineHeight > 0 ? { line: b.lineHeight, lineType: 1 } : {}) };
      const style = model.styles[b.style]?.type !== 'character' ? model.styles[b.style] : null, base = style ? val('pStyle', `HwpStyle${b.style}`) : '', styleBase = style ? model.paras[style.para] : undefined;
      const result = new XmlBuffer(); let current = [], first = true;
      if (owner === 'document' && depth === 0) current.push(...lineNumberRuns(b, props));
      const marker = props.numId ? listMarker(props, Math.min(8, Math.max(0, props.level || 0))) : null;
      if (marker) { props = { ...props, numId: 0 }; current.push({ kind: 'text', text: marker.text + ' ', char: model.chars[marker.char] ? marker.char : b.char }); }
      const flush = (force = false) => { if (!current.length && !force) return;
        // The paragraph mark's formatting sets an empty paragraph's height; a paragraph with content takes its height from its runs.
        const empty = !current.some((r) => ['text', 'image', 'shape', 'group', 'equation', 'field', 'note', 'ruby'].includes(r.kind));
        // Text after an inline table or nested blocks continues the same Hanword paragraph: no second number or outline entry for it.
        result.append(`<w:p><w:pPr>${base}${paragraphProperties(first ? { ...props, pageBreak: b.pageBreak || props.pageBreak } : { ...props, numId: 0, heading: 0, pageBreak: false }, styleBase)}${empty && b.char !== undefined ? runProperties(model.chars[b.char]) : ''}</w:pPr>${first && b.columnBreak ? '<w:r><w:br w:type="column"/></w:r>' : ''}${runsXml(current, owner, state)}</w:p>`);
        first = false; current = []; endedWithTable = false;
      };
      for (const run of b.runs) {
        if (run.kind === 'table' || run.kind === 'blocks') {
          if (first && !current.length && (b.pageBreak || b.columnBreak)) {
            // A break on an object-only HWP paragraph starts the object on the
            // next page/column; it does not add a full blank text line there.
            result.append(`<w:p><w:pPr>${b.pageBreak ? '<w:pageBreakBefore/>' : ''}<w:spacing w:before="0" w:after="0" w:line="1" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr>${b.columnBreak ? '<w:r><w:br w:type="column"/></w:r>' : ''}</w:p>`);
            first = false; endedWithTable = false;
          } else {
            flush();
            if (run.kind === 'table' && endedWithTable) result.append(TABLE_SEPARATOR);
          }
          result.append(run.kind === 'table' ? tableXml(run, owner, depth + 1) : blocksXml(run.blocks, owner, depth + 1, state));
          endedWithTable = run.kind === 'table';
        } else current.push(run);
      }
      flush(!result.length); return result.finish();
    });
    const ending = ownStory ? closeStory(state) : '';
    return !ending ? result : result.endsWith('</w:p>') ? result.slice(0, -6) + ending + '</w:p>' : result + `<w:p>${ending}</w:p>`;
  }
  let inTextBox = 0;
  /** The editor paints no diagonal cell borders; anchored lines across the cell stand in for them. */
  function withDiagonals(c, table) {
    const border = c.border || table.border, diagonals = [['tl2br', false], ['tr2bl', true]].filter(([key]) => border?.[key] && border[key].style !== 'nil');
    if (!diagonals.length || !(c.width > 0 && c.height > 0)) return c.blocks;
    if (inTextBox) { model.warnings.add('Diagonal cell borders inside a text box are not drawn.'); return c.blocks; }
    const padding = c.padding || table.padding || {};
    const lines = diagonals.map(([key, flipV]) => ({ kind: 'shape', shape: 'line', width: c.width, height: c.height, fill: null, flipV, line: lineFromBorder(border[key]), blocks: [],
      layout: { h: 'column', v: 'paragraph', x: -(Number(padding.left) || 0), y: -(Number(padding.top) || 0), hAlign: 'left', vAlign: 'top', wrap: 'none', overlap: true, inCell: true, zOrder: 0 } }));
    model.warnings.add('Diagonal cell borders are drawn as lines anchored in the cell.');
    const [first, ...rest] = c.blocks;
    return first?.kind === 'p' ? [{ ...first, runs: [...lines, ...first.runs] }, ...rest] : [{ kind: 'p', props: { line: 1, lineType: 1 }, runs: lines }, ...c.blocks];
  }
  function tableXml(table, owner, depth) {
    const { rows, cols } = table; check(rows > 0 && cols > 0 && rows * cols <= LIMITS.cells);
    const grid = Array.from({ length: rows }, () => Array(cols).fill(null)), widths = Array(cols).fill(0), starts = Array.from({ length: rows }, () => []);
    for (const c of table.cells) {
      check(Number.isInteger(c.col) && Number.isInteger(c.row) && Number.isInteger(c.colSpan) && Number.isInteger(c.rowSpan) && c.col >= 0 && c.row >= 0 && c.colSpan > 0 && c.rowSpan > 0 && c.col + c.colSpan <= cols && c.row + c.rowSpan <= rows, 'The Hanword document has invalid table cell addresses.');
      starts[c.row].push(c);
      for (let y = c.row; y < c.row + c.rowSpan; y++) for (let x = c.col; x < c.col + c.colSpan; x++) { check(!grid[y][x], 'The Hanword document has overlapping table cells.'); grid[y][x] = c; }
      if (c.colSpan === 1) widths[c.col] = Math.max(widths[c.col], c.width || 0);
    }
    for (const c of table.cells) { const missing = Array.from({ length: c.colSpan }, (_, i) => c.col + i).filter((x) => !widths[x]); const known = widths.slice(c.col, c.col + c.colSpan).reduce((a, b) => a + b, 0);
      for (const x of missing) widths[x] = Math.max(1, ((c.width || 7200 * c.colSpan) - known) / missing.length); }
    const total = widths.reduce((a, b) => a + (b || 7200), 0);
    const out = new XmlBuffer();
    // Hanword places captions on a chosen side; DOCX has no side captions, so top/left go before the table and the rest after.
    const captionFirst = table.caption && (table.captionSide === 'TOP' || table.captionSide === 'LEFT');
    if (captionFirst) out.append(blocksXml(table.caption, owner, depth));
    out.append(`<w:tbl><w:tblPr><w:tblW w:w="${bounded(twips(total), 1)}" w:type="dxa"/>${['left', 'center', 'right'].includes(table.align) ? val('jc', table.align) : ''}${table.cellSpacing ? `<w:tblCellSpacing w:w="${Math.max(0, twips(table.cellSpacing))}" w:type="dxa"/>` : ''}${borderXml(table.border, 'tblBorders')}${shadeXml(table.border)}<w:tblLayout w:type="fixed"/>${marginXml(table.padding, 'tblCellMar')}</w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${bounded(Math.max(1, twips(w || 7200)), 1)}"/>`).join('')}</w:tblGrid>`);
    let headerCount = table.repeatHeader ? 1 : 0;
    while (headerCount && headerCount < rows && starts[headerCount].length && starts[headerCount].every((c) => c.header)) headerCount++;
    // A partial vertical merge cannot repeat as a header row. Decorative HWP frames often
    // start with a cell spanning several body rows and are not table headings.
    if (table.cells.some((c) => c.row < headerCount && c.row + c.rowSpan > headerCount)) headerCount = 0;
    for (let y = 0; y < rows; y++) {
      const rowCells = starts[y], height = Math.max(0, ...rowCells.filter((c) => c.rowSpan === 1).map((c) => c.height || 0));
      const mergedArtwork = grid[y].some((c) => c?.rowSpan > 1) && grid[y].every((c) => !c || c.blocks.every((p) => p.kind === 'p' && p.runs.every((r) => ['image', 'shape', 'group'].includes(r.kind) || r.kind === 'text' && !r.text.trim())));
      // An inline graphic in a vertically merged cell spans the sum of the
      // source rows. Growing its first row to the whole graphic height counts
      // that height twice and can strand a decorative heading on another page.
      out.append(`<w:tr><w:trPr>${table.cantSplit ? '<w:cantSplit/>' : ''}${height ? `<w:trHeight w:val="${bounded(twips(height), 1)}" w:hRule="${mergedArtwork ? 'exact' : 'atLeast'}"/>` : ''}${y < headerCount ? '<w:tblHeader/>' : ''}</w:trPr>`);
      for (let x = 0; x < cols;) {
        const c = grid[y][x];
        if (!c) { out.append('<w:tc><w:p/></w:tc>'); x++; continue; }
        const continuing = y !== c.row;
        const gradient = !inTextBox && decorativeGradient(c), pictureCell = !inTextBox && !gradient && decorativePicture(c);
        if (inTextBox && (decorativeGradient(c) || decorativePicture(c))) model.warnings.add('A decorative cell fill inside a text box keeps its base color.');
        const padding = gradient || pictureCell ? { left: 0, top: 0, right: 0, bottom: 0 } : c.padding;
        out.append(`<w:tc><w:tcPr><w:tcW w:w="${bounded(twips(c.width || widths.slice(c.col, c.col + c.colSpan).reduce((a, b) => a + b, 0)), 1)}" w:type="dxa"/>${c.colSpan > 1 ? val('gridSpan', c.colSpan) : ''}${c.rowSpan > 1 ? val('vMerge', continuing ? 'continue' : 'restart') : ''}${borderXml(c.border || table.border, 'tcBorders')}${shadeXml(c.border)}${marginXml(padding, 'tcMar')}${c.direction ? val('textDirection', c.direction) : ''}${val('vAlign', c.align || 'top')}</w:tcPr>`);
        // A one-point paragraph mark avoids an empty cell's font metrics
        // increasing the height of a thin decorative rule.
        const content = continuing ? '' : gradient || pictureCell
          ? `<w:p><w:pPr>${paragraphProperties({ line: c.height, lineType: 1 })}${runProperties({ size: 100 })}</w:pPr>${picture(gradient ? gradientPicture(c) : { ...c.pictureFill, width: c.width, height: c.height }, owner)}</w:p>`
          : blocksXml(withDiagonals(c, table), owner, depth);
        out.append(content + (!content || !content.endsWith('</w:p>') ? '<w:p/>' : '') + '</w:tc>'); x += c.colSpan;
      }
      out.append('</w:tr>');
    }
    out.append('</w:tbl>');
    if (table.caption && !captionFirst) out.append(blocksXml(table.caption, owner, depth));
    return out.finish();
  }
  // Header/footer inheritance is resolved before writing. In particular, a
  // generated first-page part must never accidentally inherit another section's.
  const even = model.sections.some((s) => [...(s.headers || []), ...(s.footers || [])].some((h) => h.type === 'even' || h.type === 'odd') || /^(OUTSIDE|INSIDE)_/.test(s.pageNumber?.position || ''));
  const inherited = { header: new Map(), footer: new Map() }; let inheritedNumber = null;
  /** DOCX border styles back to the line styles the shape writer draws; widths are eighths of a point. */
  const lineFromBorder = (line) => ({ color: line.color || '000000', width: Math.max(12.5, (line.size || 4) * 12.5) * (line.style === 'double' || /^thick|^thin/.test(line.style || '') ? 2.5 : line.style === 'thick' ? 2 : 1), style: ({ dashed: 'DASH', dotted: 'DOT', dotDash: 'DASH_DOT', dotDotDash: 'DASH_DOT_DOT' })[line.style] || 'SOLID', cap: 'FLAT' });
  function pageBorderFrame(section) {
    const border = section.pageBorder?.border, page = section.page || { width: 59528, height: 84189, left: 8504, right: 8504, top: 7200, bottom: 7200 };
    const line = border && ['top', 'left', 'bottom', 'right'].map((side) => border[side]).find((side) => side && side.style !== 'nil');
    if (!line) return null;
    const offset = section.pageBorder.offset || {}, o = (side) => Math.max(0, Number(offset[side]) || 0);
    const frame = section.pageBorder.fromText
      ? { x: page.left - o('left'), y: page.top - o('top'), width: page.width - page.left - page.right + o('left') + o('right'), height: page.height - page.top - page.bottom + o('top') + o('bottom') }
      : { x: o('left'), y: o('top'), width: page.width - o('left') - o('right'), height: page.height - o('top') - o('bottom') };
    if (!(frame.width > 0 && frame.height > 0)) return null;
    model.warnings.add('Page borders are drawn as a rectangle anchored in the page header.');
    return { kind: 'p', props: { line: 1, lineType: 1 }, runs: [{ kind: 'shape', shape: 'rect', width: frame.width, height: frame.height, fill: null, line: lineFromBorder(line), blocks: [],
      layout: { h: 'page', v: 'page', x: frame.x, y: frame.y, hAlign: 'left', vAlign: 'top', wrap: 'none', behind: true, overlap: true, zOrder: 0 } }] };
  }
  function sectionXml(section) {
    let out = '';
    if (section.pageNumber) inheritedNumber = section.pageNumber;
    const number = inheritedNumber, numberedKind = /TOP/.test(number?.position || '') ? 'header' : 'footer';
    const titlePage = !!(section.hideFirstHeader || section.hideFirstFooter || section.hideFirstPageNum);
    function numberParagraph(type) {
      const pos = number.position;
      const align = pos.includes('CENTER') ? 'center' : pos.includes('LEFT') ? 'left' : pos.includes('RIGHT') ? 'right'
        : (pos.startsWith('OUTSIDE') === (type !== 'even') ? 'right' : 'left');
      return { kind: 'p', props: { align }, runs: [
        { kind: 'text', text: number.prefix || '', char: number.char },
        { kind: 'field', instruction: 'PAGE', text: String(section.pageStart || 1), char: number.char },
        { kind: 'text', text: number.suffix || '', char: number.char },
      ] };
    }
    for (const [kind, list] of [['header', section.headers], ['footer', section.footers]]) {
      const effective = inherited[kind];
      for (const item of list || []) {
        const type = item.type === 'odd' ? 'default' : item.type || 'default';
        effective.set(type, item.blocks);
        if (even && type === 'default' && item.type !== 'odd') effective.set('even', item.blocks);
      }
      const numbered = number && number.position && number.position !== 'NONE' && kind === numberedKind;
      // The editor paints no page borders, so the header of every page carries
      // an anchored, unfilled rectangle at the border's position (Hanword shows
      // the border on a page whose header is hidden as well).
      const frame = kind === 'header' ? pageBorderFrame(section) : null;
      const variants = new Map();
      for (const type of even ? ['default', 'even'] : ['default']) {
        const blocks = [...(effective.get(type) || [])];
        if (numbered) blocks.push(numberParagraph(type));
        if (frame) blocks.unshift(frame);
        if (blocks.length || effective.has(type)) variants.set(type, blocks);
      }
      if (titlePage) {
        const firstType = section.pageStart && section.pageStart % 2 === 0 ? 'even' : 'default';
        const hidden = section[kind === 'header' ? 'hideFirstHeader' : 'hideFirstFooter'];
        const blocks = hidden ? [] : [...(effective.get('first') || effective.get(firstType) || effective.get('default') || [])];
        if (!hidden && numbered && !section.hideFirstPageNum) blocks.push(numberParagraph(firstType));
        if (frame) blocks.unshift(frame);
        variants.set('first', blocks);
      }
      // Identical BOTH variants can share a part and relationship.
      const rendered = new Map();
      for (const [type, blocks] of variants) {
        const name = `${kind}${++headerId}`, content = blocksXml(blocks, name) || '<w:p/>';
        let rid = !parts.get(name)?.size && rendered.get(content);
        if (!rid) { addPart(name, kind, content, kind === 'header' ? 'hdr' : 'ftr'); rid = rel('document', kind, `${name}.xml`); if (!parts.get(name)?.size) rendered.set(content, rid); }
        out += `<w:${kind}Reference w:type="${type}" r:id="${rid}"/>`;
      }
    }
    for (const kind of ['footNote', 'endNote']) if (section[kind]) {
      const note = section[kind], tag = kind.toLowerCase();
      out += `<w:${tag}Pr>${val('numFmt', docxNumberFormat(note.format || 'decimal'))}${val('numStart', Math.max(1, note.start || 1))}${val('numRestart', note.restart || 'continuous')}</w:${tag}Pr>`;
    }
    let p = section.page || { width: 59528, height: 84189, left: 8504, right: 8504, top: 7200, bottom: 7200, header: 3600, footer: 3600, gutter: 0 };
    check(p.width > 0 && p.height > 0 && p.width <= 1000000 && p.height <= 1000000);
    // A page smaller than a twip is no page; one larger than the 22-inch DOCX page-size limit (a poster) is scaled down whole, margins included.
    if (twips(p.width) < 1 || twips(p.height) < 1) { model.warnings.add('A page size too small for DOCX was replaced by Letter.'); p = { ...p, width: 61200, height: 79200 }; }
    const overflow = Math.max(twips(p.width), twips(p.height)) / DOCX_MAX_TWIPS;
    if (overflow > 1) {
      model.warnings.add('A page larger than the 22-inch DOCX page-size limit was scaled down to fit it.');
      p = Object.fromEntries(Object.entries(p).map(([key, value]) => [key, typeof value === 'number' ? value / overflow : value]));
    }
    out += `<w:type w:val="${section.breakType || 'nextPage'}"/><w:pgSz w:w="${Math.max(1, twips(p.width))}" w:h="${Math.max(1, twips(p.height))}"${p.width > p.height ? ' w:orient="landscape"' : ''}/><w:pgMar ${['top', 'right', 'bottom', 'left', 'header', 'footer', 'gutter'].map((s) => `w:${s}="${bounded(twips(p[s]))}"`).join(' ')}/>`;
    // Page borders and line numbers are written for other DOCX readers; the editor does not paint either.
    if (section.pageBorder?.border) out += `<w:pgBorders w:offsetFrom="${section.pageBorder.fromText ? 'text' : 'page'}">${['top', 'left', 'bottom', 'right'].map((side) => { const line = section.pageBorder.border[side]; return line && line.style !== 'nil' ? `<w:${side} w:val="${xml(line.style)}" w:sz="${borderSize(line.size)}"${borderSpace(section.pageBorder.offset?.[side] ?? 0)} w:color="${xml(line.color || 'auto')}"/>` : ''; }).join('')}</w:pgBorders>`;
    // Line numbers are drawn beside the lines (see lineNumberRuns); DOCX line numbering would double them.
    if (section.pageStart || number?.format) out += `<w:pgNumType${section.pageStart ? ` w:start="${Math.max(1, Math.round(section.pageStart))}"` : ''}${number?.format ? ` w:fmt="${xml(docxNumberFormat(number.format))}"` : ''}/>`;
    const count = section.columns || 1, sizes = section.columnSizes || [];
    check(Number.isInteger(count) && count > 0 && count <= 45, 'This Hanword column layout exceeds the DOCX limit of 45 columns.');
    const custom = sizes.length === count && sizes.every((c) => c.width > 0 && c.gap >= 0);
    out += `<w:cols w:num="${count}" w:space="${Math.max(0, twips(section.columnGap ?? 3600))}"${custom ? ' w:equalWidth="0"' : ''}${section.columnSeparator ? ' w:sep="1"' : ''}>${custom ? sizes.map((c) => `<w:col w:w="${twips(c.width)}" w:space="${twips(c.gap)}"/>`).join('') : ''}</w:cols>`;
    if (titlePage) out += '<w:titlePg/>';
    if (section.direction) out += val('textDirection', section.direction);
    return `<w:sectPr>${out}</w:sectPr>`;
  }
  /**
   * A section's properties ride on its last paragraph, as DOCX stores them; a
   * paragraph of their own would show as a blank line (or a blank page) at every
   * section change. Only a section ending in a table gets that paragraph, since
   * DOCX needs one after a table anyway.
   */
  function withSectionProperties(blocks, sect) {
    const own = `<w:p><w:pPr>${sect}</w:pPr></w:p>`;
    if (!blocks.endsWith('</w:p>')) return blocks + own;
    // Paragraphs nest inside text boxes: walk back from the end to the opening of the last top-level one.
    let depth = 0, at = blocks.length;
    for (;;) {
      const open = blocks.lastIndexOf('<w:p>', at - 1), close = blocks.lastIndexOf('</w:p>', at - 1);
      if (open < 0) return blocks + own;
      if (close > open) { depth += 1; at = close; continue; }
      depth -= 1; at = open;
      if (depth === 0) break;
    }
    const start = at + '<w:p>'.length;
    // Section properties are the last thing in a paragraph's properties.
    if (blocks.startsWith('<w:pPr>', start)) { const end = blocks.indexOf('</w:pPr>', start); return blocks.slice(0, end) + sect + blocks.slice(end); }
    return blocks.slice(0, start) + `<w:pPr>${sect}</w:pPr>` + blocks.slice(start);
  }
  const body = new XmlBuffer();
  const bodyStory = story();
  for (const [i, section] of model.sections.entries()) {
    if (section.lineNumbers) {
      const previous = lineNumbering;
      lineNumbering = { ...section.lineNumbers, countBy: Math.max(1, section.lineNumbers.countBy || 1), start: Math.max(1, section.lineNumbers.start || 1), previousY: undefined };
      lineNumbering.n = previous && section.lineNumbers.restart === 'continuous' ? previous.n : lineNumbering.start - 1;
    } else lineNumbering = null;
    const blocks = blocksXml(section.blocks, 'document', 0, bodyStory);
    const sect = sectionXml(section);
    if (i === model.sections.length - 1) {
      body.append(blocks);
      const ending = closeStory(bodyStory); if (ending) body.append(`<w:p>${ending}</w:p>`);
      body.append(sect);
    } else body.append(withSectionProperties(blocks, sect));
  }
  addPart('document', 'document.main', `<w:body>${body.finish()}</w:body>`, 'document');
  const styles = `<w:docDefaults><w:rPrDefault>${runProperties(model.chars[0], { withLang: true, style: true })}</w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` + joinXml(model.styles, (s, i) => s ? `<w:style w:type="${s.type || 'paragraph'}" w:styleId="HwpStyle${i}"><w:name w:val="${xml(s.name?.replaceAll(',', ' '))}"/>${s.type !== 'character' ? val('basedOn', 'Normal') : ''}${s.type !== 'character' ? `<w:pPr>${paragraphProperties(model.paras[s.para])}</w:pPr>` : ''}${runProperties(model.chars[s.char], { withLang: true, style: true })}</w:style>` : '');
  addPart('styles', 'styles', styles, 'styles'); rel('document', 'styles', 'styles.xml');
  if (lists.size) {
    const numbering = new XmlBuffer();
    // A paragraph can sit deeper than its numbering defines; such an item shows an empty marker, so every level up to the ninth is defined, the deeper ones after the last.
    const padded = (levels) => { const out = [...levels]; while (out.length && out.length < 9) out.push({ ...out.at(-1), level: out.length }); return out; };
    for (const { id, levels } of lists.values()) numbering.append(`<w:abstractNum w:abstractNumId="${id}">${val('multiLevelType', 'multilevel')}${joinXml(padded(levels), (l) => {
      const pattern = (l.text || `^${l.level + 1}.`).replace(/\^([1-9])/g, '%$1').replace(/\^[nN]/g, (s) => Array.from({ length: l.level + 1 }, (_, i) => `%${i + 1}`).join('.') + (s === '^N' ? '.' : ''));
      return `<w:lvl w:ilvl="${l.level}">${val('start', l.start || 1)}${val('numFmt', docxNumberFormat(l.format))}${val('lvlText', pattern)}${val('lvlJc', l.align || 'left')}${model.chars[l.char] ? runProperties(model.chars[l.char]) : ''}</w:lvl>`;
    })}</w:abstractNum>`);
    for (const { id } of lists.values()) numbering.append(`<w:num w:numId="${id}">${val('abstractNumId', id)}</w:num>`);
    addPart('numbering', 'numbering', numbering.finish(), 'numbering'); rel('document', 'numbering', 'numbering.xml');
  }
  addPart('settings', 'settings', (model.sections[0]?.defaultTab ? val('defaultTabStop', Math.max(1, Math.min(31680, twips(model.sections[0].defaultTab)))) : '') + (even ? '<w:evenAndOddHeaders/>' : '') + '<w:compat/>', 'settings'); rel('document', 'settings', 'settings.xml');
  // Comments first, then the notes: a note met while a comment or another note is written joins the
  // list it belongs to, so every reference has its note and no relationship points to a missing part.
  const commentsXml = joinXml(comments, (comment) => {
    const date = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(comment.date || '') ? ` w:date="${xml(comment.date)}"` : '';
    return `<w:comment w:id="${comment.id}" w:author="${xml(comment.author || '')}"${date}>${endsWithParagraph(blocksXml(comment.blocks, 'comments'))}</w:comment>`;
  });
  const noteXml = { footnotes: [], endnotes: [] };
  for (let more = true; more;) {
    more = false;
    for (const kind of ['footnotes', 'endnotes']) {
      const tag = kind.slice(0, -1);
      while (noteXml[kind].length < notes[kind].length) {
        const note = notes[kind][noteXml[kind].length];
        const blocks = [...note.blocks], label = { kind: 'noteLabel', end: kind === 'endnotes' };
        if (blocks[0]?.kind === 'p') blocks[0] = { ...blocks[0], runs: [label, ...blocks[0].runs] };
        else blocks.unshift({ kind: 'p', runs: [label] });
        noteXml[kind].push(`<w:${tag} w:id="${note.id}">${endsWithParagraph(blocksXml(blocks, kind))}</w:${tag}>`);
        more = true;
      }
    }
  }
  for (const kind of ['footnotes', 'endnotes']) if (noteXml[kind].length) {
    const tag = kind.slice(0, -1); const contents = new XmlBuffer();
    contents.append(`<w:${tag} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${tag}><w:${tag} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${tag}>`);
    for (const chunk of noteXml[kind]) contents.append(chunk);
    addPart(kind, kind, contents.finish(), kind);
  }
  if (comments.length) addPart('comments', 'comments', commentsXml, 'comments');
  let coreRelationship = '';
  if (model.metadata && Object.values(model.metadata).some(Boolean)) {
    const namespaces = 'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
    addFile('docProps/core.xml', `${XML}<cp:coreProperties ${namespaces}>${Object.entries(model.metadata).map(([key, value]) => {
      if ((key === 'created' || key === 'modified') && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) return `<dcterms:${key} xsi:type="dcterms:W3CDTF">${xml(value)}</dcterms:${key}>`;
      const tag = { title: 'dc:title', subject: 'dc:subject', creator: 'dc:creator', description: 'dc:description', language: 'dc:language', keywords: 'cp:keywords', lastModifiedBy: 'cp:lastModifiedBy' }[key];
      return tag && value ? `<${tag}>${xml(value)}</${tag}>` : '';
    }).join('')}</cp:coreProperties>`);
    types.push('<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>');
    coreRelationship = '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>';
  }
  // Readers refuse a package whose external target is not a valid URI: the characters a URI cannot hold are percent-encoded.
  const uri = (target) => target.replace(/[<>"{}|\\^`\s]/g, (c) => encodeURIComponent(c));
  for (const [name, list] of parts) addFile(`word/_rels/${name}.xml.rels`, `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${joinXml(list.values(), (r) => `<Relationship Id="${r.id}" Type="${R}/${r.type}" Target="${xml(r.external ? uri(r.target) : r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`)}</Relationships>`);
  addFile('_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>${coreRelationship}</Relationships>`);
  addFile('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${joinXml(types)}</Types>`);
  // Pictures are already compressed: deflating them again costs seconds on a picture-heavy file for nothing.
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, name.startsWith('word/media/') ? [bytes, { level: 0 }] : bytes])), { level: 6 });
}

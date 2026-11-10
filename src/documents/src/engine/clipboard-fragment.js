import { paragraphText, paragraphFormat, locate } from './model.js';
import { runFormat } from './formatting.js';
import { listKind } from './numbering.js';
import { HIGHLIGHTS } from './backgrounds.js';
import { showLink } from './link-appearance.js';
import { normalizeCrop, FULL_TURN, OBJECT, validateImage, nextDrawingId } from './images.js';

// Formatted copy and paste. A copy carries HTML for other applications, with
// the editor's own fragment embedded for an exact paste back here. Pasting
// inserts the text first and then reapplies paragraph and character
// formatting through the ordinary commands, so the result is one undo step
// and passes the same validation as typing and toolbar edits. Selections with
// structures that plain text cannot rebuild (tables, fields, controls,
// pictures, notes) keep the plain-text path.

export const FRAGMENT_ATTRIBUTE = 'data-documents-fragment';
const RUN_KEYS = ['bold', 'italic', 'underlineStyle', 'strikethrough', 'color', 'highlight', 'fontSize', 'fontAscii', 'verticalAlign', 'capitalization'];
const MAX_RUNS = 2000;

// Trimming by scanning from the end. A regular expression anchored only at the end (/ +$/) tries every
// start position, so a page with a long stretch of spaces or line breaks before its last word took time
// growing with the square of that stretch: a few hundred kilobytes held the window for minutes.
function trimEnd(text, chars) {
  let end = text.length;
  while (end && chars.includes(text[end - 1])) end--;
  return end === text.length ? text : text.slice(0, end);
}
function trimControls(text) {
  let start = 0, end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start++;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end--;
  return text.slice(start, end);
}
// Whitespace holding a line break is one space, as a browser shows it (\s+ matches each stretch once).
const joinLines = text => text.replace(/\s+/g, space => space.includes('\n') ? ' ' : space);

const plainRun = run => !run.image && !run.math && !run.vml && !run.bodySymbol && !run.noteMark && !run.contentControl && !run.field && !/[\u000e￼]/.test(run.text);
// A paragraph a formatted paste can go into: no field, note, content control or object anywhere in it.
const plainParagraph = p => !p.blockControls?.length && !p.fieldMarkers?.length && p.runs.every(plainRun);

/**
 * Whether a paste at the selection (or `range`) can take formatting. The commands that reapply it work on the
 * pasted text by offsets, which fields, notes and content controls in the paragraphs it goes into could shift;
 * those paragraphs take plain text. Elsewhere in a document that has them, formatting is pasted as usual.
 */
export function carriesFormatting(model, [start, end] = model.range) {
  if (!(model.hasContentControls || model.hasBodyFields || model.hasBlockControls || model.hasNoteMarks || model.hasPlainTextControls || model.hasMacroButtons)) return true;
  const first = locate(model.paragraphs, start).index, last = locate(model.paragraphs, end).index;
  for (let i = first; i <= last; i++) if (!plainParagraph(model.paragraphs[i])) return false;
  return true;
}

/**
 * The selection as paragraphs of formatted runs, or null when it holds more than text. `hidden(run)` leaves out text
 * the view hides (a deletion in Simple Markup, hidden text): the fragment cannot carry it as hidden.
 */
export function copyFragment(model, { hidden = () => false, objects = null } = {}) {
  const [start, end] = model.range;
  let carried = 0;
  // What the selection holds decides (each run is checked below); fields or notes elsewhere do not.
  if (start === end) return null;
  const paragraphs = []; let at = 0, runCount = 0, cell = null;
  const last = model.paragraphs.at(-1);
  for (const p of model.paragraphs) {
    const length = paragraphText(p).length, from = at, to = at + length;
    at = to + 1;
    if (to < start || from > end) continue;
    // Text within one table cell copies as the paragraphs it is; across cells, or into or out of a table, the
    // selection holds table structure the fragment cannot carry.
    if (!paragraphs.length) cell = p.cellId || null;
    else if ((p.cellId || null) !== cell) return null;
    const runs = []; let offset = from;
    for (const run of p.runs) {
      if (hidden(run)) { offset += run.text.length; continue; }
      const a = Math.max(start, offset), b = Math.min(end, offset + run.text.length);
      const overlaps = b > a || (!run.text && offset >= start && offset < end);
      // A picture, shape or equation in the text goes with it to a paste in this document (`objects`, below).
      const object = overlaps && !plainRun(run) && objects ? carriedObject(model, run) : null;
      if (object) { runs.push({ text: OBJECT_STAND_IN, object, format: {} }); runCount++; carried++; offset += run.text.length; continue; }
      if (overlaps && !plainRun(run)) return null;
      if (b > a) {
        const format = runFormat(run), entry = { text: run.text.slice(a - offset, b - offset), format: Object.fromEntries(RUN_KEYS.map(key => [key, format[key]])) };
        if (run.link?.target) entry.link = run.link.target;
        const last = runs.at(-1);
        if (last && last.link === entry.link && RUN_KEYS.every(key => last.format[key] === entry.format[key])) last.text += entry.text;
        else { runs.push(entry); runCount++; }
      }
      offset += run.text.length;
    }
    if (runCount > MAX_RUNS) return null;
    const format = paragraphFormat(p, model.numbering, model.pageSettings), style = model.styles.definitions[p.styleId];
    // The document's last paragraph has no break after it to select, so its mark goes with it when the selection
    // takes it whole and runs to the document's end, as Select All does: pasted, it keeps its own formatting.
    const mark = (to >= start && to < end) || (p === last && to === end && from >= start && (from > start || start === 0) && !p.cellId);
    paragraphs.push({ text: runs.map(r => r.text).join(''), runs, mark,
      styleId: p.styleId || null, styleName: style?.name || null, alignment: format.alignment,
      list: p.list ? { kind: listKind(model.numbering, p.list), level: p.list.level } : null });
  }
  if (!paragraphs.length) return null;
  return carried ? { paragraphs, objects: { token: objects.token, story: objects.story ?? null } } : { paragraphs };
}

/**
 * Objects a copy of text carries for a paste in the same document and story: an equation as its Office Math, a
 * picture, shape, text box or group as the drawing itself, which keeps its parts there (`objects.token` names the
 * open document; other documents and other applications get the text alone). Charts and diagrams are not carried.
 */
export const OBJECT_STAND_IN = '\ue000';
const CARRIED_DRAWINGS = /graphicData[^>]*uri="http:\/\/schemas\.(?:openxmlformats\.org\/drawingml\/2006\/picture|microsoft\.com\/office\/word\/2010\/(?:wordprocessingShape|wordprocessingGroup))"/;
function carriedObject(model, run) {
  if (run.text !== '\ufffc' || run.revision || run.field || run.noteMark || run.contentControl) return null;
  if (run.math?.xml) return { math: { xml: run.math.xml, text: run.math.text || '' } };
  const image = run.image;
  if (!image || image.kind === 'chart' || image.hidden || !model.assets?.[image.assetId] || (image.shell ? !CARRIED_DRAWINGS.test(image.shell) : !!image.kind)) return null;
  return { image: JSON.parse(JSON.stringify(image)) };
}

const escape = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Only the values the editor writes go into a style attribute: a document shared for co-editing holds what anyone
// in the room wrote, and a color of `000"><img src=…>` became markup in the HTML a copy put on the clipboard.
const hexColor = value => typeof value === 'string' && /^[0-9a-fA-F]{6}$/.test(value) ? value : null;
const pointSize = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const HTML_ALIGNMENTS = { center: 'center', right: 'right', both: 'justify', thaiDistribute: 'justify', distribute: 'justify;text-align-last:justify' };

function runHtml(run) {
  const f = run.format, style = [], color = hexColor(f.color), size = pointSize(f.fontSize);
  if (color) style.push(`color:#${color}`);
  if (typeof f.highlight === 'string' && Object.hasOwn(HIGHLIGHTS, f.highlight) && HIGHLIGHTS[f.highlight]) style.push(`background-color:#${HIGHLIGHTS[f.highlight]}`);
  if (size) style.push(`font-size:${size}pt`);
  if (f.fontAscii) style.push(`font-family:${escape(JSON.stringify(f.fontAscii))}`);
  if (f.capitalization === 'caps') style.push('text-transform:uppercase');
  if (f.capitalization === 'smallCaps') style.push('font-variant:small-caps');
  let html = escape(run.object ? '' : run.text).replace(/\v/g, '<br>');
  if (style.length) html = `<span style="${style.join(';')}">${html}</span>`;
  if (f.verticalAlign === 'superscript') html = `<sup>${html}</sup>`;
  if (f.verticalAlign === 'subscript') html = `<sub>${html}</sub>`;
  if (f.strikethrough && f.strikethrough !== 'none') html = `<s>${html}</s>`;
  if (f.underlineStyle && f.underlineStyle !== 'none') html = `<u>${html}</u>`;
  if (f.italic) html = `<i>${html}</i>`;
  if (f.bold) html = `<b>${html}</b>`;
  // The schemes a link here may have (checkedHyperlinkTarget); nothing else becomes an href.
  if (run.link && /^(https?:|mailto:|tel:)/i.test(run.link)) html = `<a href="${escape(run.link)}">${html}</a>`;
  return html;
}

/** HTML for other applications, carrying the fragment for this editor. */
export function fragmentHtml(fragment) {
  let html = '', openList = null;
  for (const p of fragment.paragraphs) {
    const kind = p.list?.kind === 'bullet' ? 'ul' : p.list ? 'ol' : null;
    if (openList !== kind) { if (openList) html += `</${openList}>`; if (kind) html += `<${kind}>`; openList = kind; }
    const heading = /^Heading([1-6])$/.exec(p.styleId || '')?.[1] || (p.styleId === 'Title' ? '1' : null);
    const tag = kind ? 'li' : heading ? `h${heading}` : 'p';
    // Tabs and runs of spaces are the text's own, which HTML collapses into one space unless told otherwise.
    const align = Object.hasOwn(HTML_ALIGNMENTS, p.alignment ?? '') ? `;text-align:${HTML_ALIGNMENTS[p.alignment]}` : '';
    html += `<${tag} style="white-space:pre-wrap${align}">${p.runs.map(runHtml).join('') || '<br>'}</${tag}>`;
  }
  if (openList) html += `</${openList}>`;
  return `<div ${FRAGMENT_ATTRIBUTE}="${escape(JSON.stringify(fragment))}">${html}</div>`;
}

/* ---------- A picture ---------- */

export const PICTURE_ATTRIBUTE = 'data-documents-picture';
const PICTURE_MIME = /^image\/(png|jpeg|tiff)$/i, EMU_PER_PX = 9525, MAX_PICTURE_EMU = 22 * 914400;

function base64(bytes) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/**
 * Whether the selection is one picture a copy carries as HTML: the image for other applications, with
 * its size and alternative text so a paste back here inserts the picture rather than its plain-text
 * stand-in. Charts, diagrams and drawings, and pictures in formats a paste cannot insert, are not.
 */
export function copiesPicture(model) {
  const image = model.selectedImage, asset = image && model.assets[image.assetId];
  return !!image && !image.kind && asset?.bytes instanceof Uint8Array && PICTURE_MIME.test(asset.mime || '');
}

/** The HTML `copiesPicture` describes, or '' when the selection is not such a picture. */
export function pictureHtml(model) {
  if (!copiesPicture(model)) return '';
  const image = model.selectedImage, asset = model.assets[image.assetId];
  // A paste here keeps the frame, crop, flips and rotation. Other applications get the whole image: a cropped
  // picture's frame has the cropped shape, so the image takes its own proportions there.
  const cropped = Object.values(image.crop || {}).some(Boolean);
  const data = { alt: image.alt || '', width: image.width, height: image.height, ...(cropped ? { crop: image.crop } : {}),
    ...(image.flipH ? { flipH: true } : {}), ...(image.flipV ? { flipV: true } : {}), ...(image.rotation ? { rotation: image.rotation } : {}) };
  const size = cropped ? '' : ` width="${Math.round(image.width / EMU_PER_PX)}" height="${Math.round(image.height / EMU_PER_PX)}"`;
  return `<img src="data:${asset.mime};base64,${base64(asset.bytes)}" alt="${escape(data.alt)}"${size} ${PICTURE_ATTRIBUTE}="${escape(JSON.stringify(data))}">`;
}

/** The picture a copy from this editor carries in its HTML, as a file with its size and alternative text, or null. */
export function htmlPicture(html) {
  if (typeof DOMParser === 'undefined' || !html || !html.includes(PICTURE_ATTRIBUTE)) return null;
  const img = new DOMParser().parseFromString(html, 'text/html').querySelector(`img[${PICTURE_ATTRIBUTE}]`);
  const match = /^data:(image\/(?:png|jpeg|tiff));base64,([A-Za-z0-9+/=]+)$/i.exec(img?.getAttribute('src') || '');
  if (!match) return null;
  let data = {}, binary;
  try { data = JSON.parse(img.getAttribute(PICTURE_ATTRIBUTE)) || {}; binary = atob(match[2]); } catch { return null; }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const size = ['width', 'height'].every(key => Number.isSafeInteger(data[key]) && data[key] > 0 && data[key] <= MAX_PICTURE_EMU) ? { width: data.width, height: data.height } : {};
  // A crop only goes with the frame it was made for.
  let crop = null;
  try { if (size.width && data.crop) crop = normalizeCrop(data.crop); } catch { crop = null; }
  const turn = Number.isInteger(data.rotation) && data.rotation > 0 && data.rotation < FULL_TURN ? { rotation: data.rotation } : {};
  return { file: new File([bytes], `picture.${match[1].split('/')[1]}`, { type: match[1].toLowerCase() }), alt: typeof data.alt === 'string' ? data.alt.slice(0, 2000) : '', ...size,
    ...(crop ? { crop } : {}), ...(data.flipH === true ? { flipH: true } : {}), ...(data.flipV === true ? { flipV: true } : {}), ...turn };
}

/* ---------- HTML from this editor or another application ---------- */

const BLOCKS = new Set(['P', 'DIV', 'CENTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'TR', 'TABLE', 'UL', 'OL', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'MAIN', 'ADDRESS', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'HR', 'TBODY', 'THEAD', 'TFOOT', 'BODY']);
/** Blocks in a table cell that keep their own lines: lists, and the rows of a table nested in it. */
const CELL_STRUCTURE = new Set(['LI', 'UL', 'OL', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'DL', 'HR']);
const SKIPPED = new Set(['SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'META', 'LINK', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'OBJECT', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
const NAMED_COLORS = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', orange: 'FFA500', purple: '800080' };

function cssColor(value) {
  const v = String(value || '').trim().toLowerCase();
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  let m = /^#([0-9a-f]{6})$/.exec(v); if (m) return m[1].toUpperCase();
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v); if (m) return (m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toUpperCase();
  m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m && (m[4] === undefined || parseFloat(m[4]) > 0)) return [m[1], m[2], m[3]].map(n => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('').toUpperCase();
  return null;
}

function inherited(el, format) {
  const next = { ...format }, tag = el.tagName, s = el.style || {};
  if (tag === 'B' || tag === 'STRONG' || /^H[1-6]$/.test(tag) || tag === 'TH') next.bold = true;
  if (tag === 'I' || tag === 'EM' || tag === 'CITE' || tag === 'DFN') next.italic = true;
  if (tag === 'U' || tag === 'INS') next.underlineStyle = 'single';
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') next.strikethrough = 'single';
  if (tag === 'SUP') next.verticalAlign = 'superscript';
  if (tag === 'SUB') next.verticalAlign = 'subscript';
  // A weight or style the element inherits (inherit, unset: both inherited properties) is its parent's, as a reset
  // style sheet's "font: inherit" makes a span inside bold text say.
  const own = value => value && !/^(inherit|unset)$/i.test(value);
  if (own(s.fontWeight)) next.bold = s.fontWeight === 'bold' || s.fontWeight === 'bolder' || Number(s.fontWeight) >= 600;
  else if (s.fontWeight) next.bold = format.bold;
  if (own(s.fontStyle)) next.italic = s.fontStyle === 'italic' || s.fontStyle === 'oblique';
  else if (s.fontStyle) next.italic = format.italic;
  const decoration = `${s.textDecorationLine || ''} ${s.textDecoration || ''}`;
  if (/underline/.test(decoration)) next.underlineStyle = 'single';
  if (/line-through/.test(decoration)) next.strikethrough = 'single';
  if (s.verticalAlign === 'super') next.verticalAlign = 'superscript';
  if (s.verticalAlign === 'sub') next.verticalAlign = 'subscript';
  const color = cssColor(s.color);
  if (color) next.color = color === '000000' ? 'auto' : color;
  return next;
}

// Word writes a list item as a paragraph styled mso-list:l0 level1, with its number or bullet as text
// in a span styled mso-list:Ignore (for browsers without list support). The marker is not content.
const msoList = el => /mso-list\s*:\s*([^;"']*)/i.exec(el.getAttribute?.('style') || '')?.[1].trim() || '';
function wordListItem(el) {
  const level = /^l\d+\s+level(\d+)/i.exec(msoList(el))?.[1];
  if (!level) return null;
  const marker = [...el.querySelectorAll('[style]')].find(child => /^ignore$/i.test(msoList(child)))?.textContent.replace(/[\s\u00a0]/g, '') || '';
  // A number is "1.", "a)", "(iv)" or a multilevel "1.2" / "1.2.1." (or digits alone); anything else ("o", "§", "•") is a bullet.
  const numbered = /^\(?[0-9a-z]{1,6}[.)]$/i.test(marker) || /^\d{1,6}(?:\.\d{1,6})*\.?$/.test(marker);
  return { kind: numbered ? 'number' : 'bullet', level: Math.max(0, Math.min(8, Number(level) - 1)) };
}

function fromForeignHtml(body) {
  const paragraphs = [];
  let lists = 0;
  let current = null;
  const start = (props = {}) => { current = { text: '', runs: [], mark: true, styleId: null, styleName: null, alignment: null, list: null, ...props }; paragraphs.push(current); };
  const append = (text, format, link, pre = false) => {
    // Whitespace between blocks is source layout, not a paragraph.
    if (!text || !current && !/\S|\v/.test(text)) return;
    if (!current) start();
    // Preformatted text keeps the spaces it starts or ends with (an indented line of code).
    if (!current.filled) current.preStart = pre;
    current.preEnd = pre;
    current.filled = true;
    const last = current.runs.at(-1);
    if (last && last.link === link && RUN_KEYS.every(key => last.format[key] === format[key])) last.text += text;
    else current.runs.push({ text, format: { ...format }, ...(link ? { link } : {}) });
    current.text += text;
  };
  const end = () => {
    // A block that only contains other blocks (a quotation around paragraphs) is not a paragraph itself.
    if (current && !current.filled && paragraphs.at(-1) === current) paragraphs.pop();
    if (current?.runs.length) {
      // Whitespace around a block's content is layout in HTML, not text.
      if (!current.preStart) current.runs[0].text = current.runs[0].text.replace(/^ +/, '');
      const last = current.runs.at(-1); if (!current.preEnd) last.text = trimEnd(last.text, ' ');
      current.runs = current.runs.filter(r => r.text);
      // A block holding only no-break spaces is an empty paragraph kept open (Word's <o:p>&nbsp;</o:p>).
      if (/^[ \u00a0]*$/.test(current.runs.map(r => r.text).join(''))) current.runs = [];
      current.text = current.runs.map(r => r.text).join('');
    }
    current = null;
  };
  const walk = (node, format, context) => {
    if (node.nodeType === 3) {
      let text = context.pre ? node.data : joinLines(node.data).replace(/[ \t\r\f]+/g, ' ');
      if (context.pre) text = text.replace(/\r\n?/g, '\n').replace(/\n/g, '\v');
      if (!context.pre && (!current || /[ \t\v]$/.test(current.text) || !current.text) && text.startsWith(' ')) text = text.slice(1);
      append(text, format, context.link, !!context.pre);
      return;
    }
    if (node.nodeType !== 1 || SKIPPED.has(node.tagName) || /^ignore$/i.test(msoList(node))) return;
    const tag = node.tagName;
    // Word for the web ends each paragraph with a no-break space in a span of class EOP. It holds an empty
    // paragraph open, as Word's <o:p>&nbsp;</o:p> does, and is not text.
    if (tag === 'SPAN' && node.classList?.contains('EOP')) { if (current) current.filled = true; return; }
    if (tag === 'BR') { if (!node.classList?.contains('Apple-interchange-newline')) append('\v', format, context.link); return; }
    const next = inherited(node, format);
    const ctx = { ...context };
    if (tag === 'A') {
      // A browser follows an address with the spaces and line breaks around it (and tabs and line breaks in it) left out.
      const href = trimControls(node.getAttribute('href') || '').replace(/[\t\n\r]/g, '');
      if (/^(https?:|mailto:|tel:)/i.test(href)) ctx.link = href;
    }
    // Word writes a tab as no-break spaces styled mso-tab-count, and a run of spaces as no-break spaces styled
    // mso-spacerun, so a browser shows their width: they are a tab and ordinary spaces.
    const declared = node.getAttribute?.('style') || '', tabs = /mso-tab-count\s*:\s*(\d+)/i.exec(declared)?.[1];
    if (tabs) { append('\t'.repeat(Math.max(1, Math.min(Number(tabs), 64))), next, ctx.link); return; }
    if (/mso-spacerun\s*:\s*yes/i.test(declared)) { append(node.textContent.replace(/\u00a0/g, ' '), next, ctx.link, true); return; }
    // Preformatted text (pre, or white-space: pre or pre-wrap, as Google Docs and code editors write it) keeps its
    // tabs, runs of spaces and line breaks.
    const space = node.style?.whiteSpace;
    if (tag === 'PRE' || /^(pre|pre-wrap|break-spaces)$/.test(space || '')) ctx.pre = true;
    else if (/^(normal|nowrap|pre-line)$/.test(space || '')) ctx.pre = false;
    // Alignment is inherited, as on a page: from text-align, the align attribute READMEs center
    // blocks with or <center>. A table's align attribute centers the table, not its text, and the
    // cells of a table centered by its container (as Word writes one) keep their own alignment.
    const align = node.style?.textAlign || (tag !== 'TABLE' && node.getAttribute('align')) || (tag === 'CENTER' && 'center');
    if (align || tag === 'TABLE') ctx.align = { center: 'center', right: 'right', justify: 'both' }[align && align.toLowerCase()] || null;
    // Each list is told apart (`id`) so its items number on past paragraphs and lists inside them, and a list right
    // after another starts again; an ordered list keeps the number it starts at.
    if (tag === 'UL' || tag === 'OL') {
      const start = tag === 'OL' ? Number.parseInt(node.getAttribute('start') ?? '', 10) : NaN;
      ctx.list = { kind: tag === 'UL' ? 'bullet' : 'number', level: context.list ? Math.min(8, context.list.level + 1) : 0, id: ++lists, ...(Number.isSafeInteger(start) && start >= 0 && start <= 32767 ? { start } : {}) };
    }
    // Every cell after a row's first starts after a tab, an empty one included, so the cells after it stay in their columns.
    if ((tag === 'TD' || tag === 'TH') && current && /^T[DH]$/.test(node.previousElementSibling?.tagName || '')) {
      const last = current.runs.at(-1);
      if (last) { last.text = trimEnd(last.text, ' '); current.text = trimEnd(current.text, ' '); }
      append('\t', format, null);
    }
    // A list item's own paragraph wrapper (as some producers write) is the item, not another paragraph.
    const wrapper = (tag === 'P' || tag === 'DIV') && current?.list && !current.text && context.item === current;
    // A table row is one paragraph, its cells apart by tabs: the paragraphs Word, LibreOffice and Google Docs write in
    // every cell are text of the row, one after another, not paragraphs of their own.
    if (tag === 'TD' || tag === 'TH') ctx.cell = true;
    const cellBlock = context.cell && current && BLOCKS.has(tag) && !CELL_STRUCTURE.has(tag);
    if (cellBlock && current.text && !/[\t ]$/.test(current.text)) append(' ', format, null);
    const block = BLOCKS.has(tag) && !wrapper && !cellBlock;
    if (block) {
      end();
      if (!['UL', 'OL', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'DL', 'BODY'].includes(tag)) {
        const heading = /^H([1-6])$/.exec(tag)?.[1];
        start({ styleName: heading ? `Heading ${heading}` : 'Normal', alignment: ctx.align || null, list: tag === 'LI' ? ctx.list || { kind: 'bullet', level: 0 } : wordListItem(node) });
      }
    }
    if (tag === 'LI') ctx.item = current;
    // A horizontal rule is an empty paragraph with a line under it, as Word draws one (and makes of "---").
    if (tag === 'HR' && current) { current.rule = true; current.filled = true; }
    for (const child of node.childNodes) walk(child, next, ctx);
    if (block) end();
  };
  walk(body, { bold: false, italic: false }, {});
  // Empty blocks between content are blank paragraphs; leading and trailing ones are not content.
  for (const p of paragraphs) {
    delete p.filled; delete p.preStart; delete p.preEnd;
    const last = p.runs.at(-1);
    if (last) { last.text = trimEnd(last.text, '\v'); p.runs = p.runs.filter(r => r.text); }
    p.text = p.runs.map(r => r.text).join('');
  }
  while (paragraphs.length && !paragraphs[0].text) paragraphs.shift();
  while (paragraphs.length && !paragraphs.at(-1).text) paragraphs.pop();
  if (!paragraphs.length) return null;
  // A phrase keeps the destination paragraph's formatting. Of several blocks, the
  // last keeps its own only when it is a list item or heading, so lists stay whole.
  const last = paragraphs.at(-1);
  last.mark = paragraphs.length > 1 && (!!last.list || /^Heading/.test(last.styleName || ''));
  return { paragraphs, foreign: true };
}

/**
 * The fragment an HTML clipboard item holds, from this editor or converted from another application. `copied`: the
 * HTML may be this editor's own copy, whose description of what was copied stands for it; a file opened or inserted
 * is read as it is, whatever description it holds.
 */
export function htmlFragment(html, { copied = true } = {}) {
  if (typeof DOMParser === 'undefined' || !html) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const own = copied && doc.querySelector(`[${FRAGMENT_ATTRIBUTE}]`);
  if (own) {
    try {
      const fragment = JSON.parse(own.getAttribute(FRAGMENT_ATTRIBUTE));
      if (Array.isArray(fragment?.paragraphs) && fragment.paragraphs.every(p => typeof p.text === 'string' && Array.isArray(p.runs) && p.runs.map(r => r.text).join('') === p.text)) return fragment;
    } catch { /* fall through to the HTML itself */ }
  }
  return fromForeignHtml(doc.body);
}

/* ---------- Paste ---------- */

function attempt(action) { try { action(); } catch { /* A property the destination cannot take keeps its own value. */ } }

function styleFor(model, p) {
  const definitions = model.styles.definitions;
  if (p.styleId && definitions[p.styleId]?.type === 'paragraph' && (!p.styleName || definitions[p.styleId].name === p.styleName)) return p.styleId;
  const name = String(p.styleName || '').toLowerCase();
  if (!name) return null;
  return Object.values(definitions).find(s => s.type === 'paragraph' && !s.error && String(s.name || '').toLowerCase() === name)?.id || null;
}

/**
 * The item of a list another application wrote (`p.list.id`): it goes on in the list its earlier items went into here,
 * though a paragraph or another list came between, and the first item of a list starts it again at its number when
 * the list goes on from one pasted before it, or starts at another number. `lists`: each list's numbering so far.
 */
function continueList(model, p, lists) {
  const target = model.selectedParagraphs[0];
  if (!target?.list || p.list?.id == null) return;
  const known = lists.get(p.list.id);
  if (known != null) {
    if (target.list.numId !== known) { target.list = { ...target.list, numId: known, direct: true }; target.listChanged = true; }
    return;
  }
  const joined = [...lists.values()].includes(target.list.numId);
  if (p.list.kind === 'number' && (joined || (p.list.start ?? 1) !== 1)) attempt(() => model.restartNumbering(p.list.start ?? 1));
  lists.set(p.list.id, model.selectedParagraphs[0].list?.numId);
}

function applyParagraph(model, p, foreign, lists = new Map()) {
  const style = styleFor(model, p);
  if (style) attempt(() => model.setParagraphStyle(style));
  else if (!foreign && p.styleId === null) attempt(() => model.setParagraphStyle(''));
  if (p.alignment && model.paragraphFormatting.alignment !== p.alignment) attempt(() => model.setParagraphFormat({ alignment: p.alignment }));
  if (p.rule === true) attempt(() => model.setParagraphFormat({ paragraphBorders: { bottom: { style: 'single', size: 6, space: 1, color: 'auto' } } }));
  const current = model.listFormatting;
  if (p.list) {
    if (current !== p.list.kind) {
      if (current === 'bullet' || current === 'number') attempt(() => model.toggleList(current));
      attempt(() => model.toggleList(p.list.kind));
    }
    // A list without the deeper level indents the item instead of changing its level (changeListLevel): once is enough.
    for (let i = 0; i < 8 && model.selectedParagraphs[0]?.list && model.selectedParagraphs[0].list.level < p.list.level; i++) {
      const level = model.selectedParagraphs[0].list.level;
      attempt(() => model.changeListLevel(1));
      if (model.selectedParagraphs[0]?.list?.level === level) break;
    }
    continueList(model, p, lists);
  } else if (current === 'bullet' || current === 'number') attempt(() => model.toggleList(current));
}

function applyRun(model, from, to, run, foreign) {
  model.select(from, to);
  const current = model.runFormatting, patch = {};
  for (const key of RUN_KEYS) {
    const value = run.format[key];
    // Another application's plain values (not bold, black) leave the destination's own formatting.
    if (value === undefined || value === null || foreign && (value === false || value === 'auto')) continue;
    if (current[key] !== value) patch[key] = value;
  }
  if ('fontAscii' in patch) patch.fontHAnsi = patch.fontAscii;
  if ('fontSize' in patch) patch.fontSizeCs = patch.fontSize;
  if ('bold' in patch) patch.boldCs = patch.bold;
  if ('italic' in patch) patch.italicCs = patch.italic;
  if (Object.keys(patch).length) {
    try { model.setRunFormat(patch); }
    catch { for (const [key, value] of Object.entries(patch)) attempt(() => model.setRunFormat({ [key]: value })); }
  }
  if (run.link && !model.hyperlink) attempt(() => {
    // Another application's link without its own color gets the usual link look.
    if (model.setHyperlink(run.link) && foreign && !run.format.color) showLink(model);
  });
}

/** Insert a fragment at the selection with its formatting. Returns false when nothing was inserted. */
export function pasteFragment(model, fragment, { token = null, story = null } = {}) {
  // Objects go back only into the document and story they were copied from; elsewhere the text goes alone.
  const carried = !!fragment.objects && !!token && fragment.objects.token === token && (fragment.objects.story ?? null) === story;
  if (fragment.objects && !carried) fragment = withoutObjects(fragment);
  // A copy that ends with the document's last paragraph mark ends that paragraph where it goes: text after the
  // caret keeps its own paragraph and formatting, rather than joining the last pasted paragraph and taking its style.
  if (!fragment.foreign && fragment.paragraphs.at(-1)?.mark) {
    const { index, offset } = locate(model.paragraphs, model.range[1]);
    if (offset < paragraphText(model.paragraphs[index]).length) fragment = { ...fragment, paragraphs: [...fragment.paragraphs, { text: '', runs: [], mark: false }] };
  }
  const text = fragment.paragraphs.map(p => p.text).join('\n');
  if (!model.replace(text)) return false;
  // The caret ends after the inserted text. With Track Changes on, that text
  // follows the struck-out selection rather than starting where it did.
  const start = model.selection.focus - text.length;
  // The caller's session keeps the state before the paste; per-command
  // snapshots of the whole document would only make a long paste quadratic.
  model.checkpoint = () => {};
  // Formatting leaves the pasted text as it is: commands need not join or count through it each time.
  try {
    model.withFixedText(() => applyFragment(model, fragment, start));
    if (carried) placeObjects(model, fragment, start);
  } finally { delete model.checkpoint; }
  return true;
}
function withoutObjects(fragment) {
  const paragraphs = fragment.paragraphs.map(p => { const runs = p.runs.filter(run => !run.object); return { ...p, runs, text: runs.map(run => run.text).join('') }; });
  const { objects: _objects, ...rest } = fragment;
  return { ...rest, paragraphs };
}
/** Put each carried object in place of its stand-in character, from the end so earlier offsets hold. */
function placeObjects(model, fragment, start) {
  const places = []; let at = start;
  for (const p of fragment.paragraphs) { let offset = at; for (const run of p.runs) { if (run.object) places.push({ at: offset, object: run.object }); offset += run.text.length; } at += p.text.length + 1; }
  const after = model.selection.focus;
  let order = Math.max(0, ...model.paragraphs.flatMap(p => p.runs).map(r => r.image?.anchor?.order || 0));
  for (const { at, object } of places.reverse()) {
    model.select(at, at + 1);
    if (model.text[at] !== OBJECT_STAND_IN) continue;
    let placed = false;
    try {
      if (object.math?.xml) placed = model.insertMathRun({ xml: String(object.math.xml), text: String(object.math.text || '') });
      else if (object.image && model.assets?.[object.image.assetId]) {
        const image = { ...object.image, id: nextDrawingId(model.paragraphs) };
        // Identifiers that are unique in a document (paragraphs in a text box, a drawing's edit marks) are left off the copy.
        if (typeof image.shell === 'string') image.shell = image.shell.replace(/\s(?:w14:paraId|w14:textId|wp14:anchorId|wp14:editId)="[^"]*"/g, '');
        if (image.anchor) image.anchor = { ...image.anchor, order: ++order };
        placed = model.replace(OBJECT, { checkpoint: false, insertedImage: validateImage(image) });
      }
    } catch { placed = false; }
    if (!placed) { model.select(at, at + 1); if (model.text[at] === OBJECT_STAND_IN) model.replace('', { checkpoint: false }); }
  }
  model.select(Math.min(after, model.text.length));
}

// Another application's run with only plain values (not bold, black) leaves the destination's formatting.
const plainForeignRun = run => !run.link && RUN_KEYS.every(key => [undefined, null, false, 'auto'].includes(run.format?.[key]));
const appliedRuns = (fragment, p) => p.runs.filter(run => run.text && !run.object && !(fragment.foreign && plainForeignRun(run)));

/**
 * Whether a paste can carry this fragment's formatting. Every paragraph and formatted run is a command
 * over the whole document, so formatting megabytes of another application's HTML would hold the page
 * for minutes; past the limit the text is pasted without it, as a copy of that size here carries none.
 */
export function formattedPasteFits(fragment) {
  let commands = 0;
  for (const p of fragment?.paragraphs || []) if ((commands += (p.mark ? 1 : 0) + appliedRuns(fragment, p).length) > MAX_RUNS) return false;
  return true;
}

/**
 * Formatting a run is a command over its whole paragraph, which splits and joins each of the paragraph's runs,
 * so a paragraph of thousands of formatted runs took time growing with the square of their number: a web page
 * or Markdown file of a few dozen kilobytes ("*a*a*a…", "<b>a</b> <b>a</b> …"), opened or inserted, held the
 * window for minutes. A paragraph's runs cost about their number each; past this many steps in all, a
 * paragraph's text goes in without its character formatting, as a paste past MAX_RUNS does.
 */
const MAX_RUN_STEPS = 1000000;

function applyFragment(model, fragment, start) {
  const after = start + fragment.paragraphs.reduce((n, p) => n + p.text.length + 1, -1);
  let at = start, steps = 0;
  const lists = new Map();
  for (const p of fragment.paragraphs) {
    if (p.mark) { model.select(at); applyParagraph(model, p, !!fragment.foreign, lists); }
    let offset = at;
    let applied = appliedRuns(fragment, p);
    const cost = applied.length * p.runs.length;
    if (steps + cost > MAX_RUN_STEPS) applied = [];
    else steps += cost;
    applied = new Set(applied);
    for (const run of p.runs) { if (applied.has(run)) applyRun(model, offset, offset + run.text.length, run, !!fragment.foreign); offset += run.text.length; }
    at += p.text.length + 1;
  }
  model.select(after);
}

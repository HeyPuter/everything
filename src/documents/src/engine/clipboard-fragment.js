import { paragraphText, paragraphFormat } from './model.js';
import { runFormat } from './formatting.js';
import { listKind } from './numbering.js';
import { HIGHLIGHTS } from './backgrounds.js';
import { showLink } from './link-appearance.js';

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

/** Whether this document's content can be copied or pasted with formatting. */
export function carriesFormatting(model) {
  return !(model.hasContentControls || model.hasBodyFields || model.hasBlockControls || model.hasNoteMarks || model.hasPlainTextControls || model.hasMacroButtons);
}

const plainRun = run => !run.image && !run.math && !run.bodySymbol && !run.noteMark && !run.contentControl && !run.field && !/[\u000e￼]/.test(run.text);

/** The selection as paragraphs of formatted runs, or null when it holds more than text. */
export function copyFragment(model) {
  const [start, end] = model.range;
  if (start === end || !carriesFormatting(model)) return null;
  const paragraphs = []; let at = 0, runCount = 0;
  for (const p of model.paragraphs) {
    const length = paragraphText(p).length, from = at, to = at + length;
    at = to + 1;
    if (to < start || from > end) continue;
    if (p.cellId) return null;
    const runs = []; let offset = from;
    for (const run of p.runs) {
      const a = Math.max(start, offset), b = Math.min(end, offset + run.text.length);
      const overlaps = b > a || (!run.text && offset >= start && offset < end);
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
    paragraphs.push({ text: runs.map(r => r.text).join(''), runs, mark: to >= start && to < end,
      styleId: p.styleId || null, styleName: style?.name || null, alignment: format.alignment,
      list: p.list ? { kind: listKind(model.numbering, p.list), level: p.list.level } : null });
  }
  return paragraphs.length ? { paragraphs } : null;
}

const escape = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function runHtml(run) {
  const f = run.format, style = [];
  if (f.color && f.color !== 'auto') style.push(`color:#${f.color}`);
  if (HIGHLIGHTS[f.highlight]) style.push(`background-color:#${HIGHLIGHTS[f.highlight]}`);
  if (f.fontSize) style.push(`font-size:${f.fontSize}pt`);
  if (f.fontAscii) style.push(`font-family:${escape(JSON.stringify(f.fontAscii))}`);
  if (f.capitalization === 'caps') style.push('text-transform:uppercase');
  if (f.capitalization === 'smallCaps') style.push('font-variant:small-caps');
  let html = escape(run.text).replace(/\v/g, '<br>');
  if (style.length) html = `<span style="${style.join(';')}">${html}</span>`;
  if (f.verticalAlign === 'superscript') html = `<sup>${html}</sup>`;
  if (f.verticalAlign === 'subscript') html = `<sub>${html}</sub>`;
  if (f.strikethrough && f.strikethrough !== 'none') html = `<s>${html}</s>`;
  if (f.underlineStyle && f.underlineStyle !== 'none') html = `<u>${html}</u>`;
  if (f.italic) html = `<i>${html}</i>`;
  if (f.bold) html = `<b>${html}</b>`;
  if (run.link && /^(https?:|mailto:)/i.test(run.link)) html = `<a href="${escape(run.link)}">${html}</a>`;
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
    const align = p.alignment && p.alignment !== 'left' ? ` style="text-align:${p.alignment === 'both' ? 'justify' : p.alignment}"` : '';
    html += `<${tag}${align}>${p.runs.map(runHtml).join('') || '<br>'}</${tag}>`;
  }
  if (openList) html += `</${openList}>`;
  return `<div ${FRAGMENT_ATTRIBUTE}="${escape(JSON.stringify(fragment))}">${html}</div>`;
}

/* ---------- HTML from this editor or another application ---------- */

const BLOCKS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'TR', 'TABLE', 'UL', 'OL', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'MAIN', 'ADDRESS', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'HR', 'TBODY', 'THEAD', 'TFOOT', 'BODY']);
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
  if (s.fontWeight) next.bold = s.fontWeight === 'bold' || s.fontWeight === 'bolder' || Number(s.fontWeight) >= 600;
  if (s.fontStyle) next.italic = s.fontStyle === 'italic' || s.fontStyle === 'oblique';
  const decoration = `${s.textDecorationLine || ''} ${s.textDecoration || ''}`;
  if (/underline/.test(decoration)) next.underlineStyle = 'single';
  if (/line-through/.test(decoration)) next.strikethrough = 'single';
  if (s.verticalAlign === 'super') next.verticalAlign = 'superscript';
  if (s.verticalAlign === 'sub') next.verticalAlign = 'subscript';
  const color = cssColor(s.color);
  if (color) next.color = color === '000000' ? 'auto' : color;
  return next;
}

function fromForeignHtml(body) {
  const paragraphs = [];
  let current = null;
  const start = (props = {}) => { current = { text: '', runs: [], mark: true, styleId: null, styleName: null, alignment: null, list: null, ...props }; paragraphs.push(current); };
  const append = (text, format, link) => {
    // Whitespace between blocks is source layout, not a paragraph.
    if (!text || !current && !/\S|\v/.test(text)) return;
    if (!current) start();
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
      current.runs[0].text = current.runs[0].text.replace(/^ +/, '');
      const last = current.runs.at(-1); last.text = last.text.replace(/ +$/, '');
      current.runs = current.runs.filter(r => r.text);
      current.text = current.runs.map(r => r.text).join('');
    }
    current = null;
  };
  const walk = (node, format, context) => {
    if (node.nodeType === 3) {
      let text = context.pre ? node.data : node.data.replace(/[\s ]*\n[\s ]*/g, ' ').replace(/[ \t\r\f]+/g, ' ');
      if (context.pre) text = text.replace(/\r\n?/g, '\n').replace(/\n/g, '\v');
      if (!context.pre && (!current || /[ \t\v]$/.test(current.text) || !current.text) && text.startsWith(' ')) text = text.slice(1);
      append(text, format, context.link);
      return;
    }
    if (node.nodeType !== 1 || SKIPPED.has(node.tagName)) return;
    const tag = node.tagName;
    if (tag === 'BR') { if (!node.classList?.contains('Apple-interchange-newline')) append('\v', format, context.link); return; }
    const next = inherited(node, format);
    const ctx = { ...context };
    if (tag === 'A' && /^(https?:|mailto:)/i.test(node.getAttribute('href') || '')) ctx.link = node.getAttribute('href');
    if (tag === 'PRE') ctx.pre = true;
    if (tag === 'UL' || tag === 'OL') ctx.list = { kind: tag === 'UL' ? 'bullet' : 'number', level: context.list ? Math.min(8, context.list.level + 1) : 0 };
    if ((tag === 'TD' || tag === 'TH') && current?.text && !/\t$/.test(current.text)) {
      const last = current.runs.at(-1); last.text = last.text.replace(/ +$/, ''); current.text = current.text.replace(/ +$/, '');
      append('\t', format, null);
    }
    // A list item's own paragraph wrapper (as some producers write) is the item, not another paragraph.
    const wrapper = (tag === 'P' || tag === 'DIV') && current?.list && !current.text && context.item === current;
    const block = BLOCKS.has(tag) && !wrapper;
    if (block) {
      end();
      if (!['UL', 'OL', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'DL', 'BODY'].includes(tag)) {
        const heading = /^H([1-6])$/.exec(tag)?.[1];
        const align = { center: 'center', right: 'right', justify: 'both' }[node.style?.textAlign];
        start({ styleName: heading ? `Heading ${heading}` : 'Normal', alignment: align || null, list: tag === 'LI' ? ctx.list || { kind: 'bullet', level: 0 } : null });
      }
    }
    if (tag === 'LI') ctx.item = current;
    for (const child of node.childNodes) walk(child, next, ctx);
    if (block) end();
  };
  walk(body, { bold: false, italic: false }, {});
  // Empty blocks between content are blank paragraphs; leading and trailing ones are not content.
  for (const p of paragraphs) {
    delete p.filled;
    const last = p.runs.at(-1);
    if (last) { last.text = last.text.replace(/\v+$/, ''); p.runs = p.runs.filter(r => r.text); }
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

/** The fragment an HTML clipboard item holds, from this editor or converted from another application. */
export function htmlFragment(html) {
  if (typeof DOMParser === 'undefined' || !html) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const own = doc.querySelector(`[${FRAGMENT_ATTRIBUTE}]`);
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

function applyParagraph(model, p, foreign) {
  const style = styleFor(model, p);
  if (style) attempt(() => model.setParagraphStyle(style));
  else if (!foreign && p.styleId === null) attempt(() => model.setParagraphStyle(''));
  if (p.alignment && model.paragraphFormatting.alignment !== p.alignment) attempt(() => model.setParagraphFormat({ alignment: p.alignment }));
  const current = model.listFormatting;
  if (p.list) {
    if (current !== p.list.kind) {
      if (current === 'bullet' || current === 'number') attempt(() => model.toggleList(current));
      attempt(() => model.toggleList(p.list.kind));
    }
    for (let i = 0; i < 8 && model.selectedParagraphs[0]?.list && model.selectedParagraphs[0].list.level < p.list.level; i++) attempt(() => model.changeListLevel(1));
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
export function pasteFragment(model, fragment) {
  const text = fragment.paragraphs.map(p => p.text).join('\n');
  if (!model.replace(text)) return false;
  // The caret ends after the inserted text. With Track Changes on, that text
  // follows the struck-out selection rather than starting where it did.
  const start = model.selection.focus - text.length;
  // The caller's session keeps the state before the paste; per-command
  // snapshots of the whole document would only make a long paste quadratic.
  model.checkpoint = () => {};
  try { applyFragment(model, fragment, start); } finally { delete model.checkpoint; }
  return true;
}

// Another application's run with only plain values (not bold, black) leaves the destination's formatting.
const plainForeignRun = run => !run.link && RUN_KEYS.every(key => [undefined, null, false, 'auto'].includes(run.format?.[key]));
const appliedRuns = (fragment, p) => p.runs.filter(run => run.text && !(fragment.foreign && plainForeignRun(run)));

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

function applyFragment(model, fragment, start) {
  const after = start + fragment.paragraphs.reduce((n, p) => n + p.text.length + 1, -1);
  let at = start;
  for (const p of fragment.paragraphs) {
    if (p.mark) { model.select(at); applyParagraph(model, p, !!fragment.foreign); }
    let offset = at;
    const applied = new Set(appliedRuns(fragment, p));
    for (const run of p.runs) { if (applied.has(run)) applyRun(model, offset, offset + run.text.length, run, !!fragment.foreign); offset += run.text.length; }
    at += p.text.length + 1;
  }
  model.select(after);
}

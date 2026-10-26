/**
 * Export the body of a document model as a web page, Markdown or plain text — the File > Export
 * formats besides .docx and PDF. These are readable approximations: headings, paragraphs, lists,
 * tables, links and bold/italic/underline/strike/super/subscript survive; page layout, pictures,
 * fields, headers and footers, notes, comments and hidden text do not.
 */
import { documentBlocks } from '../engine/tables.js';
import { listKind, listMarkers } from '../engine/numbering.js';
import { TextDocument } from '../engine/model.js';
import { hasRevisions } from '../engine/revisions.js';

const OBJECT = '￼';
const escapeHtml = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Hidden text is neither shown nor printed, so a downloaded or published copy leaves it out too.
const runText = run => run.vanish ? '' : String(run.text || '').replace(new RegExp(OBJECT, 'g'), '');

/** A heading level 1–6 from a paragraph's style, or 0. */
export function headingLevel(p, styles) {
  const id = p.styleId || '';
  const name = String(styles?.definitions?.[id]?.name || id).toLowerCase().replace(/\s+/g, '');
  if (name === 'title') return 1;
  const m = /^heading([1-9])$/.exec(name);
  return m ? Math.min(6, Number(m[1])) : 0;
}

function safeLink(run) {
  const target = run.link?.target;
  return typeof target === 'string' && /^(https?:|mailto:|tel:)/i.test(target) ? target : null;
}
/**
 * The document as it reads with its tracked changes accepted: deleted text gone, inserted text kept, as the
 * page shows it once reviewed. A copy is resolved, so the open document keeps its changes for review.
 */
function finalModel(model) {
  if (!model?.paragraphs || !hasRevisions(model.paragraphs)) return model;
  try {
    const accepted = new TextDocument(model.paragraphs, model.pageSettings, model.numbering, model.stylesEnabled ? model.styles : undefined, model.tables || [], model.assets);
    if (!model.stylesEnabled) accepted.styles = model.styles;
    accepted.resolveRevisions(true);
    return accepted;
  } catch { return model; }
}
const kindOf = (p, numbering) => { try { return listKind(numbering, p.list); } catch { return null; } };
function blocksOf(model) {
  try { return documentBlocks(model.paragraphs, model.tables || []); }
  catch { return model.paragraphs.filter(p => !p.cellId).map(paragraph => ({ type: 'paragraph', paragraph })); }
}
const paragraphOf = block => block.paragraph;
/** Each numbered item's number at its level, as the document shows it (continued lists and start values included). */
function itemNumbers(model) {
  const numbers = new Map();
  try {
    listMarkers(model.paragraphs, model.numbering).forEach((marker, i) => {
      const p = model.paragraphs[i], value = marker?.counters[p.list.level];
      if (Number.isSafeInteger(value) && value >= 0) numbers.set(p, value);
    });
  } catch { /* Items count from 1 within each list instead. */ }
  return numbers;
}
const listLevel = p => Math.max(0, Math.min(8, p.list?.level || 0));
/**
 * A table's rows as lists of cell texts, one per grid column: a merged cell's text stands in its first
 * column and row, and the columns and rows it also covers (and cells a row leaves out) are empty, so
 * every later cell stays under its own heading.
 */
const tableRows = (block, cellText) => block.rows.map(row => {
  const cells = Array(row.gridBefore || 0).fill('');
  for (const cell of row.cells) cells.push(cell.rowSpan === 0 ? '' : cellText(cell), ...Array(Math.max(0, (cell.span || 1) - 1)).fill(''));
  return cells.concat(Array(row.gridAfter || 0).fill(''));
});
/**
 * A cell's text: its paragraphs joined by `lineBreak`, and a table nested in it flattened in place, its
 * cells joined by `cellBreak` and its rows by `lineBreak`, since neither format can nest one table in another.
 */
const cellText = (cell, paragraphText, cellBreak, lineBreak) => cell.content.map(c => c.type === 'table'
  ? tableRows(c, inner => cellText(inner, paragraphText, cellBreak, lineBreak)).map(row => row.filter(Boolean).join(cellBreak)).filter(Boolean).join(lineBreak)
  : paragraphText(c.paragraph)).join(lineBreak);

/* ---- HTML ---- */
function runHtml(run, heading = false) {
  // Line, page and column breaks all start a new line: a web page has no pages or columns to break.
  let html = escapeHtml(runText(run)).replace(/[\v\f\u000e]/g, '<br>');
  if (!html) return '';
  if (run.verticalAlign === 'superscript') html = `<sup>${html}</sup>`;
  if (run.verticalAlign === 'subscript') html = `<sub>${html}</sub>`;
  if (run.strikethrough && run.strikethrough !== 'none') html = `<s>${html}</s>`;
  if (run.underline || (run.underlineStyle && run.underlineStyle !== 'none')) html = `<u>${html}</u>`;
  if (run.italic) html = `<em>${html}</em>`;
  if (run.bold && !heading) html = `<strong>${html}</strong>`;
  const link = safeLink(run);
  if (link) html = `<a href="${escapeHtml(link)}">${html}</a>`;
  return html;
}
function blocksHtml(blocks, model, numbers = itemNumbers(model)) {
  // The open lists, outermost first; each holds an open item a deeper list nests in.
  let html = '';
  const lists = [];
  const closeList = () => { const { tag } = lists.pop(); html += `</li></${tag}>`; };
  const closeLists = () => { while (lists.length) closeList(); };
  for (const block of blocks) {
    if (block.type === 'table') {
      closeLists();
      html += '<table>' + block.rows.map(row => '<tr>' + row.cells.filter(cell => cell.rowSpan !== 0).map(cell => {
        const span = (cell.span || 1) > 1 ? ` colspan="${cell.span}"` : '';
        const rows = cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : '';
        return `<td${span}${rows}>${blocksHtml(cell.content.map(c => c.type ? c : { type: 'paragraph', ...c }), model, numbers)}</td>`;
      }).join('') + '</tr>').join('') + '</table>';
      continue;
    }
    const p = paragraphOf(block);
    const kind = kindOf(p, model.numbering), tag = kind === 'bullet' ? 'ul' : kind ? 'ol' : null;
    if (!tag) closeLists();
    else {
      const depth = listLevel(p);
      while (lists.length && lists.at(-1).depth > depth) closeList();
      if (lists.at(-1)?.depth === depth && lists.at(-1).tag !== tag) closeList();
      if (lists.at(-1)?.depth === depth) html += '</li>';
      else {
        const start = tag === 'ol' ? numbers.get(p) ?? 1 : 1;
        html += `<${tag}${start !== 1 ? ` start="${start}"` : ''}>`;
        lists.push({ tag, depth });
      }
    }
    const level = headingLevel(p, model.styles);
    const inner = p.runs.map(run => runHtml(run, !!level)).join('') || '<br>';
    const alignment = p.format?.alignment;
    const align = ['center', 'right', 'both'].includes(alignment) ? ` style="text-align:${alignment === 'both' ? 'justify' : alignment}"` : '';
    html += tag ? `<li${align}>${inner}` : level ? `<h${level}${align}>${inner}</h${level}>` : `<p${align}>${inner}</p>`;
  }
  closeLists();
  return html;
}

/** A standalone, readable web page of the document. */
export function documentHtml(model, { title = 'Document' } = {}) {
  model = finalModel(model);
  const body = blocksHtml(blocksOf(model), model);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; }
body { max-width: 46rem; margin: 2.5rem auto; padding: 0 1rem; font: 17px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1f1f1f; background: #fff; }
@media (prefers-color-scheme: dark) { body { color: #e8e8e8; background: #161616; } a { color: #8ab4f8; } td { border-color: #444; } }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 .5em; }
table { border-collapse: collapse; margin: 1em 0; } td { border: 1px solid #ccc; padding: .35em .6em; vertical-align: top; }
td > p:first-child { margin-top: 0; } td > p:last-child { margin-bottom: 0; }
</style></head>
<body>
${body}
</body></html>
`;
}

/* ---- Markdown ---- */
// Text keeps its characters on reading back: emphasis, code, link, heading, HTML and table punctuation, a
// strikethrough tilde, and an ampersand that would start a character reference are escaped.
const mdEscape = text => text.replace(/([\\`*_[\]#<>|~])/g, '\\$1').replace(/&(?=#\d+;|#x[\da-f]+;|[a-z][a-z\d]*;)/gi, '\\&');
// A web address in the text is written as an autolink (<https://…>), whose characters read back as they are.
// Escaped, Markdown readers would link it with the backslashes in it: "https://example.com/a\\_b" is linked
// as typed, backslashes and all. Trailing punctuation ends the sentence, not the address, as in GitHub's
// autolinks. An address an autolink cannot carry (one with a pipe, which would split a table cell) and a
// www. address that needs escapes start with a character reference instead, so no reader links them and
// their escapes read back as text. So does a www. address that runs straight into more than whitespace (an
// escaped "<", or the next run's text or emphasis markers): a reader's www. link goes on to the next
// whitespace, and would take those characters, backslashes and markers into its text.
const WEB_ADDRESS = /(?<![A-Za-z])(?:https?:\/\/[^\s<>\u0000-\u001f\u007f]+|www\.[^\s<>\u0000-\u001f\u007f]*)/giu;
// An address written so that no reader links it: its first character, and that of any address inside it
// ("www.a.org]http://b.org"), as a character reference.
const unlinked = address => mdEscape(address).replace(/(?:https?:\/\/|www\.)/gi, start => `&#${start.charCodeAt(0)};${start.slice(1)}`);
function mdText(text, next = '') {
  let out = '', at = 0;
  for (const match of text.matchAll(WEB_ADDRESS)) {
    let address = match[0];
    if (/^https?:/i.test(address) && !address.includes('|')) {
      for (;;) {
        const last = address.at(-1);
        if (/[?!.,:*_~'"]/.test(last) || last === ')' && address.split('(').length < address.split(')').length) address = address.slice(0, -1);
        else break;
      }
      out += `${mdEscape(text.slice(at, match.index))}<${address}>`;
    } else if (mdEscape(address) !== address || !/^[\s\u000e]?$/.test(text[match.index + address.length] ?? next)) out += `${mdEscape(text.slice(at, match.index))}${unlinked(address)}`;
    else continue;
    at = match.index + address.length;
  }
  return out + mdEscape(text.slice(at));
}
// A line of text that starts like a block (a list item, a thematic break, a setext underline or indented
// code) would become one; the punctuation is escaped and indentation's first space written as a reference.
const escapeLineStart = line => line.replace(/^(?: {4,}|\t)/, space => `&#${space.charCodeAt(0)};${space.slice(1)}`)
  .replace(/^( {0,3})([-+=])/, '$1\\$2').replace(/^( {0,3}\d{1,9})([.)])/, '$1\\$2');
// Breaks stand as NUL (which document text cannot hold) until the paragraph knows how its lines break.
const BREAK = '\0';
// A run's escaped text, split around its core when the run writes markers, tags or a link around it. `next`
// is the character the paragraph's text goes on with after the run.
function runPieces(run, heading, next) {
  const link = safeLink(run);
  // A link's text cannot hold another link, so an address in it stays escaped text.
  const text = (link ? mdEscape : mdText)(runText(run), next).replace(/[\v\f\u000e]/g, BREAK);
  const strike = run.strikethrough && run.strikethrough !== 'none', bold = run.bold && !heading;
  if (!/[^\s\0]/.test(text) || !(strike || run.italic || bold || ['superscript', 'subscript'].includes(run.verticalAlign) || link)) return { text };
  // Breaks at a run's edges stay outside its emphasis markers, as spaces do.
  const [, lead, core, trail] = /^([\s\0]*)([\s\S]*?)([\s\0]*)$/.exec(text);
  return { text, lead, core, trail, run, strike, bold, link };
}
// The character a run writes first or last (`end`); a marker, tag or link bracket is punctuation.
const edge = (piece, end) => !piece ? '' : !piece.core ? (end ? piece.text.at(-1) : piece.text[0]) : (end ? piece.trail.at(-1) : piece.lead[0]) || '*';
// CommonMark punctuation (Unicode P and S). A marker between a word and punctuation is not one: it opens only
// after whitespace or punctuation and closes only before them, so x**\_y\_**z would show its asterisks.
const PUNCTUATION = /[\p{P}\p{S}]/u;
const loose = c => !c || /[\s\0]/.test(c) || PUNCTUATION.test(c);
function runMarkdown(piece, before, after, touching = false) {
  if (!piece.core) return piece.text;
  const { lead, core, trail, run } = piece, chars = [...core];
  // Emphasis that markers cannot give there is written as HTML, which reads back the same. So is emphasis
  // whose markers would run straight into the previous run's closing ones: "***a*****b**" reads back with
  // stray asterisks.
  const tags = PUNCTUATION.test(chars[0]) && !loose(lead.at(-1) || before) || PUNCTUATION.test(chars.at(-1)) && !loose(trail[0] || after)
    || touching && !lead && !piece.link;
  let out = core;
  if (piece.strike) out = tags ? `<del>${out}</del>` : `~~${out}~~`;
  if (run.italic) out = tags ? `<em>${out}</em>` : `*${out}*`;
  if (piece.bold) out = tags ? `<strong>${out}</strong>` : `**${out}**`;
  if (run.verticalAlign === 'superscript') out = `<sup>${out}</sup>`;
  if (run.verticalAlign === 'subscript') out = `<sub>${out}</sub>`;
  if (piece.link) out = `[${out}](${piece.link.replace(/[()\s|]/g, encodeURIComponent)})`;
  return lead + out + trail;
}
/** A paragraph's Markdown, its line, page and column breaks written as `lineBreak`. */
// A break at either end of a paragraph has no line to start: Markdown would show a backslash there.
const paragraphMarkdown = (p, heading = false, lineBreak = '\\\n') => {
  const texts = p.runs.map(runText), following = [];
  for (let i = texts.length - 1, next = ''; i >= 0; i--) { following[i] = next; next = texts[i][0] || next; }
  const pieces = p.runs.map((run, i) => runPieces(run, heading, following[i])).filter(piece => piece.text);
  const written = [];
  pieces.forEach((piece, i) => {
    const previous = written[i - 1] || '';
    const touching = !!pieces[i - 1]?.core && !pieces[i - 1].trail && /[*~]$/.test(previous);
    written.push(runMarkdown(piece, edge(pieces[i - 1], true), edge(pieces[i + 1], false), touching));
    // An exclamation mark just before a link would make it a picture ("Wow![docs](…)"), which drops its text.
    if (piece.link && !piece.lead && previous.endsWith('!')) written[i - 1] = `${previous.slice(0, -1)}\\!`;
  });
  return written.join('').replace(/^\0+|\0+$/g, '')
    .split(BREAK).map(escapeLineStart).join(heading ? ' ' : lineBreak);
};
function blocksMarkdown(blocks, model) {
  const out = [], numbers = itemNumbers(model);
  // The open list levels, outermost first: where each level's markers start and its items' text begins.
  let lists = [], previousList = null;
  for (const block of blocks) {
    if (block.type === 'table') {
      // Text already escapes its pipes (and link targets encode theirs), so none ends a cell early.
      const rows = tableRows(block, cell => cellText(cell, p => paragraphMarkdown(p, false, '<br>'), ' \\| ', '<br>')).map(row => row.map(text => text || ' '));
      if (rows.length) {
        const width = Math.max(...rows.map(r => r.length));
        const pad = r => [...r, ...Array(width - r.length).fill(' ')];
        out.push(['| ' + pad(rows[0]).join(' | ') + ' |', '|' + ' --- |'.repeat(width), ...rows.slice(1).map(r => '| ' + pad(r).join(' | ') + ' |')].join('\n'));
      }
      previousList = null; lists = [];
      continue;
    }
    const p = block.paragraph, kind = kindOf(p, model.numbering), level = headingLevel(p, model.styles);
    const text = paragraphMarkdown(p, !!level);
    if (kind) {
      // A deeper item is indented to its parent item's text, which nests it under that item.
      const depth = listLevel(p);
      while (lists.length && lists.at(-1).depth > depth) lists.pop();
      let list = lists.at(-1);
      if (list?.depth !== depth) { list = { depth, indent: list ? list.content : 0, kind: null, number: 0 }; lists.push(list); }
      const number = numbers.get(p) ?? (list.kind === kind ? list.number + 1 : 1);
      Object.assign(list, { kind, number });
      const marker = kind === 'bullet' ? '-' : `${number}.`, indent = ' '.repeat(list.indent);
      list.content = list.indent + marker.length + 1;
      // A line after a break is indented to the item's text, so it stays in the item.
      const line = `${indent}${marker} ${text.replace(/\n/g, `\n${' '.repeat(list.content)}`)}`;
      if (previousList) out[out.length - 1] += `\n${line}`; else out.push(line);
      previousList = kind;
      continue;
    }
    previousList = null; lists = [];
    if (level) out.push(`${'#'.repeat(level)} ${text.trim()}`);
    else if (text.trim()) out.push(text);
  }
  return out.join('\n\n');
}

export function documentMarkdown(model) {
  model = finalModel(model);
  return `${blocksMarkdown(blocksOf(model), model).trim()}\n`;
}

/* ---- Plain text ---- */
/** Each list item's marker as the document shows it ("1.", "a)", "•") and what separates it from the text. */
function itemMarkers(model) {
  const markers = new Map();
  try {
    listMarkers(model.paragraphs, model.numbering).forEach((marker, i) => {
      if (marker?.text) markers.set(model.paragraphs[i], marker.text + ({ space: ' ', nothing: '' }[marker.level.suffix] ?? '\t'));
    });
  } catch { /* Items are written without their markers instead. */ }
  return markers;
}
export function documentPlainText(model) {
  model = finalModel(model);
  const lines = [], markers = itemMarkers(model);
  // A list item keeps its number or bullet, indented two spaces a level, as text has no other way to show them.
  const marker = (p, indent = true) => markers.has(p) ? (indent ? '  '.repeat(listLevel(p)) : '') + markers.get(p) : '';
  const walk = blocks => {
    for (const block of blocks) {
      if (block.type === 'table') { for (const row of tableRows(block, cell => cellText(cell, p => marker(p, false) + p.runs.map(runText).join('').replace(/[\v\f\u000e]/g, ' '), ' ', ' '))) lines.push(row.join('\t')); continue; }
      lines.push(marker(block.paragraph) + block.paragraph.runs.map(runText).join('').replace(/[\v\f\u000e]/g, '\n'));
    }
  };
  walk(blocksOf(model));
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

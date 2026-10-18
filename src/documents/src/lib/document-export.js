/**
 * Export the body of a document model as a web page, Markdown or plain text — the File > Export
 * formats besides .docx and PDF. These are readable approximations: headings, paragraphs, lists,
 * tables, links and bold/italic/underline/strike/super/subscript survive; page layout, pictures,
 * fields, headers and footers, notes and comments do not.
 */
import { documentBlocks } from '../engine/tables.js';
import { listKind } from '../engine/numbering.js';

const OBJECT = '￼';
const escapeHtml = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const runText = run => String(run.text || '').replace(new RegExp(OBJECT, 'g'), '');

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
const kindOf = (p, numbering) => { try { return listKind(numbering, p.list); } catch { return null; } };
function blocksOf(model) {
  try { return documentBlocks(model.paragraphs, model.tables || []); }
  catch { return model.paragraphs.filter(p => !p.cellId).map(paragraph => ({ type: 'paragraph', paragraph })); }
}
const paragraphOf = block => block.paragraph;
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
  let html = escapeHtml(runText(run)).replace(/\v/g, '<br>').replace(/\f/g, '');
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
function blocksHtml(blocks, model) {
  let html = '', list = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const block of blocks) {
    if (block.type === 'table') {
      closeList();
      html += '<table>' + block.rows.map(row => '<tr>' + row.cells.filter(cell => cell.rowSpan !== 0).map(cell => {
        const span = (cell.span || 1) > 1 ? ` colspan="${cell.span}"` : '';
        const rows = cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : '';
        return `<td${span}${rows}>${blocksHtml(cell.content.map(c => c.type ? c : { type: 'paragraph', ...c }), model)}</td>`;
      }).join('') + '</tr>').join('') + '</table>';
      continue;
    }
    const p = paragraphOf(block);
    const kind = kindOf(p, model.numbering), tag = kind === 'bullet' ? 'ul' : kind ? 'ol' : null;
    if (tag !== list) { closeList(); if (tag) { html += `<${tag}>`; list = tag; } }
    const level = headingLevel(p, model.styles);
    const inner = p.runs.map(run => runHtml(run, !!level)).join('') || '<br>';
    const align = ['center', 'right', 'both'].includes(p.alignment) ? ` style="text-align:${p.alignment === 'both' ? 'justify' : p.alignment}"` : '';
    html += tag ? `<li${align}>${inner}</li>` : level ? `<h${level}${align}>${inner}</h${level}>` : `<p${align}>${inner}</p>`;
  }
  closeList();
  return html;
}

/** A standalone, readable web page of the document. */
export function documentHtml(model, { title = 'Document' } = {}) {
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
const mdEscape = text => text.replace(/([\\`*_[\]#<>|])/g, '\\$1');
function runMarkdown(run, heading = false) {
  let text = mdEscape(runText(run)).replace(/\v/g, '  \n').replace(/\f/g, '');
  if (!text.trim()) return text;
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  let out = core;
  if (run.strikethrough && run.strikethrough !== 'none') out = `~~${out}~~`;
  if (run.italic) out = `*${out}*`;
  if (run.bold && !heading) out = `**${out}**`;
  if (run.verticalAlign === 'superscript') out = `<sup>${out}</sup>`;
  if (run.verticalAlign === 'subscript') out = `<sub>${out}</sub>`;
  const link = safeLink(run);
  if (link) out = `[${out}](${link.replace(/[()\s|]/g, encodeURIComponent)})`;
  return lead + out + trail;
}
const paragraphMarkdown = (p, heading = false) => p.runs.map(run => runMarkdown(run, heading)).join('').replace(/\n/g, ' ');
function blocksMarkdown(blocks, model) {
  const out = []; let counter = 0, previousList = null;
  for (const block of blocks) {
    if (block.type === 'table') {
      // Text already escapes its pipes (and link targets encode theirs), so none ends a cell early.
      const rows = tableRows(block, cell => cellText(cell, p => paragraphMarkdown(p), ' \\| ', '<br>')).map(row => row.map(text => text || ' '));
      if (rows.length) {
        const width = Math.max(...rows.map(r => r.length));
        const pad = r => [...r, ...Array(width - r.length).fill(' ')];
        out.push(['| ' + pad(rows[0]).join(' | ') + ' |', '|' + ' --- |'.repeat(width), ...rows.slice(1).map(r => '| ' + pad(r).join(' | ') + ' |')].join('\n'));
      }
      previousList = null;
      continue;
    }
    const p = block.paragraph, kind = kindOf(p, model.numbering), level = headingLevel(p, model.styles);
    const text = paragraphMarkdown(p, !!level);
    if (kind) {
      counter = previousList === kind ? counter + 1 : 1;
      const indent = '  '.repeat(Math.max(0, Math.min(8, p.list?.level || 0)));
      const line = `${indent}${kind === 'bullet' ? '-' : `${counter}.`} ${text}`;
      if (previousList) out[out.length - 1] += `\n${line}`; else out.push(line);
      previousList = kind;
      continue;
    }
    previousList = null;
    if (level) out.push(`${'#'.repeat(level)} ${text.trim()}`);
    else if (text.trim()) out.push(text);
  }
  return out.join('\n\n');
}

export function documentMarkdown(model) {
  return `${blocksMarkdown(blocksOf(model), model).trim()}\n`;
}

/* ---- Plain text ---- */
export function documentPlainText(model) {
  const lines = [];
  const walk = blocks => {
    for (const block of blocks) {
      if (block.type === 'table') { for (const row of tableRows(block, cell => cellText(cell, p => p.runs.map(runText).join(''), ' ', ' '))) lines.push(row.join('\t')); continue; }
      lines.push(block.paragraph.runs.map(runText).join('').replace(/\v/g, '\n').replace(/\f/g, ''));
    }
  };
  walk(blocksOf(model));
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

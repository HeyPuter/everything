/**
 * The Markdown the AI assistant writes, as page elements: paragraphs, headings, lists, quotes,
 * code, tables, emphasis and links. Built node by node, never through innerHTML, so nothing in
 * a reply (which may quote the workbook's own cells, written by anyone) can become markup.
 *
 * Pictures are never loaded: an image in a reply is how a prompt planted in a cell would carry
 * the sheet off to someone's server the moment the reply is shown (its address carrying the
 * data), so ![alt](url) shows its alt text only. Links go only to http(s) and mailto addresses,
 * open in a new tab, and name where they go in their tooltip.
 *
 * `options.refs(text)` finds cell references in plain text ([{ start, end, target }]), which
 * `options.onRef(target)` follows when one is clicked: the assistant's "B2:B20" selects them.
 * Text that is still arriving renders as far as it goes: an open code fence runs to the end.
 */

import { el } from './dom.js';
import { t } from '../i18n/index.js';

// Any words may follow the opening marks ("```excel formula", "```c#"), as CommonMark has it: a fence not seen for its
// words drew the code as text, and each fence after it turned the reply over between code and text. After backticks they
// hold no backtick: "```=SUM(A1)```" on a line is inline code.
const FENCE_LINE = /^\s{0,3}(```+|~~~+)(.*)$/;
const fence = (line) => { const m = FENCE_LINE.exec(line); return m && !(m[1][0] === '`' && m[2].includes('`')) ? m : null; };
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
// Dashes under each column, one or more ("|---|:-:|", "|-|-|"); a single dash only between pipes, where it cannot be
// a line of text's own "-".
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const tableSep = (line) => TABLE_SEP.test(line) && (line.includes('|') || /-{2,}/.test(line));
// Quotes and lists nest by recursion: a reply of thousands of ">" (a cell's text quoted back) ran out of stack, and the
// paint that threw left the reply unfinished. Deeper than this, what is left reads as text.
const MAX_DEPTH = 32;

export function renderMarkdown(text, options = {}) {
  const frag = document.createDocumentFragment();
  for (const node of blocks(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'), options)) frag.append(node);
  return frag;
}

function blocks(lines, options, depth = 0) {
  const out = [];
  let i = 0;
  let para = [];
  const flush = () => {
    if (!para.length) return;
    out.push(el('p', {}, ...inlineLines(para, options)));
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { flush(); i++; continue; }
    let m;
    if ((m = fence(line))) {
      flush();
      const close = m[1][0];
      const body = [];
      i++;
      while (i < lines.length && !(new RegExp(`^\\s{0,3}${close === '`' ? '`' : '~'}{${m[1].length},}\\s*$`).test(lines[i]))) body.push(lines[i++]);
      i++; // past the closing fence, or the end
      out.push(el('pre.md-code', {}, el('code', {}, body.join('\n'))));
      continue;
    }
    if ((m = HEADING.exec(line))) {
      flush();
      // A reply's headings are section labels in a narrow panel: two sizes serve.
      // A closing run of #s goes only after a space ("# Title #"): "C#" keeps its own. Taken off here rather than by
      // the pattern, whose lazy text beside two runs of spaces took a second over a long line, redrawn each frame.
      const title = m[2].trimEnd().replace(/(^|\s)#+$/, '').trimEnd();
      out.push(el(m[1].length <= 2 ? 'h3.md-h' : 'h4.md-h', {}, ...inline(title, options)));
      i++;
      continue;
    }
    if (RULE.test(line)) {
      flush();
      out.push(el('hr.md-rule'));
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && lines[i].trim() && (m = QUOTE.exec(lines[i]))) { body.push(m[1]); i++; }
      out.push(el('blockquote.md-quote', {}, ...(depth < MAX_DEPTH ? blocks(body, options, depth + 1) : [el('p', {}, ...inlineLines(body, options))])));
      continue;
    }
    if (ITEM.test(line)) {
      flush();
      const list = parseList(lines, i, options, depth);
      out.push(list.node);
      i = list.next;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && tableSep(lines[i + 1])) {
      flush();
      const table = parseTable(lines, i, options);
      out.push(table.node);
      i = table.next;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out;
}

/** A list and the lists nested in it, by indentation. */
function parseList(lines, start, options, depth) {
  const first = ITEM.exec(lines[start]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const node = el(ordered ? 'ol.md-list' : 'ul.md-list');
  if (ordered) {
    const n = parseInt(first[2], 10);
    if (n !== 1) node.setAttribute('start', String(n));
  }
  let i = start;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) {
      if (m && m[1].length < indent) break;
      if (!m) break;
      if (m[1].length === indent) break; // a list of the other kind begins
    }
    const body = [m[3]];
    i++;
    const nested = [];
    const deeper = (line) => !!line.trim() && line.match(/^\s*/)[0].length > indent;
    while (i < lines.length) {
      const line = lines[i];
      const sub = ITEM.exec(line);
      if (sub && sub[1].length > indent) { nested.push(line); i++; continue; }
      // A code block in the item (the command in a numbered step) is the item's to its closing fence, blank lines and
      // all: read as the item's text, its fences showed as backticks, and a blank line in it ended the list there.
      const opened = !sub && deeper(line) ? fence(line.trimStart()) : null;
      if (opened) {
        const close = new RegExp(`^${opened[1][0] === '`' ? '`' : '~'}{${opened[1].length},}\\s*$`);
        nested.push(line);
        for (i++; i < lines.length;) { const l = lines[i++]; nested.push(l); if (close.test(l.trim())) break; }
        continue;
      }
      // A blank line goes on with the item when what follows it is indented under it: a paragraph, a list or a code
      // block of its own.
      if (!line.trim()) {
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && deeper(lines[j])) { while (i < j) nested.push(lines[i++]); continue; }
        break;
      }
      if (!sub && line.trim() && /^\s+/.test(line) && (line.match(/^\s*/)[0].length > indent)) {
        if (nested.length) nested.push(line); else body.push(line.trim());
        i++;
        continue;
      }
      break;
    }
    const li = el('li', {}, ...inlineLines(body, options));
    if (nested.length) {
      const base = Math.min(...nested.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
      const inner = nested.map((l) => l.slice(Math.min(base, l.match(/^\s*/)[0].length)));
      li.append(...(depth < MAX_DEPTH ? blocks(inner, options, depth + 1) : [el('p', {}, ...inlineLines(inner.map((l) => l.trim()), options))]));
    }
    node.append(li);
    // A blank line between items keeps the list going when the next line is another item of it.
    if (i < lines.length && !lines[i].trim() && i + 1 < lines.length) {
      const again = ITEM.exec(lines[i + 1]);
      if (again && again[1].length === indent && /\d/.test(again[2]) === ordered) i++;
    }
  }
  return { node, next: i };
}

function cellsOf(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const out = [];
  let cur = '';
  let code = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '\\' && row[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '`') code = !code;
    if (ch === '|' && !code) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function parseTable(lines, start, options) {
  const head = cellsOf(lines[start]);
  const aligns = cellsOf(lines[start + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : null));
  const rows = [];
  let i = start + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cellsOf(lines[i++]));
  const cell = (tag, text, j) => el(tag, aligns[j] ? { style: { textAlign: aligns[j] } } : {}, ...inline(text, options));
  const table = el('table.md-table', {},
    el('thead', {}, el('tr', {}, ...head.map((text, j) => cell('th', text, j)))),
    el('tbody', {}, ...rows.map((row) => el('tr', {}, ...head.map((_, j) => cell('td', row[j] ?? '', j))))));
  // A wide table scrolls within the reply rather than widening the panel.
  return { node: el('div.md-table-wrap', { tabIndex: 0, role: 'region', 'aria-label': t('markdown.table') }, table), next: i };
}

/** Lines of one paragraph, each break kept: the assistant's line breaks are meant. */
function inlineLines(lines, options) {
  const out = [];
  lines.forEach((line, i) => {
    if (i) out.push(el('br'));
    // A backslash ending a line is Markdown's line break, which each line already is.
    out.push(...inline(i < lines.length - 1 && escapedAt(line, line.length) ? line.slice(0, -1) : line, options));
  });
  return out;
}

// A backslash before a mark makes it a plain character ("\*", "\_", "\$"), as in CommonMark: shown as written, the
// backslashes were left in the text, and "\*not this\*" came out in italics. Code is as written.
const ESCAPED = /\\([!-/:-@[-`{-~])/g;
const unescape = (text) => text.replace(ESCAPED, '$1');
/** Whether the character at `i` comes after an odd run of backslashes, which escapes it. */
function escapedAt(src, i) {
  let n = 0;
  while (i - n - 1 >= 0 && src[i - n - 1] === '\\') n++;
  return n % 2 === 1;
}

// An address may hold parentheses in pairs, one deep, as Wikipedia's do (…/Mercury_(planet)); an unpaired one ends it.
// An underscore within a word opens no emphasis (snake_case), which the pattern says before it looks for a closing one:
// each looked to the end of the line, and a line of column names took a long while to draw, again each frame.
const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)|(\*\*|(?<!\w)__)(?=\S)([\s\S]*?\S)\7|~~(?=\S)([\s\S]*?\S)~~|(\*|(?<!\w)_)(?=[^\s*_])([\s\S]*?[^\s*_])\10(?![\w*])|(https?:\/\/(?:[^\s<>()]|\([^\s<>()]*\))*(?:[^\s<>().,;:!?'"*_]|\([^\s<>()]*\)))/g;

/** Inline Markdown: code, emphasis, links (web and mail only), and cell references in the plain text. */
export function inline(text, options = {}) {
  const out = [];
  let last = 0;
  const src = String(text);
  let m;
  const re = new RegExp(INLINE.source, 'g');
  while ((m = re.exec(src))) {
    // Intraword underscores (snake_case names) are not emphasis. The search goes on from just past the underscore,
    // not past the whole match, which may have run over the marks later in the line.
    if ((m[10] === '_' || m[7] === '__') && /\w/.test(src[m.index - 1] || '')) { re.lastIndex = m.index + 1; continue; }
    // An escaped mark opens nothing, and one escaped where this would end it closes nothing.
    const closer = m[7] ? m[7].length : m[9] !== undefined ? 2 : m[10] ? 1 : 0;
    if (escapedAt(src, m.index) || (closer && escapedAt(src, m.index + m[0].length - closer))) { re.lastIndex = m.index + 1; continue; }
    if (m.index > last) out.push(...plainText(src.slice(last, m.index), options));
    if (m[1]) out.push(el('code.md-inline', {}, ...plainText(m[2].replace(/^ (.*) $/, '$1'), options, true)));
    else if (m[3] !== undefined && m[4] !== undefined && src[m.index] === '!') out.push(el('span.md-image', { title: t('markdown.pictureNotLoaded') }, m[3] ? `[${unescape(m[3])}]` : t('markdown.picture')));
    else if (m[5] !== undefined) out.push(link(unescape(m[6]), inline(m[5], { ...options, refs: null })));
    else if (m[7] && m[8].length > 1 && m[8][0] === m[7][0] && src[m.index + m[0].length] === m[7][0] && /\S/.test(m[8][1])) {
      // ***both***: the bold pattern stops a mark short at each end, which would show as a stray * on either side.
      out.push(el('strong', {}, el('em', {}, ...inline(m[8].slice(1), options))));
      last = re.lastIndex = m.index + m[0].length + 1;
      continue;
    }
    else if (m[7]) out.push(el('strong', {}, ...inline(m[8], options)));
    else if (m[9] !== undefined) out.push(el('s', {}, ...inline(m[9], options)));
    else if (m[10]) out.push(el('em', {}, ...inline(m[11], options)));
    else if (m[12]) out.push(link(m[12], [m[12]]));
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(...plainText(src.slice(last), options));
  return out;
}

export function safeHref(url) {
  const raw = String(url ?? '').trim();
  if (/^mailto:[^\s]+$/i.test(raw)) return raw;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

function link(url, children) {
  const href = safeHref(url);
  if (!href) return el('span', {}, ...children);
  return el('a.md-link', { href, target: '_blank', rel: 'noopener noreferrer nofollow', title: href }, ...children);
}

/** Text with the cell references in it as buttons; `code`: as written, its backslashes kept. */
function plainText(text, options, code = false) {
  const shown = code ? (s) => s : unescape;
  const found = options.refs ? options.refs(text) : [];
  if (!found?.length) return [shown(text)];
  const out = [];
  let at = 0;
  for (const { start, end, target } of found) {
    if (start < at) continue;
    if (start > at) out.push(shown(text.slice(at, start)));
    const label = text.slice(start, end);
    out.push(el('button.cell-ref', { type: 'button', title: t('markdown.selectRef', { ref: label }), onclick: () => options.onRef?.(target) }, label));
    at = end;
  }
  if (at < text.length) out.push(shown(text.slice(at)));
  return out;
}

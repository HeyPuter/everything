import { sanitizeHtml } from './sanitize.js';
import { TAG_BY_ID } from '../data/tags.js';

/*
 * Small Markdown bridge for export and import. Covers what notes use:
 * headings, paragraphs, bold/italic/strike/code, links, images, lists
 * (nested), task items (To Do tags), quotes, code blocks, tables and rules.
 */

// ------------------------------------------------------------ HTML -> Markdown

function inline(node) {
  let out = '';
  for (const c of node.childNodes) {
    if (c.nodeType === 3) {
      out += c.nodeValue.replace(/ /g, ' ').replace(/([\\`*_[\]])/g, '\\$1');
      continue;
    }
    if (c.nodeType !== 1) continue;
    const tag = c.tagName;
    if (c.classList.contains('nt-tag')) continue;
    if (c.classList.contains('nt-math')) {
      out += `$${c.dataset.tex || ''}$`;
      continue;
    }
    if (c.classList.contains('nt-file')) {
      out += `[${c.dataset.name || 'attachment'}]`;
      continue;
    }
    const inner = inline(c);
    const style = c.getAttribute('style') || '';
    if (tag === 'BR') out += '  \n';
    else if (tag === 'B' || tag === 'STRONG' || /font-weight:\s*(bold|[6-9]00)/.test(style)) out += inner.trim() ? `**${inner}**` : inner;
    else if (tag === 'I' || tag === 'EM' || /font-style:\s*italic/.test(style)) out += inner.trim() ? `*${inner}*` : inner;
    else if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || /line-through/.test(style)) out += inner.trim() ? `~~${inner}~~` : inner;
    else if (tag === 'CODE' || tag === 'KBD') out += `\`${c.textContent}\``;
    else if (tag === 'A') out += `[${inner}](${c.getAttribute('href') || ''})`;
    else if (tag === 'IMG') out += `![${c.getAttribute('alt') || ''}](${c.dataset.mdSrc || c.getAttribute('src') || ''})`;
    else out += inner;
  }
  return out;
}

function tagPrefix(block) {
  const tag = block.querySelector(':scope > .nt-tag');
  if (!tag) return '';
  const def = TAG_BY_ID.get(tag.dataset.tag);
  if (def?.kind === 'check') return tag.dataset.done === 'true' ? '[x] ' : '[ ] ';
  return def ? `(${def.label}) ` : '';
}

function list(el, depth) {
  const lines = [];
  let n = Number(el.getAttribute('start')) || 1;
  for (const li of el.children) {
    // Chrome's indent nests the new list directly in the old one
    // (<ul><li>a</li><ul><li>b</li></ul></ul>); it belongs to the item above.
    if (li.tagName === 'UL' || li.tagName === 'OL') {
      lines.push(...list(li, depth + 1));
      continue;
    }
    if (li.tagName !== 'LI') continue;
    const marker = el.tagName === 'OL' ? `${n++}.` : '-';
    const textParts = [];
    const nested = [];
    for (const c of li.childNodes) {
      if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) nested.push(...list(c, depth + 1));
      else if (c.nodeType === 1 && ['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(c.tagName)) textParts.push(tagPrefix(c) + inline(c).trim());
      else textParts.push(c.nodeType === 1 ? inline({ childNodes: [c] }) : c.nodeValue);
    }
    const lead = tagPrefix(li);
    lines.push(`${'  '.repeat(depth)}${marker} ${lead}${textParts.join(' ').replace(/\s+/g, ' ').trim()}`);
    lines.push(...nested);
  }
  return lines;
}

function table(el) {
  const rows = [...el.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => inline(c).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill('')];
  const out = [`| ${pad(rows[0]).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`];
  for (const r of rows.slice(1)) out.push(`| ${pad(r).join(' | ')} |`);
  return out.join('\n');
}

function blocks(root) {
  const out = [];
  for (const c of root.childNodes) {
    if (c.nodeType === 3) {
      if (c.nodeValue.trim()) out.push(c.nodeValue.trim());
      continue;
    }
    if (c.nodeType !== 1) continue;
    const tag = c.tagName;
    if (/^H[1-6]$/.test(tag)) out.push(`${'#'.repeat(Number(tag[1]))} ${tagPrefix(c)}${inline(c).trim()}`);
    else if (tag === 'UL' || tag === 'OL') out.push(list(c, 0).join('\n'));
    else if (tag === 'BLOCKQUOTE') out.push(blocks(c).split('\n').map((l) => `> ${l}`).join('\n'));
    else if (tag === 'PRE') out.push('```\n' + c.textContent.replace(/\n$/, '') + '\n```');
    else if (tag === 'TABLE') out.push(table(c));
    else if (tag === 'HR') out.push('---');
    else if (tag === 'P' || tag === 'DIV' || tag === 'FIGURE') {
      const prefix = tagPrefix(c);
      const text = inline(c).trim();
      if (prefix.startsWith('[')) out.push(`- ${prefix}${text}`);
      else out.push(prefix + text);
    } else out.push(inline({ childNodes: [c] }).trim());
  }
  return out.filter((b) => b !== '').join('\n\n');
}

export function htmlToMarkdown(html) {
  const doc = document.implementation.createHTMLDocument('');
  const div = doc.createElement('div');
  div.innerHTML = sanitizeHtml(html);
  return blocks(div).replace(/\n{3,}/g, '\n\n').trim();
}

// ------------------------------------------------------------ Markdown -> HTML

function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

export function inlineMd(s) {
  // Pull out escapes and code spans in one left-to-right pass, so an escaped
  // character never opens formatting and a backslash inside code stays literal.
  const held = [];
  let t = s.replace(/\\([\\`*_[\]])|`([^`]+)`/g, (_, ch, code) => {
    held.push(ch !== undefined ? esc(ch) : `<code>${esc(code)}</code>`);
    return `\u0000${held.length - 1}\u0000`;
  });
  t = esc(t);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img alt="${alt}" src="${src}">`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => `<a href="${href}">${text}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<b>${a || b}</b>`);
  t = t.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, '$1<i>$2</i>').replace(/(^|[^_\w])_([^_\s][^_]*)_(?!_)/g, '$1<i>$2</i>');
  t = t.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)]);
  return t;
}

const TODO_OPEN = '<span class="nt-tag" data-tag="todo" data-done="false" contenteditable="false"></span>';
const TODO_DONE = '<span class="nt-tag" data-tag="todo" data-done="true" contenteditable="false"></span>';

export function markdownToHtml(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const listStack = [];
  const closeLists = (depth = 0) => {
    while (listStack.length > depth) out.push(`</li></${listStack.pop().tag}>`);
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      closeLists();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre>${esc(code.join('\n'))}</pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeLists();
      out.push(`<h${heading[1].length}>${inlineMd(heading[2].trim())}</h${heading[1].length}>`);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeLists();
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
      closeLists();
      const split = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => inlineMd(c.trim().replace(/\\\|/g, '|')));
      const head = split(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(split(lines[i++]));
      out.push(`<table><tbody><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      closeLists();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${markdownToHtml(quote.join('\n'))}</blockquote>`);
      continue;
    }
    const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (item) {
      const depth = Math.floor(item[1].replace(/\t/g, '  ').length / 2) + 1;
      const tag = /\d/.test(item[2]) ? 'ol' : 'ul';
      let text = item[3];
      let prefix = '';
      const task = text.match(/^\[( |x|X)\]\s+(.*)$/);
      if (task) {
        prefix = task[1] === ' ' ? TODO_OPEN : TODO_DONE;
        text = task[2];
      }
      if (task && depth === 1 && listStack.length === 0) {
        out.push(`<p>${prefix}${inlineMd(text)}</p>`);
        i++;
        continue;
      }
      if (listStack.length < depth) {
        while (listStack.length < depth) {
          out.push(`<${tag}><li>`);
          listStack.push({ tag });
        }
      } else {
        closeLists(depth);
        if (listStack[depth - 1].tag !== tag) {
          closeLists(depth - 1);
          out.push(`<${tag}><li>`);
          listStack.push({ tag });
        } else out.push('</li><li>');
      }
      out.push(prefix + inlineMd(text));
      i++;
      continue;
    }
    if (!line.trim()) {
      closeLists();
      i++;
      continue;
    }
    closeLists();
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(`<p>${para.map((l) => inlineMd(l.replace(/\s{2,}$/, ''))).join('<br>')}</p>`);
  }
  closeLists();
  return sanitizeHtml(out.join(''));
}

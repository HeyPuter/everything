import { el, safeURL } from './dom.js';
import { t } from '../lib/i18n/index.js';

function inline(text, depth = 0) {
  if (depth > 4) return [text];
  const nodes = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\[\]\n]+\]\([^\s)]+\))/g;
  let previous = 0;
  for (const match of text.matchAll(pattern)) {
    nodes.push(text.slice(previous, match.index));
    const token = match[0];
    if (token.startsWith('`')) nodes.push(el('code', {}, token.slice(1, -1)));
    else if (token.startsWith('**')) nodes.push(el('strong', {}, inline(token.slice(2, -2), depth + 1)));
    else if (token.startsWith('*')) nodes.push(el('em', {}, inline(token.slice(1, -1), depth + 1)));
    else {
      const parts = /^\[([^\]]+)\]\((.+)\)$/.exec(token);
      const href = safeURL(parts[2]);
      const host = href && new URL(href).host;
      const label = parts[1].trim().toLowerCase();
      // <bdi> keeps bidi controls in the label from reordering the host.
      nodes.push(href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, el('bdi', {}, parts[1]),
        ![host, href.toLowerCase()].includes(label) && el('span.link-host', { dir: 'ltr' }, ' ', t('ui.linkHost', { host }))) : token);
    }
    previous = match.index + token.length;
  }
  nodes.push(text.slice(previous));
  return nodes;
}
/** Allowlist by construction: no HTML parser, images, inline HTML or arbitrary protocols. Links show their host. */
export function markdown(value) {
  const root = el('div.markdown');
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  let paragraph = [];
  let list;
  let fence;
  function flush() {
    if (paragraph.length) root.append(el('p', {}, paragraph.flatMap((line, index) => [index > 0 && el('br'), ...inline(line)])));
    paragraph = []; list = null;
  }
  for (const line of lines) {
    if (fence !== undefined) {
      if (/^```/.test(line)) { root.append(el('pre', {}, el('code', {}, fence.join('\n')))); fence = undefined; }
      else fence.push(line);
      continue;
    }
    if (/^```/.test(line)) { flush(); fence = []; continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (heading) { flush(); root.append(el(`h${heading[1].length}`, {}, inline(heading[2]))); }
    else if (bullet) {
      if (!list) { flush(); list = el('ul'); root.append(list); }
      list.append(el('li', {}, inline(bullet[1])));
    } else if (!line.trim()) flush();
    else if (/^>\s?/.test(line)) { flush(); root.append(el('blockquote', {}, inline(line.replace(/^>\s?/, '')))); }
    else { if (list) flush(); paragraph.push(line); }
  }
  flush();
  if (fence !== undefined) root.append(el('pre', {}, el('code', {}, fence.join('\n'))));
  return root;
}

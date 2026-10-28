import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { toHast } from 'mdast-util-to-hast';
import { toHtml } from 'hast-util-to-html';
import { htmlBody } from './importers.js';

/**
 * Markdown (with GitHub tables, task lists and strikethrough) as HTML. Raw HTML in the source (a centered
 * paragraph, <details>, <br>) is kept, and read as a web page's body is (htmlBody): its text and formatting,
 * without hidden content, scripts, styles, forms or embedded content. The only reader is htmlFragment, which
 * parses it inertly.
 */
export function markdownHtml(source) {
  try {
    const text = String(source ?? '');
    const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
    const html = toHtml(withoutBackReferences(toHast(tree, { allowDangerousHtml: true })), { allowDangerousHtml: true });
    return /<[a-z!/?]/i.test(text) ? htmlBody(html) : html;
  } catch (e) {
    // Structure nested thousands deep (quotes in quotes, emphasis in emphasis) overflows the converters'
    // recursion. The file's text still opens, one paragraph per line, as it would from a .txt file.
    if (!(e instanceof RangeError)) throw e;
    return plainHtml(source);
  }
}

/**
 * A footnote's "↩" links back to its references are for reading on a web page: in a document they are stray
 * arrows that lead nowhere. They go, with the spaces before them; the notes keep their numbered list.
 */
function withoutBackReferences(node) {
  if (!Array.isArray(node.children)) return node;
  const kept = node.children.filter(child => !(child.properties && 'dataFootnoteBackref' in child.properties));
  if (kept.length !== node.children.length) {
    while (kept.at(-1)?.type === 'text' && !kept.at(-1).value.trim()) kept.pop();
    const last = kept.at(-1);
    if (last?.type === 'text') kept[kept.length - 1] = { ...last, value: last.value.trimEnd() };
    node.children = kept;
  }
  for (const child of node.children) withoutBackReferences(child);
  return node;
}

const escapeHtml = text => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const plainHtml = source => String(source ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').map(line => `<p>${escapeHtml(line)}</p>`).join('');

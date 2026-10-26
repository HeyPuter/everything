import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { toHast } from 'mdast-util-to-hast';
import { toHtml } from 'hast-util-to-html';

/**
 * Markdown (with GitHub tables, task lists and strikethrough) as HTML. Raw HTML in the source (a centered
 * paragraph, <details>, <br>) is kept: the only reader is htmlFragment, which parses it inertly, keeps its
 * text and formatting, and skips scripts, styles and embedded content as it does for pasted web pages.
 */
export function markdownHtml(source) {
  try {
    const tree = fromMarkdown(String(source ?? ''), { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
    return toHtml(toHast(tree, { allowDangerousHtml: true }), { allowDangerousHtml: true });
  } catch (e) {
    // Structure nested thousands deep (quotes in quotes, emphasis in emphasis) overflows the converters'
    // recursion. The file's text still opens, one paragraph per line, as it would from a .txt file.
    if (!(e instanceof RangeError)) throw e;
    return plainHtml(source);
  }
}

const escapeHtml = text => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const plainHtml = source => String(source ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').map(line => `<p>${escapeHtml(line)}</p>`).join('');

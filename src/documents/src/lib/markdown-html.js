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
  const tree = fromMarkdown(String(source ?? ''), { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return toHtml(toHast(tree, { allowDangerousHtml: true }), { allowDangerousHtml: true });
}

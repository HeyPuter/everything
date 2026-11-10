import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { toHast } from 'mdast-util-to-hast';
import { toHtml } from 'hast-util-to-html';

/**
 * Markdown (with GitHub tables, task lists and strikethrough) as HTML, its raw HTML kept as written. It needs
 * no document, so a worker can make it (markdown-html-worker.js). Structure nested thousands deep throws a
 * RangeError: it overflows the converters' recursion.
 */
export function markdownTreeHtml(text) {
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return toHtml(withoutBackReferences(toHast(tree, { allowDangerousHtml: true })), { allowDangerousHtml: true });
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

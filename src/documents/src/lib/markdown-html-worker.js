// Converts a Markdown file to HTML off the page's thread (markdownHtmlOffThread in markdown-html.js).
// The stand-in document goes first: the parser's browser build reads it as it loads.
import './markdown-worker-document.js';
import { markdownTreeHtml } from './markdown-tree-html.js';

self.onmessage = ({ data: text }) => {
  try { self.postMessage({ html: markdownTreeHtml(text) }); }
  catch (error) { self.postMessage({ error: String(error?.message || error), range: error instanceof RangeError }); }
};

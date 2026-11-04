import { htmlBody } from './importers.js';
import { markdownTreeHtml } from './markdown-tree-html.js';

/**
 * Markdown (with GitHub tables, task lists and strikethrough) as HTML. Raw HTML in the source (a centered
 * paragraph, <details>, <br>) is kept, and read as a web page's body is (htmlBody): its text and formatting,
 * without hidden content, scripts, styles, forms or embedded content. The only reader is htmlFragment, which
 * parses it inertly.
 */
export function markdownHtml(source) {
  const text = String(source ?? '');
  try {
    return withRawHtml(text, markdownTreeHtml(text));
  } catch (e) {
    // Structure nested thousands deep (quotes in quotes, emphasis in emphasis) overflows the converters'
    // recursion. The file's text still opens, one paragraph per line, as it would from a .txt file.
    if (!(e instanceof RangeError)) throw e;
    return plainHtml(text);
  }
}

const withRawHtml = (text, html) => /<[a-z!/?]/i.test(text) ? htmlBody(html) : html;

/**
 * The Markdown parser's time grows faster than the file for some text: 60 kB of "*a*a*a…" took seconds, and a
 * few hundred kilobytes (a file anyone can send) minutes, all of it on the page's thread, which stayed frozen.
 * markdownHtml is made in a worker instead, and a file it has not read by the deadline (ordinary Markdown of
 * several megabytes takes a second or two) opens as its lines of text. Resolves { html, plain }, `plain` when
 * the deadline passed. Where no worker can run, the file is read here as before.
 */
export const MARKDOWN_DEADLINE_MS = 20000;
export function markdownHtmlOffThread(source, { deadline = MARKDOWN_DEADLINE_MS } = {}) {
  const text = String(source ?? '');
  const here = () => ({ html: markdownHtml(text), plain: false });
  let worker;
  try { worker = typeof Worker === 'function' ? new Worker(new URL('./markdown-html-worker.js', import.meta.url), { type: 'module' }) : null; }
  catch { worker = null; }
  if (!worker) return Promise.resolve().then(here);
  return new Promise((resolve, reject) => {
    const finish = result => { clearTimeout(timer); worker.terminate(); resolve(result); };
    const timer = setTimeout(() => finish({ html: plainHtml(text), plain: true }), deadline);
    worker.onmessage = ({ data }) => {
      if (data?.error === undefined) { try { finish({ html: withRawHtml(text, data.html), plain: false }); } catch (error) { clearTimeout(timer); worker.terminate(); reject(error); } }
      else if (data.range) finish({ html: plainHtml(text), plain: false });
      else { clearTimeout(timer); worker.terminate(); reject(new Error(data.error)); }
    };
    // Blocked by policy, or no module workers: read the file here instead.
    worker.onerror = event => { event.preventDefault?.(); clearTimeout(timer); worker.terminate(); try { resolve(here()); } catch (error) { reject(error); } };
    worker.postMessage(text);
  });
}

const escapeHtml = text => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const plainHtml = source => String(source ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').map(line => `<p>${escapeHtml(line)}</p>`).join('');

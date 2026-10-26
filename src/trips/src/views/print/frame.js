import printCss from './print.css?inline';
import { el } from '../../ui/dom.js';
import { direction, locale, t } from '../../lib/i18n/index.js';
import { pageStyle } from './document.js';

// A4 width; the print dialog picks the real paper size, the preview only needs a faithful line length.
const PAPER_MM = { portrait: 210, landscape: 297 };
const PX_PER_MM = 96 / 25.4;
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
export const isPrintKey = (event) => (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key?.toLowerCase() === 'p';

function dropBroken(image) {
  (image.closest('figure') ?? image).remove();
}

/**
 * The preview: a same-origin blank frame that holds only the printed trip, stamped light so tokens resolve to the
 * light theme whatever the app shows. Printing the frame prints the trip alone.
 */
export async function createFrame(host, { onEscape = () => {}, onPrintKey = () => {} } = {}) {
  const iframe = el('iframe.print-frame', { title: t('print.previewLabel') });
  const loaded = new Promise((resolve) => { iframe.addEventListener('load', resolve, { once: true }); });
  host.append(iframe);
  // Some engines fire `load` for the initial blank document later and replace it; others never fire it.
  await Promise.race([loaded, delay(1500)]);
  const doc = iframe.contentDocument;
  if (!doc?.documentElement) throw new Error('print_frame_unavailable');
  const root = doc.documentElement;
  root.lang = locale;
  root.dir = direction;
  root.dataset.theme = 'light';
  const base = doc.createElement('style');
  base.textContent = printCss;
  const page = doc.createElement('style');
  doc.head.append(base, page);
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); onEscape(); } else if (isPrintKey(event)) { event.preventDefault(); onPrintKey(); }
  });
  let orientation = 'portrait';
  const fit = () => {
    const width = iframe.clientWidth;
    if (!width) return;
    const zoom = Math.min(1, Math.max(0.25, (width - 32) / (PAPER_MM[orientation] * PX_PER_MM)));
    root.style.setProperty('--preview-zoom', String(Math.round(zoom * 1000) / 1000));
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
  observer?.observe(iframe);

  return {
    iframe,
    doc,
    render(node, { options, title }) {
      orientation = options.orientation === 'landscape' ? 'landscape' : 'portrait';
      page.textContent = pageStyle(options, { title });
      doc.title = title;
      const scroll = doc.scrollingElement?.scrollTop ?? 0;
      doc.body.replaceChildren(node);
      for (const image of doc.images) image.addEventListener('error', () => dropBroken(image), { once: true });
      if (doc.scrollingElement) doc.scrollingElement.scrollTop = scroll;
      fit();
    },
    /** Waits until every picture loaded or failed (failed ones are removed), at most `ms`. */
    async settled(ms = 15_000) {
      const waiting = [...doc.images].map((image) => {
        if (image.complete) { if (!image.naturalWidth) dropBroken(image); return null; }
        return new Promise((resolve) => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); });
      }).filter(Boolean);
      if (waiting.length) await Promise.race([Promise.all(waiting), delay(ms)]);
    },
    print() {
      const win = iframe.contentWindow;
      win.focus();
      win.print();
    },
    destroy() { observer?.disconnect(); iframe.remove(); },
  };
}

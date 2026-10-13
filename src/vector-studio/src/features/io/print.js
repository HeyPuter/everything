/**
 * Print: renders the chosen artboards as inline SVG pages into a print-only
 * container and calls window.print(). @media print CSS hides the app so
 * only the artwork prints; the container is removed afterwards.
 */
import { exportSVG } from './svg-export.js';

export function buildPrintRoot(doc, indices, { fit = false, outlines = null } = {}) {
  const root = document.createElement('div');
  root.className = 'io-print-root';
  root.setAttribute('aria-hidden', 'true');
  for (const i of indices) {
    const a = doc.artboards[i];
    if (!a) continue;
    const page = document.createElement('div');
    page.className = 'io-print-page';
    const svg = exportSVG(doc, { rect: { x: a.x, y: a.y, w: a.w, h: a.h }, responsive: true, minify: true, precision: 3, textMode: outlines ? 'outlines' : 'text', outlines, writeIds: false, idPrefix: `p${i}-` });
    page.innerHTML = svg;
    const el = page.querySelector('svg');
    if (el) {
      el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      if (fit) {
        el.style.width = '100%';
        el.style.height = '100%';
      } else {
        el.style.width = `${a.w}pt`;
        el.style.height = `${a.h}pt`;
        // Each artboard prints on a page of its own size (a named @page).
        page.style.page = `vs-artboard-${i}`;
        page.style.width = `${a.w}pt`;
        page.style.height = `${a.h}pt`;
      }
    }
    root.append(page);
  }
  return root;
}

/** @page rules: the first artboard's size by default, and a named page per artboard. */
export function pageRules(doc, indices) {
  const boards = indices.map((i) => [i, doc.artboards[i]]).filter(([, a]) => a);
  const first = boards[0]?.[1] || doc.artboards[0];
  return [`@page { size: ${first.w}pt ${first.h}pt; margin: 0; }`, ...boards.map(([i, a]) => `@page vs-artboard-${i} { size: ${a.w}pt ${a.h}pt; margin: 0; }`)].join('\n');
}

/** Print artboards (indices). Resolves once the print dialog has closed. */
export async function printArtboards(app, editor, indices, { fit = false, outlines = null } = {}) {
  const doc = editor.doc;
  const root = buildPrintRoot(doc, indices, { fit, outlines });
  // Each artboard's own page size (fit mode uses the printer's paper).
  return printRoot(root, fit ? '@page { margin: 12mm; }' : pageRules(doc, indices));
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const num = (v) => String(Math.round(v * 1000) / 1000);

/**
 * A document view that prints the chosen layers: 'printable' (visible
 * layers not marked non-printing), 'visible', or 'all' (hidden layers too).
 */
export function printView(doc, layers = 'printable') {
  if (layers === 'visible') return doc;
  const override = (n) => {
    if (n?.type !== 'layer') return n;
    if (layers === 'all') return n.hidden || n.template ? { ...n, hidden: false, template: false } : n;
    return n.print === false && !n.hidden ? { ...n, hidden: true } : n;
  };
  const view = {
    get: (id) => override(doc.get(id)),
    has: (id) => doc.has(id),
    assets: doc.assets,
    get root() {
      return doc.root;
    },
    name: doc.name,
    artboards: doc.artboards,
    walk: (fn, id = 'root', depth = 0) => {
      const n = view.get(id);
      if (!n) return;
      if (id !== 'root' && fn(n, depth) === false) return;
      if (n.children) for (const c of n.children) view.walk(fn, c, depth + 1);
    },
  };
  return view;
}

function marksSVG(marks) {
  let out = '';
  for (const m of marks) {
    if (m.kind === 'line') out += `<line x1="${num(m.x1)}" y1="${num(m.y1)}" x2="${num(m.x2)}" y2="${num(m.y2)}" stroke="#000" stroke-width="${num(m.w)}"/>`;
    else if (m.kind === 'registration') {
      out += `<g fill="none" stroke="#000" stroke-width="${num(m.w)}"><circle cx="${num(m.x)}" cy="${num(m.y)}" r="${num(m.r)}"/><circle cx="${num(m.x)}" cy="${num(m.y)}" r="${num(m.r / 2)}"/>`;
      out += `<line x1="${num(m.x - m.r * 1.5)}" y1="${num(m.y)}" x2="${num(m.x + m.r * 1.5)}" y2="${num(m.y)}"/><line x1="${num(m.x)}" y1="${num(m.y - m.r * 1.5)}" x2="${num(m.x)}" y2="${num(m.y + m.r * 1.5)}"/></g>`;
    } else if (m.kind === 'swatch') out += `<rect x="${num(m.x)}" y="${num(m.y)}" width="${num(m.w)}" height="${num(m.h)}" fill="${m.color}"/>`;
    else if (m.kind === 'text') out += `<text x="${num(m.x)}" y="${num(m.y)}" font-family="sans-serif" font-size="${num(m.size)}" fill="#000">${esc(m.text)}</text>`;
  }
  return out;
}

/**
 * Pages from print-layout.js as print-ready DOM: each page an SVG of the
 * page size holding the artwork (clipped to its bleed) and printer's marks.
 */
export function buildLayoutRoot(doc, pages, { layers = 'printable', outlines = null, grayscale = false } = {}) {
  const source = printView(doc, layers);
  const root = document.createElement('div');
  root.className = 'io-print-root';
  root.setAttribute('aria-hidden', 'true');
  if (grayscale) root.style.filter = 'grayscale(1)';
  const cache = new Map();
  pages.forEach((p, i) => {
    const page = document.createElement('div');
    page.className = 'io-print-page';
    page.style.page = `vs-page-${i}`;
    page.style.width = `${p.w}pt`;
    page.style.height = `${p.h}pt`;
    let body = '';
    p.tiles.forEach((t, k) => {
      const key = `${t.rect.x},${t.rect.y},${t.rect.w},${t.rect.h}`;
      let art = cache.get(key);
      if (art === undefined) {
        art = exportSVG(source, { rect: t.rect, responsive: true, minify: true, precision: 3, textMode: outlines ? 'outlines' : 'text', outlines, writeIds: false, idPrefix: `p${i}t${k}-` });
        cache.set(key, art);
      }
      // The artwork's own <svg> becomes a nested viewport at its place on the page; it clips to its viewBox.
      const inner = art.replace(/^<\?xml[^>]*>\s*/, '').replace(/^<svg\b/, `<svg x="${num(t.x)}" y="${num(t.y)}" width="${num(t.rect.w * t.s)}" height="${num(t.rect.h * t.s)}" preserveAspectRatio="none" overflow="hidden"`);
      body += inner;
    });
    body += marksSVG(p.marks || []);
    page.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${num(p.w)}pt" height="${num(p.h)}pt" viewBox="0 0 ${num(p.w)} ${num(p.h)}">${body}</svg>`;
    root.append(page);
  });
  return root;
}

/** @page rules for laid-out pages (a named page size per page). */
export function layoutPageRules(pages) {
  const first = pages[0];
  return [`@page { size: ${num(first.w)}pt ${num(first.h)}pt; margin: 0; }`, ...pages.map((p, i) => `@page vs-page-${i} { size: ${num(p.w)}pt ${num(p.h)}pt; margin: 0; }`)].join('\n');
}

/** Print laid-out pages. Resolves once the print dialog has closed. */
export function printPages(app, editor, pages, opts = {}) {
  if (!pages.length) return Promise.resolve();
  return printRoot(buildLayoutRoot(editor.doc, pages, opts), layoutPageRules(pages));
}

export async function printRoot(root, css) {
  document.querySelectorAll('.io-print-root, #io-print-page-style').forEach((el) => el.remove());
  const style = document.createElement('style');
  style.id = 'io-print-page-style';
  style.textContent = css;
  document.head.append(style);
  document.body.append(root);
  document.body.classList.add('io-printing');
  const cleanup = () => {
    root.remove();
    style.remove();
    document.body.classList.remove('io-printing');
  };
  try {
    await document.fonts?.ready;
  } catch {
    /* ignore */
  }
  // Let embedded images decode before the print snapshot.
  await Promise.all([...root.querySelectorAll('image')].map((im) => new Promise((r) => {
    const href = im.getAttribute('href') || im.getAttribute('xlink:href');
    if (!href) return r();
    const img = new Image();
    img.onload = img.onerror = () => r();
    img.src = href;
  })));
  await new Promise((r) => requestAnimationFrame(() => r()));
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('afterprint', finish);
      cleanup();
      resolve();
    };
    window.addEventListener('afterprint', finish);
    try {
      window.print();
    } catch {
      /* printing blocked */
    }
    // window.print() blocks in most browsers; finish if afterprint never arrives.
    setTimeout(finish, 1000);
  });
}

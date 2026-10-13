/**
 * SVG export options applied to finished SVG text:
 *
 *   styling    'attributes' (presentation attributes, as written),
 *              'inline' (style="..." on each element) or 'css' (classes
 *              in one <style> element, one class per distinct style)
 *   objectIds  'names' (object names, as written), 'minimal' (only ids
 *              that something refers to) or 'unique' (an id on every
 *              shape and group)
 */

/** Presentation attributes moved into styles. */
const STYLE_ATTRS = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity',
  'mix-blend-mode',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'text-anchor',
];

const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'image', 'use', 'g']);

function styleOf(el) {
  const parts = [];
  for (const a of STYLE_ATTRS) {
    if (!el.hasAttribute(a)) continue;
    parts.push(`${a}:${el.getAttribute(a)}`);
    el.removeAttribute(a);
  }
  const own = el.getAttribute('style');
  if (own) parts.push(...own.split(';').map((s) => s.trim()).filter(Boolean));
  return parts.join(';');
}

/** Restyle and re-id SVG text. Returns the text unchanged for the default options. */
export function applySvgOptions(text, { styling = 'attributes', objectIds = 'names', minify = false } = {}) {
  if ((styling === 'attributes' || !styling) && (objectIds === 'names' || !objectIds)) return text;
  if (typeof DOMParser === 'undefined') return text;
  const dom = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = dom.documentElement;
  if (!svg || svg.nodeName !== 'svg' || dom.getElementsByTagName('parsererror').length) return text;
  const all = [...svg.getElementsByTagName('*')].filter((el) => !el.closest('style, title, desc, metadata'));

  if (objectIds === 'minimal') {
    // Keep ids something points at (url(#id), href="#id", aria/labels).
    const used = new Set();
    for (const m of text.matchAll(/url\(#([^)]+)\)|href="#([^"]+)"/g)) used.add(m[1] || m[2]);
    for (const el of svg.querySelectorAll('[id]')) if (!used.has(el.getAttribute('id'))) el.removeAttribute('id');
  } else if (objectIds === 'unique') {
    const taken = new Set([...svg.querySelectorAll('[id]')].map((el) => el.getAttribute('id')));
    let n = 0;
    for (const el of all) {
      if (!SHAPES.has(el.localName) || el.hasAttribute('id') || el.closest('defs')) continue;
      let id;
      do id = `${el.localName}-${++n}`;
      while (taken.has(id));
      taken.add(id);
      el.setAttribute('id', id);
    }
  }

  if (styling === 'inline') {
    for (const el of all) {
      const s = styleOf(el);
      if (s) el.setAttribute('style', s);
      else el.removeAttribute('style');
    }
  } else if (styling === 'css') {
    const classes = new Map();
    for (const el of all) {
      const s = styleOf(el);
      if (!s) {
        el.removeAttribute('style');
        continue;
      }
      el.removeAttribute('style');
      let cls = classes.get(s);
      if (!cls) classes.set(s, (cls = `st${classes.size}`));
      el.setAttribute('class', [el.getAttribute('class'), cls].filter(Boolean).join(' '));
    }
    if (classes.size) {
      const nl = minify ? '' : '\n';
      const css = [...classes].map(([s, cls]) => `${minify ? '' : '    '}.${cls}{${s}}`).join(nl);
      const style = dom.createElementNS('http://www.w3.org/2000/svg', 'style');
      style.textContent = `${nl}${css}${nl}${minify ? '' : '  '}`;
      let defs = [...svg.children].find((c) => c.localName === 'defs');
      if (!defs) {
        defs = dom.createElementNS('http://www.w3.org/2000/svg', 'defs');
        svg.insertBefore(defs, svg.firstChild);
      }
      defs.insertBefore(style, defs.firstChild);
    }
  }
  const out = new XMLSerializer().serializeToString(dom);
  const decl = /^<\?xml[^>]*\?>\s*/.exec(text)?.[0] || '';
  return decl + out.replace(/^<\?xml[^>]*\?>\s*/, '');
}

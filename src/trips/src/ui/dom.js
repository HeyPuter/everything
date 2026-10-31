/** Element builder. Text stays text; HTML string injection is intentionally unsupported. */
export function el(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (key === 'html' || key === 'innerHTML' || key === 'outerHTML' || key === 'srcdoc') {
      throw new TypeError('HTML injection is unsupported');
    }
    if (value === null || value === undefined) continue;
    if (key.startsWith('on')) {
      if (typeof value !== 'function') throw new TypeError('Event handlers must be functions');
      node.addEventListener(key.slice(2), value);
    } else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) {
        if (v != null) node.style.setProperty(prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), v);
      }
    } else if (key.startsWith('aria-')) node.setAttribute(key, String(value));
    else if (key in node && !['list', 'form', 'href', 'src'].includes(key)) node[key] = value;
    else if (value !== false) node.setAttribute(key, value === true ? '' : String(value));
  }
  return append(node, children);
}
export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
  }
  return node;
}
export function clear(node) { node.replaceChildren(); return node; }
export function safeURL(value) {
  try {
    const url = new URL(String(value));
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
let nextId = 0;
export function uid(prefix = 'ui') { return `${prefix}-${++nextId}`; }

import { UnsupportedDocumentError } from './errors.js';
import { drawingEffectColor } from './docx-drawing-style.js';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const A14 = 'http://schemas.microsoft.com/office/drawing/2010/main';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const fail = why => { throw new UnsupportedDocumentError(`picture shadows with ${why}`); };
// With `withEffects`, glow, reflection and soft edges may share the list; docx-drawing-effects.js
// reads and validates them. Without it, a list holding anything but one outer shadow is unsupported.
export function readPictureShadow(shape, scheme, withEffects = false) {
  const list = [...shape.children].find(n => n.namespaceURI === A && n.localName === 'effectLst');
  if (!list) return null;
  if ([...list.attributes].some(a => a.namespaceURI !== XMLNS) || list.textContent.trim()) fail('invalid effect list');
  const members = withEffects ? [...list.children].filter(n => !(n.namespaceURI === A && ['glow', 'reflection', 'softEdge'].includes(n.localName))) : [...list.children];
  if (!members.length) return null;
  const n = members[0];
  if (members.length !== 1 || n.namespaceURI !== A || n.localName !== 'outerShdw') fail('unsupported or duplicate effects');
  const attrs = ['blurRad', 'dist', 'dir', 'sx', 'sy', 'kx', 'ky', 'algn', 'rotWithShape'];
  if ([...n.attributes].some(a => a.namespaceURI !== XMLNS && (a.namespaceURI || !attrs.includes(a.localName)))) fail('unsupported attributes');
  const number = (key, fallback, min, max) => {
    const raw = n.getAttribute(key)?.trim();
    if (raw == null) return fallback;
    if (!/^[+-]?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) fail(`invalid ${key}`);
    return Number(raw);
  };
  const blur = number('blurRad', 0, 0, 27273042316900), dist = number('dist', 0, 0, 27273042316900);
  const angle = number('dir', 0, 0, 21599999) / 60000 * Math.PI / 180;
  const scale = key => {
    const raw = n.getAttribute(key)?.trim();
    if (raw?.endsWith('%')) {
      if (!/^-?\d+(?:\.\d+)?%$/.test(raw) || !Number.isFinite(Number(raw.slice(0, -1)))) fail(`invalid ${key}`);
      return Number(raw.slice(0, -1)) / 100;
    }
    return number(key, 100000, -2147483648, 2147483647) / 100000;
  };
  const scaleX = scale('sx'), scaleY = scale('sy');
  if (number('kx', 0, -5400000, 5400000) || number('ky', 0, -5400000, 5400000)) fail('skewed shadows');
  if (n.hasAttribute('algn') && !['tl','t','tr','l','ctr','r','bl','b','br'].includes(n.getAttribute('algn'))) fail('invalid alignment');
  if (n.hasAttribute('rotWithShape') && !['0','1','true','false'].includes(n.getAttribute('rotWithShape').trim())) fail('invalid rotation flag');
  if (n.children.length !== 1) fail('missing or conflicting colors');
  const color = drawingEffectColor(n.children[0], scheme);
  // Current MS-ODRAWXML default is false, confirmed by independent native reference controls.
  const extensions = [...shape.children].find(c => c.namespaceURI === A && c.localName === 'extLst');
  const extension = [...(extensions?.children || [])].find(c => c.namespaceURI === A && c.localName === 'ext' && c.getAttribute('uri')?.toLowerCase() === '{53640926-aad7-44d8-bbd7-cce9431645ec}');
  const flag = [...(extension?.children || [])].find(c => c.namespaceURI === A14 && c.localName === 'shadowObscured');
  const obscured = ['1', 'true'].includes(flag?.getAttribute('val')?.trim());
  return { blur: blur / 9525, x: dist * Math.cos(angle) / 9525, y: dist * Math.sin(angle) / 9525, color, obscured,
    ...(scaleX !== 1 || scaleY !== 1 ? { scaleX, scaleY, alignment: n.getAttribute('algn') || 'b' } : {}) };
}

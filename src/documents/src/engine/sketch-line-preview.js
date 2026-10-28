import { UnsupportedDocumentError } from './errors.js';
import { curvedSketchRectangle, curvedSketchEllipse } from './sketch-curves.js';
import { elementChildren } from './docx-xml.js';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const ASK = 'http://schemas.microsoft.com/office/drawing/2018/sketchyshapes';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const URI = '{c807c97d-bfc1-408e-a445-0c87eb9f89a2}';
const fail = why => { throw new UnsupportedDocumentError(`sketch outlines with ${why}`); };
const children = n => n?.children ? elementChildren(n) : [];
const is = (n, ns, name) => n?.namespaceURI === ns && n.localName === name;
function attributes(n, allowed) {
  if ([...n.attributes].some(a => a.namespaceURI !== XMLNS && (a.namespaceURI || !allowed.includes(a.localName))) || [...n.childNodes].some(c => [3, 4].includes(c.nodeType) && c.textContent.trim())) fail('invalid attributes or text');
}
const seed = value => {
  const lexical = value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (!/^[+-]?\d+$/.test(lexical) || Number(lexical) < 0 || Number(lexical) > 4294967295) fail('invalid seed');
};

// Files can retain an empty sketch cache on an ordinary line. This is distinct
// from materialized sketch geometry: only the explicitly neutral cache below
// may be read by the editable importer. The original XML remains in its shell.
export function neutralSketchLine(line) {
  const lists = children(line).filter(n => is(n, A, 'extLst'));
  if (!lists.length) return null;
  if (lists.length !== 1) return null;
  const list = lists[0], extensions = children(list);
  if (extensions.length !== 1) return null;
  const ext = extensions[0], saved = children(ext)[0];
  if (!is(ext,A,'ext') || ext.getAttribute('uri')?.toLowerCase() !== URI || children(ext).length !== 1 || !is(saved,ASK,'lineSketchStyleProps')) return null;
  attributes(list,[]);attributes(ext,['uri']);attributes(saved,['sd']);
  if(saved.hasAttribute('sd'))seed(saved.getAttribute('sd'));
  const [geometry,type,...rest] = children(saved);
  if(rest.length || !is(geometry,A,'custGeom') || !is(type,ASK,'type'))return null;
  attributes(geometry,[]);attributes(type,[]);
  if(children(type).length && !(children(type).length===1 && is(children(type)[0],ASK,'lineSketchNone')))return null;
  for(const n of children(type)){attributes(n,[]);if(children(n).length)return null;}
  const nodes=children(geometry), names=['avLst','gdLst','ahLst','cxnLst','rect','pathLst'];
  if(nodes.length!==names.length)return null;
  for(let i=0;i<nodes.length;i++){
    const n=nodes[i];if(!is(n,A,names[i]) || children(n).length)return null;
    attributes(n,names[i]==='rect'?['l','t','r','b']:[]);
    if(names[i]==='rect' && ['l','t','r','b'].some(k=>!/^[-+]?0+$/.test(n.getAttribute(k)||'')))return null;
  }
  const copy=line.cloneNode(true);children(copy).find(n=>is(n,A,'extLst')).remove();return copy;
}

// MS-ODRAWXML §2.38.3.2 describes regeneration metadata. Validate the extension
// before projecting its line. Editable import additionally requires the known
// preset subset below; other projections remain read-only approximations.
export function sketchLinePreview(properties) {
  const line = children(properties).find(n => is(n, A, 'ln'));
  if (!line) return null;
  const lists = children(line).filter(n => is(n, A, 'extLst'));
  if (!lists.length) return null;
  if (lists.length !== 1) fail('duplicate extension lists');
  const list = lists[0]; attributes(list, []);
  let seen = false;
  for (const ext of children(list)) {
    attributes(ext, ['uri']);
    if (!is(ext, A, 'ext') || ext.getAttribute('uri')?.toLowerCase() !== URI || seen) fail('unknown or duplicate extension');
    seen = true;
    const items = children(ext), saved = items[0];
    if (items.length !== 1 || !is(saved, ASK, 'lineSketchStyleProps')) fail('invalid properties');
    if (!children(properties).some(n => is(n, A, 'custGeom'))) fail('missing materialized custom geometry');
    attributes(saved, ['sd']);
    if (saved.hasAttribute('sd')) seed(saved.getAttribute('sd'));
    let previous = -1;
    for (const n of children(saved)) {
      const order = is(n, A, 'custGeom') || is(n, A, 'prstGeom') ? 0 : is(n, ASK, 'type') ? 1 : is(n, ASK, 'seed') ? 2 : -1;
      if (order < 0 || order <= previous) fail('unknown or duplicate saved property');
      previous = order;
      // Do not evaluate the saved regeneration geometry in this approximation.
      if (order === 0) continue;
      if (order === 2) {
        if (children(n).length || [...n.attributes].some(a => a.namespaceURI !== XMLNS)) fail('invalid seed element');
        seed(n.textContent.trim()); continue;
      }
      attributes(n, []);
      const types = children(n);
      if (types.length > 1) fail('conflicting sketch types');
      for (const type of types) {
        if (type.namespaceURI !== ASK || !['lineSketchNone', 'lineSketchCurved', 'lineSketchFreehand', 'lineSketchScribble'].includes(type.localName)) fail('unknown sketch type');
        attributes(type, []); if (children(type).length) fail('nested sketch type');
      }
    }
  }
  if (!seen) return null;
  const copy = line.cloneNode(true);
  for (const n of children(copy).filter(n => is(n, A, 'extLst'))) n.remove();
  return copy;
}

// Supported presets may be retained as atomic drawings in editable documents.
// Only the scene is regenerated; the original XML shell remains authoritative.
function supportedSketch(properties) {
  const projectedLine = sketchLinePreview(properties);
  if (!projectedLine) return null;
  const line = children(properties).find(n => is(n, A, 'ln'));
  const list = children(line).find(n => is(n, A, 'extLst'));
  const saved = children(children(list)[0])[0];
  const geometry = children(saved).find(n => is(n, A, 'prstGeom'));
  const type = children(saved).find(n => is(n, ASK, 'type'));
  const seedElement = children(saved).find(n => is(n, ASK, 'seed'));
  if (!geometry || !['rect', 'ellipse'].includes(geometry.getAttribute('prst')) || !is(children(type)[0], ASK, 'lineSketchCurved')) return null;
  // The precedence of simultaneous seed forms has not been established.
  if (saved.hasAttribute('sd') === !!seedElement) return null;
  if ([...geometry.attributes].some(a => a.namespaceURI !== XMLNS && (a.namespaceURI || a.localName !== 'prst'))) return null;
  const adjustments = children(geometry);
  if (adjustments.length > 1 || adjustments.some(n => !is(n, A, 'avLst') || children(n).length || [...n.attributes].some(a => a.namespaceURI !== XMLNS)) || /\S/.test(geometry.textContent)) return null;
  return { line: projectedLine, ellipse: geometry.getAttribute('prst') === 'ellipse', seed: Number(seedElement?.textContent ?? saved.getAttribute('sd')) };
}

export function supportedSketchLine(properties) { return supportedSketch(properties)?.line || null; }

export function readSketchGeometry(properties, { width, height }, { preview = false } = {}) {
  const sketch = supportedSketch(properties);
  if (!sketch) return null;
  if (!(width > 0 && height > 0)) {
    if (preview) return null;
    fail('nonpositive extents');
  }
  const { ellipse, seed } = sketch;
  const generate = ellipse ? curvedSketchEllipse : curvedSketchRectangle;
  const inset = ellipse ? (1 - Math.SQRT1_2) / 2 : 0;
  return { paths: generate(width, height, seed), textRect: { left: inset, top: inset, right: 1 - inset, bottom: 1 - inset } };
}

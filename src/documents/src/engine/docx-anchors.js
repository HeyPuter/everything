import { UnsupportedDocumentError } from './errors.js';
import { MC, alternateBranch } from './docx-compatibility.js';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const WP14 = 'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing';
const children = n => [...(n?.children || [])].flatMap(c => c.namespaceURI === MC && c.localName === 'AlternateContent' ? children(alternateBranch(c)) : [c]);
const child = (n, name) => children(n).find(c => c.namespaceURI === WP && c.localName === name);
const fail = why => { throw new UnsupportedDocumentError(`floating pictures with ${why}`); };
// A wrap polygon (§20.4.2.16): a start point and at least two more points in 0..21600 wrap units.
function validPolygon(wrap) {
  const nodes = children(wrap);
  if (nodes.length !== 1 || nodes[0].namespaceURI !== WP || nodes[0].localName !== 'wrapPolygon') return false;
  const polygon = nodes[0], points = children(polygon);
  if ([...polygon.attributes].some(a => !a.namespaceURI && (a.localName !== 'edited' || !['0', '1', 'true', 'false'].includes(a.value)))) return false;
  if (points.length < 3 || points[0].localName !== 'start' || points.slice(1).some(n => n.localName !== 'lineTo')) return false;
  return points.every(n => n.namespaceURI === WP && !children(n).length && ['x', 'y'].every(k => /^[+-]?\d+$/.test(n.getAttribute(k) || '') && Math.abs(Number(n.getAttribute(k))) <= 27273042316900)
    && [...n.attributes].every(a => a.namespaceURI || ['x', 'y'].includes(a.localName)));
}
// Retain supported floating coordinate systems and wrapping independently of
// inline image metrics. Square anchors (column, paragraph, page or margin
// coordinates, by offset or alignment) use page-aware text exclusions;
// centered full-column pictures retain the existing standalone band path.
export function readAnchor(anchor) {
  for (const attr of [...anchor.attributes]) if (!attr.namespaceURI && !['simplePos', 'behindDoc', 'locked', 'layoutInCell', 'allowOverlap', 'relativeHeight', 'hidden', 'distT', 'distB', 'distL', 'distR'].includes(attr.localName)) fail(`unsupported ${attr.localName}`);
  // Tight and through wrapping (§20.4.2.18, §20.4.2.17) keep their wrap polygon in the drawing; text
  // flows around the object's rectangle, as for square wrapping.
  const contour = child(anchor, 'wrapTight') || child(anchor, 'wrapThrough');
  const square = child(anchor, 'wrapSquare') || contour;
  // A picture centred in its column at its paragraph's top keeps the standalone band path below; every
  // other square, tight or through wrap is placed like a floating object and excludes text around it.
  const placed = (name, base, alignment) => { const pos = child(anchor, name); return pos?.getAttribute('relativeFrom') === base && child(pos, 'align')?.textContent === alignment; };
  const sideWrapped = !!square && !(placed('positionH', 'column', 'center') && placed('positionV', 'paragraph', 'top'));
  const positioned = !!child(anchor, 'wrapTopAndBottom') || !!child(anchor, 'wrapNone') || !!sideWrapped;
  if (anchor.hasAttribute('hidden') && !['0', 'false'].includes(anchor.getAttribute('hidden'))) fail('hidden drawings');
  // Locking prevents automatic re-anchoring when an object is repositioned; it
  // does not hide the object or freeze its paragraph's position during layout.
  // This editor retains the source anchor and never automatically re-anchors it.
  const locked = ['1', 'true'].includes(anchor.getAttribute('locked'));
  const layoutInCell = child(anchor, 'wrapNone') ? !['0', 'false'].includes(anchor.getAttribute('layoutInCell')) : true;
  const allowOverlap = child(anchor, 'wrapNone') ? !['0', 'false'].includes(anchor.getAttribute('allowOverlap')) : true;
  const defaults = { simplePos: false, behindDoc: positioned ? ['1', 'true'].includes(anchor.getAttribute('behindDoc')) : false, locked, layoutInCell, allowOverlap };
  for (const [name, expected] of Object.entries(defaults)) {
    const raw = anchor.getAttribute(name);
    if (raw === null || !['0', '1', 'false', 'true'].includes(raw) || ['1', 'true'].includes(raw) !== expected) fail(`unsupported ${name}`);
  }
  if (!/^\d+$/.test(anchor.getAttribute('relativeHeight') || '') || Number(anchor.getAttribute('relativeHeight')) > 4294967295) fail('invalid stacking order');
  for (const name of ['distT', 'distB', 'distL', 'distR']) if (anchor.hasAttribute(name) && !(positioned && (sideWrapped || ['distL', 'distR'].includes(name) || child(anchor, 'wrapNone')) ? /^\d+$/.test(anchor.getAttribute(name)) : /^0+$/.test(anchor.getAttribute(name)))) fail('nonzero text distances');
  const simple = child(anchor, 'simplePos');
  // With anchor@simplePos=false, these retained coordinates are inactive
  // (§20.4.2.3). Validate them without applying them to positionH/positionV.
  if (!simple || children(simple).length || simple.textContent.trim()
    || [...simple.attributes].some(a => !a.namespaceURI && !['x', 'y'].includes(a.localName))
    || !['x', 'y'].every(n => {
      const raw = simple.getAttribute(n)?.trim();
      return /^[+-]?\d+$/.test(raw || '') && Number(raw) >= -27273042329600 && Number(raw) <= 27273042316900;
    })) fail('invalid simple position');
  if (positioned) {
    const offsets = {}, noWrap = !!child(anchor, 'wrapNone'), bandWrap = !!child(anchor, 'wrapTopAndBottom');
    const bases = {};
    // Square wrapping takes page and margin coordinates (and alignment against them) as well as column and
    // paragraph offsets (§20.4.2.10, §20.4.2.11); a line-relative wrapped object is outside the subset.
    const pageBases = axis => noWrap ? ['page', 'margin', ...(axis === 'y' ? ['topMargin', 'bottomMargin', 'line'] : [])]
      : bandWrap && axis === 'x' ? ['page', 'margin'] : sideWrapped ? ['page', 'margin', ...(axis === 'y' ? ['topMargin', 'bottomMargin'] : [])] : [];
    for (const [name, relative, axis] of [['positionH', 'column', 'x'], ['positionV', 'paragraph', 'y']]) {
      const pos = child(anchor, name), base = pos?.getAttribute('relativeFrom');
      if (children(anchor).filter(n => n.namespaceURI === WP && n.localName === name).length !== 1 || ![relative, ...pageBases(axis)].includes(base) || children(pos).length !== 1 || [...pos.attributes].some(a => !a.namespaceURI && a.localName !== 'relativeFrom')) fail(`unsupported ${name}`);
      bases[axis === 'x' ? 'horizontal' : 'vertical'] = base;
      const content = children(pos)[0];
      const branch = content.namespaceURI === MC && content.localName === 'AlternateContent' ? alternateBranch(content) : pos;
      if (children(branch).length !== 1) fail(`invalid ${name} contents`);
      const offset = child(branch, 'posOffset'), align = child(branch, 'align');
      const percentage = children(branch).find(n => n.namespaceURI === WP14 && n.localName === (axis === 'x' ? 'pctPosHOffset' : 'pctPosVOffset'));
      if (percentage) {
        const raw = percentage.textContent.trim();
        const percent = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)%$/.test(raw);
        const value = percent ? Number(raw.slice(0, -1)) * 1000 : Number(raw);
        if (!noWrap || children(percentage).length || [...percentage.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/') ||
            !percent && !/^[+-]?\d+$/.test(raw) || !Number.isFinite(value) || value < -2147483648 || value > 2147483647) fail(`invalid ${name} percentage`);
        offsets[axis] = 0; offsets[axis + 'Percentage'] = value;
      } else
      if (offset) {
        const raw = offset.textContent.trim();
        if (children(offset).length || !/^[+-]?\d+$/.test(raw) || Math.abs(Number(raw)) > 20116800) fail(`invalid ${name} offset`);
        offsets[axis] = Number(raw);
      } else if ((noWrap || sideWrapped || bandWrap && axis === 'x') && align && (axis === 'x' || !['paragraph', 'line'].includes(base))) {
        const raw = align.textContent.trim();
        if (children(align).length || !(axis === 'x' ? ['left', 'center', 'right'] : ['top', 'center', 'bottom']).includes(raw)) fail(`unsupported ${name} alignment`);
        offsets[axis] = 0; offsets[axis + 'Align'] = raw;
      } else fail(`unsupported ${name}`);
    }
    if (!layoutInCell && !(['page', 'margin'].includes(bases.horizontal) && ['page', 'margin', 'topMargin', 'bottomMargin'].includes(bases.vertical)) && !(bases.horizontal === 'column' && (bases.vertical === 'paragraph' || bases.vertical === 'page' && !offsets.xAlign && !offsets.yAlign)) && !(noWrap && ['page', 'margin'].includes(bases.horizontal) && bases.vertical === 'paragraph' && !offsets.xAlign && !offsets.yAlign)) fail('layoutInCell=false with mixed paragraph or column coordinates');
    const wrap = child(anchor, 'wrapTopAndBottom') || child(anchor, 'wrapNone') || square;
    if (children(anchor).filter(n => n.namespaceURI === WP && n.localName.startsWith('wrap')).length !== 1) fail('multiple wrapping declarations');
    if (sideWrapped) {
      if ((contour ? !validPolygon(wrap) : children(wrap).length) || !['bothSides', 'left', 'right', 'largest'].includes(wrap.getAttribute('wrapText'))) fail('unsupported square wrapping');
      const distances = {};
      for (const side of ['T', 'B', 'L', 'R']) {
        const raw = wrap.getAttribute('dist' + side) ?? anchor.getAttribute('dist' + side) ?? '0';
        if (!/^\d+$/.test(raw) || Number(raw) > 20116800) fail('invalid square wrapping distance');
        distances[side] = Number(raw);
      }
      if ([...wrap.attributes].some(a => !a.namespaceURI && !['wrapText','distT','distB','distL','distR'].includes(a.localName))) fail('unsupported square wrapping attribute');
      return { ...bases, wrap: 'square', ...(contour ? { contour: contour.localName === 'wrapTight' ? 'tight' : 'through' } : {}), wrapText: wrap.getAttribute('wrapText'), distances, behind: defaults.behindDoc, order: Number(anchor.getAttribute('relativeHeight')), ...(locked ? { locked } : {}), ...offsets };
    }
    if (children(wrap).length || [...wrap.attributes].some(a => !a.namespaceURI && (!['distT', 'distB'].includes(a.localName) || !/^0+$/.test(a.value)))) fail('unsupported wrapping distances');
    return { ...bases, wrap: wrap.localName === 'wrapNone' ? 'none' : 'topAndBottom', behind: defaults.behindDoc, order: Number(anchor.getAttribute('relativeHeight')), ...(locked ? { locked } : {}), ...(!layoutInCell ? { layoutInCell } : {}), ...(!allowOverlap ? { allowOverlap } : {}), ...offsets };
  }
  for (const [name, relative, alignment] of [['positionH', 'column', 'center'], ['positionV', 'paragraph', 'top']]) {
    const pos = child(anchor, name);
    if (pos?.getAttribute('relativeFrom') !== relative || children(pos).length !== 1 || child(pos, 'align')?.textContent !== alignment) fail(`unsupported ${name}`);
  }
  const wrap = child(anchor, 'wrapSquare');
  if (!wrap || !['bothSides', 'largest', 'left', 'right'].includes(wrap.getAttribute('wrapText')) || children(wrap).length) fail('unsupported text wrapping');
  for (const attr of [...wrap.attributes]) if (!attr.namespaceURI && attr.localName !== 'wrapText' && (!['distT', 'distB', 'distL', 'distR'].includes(attr.localName) || !/^0+$/.test(attr.value))) fail('unsupported wrapping distances');
  return { horizontal: 'columnCenter', vertical: 'paragraphTop', wrap: 'square', ...(locked ? { locked } : {}) };
}

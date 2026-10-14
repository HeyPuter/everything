import { materializeDrawing, readFormattedDrawing, applyDrawingFragments, drawingKind } from './drawing-format.js';
import { A, WP, PIC, WPS, WPG, child, make, writeFrame } from './drawing-xml.js';
import { frameOf, offsetsFor } from './drawing-arrange.js';
import { EMU_PER_PX, OBJECT, isPositionedImage } from './images.js';

/**
 * Group, Ungroup and Regroup (§20.4 wpg group drawings, ECMA-376 Part 1 §20.1.2.2.20 grpSpPr / §20.1.7.5
 * group transforms). Grouping writes the selected floating drawings as the children of one group drawing:
 * each child keeps its own DrawingML (fill, outline, effects, text, picture) and is placed in the group's
 * child coordinate space at its current page position. Ungrouping writes each child back out as its own
 * floating drawing at the place the group showed it, folding the group's rotation and flips into it.
 */
const runImages = model => model.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => r.image));
const nextId = model => Math.max(0, ...runImages(model).map(image => image.id)) + 1;
/** Text offsets of each drawing's object character in the current story. */
function positions(model) {
  const result = new Map(); let offset = 0;
  model.paragraphs.forEach((p, index) => {
    for (const run of p.runs) { if (run.image) result.set(run.image, offset); offset += run.text.length; }
    if (index < model.paragraphs.length - 1) offset += 1;
  });
  return result;
}
const int = value => Math.round(value);

/** Why these drawings cannot be grouped, or null. */
export function groupUnavailable(images) {
  if (images.length < 2) return 'Select two or more objects (Shift+click) to group them.';
  if (images.some(image => !isPositionedImage(image))) return 'Only floating objects can be grouped. Set their text wrapping first.';
  if (images.some(image => ['chart', 'diagram', 'other'].includes(drawingKind(image)))) return 'Charts and diagrams cannot be grouped.';
  if (images.some(image => image.hyperlink)) return 'Objects with links cannot be grouped.';
  if (images.some(image => image.anchor?.relativeSize)) return 'Objects sized relative to the page cannot be grouped.';
  return null;
}

/** A group's graphic child for a drawing's graphic root, placed at (x, y) with size (cx, cy) in the group space. */
function groupChild(doc, root, docPr, { x, y, cx, cy }, ids) {
  const node = doc.importNode(root, true);
  const naming = { id: ids.next(), name: docPr.getAttribute('name') || 'Object', ...(docPr.getAttribute('descr') ? { descr: docPr.getAttribute('descr') } : {}), ...(docPr.getAttribute('title') ? { title: docPr.getAttribute('title') } : {}) };
  let props;
  if (node.namespaceURI === WPS) {
    if (!child(node, WPS, 'cNvPr')) node.insertBefore(make(doc, WPS, 'cNvPr', naming), node.firstChild);
    props = child(node, WPS, 'spPr');
  } else if (node.namespaceURI === PIC) {
    const nv = child(child(node, PIC, 'nvPicPr'), PIC, 'cNvPr');
    if (nv) for (const [key, value] of Object.entries(naming)) if (key !== 'id') nv.setAttribute(key, value);
    props = child(node, PIC, 'spPr');
  } else if (node.namespaceURI === WPG && node.localName === 'wgp') {
    // A nested group is a grpSp inside the new group.
    const group = make(doc, WPG, 'grpSp');
    if (!child(node, WPG, 'cNvPr')) group.append(make(doc, WPG, 'cNvPr', naming));
    while (node.firstChild) group.append(node.firstChild);
    props = child(group, WPG, 'grpSpPr');
    placeTransform(doc, props, { x, y, cx, cy });
    return group;
  } else throw new Error('This object cannot be grouped.');
  placeTransform(doc, props, { x, y, cx, cy });
  return node;
}
function placeTransform(doc, props, { x, y, cx, cy }) {
  let xfrm = child(props, A, 'xfrm');
  if (!xfrm) { xfrm = make(doc, A, 'xfrm'); props.insertBefore(xfrm, props.firstChild); }
  let off = child(xfrm, A, 'off'), ext = child(xfrm, A, 'ext');
  if (!off) { off = make(doc, A, 'off'); xfrm.insertBefore(off, xfrm.firstChild); }
  if (!ext) { ext = make(doc, A, 'ext'); off.after(ext); }
  off.setAttribute('x', String(int(x))); off.setAttribute('y', String(int(y)));
  // A nested group's child space (chOff, chExt) keeps its own coordinates; its extent maps it into the new place.
  ext.setAttribute('cx', String(int(cx))); ext.setAttribute('cy', String(int(cy)));
}

/**
 * Group floating drawings into one wpg:wgp drawing. images: drawings of the current story, in any
 * order. Returns whether the document changed; the group stays selected.
 */
export async function groupDrawings(editor, images) {
  const reason = groupUnavailable(images);
  if (reason) throw new Error(reason);
  const pkg = editor.shapePackage?.(), model = editor.model, revision = editor.session.revision;
  const at = positions(model);
  const members = images.map(image => ({ image, frame: frameOf(editor, image), start: at.get(image) })).sort((a, b) => a.start - b.start);
  if (members.some(m => !m.frame)) throw new Error('Scroll the objects into view and try again.');
  if (members.some(m => m.frame.page !== members[0].frame.page)) throw new Error('Objects on different pages cannot be grouped.');
  const left = Math.min(...members.map(m => m.frame.x)), top = Math.min(...members.map(m => m.frame.y));
  const width = Math.max(...members.map(m => (m.frame.x - left) * EMU_PER_PX + m.image.width));
  const height = Math.max(...members.map(m => (m.frame.y - top) * EMU_PER_PX + m.image.height));
  const primary = members[0];
  const { drawing, parts: primaryParts } = materializeDrawing(pkg, model, primary.image);
  const doc = drawing.ownerDocument;
  const parts = new Map(primaryParts);
  let id = nextId(model) + 1000; const ids = { next: () => id++ };
  const group = make(doc, WPG, 'wgp', {}, make(doc, WPG, 'cNvGrpSpPr'),
    make(doc, WPG, 'grpSpPr', {}, make(doc, A, 'xfrm', {}, make(doc, A, 'off', { x: 0, y: 0 }), make(doc, A, 'ext', { cx: int(width), cy: int(height) }), make(doc, A, 'chOff', { x: 0, y: 0 }), make(doc, A, 'chExt', { cx: int(width), cy: int(height) }))));
  for (const member of members) {
    const source = member === primary ? { drawing } : materializeDrawing(pkg, model, member.image);
    if (source.parts) for (const [rel, part] of source.parts) {
      if (parts.has(rel) && parts.get(rel).path !== part.path) throw new Error('These objects use conflicting pictures and cannot be grouped.');
      parts.set(rel, part);
    }
    const frame = [...source.drawing.children].find(n => n.namespaceURI === WP);
    const root = child(child(frame, A, 'graphic'), A, 'graphicData')?.firstElementChild;
    const docPr = child(frame, WP, 'docPr');
    group.append(groupChild(doc, root, docPr, { x: (member.frame.x - left) * EMU_PER_PX, y: (member.frame.y - top) * EMU_PER_PX, cx: member.image.width, cy: member.image.height }, ids));
  }
  // The group takes the first object's frame: its anchor coordinates, wrapping and layer.
  const frame = [...drawing.children].find(n => n.namespaceURI === WP);
  const data = child(child(frame, A, 'graphic'), A, 'graphicData');
  data.setAttribute('uri', WPG); data.replaceChildren(group);
  const extent = child(frame, WP, 'extent'); extent.setAttribute('cx', String(int(width))); extent.setAttribute('cy', String(int(height)));
  const effects = child(frame, WP, 'effectExtent'); if (effects) for (const side of ['l', 't', 'r', 'b']) effects.setAttribute(side, '0');
  const docPr = child(frame, WP, 'docPr');
  for (const name of ['descr', 'title']) docPr.removeAttribute(name);
  docPr.replaceChildren();
  const groupId = nextId(model);
  docPr.setAttribute('name', `Group ${groupId}`);
  const locks = child(frame, WP, 'cNvGraphicFramePr'); locks?.replaceChildren();
  const offsets = offsetsFor(editor, primary.frame, left, top);
  writeFrame(drawing, { horizontal: { relativeFrom: primary.image.anchor.horizontal === 'columnCenter' ? 'column' : primary.image.anchor.horizontal, offset: offsets.x },
    vertical: { relativeFrom: primary.image.anchor.vertical === 'paragraphTop' ? 'paragraph' : primary.image.anchor.vertical, offset: offsets.y },
    order: Math.max(...members.map(m => m.image.anchor.order || 0)) });
  const fragment = await readFormattedDrawing(pkg, model, primary.image, drawing, parts);
  fragment.image = { ...fragment.image, id: groupId };
  return applyDrawingFragments(editor, [fragment], model => {
    model.checkpoint();
    const now = positions(model);
    const starts = members.map(m => now.get(m.image)).filter(n => n !== undefined);
    if (starts.length !== members.length) throw new Error('The objects changed before they could be grouped.');
    const first = Math.min(...starts);
    for (const start of [...starts].sort((a, b) => b - a)) { model.select(start, start + 1); model.replace('', { checkpoint: false }); }
    model.select(first, first);
    model.replace(OBJECT, { checkpoint: false, insertedImage: fragment.image });
    model.select(first, first + 1);
    return true;
  }, { revision });
}

/** Read a group transform: off, ext, chOff, chExt (EMU), rotation (degrees), flips. */
function groupTransform(props) {
  const xfrm = child(props, A, 'xfrm');
  const pair = (name, a, b, fallback = 0) => { const n = child(xfrm, A, name); return [Number(n?.getAttribute(a) ?? fallback), Number(n?.getAttribute(b) ?? fallback)]; };
  const [x, y] = pair('off', 'x', 'y'), [cx, cy] = pair('ext', 'cx', 'cy'), [chx, chy] = pair('chOff', 'x', 'y'), [chcx, chcy] = pair('chExt', 'cx', 'cy');
  return { x, y, cx, cy, chx, chy, chcx: chcx || cx, chcy: chcy || cy, rotation: Number(xfrm?.getAttribute('rot') || 0) / 60000,
    flipH: ['1', 'true'].includes(xfrm?.getAttribute('flipH')), flipV: ['1', 'true'].includes(xfrm?.getAttribute('flipV')) };
}

/** Ungroup the selected group drawing into its children. Returns the new drawings' ids. */
export async function ungroupDrawing(editor, image) {
  if (drawingKind(image) !== 'group') throw new Error('Select a group to ungroup it.');
  if (!isPositionedImage(image)) throw new Error('Set the group\'s text wrapping before ungrouping it.');
  const pkg = editor.shapePackage?.(), model = editor.model, revision = editor.session.revision;
  const { drawing, parts } = materializeDrawing(pkg, model, image);
  const doc = drawing.ownerDocument;
  const frame = [...drawing.children].find(n => n.namespaceURI === WP);
  const group = child(child(child(frame, A, 'graphic'), A, 'graphicData'), WPG, 'wgp');
  const g = groupTransform(child(group, WPG, 'grpSpPr'));
  const width = Number(child(frame, WP, 'extent').getAttribute('cx')), height = Number(child(frame, WP, 'extent').getAttribute('cy'));
  const scaleX = g.chcx ? width / g.chcx : 1, scaleY = g.chcy ? height / g.chcy : 1;
  const where = frameOf(editor, image);
  if (!where) throw new Error('Scroll the group into view and try again.');
  const groupFrameX = where.x, groupFrameY = where.y;
  const kids = [...group.children].filter(n => (n.namespaceURI === WPS && n.localName === 'wsp') || (n.namespaceURI === PIC && n.localName === 'pic') || (n.namespaceURI === WPG && n.localName === 'grpSp'));
  if (kids.length < 1) throw new Error('This group has nothing to ungroup.');
  const angle = g.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  let id = nextId(model);
  const fragments = [];
  for (const [index, kid] of kids.entries()) {
    const props = kid.namespaceURI === WPS ? child(kid, WPS, 'spPr') : kid.namespaceURI === PIC ? child(kid, PIC, 'spPr') : child(kid, WPG, 'grpSpPr');
    const t = groupTransform(props);
    const cw = t.cx * scaleX, ch = t.cy * scaleY;
    // The child's centre in the group frame, then through the group's flips and rotation about its centre.
    let cx = (t.x - g.chx) * scaleX + cw / 2 - width / 2, cy = (t.y - g.chy) * scaleY + ch / 2 - height / 2;
    if (g.flipH) cx = -cx;
    if (g.flipV) cy = -cy;
    const rx = cx * cos - cy * sin + width / 2, ry = cx * sin + cy * cos + height / 2;
    const copy = doc.importNode(kid, true);
    let root = copy;
    if (kid.namespaceURI === WPG) {
      root = make(doc, WPG, 'wgp');
      for (const node of [...copy.childNodes]) root.append(node);
    }
    const ownProps = root.namespaceURI === WPS ? child(root, WPS, 'spPr') : root.namespaceURI === PIC ? child(root, PIC, 'spPr') : child(root, WPG, 'grpSpPr');
    const xfrm = child(ownProps, A, 'xfrm');
    child(xfrm, A, 'off').setAttribute('x', '0'); child(xfrm, A, 'off').setAttribute('y', '0');
    child(xfrm, A, 'ext').setAttribute('cx', String(int(cw))); child(xfrm, A, 'ext').setAttribute('cy', String(int(ch)));
    // Flips of the group mirror the child; both flips together are a half turn.
    let rotation = t.rotation, flipH = t.flipH, flipV = t.flipV;
    if (g.flipH && g.flipV) rotation += 180;
    else if (g.flipH || g.flipV) { rotation = -rotation; if (g.flipH) flipH = !flipH; else flipV = !flipV; }
    rotation = ((rotation + g.rotation) % 360 + 360) % 360;
    const rot = int(rotation * 60000) % 21600000;
    if (rot) xfrm.setAttribute('rot', String(rot)); else xfrm.removeAttribute('rot');
    for (const [key, value] of [['flipH', flipH], ['flipV', flipV]]) if (value) xfrm.setAttribute(key, '1'); else xfrm.removeAttribute(key);
    // Names and alt text come from the child's own non-visual properties.
    const nv = root.namespaceURI === PIC ? child(child(root, PIC, 'nvPicPr'), PIC, 'cNvPr') : child(root, root.namespaceURI, 'cNvPr');
    const name = nv?.getAttribute('name') || `Object ${id}`, descr = nv?.getAttribute('descr') || '';
    if (root.namespaceURI === WPS) child(root, WPS, 'cNvPr')?.remove();
    if (root.namespaceURI === WPG) child(root, WPG, 'cNvPr')?.remove();
    const single = drawing.cloneNode(true);
    const singleFrame = [...single.children].find(n => n.namespaceURI === WP);
    const data = child(child(singleFrame, A, 'graphic'), A, 'graphicData');
    data.setAttribute('uri', root.namespaceURI === WPS ? WPS : root.namespaceURI === PIC ? PIC : WPG);
    data.replaceChildren(root);
    child(singleFrame, WP, 'extent').setAttribute('cx', String(int(cw))); child(singleFrame, WP, 'extent').setAttribute('cy', String(int(ch)));
    const docPr = child(singleFrame, WP, 'docPr');
    docPr.replaceChildren(); docPr.setAttribute('id', String(id)); docPr.setAttribute('name', name);
    if (descr) docPr.setAttribute('descr', descr); else docPr.removeAttribute('descr');
    docPr.removeAttribute('title');
    const offsets = offsetsFor(editor, where, groupFrameX + (rx - cw / 2) / EMU_PER_PX, groupFrameY + (ry - ch / 2) / EMU_PER_PX);
    writeFrame(single, { horizontal: { relativeFrom: image.anchor.horizontal === 'columnCenter' ? 'column' : image.anchor.horizontal, offset: offsets.x },
      vertical: { relativeFrom: image.anchor.vertical === 'paragraphTop' ? 'paragraph' : image.anchor.vertical, offset: offsets.y }, order: (image.anchor.order || 1) + index });
    const fragment = await readFormattedDrawing(pkg, model, image, single, parts);
    fragment.image = { ...fragment.image, id: id++ };
    fragments.push(fragment);
  }
  const ok = await applyDrawingFragments(editor, fragments, model => {
    model.checkpoint();
    const start = positions(model).get(image);
    if (start === undefined) throw new Error('The group changed before it could be ungrouped.');
    model.select(start, start + 1); model.replace('', { checkpoint: false });
    for (const [i, fragment] of fragments.entries()) { model.select(start + i, start + i); model.replace(OBJECT, { checkpoint: false, insertedImage: fragment.image }); }
    model.select(start, start + 1);
    return true;
  }, { revision });
  return ok ? fragments.map(f => f.image.id) : null;
}

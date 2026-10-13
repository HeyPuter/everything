/**
 * Opacity masks: an object's transparency taken from the luminance of
 * other artwork (white shows the object, black hides it, grays are
 * partly transparent).
 *
 * node.opacityMask = {
 *   art: { root, nodes },   the mask artwork (doc.exportSubtree format), not in the tree
 *   transform,              matrix applied to the art (follows the object while linked)
 *   clip,                   outside the mask art counts as black (hidden) instead of white
 *   invert,                 use 1 - luminance
 *   disabled,               keep the mask but draw the object unmasked
 *   unlinked,               transforming the object leaves the mask where it is
 * }
 *
 * Make Opacity Mask uses the topmost selected object as the mask for the
 * rest (grouped when there are several); Release puts the art back above
 * the object. Rendering goes through drawHooks.opacityMask, transforms
 * through geometry transformHooks, and SVG export writes a <mask>.
 *
 * Mask editing mode (from the Transparency panel's mask thumbnail) edits
 * the art in place: it moves into the document as a group marked
 * `maskEdit: { owner }` right above the object (whose mask records
 * `editing: groupId` and is drawn from that group meanwhile), and the group
 * is isolated so every tool works on it. The art itself does not paint; its
 * outlines show. Leaving the mode (Esc, the object thumbnail, Exit
 * Isolation Mode) stores the edited art back into the mask. Like pattern
 * editing, the mode is document state, so undo steps in and out of it.
 */
import { drawNode, drawHooks } from '../../render/draw.js';
import { transformHooks, nodeBounds, transformNodes } from '../../model/geometry.js';
import { createGroup } from '../../model/nodes.js';
import { IDENTITY, multiply, translate } from '../../lib/matrix.js';
import { svgExportHooks, exportBakers } from '../io/hooks.js';
import { viewHooks } from '../../render/canvas-view.js';

const isIdentity = (m) => !m || m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-12);

export function maskOf(node) {
  return node?.opacityMask || null;
}

/** A document view in which the mask art's nodes resolve (other ids fall through to the document). */
const views = new WeakMap();
export function maskView(doc, om) {
  let hit = views.get(om.art);
  if (hit && hit.doc === doc) return hit.view;
  const map = new Map(om.art.nodes.map((n) => [n.id, n]));
  const view = {
    get: (id) => map.get(id) ?? doc.get(id),
    has: (id) => map.has(id) || doc.has(id),
    assets: doc.assets,
    root: doc.root,
    artboards: doc.artboards,
    walk: (fn, id = om.art.root, depth = 0) => {
      const n = view.get(id);
      if (!n) return;
      if (fn(n, depth) === false) return;
      if (n.children) for (const c of n.children) view.walk(fn, c, depth + 1);
    },
  };
  views.set(om.art, { doc, view });
  return view;
}

export function maskRootNode(doc, om) {
  return maskView(doc, om).get(om.art.root);
}

/** Bounds of the mask art in document space (with its transform). */
export function maskBounds(doc, om) {
  const root = maskRootNode(doc, om);
  const b = root ? nodeBounds(maskView(doc, om), root) : null;
  if (!b || isIdentity(om.transform)) return b;
  const t = om.transform;
  const pts = [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x, b.y + b.h],
    [b.x + b.w, b.y + b.h],
  ].map(([x, y]) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

// ---- rendering ----

const maskCache = new WeakMap();

/**
 * Luminance-to-alpha mask for a device region: transparent black where
 * the object is hidden, opaque where it shows.
 */
function maskCanvas(region, m, doc, node, opts) {
  const om = node.opacityMask;
  // While the art is edited in place it draws from the document (never cached: it changes under the same mask record).
  const live = om.editing && doc.get(om.editing)?.maskEdit ? doc.get(om.editing) : null;
  const key = [region.x, region.y, region.w, region.h, m.a, m.b, m.c, m.d, m.e, m.f, om.clip, om.invert].join(',');
  const hit = maskCache.get(om);
  if (!live && hit && hit.key === key && hit.doc === doc) return hit.canvas;
  const canvas = hit?.canvas && hit.canvas.width === region.w && hit.canvas.height === region.h ? hit.canvas : makeCanvas(region.w, region.h);
  const mctx = canvas.getContext('2d');
  if (!mctx) return null;
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.globalCompositeOperation = 'source-over';
  mctx.globalAlpha = 1;
  mctx.fillStyle = om.clip ? '#000000' : '#ffffff';
  mctx.fillRect(0, 0, region.w, region.h);
  const t = live ? IDENTITY : om.transform || IDENTITY;
  const vm = multiply([m.a, m.b, m.c, m.d, m.e - region.x, m.f - region.y], t);
  mctx.setTransform(vm[0], vm[1], vm[2], vm[3], vm[4], vm[5]);
  const view = live ? doc : maskView(doc, om);
  const root = live ? { ...live, maskEdit: undefined } : view.get(om.art.root);
  if (root) drawNode(mctx, view, root, { ...opts, viewRect: null, skip: null, leafFilter: null, overprint: false });
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  const img = mctx.getImageData?.(0, 0, region.w, region.h);
  if (!img?.data || img.data.length < region.w * region.h * 4) return null;
  luminanceToAlpha(img.data, om.invert);
  mctx.putImageData(img, 0, 0);
  maskCache.set(om, { key: live ? null : key, doc, canvas });
  return canvas;
}

/** In place: RGBA pixels -> black with alpha = luminance (or 1 - luminance). */
export function luminanceToAlpha(data, invert = false) {
  for (let i = 0; i < data.length; i += 4) {
    // The art was drawn over an opaque background, so alpha is already composited in.
    let l = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    if (invert) l = 1 - l;
    data[i] = data[i + 1] = data[i + 2] = 0;
    data[i + 3] = Math.round(l * 255);
  }
  return data;
}

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') return Object.assign(document.createElement('canvas'), { width: w, height: h });
  return new OffscreenCanvas(w, h);
}

function applyMask(layer, region, m, doc, node, opts) {
  const mask = maskCanvas(region, m, doc, node, opts);
  if (!mask) return;
  const ctx = layer.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0);
  ctx.restore();
}

// ---- transforms ----

function maskTransformPatch(node, m) {
  const om = node.opacityMask;
  if (!om || om.unlinked) return null;
  return { opacityMask: { ...om, transform: multiply(m, om.transform || IDENTITY) } };
}

// ---- SVG export ----

function svgMask(node, w, depth) {
  const om = node.opacityMask;
  if (!om || om.disabled) return undefined;
  const plain = { ...node };
  delete plain.opacityMask;
  const inner = w.node(plain, depth + 1);
  if (!inner) return '';
  // Art being edited in place is written from the document.
  const live = om.editing ? w.doc.get(om.editing) : null;
  const view = live ? w.doc : maskView(w.doc, om);
  const root = live ? { ...live, hidden: false, maskEdit: undefined } : view.get(om.art.root);
  const savedDoc = w.doc;
  const savedCull = w.cullRect;
  let art = '';
  try {
    w.doc = view;
    w.cullRect = null;
    art = root ? w.node(root, 4) : '';
  } finally {
    w.doc = savedDoc;
    w.cullRect = savedCull;
  }
  const t = multiply(multiply(translate(-w.ox, -w.oy), live ? IDENTITY : om.transform || IDENTITY), translate(w.ox, w.oy));
  const f = (v) => w.n(v);
  const tAttr = isIdentity(t) ? '' : ` transform="matrix(${t.map(f).join(' ')})"`;
  const bg = om.clip ? '#000' : '#fff';
  const invertFilter = om.invert ? w.def('fi', (id) => `${w.nl(2)}<filter id="${id}" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR type="table" tableValues="1 0"/><feFuncG type="table" tableValues="1 0"/><feFuncB type="table" tableValues="1 0"/></feComponentTransfer></filter>`) : null;
  const nl3 = w.nl(3);
  const content = `${nl3}<rect x="-100000" y="-100000" width="200000" height="200000" fill="${bg}"/>${tAttr ? `${nl3}<g${tAttr}>${art}${nl3}</g>` : art}`;
  const body = invertFilter ? `${nl3}<g filter="url(#${invertFilter})">${content}${nl3}</g>` : content;
  const id = w.def('om', (mid) => `${w.nl(2)}<mask id="${mid}" maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000" style="mask-type:luminance">${body}${w.nl(2)}</mask>`);
  return `${w.nl(depth)}<g mask="url(#${id})">${inner}${w.nl(depth)}</g>`;
}

/** Install the renderer, transform and export hooks (once per module). */
let installed = false;
export function installOpacityMasks() {
  if (installed) return;
  installed = true;
  drawHooks.opacityMask = applyMask;
  transformHooks.push(maskTransformPatch);
  svgExportHooks.element.unshift(svgMask);
  // Mask art being edited in place paints only through the mask (exports included).
  exportBakers.push({ key: 'maskEdit', test: (n) => Boolean(n.maskEdit), bake: (n) => ({ ...n, hidden: true }) });
  viewHooks.artOptions.push((editor, opts) => {
    const g = maskEditGroup(editor.doc);
    return g ? { ...opts, skip: new Set([...(opts.skip || []), g.id]) } : opts;
  });
  viewHooks.afterArt.push((ctx, editor, view) => {
    const g = maskEditGroup(editor.doc);
    if (!g) return;
    ctx.save();
    ctx.globalAlpha = 0.6;
    drawNode(ctx, editor.doc, { ...g, maskEdit: undefined }, { outline: true, outlineColor: '#7f7f7f', hairline: 1 / view.zoom, viewRect: null, scale: view.zoom });
    ctx.restore();
  });
}

// ---- operations ----

/** Selected objects that carry opacity masks (the object whose mask is being edited, while editing). */
export function maskedTargets(editor) {
  const owner = maskEditOwner(editor.doc);
  if (owner) return [owner];
  return editor
    .topSelection()
    .map((id) => editor.doc.get(id))
    .filter((n) => n && n.opacityMask);
}

/** Can the selection make an opacity mask (the topmost object masks the rest)? */
export function canMakeMask(editor) {
  if (!editor) return false;
  const top = editor.topSelection().map((id) => editor.doc.get(id)).filter((n) => n && n.type !== 'layer');
  return top.length >= 2;
}

/**
 * Make an opacity mask from the selection: the topmost object becomes the
 * mask of the others (grouped first when there are several). Returns the
 * masked object's id.
 */
export function makeOpacityMask(editor, { clip = true, invert = false } = {}) {
  const { doc } = editor;
  const ids = doc.sortByPaintOrder(editor.topSelection().filter((id) => doc.get(id)?.type !== 'layer'));
  if (ids.length < 2) return null;
  const maskId = ids[ids.length - 1];
  const rest = ids.slice(0, -1);
  let targetId = rest[0];
  doc.transact('Make Opacity Mask', () => {
    if (rest.length > 1) {
      // The others are grouped where the topmost of them was.
      const top = doc.get(rest[rest.length - 1]);
      const parent = doc.get(top.parent);
      const g = createGroup([]);
      doc.insert(g, parent.id, parent.children.indexOf(top.id) + 1);
      for (const id of rest) doc.move(id, g.id);
      targetId = g.id;
    }
    const art = structuredClone(doc.exportSubtree(maskId));
    doc.remove(maskId);
    const om = { art, transform: [...IDENTITY], clip: Boolean(clip), invert: Boolean(invert) };
    doc.update(targetId, { opacityMask: om });
  });
  editor.select([targetId]);
  return targetId;
}

/** Release opacity masks: the art goes back into the document just above each object. */
export function releaseOpacityMask(editor) {
  const { doc } = editor;
  const targets = maskedTargets(editor);
  if (!targets.length) return [];
  const out = [];
  doc.transact('Release Opacity Mask', () => {
    for (const n of targets) {
      const om = n.opacityMask;
      const parent = doc.get(n.parent);
      const root = doc.importSubtree(structuredClone(om.art), parent.id, parent.children.indexOf(n.id) + 1);
      if (!isIdentity(om.transform)) transformNodes(doc, [root.id], om.transform);
      doc.update(n.id, { opacityMask: undefined });
      out.push(n.id, root.id);
    }
  });
  editor.select(out);
  return out;
}

/** Set a flag (clip, invert, disabled, unlinked) on the selected objects' masks. */
export function setMaskFlag(editor, key, value, label) {
  const targets = maskedTargets(editor);
  if (!targets.length) return;
  editor.doc.transact(label, () => {
    for (const n of targets) {
      const om = { ...n.opacityMask };
      if (value) om[key] = true;
      else delete om[key];
      editor.doc.update(n.id, { opacityMask: om });
    }
  });
}

/** Common value of a mask flag across the selection: true, false or 'mixed' (null without masks). */
export function maskFlag(editor, key) {
  const t = maskedTargets(editor);
  if (!t.length) return null;
  const v = t.map((n) => Boolean(n.opacityMask[key]));
  return v.every(Boolean) ? true : v.some(Boolean) ? 'mixed' : false;
}

// ---- editing the mask in place ----

const editGroups = new WeakMap();

/** The group holding mask art being edited, or null (looked up once per document change). */
export function maskEditGroup(doc) {
  const v = doc.nodes.version;
  const hit = editGroups.get(doc);
  if (hit && v !== undefined && hit.v === v) return hit.g && doc.get(hit.g.id);
  let g = null;
  for (const n of doc.nodes.values()) {
    if (n.maskEdit && n.type === 'group') {
      g = n;
      break;
    }
  }
  editGroups.set(doc, { v, g });
  return g;
}

/** The object whose mask is being edited, or null. */
export function maskEditOwner(doc) {
  const g = maskEditGroup(doc);
  const owner = g ? doc.get(g.maskEdit.owner) : null;
  return owner && owner.opacityMask?.editing === g.id ? owner : null;
}

/**
 * Edit an object's mask art in place (see the module comment). Returns the
 * editing group's id, or null.
 */
export function enterMaskEditing(editor, id = null) {
  const { doc } = editor;
  if (maskEditGroup(doc)) return null;
  const owner = doc.get(id || maskedTargets(editor)[0]?.id);
  const om = owner?.opacityMask;
  if (!om || !owner.parent) return null;
  let gid = null;
  doc.transact('Edit Opacity Mask', () => {
    const parent = doc.get(owner.parent);
    const g = createGroup([], { name: '<Opacity Mask>', maskEdit: { owner: owner.id } });
    doc.insert(g, parent.id, parent.children.indexOf(owner.id) + 1);
    gid = g.id;
    const root = doc.importSubtree(structuredClone(om.art), gid);
    if (!isIdentity(om.transform)) transformNodes(doc, [root.id], om.transform);
    doc.update(owner.id, { opacityMask: { ...om, editing: gid } });
  });
  editor.isolation = gid;
  editor.clearSelection();
  editor.emit('isolation');
  editor.invalidate?.();
  return gid;
}

/** Store the edited art back into the mask and leave mask editing. Returns the object's id. */
export function exitMaskEditing(editor) {
  const { doc } = editor;
  const g = maskEditGroup(doc);
  const ownerId = g?.maskEdit.owner;
  if (g) {
    doc.transact('Done Editing Opacity Mask', () => {
      const owner = doc.get(ownerId);
      if (owner?.opacityMask) {
        const kids = g.children.filter((c) => doc.has(c));
        let art;
        if (kids.length === 1) art = structuredClone(doc.exportSubtree(kids[0]));
        else {
          const sub = structuredClone(doc.exportSubtree(g.id));
          const root = sub.nodes[0];
          delete root.maskEdit;
          delete root.parent;
          root.name = '';
          art = sub;
        }
        const { editing, ...om } = owner.opacityMask;
        doc.update(owner.id, { opacityMask: { ...om, art, transform: [...IDENTITY] } });
      }
      doc.remove(g.id);
    });
  }
  if (editor.isolation === g?.id || (editor.isolation && !doc.has(editor.isolation))) editor.isolation = null;
  editor.select(ownerId && doc.has(ownerId) ? [ownerId] : []);
  editor.emit('isolation');
  editor.invalidate?.();
  return ownerId || null;
}

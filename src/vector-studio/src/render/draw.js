/**
 * Artwork rasterization with Canvas 2D.
 *
 * Canvas 2D (Skia on Chromium, Core Graphics on Safari, GPU-backed where the
 * browser can) gives analytic anti-aliasing, exact curve rendering, dashes,
 * joins, gradients and blend modes, which is what vector artwork needs. The
 * work kept off the per-frame path is geometry: Path2D objects and gradient
 * objects are cached per immutable node (WeakMap), offscreen nodes are culled
 * by their visual bounds, and the editor composites cached bitmaps while
 * panning and zooming large documents (see viewport-cache.js).
 *
 * drawArtwork() is shared by the screen renderer and raster export, so what
 * you see is what PNG/JPEG export produces.
 */
import { segmentCount, segmentPoints, isLine } from '../model/bezier.js';
import { gradientGeometry, localGradientGeometry, nodeBounds, visualBounds, rectsIntersect } from '../model/geometry.js';
import { layoutText, cssFont, glyphPlacements, extraPlacements, drawsAsSegments, riseOf, textHooks } from '../model/text-layout.js';
import { expandStops, focalPoint } from '../model/gradients.js';
import { multiply } from '../lib/matrix.js';
import { geomEffectsOf, effectiveSubpaths, paintParts } from '../model/geom-effects.js';
import { liveDef, liveArtwork } from '../model/live.js';
import '../model/live-effects.js';
import { rasterEffects, compositeWithEffects, regionPool, deviceRegion, effectsMargin } from './effects.js';

const pathCache = new WeakMap();
const compoundCache = new WeakMap();

/** Append an anchor list to a Path2D (or any object with the canvas path API). */
export function tracePath(p, anchors, closed) {
  if (!anchors.length) return p;
  p.moveTo(anchors[0].x, anchors[0].y);
  const n = segmentCount(anchors, closed);
  for (let i = 0; i < n; i++) {
    const c = segmentPoints(anchors, i);
    if (isLine(c)) p.lineTo(c[6], c[7]);
    else p.bezierCurveTo(c[2], c[3], c[4], c[5], c[6], c[7]);
  }
  if (closed) p.closePath();
  return p;
}

export function pathOf(node) {
  let p = pathCache.get(node);
  if (!p) {
    p = tracePath(new Path2D(), node.anchors, node.closed);
    pathCache.set(node, p);
  }
  return p;
}

/** Path2D for a compound path (cached on the compound node + its children). */
export function compoundPathOf(doc, node) {
  const kids = node.children.map((c) => doc.get(c)).filter(Boolean);
  const hit = compoundCache.get(node);
  if (hit && hit.kids.length === kids.length && hit.kids.every((k, i) => k === kids[i])) return hit.path;
  const p = new Path2D();
  for (const k of kids) tracePath(p, k.anchors, k.closed);
  compoundCache.set(node, { kids, path: p });
  return p;
}

/** Path2D for any shape-like node (path, compound), or null. */
export function shapePathOf(doc, node) {
  if (node.type === 'path') return pathOf(node);
  if (node.type === 'compound') return compoundPathOf(doc, node);
  return null;
}

function hexA(hex, a) {
  if (a >= 1) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * A canvas fill/stroke style for a paint on a node, or null for None. Type
 * is drawn inside its transform (and each run inside its own placement
 * `seg`, relative to the text), so its gradients are built in that space.
 */
export function paintStyle(ctx, doc, node, paint, seg = null) {
  if (!paint) return null;
  if (paint.type === 'solid') return paint.opacity != null && paint.opacity < 1 ? hexA(paint.color, paint.opacity) : paint.color;
  if (paint.type === 'linear' || paint.type === 'radial') {
    const b = nodeBounds(doc, node) || { x: 0, y: 0, w: 1, h: 1 };
    let g = gradientGeometry(paint, b);
    if (node.type === 'text') g = localGradientGeometry(g, seg ? multiply(node.transform, seg) : node.transform);
    let grad;
    if (paint.type === 'linear') grad = ctx.createLinearGradient(g.x1, g.y1, g.x2, g.y2);
    else {
      const f = focalPoint(paint, g, 1);
      grad = ctx.createRadialGradient(g.x1 + f.x, g.y1 + f.y, f.r, g.x1, g.y1, Math.max(g.r, 0.0001));
    }
    addStops(grad, paint.stops);
    return grad;
  }
  return drawHooks.paintStyle ? drawHooks.paintStyle(ctx, doc, node, paint, seg) : null;
}


function addStops(grad, stops) {
  for (const s of expandStops(stops)) grad.addColorStop(s.offset, hexA(s.color, s.opacity ?? 1));
}

/** True for a radial gradient squashed by its aspect ratio (needs an elliptical fill). */
function isElliptical(paint) {
  return paint && paint.type === 'radial' && paint.aspect != null && Math.abs(paint.aspect - 1) > 1e-3 && paint.aspect > 0;
}

/**
 * Fill a path with a paint. Elliptical radial gradients (aspect ratio) are
 * drawn by clipping to the path and filling in the gradient's own scaled
 * frame, since canvas radial gradients are circular.
 */
function fillPath(ctx, doc, node, paint, path, fillRule) {
  if (isElliptical(paint)) {
    const b = nodeBounds(doc, node) || { x: 0, y: 0, w: 1, h: 1 };
    const g = gradientGeometry(paint, b);
    const ang = paint.x1 !== undefined ? Math.atan2(g.y2 - g.y1, g.x2 - g.x1) : (-(paint.angle || 0) * Math.PI) / 180;
    const reach = (Math.hypot(b.w, b.h) + Math.hypot(g.x1 - (b.x + b.w / 2), g.y1 - (b.y + b.h / 2))) / Math.min(1, paint.aspect) + 1;
    ctx.save();
    ctx.clip(path, fillRule);
    ctx.translate(g.x1, g.y1);
    ctx.rotate(ang);
    ctx.scale(1, paint.aspect);
    // In the gradient's own frame (major axis along x, minor axis scaled by aspect).
    const fr = Math.max(0, (paint.focalRadius || 0) * g.r);
    const [fu, fv] = paint.focal || [0, 0];
    const grad = ctx.createRadialGradient(fu * g.r, fv * g.r, fr, 0, 0, Math.max(g.r, 0.0001));
    addStops(grad, paint.stops);
    ctx.fillStyle = grad;
    ctx.fillRect(-reach, -reach / paint.aspect, reach * 2, (reach * 2) / paint.aspect);
    ctx.restore();
    return;
  }
  const fill = paintStyle(ctx, doc, node, paint);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill(path, fillRule);
  }
}

const BLEND = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  colorDodge: 'color-dodge',
  colorBurn: 'color-burn',
  hardLight: 'hard-light',
  softLight: 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

export const BLEND_MODES = Object.keys(BLEND);

function setStrokeProps(ctx, node, widthScale = 1) {
  ctx.lineWidth = (node.strokeWidth || 0) * widthScale;
  ctx.lineCap = node.strokeCap || 'butt';
  ctx.lineJoin = node.strokeJoin || 'miter';
  ctx.miterLimit = node.miterLimit || 10;
  const custom = drawHooks.dashPattern ? drawHooks.dashPattern(node, widthScale) : null;
  const dash = custom ? custom.dash : node.dash && node.dash.length ? node.dash : null;
  ctx.setLineDash(dash || []);
  ctx.lineDashOffset = custom ? custom.offset : node.dashOffset || 0;
}

/** Stroke with alignment: center, inside (clip to the shape) or outside (clip to its complement). */
function strokeAligned(ctx, path, node, fillRule) {
  const align = node.strokeAlign || 'center';
  if (align === 'center' || (node.type === 'path' && !node.closed)) {
    setStrokeProps(ctx, node);
    ctx.stroke(path);
    return;
  }
  ctx.save();
  if (align === 'inside') ctx.clip(path, fillRule);
  else {
    const outside = new Path2D();
    outside.rect(-1e7, -1e7, 2e7, 2e7);
    outside.addPath(path);
    ctx.clip(outside, 'evenodd');
  }
  setStrokeProps(ctx, node, 2);
  ctx.stroke(path);
  ctx.restore();
}

function arrowPaths(node) {
  // Arrowheads are drawn by the Stroke panel feature module when present.
  return drawHooks.arrowheads ? drawHooks.arrowheads(node) : null;
}

/**
 * Extension points for feature modules:
 *   arrowheads(node)          -> [Path2D] filled with the stroke paint (document space)
 *   strokePath(node, path)    -> Path2D to stroke instead of `path` (e.g. trimmed for arrowheads)
 *   dashPattern(node, scale)  -> { dash, offset } replacing node.dash (e.g. aligned to corners)
 *   paintStyle(ctx, doc, node, paint, seg) -> canvas style for paint types beyond solid
 *                             and gradients (pattern swatches); `seg` as in paintStyle()
 *   opacityMask(layer, region, m, doc, node, opts)
 *                             apply node.opacityMask to the object's artwork, drawn in
 *                             `layer` ({ canvas, ctx }) covering device `region` under
 *                             view transform `m`
 *
 * Live artwork (blends, repeats, symbol instances, ...) draws through
 * model/live.js and geometry effects through model/geom-effects.js.
 */
export const drawHooks = { arrowheads: null, strokePath: null, dashPattern: null, paintStyle: null, opacityMask: null };

const effectPathCache = new WeakMap();

/**
 * The path a shape renders with: its own geometry, or the geometry after
 * its live geometry effects (Round Corners, Roughen, Warp, ...), cached per
 * node object.
 */
export function renderPathOf(doc, node) {
  if ((node.type !== 'path' && node.type !== 'compound') || !geomEffectsOf(node)) return shapePathOf(doc, node);
  const subs = effectiveSubpaths(doc, node);
  const hit = effectPathCache.get(node);
  if (hit && hit.subs === subs) return hit.path;
  const p = new Path2D();
  for (const s of subs) tracePath(p, s.anchors, s.closed);
  effectPathCache.set(node, { subs, path: p });
  return p;
}

/** Draw a live object's generated artwork in paint order. */
function drawLive(ctx, doc, node, opts) {
  // Generated artwork draws with its live object in one interaction slice.
  if (opts.leafFilter) {
    if (!opts.leafFilter(node.id)) return;
    opts = { ...opts, leafFilter: null };
  }
  const def = liveDef(node);
  if (def?.draw) {
    def.draw(ctx, doc, node, opts);
    return;
  }
  const { items, vdoc } = liveArtwork(doc, node);
  for (const n of items) drawNode(ctx, vdoc, n, opts);
}

const partsCache = new WeakMap();

/**
 * A shape whose geometry effects paint some outlines differently (Scribble
 * hatching in the fill paint, Crop Marks): [{ node, path }] per paint, in
 * paint order, or null.
 */
function paintedParts(doc, node) {
  if (!geomEffectsOf(node)) return null;
  const subs = effectiveSubpaths(doc, node);
  const hit = partsCache.get(node);
  if (hit && hit.subs === subs) return hit.parts;
  const parts = paintParts(node, subs)?.map((p) => ({
    node: { ...node, ...p.style },
    path: p.subpaths.reduce((path, s) => tracePath(path, s.anchors, s.closed), new Path2D()),
  }));
  partsCache.set(node, { subs, parts: parts || null });
  return parts || null;
}

function drawShape(ctx, doc, node, opts) {
  const path = opts.outline ? shapePathOf(doc, node) : renderPathOf(doc, node);
  if (!path) return;
  const fillRule = node.fillRule || 'nonzero';
  if (opts.outline) {
    ctx.strokeStyle = opts.outlineColor || '#000';
    ctx.lineWidth = opts.hairline;
    ctx.setLineDash([]);
    ctx.stroke(path);
    return;
  }
  const parts = paintedParts(doc, node);
  if (parts) {
    for (const p of parts) paintShape(ctx, doc, p.node, p.path, fillRule, false);
    return;
  }
  paintShape(ctx, doc, node, path, fillRule, true);
}

function paintShape(ctx, doc, node, path, fillRule, decorations) {
  if (node.fill) fillPath(ctx, doc, node, node.fill, path, fillRule);
  const stroke = node.strokeWidth > 0 ? paintStyle(ctx, doc, node, node.stroke) : null;
  if (stroke) {
    ctx.strokeStyle = stroke;
    const sp = decorations && drawHooks.strokePath ? drawHooks.strokePath(node, path) || path : path;
    strokeAligned(ctx, sp, node, fillRule);
    const arrows = decorations ? arrowPaths(node) : null;
    if (arrows) {
      ctx.setLineDash([]);
      ctx.fillStyle = stroke;
      for (const a of arrows) ctx.fill(a);
    }
  }
}

/**
 * Canvas style for a text paint. Gradients span the whole text object: the
 * canvas reads gradient coordinates in the space current at fill time, so
 * a run drawn under its placement `seg` gets a gradient built for it.
 */
function textPaint(ctx, doc, node, paint, cache, seg = null) {
  if (!paint) return null;
  if (paint.type === 'solid') return paintStyle(ctx, doc, node, paint);
  const key = seg ? null : paint;
  let v = key ? cache.get(key) : undefined;
  if (v === undefined) {
    v = paintStyle(ctx, doc, node, paint, seg);
    if (key) cache.set(key, v);
  }
  return v;
}

function decorate(ctx, st, size, x0, x1, base) {
  const t = Math.max(st.fontSize / 18, 0.25);
  if (st.underline) ctx.fillRect(x0, base + st.fontSize * 0.12, x1 - x0, t);
  if (st.strike) ctx.fillRect(x0, base - size * 0.3, x1 - x0, t);
}

/**
 * Draw a text node from its layout. Horizontal type draws runs of
 * same-styled characters with one fillText each (keeping the browser's
 * kerning and ligatures, positioned from the layout); vertical type, type on
 * a path and rotated characters draw glyph by glyph from glyphPlacements().
 */
function drawText(ctx, doc, node, opts) {
  const lay = layoutText(node);
  ctx.save();
  const m = node.transform;
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const hasLS = 'letterSpacing' in ctx;
  const cache = new Map();
  const outline = opts.outline;
  const fillOf = (st, seg) => (outline ? opts.outlineColor || '#000' : textPaint(ctx, doc, node, st.fill, cache, seg));
  const strokeOf = (st, seg) => (outline || !(st.strokeWidth > 0) ? null : textPaint(ctx, doc, node, st.stroke, cache, seg));
  const paintText = (st, str, x, y, seg) => {
    const f = fillOf(st, seg);
    if (f) {
      ctx.fillStyle = f;
      ctx.fillText(str, x, y);
    }
    const s = strokeOf(st, seg);
    if (s) {
      ctx.strokeStyle = s;
      setStrokeProps(ctx, { ...node, strokeWidth: st.strokeWidth, dash: node.dash });
      ctx.lineJoin = node.strokeJoin || 'miter';
      ctx.strokeText(str, x, y);
    }
  };
  const paintGlyph = (st, path, seg) => {
    const f = fillOf(st, seg);
    if (f) {
      ctx.fillStyle = f;
      ctx.fill(path);
    }
    const s = strokeOf(st, seg);
    if (s) {
      ctx.strokeStyle = s;
      setStrokeProps(ctx, { ...node, strokeWidth: st.strokeWidth, dash: node.dash });
      ctx.lineJoin = node.strokeJoin || 'miter';
      ctx.stroke(path);
    }
  };
  if (outline && node.kind === 'area' && node.areaPath?.length > 2) {
    ctx.strokeStyle = opts.outlineColor || '#000';
    ctx.lineWidth = opts.hairline / Math.max(1e-6, Math.hypot(m[0], m[1]));
    ctx.stroke(tracePath(new Path2D(), node.areaPath, true));
  }
  const needsLS = !hasLS && lay.chars.sty.some((st) => st && st.tracking);
  if (drawsAsSegments(lay) && !needsLS) {
    const { chars, text } = lay;
    for (const line of lay.lines) {
      let i = line.start;
      const end = line.contentEnd;
      while (i < end) {
        const st = chars.sty[i];
        const size = chars.size[i];
        let j = i + 1;
        const breakAfterSpace = line.justified;
        if (!(breakAfterSpace && text[i] === ' ') && text[i] !== '\t') {
          while (j < end && chars.sty[j] === st && chars.size[j] === size && !chars.manual[j] && text[j] !== '\t' && !(breakAfterSpace && (text[j] === ' ' || text[j - 1] === ' '))) j++;
        }
        const str = text[i] === '\t' ? '' : chars.disp.slice(i, j).join('');
        if (str.trim()) {
          const hs = (st.horizontalScale ?? 100) / 100;
          const vs = (st.verticalScale ?? 100) / 100;
          const track = ((st.tracking || 0) / 1000) * st.fontSize;
          const x = line.xs[i - line.start];
          const y = line.y - riseOf(st);
          ctx.save();
          ctx.translate(x, y);
          if (hs !== 1 || vs !== 1) ctx.scale(hs, vs);
          ctx.font = cssFont(st, size);
          if (hasLS) ctx.letterSpacing = `${track / hs}px`;
          paintText(st, str, 0, 0, [hs, 0, 0, vs, x, y]);
          ctx.restore();
        }
        if ((st.underline || st.strike) && !outline) {
          const f = fillOf(st);
          if (f) {
            ctx.fillStyle = f;
            const x1 = j >= end ? line.xs[end - line.start] - ((st.tracking || 0) / 1000) * st.fontSize : line.xs[j - line.start];
            decorate(ctx, st, size, line.xs[i - line.start], x1, line.y - riseOf(st));
          }
        }
        i = j;
      }
    }
    // List markers, tab leaders and discretionary hyphens.
    const extras = extraPlacements(lay);
    if (extras.length) {
      if (hasLS) ctx.letterSpacing = '0px';
      for (const g of extras) {
        ctx.save();
        ctx.transform(g.m[0], g.m[1], g.m[2], g.m[3], g.m[4], g.m[5]);
        ctx.font = cssFont(g.style, g.size);
        paintText(g.style, g.ch, 0, 0, g.m);
        ctx.restore();
      }
    }
  } else {
    if (hasLS) ctx.letterSpacing = '0px';
    for (const g of glyphPlacements(lay)) {
      ctx.save();
      const gm = g.m;
      ctx.transform(gm[0], gm[1], gm[2], gm[3], gm[4], gm[5]);
      ctx.font = cssFont(g.style, g.size);
      // Shaped glyphs (OpenType substitutions) draw from the font's outlines.
      const gp = g.glyph != null ? textHooks.glyphPath?.(g.style, g.glyph, g.size) : null;
      if (gp) paintGlyph(g.style, gp, gm);
      else paintText(g.style, g.ch, 0, 0, gm);
      if ((g.style.underline || g.style.strike) && !outline && !lay.vertical) {
        const f = fillOf(g.style, gm);
        if (f) {
          ctx.fillStyle = f;
          decorate(ctx, g.style, g.size, 0, g.w, 0);
        }
      }
      ctx.restore();
    }
  }
  ctx.restore();
}

/** Decoded images by asset id. Images decode asynchronously; `onReady` triggers a redraw. */
const imageCache = new Map();
export const imageEvents = { onReady: null };

export function imageFor(doc, assetId) {
  const asset = doc.assets.get(assetId);
  if (!asset) return null;
  let entry = imageCache.get(asset);
  if (!entry) {
    entry = { img: null };
    imageCache.set(asset, entry);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      entry.img = img;
      imageEvents.onReady?.();
    };
    img.src = asset.data;
  }
  return entry.img;
}

function drawImage(ctx, doc, node, opts) {
  ctx.save();
  const m = node.transform;
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  if (opts.outline && !opts.imagesInOutline) {
    ctx.strokeStyle = opts.outlineColor || '#000';
    ctx.lineWidth = opts.hairline;
    ctx.strokeRect(0, 0, node.width, node.height);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(node.width, node.height);
    ctx.moveTo(node.width, 0);
    ctx.lineTo(0, node.height);
    ctx.stroke();
  } else {
    const img = imageFor(doc, node.asset);
    if (img) {
      if (opts.dimImages > 0) ctx.globalAlpha *= 1 - Math.min(100, opts.dimImages) / 100;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, node.width, node.height);
    }
  }
  ctx.restore();
}

/**
 * Draw one node. `opts`:
 *   viewRect   document-space rect to cull against (null = no culling)
 *   outline    outline (wireframe) mode
 *   hairline   outline stroke width in document units (1 device px)
 *   scale      device pixels per document unit (for shadows and blurs)
 *   skip       Set of ids not to draw (e.g. text being edited)
 *   leafFilter (id) => bool deciding which leaves draw (interaction slices)
 *   overprint  Overprint Preview: objects with overprintFill/overprintStroke multiply
 */
export function drawNode(ctx, doc, node, opts) {
  if (!node || node.hidden) return;
  if (opts.skip && opts.skip.has(node.id)) return;
  // Leaves include leaf live objects (meshes, flares): they draw as one unit.
  if (opts.leafFilter && (node.type === 'compound' || !node.children) && !opts.leafFilter(node.id)) return;
  if (opts.viewRect) {
    const vb = visualBounds(doc, node);
    if (!vb || !rectsIntersect(vb, opts.viewRect)) return;
  }
  const opacity = node.opacity ?? 1;
  let blend = BLEND[node.blendMode] || 'source-over';
  // Overprint Preview: inks set to overprint mix with what is below instead of knocking it out.
  if (opts.overprint && blend === 'source-over' && (node.overprintFill || node.overprintStroke)) blend = 'multiply';
  const fx = opts.outline ? null : rasterEffects(node);
  const container = node.type === 'group' || node.type === 'layer';
  // Leaf live objects (symbol instances, brush strokes, effected type) are several shapes too: they isolate like groups.
  const grouped = container || (node.type !== 'image' && Boolean(liveDef(node)));
  // An opacity mask (drawHooks.opacityMask) needs the object's finished artwork in a layer.
  const om = !opts.outline && node.opacityMask && !node.opacityMask.disabled && drawHooks.opacityMask ? node.opacityMask : null;
  const isolated = !opts.outline && ((grouped && (opacity < 1 || blend !== 'source-over' || fx || node.isolate || node.knockout)) || Boolean(om));

  if (fx || isolated) {
    // Groups with opacity, blending, isolation or effects, and any object
    // with raster effects, render into a layer first: children do not show
    // through each other and effects see the finished artwork.
    const region = deviceRegion(ctx, visualBounds(doc, node), fx ? effectsMargin(fx, opts.scale || 1) : undefined);
    if (!region) return;
    const pool = regionPool;
    const layer = pool.acquire(region.w, region.h);
    const lctx = layer.ctx;
    const m = ctx.getTransform();
    lctx.setTransform(m.a, m.b, m.c, m.d, m.e - region.x, m.f - region.y);
    if (container) {
      if (node.knockout && !opts.outline) drawKnockout(lctx, doc, node, opts, pool);
      else drawChildren(lctx, doc, node, opts);
    } else drawContent(lctx, doc, node, opts);
    if (om) drawHooks.opacityMask(layer, region, m, doc, node, opts);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha *= opacity;
    ctx.globalCompositeOperation = blend;
    compositeWithEffects(ctx, layer, fx, opts.scale || 1, pool, region.x, region.y, fx && { transform: m, doc, node });
    ctx.restore();
    pool.release(layer);
    return;
  }

  ctx.save();
  if (!opts.outline) {
    if (opacity < 1) ctx.globalAlpha *= opacity;
    if (blend !== 'source-over') ctx.globalCompositeOperation = blend;
  }
  drawContent(ctx, doc, node, opts);
  ctx.restore();
}

function drawContent(ctx, doc, node, opts) {
  switch (node.type) {
    case 'path':
    case 'compound':
      // Live paths (brush strokes, variable widths) draw their artwork; outline mode shows the path.
      if (!opts.outline && liveDef(node)) drawLive(ctx, doc, node, opts);
      else drawShape(ctx, doc, node, opts);
      break;
    case 'text':
      // Type with geometry effects (Warp, ...) draws as its effected outlines.
      if (!opts.outline && liveDef(node)) drawLive(ctx, doc, node, opts);
      else drawText(ctx, doc, node, opts);
      break;
    case 'image':
      drawImage(ctx, doc, node, opts);
      break;
    case 'group':
    case 'layer':
      drawChildren(ctx, doc, node, opts);
      break;
    default:
      // A leaf live object passed the leaf filter as a whole; its generated parts are not filtered again.
      if (liveDef(node)) drawLive(ctx, doc, node, opts.leafFilter ? { ...opts, leafFilter: null } : opts);
      break;
  }
}

/**
 * Knockout group: each child replaces what earlier children drew instead
 * of compositing over it. The child's whole shape knocks out; with
 * `knockoutShape` its opacity and opacity mask set how much.
 */
function drawKnockout(ctx, doc, node, opts, pool) {
  const m = ctx.getTransform();
  for (const c of node.children) {
    const child = doc.get(c);
    if (!child || child.hidden) continue;
    const tmp = pool.acquire(ctx.canvas.width, ctx.canvas.height);
    tmp.ctx.setTransform(m);
    drawNode(tmp.ctx, doc, child, opts);
    const partial = !child.knockoutShape && ((child.opacity ?? 1) < 1 || (child.opacityMask && !child.opacityMask.disabled));
    const cut = partial ? pool.acquire(ctx.canvas.width, ctx.canvas.height) : tmp;
    if (partial) {
      cut.ctx.setTransform(m);
      drawNode(cut.ctx, doc, { ...child, opacity: 1, opacityMask: undefined }, opts);
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(cut.canvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(tmp.canvas, 0, 0);
    ctx.restore();
    if (partial) pool.release(cut);
    pool.release(tmp);
  }
}

function drawChildren(ctx, doc, node, opts) {
  if (node.type === 'group' && liveDef(node)) {
    drawLive(ctx, doc, node, opts);
    return;
  }
  const kids = node.children;
  if (node.type === 'group' && node.clip && kids.length) {
    const mask = doc.get(kids[kids.length - 1]);
    if (mask && !opts.outline && maskHasText(doc, mask)) {
      drawTextMasked(ctx, doc, kids, mask, opts);
      return;
    }
    const clipPath = mask ? clipPathOf(doc, mask) : null;
    ctx.save();
    if (clipPath) {
      if (opts.outline) drawNode(ctx, doc, mask, opts);
      ctx.clip(clipPath, mask.fillRule || 'nonzero');
    }
    for (let i = 0; i < kids.length - 1; i++) drawNode(ctx, doc, doc.get(kids[i]), opts);
    ctx.restore();
    // A clipping path can carry its own stroke (drawn on top).
    if (mask && !opts.outline && mask.stroke && mask.strokeWidth > 0 && (mask.type === 'path' || mask.type === 'compound')) {
      ctx.save();
      ctx.strokeStyle = paintStyle(ctx, doc, mask, mask.stroke);
      strokeAligned(ctx, shapePathOf(doc, mask), mask, 'nonzero');
      ctx.restore();
    }
    return;
  }
  for (const c of kids) drawNode(ctx, doc, doc.get(c), opts);
}

function maskHasText(doc, n) {
  if (!n) return false;
  if (n.type === 'text') return true;
  return n.type === 'group' && n.children.some((c) => maskHasText(doc, doc.get(c)));
}

/** Paint a mask's shape opaque: filled paths and type glyphs (groups combine their parts). */
function fillMask(ctx, doc, n, opts) {
  if (!n) return;
  if (n.type === 'path' || n.type === 'compound') {
    ctx.fillStyle = '#000';
    ctx.fill(shapePathOf(doc, n), n.fillRule || 'nonzero');
  } else if (n.type === 'text') drawText(ctx, doc, n, { ...opts, outline: true, outlineColor: '#000', hairline: 0 });
  else if (n.type === 'group') for (const c of n.children) fillMask(ctx, doc, doc.get(c), opts);
}

/**
 * Clip group whose clipping path is (or contains) type: the content is
 * drawn into a layer and kept only where the glyphs are, since a canvas
 * clip path cannot be made from text.
 */
function drawTextMasked(ctx, doc, kids, mask, opts) {
  const region = deviceRegion(ctx, nodeBounds(doc, mask));
  if (!region) return;
  const layer = regionPool.acquire(region.w, region.h);
  const lctx = layer.ctx;
  const m = ctx.getTransform();
  lctx.setTransform(m.a, m.b, m.c, m.d, m.e - region.x, m.f - region.y);
  for (let i = 0; i < kids.length - 1; i++) drawNode(lctx, doc, doc.get(kids[i]), opts);
  lctx.globalCompositeOperation = 'destination-in';
  fillMask(lctx, doc, mask, opts);
  lctx.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(layer.canvas, region.x, region.y);
  ctx.restore();
  regionPool.release(layer);
}

/** Clip region for a mask node (path, compound, or text as its glyph boxes). */
function clipPathOf(doc, node) {
  if (node.type === 'path' || node.type === 'compound') return shapePathOf(doc, node);
  if (node.type === 'group') {
    const p = new Path2D();
    for (const c of node.children) {
      const cp = clipPathOf(doc, doc.get(c));
      if (cp) p.addPath(cp);
    }
    return p;
  }
  const b = nodeBounds(doc, node);
  if (!b) return null;
  const p = new Path2D();
  p.rect(b.x, b.y, b.w, b.h);
  return p;
}

/** Draw every layer of a document. */
export function drawArtwork(ctx, doc, opts) {
  for (const id of doc.root.children) {
    const layer = doc.get(id);
    if (!layer || layer.hidden) continue;
    if (opts.layerFilter && !opts.layerFilter(layer)) continue;
    const layerOpts = layer.outline && !opts.outline ? { ...opts, outline: true } : opts;
    // Layer Options > Dim Images (on by default for template layers): on screen (opts.dimLayers), images draw faded.
    const dim = opts.dimLayers ? (layer.dimImages ?? (layer.template ? 50 : 0)) : 0;
    drawNode(ctx, doc, layer, dim > 0 ? { ...layerOpts, dimImages: dim } : layerOpts);
  }
}

/** Pool of full-viewport offscreen canvases for isolated group rendering. */
export class LayerPool {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.free = [];
  }

  resize(width, height) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.free = [];
  }

  acquire() {
    const layer = this.free.pop();
    if (layer) {
      layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
      layer.ctx.clearRect(0, 0, this.width, this.height);
      return layer;
    }
    const canvas = typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: this.width, height: this.height }) : new OffscreenCanvas(this.width, this.height);
    return { canvas, ctx: canvas.getContext('2d') };
  }

  release(layer) {
    if (this.free.length < 4) this.free.push(layer);
  }
}

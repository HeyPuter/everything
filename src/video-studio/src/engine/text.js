/**
 * Text and sticker rasterization with Canvas 2D. The result is uploaded as a
 * texture by the compositor; entries are cached by content so a static title
 * is drawn once, not every frame. The live player and the exporter both draw
 * text through this file, so preview and export match.
 *
 * Text is drawn in layers, back to front: bubble, background box, drop
 * shadow, depth (repeated offset), glow, color-split fringes, outer outline,
 * outline, fill (solid, gradient or two-tone) and underline. Plain text draws
 * a whole line per call; curved text and letter or word animations draw one
 * glyph per call with its own transform, opacity and blur.
 */
import { FONTS } from '../model/catalog.js';
import { drawSticker, STICKER_SIZE, isAnimatedSticker, stickerColor } from './stickers.js';
import { drawAvatar } from './avatars.js';
import { poseKey } from './avatar-motion.js';
import { caseOf, applyCase } from '../model/text-style.js';
import { wrapLines, lineGlyphs, indexGlyphs, arcLayout, placedBounds } from './text-layout.js';
import { glyphState, animKey, animMargin } from './text-anim.js';
import { bubbleGeometry, drawBubble, hasBubble } from './bubbles.js';
import { fontsVersion, onFontsChange } from './font-registry.js';

/** Animated graphics redraw at most this many times per second of clip time. */
export const STICKER_ANIM_FPS = 30;

const FONT_CSS = new Map(FONTS.map((f) => [f.id, f.css]));

export function fontString(style, size) {
  const css = FONT_CSS.get(style.font) || `'${style.font.replace(/'/g, '')}', sans-serif`;
  return `${style.italic ? 'italic ' : ''}${style.bold ? '700' : '400'} ${size}px ${css}`;
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Lines of text after case change and typewriter reveal. */
export function visibleLines(text, style, reveal = 1) {
  let s = applyCase(text, caseOf(style));
  if (reveal < 1) {
    const chars = [...s];
    s = chars.slice(0, Math.floor(chars.length * reveal)).join('');
  }
  return s.split('\n');
}

let probeCtx = null;
function probe() {
  probeCtx ||= makeCanvas(4, 4).getContext('2d');
  return probeCtx;
}

const setSpacing = (ctx, px) => {
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${px}px`;
};

// Glyph positions per (font, spacing, line); measuring letter by letter is the slow part.
const glyphCache = new Map();
function glyphsFor(line, font, spacing) {
  const key = `${font}|${spacing}|${line}`;
  let g = glyphCache.get(key);
  if (g) return g;
  const p = probe();
  p.font = font;
  g = lineGlyphs(line, (str) => {
    setSpacing(p, spacing);
    return p.measureText(str).width;
  }, (ch) => {
    setSpacing(p, 0);
    return p.measureText(ch).width;
  });
  if (glyphCache.size > 400) glyphCache.delete(glyphCache.keys().next().value);
  glyphCache.set(key, g);
  return g;
}

/**
 * Layout of a text clip at a raster scale: canvas size, content rectangle
 * and the runs to draw. opts: { reveal, anim: [{ id, phase, p }], color }.
 */
function layoutText(clip, scale, opts = {}) {
  const style = clip.style;
  const reveal = opts.reveal ?? 1;
  const anim = opts.anim?.length ? opts.anim : null;
  const size = style.size * scale;
  const font = fontString(style, size);
  const spacing = (style.letterSpacing || 0) * scale;
  const p = probe();
  p.font = font;
  setSpacing(p, spacing);
  const text = applyCase(clip.text, caseOf(style));
  const boxW = style.boxWidth > 0 ? style.boxWidth * scale : 0;
  const lines = wrapLines(text, boxW, (s) => p.measureText(s).width);
  // Size the box for the full text so typewriter reveal does not jump around.
  const widths = lines.map((l) => p.measureText(l || ' ').width);
  const lineH = size * style.lineHeight;
  const textW = Math.max(1, ...widths);
  const textH = lineH * lines.length;
  let contentW = Math.max(boxW, textW);
  let contentH = Math.max(textH, (style.boxHeight || 0) * scale);
  const offY = style.vAlign === 'top' ? 0 : style.vAlign === 'bottom' ? contentH - textH : (contentH - textH) / 2;
  const xFor = (i) => {
    if (style.align === 'left') return 0;
    if (style.align === 'right') return contentW - widths[i];
    return (contentW - widths[i]) / 2;
  };
  const arc = style.arc || 0;
  // Highlighted words (model/text-marks.js) are drawn glyph by glyph in the highlight color.
  const marks = clip.marks?.length ? new Set(clip.marks) : null;
  const perGlyph = Boolean(anim) || arc !== 0 || Boolean(marks);
  let revealCount = Infinity;
  if (reveal < 1) revealCount = Math.floor([...text.replace(/\n/g, '')].length * reveal);

  let runs;
  let totals = null;
  let shiftX = 0;
  let shiftY = 0;
  if (!perGlyph) {
    let left = revealCount;
    runs = lines.map((line, i) => {
      let t = line;
      if (left !== Infinity) {
        const chars = [...line];
        t = chars.slice(0, Math.max(0, left)).join('');
        left -= chars.length;
      }
      return { plain: true, text: t, x: xFor(i), y: offY + lineH * (i + 0.5), w: widths[i], alpha: 1 };
    });
  } else {
    const gl = lines.map((line, i) => {
      const x0 = xFor(i);
      const glyphs = glyphsFor(line, font, spacing).map((g) => ({ ...g, cx: x0 + g.x + g.w / 2 }));
      return { y: offY + lineH * (i + 0.5), x0, w: widths[i], glyphs };
    });
    totals = indexGlyphs(gl);
    // Curved text: place glyphs on circles, then make the bent block the content box.
    let placed = null;
    if (arc) {
      const rel = gl.map((l) => ({ y: l.y - contentH / 2, glyphs: l.glyphs.map((g) => ({ cx: g.cx - contentW / 2, w: g.w })) }));
      placed = arcLayout(rel, arc, textW, lineH).lines;
      const pts = [];
      placed.forEach((pl, li) => pl.forEach((q, gi) => pts.push({ x: q.x, y: q.y, rot: q.rot, hw: gl[li].glyphs[gi].adv / 2 + 1, hh: lineH / 2 })));
      const b = placedBounds(pts);
      contentW = Math.max(1, b.maxX - b.minX);
      contentH = Math.max(1, b.maxY - b.minY);
      shiftX = -b.minX;
      shiftY = -b.minY;
    }
    runs = [];
    let n = 0;
    gl.forEach((l, li) => {
      const lineCx = l.x0 + l.w / 2;
      l.glyphs.forEach((g, gi) => {
        if (n++ >= revealCount) return;
        const q = placed?.[li][gi];
        const run = {
          plain: false,
          text: g.ch,
          cx: q ? q.x + shiftX : g.cx,
          cy: q ? q.y + shiftY : l.y,
          rot: q ? q.rot : 0,
          scale: 1,
          alpha: 1,
          blur: 0,
          w: g.w,
          adv: g.adv,
          color: marks?.has(g.wi) ? style.highlightColor : null,
          space: /\s/.test(g.ch),
        };
        if (anim) {
          const st = glyphState(anim, { ch: g.ch, ci: g.ci, wi: g.wi, cx: g.cx, lineCx }, totals, { size, highlight: style.highlightColor });
          if (st) {
            run.cx += st.dx;
            run.cy += st.dy;
            run.rot += st.rot;
            run.scale = st.scale;
            run.alpha = st.alpha;
            run.blur = st.blur;
            if (st.color) run.color = st.color;
            if (st.ch) {
              run.text = st.ch;
              run.w = -1; // measured when drawn
            }
          }
        }
        runs.push(run);
      });
    });
  }

  // Room around the content for everything drawn outside the letters.
  const outline = ((style.strokeWidth || 0) + (style.stroke2Width || 0)) * scale;
  const shadowPad = style.shadowOpacity > 0 ? (style.shadowBlur + style.shadowDistance) * scale : 0;
  const glowPad = style.glowStrength > 0 ? style.glowRadius * scale * 1.3 : 0;
  const extrudePad = (style.extrudeDepth || 0) * scale;
  const glitchPad = (style.glitch || 0) * scale;
  const deco = outline + extrudePad + Math.max(shadowPad, glowPad, glitchPad) + size * 0.12 + (anim ? animMargin(anim) * size : 0);
  const bgPad = style.bgOpacity > 0 ? size * 0.3 : 0;
  let bub = null;
  if (hasBubble(style.bubble)) bub = bubbleGeometry(style.bubble, contentW, contentH, size, (style.bubbleStrokeWidth || 0) * scale);
  const padX = Math.ceil(Math.max(deco, bgPad + 1, bub ? Math.max(bub.reach.l, bub.reach.r) + 1 : 0));
  const padY = Math.ceil(Math.max(deco, bgPad + 1, bub ? Math.max(bub.reach.t, bub.reach.b) + 1 : 0));
  const w = Math.min(8192, Math.ceil(contentW + padX * 2));
  const h = Math.min(8192, Math.ceil(contentH + padY * 2));
  return { style, size, font, spacing, scale, lineH, runs, totals, contentW, contentH, padX, padY, bgPad, w, h, color: opts.color || style.color };
}

/** Run each visible run with ctx transformed so (x, y) is where its text starts. */
function eachRun(ctx, L, ox, oy, fn) {
  const canFilter = 'filter' in ctx;
  let filtered = false;
  for (const r of L.runs) {
    if (r.alpha <= 0.002 || (!r.plain && (r.scale <= 0.002 || r.space))) continue;
    ctx.setTransform(1, 0, 0, 1, ox, oy);
    ctx.globalAlpha = r.alpha;
    if (r.plain) {
      fn(r, L.padX + r.x, L.padY + r.y);
      continue;
    }
    ctx.translate(L.padX + r.cx, L.padY + r.cy);
    if (r.rot) ctx.rotate(r.rot);
    if (r.scale !== 1) ctx.scale(r.scale, r.scale);
    if (canFilter && (r.blur > 0.3 || filtered)) {
      ctx.filter = r.blur > 0.3 ? `blur(${r.blur.toFixed(1)}px)` : 'none';
      filtered = r.blur > 0.3;
    }
    if (r.w < 0) r.w = ctx.measureText(r.text).width;
    fn(r, -r.w / 2, 0);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  if (filtered) ctx.filter = 'none';
}

function prepare(ctx, L) {
  ctx.font = L.font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  // Glyph runs are placed one by one, so spacing is already in their positions.
  setSpacing(ctx, !L.runs.length || L.runs[0].plain ? L.spacing : 0);
}

/** Letters plus their outlines as one solid shape (for shadow, depth and glow). */
function silhouette(ctx, L, ox, oy, color) {
  const lw = ((L.style.strokeWidth || 0) + (L.style.stroke2Width || 0)) * 2 * L.scale;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  eachRun(ctx, L, ox, oy, (r, x, y) => {
    if (lw > 0) ctx.strokeText(r.text, x, y);
    ctx.fillText(r.text, x, y);
  });
}

/**
 * A blurred copy of the silhouette without the silhouette itself: the
 * letters are drawn far to the left and only their shadow lands here.
 */
function shadowOnly(ctx, L, dx, dy, blur, color) {
  const far = L.w + L.h + 200;
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = far + dx;
  ctx.shadowOffsetY = dy;
  silhouette(ctx, L, -far, 0, '#000000');
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

function underline(ctx, L, r, x, y) {
  if (!L.style.underline || !r.text) return;
  const width = r.plain ? ctx.measureText(r.text).width : r.adv;
  ctx.fillRect(x, y + L.size * 0.42, width, Math.max(1, L.size * 0.06));
}

function gradientFor(ctx, L) {
  const s = L.style;
  const cx = L.padX + L.contentW / 2;
  const cy = L.padY + L.contentH / 2;
  const a = ((s.gradAngle ?? 90) * Math.PI) / 180;
  const half = Math.abs(Math.cos(a)) * (L.contentW / 2) + Math.abs(Math.sin(a)) * (L.contentH / 2) || 1;
  const g = ctx.createLinearGradient(cx - Math.cos(a) * half, cy - Math.sin(a) * half, cx + Math.cos(a) * half, cy + Math.sin(a) * half);
  if (s.fillType === 'split') {
    g.addColorStop(0, s.grad1);
    g.addColorStop(0.5, s.grad1);
    g.addColorStop(0.5, s.grad2);
    g.addColorStop(1, s.grad2);
  } else {
    const stops = [s.grad1, s.grad2, s.grad3].filter(Boolean);
    stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  }
  return g;
}

function drawText(ctx, L) {
  const s = L.style;
  const sc = L.scale;
  if (hasBubble(s.bubble)) {
    drawBubble(ctx, s.bubble, { x: L.padX, y: L.padY, w: L.contentW, h: L.contentH }, { size: L.size, fill: s.bubbleFill, stroke: s.bubbleStroke, lineWidth: (s.bubbleStrokeWidth || 0) * sc });
  }
  if (s.bgOpacity > 0) {
    ctx.fillStyle = rgba(s.bgColor, s.bgOpacity);
    const bw = L.contentW + L.bgPad * 2;
    const bh = L.contentH + L.bgPad * 2;
    const r = Math.min(s.bgRadius * sc, bw / 2, bh / 2);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(L.padX - L.bgPad, L.padY - L.bgPad, bw, bh, r);
    else ctx.rect(L.padX - L.bgPad, L.padY - L.bgPad, bw, bh);
    ctx.fill();
  }
  prepare(ctx, L);
  if (s.shadowOpacity > 0) {
    const a = (s.shadowAngle * Math.PI) / 180;
    shadowOnly(ctx, L, Math.cos(a) * s.shadowDistance * sc, Math.sin(a) * s.shadowDistance * sc, s.shadowBlur * sc, rgba(s.shadowColor, s.shadowOpacity));
  }
  if (s.extrudeDepth > 0) {
    const a = (s.extrudeAngle * Math.PI) / 180;
    const depth = s.extrudeDepth * sc;
    const step = Math.max(1, depth / 40);
    for (let d = depth; d > 0; d -= step) silhouette(ctx, L, Math.cos(a) * d, Math.sin(a) * d, s.extrudeColor);
  }
  if (s.glowStrength > 0) {
    // Up to three stacked glows; the last one carries the fraction.
    const total = (s.glowStrength / 100) * 3;
    for (let i = 0; i < Math.ceil(total); i++) {
      const alpha = Math.min(1, total - i);
      shadowOnly(ctx, L, 0, 0, Math.max(1, s.glowRadius * sc), rgba(s.glowColor, alpha));
    }
  }
  if (s.glitch > 0) {
    const g = s.glitch * sc;
    for (const [dx, col] of [[-g, s.glitchColorA], [g, s.glitchColorB]]) {
      ctx.fillStyle = col;
      eachRun(ctx, L, dx, 0, (r, x, y) => ctx.fillText(r.text, x, y));
    }
  }
  if (s.stroke2Width > 0) {
    ctx.lineWidth = (s.strokeWidth + s.stroke2Width) * 2 * sc;
    ctx.strokeStyle = s.stroke2Color;
    eachRun(ctx, L, 0, 0, (r, x, y) => ctx.strokeText(r.text, x, y));
  }
  if (s.strokeWidth > 0) {
    ctx.lineWidth = s.strokeWidth * 2 * sc;
    ctx.strokeStyle = s.strokeColor;
    eachRun(ctx, L, 0, 0, (r, x, y) => ctx.strokeText(r.text, x, y));
  }
  const fillA = s.fillOpacity ?? 1;
  if (fillA <= 0) return;
  if (s.fillType === 'linear' || s.fillType === 'split') {
    // Letters in white on their own layer, then the gradient kept only where they are.
    const layer = makeCanvas(L.w, L.h);
    const lc = layer.getContext('2d');
    prepare(lc, L);
    lc.fillStyle = '#ffffff';
    eachRun(lc, L, 0, 0, (r, x, y) => {
      lc.fillText(r.text, x, y);
      underline(lc, L, r, x, y);
    });
    lc.globalCompositeOperation = 'source-in';
    lc.fillStyle = gradientFor(lc, L);
    lc.fillRect(0, 0, L.w, L.h);
    ctx.globalAlpha = fillA;
    ctx.drawImage(layer, 0, 0);
    ctx.globalAlpha = 1;
    // Highlighted words (karaoke) take their color on top.
    const lit = L.runs.filter((r) => r.color);
    if (lit.length) {
      eachRun(ctx, { ...L, runs: lit }, 0, 0, (r, x, y) => {
        ctx.globalAlpha *= fillA;
        ctx.fillStyle = r.color;
        ctx.fillText(r.text, x, y);
      });
    }
    return;
  }
  eachRun(ctx, L, 0, 0, (r, x, y) => {
    ctx.globalAlpha *= fillA;
    ctx.fillStyle = r.color || L.color;
    ctx.fillText(r.text, x, y);
    underline(ctx, L, r, x, y);
  });
}

/**
 * Measure and draw a text clip. scale is pixels per project pixel. Returns
 * { canvas, width, height, projW, projH, totals } where proj sizes are in
 * project pixels at transform scale 1.
 *  extra: { anim: [{ id, phase, p }], color }  per-frame animation state
 */
export function rasterizeText(clip, reveal, scale, measureOnly = false, extra = {}) {
  const L = layoutText(clip, scale, { reveal, anim: extra.anim, color: extra.color });
  if (measureOnly) return { width: L.w, height: L.h, projW: L.w / scale, projH: L.h / scale };
  const canvas = makeCanvas(L.w, L.h);
  const ctx = canvas.getContext('2d');
  drawText(ctx, L);
  return { canvas, width: L.w, height: L.h, projW: L.w / scale, projH: L.h / scale, totals: L.totals };
}

export function rasterizeSticker(clip, scale, t = 0, reuse = null) {
  const px = Math.max(16, Math.min(4096, Math.round(STICKER_SIZE * scale)));
  // Animated graphics redraw often: reuse the previous canvas when it is the same size.
  const canvas = reuse && reuse.width === px && reuse.height === px ? reuse : makeCanvas(px, px);
  drawSticker(canvas.getContext('2d'), clip.sticker, stickerColor(clip.sticker, clip.color, clip.colorMode), px, { t });
  return { canvas, width: px, height: px, projW: STICKER_SIZE, projH: STICKER_SIZE };
}

/** Corner radius (project pixels) of an avatar shown smaller than the frame: a picture in picture. */
export function avatarRadius(layer) {
  return layer.scale < 0.95 ? Math.round(Math.min(layer.frameW, layer.frameH) * 0.05) : 0;
}

/**
 * Draw an avatar layer (scene.js gives it frameW/H and a pose) at scale
 * pixels per project pixel, reusing a canvas of the same size.
 */
export function rasterizeAvatar(layer, scale, reuse = null) {
  const w = Math.max(2, Math.round(layer.frameW * scale));
  const h = Math.max(2, Math.round(layer.frameH * scale));
  const canvas = reuse && reuse.width === w && reuse.height === h ? reuse : makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, w, h);
    drawAvatar(ctx, w, h, layer.clip.avatar, layer.pose, { radius: avatarRadius(layer) * scale });
  }
  return { canvas, width: w, height: h, projW: layer.frameW, projH: layer.frameH };
}

/** What an avatar raster depends on besides its pose. */
const avatarLookKey = (a) => `${a.character}|${a.framing}|${a.background}|${a.bgColor}|${a.seed}`;

/**
 * Cache of rasterized text/sticker layers keyed by clip id; redraws when the
 * content, reveal step, animation frame or resolution bucket changes, or
 * when a font finishes loading.
 */
export class TextCache {
  constructor({ onFontLoaded } = {}) {
    this.entries = new Map();
    this.onFontLoaded = onFontLoaded;
    this.pendingFonts = new Set();
    this.fontEpoch = 0;
    this.offFonts = onFontLoaded ? onFontsChange(() => onFontLoaded()) : null;
  }

  _ensureFont(style) {
    if (typeof document === 'undefined' || !document.fonts) return;
    const spec = fontString(style, 32);
    if (document.fonts.check(spec)) return;
    if (this.pendingFonts.has(spec)) return;
    this.pendingFonts.add(spec);
    document.fonts.load(spec).then(() => {
      this.pendingFonts.delete(spec);
      this.fontEpoch++;
      this.onFontLoaded?.();
    }, () => this.pendingFonts.delete(spec));
  }

  /** Resolved texture info for a text or sticker layer. */
  get(layer, renderScale) {
    const clip = layer.clip;
    if (clip.type === 'avatar') return this._avatar(layer, renderScale);
    // Render at the size it is shown, in steps so small scale changes reuse the raster.
    const shown = renderScale * Math.max(0.25, layer.scale);
    const bucket = Math.min(4, Math.max(0.25, 2 ** (Math.ceil(Math.log2(shown) * 2) / 2)));
    let e = this.entries.get(clip.id);
    let sig;
    // Animated graphics step through frames of clip-local time.
    const frame = clip.type === 'sticker' && isAnimatedSticker(clip.sticker) ? Math.floor((Math.max(0, layer.local || 0) / 1e6) * STICKER_ANIM_FPS) : 0;
    let base = null;
    if (clip.type === 'text') {
      this._ensureFont(clip.style);
      const reveal = layer.reveal < 1 ? Math.floor(layer.reveal * [...clip.text].length) : -1;
      base = `${clip.text}|${JSON.stringify(clip.style)}|${reveal}|${bucket}|${this.fontEpoch}|${fontsVersion()}|${layer.textColor || ''}|${clip.marks?.join(',') || ''}`;
      const anim = layer.textAnim?.length ? animKey(layer.textAnim, e?.base === base ? e.totals : null) : '';
      sig = `${base}|${anim}`;
    } else {
      sig = `${clip.sticker}|${clip.color}|${clip.colorMode || ''}|${bucket}|${frame}`;
    }
    if (!e || e.sig !== sig) {
      const r = clip.type === 'text'
        ? rasterizeText(clip, layer.reveal, bucket, false, { anim: layer.textAnim, color: layer.textColor })
        : rasterizeSticker(clip, bucket, frame / STICKER_ANIM_FPS, frame ? e?.canvas : null);
      e = { sig, base, version: (e?.version || 0) + 1, ...r };
      this.entries.set(clip.id, e);
    }
    return { key: `txt:${clip.id}`, source: e.canvas, width: e.width, height: e.height, projW: e.projW, projH: e.projH, version: e.version };
  }

  _avatar(layer, renderScale) {
    const clip = layer.clip;
    const shown = renderScale * Math.max(0.1, layer.scale);
    let k = Math.min(4, Math.max(0.1, 2 ** (Math.ceil(Math.log2(shown) * 2) / 2)));
    k = Math.min(k, 4096 / Math.max(layer.frameW, layer.frameH));
    const sig = `${avatarLookKey(clip.avatar)}|${poseKey(layer.pose)}|${k}|${avatarRadius(layer)}|${layer.frameW}x${layer.frameH}`;
    let e = this.entries.get(clip.id);
    if (!e || e.sig !== sig) {
      // Poses change every frame while it talks: draw into the same canvas.
      const r = rasterizeAvatar(layer, k, e?.canvas || null);
      e = { sig, version: (e?.version || 0) + 1, ...r };
      this.entries.set(clip.id, e);
    }
    return { key: `txt:${clip.id}`, source: e.canvas, width: e.width, height: e.height, projW: e.projW, projH: e.projH, version: e.version };
  }

  /** Size in project pixels without drawing (hit testing in the player). */
  measure(clip) {
    if (clip.type === 'sticker') return { projW: STICKER_SIZE, projH: STICKER_SIZE };
    const r = rasterizeText(clip, 1, 1, true);
    return { projW: r.projW, projH: r.projH };
  }

  drop(id) {
    this.entries.delete(id);
  }

  clear() {
    this.entries.clear();
  }

  dispose() {
    this.offFonts?.();
    this.offFonts = null;
    this.entries.clear();
  }
}

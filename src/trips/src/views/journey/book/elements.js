// One book element as DOM: absolutely placed in fractions of the sheet, sizes in `cqw` of the sheet container.
import { el } from '../../../ui/dom.js';
import { t } from '../../../lib/i18n/index.js';
import { fileUrl, isRaster } from '../../../lib/files/index.js';
import { mmToCqw, ptToCqw } from '../../../lib/book/formats.js';
import { DEFAULT_TEXT_SIZE, FILTER_CSS, FONT_STACKS, LINE_HEIGHT, STYLE_WEIGHTS } from '../../../lib/book/raster.js';
import { flagEmoji } from '../../../lib/book/travel.js';
import { bookIcon, icon } from './icons.js';
import { paint } from './palette.js';
import { countrySvg, mapSvg } from './travel-svg.js';
import { statsText } from './stats.js';

const pct = (value) => `${(value * 100).toFixed(3)}%`;
const usable = (entity) => entity && !entity.deleted;

/** A label for screen readers and the element list. */
export function elementLabel(item) {
  if (item.k === 'text') return item.text?.trim() ? t('book.el.textNamed', { text: [...item.text.trim()].slice(0, 40).join('') }) : t('book.el.textEmpty');
  if (item.k === 'photo') return item.file ? t('book.el.photo') : t('book.el.photoEmpty');
  return t(`book.el.${item.k}`);
}

function photoContent(node, item, ctx) {
  const entity = item.file ? ctx.space.get('file', item.file) : null;
  let img = node.querySelector('img');
  const want = item.file && usable(entity) ? `${item.file}:${ctx.thumbs ? 't' : 'f'}` : '';
  if (!want) {
    img?.remove();
    node.querySelector('.bk-frame')?.remove();
    if (!node.querySelector('.bk-placeholder')) {
      node.append(el('span.bk-placeholder', { 'aria-hidden': 'true' }, icon(item.file ? 'warning' : 'addPhoto', 20),
        ctx.thumbs ? null : el('span', {}, item.file ? t('book.photoMissing') : t('book.photoEmpty'))));
    }
    node.classList.toggle('is-missing', Boolean(item.file));
    node.classList.add('is-empty');
    return;
  }
  node.classList.remove('is-empty', 'is-missing');
  node.querySelector('.bk-placeholder')?.remove();
  if (!img) { img = el('img', { alt: '', decoding: 'async', draggable: false }); node.prepend(img); }
  if (img.dataset.want !== want) {
    img.dataset.want = want;
    img.removeAttribute('src');
    const load = ctx.thumbs
      ? fileUrl(ctx.space, item.file, { thumb: true }).then((url) => url ?? (isRaster(entity.mime) ? fileUrl(ctx.space, item.file) : null))
      : fileUrl(ctx.space, item.file);
    const pending = Promise.resolve(load).then((url) => { if (url && img.dataset.want === want) img.src = url; }).catch(() => { node.classList.add('is-broken'); });
    ctx.track?.(pending);
  }
  const fx = item.fx ?? 0.5;
  const fy = item.fy ?? 0.5;
  img.style.objectFit = item.fit === 'fit' ? 'contain' : 'cover';
  img.style.objectPosition = `${fx * 100}% ${fy * 100}%`;
  img.style.transformOrigin = `${fx * 100}% ${fy * 100}%`;
  img.style.transform = (item.zoom ?? 1) !== 1 ? `scale(${item.zoom})` : '';
  img.style.filter = FILTER_CSS[item.filter] && item.filter !== 'none' ? FILTER_CSS[item.filter] : '';
  let frame = node.querySelector('.bk-frame');
  if (item.frame > 0) {
    if (!frame) { frame = el('span.bk-frame', { 'aria-hidden': 'true' }); node.append(frame); }
    frame.style.borderWidth = `${mmToCqw(item.frame, ctx.sheet.w)}cqw`;
    frame.style.borderColor = paint(item.frameColor, 'surface');
  } else frame?.remove();
}

function textStyle(node, item, ctx) {
  node.style.fontFamily = FONT_STACKS[item.font] ?? FONT_STACKS.sans;
  node.style.fontWeight = String(item.bold ? 700 : STYLE_WEIGHTS[item.style] ?? 400);
  node.style.fontStyle = item.italic || item.style === 'quote' ? 'italic' : '';
  node.style.fontSize = `${ptToCqw(item.size ?? DEFAULT_TEXT_SIZE, ctx.sheet.w)}cqw`;
  node.style.lineHeight = String(LINE_HEIGHT);
  node.style.color = paint(item.color, 'ink');
  node.dataset.align = item.align === 'center' || item.align === 'end' ? item.align : 'start';
}

// Travel SVG is rebuilt only when its inputs change.
const svgKeys = new WeakMap();

function content(node, item, ctx) {
  const box = { w: item.w * ctx.sheet.w, h: item.h * ctx.sheet.h };
  switch (item.k) {
    case 'photo': photoContent(node, item, ctx); break;
    case 'text': {
      textStyle(node, item, ctx);
      const empty = !String(item.text ?? '').trim();
      node.classList.toggle('is-empty', empty);
      node.textContent = empty ? (ctx.thumbs || ctx.print ? '' : t('book.textEmpty')) : item.text;
      break;
    }
    case 'stats': textStyle(node, item, ctx); node.textContent = statsText(ctx.stats, item.stat); break;
    case 'shape': {
      node.style.background = paint(item.fill, 'surface-2');
      node.style.border = item.stroke > 0 ? `${mmToCqw(item.stroke, ctx.sheet.w)}cqw solid ${paint(item.color, 'ink')}` : '';
      node.style.borderRadius = item.shape === 'ellipse' ? '50%' : `${mmToCqw(item.radius ?? 0, ctx.sheet.w)}cqw`;
      break;
    }
    case 'line': {
      let bar = node.firstElementChild;
      if (!bar) { bar = el('span.bk-rule'); node.append(bar); }
      bar.style.blockSize = `${mmToCqw(Math.max(0.1, item.stroke ?? 0.5), ctx.sheet.w)}cqw`;
      bar.style.background = paint(item.color, 'ink');
      break;
    }
    case 'icon': {
      node.style.color = paint(item.color, 'ink');
      if (node.dataset.icon !== item.icon) { node.dataset.icon = item.icon ?? ''; node.replaceChildren(bookIcon(item.icon, 'currentColor') ?? ''); }
      break;
    }
    case 'flag': {
      node.textContent = flagEmoji(item.cc) || (item.cc ?? '');
      node.style.fontSize = `${mmToCqw(box.h * 0.8, ctx.sheet.w)}cqw`;
      break;
    }
    case 'country': case 'map': case 'route': {
      const key = JSON.stringify([item, box, item.k === 'country' ? null : ctx.travelKey, Boolean(ctx.shapes)]);
      if (svgKeys.get(node) === key) break;
      svgKeys.set(node, key);
      const args = { entries: ctx.entries, page: ctx.page, item, w: box.w, h: box.h, shapes: ctx.shapes, paint };
      node.replaceChildren(item.k === 'country' ? countrySvg(args) : mapSvg({ ...args, route: item.k === 'route' }));
      break;
    }
    default: break;
  }
}

/** Creates or updates the node for one element. `ctx`: `{space, sheet, page, entries, stats, shapes, thumbs, print, track}`. */
export function renderElement(node, item, ctx) {
  const target = node ?? el('div.bk-el', { dataset: { id: item.id } });
  if (target.dataset.kind !== item.k) { target.replaceChildren(); target.dataset.kind = item.k; target.className = `bk-el bk-${item.k}`; }
  // The sheet lays out left to right in every language (book.css), so the inline start is the page's left edge.
  target.style.insetInlineStart = pct(item.x);
  target.style.insetBlockStart = pct(item.y);
  target.style.width = pct(item.w);
  target.style.height = pct(item.h);
  target.style.zIndex = String(Math.max(0, Math.round(item.z ?? 0)));
  target.style.opacity = Number.isFinite(item.opacity) ? String(item.opacity) : '';
  target.style.borderRadius = item.k === 'photo' ? `${mmToCqw(item.radius ?? 0, ctx.sheet.w)}cqw` : target.style.borderRadius;
  target.classList.toggle('is-locked', Boolean(item.lock));
  content(target, item, ctx);
  return target;
}

/**
 * Text tab of the assets panel: default text, style presets, word-art
 * effects and animated title templates. Search looks through every
 * category at once. Tiles are drawn by the real text renderer; template
 * tiles play their animation while hovered.
 */
import '../../styles/text.css';
import { h, announce } from '../../lib/dom.js';
import { US } from '../../lib/time.js';
import { TEXT_PRESETS, TEXT_EFFECTS } from '../../model/text-presets.js';
import { TEXT_TEMPLATES, templateClips, addTextTemplate } from '../../model/text-templates.js';
import { rasterizeText, rasterizeSticker } from '../../engine/text.js';
import { clipLayer } from '../../engine/scene.js';
import { lookCanvas } from '../text-thumbs.js';
import { textAiPanel } from './text-ai.js';
import { tabLayout, tileGrid, tile, emptyState } from './common.js';

const W = 192;
const H = 108;

const QUICK = [
  { id: 'plain', label: 'Default text' },
  { id: 'title-bold', label: 'Title' },
  { id: 'subtitle', label: 'Subtitle' },
  { id: 'minimal', label: 'Small heading' },
];

function presetPreview(p) {
  return lookCanvas({ text: p.text || 'Text', style: p.style }, W, H, { scale: 0.6 });
}

function effectPreview(e) {
  return lookCanvas({ text: e.label, style: { ...e.style, size: 110 } }, W, H, { scale: 0.5 });
}

/** Draw a template at template-relative time t (seconds) into a canvas. */
export function drawTemplate(canvas, tpl, t) {
  const g = canvas.getContext?.('2d');
  if (!g) return;
  const settings = { width: 1920, height: 1080 };
  const f = canvas.width / settings.width;
  g.fillStyle = '#1d2230';
  g.fillRect(0, 0, canvas.width, canvas.height);
  // A soft backdrop so light and dark layers both read.
  const grad = g.createLinearGradient(0, 0, canvas.width, canvas.height);
  grad.addColorStop(0, '#3b4a6b');
  grad.addColorStop(1, '#6b4a5e');
  g.fillStyle = grad;
  g.fillRect(0, 0, canvas.width, canvas.height);
  const raster = 0.25;
  for (const { clip } of templateClips(tpl, settings, 0)) {
    const local = t * US;
    if (local < clip.start || local >= clip.start + clip.duration) continue;
    const layer = clipLayer(null, clip, local, 0);
    if (layer.opacity <= 0.01) continue;
    let r;
    try {
      r = clip.type === 'sticker' ? rasterizeSticker(clip, raster) : rasterizeText(clip, layer.reveal, raster, false, { anim: layer.textAnim, color: layer.textColor });
    } catch {
      return;
    }
    const w = r.projW * layer.scale * f;
    const hh = r.projH * layer.scale * f;
    g.save();
    g.globalAlpha = layer.opacity;
    g.translate((settings.width / 2 + layer.x * settings.width) * f, (settings.height / 2 + layer.y * settings.height) * f);
    g.rotate((layer.rotation * Math.PI) / 180);
    g.drawImage(r.canvas, -w / 2, -hh / 2, w, hh);
    g.restore();
  }
}

/** Still frame once the layers have come in. */
const stillTime = (tpl) => Math.min(tpl.duration * 0.6, 1.6);

function templatePreview(tpl) {
  const c = h('canvas.tile-canvas', { width: W, height: H, 'aria-hidden': 'true' });
  drawTemplate(c, tpl, stillTime(tpl));
  // Redraw after the template's fonts load.
  if (typeof document !== 'undefined' && document.fonts?.ready) document.fonts.ready.then(() => drawTemplate(c, tpl, stillTime(tpl)));
  return c;
}

function hoverPlay(tileEl, tpl) {
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let raf = 0;
  let start = 0;
  const frame = (now) => {
    // A tile replaced while hovered never gets pointerleave.
    if (!tileEl.isConnected) {
      raf = 0;
      return;
    }
    start ||= now;
    const t = ((now - start) / 1000) % (tpl.duration + 0.3);
    const c = tileEl.querySelector('canvas');
    if (c) drawTemplate(c, tpl, Math.min(t, tpl.duration - 0.01));
    raf = requestAnimationFrame(frame);
  };
  const on = () => {
    if (raf) return;
    start = 0;
    raf = requestAnimationFrame(frame);
  };
  const off = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    const c = tileEl.querySelector('canvas');
    if (c) drawTemplate(c, tpl, stillTime(tpl));
  };
  tileEl.addEventListener('pointerenter', on);
  tileEl.addEventListener('pointerleave', off);
  tileEl.addEventListener('focus', on);
  tileEl.addEventListener('blur', off);
}

export function textTab(ctx) {
  const lookTile = (look, preview) => tile({
    label: look.label,
    preview,
    onAdd: () => ctx.actions.addText(look.id),
    drag: { kind: 'text', id: look.id },
    addLabel: `Add ${look.label} text`,
  });
  const templateTile = (tpl) => {
    const el = tile({
      label: tpl.label,
      preview: templatePreview(tpl),
      sub: `${tpl.layers.length} layers`,
      onAdd: () => {
        if (addTextTemplate(ctx.store, tpl.id)) announce(`${tpl.label} added`);
      },
      addLabel: `Add ${tpl.label} template`,
    });
    hoverPlay(el, tpl);
    return el;
  };
  const sections = [
    { id: 'default', label: 'Default text', items: () => QUICK.map((q) => ({ ...TEXT_PRESETS.find((p) => p.id === q.id), label: q.label })), make: (p) => lookTile(p, presetPreview(p)) },
    { id: 'styles', label: 'Styles', items: () => TEXT_PRESETS, make: (p) => lookTile(p, presetPreview(p)) },
    { id: 'effects', label: 'Effects', items: () => TEXT_EFFECTS, make: (e) => lookTile(e, effectPreview(e)) },
    { id: 'templates', label: 'Templates', items: () => TEXT_TEMPLATES, make: templateTile, className: 'template-grid' },
  ];
  const ai = textAiPanel(ctx, ctx.textAiChat ? { chat: ctx.textAiChat } : undefined);
  const layout = tabLayout({
    title: 'Text',
    categories: [...sections.map((s) => ({ id: s.id, label: s.label })), { id: 'ai', label: 'Write with AI', icon: 'magic' }],
    render(cat, q) {
      if (cat === 'ai' && !q) return ai.el;
      const match = (x) => !q || x.label.toLowerCase().includes(q) || x.id.includes(q);
      if (q) {
        const groups = sections.slice(1).map((s) => {
          const list = s.items().filter(match);
          if (!list.length) return null;
          return h('section.text-asset-group', { 'aria-label': s.label },
            h('h3.asset-group-title', s.label),
            tileGrid(list.map(s.make), { label: s.label, className: s.className || '' }),
          );
        }).filter(Boolean);
        if (!groups.length) return emptyState('search', 'No text found', 'Try another word.');
        return h('div.text-asset-results', groups);
      }
      const s = sections.find((x) => x.id === cat) || sections[0];
      return tileGrid(s.items().map(s.make), { label: s.label, className: s.className || '' });
    },
  });
  return { el: layout.el };
}

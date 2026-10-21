// Stencil brush textures: the overlay drawn over the viewport, right-drag to move / Shift scale /
// Ctrl rotate it (Alt: the mask texture's stencil), fitting it to the image's proportions and
// resetting it.
import { app, registerOperators, type OpContext } from '../app/app';
import { h, type VNode } from '../ui/h';
import { editModeHooks, viewportExtensions, viewportUIHooks } from '../editors/view3d/hooks';
import { activeView3D } from '../editors/view3d/view3d';
import { imageReady } from '../render/images';
import { activeBrush, isBrushMode, type BrushMode, type PaintBrush } from './brushes';
import { DEFAULT_STENCIL_DIM, DEFAULT_STENCIL_POS, maskTextureActive, sampleTexRGBA, stencilRect, textureActive, type BrushTexture } from './brushtex';

const slotOf = (b: PaintBrush, mask: boolean) => (mask ? b.mask_texture_slot : b.texture_slot);
const isStencil = (b: PaintBrush | null, mask: boolean): b is PaintBrush => !!b && (mask ? maskTextureActive(b) : textureActive(b)) && slotOf(b, mask)?.map_mode === 'STENCIL';

function brushNow(): PaintBrush | null {
  const m = app.doc.mode;
  return isBrushMode(m) ? activeBrush(m as BrushMode) : null;
}

function getPos(b: PaintBrush, mask: boolean): [number, number] {
  return [...((mask ? b.mask_stencil_pos : b.stencil_pos) ?? DEFAULT_STENCIL_POS)] as [number, number];
}
function getDim(b: PaintBrush, mask: boolean): [number, number] {
  return [...((mask ? b.mask_stencil_dimension : b.stencil_dimension) ?? DEFAULT_STENCIL_DIM)] as [number, number];
}
function setPos(b: PaintBrush, mask: boolean, p: [number, number]) {
  if (mask) b.mask_stencil_pos = p;
  else b.stencil_pos = p;
}
function setDim(b: PaintBrush, mask: boolean, d: [number, number]) {
  if (mask) b.mask_stencil_dimension = d;
  else b.stencil_dimension = d;
}

// ---------------------------------------------------------------------------
// overlay

const overlayCache = new Map<string, string>();

/** Data URL of the texture over the stencil's [-1, 1] square (with the texture's size and offset). */
function overlayImage(t: BrushTexture, mask: boolean): string {
  const img = t.image ? app.doc.images[t.image] : null;
  const key = `${mask}|${t.source}|${t.image}|${img?.revision ?? 0}|${t.scale}|${t.offset?.join(',')}`;
  const hit = overlayCache.get(key);
  if (hit) return hit;
  if (img && !imageReady(img)) {
    // try again once the image has loaded
    setTimeout(() => app.changed('ui'), 150);
    return '';
  }
  const N = 192;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  if (!g) return '';
  const data = g.createImageData(N, N);
  const px = [0, 0, 0, 0];
  const sc = Math.max(1e-3, t.scale),
    off = t.offset ?? [0, 0, 0];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = ((x + 0.5) / N) * 2 - 1,
        v = 1 - ((y + 0.5) / N) * 2;
      sampleTexRGBA(t, u / sc + off[0], v / sc + off[1], px);
      const i = (y * N + x) * 4;
      if (mask) {
        // masks show their strength as a grey level
        const f = (px[0] * 0.2126 + px[1] * 0.7152 + px[2] * 0.0722) * px[3];
        data.data[i] = data.data[i + 1] = data.data[i + 2] = Math.round(f * 255);
        data.data[i + 3] = 255;
      } else {
        for (let k = 0; k < 4; k++) data.data[i + k] = Math.round(px[k] * 255);
      }
    }
  g.putImageData(data, 0, 0);
  const url = c.toDataURL();
  if (overlayCache.size > 16) overlayCache.clear();
  overlayCache.set(key, url);
  return url;
}

editModeHooks.svg.push((v) => {
  const b = brushNow();
  if (!b) return null;
  const parts: VNode[] = [];
  for (const mask of [true, false]) {
    if (!isStencil(b, mask)) continue;
    const t = slotOf(b, mask)!;
    const r = stencilRect(b, mask, v.height);
    const deg = (-r.angle * 180) / Math.PI;
    void t;
    parts.push(
      h(
        'g',
        { key: `stencil-${mask}`, class: 'paint-stencil', 'data-mask': String(mask), transform: `translate(${r.cx} ${r.cy}) rotate(${deg})`, 'pointer-events': 'none' },
        h('rect', { x: -r.hw, y: -r.hh, width: r.hw * 2, height: r.hh * 2, fill: 'none', stroke: mask ? '#7fb2ff' : '#ffffff', 'stroke-opacity': 0.35, 'stroke-dasharray': '4 3' }),
      ) as VNode,
    );
  }
  return parts.length ? (h('g', { key: 'paint-stencils' }, ...parts) as VNode) : null;
});

// the texture itself, as an image under the viewport's UI (it lets the pointer through)
viewportUIHooks.push((v) => {
  const b = brushNow();
  if (!b) return null;
  const out = [];
  for (const mask of [true, false]) {
    if (!isStencil(b, mask)) continue;
    const t = slotOf(b, mask)!;
    const src = overlayImage(t, mask);
    if (!src) continue;
    const r = stencilRect(b, mask, v.height);
    const alpha = Math.max(0, Math.min(100, (mask ? b.mask_overlay_alpha : b.texture_overlay_alpha) ?? 33)) / 100;
    out.push(
      h('img', {
        key: `stencil-img-${mask}`,
        class: 'paint-stencil-img',
        src,
        alt: '',
        draggable: false,
        style: {
          position: 'absolute',
          left: `${r.cx - r.hw}px`,
          top: `${r.cy - r.hh}px`,
          width: `${r.hw * 2}px`,
          height: `${r.hh * 2}px`,
          opacity: String(alpha),
          transform: `rotate(${(-r.angle * 180) / Math.PI}deg)`,
          pointerEvents: 'none',
          imageRendering: 'auto',
        },
      }),
    );
  }
  return out.length ? out : null;
});

// ---------------------------------------------------------------------------
// operators

function stencilControl(ctx: OpContext, p: Record<string, unknown>): 'RUNNING_MODAL' | 'CANCELLED' {
  const b = brushNow();
  const mask = p.texmode === 'SECONDARY';
  const v = activeView3D();
  if (!isStencil(b, mask) || !v || !ctx.event) return 'CANCELLED';
  const rect = v.el.getBoundingClientRect();
  const local = (x: number, y: number) => ({ x: x - rect.left, y: v.height - (y - rect.top) });
  const start = local(ctx.event.x, ctx.event.y);
  const pos0 = getPos(b, mask),
    dim0 = getDim(b, mask);
  const slot = slotOf(b, mask)!;
  const ang0 = slot.angle;
  const mode = String(p.mode ?? 'TRANSLATION');
  const d0 = Math.max(1, Math.hypot(start.x - pos0[0], start.y - pos0[1]));
  const a0 = Math.atan2(start.y - pos0[1], start.x - pos0[0]);
  const redraw = () => {
    v.drawSvg();
    app.changed('ui');
  };
  app.startModal({
    label: 'Stencil Brush Control',
    cursor: mode === 'TRANSLATION' ? 'move' : 'crosshair',
    onPointerMove: (e) => {
      const q = local(e.clientX, e.clientY);
      if (mode === 'TRANSLATION') setPos(b, mask, [Math.round(pos0[0] + q.x - start.x), Math.round(pos0[1] + q.y - start.y)]);
      else if (mode === 'SCALE') {
        const k = Math.max(0.01, Math.hypot(q.x - pos0[0], q.y - pos0[1]) / d0);
        setDim(b, mask, [Math.max(1, dim0[0] * k), Math.max(1, dim0[1] * k)]);
      } else {
        const a = Math.atan2(q.y - pos0[1], q.x - pos0[0]);
        let ang = ang0 + (a - a0);
        while (ang > Math.PI * 2) ang -= Math.PI * 2;
        while (ang < -Math.PI * 2) ang += Math.PI * 2;
        slot.angle = ang;
      }
      redraw();
    },
    onPointerUp: (e) => (e.button === 2 || e.button === 0 ? 'FINISHED' : undefined),
    onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : undefined),
    onKey: (e) => {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      return true;
    },
    cancel: () => {
      setPos(b, mask, pos0);
      setDim(b, mask, dim0);
      slot.angle = ang0;
      redraw();
    },
    header: () => (mode === 'TRANSLATION' ? 'Move the stencil' : mode === 'SCALE' ? 'Scale the stencil' : 'Rotate the stencil') + ' · release to confirm · Esc cancels',
  });
  return 'RUNNING_MODAL';
}

const maskProp = { id: 'mask', label: 'Modify Mask Stencil', type: 'bool' as const, default: false };

registerOperators([
  {
    idname: 'brush.stencil_control',
    label: 'Stencil Brush Control',
    description: 'Move, scale or rotate the stencil of the brush texture with the mouse',
    props: [
      {
        id: 'mode',
        label: 'Tool',
        type: 'enum',
        default: 'TRANSLATION',
        items: [
          ['TRANSLATION', 'Translation'],
          ['SCALE', 'Scale'],
          ['ROTATION', 'Rotation'],
        ],
      },
      {
        id: 'texmode',
        label: 'Tool',
        type: 'enum',
        default: 'PRIMARY',
        items: [
          ['PRIMARY', 'Primary', 'The brush texture'],
          ['SECONDARY', 'Secondary', 'The mask texture'],
        ],
      },
    ],
    poll: () => isStencil(brushNow(), false) || isStencil(brushNow(), true),
    invoke: (ctx, p) => stencilControl(ctx, p),
    exec: () => 'CANCELLED',
  },
  {
    idname: 'brush.stencil_fit_image_aspect',
    label: 'Image Aspect',
    description: 'Give the stencil the width-to-height ratio of its image',
    props: [{ id: 'use_repeat', label: 'Use Repeat', type: 'bool', default: true }, { id: 'use_scale', label: 'Use Scale', type: 'bool', default: true }, maskProp],
    poll: () => !!brushNow(),
    exec: (_ctx, p) => {
      const b = brushNow()!;
      const mask = !!p.mask;
      const t = slotOf(b, mask);
      const img = t?.source === 'IMAGE' && t.image ? app.doc.images[t.image] : null;
      if (!t || !img || !img.width || !img.height) {
        app.report('WARNING', 'The stencil needs an image texture');
        return 'CANCELLED';
      }
      const dim = getDim(b, mask);
      let w = img.width,
        hgt = img.height;
      // with "repeat" the texture size counts (a smaller texture repeats inside the stencil)
      if (p.use_scale) {
        const sc = Math.max(1e-3, t.scale);
        w *= sc;
        hgt *= sc;
      }
      const base = Math.max(dim[0], dim[1]);
      const k = base / Math.max(w, hgt);
      setDim(b, mask, [w * k, hgt * k]);
      void p.use_repeat;
    },
  },
  {
    idname: 'brush.stencil_reset_transform',
    label: 'Reset Transform',
    description: 'Put the stencil back to its default position, size and angle',
    props: [maskProp],
    poll: () => !!brushNow(),
    exec: (_ctx, p) => {
      const b = brushNow()!;
      const mask = !!p.mask;
      setPos(b, mask, [...DEFAULT_STENCIL_POS]);
      setDim(b, mask, [...DEFAULT_STENCIL_DIM]);
      const t = slotOf(b, mask);
      if (t) t.angle = 0;
    },
  },
]);

// right mouse in a paint mode with a stencil: control it instead of opening the context menu
viewportExtensions.push((v) => {
  const down = (e: PointerEvent) => {
    if (e.button !== 2 || app.modal || !isBrushMode(app.doc.mode)) return;
    const b = brushNow();
    const mask = e.altKey;
    // with the Curve stroke method the right button selects curve points
    if (!isStencil(b, mask) || b.stroke_method === 'CURVE') return;
    e.preventDefault();
    e.stopPropagation();
    const mode = e.shiftKey ? 'SCALE' : e.ctrlKey || e.metaKey ? 'ROTATION' : 'TRANSLATION';
    app.run('brush.stencil_control', { mode, texmode: mask ? 'SECONDARY' : 'PRIMARY' }, { event: { x: e.clientX, y: e.clientY }, area: v.area as never });
  };
  const menu = (e: MouseEvent) => {
    if (app.modal?.label === 'Stencil Brush Control') e.preventDefault();
  };
  v.el.addEventListener('pointerdown', down, true);
  v.el.addEventListener('contextmenu', menu, true);
  return () => {
    v.el.removeEventListener('pointerdown', down, true);
    v.el.removeEventListener('contextmenu', menu, true);
  };
});

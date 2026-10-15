// Compositor Mask node: rasterizes a mask data-block at the compositing resolution (or a fixed
// size) for the current frame.
import { h } from '../ui/h';
import { onAppReady } from '../app/app';
import { enumMenu } from '../ui/widgets';
import { registerNodeType, nodeMenu } from '../nodes/registry';
import type { MenuCategory } from '../nodes/types';
import { registerExec } from '../compositor/eval/evaluator';
import { Result, IDENTITY, type Domain, type Xform } from '../compositor/eval/result';
import { cachedTexture } from '../compositor/eval/cache';
import { maskTable } from './types';
import { maskPixels, maskKey } from './raster';
import { parentResolver } from './parent';
import { app } from '../app/app';
import { compositingGroup } from '../compositor/data';
import { recomposite } from '../compositor/session';

registerNodeType({
  idname: 'CompositorNodeMask',
  label: 'Mask',
  category: 'input',
  treeTypes: ['COMPOSITOR'],
  width: 150,
  description: 'Input a mask (drawn in the clip editor) as a matte',
  inputs: [],
  outputs: [{ name: 'Mask', identifier: 'Mask', type: 'FLOAT', default: 0 }],
  props: [
    { id: 'use_feather', name: 'Feather', type: 'BOOLEAN', d: true },
    {
      id: 'size_source',
      name: 'Size Source',
      type: 'ENUM',
      d: 'SCENE',
      items: [
        ['SCENE', 'Scene Size'],
        ['FIXED', 'Fixed'],
      ],
    },
    { id: 'size_x', name: 'X', type: 'INT', d: 256, min: 1, max: 16384, visible: (n) => n.props.size_source === 'FIXED' },
    { id: 'size_y', name: 'Y', type: 'INT', d: 256, min: 1, max: 16384, visible: (n) => n.props.size_source === 'FIXED' },
  ],
  drawBody: (ctx) => {
    const masks = Object.values(maskTable(app.doc));
    return h(
      'div',
      { class: 'node-mask-pick' },
      enumMenu(
        `${ctx.key}-mask`,
        [{ value: '', label: '—' }, ...masks.map((m) => ({ value: m.id, label: m.name, icon: 'mod_mask' }))],
        (ctx.node.props.mask as string) ?? '',
        (v) => {
          ctx.node.props.mask = v || null;
          ctx.changed('Mask', true);
        },
      ),
    );
  },
  bodyHeight: () => 1,
});

registerExec('CompositorNodeMask', (x) => {
  const id = x.prop('mask') as string | null;
  const mask = id ? x.env.doc.masks?.[id] : undefined;
  if (!mask) {
    x.outs.set('Mask', Result.single('FLOAT', 0));
    return;
  }
  const fixed = x.str('size_source') === 'FIXED';
  const [W, H] = fixed ? [Math.max(1, Number(x.prop('size_x')) || 256), Math.max(1, Number(x.prop('size_y')) || 256)] : x.env.renderSize;
  const feather = x.prop('use_feather') !== false;
  const frame = x.env.frame;
  const parent = parentResolver(x.env.doc);
  const tex = cachedTexture(`mask|${maskKey(mask, frame, parent)}|${W}x${H}|${feather}`, () => {
    const px = maskPixels(mask, frame, W, H, feather, parent);
    const out = new Float32Array(W * H * 4);
    // textures are bottom-up
    for (let y = 0; y < H; y++)
      for (let i = 0; i < W; i++) {
        const v = px[(H - 1 - y) * W + i];
        const k = (y * W + i) * 4;
        out[k] = out[k + 1] = out[k + 2] = v;
        out[k + 3] = 1;
      }
    return x.gpu.upload(out, W, H, `mask:${mask.name}`);
  });
  const d: Domain = { w: W, h: H, xf: [...IDENTITY] as Xform };
  x.outs.set('Mask', Result.image('FLOAT', tex, d));
});

// editing a mask the compositor uses re-runs the compositor (its own change tracking does not see masks)
let lastSig = '';
let timer = 0;
onAppReady((a) =>
  a.subscribe((kinds) => {
    if (!kinds.has('doc') && !kinds.has('frame')) return;
    const masks = a.doc.masks;
    if (!masks) return;
    const g = compositingGroup(a.doc);
    const ids = g ? g.tree.nodes.filter((n) => n.type === 'CompositorNodeMask' && n.props.mask && masks[n.props.mask as string]).map((n) => n.props.mask as string) : [];
    if (!ids.length) return;
    const parent = parentResolver(a.doc);
    const sig = ids.map((id) => maskKey(masks[id], a.doc.scene.frame_current, parent)).join(',');
    if (sig === lastSig) return;
    lastSig = sig;
    clearTimeout(timer);
    timer = window.setTimeout(() => recomposite(true), 60);
  }),
);

// list the node under Add ▸ Mask next to the box and ellipse masks
onAppReady(() => {
  const cat = nodeMenu('COMPOSITOR').find((c) => c.label === 'Mask') as MenuCategory | undefined;
  if (cat && !cat.items.some((i) => typeof i === 'object' && 'idname' in i && i.idname === 'CompositorNodeMask')) cat.items.unshift({ idname: 'CompositorNodeMask' }, 'SEPARATOR');
});

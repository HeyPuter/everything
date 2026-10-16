// Segment list operators of the Dot Dash and Time Offset (Chain) modifiers.
import { app, registerOperators, type OpContext } from '../app/app';
import type { ModifierBase } from '../data/types';

type Seg = Record<string, unknown>;
type M = ModifierBase & { segments?: Seg[]; segment_active_index?: number };

function target(ctx: OpContext, p: Record<string, unknown>, type: string): M | null {
  const ob = app.activeObject;
  if (!ob || ob.type !== 'GREASEPENCIL') return null;
  const m = (p.modifier ? ob.modifiers.find((x) => x.name === p.modifier || x.id === p.modifier) : ob.modifiers.find((x) => x.is_active)) as M | undefined;
  void ctx;
  return m && m.type === type ? m : null;
}

const uniqueSeg = (segs: Seg[], base: string) => {
  const names = new Set(segs.map((s) => String(s.name)));
  if (!names.has(base)) return base;
  for (let i = 1; ; i++) {
    const n = `${base}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
};

function segOps(kind: 'dash' | 'time', type: string, make: (segs: Seg[], active: number) => Seg) {
  const modProp = { id: 'modifier', label: 'Modifier', type: 'string' as const, default: '', hidden: true };
  const poll = (ctx: OpContext) => !!app.activeObject && app.activeObject.type === 'GREASEPENCIL' && ctx.doc.mode === 'OBJECT';
  registerOperators([
    {
      idname: `object.grease_pencil_${kind}_modifier_segment_add`,
      label: 'Add Segment',
      description: kind === 'dash' ? 'Add a dash segment after the active one' : 'Add a frame segment after the active one',
      props: [modProp],
      poll,
      exec: (ctx, p) => {
        const m = target(ctx, p, type);
        if (!m) return 'CANCELLED';
        const segs = (m.segments ??= []);
        const active = Math.min(segs.length - 1, Math.max(0, m.segment_active_index ?? 0));
        const s = make(segs, active);
        segs.splice(active + 1, 0, s);
        m.segment_active_index = active + 1;
      },
    },
    {
      idname: `object.grease_pencil_${kind}_modifier_segment_remove`,
      label: 'Remove Segment',
      description: 'Remove the active segment',
      props: [modProp, { id: 'index', label: 'Index', type: 'int', default: -1, hidden: true }],
      poll,
      exec: (ctx, p) => {
        const m = target(ctx, p, type);
        const segs = m?.segments ?? [];
        const i = (p.index as number) >= 0 ? (p.index as number) : (m?.segment_active_index ?? 0);
        // a dot dash pattern keeps at least one segment
        if (!m || !segs[i] || (kind === 'dash' && segs.length <= 1)) return 'CANCELLED';
        segs.splice(i, 1);
        m.segment_active_index = Math.max(0, Math.min(segs.length - 1, i - 1));
      },
    },
    {
      idname: `object.grease_pencil_${kind}_modifier_segment_move`,
      label: 'Move Segment',
      description: 'Move the active segment up or down in the list',
      props: [
        modProp,
        {
          id: 'type',
          label: 'Type',
          type: 'enum',
          default: 'UP',
          items: [
            ['UP', 'Up'],
            ['DOWN', 'Down'],
          ],
        },
      ],
      poll,
      exec: (ctx, p) => {
        const m = target(ctx, p, type);
        const segs = m?.segments ?? [];
        const i = m?.segment_active_index ?? 0;
        const j = p.type === 'UP' ? i - 1 : i + 1;
        if (!m || j < 0 || j >= segs.length) return 'CANCELLED';
        [segs[i], segs[j]] = [segs[j], segs[i]];
        m.segment_active_index = j;
      },
    },
  ]);
}

segOps('dash', 'GREASE_PENCIL_DASH', (segs, active) => {
  const src = segs[active];
  return src ? { ...structuredClone(src), name: uniqueSeg(segs, 'Segment') } : { name: uniqueSeg(segs, 'Segment'), dash: 2, gap: 1, radius: 1, opacity: 1, material_index: -1, use_cyclic: false };
});
segOps('time', 'GREASE_PENCIL_TIME', (segs, active) => {
  const src = segs[active];
  const st = src ? (src.seg_end as number) + 1 : 1;
  return { name: uniqueSeg(segs, 'Segment'), seg_start: st, seg_end: st + 1, seg_mode: 'NORMAL', seg_repeat: 1 };
});

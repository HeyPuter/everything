// Annotation layers: the View tab's Annotations panel (layer list, colour, thickness, opacity)
// and the gpencil.* annotation operators (add / unlink data, add / remove / move layers, delete the
// active layer's strokes).
import { app, registerOperators, type OpContext } from '../app/app';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { panel, numberField, colorSwatch } from '../ui/widgets';
import { uiList } from '../editors/properties/uilist';
import { viewTabPanels } from '../editors/view3d/sidebar';
import { activeAnnotationLayer, type AnnotationLayer, type AnnotationStroke } from '../editors/view3d/tools3d';
import type { SceneData } from '../data/types';

type SceneExt = SceneData & { annotations?: AnnotationStroke[]; annotation_layers?: AnnotationLayer[]; annotation_layer_active?: number };
const sc = (ctx?: OpContext) => (ctx?.doc ?? app.doc).scene as SceneExt;

const uniqueLayer = (list: AnnotationLayer[], base: string) => {
  const names = new Set(list.map((l) => l.name));
  if (!names.has(base)) return base;
  for (let i = 1; ; i++) {
    const n = `${base}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
};

const newLayer = (list: AnnotationLayer[], base = 'Note'): AnnotationLayer => ({ name: uniqueLayer(list, base), color: [0.12, 0.65, 0.95], thickness: 3, annotation_opacity: 1, annotation_hide: false, lock: false });

const hasLayers = (ctx: OpContext) => !!sc(ctx).annotation_layers?.length;

registerOperators([
  {
    idname: 'gpencil.annotation_add',
    label: 'Annotation Add New',
    description: 'Start annotations with a first layer',
    poll: (ctx) => !hasLayers(ctx),
    exec: () => {
      activeAnnotationLayer(true);
    },
  },
  {
    idname: 'gpencil.data_unlink',
    label: 'Annotation Unlink',
    description: 'Remove all annotation layers and their strokes',
    poll: (ctx) => hasLayers(ctx) || !!sc(ctx).annotations?.length,
    exec: (ctx) => {
      const s = sc(ctx);
      s.annotation_layers = [];
      s.annotation_layer_active = 0;
      s.annotations = [];
    },
  },
  {
    idname: 'gpencil.layer_annotation_add',
    label: 'Add New Annotation Layer',
    description: 'Add a layer above the active one; new annotation strokes go to it',
    exec: (ctx) => {
      const s = sc(ctx);
      const list = (s.annotation_layers ??= []);
      const at = list.length ? Math.min(list.length, (s.annotation_layer_active ?? 0) + 1) : 0;
      list.splice(at, 0, newLayer(list));
      s.annotation_layer_active = at;
    },
  },
  {
    idname: 'gpencil.layer_annotation_remove',
    label: 'Remove Annotation Layer',
    description: 'Remove the active annotation layer and its strokes',
    poll: hasLayers,
    exec: (ctx) => {
      const s = sc(ctx);
      const list = s.annotation_layers!;
      const i = Math.max(0, Math.min(list.length - 1, s.annotation_layer_active ?? 0));
      const [gone] = list.splice(i, 1);
      s.annotations = (s.annotations ?? []).filter((st) => st.layer !== gone.name);
      s.annotation_layer_active = Math.max(0, i - 1);
    },
  },
  {
    idname: 'gpencil.layer_annotation_move',
    label: 'Move Annotation Layer',
    description: 'Move the active annotation layer up or down in the list',
    props: [
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
    poll: (ctx) => (sc(ctx).annotation_layers?.length ?? 0) > 1,
    exec: (ctx, p) => {
      const s = sc(ctx);
      const list = s.annotation_layers!;
      const i = s.annotation_layer_active ?? 0;
      // the list shows the top layer first: up moves towards the end of the stack
      const j = p.type === 'UP' ? i + 1 : i - 1;
      if (j < 0 || j >= list.length) return 'CANCELLED';
      [list[i], list[j]] = [list[j], list[i]];
      s.annotation_layer_active = j;
    },
  },
  {
    idname: 'gpencil.annotation_active_frame_delete',
    label: 'Delete Active Frame',
    description: 'Delete the strokes of the active annotation layer',
    poll: (ctx) => {
      const l = activeAnnotationLayer();
      return !!l && !!sc(ctx).annotations?.some((s) => s.layer === l.name);
    },
    exec: (ctx) => {
      const l = activeAnnotationLayer();
      if (!l) return 'CANCELLED';
      const s = sc(ctx);
      s.annotations = (s.annotations ?? []).filter((st) => st.layer !== l.name);
    },
  },
]);

function changed(label: string) {
  app.pushUndo(label);
  app.changed('doc');
}

function annotationsPanel(): Child {
  const s = sc();
  const list = s.annotation_layers ?? [];
  if (!list.length)
    return [
      h('button', { class: 'btn', onclick: () => app.run('gpencil.annotation_add') }, icon('add'), 'New'),
      s.annotations?.length ? h('div', { class: 'prop-note' }, 'Strokes drawn before layers existed stay until cleared.') : null,
    ];
  const active = Math.max(0, Math.min(list.length - 1, s.annotation_layer_active ?? 0));
  const l = list[active];
  // top layer first, like the stacking order
  const order = list.map((_, i) => list.length - 1 - i);
  return [
    uiList(
      'ann-layers',
      order.map((i) => ({
        key: list[i].name,
        label: list[i].name,
        icon: 'annotate',
        rightSize: 'compact' as const,
        right: [
          h('button', { class: { 'ul-lock': true, on: list[i].annotation_hide }, 'data-tip': 'Hide the layer', onpointerdown: (e: PointerEvent) => e.stopPropagation(), onclick: (e: MouseEvent) => (e.stopPropagation(), (list[i].annotation_hide = !list[i].annotation_hide), changed('Hide Annotation Layer')) }, icon(list[i].annotation_hide ? 'hide_on' : 'hide_off')),
          h('button', { class: { 'ul-lock': true, on: list[i].lock }, 'data-tip': 'Lock the layer', onpointerdown: (e: PointerEvent) => e.stopPropagation(), onclick: (e: MouseEvent) => (e.stopPropagation(), (list[i].lock = !list[i].lock), changed('Lock Annotation Layer')) }, icon(list[i].lock ? 'locked' : 'unlocked')),
        ],
      })),
      list.length - 1 - active,
      (k) => ((s.annotation_layer_active = list.length - 1 - k), app.changed('doc')),
      {
        add: () => app.run('gpencil.layer_annotation_add'),
        remove: () => app.run('gpencil.layer_annotation_remove'),
        rename: (k, name) => {
          const ly = list[list.length - 1 - k];
          const old = ly.name;
          ly.name = uniqueLayer(list.filter((x) => x !== ly), name || old);
          for (const st of s.annotations ?? []) if (st.layer === old) st.layer = ly.name;
          changed('Rename Annotation Layer');
        },
        up: list.length > 1 ? () => app.run('gpencil.layer_annotation_move', { type: 'UP' }) : undefined,
        down: list.length > 1 ? () => app.run('gpencil.layer_annotation_move', { type: 'DOWN' }) : undefined,
        specials: () => [
          { label: 'Delete Active Layer Strokes', op: 'gpencil.annotation_active_frame_delete' },
          { label: 'Remove All Annotations', op: 'gpencil.data_unlink' },
        ],
      },
    ),
    h(
      'div',
      { class: 'ann-props' },
      colorSwatch('ann-l-color', l.color, (c, final) => {
        l.color = [c[0], c[1], c[2]];
        if (final) app.pushUndo('Annotation Color');
        app.changed('doc');
      }),
      numberField({ id: 'ann-l-thick', label: 'Thickness', value: l.thickness, min: 1, max: 10, int: true, set: (x, final) => ((l.thickness = x), final && app.pushUndo('Annotation Thickness'), app.changed('doc')) }),
      numberField({ id: 'ann-l-opac', label: 'Opacity', value: l.annotation_opacity, min: 0, max: 1, slider: true, set: (x, final) => ((l.annotation_opacity = x), final && app.pushUndo('Annotation Opacity'), app.changed('doc')) }),
    ),
  ];
}

viewTabPanels.push(() => panel('sb-annotations', 'Annotations', annotationsPanel, { closed: true }));

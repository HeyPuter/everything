// Dope Sheet ▸ Grease Pencil mode: one channel per layer (grouped by object) with the layer
// keyframes; click / shift / box / column selection, move (G or drag), duplicate, delete, keyframe
// type, insert blank keyframe; layer toggles (onion skin, visibility, lock) in the channel list.
import { app, registerOperators, type OpContext } from '../app/app';
import { addKeys } from '../app/keymap';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { openMenu, type MenuItem } from '../ui/menu';
import { numberField } from '../ui/widgets';
import { registerEditor, type Area } from '../ui/screen';
import { DopeSheet, DOPESHEET_MODES } from '../animation/dopesheet';
import { menuButton, hdrToggle, markerMenu, RULER_H } from '../animation/animeditor';
import { channelState, type Channel } from '../animation/channels';
import { C, drawKey } from '../animation/theme';
import { playbackFooter } from '../animation/footer';
import { gpOf, copyDrawing, compactDrawings, sortFrames } from './data';
import { layerMenu } from './ui';
import type { GPFrame, GPKeyframeType, GPLayer, GreasePencilData } from './types';
import type { ObjectData } from '../data/types';

DOPESHEET_MODES.push({
  value: 'GPENCIL',
  label: 'Grease Pencil',
  icon: 'outliner_ob_greasepencil',
  description: 'Edit timings for all Grease Pencil layers',
});

interface GPRow {
  kind: 'SUMMARY' | 'OBJECT' | 'LAYER' | 'GROUP';
  /** layer group name (GROUP rows) */
  group?: string;
  ob?: ObjectData;
  gp?: GreasePencilData;
  layer?: GPLayer;
  layerIndex?: number;
}
type GPChannel = Channel & { gpRow: GPRow };

const KEY_TYPES: [GPKeyframeType, string][] = [
  ['KEYFRAME', 'Keyframe'],
  ['BREAKDOWN', 'Breakdown'],
  ['MOVING_HOLD', 'Moving Hold'],
  ['EXTREME', 'Extreme'],
  ['JITTER', 'Jitter'],
  ['GENERATED', 'Generated'],
];

/** All GP layers shown by a dope sheet (respecting Only Show Selected / Show Hidden). */
export function gpObjects(onlySelected: boolean, showHidden: boolean): { ob: ObjectData; gp: GreasePencilData }[] {
  const out: { ob: ObjectData; gp: GreasePencilData }[] = [];
  for (const id of app.doc.object_order) {
    const ob = app.doc.objects[id];
    const gp = gpOf(app.doc, ob);
    if (!ob || !gp) continue;
    if (onlySelected && !ob.select) continue;
    if (!showHidden && !app.isVisible(ob.id)) continue;
    out.push({ ob, gp });
  }
  return out;
}

function rowFrames(r: GPRow, all: { ob: ObjectData; gp: GreasePencilData }[]): GPFrame[] {
  if (r.kind === 'LAYER') return r.layer!.frames;
  if (r.kind === 'GROUP') return r.gp!.layers.filter((l) => l.parent_group === r.group).flatMap((l) => l.frames);
  if (r.kind === 'OBJECT') return r.gp!.layers.flatMap((l) => l.frames);
  return all.flatMap((x) => x.gp.layers.flatMap((l) => l.frames));
}

const isGPEditor = (ed: unknown): ed is GPDopeSheet => ed instanceof GPDopeSheet && ed.gpMode();
export const hoverGP = (ctx?: OpContext): GPDopeSheet | null => {
  const ed = (ctx?.area ?? app.hoverArea ?? app.activeArea)?.editor;
  return isGPEditor(ed) ? ed : null;
};

export class GPDopeSheet extends DopeSheet {
  constructor(area: Area, state?: unknown) {
    super(area, state);
    if ((state as { mode?: string } | undefined)?.mode === 'GPENCIL') (this as { mode: string }).mode = 'GPENCIL';
    const base = this.keymaps;
    Object.defineProperty(this, 'keymaps', {
      get: () => (this.gpMode() ? ['Dopesheet Grease Pencil', 'Dopesheet', 'Animation'] : base),
      set: () => {},
      configurable: true,
    });
    this.refresh();
  }

  gpMode() {
    return (this.mode as string) === 'GPENCIL';
  }

  frameSets() {
    return gpObjects(this.onlySelected, this.showHidden);
  }

  rebuild() {
    if (!this.gpMode()) return super.rebuild();
    const rows: GPChannel[] = [];
    const objs = this.frameSets();
    const mk = (key: string, kind: Channel['kind'], label: string, depth: number, gpRow: GPRow, ic?: string): GPChannel => ({
      key,
      kind,
      label,
      depth,
      icon: ic,
      curves: [],
      expandable: false,
      expanded: true,
      gpRow,
      ob: gpRow.ob,
    });
    for (const k of [...channelState.selectedGroups]) if (k.startsWith('gpl:')) channelState.selectedGroups.delete(k);
    if (objs.length) rows.push(mk('gp-summary', 'SUMMARY', 'Summary', 0, { kind: 'SUMMARY' }));
    const q = this.search.toLowerCase();
    for (const { ob, gp } of objs) {
      rows.push(mk(`gpo:${ob.id}`, 'OBJECT', ob.name, 0, { kind: 'OBJECT', ob, gp }, 'outliner_ob_greasepencil'));
      const shownGroups = new Set<string>();
      for (let li = gp.layers.length - 1; li >= 0; li--) {
        const layer = gp.layers[li];
        const g = layer.parent_group;
        if (g && !shownGroups.has(g)) {
          shownGroups.add(g);
          rows.push(mk(`gpg:${ob.id}:${g}`, 'GROUP', g, 1, { kind: 'GROUP', ob, gp, group: g }, 'file_folder'));
        }
        if (g && (gp.layer_groups ?? []).find((x) => x.name === g)?.expanded === false) continue;
        if (q && !layer.name.toLowerCase().includes(q)) continue;
        const key = `gpl:${ob.id}:${li}`;
        if (li === gp.active_layer_index) channelState.selectedGroups.add(key);
        rows.push(mk(key, 'GROUP', layer.name, g ? 2 : 1, { kind: 'LAYER', ob, gp, layer, layerIndex: li }, 'outliner_data_gp_layer'));
      }
    }
    this.list = { rows, curves: [] };
  }

  header(): Child {
    if (!this.gpMode()) return super.header();
    return h(
      'div',
      { class: 'hdr-row' },
      h(
        'button',
        {
          key: 'mode',
          class: 'hdr-mode',
          'data-tip': 'Mode\nEditing context being displayed',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(
              DOPESHEET_MODES.map((m) => ({
                label: m.label,
                icon: m.icon,
                active: m.value === this.mode,
                description: m.description,
                action: () => this.setMode(m.value as never),
              })),
              e.currentTarget as HTMLElement,
            );
          },
        },
        icon('outliner_ob_greasepencil'),
        'Grease Pencil',
        icon('down_arrow_hlt', 'tiny'),
      ),
      menuButton('View', () => this.viewMenu()),
      menuButton('Select', gpSelectMenu),
      menuButton('Marker', markerMenu),
      menuButton('Channel', layerMenu),
      menuButton('Key', gpKeyMenu),
      h('div', { class: 'hdr-spacer' }),
      hdrToggle(
        'only-sel',
        'restrict_select_off',
        this.onlySelected,
        'Only Show Selected\nOnly include channels relating to selected objects and data',
        () => ((this.onlySelected = !this.onlySelected), this.refresh(), app.changed('ui')),
      ),
      hdrToggle(
        'show-hidden',
        'hide_off',
        this.showHidden,
        'Show Hidden\nInclude channels from objects/bone that are not visible',
        () => ((this.showHidden = !this.showHidden), this.refresh(), app.changed('ui')),
      ),
    );
  }

  protected footer(): Child | null {
    return playbackFooter();
  }

  protected rowExtra(ch: Channel): Child {
    if (!this.gpMode()) return super.rowExtra(ch);
    const r = (ch as GPChannel).gpRow;
    if (r?.kind !== 'LAYER') return null;
    const l = r.layer!;
    return h(
      'span',
      { class: 'anim-ch-slider', style: { width: '54px', flex: 'none' } },
      numberField({
        id: `gpl-op-${ch.key}`,
        value: l.opacity,
        min: 0,
        max: 1,
        slider: true,
        precision: 2,
        tip: 'Layer opacity',
        set: (v, final) => {
          l.opacity = v;
          app.changed('doc');
          if (final) app.pushUndo('Layer Opacity');
        },
      }),
    );
  }

  protected rowToggles(ch: Channel): Child {
    if (!this.gpMode()) return super.rowToggles(ch);
    const r = (ch as GPChannel).gpRow;
    if (r?.kind !== 'LAYER') return null;
    const l = r.layer!;
    const tg = (key: string, on: boolean, a: string, b: string, tip: string, f: () => void) =>
      h(
        'button',
        {
          key,
          class: { 'anim-tg': true, on },
          'data-tip': tip,
          onpointerdown: (e: PointerEvent) => e.stopPropagation(),
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            f();
            app.pushUndo(tip.split('\n')[0]);
            app.changed('doc');
          },
        },
        icon(on ? a : b),
      );
    return [
      tg('on', l.use_onion_skinning, 'onionskin_on', 'onionskin_off', 'Onion Skinning\nDisplay onion skins of this layer', () => (l.use_onion_skinning = !l.use_onion_skinning)),
      tg('hd', !l.hide, 'hide_off', 'hide_on', 'Hide\nSet layer visibility', () => (l.hide = !l.hide)),
      tg('lk', l.lock, 'locked', 'unlocked', 'Lock\nProtect layer from further editing', () => (l.lock = !l.lock)),
    ];
  }

  protected channelDown(e: PointerEvent, ch: Channel) {
    if (!this.gpMode()) return super.channelDown(e, ch);
    if ((e.target as HTMLElement).closest('.anim-tg')) return;
    const r = (ch as GPChannel).gpRow;
    if (e.button === 2) {
      e.preventDefault();
      openMenu(layerMenu(), { x: e.clientX, y: e.clientY });
      return;
    }
    if (r.kind === 'LAYER' && r.ob) {
      r.gp!.active_layer_index = r.layerIndex!;
      if (!r.ob.select || app.doc.scene.active_object !== r.ob.id) {
        if (!e.shiftKey && app.doc.mode === 'OBJECT') for (const o of Object.values(app.doc.objects)) o.select = false;
        r.ob.select = true;
        if (app.doc.mode === 'OBJECT') app.doc.scene.active_object = r.ob.id;
      }
      app.pushUndo('Set Active Layer');
      app.changed('doc', 'select');
    } else if (r.kind === 'OBJECT' && r.ob && app.doc.mode === 'OBJECT') {
      if (!e.shiftKey) for (const o of Object.values(app.doc.objects)) o.select = false;
      r.ob.select = true;
      app.doc.scene.active_object = r.ob.id;
      app.pushUndo('Select Object');
      app.changed('doc', 'select');
    }
  }

  channelContextMenu(): MenuItem[] {
    return this.gpMode() ? layerMenu() : super.channelContextMenu();
  }

  protected mainContextMenu(): MenuItem[] {
    if (!this.gpMode()) return super.mainContextMenu();
    return [{ heading: 'Grease Pencil' }, ...gpKeyMenu()];
  }

  protected drawContent(g: CanvasRenderingContext2D, W: number, H: number) {
    if (!this.gpMode()) return super.drawContent(g, W, H);
    const v = this.view;
    const rows = this.list.rows as GPChannel[];
    const rh = this.rowH;
    const size = Math.round(rh * 0.62);
    const all = this.frameSets();
    for (let i = 0; i < rows.length; i++) {
      const y = this.rowTop(i);
      if (y > H || y + rh < RULER_H) continue;
      const ch = rows[i];
      const r = ch.gpRow;
      g.fillStyle = r.kind === 'SUMMARY' ? C.summary : r.kind === 'OBJECT' || r.kind === 'GROUP' ? C.objectRow : channelState.selectedGroups.has(ch.key) ? C.channelRowSel : C.channelRow;
      g.fillRect(0, y, W, rh - 1);
      const cc = r.kind === 'LAYER' ? r.layer!.channel_color : undefined;
      if (cc) {
        // custom channel color: a tinted row
        g.fillStyle = `rgba(${cc.map((x) => Math.round(Math.pow(Math.max(0, Math.min(1, x)), 1 / 2.2) * 255)).join(',')},0.28)`;
        g.fillRect(0, y, W, rh - 1);
      }
      const yc = Math.round(y + rh / 2) + 0.5;
      const byFrame = new Map<number, { sel: boolean; type: GPKeyframeType }>();
      for (const f of rowFrames(r, all)) {
        const cur = byFrame.get(f.frame_number);
        byFrame.set(f.frame_number, {
          sel: (cur?.sel ?? false) || !!f.select,
          type: cur ? (cur.type === f.keyframe_type ? cur.type : 'KEYFRAME') : f.keyframe_type,
        });
      }
      // hold bars between keys of a layer (same drawing continues)
      if (r.kind === 'LAYER') {
        const fr = r.layer!.frames;
        for (let k = 0; k + 1 < fr.length; k++) {
          const x0 = v.fx(fr[k].frame_number),
            x1 = v.fx(fr[k + 1].frame_number);
          if (x1 < 0 || x0 > W || fr[k].drawing !== fr[k + 1].drawing) continue;
          g.fillStyle = fr[k].select && fr[k + 1].select ? C.longKeySelected : C.longKey;
          g.fillRect(x0, yc - rh * 0.17, x1 - x0, rh * 0.34);
        }
      }
      for (const [frame, k] of byFrame) {
        const x = v.fx(frame);
        if (x < -10 || x > W + 10) continue;
        drawKey(g, Math.round(x) + 0.5, yc, size, k.type, k.sel, 'DIAMOND', r.layer?.hide ? 0.45 : 1);
      }
    }
  }

  /** frames under a row/frame position */
  gpKeyAt(x: number, y: number): { frames: GPFrame[]; frame: number } | null {
    const i = this.rowAt(y);
    const ch = this.list.rows[i] as GPChannel | undefined;
    if (!ch?.gpRow) return null;
    const frames = rowFrames(ch.gpRow, this.frameSets());
    let best: number | null = null,
      bd = 8;
    for (const f of frames) {
      const d = Math.abs(this.view.fx(f.frame_number) - x);
      if (d < bd) {
        bd = d;
        best = f.frame_number;
      }
    }
    return best === null ? null : { frames: frames.filter((f) => f.frame_number === best), frame: best };
  }

  allFrames(): GPFrame[] {
    return this.frameSets().flatMap((x) => x.gp.layers.flatMap((l) => l.frames));
  }

  protected mainDown(e: PointerEvent, x: number, y: number) {
    if (!this.gpMode()) return super.mainDown(e, x, y);
    const hit = this.gpKeyAt(x, y);
    const all = this.allFrames();
    if (e.altKey && hit) {
      if (!e.shiftKey) all.forEach((f) => (f.select = false));
      for (const f of all) if (f.frame_number === hit.frame) f.select = true;
      app.pushUndo('Select Column');
      app.changed('doc');
      return;
    }
    if (hit) {
      const allSel = hit.frames.every((f) => f.select);
      if (e.shiftKey) {
        hit.frames.forEach((f) => (f.select = !allSel));
        app.pushUndo('Select Keyframes');
        app.changed('doc');
        return;
      }
      if (!allSel) {
        all.forEach((f) => (f.select = false));
        hit.frames.forEach((f) => (f.select = true));
        app.changed('doc');
      }
      this.clickOrDrag(
        e,
        () => {
          all.forEach((f) => (f.select = false));
          hit.frames.forEach((f) => (f.select = true));
          app.pushUndo('Select Keyframes');
          app.changed('doc');
        },
        (start) => moveFrames(this, start.clientX),
      );
      return;
    }
    this.clickOrDrag(
      e,
      () => {
        if (!e.shiftKey) {
          all.forEach((f) => (f.select = false));
          app.pushUndo('Deselect Keyframes');
          app.changed('doc');
        }
      },
      (start) => this.boxGesture(start, (r, mode) => this.boxSelect(r, mode)),
    );
  }

  boxSelect(r: { x0: number; y0: number; x1: number; y1: number }, mode: 'SET' | 'ADD' | 'SUB') {
    if (!this.gpMode()) return super.boxSelect(r, mode);
    const all = this.frameSets();
    if (mode === 'SET') for (const f of this.allFrames()) f.select = false;
    const f0 = this.view.xf(r.x0),
      f1 = this.view.xf(r.x1);
    const i0 = this.rowAt(Math.max(RULER_H, r.y0)),
      i1 = this.rowAt(r.y1);
    for (let i = Math.max(0, i0); i <= i1 && i < this.list.rows.length; i++) {
      const ch = this.list.rows[i] as GPChannel;
      for (const f of rowFrames(ch.gpRow, all)) if (f.frame_number >= f0 && f.frame_number <= f1) f.select = mode !== 'SUB';
    }
    app.pushUndo('Box Select');
    app.changed('doc');
  }

  viewAll() {
    if (!this.gpMode()) return super.viewAll();
    const fr = this.allFrames().map((f) => f.frame_number);
    const s = app.doc.scene;
    if (fr.length) this.viewFrameRange(Math.min(...fr), Math.max(...fr, Math.min(...fr) + 1));
    else this.viewFrameRange(s.frame_start, s.frame_end);
  }

  viewSelected() {
    if (!this.gpMode()) return super.viewSelected();
    const fr = this.allFrames()
      .filter((f) => f.select)
      .map((f) => f.frame_number);
    if (!fr.length) return this.viewAll();
    this.viewFrameRange(Math.min(...fr), Math.max(...fr, Math.min(...fr) + 1));
  }
}

// ---------------------------------------------------------------------------
// moving keyframes (drag / G)

export function layersOf(ed: GPDopeSheet) {
  return ed.frameSets().flatMap((x) => x.gp.layers.map((l) => ({ gp: x.gp, layer: l })));
}

function moveFrames(ed: GPDopeSheet, startX: number, onCancel?: () => void) {
  const sel = ed.allFrames().filter((f) => f.select);
  if (!sel.length) return false;
  const orig = new Map(sel.map((f) => [f, f.frame_number]));
  let delta = 0;
  const apply = () => {
    for (const [f, n] of orig) f.frame_number = n + delta;
    ed.draw();
  };
  app.startModal({
    label: 'Move Keyframes',
    cursor: 'ew-resize',
    onPointerMove: (e) => {
      const d = Math.round((e.clientX - startX) / ed.view.ppf);
      if (d !== delta) {
        delta = d;
        apply();
        app.changed('frame');
      }
    },
    onPointerUp: () => 'FINISHED',
    onPointerDown: (e) => (e.button === 2 ? 'CANCELLED' : 'FINISHED'),
    onKey: (e) => (e.type !== 'keydown' ? true : e.key === 'Escape' ? 'CANCELLED' : e.key === 'Enter' ? 'FINISHED' : true),
    cancel: () => {
      delta = 0;
      apply();
      onCancel?.();
    },
    finish: () => {
      // a moved key replaces a key it lands on
      for (const { gp, layer } of layersOf(ed)) {
        const moved = new Set(layer.frames.filter((f) => orig.has(f)).map((f) => f.frame_number));
        layer.frames = layer.frames.filter((f) => orig.has(f) || !moved.has(f.frame_number));
        sortFrames(layer);
        compactDrawings(gp);
      }
    },
    header: () => `Time: ${delta > 0 ? '+' : ''}${delta} frames`,
  });
  return true;
}

// ---------------------------------------------------------------------------
// operators (act on the hovered Grease Pencil dope sheet)

const poll = (ctx: OpContext) => !!hoverGP(ctx);
const pollSel = (ctx: OpContext) =>
  !!hoverGP(ctx)
    ?.allFrames()
    .some((f) => f.select);

registerOperators([
  {
    idname: 'grease_pencil.frames_select_all',
    label: '(De)select All Keyframes',
    props: [
      {
        id: 'action',
        label: 'Action',
        type: 'enum',
        default: 'TOGGLE',
        items: [
          ['TOGGLE', 'Toggle'],
          ['SELECT', 'Select'],
          ['DESELECT', 'Deselect'],
          ['INVERT', 'Invert'],
        ],
      },
    ],
    poll,
    exec: (ctx, p) => {
      const all = hoverGP(ctx)!.allFrames();
      let a = p.action as string;
      if (a === 'TOGGLE') a = all.some((f) => f.select) ? 'DESELECT' : 'SELECT';
      for (const f of all) f.select = a === 'SELECT' ? true : a === 'DESELECT' ? false : !f.select;
    },
    redo: false,
  },
  {
    idname: 'grease_pencil.frames_delete',
    label: 'Delete Keyframes',
    poll: pollSel,
    exec: (ctx) => {
      for (const { gp, layer } of layersOf(hoverGP(ctx)!)) {
        layer.frames = layer.frames.filter((f) => !f.select);
        compactDrawings(gp);
      }
    },
  },
  {
    idname: 'grease_pencil.frames_duplicate_move',
    label: 'Duplicate Keyframes',
    poll: pollSel,
    invoke: (ctx) => {
      const ed = hoverGP(ctx)!;
      for (const { gp, layer } of layersOf(ed)) {
        const sel = layer.frames.filter((f) => f.select);
        for (const f of sel) {
          f.select = false;
          gp.drawings.push(copyDrawing(gp.drawings[f.drawing]));
          layer.frames.push({
            frame_number: f.frame_number,
            drawing: gp.drawings.length - 1,
            keyframe_type: f.keyframe_type,
            select: true,
          });
        }
      }
      app.changed('doc');
      if (!moveFrames(ed, ctx.event?.x ?? app.pointer.x)) return 'FINISHED';
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'grease_pencil.frames_move',
    label: 'Move Keyframes',
    poll: pollSel,
    invoke: (ctx) => (moveFrames(hoverGP(ctx)!, ctx.event?.x ?? app.pointer.x) ? 'RUNNING_MODAL' : 'CANCELLED'),
  },
  {
    idname: 'grease_pencil.frames_keyframe_type',
    label: 'Set Keyframe Type',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'KEYFRAME',
        items: KEY_TYPES,
      },
    ],
    poll: pollSel,
    exec: (ctx, p) => {
      for (const f of hoverGP(ctx)!.allFrames()) if (f.select) f.keyframe_type = p.type as GPKeyframeType;
    },
  },
  {
    idname: 'grease_pencil.frames_select_column',
    label: 'Select Column',
    description: 'Select all keyframes on the current frame',
    poll,
    exec: (ctx) => {
      const n = ctx.doc.scene.frame_current;
      for (const f of hoverGP(ctx)!.allFrames()) if (f.frame_number === n) f.select = true;
    },
  },
]);

export function gpSelectMenu(): MenuItem[] {
  return [
    { label: 'All', op: 'grease_pencil.frames_select_all', props: { action: 'SELECT' }, shortcut: 'A' },
    { label: 'None', op: 'grease_pencil.frames_select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
    { label: 'Invert', op: 'grease_pencil.frames_select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
    { separator: true },
    { label: 'Box Select', op: 'action.select_box', shortcut: 'B' },
    { separator: true },
    { label: 'Columns on Selected Keys', op: 'grease_pencil.frames_select_column_keys', shortcut: 'K' },
    { label: 'Column on Current Frame', op: 'grease_pencil.frames_select_column', shortcut: 'Ctrl K' },
    { separator: true },
    { label: 'Before Current Frame', op: 'grease_pencil.frames_select_leftright', props: { mode: 'LEFT' }, shortcut: '[' },
    { label: 'After Current Frame', op: 'grease_pencil.frames_select_leftright', props: { mode: 'RIGHT' }, shortcut: ']' },
    { separator: true },
    { label: 'More', op: 'grease_pencil.frames_select_more', shortcut: 'Ctrl Numpad +' },
    { label: 'Less', op: 'grease_pencil.frames_select_less', shortcut: 'Ctrl Numpad -' },
    { label: 'Select Linked', op: 'grease_pencil.frames_select_linked', shortcut: 'L' },
  ];
}

export function gpKeyMenu(): MenuItem[] {
  return [
    {
      label: 'Transform',
      submenu: () => [
        { label: 'Move', op: 'grease_pencil.frames_move', shortcut: 'G' },
        { label: 'Extend', op: 'grease_pencil.frames_extend', shortcut: 'E' },
        { label: 'Scale', op: 'grease_pencil.frames_scale', shortcut: 'S' },
      ],
    },
    {
      label: 'Snap',
      shortcut: 'Shift S',
      submenu: () => [
        { label: 'Selection to Current Frame', op: 'grease_pencil.frames_snap', props: { type: 'CFRA' } },
        { label: 'Selection to Nearest Marker', op: 'grease_pencil.frames_snap', props: { type: 'NEAREST_MARKER' } },
      ],
    },
    {
      label: 'Mirror',
      shortcut: 'Ctrl M',
      submenu: () => [
        { label: 'By Times Over Current Frame', op: 'grease_pencil.frames_mirror', props: { type: 'CFRA' } },
        { label: 'By Times Over First Selected Marker', op: 'grease_pencil.frames_mirror', props: { type: 'MARKER' } },
      ],
    },
    { separator: true },
    { label: 'Insert Blank Keyframe (Active Layer)', op: 'grease_pencil.insert_blank_frame', props: { all_layers: false }, shortcut: 'I' },
    { label: 'Insert Blank Keyframe (All Layers)', op: 'grease_pencil.insert_blank_frame', props: { all_layers: true } },
    { label: 'Jump to Keyframes', op: 'grease_pencil.frames_jump', shortcut: 'Ctrl G' },
    { separator: true },
    { label: 'Copy', op: 'grease_pencil.frames_copy', shortcut: 'Ctrl C' },
    { label: 'Paste', op: 'grease_pencil.frames_paste', shortcut: 'Ctrl V' },
    { label: 'Duplicate', op: 'grease_pencil.frames_duplicate_move', shortcut: 'Shift D' },
    { label: 'Delete Keyframes', op: 'grease_pencil.frames_delete', shortcut: 'X' },
    { separator: true },
    {
      label: 'Keyframe Type',
      submenu: () => KEY_TYPES.map(([t, l]) => ({ label: l, op: 'grease_pencil.frames_keyframe_type', props: { type: t } })),
      shortcut: 'R',
    },
    { separator: true },
    { label: 'Interpolate Sequence', op: 'grease_pencil.interpolate_sequence' },
    { label: 'Delete Breakdown Frames', op: 'grease_pencil.delete_breakdown' },
    { label: 'Delete Duplicate Frames', op: 'grease_pencil.frame_clean_duplicate', props: { selected: true } },
  ];
}

addKeys('Dopesheet Grease Pencil', [
  {
    key: 'A',
    op: 'grease_pencil.frames_select_all',
    props: { action: 'SELECT' },
  },
  {
    key: 'A',
    alt: true,
    op: 'grease_pencil.frames_select_all',
    props: { action: 'DESELECT' },
  },
  {
    key: 'I',
    ctrl: true,
    op: 'grease_pencil.frames_select_all',
    props: { action: 'INVERT' },
  },
  { key: 'K', ctrl: true, op: 'grease_pencil.frames_select_column' },
  { key: 'X', op: 'grease_pencil.frames_delete' },
  { key: 'DEL', op: 'grease_pencil.frames_delete' },
  { key: 'D', shift: true, op: 'grease_pencil.frames_duplicate_move' },
  { key: 'G', op: 'grease_pencil.frames_move' },
  {
    key: 'R',
    menu: () =>
      KEY_TYPES.map(([t, l]) => ({
        label: l,
        op: 'grease_pencil.frames_keyframe_type',
        props: { type: t },
      })),
    menuTitle: 'Set Keyframe Type',
  },
  { key: 'I', op: 'grease_pencil.insert_blank_frame' },
]);

registerEditor({
  id: 'DOPESHEET',
  label: 'Dope Sheet',
  icon: 'action',
  group: 'Animation',
  create: (a, s) => new GPDopeSheet(a, s),
});

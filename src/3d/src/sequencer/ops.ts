// Sequencer operators: selection, editing, meta strips, view, adding strips.
import { app, registerOperators, operators, type Operator } from '../app/app';
import type { Strip, StripType, ModifierType } from './types';
import * as S from './strips';
import { seqEditor, seqList, seqChannels, selectedStrips, activeStrip, setActive, isLocked, toolSettings, afterEdit, hoverSeq, hasEditor, overPreview } from './context';
import { startSlide, startExtend, startSlip, previewStrips, slideBy, slipBy, extendBy } from './transform';
import { startPreviewTransform, transformPreview, type PreviewMode } from './pvtransform';
import { addEffect, addScene, addMovie, addSound, addImages, pickFiles, ACCEPT, DEFAULT_LENGTH, fitScale } from './add';
import { restartPlayback } from './audio';
import { promptText } from '../ui/menu';
import { clearMovieCaches } from './media';
import { connectedOf, remapConnections } from './connect';

const anySeq = () => hasEditor() && seqList().length > 0;
const anySelected = () => hasEditor() && seqList().some((s) => s.select);
const inSeq = () => !!hoverSeq();

function done(label?: string) {
  afterEdit();
  restartPlayback();
  void label;
}

/** Where new strips go: the playhead and the channel under the pointer (or 1). */
export function insertPoint(): [number, number] {
  const ed = hoverSeq();
  const frame = app.doc.scene.frame_current;
  let channel = 1;
  if (ed && ed.hover === 'timeline') channel = Math.max(1, Math.floor(ed.pointerChannel(app.pointer.y)));
  return [frame, channel];
}

function deselectAll(list = seqList()) {
  for (const s of list) {
    s.select = false;
    s.select_left_handle = s.select_right_handle = false;
  }
}

/** Click selection in the timeline (sequencer.select). Connected strips follow unless ignored. */
export function selectStrip(s: Strip | null, opts: { extend?: boolean; toggle?: boolean; handle?: 'LEFT' | 'RIGHT' | null; deselectAll?: boolean; ignoreConnections?: boolean } = {}) {
  const list = seqList();
  if (!s) {
    if (opts.deselectAll !== false && !opts.extend && !opts.toggle) {
      deselectAll(list);
      setActive(null);
    }
    return;
  }
  const linked = opts.ignoreConnections ? [] : connectedOf(list, s);
  if (opts.toggle) {
    if (s.select && !opts.handle) {
      for (const x of [s, ...linked]) {
        x.select = false;
        x.select_left_handle = x.select_right_handle = false;
      }
      if (activeStrip() === s) setActive(null);
      return;
    }
  } else if (!opts.extend) deselectAll(list);
  s.select = true;
  s.select_left_handle = opts.handle === 'LEFT' || (!!opts.toggle && s.select_left_handle);
  s.select_right_handle = opts.handle === 'RIGHT' || (!!opts.toggle && s.select_right_handle);
  if (!opts.handle) s.select_left_handle = s.select_right_handle = false;
  for (const c of linked) {
    c.select = true;
    if (!opts.handle) c.select_left_handle = c.select_right_handle = false;
    // connected strips sharing the clicked edge are trimmed together
    else if (opts.handle === 'LEFT' && S.finalStart(c) === S.finalStart(s)) c.select_left_handle = true;
    else if (opts.handle === 'RIGHT' && S.finalEnd(c) === S.finalEnd(s)) c.select_right_handle = true;
  }
  setActive(s);
}

function duplicate(list: Strip[], src: Strip[]): Strip[] {
  const ed = seqEditor();
  const taken = new Set(S.allStrips(ed.strips).map((s) => s.name));
  const rename = new Map<string, string>();
  const out: Strip[] = [];
  const cloneDeep = (s: Strip): Strip => {
    const name = S.uniqueName(ed, s.name, taken);
    taken.add(name);
    rename.set(s.name, name);
    const c = S.cloneStrip(s, name);
    if (c.strips) c.strips = (s.strips ?? []).map(cloneDeep);
    return c;
  };
  for (const s of src) out.push(cloneDeep(s));
  remapConnections(out, rename);
  // effects duplicated together with their inputs use the copies
  const fix = (l: Strip[]) => {
    for (const c of l) {
      if (c.input_1 && rename.has(c.input_1)) c.input_1 = rename.get(c.input_1)!;
      if (c.input_2 && rename.has(c.input_2)) c.input_2 = rename.get(c.input_2)!;
      if (c.strips) fix(c.strips);
    }
  };
  fix(out);
  for (const s of src) s.select = false;
  for (const c of out) c.select = true;
  list.push(...out);
  if (out.length) setActive(out[out.length - 1]);
  return out;
}

function removeStrips(list: Strip[], strips: Strip[]) {
  const names = new Set(strips.map((s) => s.name));
  const dead = new Set<Strip>([...strips, ...S.dependentEffects(list, names).filter((e) => list.includes(e))]);
  for (const s of dead) {
    const i = list.indexOf(s);
    if (i >= 0) list.splice(i, 1);
  }
  const ed = seqEditor();
  if (ed.active_strip && !S.findStrip(ed.strips, ed.active_strip)) ed.active_strip = null;
  return dead.size;
}

let clipboard: { strips: Strip[]; frame: number } | null = null;

const ops: Operator[] = [
  // ------------------------------------------------------------------ selection
  {
    idname: 'sequencer.select_all',
    label: '(De)select All',
    description: 'Select or deselect all strips',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] }],
    poll: anySeq,
    exec: (_c, p) => {
      const list = seqList();
      let a = p.action as string;
      if (a === 'TOGGLE') a = list.some((s) => s.select) ? 'DESELECT' : 'SELECT';
      for (const s of list) {
        s.select = a === 'SELECT' ? true : a === 'DESELECT' ? false : !s.select;
        s.select_left_handle = s.select_right_handle = false;
      }
    },
  },
  {
    idname: 'sequencer.select_box',
    label: 'Box Select',
    description: 'Select strips using box selection',
    props: [
      { id: 'mode', label: 'Mode', type: 'enum', default: 'SET', items: [['SET', 'Set'], ['ADD', 'Extend'], ['SUB', 'Subtract']] },
      { id: 'include_handles', label: 'Select Handles', type: 'bool', default: false },
      { id: 'ignore_connections', label: 'Ignore Connections', type: 'bool', default: false },
    ],
    poll: () => anySeq() && inSeq(),
    undo: false,
    invoke: (_c, p) => {
      const ed = hoverSeq();
      if (!ed) return 'CANCELLED';
      ed.startBoxSelect({ clientX: app.pointer.x, clientY: app.pointer.y }, p.mode as 'SET', false, { includeHandles: !!p.include_handles, ignoreConnections: !!p.ignore_connections });
      return 'CANCELLED';
    },
  },
  {
    idname: 'sequencer.select_side_of_frame',
    label: 'Select Side of Frame',
    description: 'Select strips relative to the current frame',
    props: [
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
      { id: 'side', label: 'Side', type: 'enum', default: 'LEFT', items: [['LEFT', 'Left'], ['RIGHT', 'Right'], ['CURRENT', 'Current Frame']] },
    ],
    poll: anySeq,
    exec: (c, p) => {
      const f = c.doc.scene.frame_current;
      const list = seqList();
      if (!p.extend) deselectAll(list);
      for (const s of list) {
        const hit = p.side === 'LEFT' ? S.finalEnd(s) <= f : p.side === 'RIGHT' ? S.finalStart(s) >= f : S.activeAt(s, f);
        if (hit) s.select = true;
      }
    },
  },
  {
    idname: 'sequencer.select_grouped',
    label: 'Select Grouped',
    description: 'Select all strips grouped by various properties',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'TYPE',
        items: [
          ['TYPE', 'Type'],
          ['TYPE_BASIC', 'Global Type'],
          ['TYPE_EFFECT', 'Effect Type'],
          ['DATA', 'Data'],
          ['EFFECT', 'Effect'],
          ['EFFECT_LINK', 'Effect/Linked'],
          ['OVERLAP', 'Overlap'],
        ],
      },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
      { id: 'use_active_channel', label: 'Same Channel', type: 'bool', default: false },
    ],
    poll: () => !!activeStrip(),
    exec: (_c, p) => {
      const act = activeStrip()!;
      const list = seqList();
      const basic = (t: StripType) => (S.inputCount(t) ? 'EFFECT' : t === 'SOUND' ? 'SOUND' : 'VISUAL');
      const test = (s: Strip): boolean => {
        if (p.use_active_channel && s.channel !== act.channel) return false;
        switch (p.type) {
          case 'TYPE':
            return s.type === act.type;
          case 'TYPE_BASIC':
            return basic(s.type) === basic(act.type);
          case 'TYPE_EFFECT':
            return !!S.inputCount(s.type);
          case 'DATA':
            return !!act.media && s.media?.bytes === act.media.bytes;
          case 'EFFECT':
            return s.input_1 === act.name || s.input_2 === act.name;
          case 'EFFECT_LINK':
            return s === act || s.input_1 === act.name || s.input_2 === act.name || act.input_1 === s.name || act.input_2 === s.name;
          case 'OVERLAP':
            return S.rangesOverlap(S.finalStart(s), S.finalEnd(s), S.finalStart(act), S.finalEnd(act));
        }
        return false;
      };
      if (!p.extend) deselectAll(list);
      for (const s of list) if (test(s)) s.select = true;
      act.select = true;
    },
  },
  // ------------------------------------------------------------------ editing
  {
    idname: 'sequencer.split',
    label: 'Split Strips',
    description: 'Split the selected strips in two',
    props: [
      { id: 'frame', label: 'Frame', type: 'int', default: 0 },
      { id: 'channel', label: 'Channel', type: 'int', default: 0 },
      { id: 'type', label: 'Type', type: 'enum', default: 'SOFT', items: [['SOFT', 'Soft'], ['HARD', 'Hard']] },
      { id: 'use_cursor_position', label: 'Use Cursor Position', type: 'bool', default: false },
      { id: 'side', label: 'Side', type: 'enum', default: 'MOUSE', items: [['MOUSE', 'Mouse Position'], ['LEFT', 'Left'], ['RIGHT', 'Right'], ['BOTH', 'Both'], ['NO_CHANGE', 'No Change']] },
      { id: 'ignore_selection', label: 'Ignore Selection', type: 'bool', default: false },
    ],
    poll: anySeq,
    invoke: (c, p) => {
      const ed = hoverSeq();
      const props = { ...p };
      if (!p.use_cursor_position || !ed) props.frame = c.doc.scene.frame_current;
      else {
        props.frame = Math.round(ed.pointerFrame(app.pointer.x));
        props.channel = Math.floor(ed.pointerChannel(app.pointer.y));
      }
      if (props.side === 'MOUSE') props.side = ed && ed.hover === 'timeline' ? (ed.pointerFrame(app.pointer.x) >= (props.frame as number) ? 'RIGHT' : 'LEFT') : 'RIGHT';
      return app.run('sequencer.split', props, { invoke: false }) === 'FINISHED' ? 'CANCELLED' : 'CANCELLED';
    },
    exec: (c, p) => {
      const list = seqList();
      const f = p.frame as number;
      let targets = p.ignore_selection || p.use_cursor_position ? list.filter((s) => S.activeAt(s, f) && (!p.channel || s.channel === p.channel)) : list.filter((s) => s.select);
      if (!p.ignore_selection && !p.use_cursor_position && !targets.length) targets = list.filter((s) => S.activeAt(s, f));
      targets = targets.filter((s) => !isLocked(s));
      const right = S.splitStrips(seqEditor(), list, targets, f, p.type as 'SOFT');
      if (!right.length) return 'CANCELLED';
      const left = targets.filter((s) => S.finalEnd(s) === f);
      if (p.side === 'LEFT' || p.side === 'RIGHT' || p.side === 'BOTH') {
        deselectAll(list);
        if (p.side !== 'RIGHT') left.forEach((s) => (s.select = true));
        if (p.side !== 'LEFT') right.forEach((s) => (s.select = true));
        if (p.side === 'RIGHT') setActive(right[0]);
      }
      void c;
      done();
    },
  },
  {
    idname: 'sequencer.delete',
    label: 'Delete Strips',
    description: 'Delete selected strips from the sequencer',
    poll: anySelected,
    exec: () => {
      const list = seqList();
      const sel = list.filter((s) => s.select && !isLocked(s));
      if (!sel.length) return 'CANCELLED';
      const n = removeStrips(list, sel);
      app.report('INFO', `Deleted ${n} strip${n === 1 ? '' : 's'}`);
      done();
    },
  },
  {
    idname: 'sequencer.duplicate',
    label: 'Duplicate Strips',
    description: 'Duplicate the selected strips',
    poll: anySelected,
    exec: () => {
      const list = seqList();
      duplicate(list, list.filter((s) => s.select));
      done();
    },
  },
  {
    idname: 'sequencer.duplicate_move',
    label: 'Duplicate Strips',
    description: 'Duplicate selected strips and move them',
    poll: anySelected,
    invoke: () => {
      const ed = hoverSeq();
      const list = seqList();
      const src = list.filter((s) => s.select);
      const copies = duplicate(list, src);
      afterEdit();
      if (!ed || !startSlide(ed, app.pointer.x, app.pointer.y, {
        label: 'Duplicate Strips',
        redoOp: 'sequencer.duplicate_move',
        onCancel: () => {
          // cancelling the move keeps the copies in place, resolving overlap
          S.resolveOverlap(list, copies, toolSettings().overlap_mode);
          afterEdit();
          app.pushUndo('Duplicate Strips');
        },
      })) {
        S.resolveOverlap(list, copies, toolSettings().overlap_mode);
        afterEdit();
        return 'FINISHED';
      }
      return 'RUNNING_MODAL';
    },
    props: [{ id: 'value', label: 'Offset', type: 'vec2', default: [0, 0], precision: 0 }],
    exec: (_c, p) => {
      const list = seqList();
      const copies = duplicate(list, list.filter((s) => s.select));
      const v = (p.value as number[]) ?? [0, 0];
      if (v[0] || v[1]) slideBy(Math.round(v[0]), Math.round(v[1]));
      else S.resolveOverlap(list, copies, toolSettings().overlap_mode);
      done();
    },
  },
  {
    idname: 'sequencer.preview_duplicate_move',
    label: 'Duplicate Strips',
    description: 'Duplicate the selected strips and move their images in the preview',
    poll: () => anySelected() && overPreview(),
    invoke: () => {
      const list = seqList();
      duplicate(list, list.filter((s) => s.select));
      S.resolveOverlap(list, list.filter((s) => s.select), toolSettings().overlap_mode);
      afterEdit();
      return startPreviewTransform(hoverSeq()!, 'TRANSLATE', app.pointer.x, app.pointer.y) ? 'RUNNING_MODAL' : 'FINISHED';
    },
  },
  {
    idname: 'sequencer.mute',
    label: 'Mute Strips',
    description: 'Mute (un)selected strips',
    props: [{ id: 'unselected', label: 'Unselected', type: 'bool', default: false }],
    poll: anySeq,
    exec: (_c, p) => {
      for (const s of seqList()) if (s.select !== !!p.unselected && !isLocked(s)) s.mute = true;
      done();
    },
  },
  {
    idname: 'sequencer.unmute',
    label: 'Unmute Strips',
    description: 'Unmute (un)selected strips',
    props: [{ id: 'unselected', label: 'Unselected', type: 'bool', default: false }],
    poll: anySeq,
    exec: (_c, p) => {
      for (const s of seqList()) if (s.select !== !!p.unselected && !isLocked(s)) s.mute = false;
      done();
    },
  },
  {
    idname: 'sequencer.lock',
    label: 'Lock Strips',
    description: 'Lock strips so they cannot be transformed',
    poll: anySelected,
    exec: () => {
      for (const s of seqList()) if (s.select) s.lock = true;
    },
  },
  {
    idname: 'sequencer.unlock',
    label: 'Unlock Strips',
    description: 'Unlock strips so they can be transformed',
    poll: anySelected,
    exec: () => {
      for (const s of seqList()) if (s.select) s.lock = false;
    },
  },
  {
    idname: 'sequencer.snap',
    label: 'Snap Strips to the Current Frame',
    description: 'Frame where selected strips will be snapped',
    props: [{ id: 'frame', label: 'Frame', type: 'int', default: 0 }],
    poll: anySelected,
    invoke: (c) => app.run('sequencer.snap', { frame: c.doc.scene.frame_current }, { invoke: false }),
    exec: (_c, p) => {
      const list = seqList();
      const moved = list.filter((s) => s.select && !isLocked(s) && !S.inputCount(s.type));
      for (const s of moved) S.translateStrip(s, (p.frame as number) - S.finalStart(s));
      S.resolveOverlap(list, moved, toolSettings().overlap_mode);
      done();
    },
  },
  {
    idname: 'sequencer.offset_clear',
    label: 'Clear Strip Offset',
    description: 'Clear strip in/out offsets from the start and end of content',
    poll: anySelected,
    exec: () => {
      const list = seqList();
      const sel = list.filter((s) => s.select && !isLocked(s) && !S.isStill(s));
      for (const s of sel) s.frame_offset_start = s.frame_offset_end = 0;
      S.resolveOverlap(list, sel, toolSettings().overlap_mode);
      done();
    },
  },
  {
    idname: 'sequencer.gap_remove',
    label: 'Remove Gaps',
    description: 'Remove gap at current frame to first strip at the right, independent of selection or locked state of strips',
    props: [{ id: 'all', label: 'All Gaps', type: 'bool', default: false }],
    poll: anySeq,
    exec: (c, p) => (S.gapRemove(seqList(), c.doc.scene.frame_current, !!p.all) ? done() : 'CANCELLED'),
  },
  {
    idname: 'sequencer.gap_insert',
    label: 'Insert Gaps',
    description: 'Insert gap at current frame to first strips at the right, independent of selection or locked state of strips',
    props: [{ id: 'frames', label: 'Frames', type: 'int', default: 10, min: 0 }],
    poll: anySeq,
    exec: (c, p) => {
      S.gapInsert(seqList(), c.doc.scene.frame_current, p.frames as number);
      done();
    },
  },
  {
    idname: 'sequencer.swap',
    label: 'Swap Strip',
    description: 'Swap active strip with strip to the right or left',
    props: [{ id: 'side', label: 'Side', type: 'enum', default: 'RIGHT', items: [['LEFT', 'Left'], ['RIGHT', 'Right']] }],
    poll: () => !!activeStrip(),
    exec: (_c, p) => {
      const act = activeStrip()!;
      const list = seqList().filter((s) => s.channel === act.channel && s !== act);
      const other = p.side === 'RIGHT' ? list.filter((s) => S.finalStart(s) >= S.finalEnd(act)).sort((a, b) => S.finalStart(a) - S.finalStart(b))[0] : list.filter((s) => S.finalEnd(s) <= S.finalStart(act)).sort((a, b) => S.finalEnd(b) - S.finalEnd(a))[0];
      if (!other || isLocked(other) || isLocked(act)) return 'CANCELLED';
      const [l, r] = p.side === 'RIGHT' ? [act, other] : [other, act];
      const gap = S.finalStart(r) - S.finalEnd(l);
      const ls = S.finalStart(l);
      S.translateStrip(r, ls - S.finalStart(r));
      S.translateStrip(l, S.finalEnd(r) + gap - S.finalStart(l));
      done();
    },
  },
  {
    idname: 'sequencer.strip_jump',
    label: 'Jump to Strip',
    description: 'Move frame to previous edit point',
    props: [
      { id: 'next', label: 'Next Strip', type: 'bool', default: true },
      { id: 'center', label: 'Use Strip Center', type: 'bool', default: true },
    ],
    poll: anySeq,
    undo: false,
    exec: (c, p) => {
      const f = c.doc.scene.frame_current;
      const pts = new Set<number>();
      for (const s of seqList()) {
        if (p.center) pts.add(Math.floor((S.finalStart(s) + S.finalEnd(s)) / 2));
        else {
          pts.add(S.finalStart(s));
          pts.add(S.finalEnd(s));
        }
      }
      const sorted = [...pts].sort((a, b) => a - b);
      const t = p.next ? sorted.find((x) => x > f) : [...sorted].reverse().find((x) => x < f);
      if (t === undefined) {
        app.report('INFO', 'No more strips');
        return 'CANCELLED';
      }
      app.setFrame(t);
    },
  },
  {
    idname: 'sequencer.images_separate',
    label: 'Separate Images',
    description: 'On image sequence strips, it returns a strip for each image',
    props: [{ id: 'length', label: 'Length', type: 'int', default: 1, min: 1 }],
    poll: () => selectedStrips().some((s) => s.type === 'IMAGE' && (s.elements?.length ?? 0) > 1),
    exec: (_c, p) => {
      const list = seqList();
      const ed = seqEditor();
      for (const s of list.filter((x) => x.select && x.type === 'IMAGE' && (x.elements?.length ?? 0) > 1)) {
        const els = s.elements!;
        const step = p.length as number;
        const a = S.finalStart(s),
          b = S.finalEnd(s);
        list.splice(list.indexOf(s), 1);
        let f = a;
        for (let fr = a; fr < b; fr++) {
          const el = els[S.contentFrame(s, fr) - s.animation_offset_start] ?? els[0];
          const n = S.cloneStrip(s, S.uniqueName(ed, el.filename));
          Object.assign(n, { elements: [el], frame_start: f, frame_duration: step, frame_offset_start: 0, frame_offset_end: 0, animation_offset_start: 0, animation_offset_end: 0 });
          list.push(n);
          f += step;
        }
      }
      done();
    },
  },
  {
    idname: 'sequencer.reassign_inputs',
    label: 'Reassign Inputs',
    description: 'Reassign the inputs for the effect strip',
    poll: () => !!activeStrip() && !!S.inputCount(activeStrip()!.type),
    exec: () => {
      const act = activeStrip()!;
      const n = S.inputCount(act.type);
      const sel = seqList().filter((s) => s.select && s !== act && s.type !== 'SOUND').sort((a, b) => a.channel - b.channel);
      if (sel.length < n) {
        app.report('ERROR', n === 1 ? 'Need one selected strip' : 'Need two selected strips');
        return 'CANCELLED';
      }
      // an effect cannot use itself (directly or through other effects)
      const deps = new Set(S.dependentEffects(seqList(), new Set([act.name])).map((s) => s.name));
      if (sel.slice(0, n).some((s) => deps.has(s.name))) {
        app.report('ERROR', 'Cannot reassign inputs: strip would use itself');
        return 'CANCELLED';
      }
      act.input_1 = sel[0].name;
      act.input_2 = n > 1 ? sel[1].name : null;
      done();
    },
  },
  {
    idname: 'sequencer.swap_inputs',
    label: 'Swap Inputs',
    description: 'Swap the two inputs of the effect strip',
    poll: () => !!activeStrip() && S.inputCount(activeStrip()!.type) === 2,
    exec: () => {
      const act = activeStrip()!;
      [act.input_1, act.input_2] = [act.input_2 ?? null, act.input_1 ?? null];
      done();
    },
  },
  {
    idname: 'sequencer.copy',
    label: 'Copy',
    description: 'Copy the selected strips to the internal clipboard',
    poll: anySelected,
    undo: false,
    exec: () => {
      const sel = selectedStrips();
      clipboard = { strips: sel.map((s) => S.cloneStrip(s, s.name)), frame: Math.min(...sel.map(S.finalStart)) };
      app.report('INFO', `Copied ${sel.length} strip${sel.length === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'sequencer.paste',
    label: 'Paste',
    description: 'Paste strips from the internal clipboard',
    props: [{ id: 'keep_offset', label: 'Keep Offset', type: 'bool', default: false }],
    poll: () => !!clipboard,
    exec: (c, p) => {
      const list = seqList();
      deselectAll(list);
      const copies = duplicate(list, clipboard!.strips);
      if (!p.keep_offset) for (const s of copies) S.translateStrip(s, c.doc.scene.frame_current - clipboard!.frame);
      S.updateEffectRanges(list);
      S.resolveOverlap(list, copies, toolSettings().overlap_mode);
      done();
    },
  },
  // ------------------------------------------------------------------ meta strips
  {
    idname: 'sequencer.meta_make',
    label: 'Make Meta Strip',
    description: 'Group selected strips into a meta-strip',
    poll: anySelected,
    exec: () => {
      const list = seqList();
      const m = S.makeMeta(seqEditor(), list, list.filter((s) => s.select));
      if (!m) return 'CANCELLED';
      deselectAll(list);
      m.select = true;
      setActive(m);
      done();
    },
  },
  {
    idname: 'sequencer.meta_separate',
    label: 'UnMeta Strip',
    description: 'Put the contents of a meta-strip back in the sequencer',
    poll: () => selectedStrips().some((s) => s.type === 'META'),
    exec: () => {
      const list = seqList();
      for (const m of list.filter((s) => s.select && s.type === 'META')) S.separateMeta(list, m, toolSettings().overlap_mode);
      done();
    },
  },
  {
    idname: 'sequencer.meta_toggle',
    label: 'Toggle Meta Strip',
    description: 'Toggle a meta-strip (to edit enclosed strips)',
    poll: () => hasEditor() && (activeStrip()?.type === 'META' || seqEditor().meta_stack.length > 0),
    exec: () => {
      const ed = seqEditor();
      const act = activeStrip();
      if (act?.type === 'META' && seqList().includes(act)) {
        ed.meta_stack.push(act.name);
        setActive(null);
      } else {
        const name = ed.meta_stack.pop();
        afterEdit();
        const m = name ? S.findStrip(ed.strips, name) : null;
        if (m) {
          // the meta follows its edited content
          S.updateMetaBounds(m);
          deselectAll();
          m.select = true;
          setActive(m);
        }
      }
      hoverSeq()?.viewAll();
    },
  },
  // ------------------------------------------------------------------ view
  { idname: 'sequencer.view_all', label: 'Frame All', description: 'View all the strips in the sequencer', undo: false, poll: inSeq, exec: () => hoverSeq()?.viewAll() },
  { idname: 'sequencer.view_selected', label: 'Frame Selected', description: 'Zoom the sequencer on the selected strips', undo: false, poll: inSeq, exec: () => hoverSeq()?.viewSelected() },
  { idname: 'sequencer.view_frame', label: 'Go to Current Frame', description: 'Move the view to the current frame', undo: false, poll: inSeq, exec: () => hoverSeq()?.viewFrame() },
  {
    idname: 'sequencer.view_all_preview',
    label: 'Fit Preview in Window',
    description: 'Zoom preview to fit in the area',
    undo: false,
    poll: inSeq,
    exec: () => hoverSeq()?.previewFit(),
  },
  {
    idname: 'sequencer.view_zoom_ratio',
    label: 'Sequencer View Zoom Ratio',
    description: 'Change zoom ratio of sequencer preview',
    props: [{ id: 'ratio', label: 'Ratio', type: 'float', default: 1 }],
    undo: false,
    poll: inSeq,
    exec: (_c, p) => hoverSeq()?.previewZoom(p.ratio as number),
  },
  {
    idname: 'sequencer.view_toggle',
    label: 'Sequencer/Preview',
    description: 'Toggle between sequencer and preview',
    undo: false,
    poll: inSeq,
    exec: () => {
      const ed = hoverSeq()!;
      ed.setView(ed.view === 'SEQUENCER' ? 'PREVIEW' : 'SEQUENCER');
    },
  },
  {
    idname: 'sequencer.set_range_to_strips',
    label: 'Set Range to Strips',
    description: 'Set the frame range to the selected strips start and end',
    props: [{ id: 'preview', label: 'Preview', type: 'bool', default: false }],
    poll: anySeq,
    exec: (c, p) => {
      const sel = selectedStrips().length ? selectedStrips() : seqList();
      const a = Math.min(...sel.map(S.finalStart)),
        b = Math.max(...sel.map(S.finalEnd)) - 1;
      const sc = c.doc.scene;
      if (p.preview) {
        sc.use_preview_range = true;
        sc.frame_preview_start = a;
        sc.frame_preview_end = b;
      } else {
        sc.frame_start = a;
        sc.frame_end = b;
      }
    },
  },
  {
    idname: 'sequencer.refresh_all',
    label: 'Refresh All',
    description: 'Refresh the sequencer editor (clears cached frames)',
    undo: false,
    exec: () => {
      clearMovieCaches();
      app.changed('doc');
    },
  },
  {
    idname: 'sequencer.rename_channel',
    label: 'Rename Channel',
    description: 'Rename the channel under the pointer',
    undo: false,
    poll: () => !!hoverSeq() && hasEditor(),
    invoke: () => {
      const ed = hoverSeq()!;
      const ch = Math.floor(ed.pointerChannel(app.pointer.y));
      renameChannel(ch);
      return 'CANCELLED';
    },
  },
  // ------------------------------------------------------------------ transforms
  {
    idname: 'transform.seq_slide',
    label: 'Sequence Slide',
    description: 'Slide a sequence strip in time',
    props: [{ id: 'value', label: 'Offset', type: 'vec2', default: [0, 0], precision: 0 }],
    poll: () => anySelected() && !!hoverSeq() && !overPreview(),
    invoke: () => {
      const ed = hoverSeq()!;
      return startSlide(ed, app.pointer.x, app.pointer.y) ? 'RUNNING_MODAL' : 'CANCELLED';
    },
    exec: (_c, p) => {
      const v = p.value as number[];
      return slideBy(Math.round(v[0] ?? 0), Math.round(v[1] ?? 0)) ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'sequencer.slip',
    label: 'Slip Strips',
    description: 'Slip the contents of selected strips',
    props: [{ id: 'offset', label: 'Offset', type: 'int', default: 0 }],
    poll: () => anySelected() && !!hoverSeq() && !overPreview(),
    invoke: () => (startSlip(hoverSeq()!, app.pointer.x) ? 'RUNNING_MODAL' : 'CANCELLED'),
    exec: (_c, p) => (slipBy(p.offset as number) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'sequencer.strip_transform',
    label: 'Transform Strip Image',
    description: 'Move, rotate or scale the selected strips in the preview',
    props: [
      { id: 'mode', label: 'Mode', type: 'enum', default: 'TRANSLATE', items: [['TRANSLATE', 'Move'], ['ROTATE', 'Rotate'], ['RESIZE', 'Scale'], ['ORIGIN', 'Move Origin']], hidden: true },
      { id: 'value', label: 'Value', type: 'vec3', default: [0, 0, 0] },
    ],
    poll: () => anySelected() && overPreview(),
    invoke: (_c, p) => (startPreviewTransform(hoverSeq()!, p.mode as PreviewMode, app.pointer.x, app.pointer.y) ? 'RUNNING_MODAL' : 'CANCELLED'),
    exec: (_c, p) => {
      const v = (p.value as number[]) ?? [0, 0, 0];
      const value = p.mode === 'RESIZE' ? [v[0] || 1, v[1] || 1] : p.mode === 'ROTATE' ? [v[0]] : [v[0], v[1]];
      return transformPreview(p.mode as PreviewMode, value) ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'sequencer.strip_transform_clear',
    label: 'Clear Strip Transform',
    description: 'Reset image transformation to default value',
    props: [{ id: 'property', label: 'Property', type: 'enum', default: 'ALL', items: [['POSITION', 'Position'], ['SCALE', 'Scale'], ['ROTATION', 'Rotation'], ['ALL', 'All']] }],
    poll: anySelected,
    exec: (c, p) => {
      const r = c.doc.scene.render;
      for (const s of selectedStrips()) {
        if (isLocked(s)) continue;
        const t = s.transform;
        if (p.property === 'POSITION' || p.property === 'ALL') t.offset_x = t.offset_y = 0;
        if (p.property === 'ROTATION' || p.property === 'ALL') t.rotation = 0;
        if (p.property === 'SCALE' || p.property === 'ALL') {
          const [sx, sy] = s.orig_width ? fitScale(s.orig_width, s.orig_height ?? 0, r.resolution_x, r.resolution_y) : [1, 1];
          t.scale_x = sx;
          t.scale_y = sy;
        }
      }
    },
  },
  {
    idname: 'sequencer.strip_transform_fit',
    label: 'Strip Transform Set Fit',
    description: 'Set the scale of the selected images to fit the render size',
    props: [{ id: 'fit_method', label: 'Fit Method', type: 'enum', default: 'FIT', items: [['FIT', 'Scale to Fit'], ['FILL', 'Scale to Fill'], ['STRETCH', 'Stretch to Fill'], ['ORIGINAL', 'Use Original Size']] }],
    poll: () => selectedStrips().some((s) => !!s.orig_width),
    exec: (c, p) => {
      const r = c.doc.scene.render;
      for (const s of selectedStrips()) {
        if (!s.orig_width || isLocked(s)) continue;
        const [sx, sy] = fitScale(s.orig_width, s.orig_height ?? 0, r.resolution_x, r.resolution_y, p.fit_method as 'FIT');
        s.transform.scale_x = sx;
        s.transform.scale_y = sy;
        s.transform.offset_x = s.transform.offset_y = 0;
        s.transform.rotation = 0;
      }
    },
  },
  // ------------------------------------------------------------------ adding
  {
    idname: 'sequencer.effect_strip_add',
    label: 'Add Effect Strip',
    description: 'Add an effect to the sequencer, most are applied on top of existing strips',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'CROSS',
        items: (['CROSS', 'ADD', 'SUBTRACT', 'ALPHA_OVER', 'ALPHA_UNDER', 'GAMMA_CROSS', 'MULTIPLY', 'WIPE', 'GLOW', 'TRANSFORM', 'COLOR', 'SPEED', 'ADJUSTMENT', 'GAUSSIAN_BLUR', 'TEXT', 'COLORMIX', 'MULTICAM'] as StripType[]).map((t) => [t, S.STRIP_LABELS[t]] as [string, string]),
      },
      { id: 'frame_start', label: 'Start Frame', type: 'int', default: 0 },
      { id: 'length', label: 'Length', type: 'int', default: DEFAULT_LENGTH, min: 1 },
      { id: 'channel', label: 'Channel', type: 'int', default: 1, min: 1, max: 128 },
      { id: 'color', label: 'Color', type: 'color', default: [0, 0, 0], showIf: (p) => p.type === 'COLOR' },
    ],
    invoke: (_c, p) => {
      const [frame, channel] = insertPoint();
      return app.run('sequencer.effect_strip_add', { ...p, frame_start: frame, channel }, { invoke: false });
    },
    exec: (_c, p) => {
      const r = addEffect(p.type as StripType, p.frame_start as number, p.channel as number, p.length as number, p.type === 'COLOR' ? (p.color as number[]) : undefined);
      if (typeof r === 'string') {
        app.report('ERROR', r);
        return 'CANCELLED';
      }
      done();
    },
  },
  {
    idname: 'sequencer.scene_strip_add',
    label: 'Add Scene Strip',
    description: 'Add a strip re-using this scene for the strip',
    props: [
      { id: 'frame_start', label: 'Start Frame', type: 'int', default: 0 },
      { id: 'channel', label: 'Channel', type: 'int', default: 1, min: 1, max: 128 },
      { id: 'camera', label: 'Camera', type: 'string', default: '' },
    ],
    invoke: (_c, p) => {
      const [frame, channel] = insertPoint();
      return app.run('sequencer.scene_strip_add', { ...p, frame_start: frame, channel }, { invoke: false });
    },
    exec: (_c, p) => {
      addScene(p.frame_start as number, p.channel as number, (p.camera as string) || null);
      done();
    },
  },
  ...(['movie', 'sound', 'image'] as const).map(
    (kind): Operator => ({
      idname: `sequencer.${kind}_strip_add`,
      label: kind === 'movie' ? 'Add Movie Strip' : kind === 'sound' ? 'Add Sound Strip' : 'Add Image Strip',
      description: kind === 'movie' ? 'Add a movie strip to the sequencer' : kind === 'sound' ? 'Add a sound strip to the sequencer' : 'Add an image or image sequence to the sequencer',
      undo: false,
      invoke: () => {
        const [frame, channel] = insertPoint();
        void pickFiles(ACCEPT[kind], kind === 'image').then((files) => addPicked(kind, files, frame, channel));
        return 'CANCELLED';
      },
    }),
  ),
  // ------------------------------------------------------------------ modifiers
  {
    idname: 'sequencer.strip_modifier_add',
    label: 'Add Strip Modifier',
    description: 'Add a modifier to the strip',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'COLOR_BALANCE', items: [['COLOR_BALANCE', 'Color Balance'], ['BRIGHT_CONTRAST', 'Brightness/Contrast'], ['WHITE_BALANCE', 'White Balance'], ['CURVES', 'Curves']] }],
    poll: () => !!activeStrip() && activeStrip()!.type !== 'SOUND',
    exec: (_c, p) => {
      const s = activeStrip()!;
      const base = p.type === 'COLOR_BALANCE' ? 'Color Balance' : p.type === 'WHITE_BALANCE' ? 'White Balance' : p.type === 'CURVES' ? 'Curves' : 'Brightness/Contrast';
      let name = base;
      for (let i = 1; s.modifiers.some((m) => m.name === name); i++) name = `${base}.${String(i).padStart(3, '0')}`;
      s.modifiers.push(S.newModifier(p.type as ModifierType, name));
      s.active_modifier = name;
    },
  },
  {
    idname: 'sequencer.strip_modifier_set_active',
    label: 'Set Active Modifier',
    description: 'Make a modifier of the active strip the active one',
    props: [{ id: 'modifier', label: 'Modifier', type: 'string', default: '' }],
    poll: () => !!activeStrip()?.modifiers.length,
    exec: (_c, p) => {
      const s = activeStrip()!;
      if (!s.modifiers.some((m) => m.name === p.modifier)) return 'CANCELLED';
      s.active_modifier = p.modifier as string;
    },
  },
  {
    idname: 'sequencer.strip_modifier_remove',
    label: 'Remove Strip Modifier',
    description: 'Remove a modifier from the strip',
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    poll: () => !!activeStrip()?.modifiers.length,
    exec: (_c, p) => {
      const s = activeStrip()!;
      const i = s.modifiers.findIndex((m) => m.name === p.name);
      if (i < 0) return 'CANCELLED';
      s.modifiers.splice(i, 1);
    },
  },
  {
    idname: 'sequencer.strip_modifier_move',
    label: 'Move Strip Modifier',
    description: 'Move modifier up and down in the stack',
    props: [
      { id: 'name', label: 'Name', type: 'string', default: '' },
      { id: 'direction', label: 'Type', type: 'enum', default: 'UP', items: [['UP', 'Up'], ['DOWN', 'Down']] },
    ],
    poll: () => (activeStrip()?.modifiers.length ?? 0) > 1,
    exec: (_c, p) => {
      const ms = activeStrip()!.modifiers;
      const i = ms.findIndex((m) => m.name === p.name);
      const j = p.direction === 'UP' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= ms.length) return 'CANCELLED';
      [ms[i], ms[j]] = [ms[j], ms[i]];
    },
  },
];

/** Time Extend uses the generic transform operator name. */
if (!operators.has('transform.transform'))
  ops.push({
    idname: 'transform.transform',
    label: 'Transform',
    description: 'Transform selected strips (Time Extend)',
    props: [
      { id: 'mode', label: 'Mode', type: 'enum', default: 'TIME_EXTEND', items: [['TIME_EXTEND', 'Time Extend']] },
      { id: 'value', label: 'Values', type: 'vec3', default: [0, 0, 0] },
    ],
    poll: () => anySelected() && !!hoverSeq() && !overPreview(),
    invoke: () => (startExtend(hoverSeq()!, app.pointer.x) ? 'RUNNING_MODAL' : 'CANCELLED'),
    exec: (c, p) => {
      const frame = typeof p.frame === 'number' ? p.frame : c.doc.scene.frame_current;
      return extendBy(Math.round((p.value as number[])[0] ?? 0), frame, p.side !== 'LEFT') ? 'FINISHED' : 'CANCELLED';
    },
  });

registerOperators(ops);

async function addPicked(kind: 'movie' | 'sound' | 'image', files: File[], frame: number, channel: number) {
  if (!files.length) return;
  try {
    if (kind === 'movie') for (const f of files) await addMovie(f, frame, channel);
    else if (kind === 'sound') for (const f of files) await addSound(f, frame, channel);
    else await addImages(files, frame, channel);
    app.pushUndo(kind === 'movie' ? 'Add Movie Strip' : kind === 'sound' ? 'Add Sound Strip' : 'Add Image Strip');
    app.changed('doc');
    done();
  } catch (e) {
    app.report('ERROR', `Cannot add ${kind}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function renameChannel(ch: number) {
  if (!(ch >= 1 && ch <= 128)) return;
  const chans = seqChannels();
  promptText('Rename Channel', chans[ch].name, (v) => {
    if (!v) return;
    chans[ch].name = v;
    app.pushUndo('Rename Channel');
    app.changed('doc');
  });
}

export { previewStrips, deselectAll, duplicate, removeStrips };

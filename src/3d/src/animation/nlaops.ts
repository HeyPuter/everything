// NLA strip operators: tweak mode (Tab / Shift+Tab), meta strips (Ctrl+G / Ctrl+Alt+G),
// transitions (Shift+T), duplicate / linked duplicate, swap (Alt+F), move up/down
// (Page Up/Down), apply scale (Ctrl+A), make single user (U), include selected objects
// and preview range from strips.
import { app, registerOperators, type OpContext, type Operator } from '../app/app';
import { addKeys } from '../app/keymap';
import type { NlaStrip, ObjectData } from '../data/types';
import { overMain } from './animeditor';
import { NlaEditor, type StripRef } from './nla';
import { actionUsers, makeMetas, removeMetas, addTransitions, swapStrips, applyStripScale, enterTweak, exitTweak, isClip } from './nlaedit';
import { copyAction, ensureAnimData, newTrack, sortStrips, stripFits } from './actionops';

function nlaEd(ctx: OpContext): NlaEditor | null {
  const ed = ctx.area?.editor;
  return ed instanceof NlaEditor ? ed : null;
}
const sel = (ctx: OpContext) => nlaEd(ctx)?.selectedStrips() ?? [];
const pollSel = (ctx: OpContext) => sel(ctx).length > 0;

// ---------------------------------------------------------------------------
// Operators

/** Objects listed in the editor, with their animation data. */
function listedObjects(ed: NlaEditor): ObjectData[] {
  return [...new Set(ed.list.rows.filter((r) => r.ob?.animation_data).map((r) => r.ob!))];
}
const tweaking = (ed: NlaEditor) => listedObjects(ed).some((o) => o.animation_data?.tweak);

function duplicate(ed: NlaEditor, linked: boolean): NlaStrip[] {
  const out: NlaStrip[] = [];
  for (const r of ed.selectedStrips()) {
    const c: NlaStrip = structuredClone({ ...r.strip, select: true });
    if (!linked && isClip(c)) {
      const a = app.doc.actions[c.action];
      if (a) c.action = copyAction(app.doc, a).id;
    }
    r.strip.select = false;
    const idx = r.ad.nla_tracks.indexOf(r.track);
    let target = r.ad.nla_tracks[idx + 1];
    if (!target || target.lock || !stripFits(target, c.frame_start, c.frame_end)) {
      target = newTrack(r.ad);
      r.ad.nla_tracks.splice(idx + 1, 0, target);
    }
    target.strips.push(c);
    sortStrips(target);
    out.push(c);
  }
  return out;
}

function duplicateMoveOp(idname: string, label: string, linked: boolean): Operator {
  return {
    idname,
    label,
    description: linked ? 'Duplicate the selected strips (sharing their actions) and move them' : 'Duplicate the selected strips with copies of their actions and move them',
    poll: pollSel,
    invoke: (ctx) => {
      const ed = nlaEd(ctx)!;
      if (!duplicate(ed, linked).length) return 'CANCELLED';
      ed.refresh();
      return ed.startTransform('TRANSLATION', { ...app.pointer }, false) ? 'RUNNING_MODAL' : 'FINISHED';
    },
    exec: (ctx) => {
      if (!duplicate(nlaEd(ctx)!, linked).length) return 'CANCELLED';
    },
  };
}

function tracksOf(refs: StripRef[]) {
  return [...new Set(refs.map((r) => r.track))];
}

const ops: Operator[] = [
  {
    idname: 'nla.tweakmode_enter',
    label: 'Enter Tweak Mode',
    description: 'Edit the action of the active strip in the Dope Sheet and Graph Editor',
    props: [
      { id: 'isolate_action', label: 'Isolate Action', type: 'bool', default: false },
      { id: 'use_upper_stack_evaluation', label: 'Evaluate Upper Stack', type: 'bool', default: false },
    ],
    poll: (ctx) => !!nlaEd(ctx) && !tweaking(nlaEd(ctx)!) && !!nlaEd(ctx)!.activeStripRef(),
    exec: (ctx, p) => {
      const ed = nlaEd(ctx)!;
      // one strip per object: the active strip, or each object's first selected strip
      const active = ed.activeStripRef();
      const per = new Map<ObjectData, StripRef>();
      if (active) per.set(active.ob, active);
      for (const r of ed.selectedStrips(true)) if (!per.has(r.ob)) per.set(r.ob, r);
      let n = 0;
      for (const r of per.values()) {
        const ti = r.ad.nla_tracks.indexOf(r.track),
          si = r.track.strips.indexOf(r.strip);
        if (enterTweak(ctx.doc, r.ad, ti, si, !!p.use_upper_stack_evaluation, !!p.isolate_action)) n++;
      }
      if (!n) {
        app.report('WARNING', 'No action strip to edit (select an action strip first)');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'nla.tweakmode_exit',
    label: 'Exit Tweak Mode',
    description: 'Stop editing the strip action and return to the NLA stack',
    props: [{ id: 'isolate_action', label: 'Isolate Action', type: 'bool', default: false }],
    poll: (ctx) => {
      const ed = nlaEd(ctx);
      return ed ? tweaking(ed) : Object.values(ctx.doc.objects).some((o) => o.animation_data?.tweak);
    },
    exec: (ctx, p) => {
      let n = 0;
      for (const o of Object.values(ctx.doc.objects)) if (o.animation_data && exitTweak(o.animation_data, !!p.isolate_action)) n++;
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'nla.duplicate',
    label: 'Duplicate Strips',
    description: 'Duplicate the selected strips into new tracks',
    props: [{ id: 'linked', label: 'Linked', type: 'bool', default: false }],
    poll: pollSel,
    exec: (ctx, p) => {
      if (!duplicate(nlaEd(ctx)!, !!p.linked).length) return 'CANCELLED';
    },
  },
  duplicateMoveOp('nla.duplicate_move', 'Duplicate', false),
  duplicateMoveOp('nla.duplicate_linked_move', 'Duplicate Linked', true),
  {
    idname: 'nla.meta_add',
    label: 'Add Meta-Strips',
    description: 'Group consecutive selected strips of each track into a meta strip',
    poll: pollSel,
    exec: (ctx) => {
      let n = 0;
      for (const t of tracksOf(sel(ctx))) n += makeMetas(t);
      if (!n) {
        app.report('WARNING', 'Select at least two neighbouring strips in a track');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'nla.meta_remove',
    label: 'Remove Meta-Strips',
    description: 'Separate the selected meta strips back into their strips',
    poll: (ctx) => sel(ctx).some((r) => r.strip.type === 'META'),
    exec: (ctx) => {
      let n = 0;
      for (const t of tracksOf(sel(ctx))) n += removeMetas(t);
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'nla.transition_add',
    label: 'Add Transition',
    description: 'Fill the gap between pairs of selected strips with a transition that blends from one to the other',
    poll: pollSel,
    exec: (ctx) => {
      let n = 0;
      for (const t of tracksOf(sel(ctx))) n += addTransitions(t);
      if (!n) {
        app.report('ERROR', 'Needs at least a pair of adjacent selected strips with a gap between them');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'nla.swap',
    label: 'Swap Strips',
    description: 'Swap the order of two selected strips in a track',
    poll: pollSel,
    exec: (ctx) => {
      let n = 0;
      for (const t of tracksOf(sel(ctx))) if (swapStrips(t)) n++;
      if (!n) {
        app.report('WARNING', 'Select exactly two strips in a track to swap them');
        return 'CANCELLED';
      }
    },
  },
  ...(['up', 'down'] as const).map(
    (dir): Operator => ({
      idname: `nla.move_${dir}`,
      label: dir === 'up' ? 'Move Strips Up' : 'Move Strips Down',
      description: `Move the selected strips to the track ${dir === 'up' ? 'above' : 'below'} when there is room`,
      poll: pollSel,
      exec: (ctx) => {
        let n = 0;
        for (const r of sel(ctx)) {
          const i = r.ad.nla_tracks.indexOf(r.track);
          const t = r.ad.nla_tracks[dir === 'up' ? i + 1 : i - 1];
          if (!t || t.lock || !stripFits(t, r.strip.frame_start, r.strip.frame_end)) continue;
          r.track.strips = r.track.strips.filter((s) => s !== r.strip);
          t.strips.push(r.strip);
          sortStrips(t);
          n++;
        }
        if (!n) return 'CANCELLED';
      },
    }),
  ),
  {
    idname: 'nla.apply_scale',
    label: 'Apply Scale',
    description: 'Bake the playback scale of the selected strips into their actions',
    poll: pollSel,
    exec: (ctx) => {
      let n = 0,
        shared = 0;
      for (const r of sel(ctx)) {
        if (!isClip(r.strip)) continue;
        const a = ctx.doc.actions[r.strip.action];
        if (!a) continue;
        if (actionUsers(ctx.doc, a.id) > 1) {
          shared++;
          continue;
        }
        if (applyStripScale(r.strip, a)) n++;
      }
      if (shared) app.report('WARNING', 'Strips sharing an action were skipped (make them single user first)');
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'nla.make_single_user',
    label: 'Make Single User',
    description: 'Give each selected strip its own copy of an action it shares with other users',
    props: [{ id: 'confirm', label: 'Confirm', type: 'bool', default: true, hidden: true }],
    poll: pollSel,
    exec: (ctx) => {
      let n = 0;
      for (const r of sel(ctx)) {
        if (!isClip(r.strip)) continue;
        const a = ctx.doc.actions[r.strip.action];
        if (!a || actionUsers(ctx.doc, a.id) < 2) continue;
        r.strip.action = copyAction(ctx.doc, a).id;
        n++;
      }
      if (!n) {
        app.report('INFO', 'The selected strips already use their own actions');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'nla.selected_objects_add',
    label: 'Include Selected Objects',
    description: 'Give the selected objects animation data so they are listed in the NLA editor',
    poll: (ctx) => !!nlaEd(ctx) && app.selectedObjects().length > 0,
    exec: (ctx) => {
      let n = 0;
      for (const o of app.selectedObjects()) {
        if (o.animation_data) continue;
        const ad = ensureAnimData(o);
        ad.nla_tracks.push(newTrack(ad));
        n++;
      }
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'nla.previewrange_set',
    label: 'Set Preview Range to Selected',
    description: 'Set the preview range to the extent of the selected strips',
    poll: pollSel,
    exec: (ctx) => {
      const r = sel(ctx);
      const s = ctx.doc.scene;
      s.use_preview_range = true;
      s.frame_preview_start = Math.floor(Math.min(...r.map((x) => x.strip.frame_start)));
      s.frame_preview_end = Math.ceil(Math.max(...r.map((x) => x.strip.frame_end)));
    },
  },
];

registerOperators(ops);

addKeys('NLA Editor', [
  { key: 'TAB', op: 'nla.tweakmode_enter', props: { use_upper_stack_evaluation: true } },
  { key: 'TAB', op: 'nla.tweakmode_exit' },
  { key: 'TAB', shift: true, op: 'nla.tweakmode_enter', props: { isolate_action: true } },
  { key: 'TAB', shift: true, op: 'nla.tweakmode_exit', props: { isolate_action: true } },
  { key: 'T', shift: true, op: 'nla.transition_add', when: overMain },
  { key: 'G', ctrl: true, op: 'nla.meta_add', when: overMain },
  { key: 'G', ctrl: true, alt: true, op: 'nla.meta_remove', when: overMain },
  { key: 'D', alt: true, op: 'nla.duplicate_move', when: overMain },
  { key: 'U', op: 'nla.make_single_user', when: overMain },
  { key: 'F', alt: true, op: 'nla.swap', when: overMain },
  { key: 'PAGE_UP', op: 'nla.move_up', when: overMain },
  { key: 'PAGE_DOWN', op: 'nla.move_down', when: overMain },
  { key: 'A', ctrl: true, op: 'nla.apply_scale', when: overMain },
  { key: 'P', ctrl: true, alt: true, op: 'nla.previewrange_set' },
]);

/** Whether an object is in NLA tweak mode (for editors that show it). */
export const inTweakMode = (ob: ObjectData | null | undefined) => !!ob?.animation_data?.tweak;

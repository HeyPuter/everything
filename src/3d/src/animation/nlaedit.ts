// Pure NLA strip editing helpers (meta strips, transitions, swap, apply scale, tweak
// mode bookkeeping), kept free of UI imports for unit testing.
import { isSlotted, stripSlot } from '../anim/slots';
import type { ActionData, AnimData, DocumentData, NlaStrip, NlaTrack } from '../data/types';
import { calcHandles } from '../anim/fcurve';
import { sortStrips } from './actionops';

export const isClip = (s: NlaStrip) => !s.type || s.type === 'CLIP';

function updateStripEnd(s: NlaStrip) {
  s.frame_end = s.frame_start + Math.max(1e-3, s.action_frame_end - s.action_frame_start) * Math.max(1e-3, s.scale) * Math.max(0.1, s.repeat);
}

/** Number of places an action is used (active action lines and strips, meta children included). */
export function actionUsers(doc: DocumentData, id: string): number {
  let n = 0;
  const visit = (strips: NlaStrip[]) => {
    for (const s of strips) {
      if (isClip(s) && s.action === id) n++;
      if (s.strips) visit(s.strips);
    }
  };
  for (const ob of Object.values(doc.objects)) {
    const ad = ob.animation_data;
    if (!ad) continue;
    if (ad.action === id && !ad.tweak) n++;
    for (const t of ad.nla_tracks) visit(t.strips);
  }
  return n;
}

/** Group consecutive selected strips of a track into meta strips. Returns metas made. */
export function makeMetas(track: NlaTrack): number {
  sortStrips(track);
  const out: NlaStrip[] = [];
  let run: NlaStrip[] = [];
  let made = 0;
  const flush = () => {
    if (run.length > 1) {
      const a = run[0].frame_start,
        b = run[run.length - 1].frame_end;
      out.push({
        name: 'NlaStrip',
        action: '',
        type: 'META',
        strips: run.map((s) => ({ ...s, select: false })),
        frame_start: a,
        frame_end: b,
        action_frame_start: a,
        action_frame_end: b,
        scale: 1,
        repeat: 1,
        blend_type: 'REPLACE',
        blend_in: 0,
        blend_out: 0,
        mute: false,
        select: true,
        extrapolation: run[run.length - 1].extrapolation,
      });
      made++;
    } else out.push(...run);
    run = [];
  };
  for (const s of track.strips) {
    if (s.select && s.type !== 'TRANSITION') run.push(s);
    else {
      flush();
      out.push(s);
    }
  }
  flush();
  track.strips = out;
  return made;
}

/** Ungroup selected meta strips, mapping their children back to scene time. */
export function removeMetas(track: NlaTrack): number {
  let n = 0;
  const out: NlaStrip[] = [];
  for (const s of track.strips) {
    if (s.type !== 'META' || !s.select || !s.strips) {
      out.push(s);
      continue;
    }
    const k = (s.frame_end - s.frame_start) / Math.max(1e-6, s.action_frame_end - s.action_frame_start);
    const map = (f: number) => s.frame_start + (f - s.action_frame_start) * k;
    for (const c of s.strips) {
      const len = c.frame_end - c.frame_start;
      c.frame_start = map(c.frame_start);
      c.frame_end = c.frame_start + len * k;
      if (isClip(c) && Math.abs(k - 1) > 1e-6) c.scale *= k;
      c.select = true;
      out.push(c);
    }
    n++;
  }
  track.strips = out;
  sortStrips(track);
  return n;
}

/** Add transitions between selected strips that have a gap between them. */
export function addTransitions(track: NlaTrack): number {
  sortStrips(track);
  let n = 0;
  const add: NlaStrip[] = [];
  for (let i = 0; i + 1 < track.strips.length; i++) {
    const a = track.strips[i],
      b = track.strips[i + 1];
    if (!a.select || !b.select || a.type === 'TRANSITION' || b.type === 'TRANSITION') continue;
    if (b.frame_start - a.frame_end < 1e-3) continue;
    add.push({
      name: 'Transition',
      action: '',
      type: 'TRANSITION',
      frame_start: a.frame_end,
      frame_end: b.frame_start,
      action_frame_start: 0,
      action_frame_end: 1,
      scale: 1,
      repeat: 1,
      blend_type: 'REPLACE',
      blend_in: 0,
      blend_out: 0,
      mute: false,
      select: false,
      extrapolation: 'NOTHING',
    });
    n++;
  }
  track.strips.push(...add);
  sortStrips(track);
  return n;
}

/** Swap two selected strips in a track (each takes the other's place). */
export function swapStrips(track: NlaTrack): boolean {
  sortStrips(track);
  const s = track.strips.filter((x) => x.select);
  if (s.length !== 2) return false;
  const [a, b] = s;
  const la = a.frame_end - a.frame_start,
    lb = b.frame_end - b.frame_start;
  const start = a.frame_start,
    end = b.frame_end;
  b.frame_start = start;
  b.frame_end = start + lb;
  a.frame_end = end;
  a.frame_start = end - la;
  sortStrips(track);
  return true;
}

/** Bake a strip's playback scale into its (single-user) action's keys. */
export function applyStripScale(strip: NlaStrip, action: ActionData) {
  const k = strip.scale;
  if (Math.abs(k - 1) < 1e-9) return false;
  const o = strip.action_frame_start;
  const m = (f: number) => o + (f - o) * k;
  for (const fc of action.fcurves) {
    for (const key of fc.keyframe_points) {
      key.co[0] = m(key.co[0]);
      key.handle_left[0] = m(key.handle_left[0]);
      key.handle_right[0] = m(key.handle_right[0]);
    }
    calcHandles(fc);
  }
  strip.action_frame_end = m(strip.action_frame_end);
  if (action.frame_range) action.frame_range = [m(action.frame_range[0]), m(action.frame_range[1])];
  strip.scale = 1;
  updateStripEnd(strip);
  return true;
}

/**
 * Shift an action's keys so a strip plays it without a time offset (keys line up with the
 * strip in the editors while tweaking). Other strips using the action follow the shift.
 */
export function alignActionToStrip(doc: DocumentData, strip: NlaStrip): boolean {
  const d = strip.frame_start - strip.action_frame_start;
  const action = doc.actions[strip.action];
  if (!action || Math.abs(d) < 1e-9 || Math.abs(strip.scale - 1) > 1e-9 || Math.abs(strip.repeat - 1) > 1e-9) return false;
  // keys can't move when the action is also played directly as an active action
  if (Object.values(doc.objects).some((o) => o.animation_data?.action === action.id && !o.animation_data.tweak)) return false;
  for (const fc of action.fcurves) {
    for (const k of fc.keyframe_points) {
      k.co[0] += d;
      k.handle_left[0] += d;
      k.handle_right[0] += d;
    }
  }
  if (action.frame_range) action.frame_range = [action.frame_range[0] + d, action.frame_range[1] + d];
  const visit = (strips: NlaStrip[]) => {
    for (const s of strips) {
      if (isClip(s) && s.action === action.id) {
        s.action_frame_start += d;
        s.action_frame_end += d;
      }
      if (s.strips) visit(s.strips);
    }
  };
  for (const ob of Object.values(doc.objects)) for (const t of ob.animation_data?.nla_tracks ?? []) visit(t.strips);
  return true;
}

export function enterTweak(doc: DocumentData, ad: AnimData, track: number, strip: number, upper: boolean, isolate: boolean): boolean {
  const s = ad.nla_tracks[track]?.strips[strip];
  if (!s || !isClip(s) || !doc.actions[s.action] || ad.tweak) return false;
  alignActionToStrip(doc, s);
  ad.tweak = { track, strip, prev_action: ad.action, upper, prev_slot: ad.action_slot_handle, prev_slot_action: ad.slot_action };
  // the edited action plays (and is keyed) through the strip's slot
  const act = doc.actions[s.action];
  const owner = Object.values(doc.objects).find((o) => o.animation_data === ad);
  ad.action = s.action;
  if (owner && isSlotted(act)) {
    const h = stripSlot(act, s, owner);
    ad.slot_action = act.id;
    ad.action_slot_handle = h ?? 0;
  }
  if (isolate) {
    for (const t of ad.nla_tracks) t.is_solo = false;
    ad.nla_tracks[track].is_solo = true;
  }
  return true;
}

export function exitTweak(ad: AnimData, isolate: boolean) {
  const tw = ad.tweak;
  if (!tw) return false;
  ad.action = tw.prev_action;
  ad.action_slot_handle = tw.prev_slot;
  ad.slot_action = tw.prev_slot_action;
  if (isolate) ad.nla_tracks[tw.track] && (ad.nla_tracks[tw.track].is_solo = false);
  ad.tweak = null;
  return true;
}


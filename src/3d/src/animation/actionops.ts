// Action data-block operations: new / unlink / push down / stash.
import { app, registerOperators } from '../app/app';
import type { ActionData, AnimData, DocumentData, NlaStrip, NlaTrack, ObjectData } from '../data/types';
import { newAction } from '../data/defaults';
import { activeAction } from './channels';
import { assignAction, resolveSlot } from '../anim/slots';
import { cloneKey } from './keyedit';

export function uniqueName(base: string, taken: Iterable<string>) {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; i < 10000; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!set.has(n)) return n;
  }
  return `${stem}.${Date.now()}`;
}

export function ensureAnimData(ob: ObjectData): AnimData {
  if (!ob.animation_data) ob.animation_data = { action: null, nla_tracks: [], drivers: [] };
  return ob.animation_data;
}

/** Keyed frame range of an action ([start, end], end > start). */
export function actionRange(act: ActionData, fallback: [number, number] = [1, 2]): [number, number] {
  if (act.frame_range) return [act.frame_range[0], Math.max(act.frame_range[1], act.frame_range[0] + 1)];
  let a = Infinity,
    b = -Infinity;
  for (const fc of act.fcurves)
    for (const k of fc.keyframe_points) {
      a = Math.min(a, k.co[0]);
      b = Math.max(b, k.co[0]);
    }
  if (a === Infinity) return fallback;
  if (b <= a) b = a + 1;
  return [a, b];
}

export function copyAction(doc: DocumentData, act: ActionData): ActionData {
  const c = newAction(
    uniqueName(
      act.name,
      Object.values(doc.actions).map((a) => a.name),
    ),
  );
  c.fcurves = act.fcurves.map((fc) => ({
    ...fc,
    keyframe_points: fc.keyframe_points.map(cloneKey),
    modifiers: fc.modifiers.map((m) => ({
      ...m,
      coefficients: m.coefficients ? [...m.coefficients] : undefined,
    })),
    color: fc.color ? ([...fc.color] as typeof fc.color) : undefined,
  }));
  if (act.frame_range) c.frame_range = [...act.frame_range];
  if (act.slots) c.slots = act.slots.map((sl) => ({ ...sl }));
  if (act.last_slot_handle !== undefined) c.last_slot_handle = act.last_slot_handle;
  if (act.active_slot !== undefined) c.active_slot = act.active_slot;
  doc.actions[c.id] = c;
  return c;
}

export function newTrack(ad: AnimData, name = 'NlaTrack'): NlaTrack {
  const t: NlaTrack = {
    name: uniqueName(
      name,
      ad.nla_tracks.map((x) => x.name),
    ),
    strips: [],
    mute: false,
    is_solo: false,
    select: false,
  };
  return t;
}

export function makeStrip(act: ActionData, start: number, extrapolation: NlaStrip['extrapolation'] = 'HOLD_FORWARD', slot?: number | null): NlaStrip {
  const [a, b] = actionRange(act);
  return {
    ...(slot !== undefined ? { action_slot_handle: slot ?? 0 } : {}),
    name: act.name,
    action: act.id,
    frame_start: start,
    frame_end: start + (b - a),
    action_frame_start: a,
    action_frame_end: b,
    scale: 1,
    repeat: 1,
    blend_type: 'REPLACE',
    blend_in: 0,
    blend_out: 0,
    mute: false,
    select: true,
    extrapolation,
  };
}

export function stripFits(track: NlaTrack, a: number, b: number, ignore?: NlaStrip) {
  return !track.strips.some((s) => s !== ignore && s.frame_start < b - 1e-4 && s.frame_end > a + 1e-4);
}

export function sortStrips(track: NlaTrack) {
  track.strips.sort((x, y) => x.frame_start - y.frame_start);
}

/** Move the active action into the NLA stack as a new strip. */
export function pushDown(doc: DocumentData, ob: ObjectData): NlaStrip | null {
  const ad = ob.animation_data;
  const act = activeAction(doc, ob);
  if (!ad || !act) return null;
  const isFirst = ad.nla_tracks.every((t) => !t.strips.length);
  const strip = makeStrip(act, actionRange(act)[0], isFirst ? 'HOLD' : 'HOLD_FORWARD', resolveSlot(act, ad, ob));
  const top = ad.nla_tracks[ad.nla_tracks.length - 1];
  let track: NlaTrack;
  if (top && !top.lock && stripFits(top, strip.frame_start, strip.frame_end)) track = top;
  else {
    track = newTrack(ad);
    ad.nla_tracks.push(track);
  }
  for (const t of ad.nla_tracks) for (const s of t.strips) s.select = false;
  track.strips.push(strip);
  sortStrips(track);
  assignAction(doc, ob, ad, null);
  return strip;
}

/** Store the action in a muted "[Action Stash]" track and unassign it. */
export function stashAction(doc: DocumentData, ob: ObjectData): boolean {
  const ad = ob.animation_data;
  const act = activeAction(doc, ob);
  if (!ad || !act) return false;
  let track = ad.nla_tracks.find((t) => t.name === '[Action Stash]');
  const strip = makeStrip(act, actionRange(act)[0], 'NOTHING', resolveSlot(act, ad, ob));
  strip.select = false;
  if (!track || !stripFits(track, strip.frame_start, strip.frame_end)) {
    track = { ...newTrack(ad, '[Action Stash]'), mute: true };
    ad.nla_tracks.unshift(track);
  }
  track.strips.push(strip);
  sortStrips(track);
  act.use_fake_user = true;
  assignAction(doc, ob, ad, null);
  return true;
}

const activeOb = () => app.activeObject;

registerOperators([
  {
    idname: 'action.new',
    label: 'New Action',
    description: 'Create new action (copying the active one, if any)',
    poll: () => !!activeOb(),
    exec: (ctx) => {
      const ob = activeOb()!;
      const cur = activeAction(ctx.doc, ob);
      const act = cur
        ? copyAction(ctx.doc, cur)
        : newAction(
            uniqueName(
              'Action',
              Object.values(ctx.doc.actions).map((a) => a.name),
            ),
          );
      ctx.doc.actions[act.id] = act;
      assignAction(ctx.doc, ob, ensureAnimData(ob), act.id);
    },
  },
  {
    idname: 'action.unlink',
    label: 'Unlink Action',
    description: 'Unlink this action from the active action slot',
    poll: () => !!activeOb()?.animation_data?.action,
    exec: (ctx) => {
      const ob = activeOb()!;
      const act = activeAction(ctx.doc, ob);
      assignAction(ctx.doc, ob, ob.animation_data!, null);
      if (
        act &&
        !act.use_fake_user &&
        !Object.values(ctx.doc.objects).some((o) => o.animation_data?.action === act.id || o.animation_data?.nla_tracks.some((t) => t.strips.some((s) => s.action === act.id)))
      )
        app.report('WARNING', `Action '${act.name}' has no users and will be lost when the file is saved (enable Fake User to keep it)`);
    },
  },
  {
    idname: 'action.push_down',
    label: 'Push Down Action',
    description: 'Push action down onto the top of the NLA stack as a new strip',
    poll: () => !!activeOb()?.animation_data?.action && !activeOb()?.animation_data?.tweak,
    exec: (ctx) => {
      if (!pushDown(ctx.doc, activeOb()!)) return 'CANCELLED';
    },
  },
  {
    idname: 'action.stash_and_create',
    label: 'Stash Action',
    description: 'Stash the action in the NLA stack and start a new, empty action',
    poll: () => !!activeOb()?.animation_data?.action && !activeOb()?.animation_data?.tweak,
    exec: (ctx) => {
      const ob = activeOb()!;
      if (!stashAction(ctx.doc, ob)) return 'CANCELLED';
      const act = newAction(
        uniqueName(
          'Action',
          Object.values(ctx.doc.actions).map((a) => a.name),
        ),
      );
      ctx.doc.actions[act.id] = act;
      assignAction(ctx.doc, ob, ensureAnimData(ob), act.id);
    },
  },
  {
    idname: 'action.stash',
    label: 'Stash Action',
    description: 'Store this action in the NLA stack as a non-contributing strip for later use',
    poll: () => !!activeOb()?.animation_data?.action && !activeOb()?.animation_data?.tweak,
    exec: (ctx) => {
      if (!stashAction(ctx.doc, activeOb()!)) return 'CANCELLED';
    },
  },
]);

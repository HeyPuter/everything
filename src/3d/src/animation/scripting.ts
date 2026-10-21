// Action slots for scripts: `action.slots`, the layered view of an action (`action.layers[0]
// .strips[0].channelbag(slot)` with per-slot `fcurves` and `groups`), `animation_data
// .action_slot` / `action_slot_handle` / `action_suitable_slots` / `last_slot_identifier` and
// `NlaStrip.action_slot`. Actions here have one layer with one keyframe strip.
import { app } from '../app/app';
import type { ActionData, ActionSlot, NlaStrip } from '../data/types';
import { ActionStruct, wrapId } from '../scripting/api';
import { AnimDataStruct, FCurves, fcurveWrapper, stripStructHooks } from '../scripting/api_anim';
import { PropCollection, Struct, expectId, kwMethod, mixin, proxify, pyError, touched, type Raw } from '../scripting/rna';
import { insertKeyframe } from '../anim/fcurve';
import { ensureFCurve } from '../anim/keyframes';
import { ID_CODES, addSlot, curveSlot, findSlot, isSlotted, materializeSlot, removeSlot, renameSlotEverywhere, resolveSlot, setSlot, slotCurves, slotIdType, slotName, slotUsers, slotsOf, stripSlot, suitableSlots, uniqueIdentifier } from '../anim/slots';

const q = (s: string) => JSON.stringify(s);
const actOf = (id: string): ActionData => {
  const a = app.doc.actions[id];
  if (!a) throw pyError('ReferenceError', 'Action has been removed');
  return a;
};
const actPath = (id: string) => `bpy.data.actions[${q(app.doc.actions[id]?.name ?? '?')}]`;
const ID_TYPES = Object.keys(ID_CODES);

/** Slot handle of a script value (an ActionSlot wrapper). */
function slotOf(v: unknown, act: ActionData): ActionSlot {
  const slot = (v as { __slot?: ActionSlot })?.__slot;
  if (!slot) throw pyError('TypeError', 'expected an ActionSlot');
  if (!act.slots?.includes(slot)) throw pyError('RuntimeError', `slot "${slot.identifier}" does not belong to action "${act.name}"`);
  return slot;
}

const slotCache = new WeakMap<ActionSlot, unknown>();
export function slotWrapper(actId: string, slot: ActionSlot): unknown {
  let w = slotCache.get(slot);
  if (w) return w;
  const alive = () => !!app.doc.actions[actId]?.slots?.includes(slot);
  const s = new Struct('ActionSlot', () => (alive() ? (slot as unknown as Raw) : null), '');
  Object.defineProperty(s, '__path', { get: () => `${actPath(actId)}.slots[${q(slot.identifier)}]` });
  Object.defineProperty(s, '__slot', { value: slot });
  Object.defineProperty(s, 'handle', { get: () => slot.handle, enumerable: true });
  Object.defineProperty(s, 'identifier', {
    enumerable: true,
    get: () => slot.identifier,
    set: (v: string) => {
      const id = String(v);
      if (id.length < 3) throw pyError('ValueError', 'a slot identifier is a two-letter type code followed by a name');
      const act = actOf(actId);
      renameSlotEverywhere(app.doc, act, slot, id.slice(2));
      slot.identifier = uniqueIdentifier(act, id, slot);
      touched();
    },
  });
  Object.defineProperty(s, 'name_display', {
    enumerable: true,
    get: () => slotName(slot),
    set: (v: string) => {
      renameSlotEverywhere(app.doc, actOf(actId), slot, String(v));
      touched();
    },
  });
  Object.defineProperty(s, 'target_id_type', {
    enumerable: true,
    get: () => slotIdType(slot),
    set: (v: string) => {
      const t = String(v).toUpperCase();
      if (slotIdType(slot) !== 'UNSPECIFIED') throw pyError('AttributeError', 'the type of a slot can only be set while it is unspecified');
      if (!ID_CODES[t]) throw pyError('TypeError', `enum "${v}" not found in (${ID_TYPES.map((x) => `'${x}'`).join(', ')})`);
      slot.identifier = uniqueIdentifier(actOf(actId), ID_CODES[t] + slotName(slot), slot);
      touched();
    },
  });
  Object.defineProperty(s, 'active', {
    enumerable: true,
    get: () => actOf(actId).active_slot === slot.handle,
    set: (v: boolean) => {
      if (v) actOf(actId).active_slot = slot.handle;
      touched();
    },
  });
  Object.defineProperty(s, 'users', { value: () => slotUsers(app.doc, actOf(actId), slot.handle).map((o) => wrapId('objects', o.id)) });
  Object.defineProperty(s, 'duplicate', {
    value: () => {
      const act = actOf(actId);
      const c = addSlot(act, slotIdType(slot) === 'UNSPECIFIED' ? 'UNSPECIFIED' : slotIdType(slot), slotName(slot));
      for (const fc of slotCurves(act, slot.handle)) act.fcurves.push({ ...structuredClone(fc), slot: c.handle });
      touched();
      return slotWrapper(actId, c);
    },
  });
  w = proxify(s);
  slotCache.set(slot, w);
  return w;
}

class ActionSlots extends PropCollection<unknown> {
  constructor(readonly actId: string) {
    super(`${actPath(actId)}.slots`);
  }
  list() {
    return slotsOf(actOf(this.actId)).map((s) => slotWrapper(this.actId, s));
  }
  nameOf(x: unknown) {
    return (x as { identifier: string }).identifier;
  }
  /** Adds a slot for data-blocks of `id_type` ('UNSPECIFIED' for any). */
  new(id_type: string, name: string) {
    const t = String(id_type ?? '').toUpperCase();
    if (t !== 'UNSPECIFIED' && !ID_CODES[t]) throw pyError('TypeError', `ActionSlots.new(): enum "${id_type}" not found in ('UNSPECIFIED', ${ID_TYPES.map((x) => `'${x}'`).join(', ')})`);
    const act = actOf(this.actId);
    if (!isSlotted(act) && act.fcurves.length) materializeSlot(app.doc, act);
    const slot = addSlot(act, t, String(name ?? 'Slot') || 'Slot');
    touched();
    return slotWrapper(this.actId, slot);
  }
  remove(action_slot: unknown) {
    const act = actOf(this.actId);
    removeSlot(app.doc, act, slotOf(action_slot, act));
    touched();
  }
  get active() {
    const act = actOf(this.actId);
    const s = findSlot(act, act.active_slot);
    return s ? slotWrapper(this.actId, s) : null;
  }
  set active(v: unknown) {
    const act = actOf(this.actId);
    act.active_slot = v === null || v === undefined ? undefined : slotOf(v, act).handle;
    touched();
  }
}
kwMethod(ActionSlots.prototype, 'new', ['id_type', 'name']);
kwMethod(ActionSlots.prototype, 'remove', ['action_slot']);

/** The animation of one slot in the action's keyframe strip. */
function channelbag(actId: string, slot: ActionSlot) {
  const path = `${actPath(actId)}.layers[0].strips[0].channelbag(${actPath(actId)}.slots[${q(slot.identifier)}])`;
  const s = new Struct('ActionChannelbag', () => (app.doc.actions[actId]?.slots?.includes(slot) ? ({} as Raw) : null), path);
  Object.defineProperty(s, 'slot', { get: () => slotWrapper(actId, slot) });
  Object.defineProperty(s, 'slot_handle', { get: () => slot.handle });
  Object.defineProperty(s, 'fcurves', { get: () => new FCurves(actId, slot.handle, `${path}.fcurves`) });
  Object.defineProperty(s, 'groups', { get: () => new ChannelGroups(actId, slot.handle, `${path}.groups`) });
  return proxify(s);
}

/** groups created by scripts before any curve joined them (per action and slot) */
const emptyGroups = new Map<string, string[]>();

class ChannelGroups extends PropCollection<unknown> {
  constructor(
    readonly actId: string,
    readonly slot: number,
    path: string,
  ) {
    super(path);
  }
  private names() {
    const out: string[] = [];
    for (const fc of slotCurves(actOf(this.actId), this.slot)) if (fc.group && !out.includes(fc.group)) out.push(fc.group);
    return out.concat((emptyGroups.get(this.actId + ':' + this.slot) ?? []).filter((n) => !out.includes(n)));
  }
  list() {
    return this.names().map((name) => this.wrap(name));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  private wrap(name: string) {
    const actId = this.actId,
      slot = this.slot;
    return {
      __kind: 'struct',
      __type: 'ActionGroup',
      name,
      get channels() {
        return slotCurves(actOf(actId), slot)
          .filter((f) => f.group === name)
          .map((f) => fcurveWrapper(actId, f));
      },
      toString: () => `<bpy_struct, ActionGroup("${name}")>`,
    };
  }
  new(name: string) {
    const key = this.actId + ':' + this.slot;
    const n = String(name || 'Group');
    const list = emptyGroups.get(key) ?? [];
    if (!this.names().includes(n)) emptyGroups.set(key, [...list, n]);
    return this.wrap(n);
  }
}
kwMethod(ChannelGroups.prototype, 'new', ['name']);

/** The single keyframe strip of the action's single layer. */
function keyframeStrip(actId: string) {
  const path = `${actPath(actId)}.layers[0].strips[0]`;
  const s = new Struct('ActionKeyframeStrip', () => (app.doc.actions[actId] ? ({ type: 'KEYFRAME' } as Raw) : null), path);
  Object.defineProperty(s, 'type', { get: () => 'KEYFRAME' });
  Object.defineProperty(s, 'channelbags', {
    get: () => {
      const act = actOf(actId);
      return slotsOf(act)
        .filter((sl) => act.fcurves.some((fc) => curveSlot(act, fc) === sl.handle))
        .map((sl) => channelbag(actId, sl));
    },
  });
  Object.defineProperty(s, 'channelbag', {
    value: (slot: unknown, ensure = false) => {
      const act = actOf(actId);
      const sl = slotOf(slot, act);
      if (!ensure && !act.fcurves.some((fc) => curveSlot(act, fc) === sl.handle)) return null;
      return channelbag(actId, sl);
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(s, 'key_insert', {
    value: (slot: unknown, data_path: string, array_index: number, value: number, time: number) => {
      const act = actOf(actId);
      const sl = slotOf(slot, act);
      insertKeyframe(ensureFCurve(act, String(data_path), Number(array_index ?? 0), sl.handle), Number(time), Number(value));
      touched();
      return true;
    },
    configurable: true,
    writable: true,
  });
  kwMethod(s as unknown as { channelbag: unknown }, 'channelbag', ['slot', 'ensure']);
  kwMethod(s as unknown as { key_insert: unknown }, 'key_insert', ['slot', 'data_path', 'array_index', 'value', 'time']);
  return proxify(s);
}

function layer(actId: string) {
  const path = `${actPath(actId)}.layers[0]`;
  const s = new Struct('ActionLayer', () => (app.doc.actions[actId] ? ({ name: 'Layer', influence: 1, mix_mode: 'REPLACE' } as Raw) : null), path);
  Object.defineProperty(s, 'name', { get: () => 'Layer' });
  Object.defineProperty(s, 'strips', {
    get: () => {
      const strips = [keyframeStrip(actId)];
      return Object.assign(strips, { new: () => strips[0] });
    },
  });
  return proxify(s);
}

class ActionSlotsAnim {
  get slots() {
    return new ActionSlots((this as unknown as ActionStruct).__id);
  }
  get layers() {
    const id = (this as unknown as ActionStruct).__id;
    const layers = [layer(id)];
    // one layer: new() hands back the existing one
    return Object.assign(layers, {
      new: () => layers[0],
      remove: () => {
        throw pyError('RuntimeError', 'actions here always have one layer');
      },
    });
  }
  get is_action_layered() {
    return true;
  }
  get is_action_legacy() {
    return false;
  }
  get is_empty() {
    const a = actOf((this as unknown as ActionStruct).__id);
    return !a.fcurves.length && !slotsOf(a).length;
  }
}
mixin(ActionStruct, ActionSlotsAnim, true);

class AnimDataSlots {
  get action_slot() {
    const self = this as unknown as AnimDataStruct;
    const ob = app.doc.objects[self.__obId];
    const ad = ob?.animation_data;
    const act = ad?.action ? app.doc.actions[ad.action] : undefined;
    if (!ob || !ad || !act) return null;
    const s = findSlot(act, resolveSlot(act, ad, ob));
    return s ? slotWrapper(act.id, s) : null;
  }
  set action_slot(v: unknown) {
    const self = this as unknown as AnimDataStruct;
    const ob = app.doc.objects[self.__obId];
    const ad = ob?.animation_data;
    const act = ad?.action ? app.doc.actions[ad.action] : undefined;
    if (!ob || !ad) throw pyError('ReferenceError', 'animation data has been cleared');
    if (v === null || v === undefined) {
      if (act) setSlot(ad, act, null);
    } else {
      if (!act) throw pyError('RuntimeError', 'assign an action before assigning one of its slots');
      const slot = slotOf(v, act);
      if (!suitableSlots(act, 'OBJECT').includes(slot)) throw pyError('RuntimeError', `slot "${slot.identifier}" is for another data-block type`);
      setSlot(ad, act, slot);
    }
    touched();
  }
  get action_slot_handle() {
    const self = this as unknown as AnimDataStruct;
    const ob = app.doc.objects[self.__obId];
    const ad = ob?.animation_data;
    const act = ad?.action ? app.doc.actions[ad.action] : undefined;
    return act && ad && ob ? (resolveSlot(act, ad, ob) ?? 0) : (ad?.action_slot_handle ?? 0);
  }
  set action_slot_handle(v: number) {
    const self = this as unknown as AnimDataStruct;
    const ad = app.doc.objects[self.__obId]?.animation_data;
    const act = ad?.action ? app.doc.actions[ad.action] : undefined;
    if (!ad) throw pyError('ReferenceError', 'animation data has been cleared');
    setSlot(ad, act, findSlot(act, Number(v)) ?? null);
    touched();
  }
  get action_suitable_slots() {
    const self = this as unknown as AnimDataStruct;
    const ad = app.doc.objects[self.__obId]?.animation_data;
    const act = ad?.action ? app.doc.actions[ad.action] : undefined;
    return act ? suitableSlots(act, 'OBJECT').map((s) => slotWrapper(act.id, s)) : [];
  }
  get last_slot_identifier() {
    const self = this as unknown as AnimDataStruct;
    return app.doc.objects[self.__obId]?.animation_data?.last_slot_identifier ?? '';
  }
  set last_slot_identifier(v: string) {
    const self = this as unknown as AnimDataStruct;
    const ad = app.doc.objects[self.__obId]?.animation_data;
    if (ad) ad.last_slot_identifier = String(v);
    touched();
  }
}
mixin(AnimDataStruct, AnimDataSlots, true);

// NLA strips play one slot of their action
stripStructHooks.push((s: Struct, st: NlaStrip, obId: string) => {
  const ctx = () => {
    const ob = app.doc.objects[obId];
    const act = app.doc.actions[st.action];
    return { ob, act };
  };
  Object.defineProperty(s, 'action_slot', {
    get: () => {
      const { ob, act } = ctx();
      if (!ob || !act) return null;
      const sl = findSlot(act, stripSlot(act, st, ob));
      return sl ? slotWrapper(act.id, sl) : null;
    },
    set: (v: unknown) => {
      const { act } = ctx();
      if (!act) throw pyError('RuntimeError', 'the strip has no action');
      st.action_slot_handle = v === null || v === undefined ? 0 : slotOf(v, act).handle;
      touched();
    },
  });
  Object.defineProperty(s, 'action_slot_handle', {
    get: () => st.action_slot_handle ?? 0,
    set: (v: number) => {
      st.action_slot_handle = Number(v);
      touched();
    },
  });
  Object.defineProperty(s, 'action', {
    get: () => (app.doc.actions[st.action] ? wrapId('actions', st.action) : null),
    set: (v: unknown) => {
      st.action = expectId(v, 'actions', 'Action');
      delete st.action_slot_handle;
      touched();
    },
  });
});


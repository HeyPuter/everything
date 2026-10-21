// Action slots: one action can hold the animation of several data-blocks, each in its own slot.
//
// Model
// - `action.slots` lists the slots; every F-Curve belongs to one slot through `fc.slot` (a slot
//   handle; curves without it belong to the first slot). An action without slots is "unslotted":
//   it plays all its curves on whatever uses it (actions made by importers, bakes and older files).
// - A user (object animation data, NLA strip, Action constraint) plays one slot. Animation data
//   keeps `action_slot_handle` together with `slot_action`, the action the handle belongs to.
//   When code assigns another action without choosing a slot, the slot is looked up again from
//   `last_slot_identifier`, the user's own name, or a never-used single slot (findSlotFor).
// - Keying an object whose action has no slot for it creates one ("OB" + object name).
//
// Pure document logic (no app/DOM) so it can be unit tested.
import type { ActionData, ActionSlot, AnimData, Constraint, DocumentData, FCurve, NlaStrip, ObjectData } from '../data/types';

/** Two-letter codes of slot identifiers, by data-block type. */
export const ID_CODES: Record<string, string> = {
  OBJECT: 'OB',
  MESH: 'ME',
  CURVE: 'CU',
  ARMATURE: 'AR',
  CAMERA: 'CA',
  LIGHT: 'LA',
  LATTICE: 'LT',
  MATERIAL: 'MA',
  WORLD: 'WO',
  SCENE: 'SC',
  KEY: 'KE',
  NODETREE: 'NT',
  GREASEPENCIL: 'GP',
  TEXTURE: 'TE',
  SPEAKER: 'SK',
  CURVES: 'CV',
  POINTCLOUD: 'PT',
  VOLUME: 'VO',
  LIGHT_PROBE: 'LP',
  METABALL: 'MB',
  CACHEFILE: 'CF',
  MASK: 'MS',
  MOVIECLIP: 'MC',
  PALETTE: 'PL',
  LINESTYLE: 'LS',
};
const CODE_TYPES: Record<string, string> = Object.fromEntries(Object.entries(ID_CODES).map(([t, c]) => [c, t]));
/** Code of slots that have never been assigned (any data-block type may use them). */
export const UNSPECIFIED_CODE = 'XX';

export const slotsOf = (act: ActionData | null | undefined): ActionSlot[] => act?.slots ?? [];
export const isSlotted = (act: ActionData | null | undefined) => !!act?.slots?.length;

/** Data-block type of a slot ('UNSPECIFIED' for never-assigned slots). */
export function slotIdType(slot: ActionSlot): string {
  return CODE_TYPES[slot.identifier.slice(0, 2)] ?? 'UNSPECIFIED';
}
/** The slot's name without the type code. */
export const slotName = (slot: ActionSlot) => slot.identifier.slice(2);

export function findSlot(act: ActionData | null | undefined, handle: number | null | undefined): ActionSlot | undefined {
  if (!act?.slots || handle === null || handle === undefined) return undefined;
  return act.slots.find((s) => s.handle === handle);
}

export function slotByIdentifier(act: ActionData | null | undefined, identifier: string): ActionSlot | undefined {
  return act?.slots?.find((s) => s.identifier === identifier);
}

/** Handle of the slot a curve belongs to (undefined for unslotted actions). */
export function curveSlot(act: ActionData, fc: FCurve): number | undefined {
  if (!act.slots?.length) return undefined;
  if (fc.slot !== undefined && act.slots.some((s) => s.handle === fc.slot)) return fc.slot;
  return act.slots[0].handle;
}

/**
 * Curves a slot animates. `handle` undefined means "every curve" (unslotted actions or no slot
 * filtering); null means no slot (nothing plays).
 */
export function slotCurves(act: ActionData, handle: number | null | undefined): FCurve[] {
  if (!act.slots?.length || handle === undefined) return act.fcurves;
  if (handle === null) return [];
  return act.fcurves.filter((fc) => curveSlot(act, fc) === handle);
}

export function uniqueIdentifier(act: ActionData, identifier: string, ignore?: ActionSlot): string {
  const taken = new Set(slotsOf(act).filter((s) => s !== ignore).map((s) => s.identifier));
  if (!taken.has(identifier)) return identifier;
  const stem = identifier.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken.has(n)) return n;
  }
}

/** Add a slot named `name` for data-blocks of `idType` ('UNSPECIFIED' gives an 'XX' slot). */
export function addSlot(act: ActionData, idType = 'OBJECT', name = 'Slot'): ActionSlot {
  const code = ID_CODES[idType] ?? UNSPECIFIED_CODE;
  act.slots ??= [];
  const handle = Math.max(act.last_slot_handle ?? 0, ...act.slots.map((s) => s.handle)) + 1;
  act.last_slot_handle = handle;
  const slot: ActionSlot = { handle, identifier: uniqueIdentifier(act, code + name), show_expanded: true };
  act.slots.push(slot);
  act.active_slot ??= handle;
  return slot;
}

export function renameSlot(act: ActionData, slot: ActionSlot, name: string) {
  slot.identifier = uniqueIdentifier(act, slot.identifier.slice(0, 2) + name, slot);
}

// ---------------------------------------------------------------------------
// users

export interface SlotUser {
  ob: ObjectData;
  kind: 'ANIMDATA' | 'STRIP' | 'CONSTRAINT';
  strip?: NlaStrip;
  constraint?: Constraint;
}

function forStrips(strips: NlaStrip[], fn: (s: NlaStrip) => void) {
  for (const s of strips) {
    fn(s);
    if (s.strips) forStrips(s.strips, fn);
  }
}

/** Every object-level user of an action (animation data, NLA strips, Action constraints). */
export function actionUsers(doc: DocumentData, actId: string): SlotUser[] {
  const out: SlotUser[] = [];
  for (const id of Object.keys(doc.objects)) {
    const ob = doc.objects[id];
    const ad = ob.animation_data;
    if (ad?.action === actId) out.push({ ob, kind: 'ANIMDATA' });
    if (ad) for (const t of ad.nla_tracks) forStrips(t.strips, (s) => s.type !== 'TRANSITION' && s.type !== 'META' && s.action === actId && out.push({ ob, kind: 'STRIP', strip: s }));
    for (const c of allConstraints(ob)) if (c.type === 'ACTION' && c.action === actId) out.push({ ob, kind: 'CONSTRAINT', constraint: c });
  }
  return out;
}

function allConstraints(ob: ObjectData): Constraint[] {
  const out = [...(ob.constraints ?? [])];
  if (ob.pose) for (const pb of Object.values(ob.pose)) out.push(...((pb as { constraints?: Constraint[] }).constraints ?? []));
  return out;
}

/** The slot a user plays (resolved like resolveSlot / stripSlot / constraintSlot). */
export function userSlot(doc: DocumentData, act: ActionData, u: SlotUser): number | null | undefined {
  if (u.kind === 'ANIMDATA') return resolveSlot(act, u.ob.animation_data!, u.ob);
  if (u.kind === 'STRIP') return stripSlot(act, u.strip!, u.ob);
  return constraintSlot(act, u.constraint!, u.ob);
}

/** Objects whose animation data plays the slot. */
export function slotUsers(doc: DocumentData, act: ActionData, handle: number): ObjectData[] {
  const out: ObjectData[] = [];
  for (const u of actionUsers(doc, act.id)) if (u.kind === 'ANIMDATA' && userSlot(doc, act, u) === handle && !out.includes(u.ob)) out.push(u.ob);
  return out;
}

/** Whether anything uses the slot (animation data, strips or constraints). */
export function slotInUse(doc: DocumentData, act: ActionData, handle: number): boolean {
  return actionUsers(doc, act.id).some((u) => userSlot(doc, act, u) === handle);
}

// ---------------------------------------------------------------------------
// slot lookup and assignment

/** The identifier a data-block's own slot gets. */
export const identifierFor = (ob: { name: string }, idType = 'OBJECT') => (ID_CODES[idType] ?? UNSPECIFIED_CODE) + ob.name;

/** Slots a data-block of `idType` can play (its own type or never assigned). */
export function suitableSlots(act: ActionData | null | undefined, idType = 'OBJECT'): ActionSlot[] {
  const code = ID_CODES[idType];
  return slotsOf(act).filter((s) => s.identifier.startsWith(code) || s.identifier.startsWith(UNSPECIFIED_CODE));
}

/**
 * The slot to use when `act` gets assigned to a user without an explicit choice: the slot last
 * used (by identifier), the slot named after the user, or a single slot nobody has used yet.
 */
export function findSlotFor(act: ActionData, owner: { name: string }, lastIdentifier?: string, idType = 'OBJECT'): ActionSlot | undefined {
  if (!act.slots?.length) return undefined;
  if (lastIdentifier) {
    const s = slotByIdentifier(act, lastIdentifier);
    if (s) return s;
  }
  const own = slotByIdentifier(act, identifierFor(owner, idType));
  if (own) return own;
  if (act.slots.length === 1 && act.slots[0].identifier.startsWith(UNSPECIFIED_CODE)) return act.slots[0];
  return undefined;
}

/**
 * The slot an object's animation data plays: undefined = every curve (unslotted action),
 * null = no slot, else a handle.
 */
export function resolveSlot(act: ActionData, ad: AnimData, owner: { name: string }): number | null | undefined {
  if (!act.slots?.length) return undefined;
  if (ad.slot_action === act.id && ad.action_slot_handle !== undefined) return findSlot(act, ad.action_slot_handle)?.handle ?? null;
  return findSlotFor(act, owner, ad.last_slot_identifier)?.handle ?? null;
}

/** The slot an NLA strip plays (found through the owner when the strip has none recorded). */
export function stripSlot(act: ActionData, strip: NlaStrip, owner: ObjectData): number | null | undefined {
  if (!act.slots?.length) return undefined;
  if (strip.action_slot_handle !== undefined) return findSlot(act, strip.action_slot_handle)?.handle ?? null;
  const ad = owner.animation_data;
  if (ad && ad.action === act.id) {
    const s = resolveSlot(act, ad, owner);
    if (s !== null) return s;
  }
  return findSlotFor(act, owner, ad?.last_slot_identifier)?.handle ?? (act.slots.length === 1 ? act.slots[0].handle : null);
}

/** The slot an Action constraint plays. */
export function constraintSlot(act: ActionData, c: Constraint, owner: ObjectData): number | null | undefined {
  if (!act.slots?.length) return undefined;
  const h = c.action_slot_handle as number | undefined;
  if (h !== undefined) return findSlot(act, h)?.handle ?? null;
  return findSlotFor(act, owner)?.handle ?? act.slots[0].handle;
}

/** Make the slot (or none) the explicit choice of the animation data. */
export function setSlot(ad: AnimData, act: ActionData | null | undefined, slot: ActionSlot | null | undefined, idType = 'OBJECT') {
  ad.slot_action = act?.id ?? null;
  ad.action_slot_handle = slot?.handle ?? 0;
  if (slot) {
    // a never-assigned slot takes the type of its first user
    if (slot.identifier.startsWith(UNSPECIFIED_CODE) && act) slot.identifier = uniqueIdentifier(act, (ID_CODES[idType] ?? UNSPECIFIED_CODE) + slot.identifier.slice(2), slot);
    ad.last_slot_identifier = slot.identifier;
  }
}

/** Assign an action to animation data and pick its slot (see findSlotFor). */
export function assignAction(doc: DocumentData, owner: ObjectData, ad: AnimData, actId: string | null) {
  ad.action = actId;
  const act = actId ? doc.actions[actId] : undefined;
  if (!act) {
    ad.slot_action = null;
    ad.action_slot_handle = 0;
    return;
  }
  setSlot(ad, act, act.slots?.length ? findSlotFor(act, owner, ad.last_slot_identifier) : null);
}

/**
 * Give an unslotted action that has curves its first slot (named after its first user) and
 * assign it to every current user, so they keep playing the same curves.
 */
export function materializeSlot(doc: DocumentData, act: ActionData, owner?: { name: string }): ActionSlot | undefined {
  if (act.slots?.length) return undefined;
  const users = actionUsers(doc, act.id);
  const first = users.find((u) => u.kind === 'ANIMDATA')?.ob ?? users[0]?.ob ?? owner;
  const slot = addSlot(act, first ? 'OBJECT' : 'UNSPECIFIED', first ? first.name : 'Slot');
  for (const u of users) {
    if (u.kind === 'ANIMDATA') setSlot(u.ob.animation_data!, act, slot);
    else if (u.kind === 'STRIP') u.strip!.action_slot_handle = slot.handle;
    else u.constraint!.action_slot_handle = slot.handle;
  }
  return slot;
}

/**
 * The slot keys of `owner` go into: the slot its animation data plays, else a new slot named
 * after it (assigned right away). Unslotted actions get their first slot here.
 */
export function ensureSlotForKeying(doc: DocumentData, owner: ObjectData, ad: AnimData, act: ActionData): ActionSlot {
  if (!act.slots?.length) {
    if (act.fcurves.length) materializeSlot(doc, act, owner);
    else {
      const slot = addSlot(act, 'OBJECT', owner.name);
      setSlot(ad, act, slot);
      return slot;
    }
  }
  const h = resolveSlot(act, ad, owner);
  const cur = h === null || h === undefined ? undefined : findSlot(act, h);
  if (cur) {
    if (ad.slot_action !== act.id) setSlot(ad, act, cur);
    return cur;
  }
  const slot = addSlot(act, 'OBJECT', owner.name);
  setSlot(ad, act, slot);
  return slot;
}

/** Curves an object's animation data plays from its active action. */
export function objectCurves(doc: DocumentData, ob: ObjectData | null | undefined): FCurve[] {
  const ad = ob?.animation_data;
  const act = ad?.action ? doc.actions[ad.action] : undefined;
  if (!act || !ad) return [];
  return slotCurves(act, resolveSlot(act, ad, ob!));
}

/** The slot an object's active action plays (undefined for unslotted actions / no action). */
export function objectSlot(doc: DocumentData, ob: ObjectData | null | undefined): ActionSlot | undefined {
  const ad = ob?.animation_data;
  const act = ad?.action ? doc.actions[ad.action] : undefined;
  if (!act || !ad) return undefined;
  return findSlot(act, resolveSlot(act, ad, ob!));
}

/** Remove a slot and its curves; users of the slot end up with none. */
export function removeSlot(doc: DocumentData, act: ActionData, slot: ActionSlot) {
  const keepFirst = act.slots && act.slots[0] === slot && act.slots.length > 1 ? act.slots[1] : null;
  // curves without an explicit slot belong to the first slot: pin them before the order changes
  pinCurves(act);
  act.fcurves = act.fcurves.filter((fc) => fc.slot !== slot.handle);
  for (const u of actionUsers(doc, act.id)) {
    if (userSlot(doc, act, u) !== slot.handle) continue;
    if (u.kind === 'ANIMDATA') setSlot(u.ob.animation_data!, act, null);
    else if (u.kind === 'STRIP') u.strip!.action_slot_handle = 0;
    else u.constraint!.action_slot_handle = 0;
  }
  act.slots = act.slots!.filter((s) => s !== slot);
  if (act.active_slot === slot.handle) act.active_slot = (keepFirst ?? act.slots[0])?.handle;
}

/** Move a slot with its curves from one action into another (handles may change). */
export function moveSlot(doc: DocumentData, from: ActionData, slot: ActionSlot, to: ActionData): ActionSlot {
  // users are re-pointed after the move, so collect them while the slot still resolves
  const users = actionUsers(doc, from.id).filter((u) => userSlot(doc, from, u) === slot.handle);
  const curves = slotCurves(from, slot.handle);
  const moved = addSlot(to, slotIdType(slot) === 'UNSPECIFIED' ? 'UNSPECIFIED' : slotIdType(slot), slotName(slot));
  moved.select = slot.select;
  moved.show_expanded = slot.show_expanded;
  pinCurves(from);
  from.fcurves = from.fcurves.filter((fc) => !curves.includes(fc));
  for (const fc of curves) {
    fc.slot = moved.handle;
    to.fcurves.push(fc);
  }
  from.slots = from.slots!.filter((s) => s !== slot);
  if (from.active_slot === slot.handle) from.active_slot = from.slots[0]?.handle;
  for (const u of users) {
    if (u.kind === 'ANIMDATA') {
      u.ob.animation_data!.action = to.id;
      setSlot(u.ob.animation_data!, to, moved);
    } else if (u.kind === 'STRIP') {
      u.strip!.action = to.id;
      u.strip!.action_slot_handle = moved.handle;
    } else {
      u.constraint!.action = to.id;
      u.constraint!.action_slot_handle = moved.handle;
    }
  }
  return moved;
}

/** Pin every curve's slot explicitly (so removing / reordering slots keeps ownership). */
export function pinCurves(act: ActionData) {
  for (const fc of act.fcurves) fc.slot = curveSlot(act, fc);
}

/** Display name of a slot for menus (name plus the type when it is not an object). */
export function slotLabel(slot: ActionSlot): string {
  const t = slotIdType(slot);
  return t === 'OBJECT' ? slotName(slot) : `${slotName(slot)} (${t === 'UNSPECIFIED' ? 'Unassigned' : t.charAt(0) + t.slice(1).toLowerCase()})`;
}

// ---------------------------------------------------------------------------
// editing helpers (used by the slot operators)

/** Rename a slot; users that remember it by identifier follow the new name. */
export function renameSlotEverywhere(d: DocumentData, act: ActionData, slot: ActionSlot, name: string) {
  const old = slot.identifier;
  renameSlot(act, slot, name);
  for (const ob of Object.values(d.objects)) if (ob.animation_data?.last_slot_identifier === old && ob.animation_data.action === act.id) ob.animation_data.last_slot_identifier = slot.identifier;
}

/** Add a slot for an object to its action and assign it (unslotted actions keep their curves in a first slot). */
export function newSlotForObject(d: DocumentData, ob: ObjectData, act: ActionData): ActionSlot {
  const ad = (ob.animation_data ??= { action: null, nla_tracks: [], drivers: [] });
  if (!isSlotted(act) && act.fcurves.length) materializeSlot(d, act, ob);
  const slot = addSlot(act, 'OBJECT', ob.name);
  setSlot(ad, act, slot);
  act.active_slot = slot.handle;
  return slot;
}

/** Re-point every user of `old` to `next`; slots are matched by identifier. */
export function replaceActionUsers(d: DocumentData, old: ActionData, next: ActionData) {
  for (const u of actionUsers(d, old.id)) {
    const h = userSlot(d, old, u);
    const ident = findSlot(old, h)?.identifier;
    const match = ident ? slotsOf(next).find((s) => s.identifier === ident) : undefined;
    if (u.kind === 'ANIMDATA') {
      const ad = u.ob.animation_data!;
      if (ident) ad.last_slot_identifier = ident;
      assignAction(d, u.ob, ad, next.id);
    } else if (u.kind === 'STRIP') {
      u.strip!.action = next.id;
      u.strip!.action_slot_handle = match ? match.handle : undefined;
    } else {
      u.constraint!.action = next.id;
      u.constraint!.action_slot_handle = match ? match.handle : undefined;
    }
  }
}

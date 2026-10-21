// Action slots: operators (new / unassign slots, merge and separate actions, move slots to a new
// action, replace an action everywhere) and the slot selector widget used by the Action Editor
// header, the Object properties Animation panel, NLA strips and the Action constraint.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, registerOperators, type OpContext } from '../app/app';
import { openMenu, type MenuItem } from '../ui/menu';
import { textField } from '../ui/widgets';
import type { ActionData, ActionSlot, Constraint, DocumentData, NlaStrip, ObjectData } from '../data/types';
import { newAction } from '../data/defaults';
import {
  addSlot,
  findSlot,
  isSlotted,
  materializeSlot,
  moveSlot,
  resolveSlot,
  setSlot,
  slotIdType,
  slotLabel,
  slotName,
  slotUsers,
  slotsOf,
  suitableSlots,
} from '../anim/slots';
import { slotIcon } from './channels';
export { renameSlotEverywhere, newSlotForObject, replaceActionUsers } from '../anim/slots';
import { renameSlotEverywhere, newSlotForObject, replaceActionUsers } from '../anim/slots';
import { uniqueName } from './actionops';
import './icons';
import './slots.css';

const doc = () => app.doc;
const actionNames = (d: DocumentData) => Object.values(d.actions).map((a) => a.name);

/** The object an operator works on: the `object` prop (panels) or the active object. */
function targetObject(p: Record<string, unknown>): ObjectData | null {
  const id = p.object as string | undefined;
  return (id ? doc().objects[id] : app.activeObject) ?? null;
}
const objectAction = (ob: ObjectData | null) => (ob?.animation_data?.action ? doc().actions[ob.animation_data.action] : undefined);



/** The NLA strip an operator works on: given by track/strip indices, else the first selected clip. */
function targetStrip(p: Record<string, unknown>, ctx?: OpContext): { ob: ObjectData; strip: NlaStrip } | null {
  const ed = ctx?.area?.editor as { activeStripRef?: () => { ob: ObjectData; strip: NlaStrip } | null } | undefined;
  if (p.track === undefined && ed?.activeStripRef) {
    const r = ed.activeStripRef();
    if (r) return { ob: r.ob, strip: r.strip };
  }
  const ob = targetObject(p);
  const ad = ob?.animation_data;
  if (!ob || !ad) return null;
  if (typeof p.track === 'number' && typeof p.strip === 'number') {
    const s = ad.nla_tracks[p.track]?.strips[p.strip];
    return s ? { ob, strip: s } : null;
  }
  for (const t of ad.nla_tracks) for (const s of t.strips) if (s.select && (!s.type || s.type === 'CLIP')) return { ob, strip: s };
  return null;
}

/** The Action constraint an operator works on (by name on the object or one of its pose bones). */
function targetConstraint(p: Record<string, unknown>): { ob: ObjectData; c: Constraint } | null {
  const ob = targetObject(p);
  if (!ob) return null;
  const bone = p.bone as string | undefined;
  const list = bone ? (ob.pose?.[bone]?.constraints ?? []) : ob.constraints;
  const c = list.find((x) => x.name === p.constraint) ?? list.find((x) => x.type === 'ACTION' && (x as { active?: boolean }).active) ?? list.find((x) => x.type === 'ACTION');
  return c && c.type === 'ACTION' ? { ob, c } : null;
}

const objectProps = [{ id: 'object', label: 'Object', type: 'string' as const, default: '', hidden: true }];

registerOperators([
  {
    idname: 'anim.slot_new_for_id',
    label: 'New Slot',
    description: 'Give this data-block a new slot of its action to keep its animation in',
    props: objectProps,
    poll: () => !!objectAction(app.activeObject),
    exec: (ctx, p) => {
      const ob = targetObject(p);
      const act = objectAction(ob);
      if (!ob || !act) return 'CANCELLED';
      newSlotForObject(ctx.doc, ob, act);
    },
  },
  {
    idname: 'anim.slot_unassign_from_id',
    label: 'Unassign Slot',
    description: 'Stop playing the slot: the data-block keeps the action but no longer gets animation from it',
    props: objectProps,
    poll: () => !!objectAction(app.activeObject),
    exec: (ctx, p) => {
      const ob = targetObject(p);
      const act = objectAction(ob);
      if (!ob || !act || !ob.animation_data) return 'CANCELLED';
      setSlot(ob.animation_data, act, null);
    },
  },
  {
    idname: 'anim.slot_unassign_from_nla_strip',
    label: 'Unassign Slot',
    description: 'Stop the NLA strip from playing a slot of its action',
    props: [...objectProps, { id: 'track', label: 'Track', type: 'int', default: -1, hidden: true }, { id: 'strip', label: 'Strip', type: 'int', default: -1, hidden: true }],
    poll: (ctx) => !!targetStrip({}, ctx),
    exec: (ctx, p) => {
      const props = { ...p };
      if ((props.track as number) < 0) delete props.track;
      const t = targetStrip(props, ctx);
      if (!t) return 'CANCELLED';
      t.strip.action_slot_handle = 0;
    },
  },
  {
    idname: 'anim.slot_unassign_from_constraint',
    label: 'Unassign Slot',
    description: 'Stop the Action constraint from playing a slot of its action',
    props: [...objectProps, { id: 'constraint', label: 'Constraint', type: 'string', default: '', hidden: true }, { id: 'bone', label: 'Bone', type: 'string', default: '', hidden: true }],
    poll: () => !!app.activeObject,
    exec: (_ctx, p) => {
      const t = targetConstraint(p);
      if (!t) return 'CANCELLED';
      t.c.action_slot_handle = 0;
    },
  },
  {
    idname: 'anim.separate_slots',
    label: 'Separate Slots',
    description: 'Give every slot of the active object’s action an action of its own; the users of each slot move along. The emptied action is kept',
    poll: () => slotsOf(objectAction(app.activeObject)).length > 0,
    exec: (ctx) => {
      const ob = app.activeObject!;
      const act = objectAction(ob)!;
      const slots = [...slotsOf(act)];
      for (const slot of slots) {
        const fresh = newAction(uniqueName(`${slotName(slot)}Action`, actionNames(ctx.doc)));
        ctx.doc.actions[fresh.id] = fresh;
        moveSlot(ctx.doc, act, slot, fresh);
      }
      app.report('INFO', `Separated ${act.name} into ${slots.length} new action${slots.length === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'anim.slot_channels_move_to_new_action',
    label: 'Move Slots to new Action',
    description: 'Move the selected slots, with their animation and users, into a new action',
    poll: () => slotsOf(objectAction(app.activeObject)).some((s) => s.select),
    exec: (ctx) => {
      const act = objectAction(app.activeObject)!;
      const sel = slotsOf(act).filter((s) => s.select);
      if (!sel.length) return 'CANCELLED';
      const fresh = newAction(uniqueName(sel.length === 1 ? `${slotName(sel[0])}Action` : act.name, actionNames(ctx.doc)));
      ctx.doc.actions[fresh.id] = fresh;
      for (const slot of sel) moveSlot(ctx.doc, act, slot, fresh);
      app.report('INFO', `Moved ${sel.length} slot${sel.length === 1 ? '' : 's'} into ${fresh.name}`);
    },
  },
  {
    idname: 'anim.merge_animation',
    label: 'Merge Animation',
    description: 'Move the animation of the selected objects into the action of the active object, as slots of it. The other actions are kept (they may end up unused)',
    poll: () => !!objectAction(app.activeObject) && app.selectedObjects().some((o) => o !== app.activeObject && objectAction(o)),
    exec: (ctx) => {
      const target = objectAction(app.activeObject)!;
      if (!isSlotted(target) && target.fcurves.length) materializeSlot(ctx.doc, target, app.activeObject!);
      let moved = 0;
      for (const ob of app.selectedObjects()) {
        const act = objectAction(ob);
        if (!act || act === target) continue;
        if (!isSlotted(act)) {
          if (!act.fcurves.length) continue;
          materializeSlot(ctx.doc, act, ob);
        }
        for (const slot of [...slotsOf(act)]) {
          moveSlot(ctx.doc, act, slot, target);
          moved++;
        }
      }
      if (!moved) return 'CANCELLED';
      app.report('INFO', `Moved ${moved} slot${moved === 1 ? '' : 's'} into the action of the active object`);
    },
  },
  {
    idname: 'anim.replace_action',
    label: 'Replace Action',
    description: 'Make every user of the action (objects, NLA strips, constraints) use another action instead',
    props: [
      { id: 'old_action', label: 'Old Action', type: 'string', default: '', hidden: true },
      { id: 'new_action', label: 'New Action', type: 'string', default: '', hidden: true },
    ],
    poll: () => !!objectAction(app.activeObject),
    invoke: (ctx, p) => {
      const old = (p.old_action as string) || objectAction(app.activeObject)?.id;
      if (!old) return 'CANCELLED';
      if (p.new_action) return app.run('anim.replace_action', { old_action: old, new_action: p.new_action }, { invoke: false }) as 'FINISHED';
      const others = Object.values(ctx.doc.actions)
        .filter((a) => a.id !== old)
        .sort((a, b) => a.name.localeCompare(b.name));
      openMenu(others.length ? others.map((a) => ({ label: a.name, icon: 'action', op: 'anim.replace_action', props: { old_action: old, new_action: a.id } })) : [{ label: 'No other actions', disabled: true }], { ...app.pointer }, { title: 'Replace Action', search: others.length > 10 });
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const old = ctx.doc.actions[(p.old_action as string) || objectAction(app.activeObject)?.id || ''];
      const next = ctx.doc.actions[p.new_action as string];
      if (!old || !next || old === next) return 'CANCELLED';
      replaceActionUsers(ctx.doc, old, next);
    },
  },
  {
    idname: 'anim.replace_action_new',
    label: 'Replace with New Action',
    description: 'Make every user of the action use a new, empty action with the same slots',
    props: [{ id: 'old_action', label: 'Old Action', type: 'string', default: '', hidden: true }],
    poll: () => !!objectAction(app.activeObject),
    exec: (ctx, p) => {
      const old = ctx.doc.actions[(p.old_action as string) || objectAction(app.activeObject)?.id || ''];
      if (!old) return 'CANCELLED';
      const fresh = newAction(uniqueName('Action', actionNames(ctx.doc)));
      // the same slots (by identifier), so every user keeps playing "its" slot
      for (const s of slotsOf(old)) {
        const c = addSlot(fresh, 'OBJECT', 'Slot');
        c.identifier = s.identifier;
      }
      ctx.doc.actions[fresh.id] = fresh;
      replaceActionUsers(ctx.doc, old, fresh);
    },
  },
]);


// ---------------------------------------------------------------------------
// slot selector

export interface SlotBinding {
  act: ActionData;
  /** the slot played now (undefined: none) */
  current: ActionSlot | undefined;
  /** user of the slot, for icons and the New Slot name */
  owner: ObjectData;
  assign: (slot: ActionSlot | null) => void;
  /** operator (and props) of the "new slot" button; absent hides it */
  newSlot?: [string, Record<string, unknown>];
  unassign: [string, Record<string, unknown>];
}

/** Menu of the slots an owner can play (its type's slots and never-assigned ones). */
export function slotMenu(b: SlotBinding): MenuItem[] {
  const fit = suitableSlots(b.act, 'OBJECT');
  const other = slotsOf(b.act).filter((s) => !fit.includes(s));
  const item = (s: ActionSlot): MenuItem => {
    const users = slotUsers(doc(), b.act, s.handle).filter((o) => o !== b.owner);
    return {
      label: slotLabel(s),
      icon: slotIcon(s, b.owner),
      active: s === b.current,
      description: users.length ? `Also used by ${users.map((o) => o.name).join(', ')}` : slotIdType(s) === 'UNSPECIFIED' ? 'Not used yet: takes the type of its first user' : undefined,
      action: () => b.assign(s),
    };
  };
  const out: MenuItem[] = fit.map(item);
  if (other.length) out.push({ separator: true }, { heading: 'Other Data-Block Types' }, ...other.map((s) => ({ ...item(s), disabled: true })));
  if (!out.length) out.push({ label: 'The action has no slots yet', disabled: true });
  return out;
}

/**
 * Slot selector: browse button, editable name, New Slot and Unassign buttons. `variant`
 * 'header' uses the compact header look of the Action Editor, 'panel' the data-block selector look.
 */
export function slotSelector(key: string, b: SlotBinding, variant: 'header' | 'panel' = 'panel'): Child {
  const header = variant === 'header';
  const cls = header ? { root: 'anim-idblock anim-slotblock', browse: 'anim-id-browse', name: 'anim-id-name', btn: 'anim-id-btn' } : { root: 'id-selector slot-selector', browse: 'ids-browse', name: '', btn: 'ids-btn' };
  const cur = b.current;
  return h(
    'div',
    { key, class: cls.root, 'data-slot-selector': key },
    h(
      'button',
      {
        class: cls.browse,
        'data-tip': 'Slot\nThe slot of the action this data-block plays',
        onpointerdown: (e: PointerEvent) => (e.preventDefault(), openMenu(slotMenu(b), e.currentTarget as HTMLElement, { title: 'Browse Slot' })),
      },
      icon(cur ? slotIcon(cur, b.owner) : 'action_slot'),
      icon('down_arrow_hlt', 'tiny'),
    ),
    cur
      ? [
          textField(
            `${key}-name`,
            slotName(cur),
            (v) => {
              const name = v.trim();
              if (!name || name === slotName(cur)) return;
              renameSlotEverywhere(doc(), b.act, cur, name);
              app.pushUndo('Rename Slot');
              app.changed('doc');
            },
            { className: cls.name },
          ),
          b.newSlot ? h('button', { class: cls.btn, 'data-tip': 'New Slot\nGive this data-block a new, empty slot', onclick: () => app.run(b.newSlot![0], b.newSlot![1], { invoke: false }) }, icon('duplicate')) : null,
          h('button', { class: cls.btn, 'data-tip': 'Unassign Slot\nKeep the action but stop playing this slot', onclick: () => app.run(b.unassign[0], b.unassign[1], { invoke: false }) }, icon('x')),
        ]
      : b.newSlot
        ? h('button', { class: header ? 'anim-id-new' : 'btn ids-new', 'data-tip': 'New Slot\nGive this data-block a slot of the action to keep its animation in', onclick: () => app.run(b.newSlot![0], b.newSlot![1], { invoke: false }) }, icon('add'), 'New Slot')
        : h('span', { class: 'slot-none' }, 'No slot'),
  );
}

/** Slot binding of an object's own animation data (null when its action has no slots). */
export function objectSlotBinding(ob: ObjectData): SlotBinding | null {
  const ad = ob.animation_data;
  const act = objectAction(ob);
  if (!ad || !act || !isSlotted(act)) return null;
  return {
    act,
    owner: ob,
    current: findSlot(act, resolveSlot(act, ad, ob)),
    assign: (slot) => {
      setSlot(ad, act, slot);
      if (slot) act.active_slot = slot.handle;
      app.pushUndo('Assign Slot');
      app.changed('doc');
    },
    newSlot: ['anim.slot_new_for_id', { object: ob.id }],
    unassign: ['anim.slot_unassign_from_id', { object: ob.id }],
  };
}

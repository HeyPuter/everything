// Change, assign and remove the keyboard shortcut of an operator from its button or menu item
// (right-click ▸ Assign Shortcut). Changes go through the key configuration, so they are saved
// and show up in Preferences ▸ Keymap like edits made there.
import { app } from '../app/app';
import { keyLabel, keyName, keymaps, MODIFIER_KEYS, type KeyItem } from '../app/keymap';
import { keyconfig, keyconfigChanged } from '../prefs/keyconfig';
import type { MenuItem } from './menu';

const sameProps = (a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined) => {
  const ka = Object.keys(a ?? {}),
    kb = Object.keys(b ?? {});
  return ka.length === kb.length && ka.every((k) => JSON.stringify(a![k]) === JSON.stringify(b?.[k]));
};

/** The active key item that runs `op` with exactly these properties, and its keymap. */
export function findShortcut(op: string, props?: Record<string, unknown>): { km: string; item: KeyItem } | null {
  for (const [km, items] of Object.entries(keymaps)) for (const item of items) if (!item.inactive && item.op === op && sameProps(item.props, props)) return { km, item };
  return null;
}

/** Keymap a new shortcut for an operator goes to (its editor's map when the prefix names one). */
export function keymapForOp(op: string): string {
  const prefix = op.split('.')[0];
  const MAP: Record<string, string> = {
    object: 'Object Mode',
    mesh: 'Mesh',
    curve: 'Curve',
    armature: 'Armature',
    pose: 'Pose',
    sculpt: 'Sculpt',
    paint: 'Sculpt',
    view3d: '3D View',
    transform: '3D View',
    graph: 'Graph Editor',
    action: 'Dopesheet',
    nla: 'NLA Editor',
    node: 'Node Editor',
    image: 'Image',
    uv: 'UV Editor',
    sequencer: 'SequencerCommon',
    clip: 'Clip',
    text: 'Text',
    console: 'Console',
    outliner: 'Outliner',
    file: 'File Browser',
    marker: 'Markers',
  };
  const km = MAP[prefix];
  return km && keymaps[km] ? km : 'Window';
}

interface Combo {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** Other active items of a keymap bound to the same keys. */
function conflicts(km: string, c: Combo, except?: KeyItem): KeyItem[] {
  return (keymaps[km] ?? []).filter((k) => k !== except && !k.inactive && (k.value ?? 'PRESS') === 'PRESS' && k.key === c.key && !!k.ctrl === c.ctrl && !!k.shift === c.shift && !!k.alt === c.alt);
}

/** Bind an operator call to a key combination (replacing its current shortcut). */
export function setShortcut(op: string, props: Record<string, unknown> | undefined, c: Combo, label?: string): KeyItem {
  const cur = findShortcut(op, props);
  let item: KeyItem;
  let km: string;
  if (cur) {
    keyconfig.edit(cur.item, { key: c.key, ctrl: c.ctrl, shift: c.shift, alt: c.alt });
    item = cur.item;
    km = cur.km;
  } else {
    km = keymapForOp(op);
    item = keyconfig.addItem(km, { key: c.key, ctrl: c.ctrl, shift: c.shift, alt: c.alt, op, props: props ? structuredClone(props) : {} });
  }
  keyconfigChanged();
  const clash = conflicts(km, c, item)[0];
  const name = label ?? op;
  app.report(clash ? 'WARNING' : 'INFO', `${name}: ${keyLabel(item)}${clash ? ` (also bound to ${clash.op ?? clash.menuTitle ?? 'another item'} in ${km})` : ''}`);
  app.changed('ui');
  return item;
}

export function removeShortcut(op: string, props?: Record<string, unknown>): boolean {
  const cur = findShortcut(op, props);
  if (!cur) return false;
  keyconfig.remove(cur.item);
  keyconfigChanged();
  app.changed('ui');
  return true;
}

/** Wait for the next key combination (Esc cancels) and bind it to the operator call. */
export function captureShortcut(op: string, props: Record<string, unknown> | undefined, label: string) {
  if (app.modal) return;
  app.startModal({
    label: 'Assign Shortcut',
    header: () => `Press a key for "${label}" (Esc to cancel, Backspace to remove)`,
    status: () => [
      ['Any key', 'Assign'],
      ['Esc', 'Cancel'],
    ],
    onKey: (e) => {
      if (e.type !== 'keydown') return true;
      const name = keyName(e);
      if (MODIFIER_KEYS.includes(name)) return true;
      if (name === 'ESC') return 'CANCELLED';
      if (name === 'BACK_SPACE' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
        removeShortcut(op, props);
        return 'CANCELLED';
      }
      setShortcut(op, props, { key: name, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey }, label);
      // the binding is a preference, not an undo step
      return 'CANCELLED';
    },
    onPointerDown: () => 'CANCELLED',
    cancel: () => {},
  });
}

/** Change / Remove Shortcut, or Assign Shortcut, for an operator call. */
export function shortcutMenuItems(op: string, props: Record<string, unknown> | undefined, label: string): MenuItem[] {
  const cur = findShortcut(op, props);
  return cur
    ? [
        { label: 'Change Shortcut', shortcut: keyLabel(cur.item), action: () => captureShortcut(op, props, label) },
        { label: 'Remove Shortcut', action: () => removeShortcut(op, props) },
      ]
    : [{ label: 'Assign Shortcut', action: () => captureShortcut(op, props, label) }];
}

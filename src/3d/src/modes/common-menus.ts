// Submenus shared by the curve, lattice, armature and metaball edit modes.
import type { MenuItem } from '../ui/menu';
import { snapMenu } from '../editors/view3d/menus';
import { app } from '../app/app';
import { addKeys } from '../app/keymap';
import { genericEditMode } from './editxform';

export function transformSubmenu(extra: MenuItem[] = []): MenuItem {
  return {
    label: 'Transform',
    submenu: () => [
      { label: 'Move', op: 'transform.translate', shortcut: 'G' },
      { label: 'Rotate', op: 'transform.rotate', shortcut: 'R' },
      { label: 'Scale', op: 'transform.resize', shortcut: 'S' },
      { separator: true },
      { label: 'To Sphere', op: 'transform.tosphere', shortcut: 'Shift Alt S' },
      { label: 'Push/Pull', op: 'transform.push_pull' },
      ...(extra.length ? [{ separator: true } as MenuItem, ...extra] : []),
    ],
  };
}

export function mirrorSubmenu(): MenuItem {
  return { label: 'Mirror', submenu: mirrorMenuItems, shortcut: 'Ctrl M' };
}

export function snapSubmenu(): MenuItem {
  return { label: 'Snap', submenu: snapMenu };
}

export function showHideSubmenu(prefix: string, reveal: string, hide: string): MenuItem {
  return {
    label: 'Show/Hide',
    submenu: () => [
      { label: 'Reveal Hidden', op: `${prefix}.${reveal}`, shortcut: 'Alt H' },
      { label: 'Hide Selected', op: `${prefix}.${hide}`, props: { unselected: false }, shortcut: 'H' },
      { label: 'Hide Unselected', op: `${prefix}.${hide}`, props: { unselected: true }, shortcut: 'Shift H' },
    ],
  };
}

/** Ctrl M mirror menu and Shift Alt S To Sphere for the curve, armature, lattice and metaball edit modes. */
export function mirrorMenuItems(): MenuItem[] {
  return ['X', 'Y', 'Z'].map((a, i) => ({ label: `${a} Global`, op: 'transform.mirror', props: { axis: i } }));
}

for (const km of ['Curve', 'Armature', 'Lattice', 'Metaball'])
  addKeys(km, [
    { key: 'M', ctrl: true, menu: mirrorMenuItems, menuTitle: 'Mirror', when: genericEditMode },
    { key: 'S', alt: true, shift: true, op: 'transform.tosphere', when: () => genericEditMode() && app.activeObject?.type !== 'ARMATURE' },
  ]);

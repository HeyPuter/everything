// Node group interface: removing and duplicating items, panel toggles.
import { describe, it, expect } from 'vitest';
import type { NodeTreeData } from '../../src/data/types';
import { addInterfacePanel, addPanelToggle, duplicateInterfaceItem, makePanelToggle, removeInterfaceItem, unlinkPanelToggle, panelOfToggle } from '../../src/nodes/iface';
import { addInterfaceSocket } from '../../src/nodes/tree';
import '../../src/nodes/common';
import { interfacePanels } from '../../src/nodes/registry';

const tree = (): NodeTreeData => ({ type: 'GEOMETRY', nodes: [], links: [], interface: [] });
const add = (t: NodeTreeData) => (io: 'INPUT' | 'OUTPUT', name: string) => addInterfaceSocket(t, io, name, 'FLOAT');

describe('interface items', () => {
  it('panel toggles are added, made from boolean inputs and unlinked', () => {
    const t = tree();
    const p = addInterfacePanel(t, 'Detail');
    const tog = addPanelToggle(t, p.identifier, add(t))!;
    expect(tog.socket_type).toBe('NodeSocketBool');
    expect(tog.panel).toBe(p.identifier);
    expect(panelOfToggle(t, tog.identifier)).toBe(p);
    expect(interfacePanels(t)[0].toggle).toBe(tog.identifier);
    // only one toggle per panel
    expect(addPanelToggle(t, p.identifier, add(t))).toBeNull();
    expect(unlinkPanelToggle(t, p.identifier)).toBe(true);
    expect(p.toggle).toBeUndefined();
    expect(makePanelToggle(t, tog.identifier)).toBe(true);
    // a float input cannot be a toggle
    const f = add(t)('INPUT', 'Size');
    f.panel = p.identifier;
    expect(makePanelToggle(t, f.identifier)).toBe(false);
    // removing the toggle socket clears the panel's toggle
    expect(removeInterfaceItem(t, tog.identifier)).toBe(true);
    expect(p.toggle).toBeUndefined();
  });
  it('duplicates a socket right after itself with its settings', () => {
    const t = tree();
    const a = add(t)('INPUT', 'A');
    a.min_value = 2;
    add(t)('INPUT', 'B');
    const c = duplicateInterfaceItem(t, a.identifier, add(t))!;
    expect(t.interface!.map((i) => i.name)).toEqual(['A', 'A.001', 'B']);
    expect(c.min_value).toBe(2);
    expect(c.identifier).not.toBe(a.identifier);
  });
});

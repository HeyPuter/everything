import { describe, expect, it } from 'vitest';
import * as RL from '../src/core/ribbon-layout.js';

const BUILTINS = ['Home', 'Insert', 'Data', 'View'];
const ids = (layout) => RL.tabsIn(layout, BUILTINS).map((t) => t.id);

describe('ribbon layout', () => {
  it('starts with the built-in tabs in order', () => {
    expect(ids(RL.EMPTY_LAYOUT)).toEqual(BUILTINS);
    expect(RL.isDefaultLayout(RL.normalizeLayout(null))).toBe(true);
  });

  it('hides, renames and reorders tabs', () => {
    let layout = RL.setTabHidden(RL.EMPTY_LAYOUT, 'Insert', true);
    layout = RL.rename(layout, 'Data', 'Numbers');
    layout = RL.moveTab(layout, BUILTINS, 'View', -1);
    const tabs = RL.tabsIn(layout, BUILTINS);
    expect(tabs.map((t) => t.id)).toEqual(['Home', 'Insert', 'View', 'Data']);
    expect(tabs.find((t) => t.id === 'Insert').hidden).toBe(true);
    expect(tabs.find((t) => t.id === 'Data').name).toBe('Numbers');
    // Given its own name again, a built-in tab drops the rename.
    expect(RL.rename(layout, 'Data', 'Data').names).toEqual({});
    expect(RL.moveTab(layout, BUILTINS, 'Home', -1)).toBe(layout);
  });

  it('adds a tab of one’s own, with a group, after the chosen tab', () => {
    const layout = RL.addTab(RL.EMPTY_LAYOUT, BUILTINS, 'Mine', 'Home');
    expect(ids(layout)).toEqual(['Home', layout.created.tab, 'Insert', 'Data', 'View']);
    expect(layout.groups[layout.created.tab]).toHaveLength(1);
    const stored = RL.normalizeLayout(JSON.parse(JSON.stringify(layout)));
    expect(stored.tabs).toEqual([{ id: layout.created.tab, name: 'Mine' }]);
    expect(ids(stored)[1]).toBe(layout.created.tab);
  });

  it('fills groups with commands, reorders and removes them', () => {
    let layout = RL.addGroup(RL.EMPTY_LAYOUT, 'Home', 'Favourites');
    const group = layout.created.group;
    layout = RL.addCommand(layout, group, 'bold');
    layout = RL.addCommand(layout, group, 'sort:"asc"');
    layout = RL.addCommand(layout, group, 'bold'); // already there
    expect(RL.findGroup(layout, group).group.commands).toEqual(['bold', 'sort:"asc"']);
    layout = RL.moveCommand(layout, group, 'sort:"asc"', -1);
    expect(RL.findGroup(layout, group).group.commands).toEqual(['sort:"asc"', 'bold']);
    layout = RL.removeCommand(layout, group, 'bold');
    expect(RL.findGroup(layout, group).group.commands).toEqual(['sort:"asc"']);
    layout = RL.rename(layout, group, 'Picks');
    expect(RL.findGroup(layout, group).group.name).toBe('Picks');
    layout = RL.removeItem(layout, group);
    expect(layout.groups.Home).toBeUndefined();
  });

  it('removes a tab of one’s own with its groups; a built-in tab can only be hidden', () => {
    let layout = RL.addTab(RL.EMPTY_LAYOUT, BUILTINS);
    const tab = layout.created.tab;
    layout = RL.removeItem(layout, tab);
    expect(ids(layout)).toEqual(BUILTINS);
    expect(layout.groups[tab]).toBeUndefined();
    expect(RL.removeItem(layout, 'Home')).toBe(layout);
  });

  it('drops what a stored layout cannot hold', () => {
    const layout = RL.normalizeLayout({ tabs: [{ id: 'evil', name: 'x' }, { id: 'custom-a', name: '' }], groups: { Home: [{ id: 'group-a', name: 'G', commands: ['bold', 4, 'bold'] }, { id: 'bad' }] }, order: ['Home', 7], hidden: 'Home' });
    expect(layout.tabs).toEqual([{ id: 'custom-a', name: 'New Tab' }]);
    expect(layout.groups.Home).toEqual([{ id: 'group-a', name: 'G', commands: ['bold'] }]);
    expect(layout.order).toEqual(['Home']);
    expect(layout.hidden).toEqual([]);
  });
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

// The grid switches sheets with Alt+Down and Alt+Up (browsers keep Ctrl+PgUp/PgDn for their own tabs on
// Windows and Linux) and, on a Mac, selects the column and shows formulas with Control as well, since
// ⌘+Space is Spotlight and ⌘+` moves between windows. The shortcuts help now names those keys.
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.resetModules(); });

/** The help sheet as it loads on the given platform: the modifier key is decided when its module is evaluated. */
async function rowsOn(platform) {
  vi.stubGlobal('navigator', { platform, userAgent: platform === 'MacIntel' ? 'Macintosh' : 'Windows' });
  vi.resetModules();
  const { openShortcuts } = await import('../src/ui/shortcuts.js');
  openShortcuts();
  const rows = [...document.querySelectorAll('.modal-panel.wide .shortcut-row')];
  const row = (what) => rows.find((r) => r.querySelector('.shortcut-what').textContent.startsWith(what));
  return { row, keys: (what) => row(what).querySelector('.shortcut-keys').textContent, what: (start) => row(start).querySelector('.shortcut-what').textContent };
}

it('lists Alt+Right and Alt+Left for the next and previous sheet, with the Page keys beside them', async () => {
  const { row, keys, what } = await rowsOn('Win32');
  expect(keys('Next / previous sheet')).toBe('Alt+→/Alt+←');
  expect(what('Next / previous sheet')).toBe('Next / previous sheet (also Ctrl + Page Down / Page Up)');
  expect(row('Previous / next sheet')).toBeUndefined(); // the old row, which named the Page keys alone
  // Off a Mac the column and formula rows keep their one chord each.
  expect(keys('Select the column')).toBe('Ctrl+Space');
  expect(keys('Show formulas instead of values')).toBe('Ctrl+`');
});

it('names Control beside the command key for the column and formulas on a Mac', async () => {
  const { keys, what } = await rowsOn('MacIntel');
  expect(keys('Select the column')).toBe('⌘+Spaceor⌃+Space');
  expect(keys('Show formulas instead of values')).toBe('⌘+`or⌃+`');
  expect(what('Next / previous sheet')).toBe('Next / previous sheet (also ⌃ or ⌘ + Page Down / Page Up)');
});

it('offers Control+` for Show formulas in the menus and command palette on a Mac, where ⌘+` moves between windows', async () => {
  for (const [platform, shown, aria] of [['MacIntel', '⌃+`', 'Control+`'], ['Win32', 'Ctrl+`', 'Control+`']]) {
    vi.stubGlobal('navigator', { platform, userAgent: platform === 'MacIntel' ? 'Macintosh' : 'Windows' });
    vi.resetModules();
    const { menubarMenus, menuLeaves } = await import('../src/ui/menubar.js');
    const { paletteCommands } = await import('../src/ui/palette.js');
    const { ariaKeyShortcuts } = await import('../src/ui/menu.js');
    const item = menubarMenus({}).flatMap((m) => menuLeaves(m.items)).find((i) => i.cmd === 'showFormulas');
    expect(item.shortcut, platform).toBe(shown);
    expect(ariaKeyShortcuts(item.shortcut), platform).toBe(aria);
    expect(paletteCommands({}).find((c) => c.cmd === 'showFormulas').shortcut, platform).toBe(shown);
  }
});

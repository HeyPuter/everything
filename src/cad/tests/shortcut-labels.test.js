// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/ui/dom.js', async (original) => ({ ...(await original()), MOD: 'Cmd' }));
const { commandTip } = await import('../src/ui/ribbon.js');
const { StatusBar } = await import('../src/ui/statusbar.js');
const { buildRegistry } = await import('../src/editor/commands/index.js');

describe('shortcut labels on a Mac', () => {
  it('name Cmd in ribbon tooltips, as the menus do', () => {
    const commands = buildRegistry();
    expect(commandTip(commands.get('COPYCLIP'))['data-tip-keys']).toBe('Cmd+C');
    expect(commandTip(commands.get('COPYBASE'))['data-tip-keys']).toBe('Cmd+Shift+C');
    expect(commandTip(commands.get('LINE'))['data-tip-keys']).toBe(null);
  });

  it('name Cmd for clean screen in the status bar', () => {
    const sb = new StatusBar({ settings: {}, toggleSetting() {}, run() {}, toggleCleanScreen() {} });
    expect(sb.el.querySelector('[aria-label="Clean screen"]').dataset.tipKeys).toBe('Cmd+0');
  });
});

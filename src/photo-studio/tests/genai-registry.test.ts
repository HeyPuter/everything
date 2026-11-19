// AI Recompose, Remove Reflections, Rotate Object and the editor modes in the
// real registries: menu places, and the Assistant finds them as AI commands.
import { beforeAll, describe, expect, it } from 'vitest';
import { Catalog } from '../src/features/assistant/catalog';
import { loadRegistry } from './registry-fixture';

type Registry = Awaited<ReturnType<typeof loadRegistry>>;
let reg: Registry;
let catalog: Catalog;
let edit: unknown[];
let windowMenu: unknown[];
beforeAll(async () => {
  reg = await loadRegistry();
  const { menuSkeleton } = await import('../src/app/menus');
  const { withContributions } = await import('../src/app/menubar');
  const items = (id: string) => withContributions(id, menuSkeleton.find((m) => m.id === id)!.items);
  edit = items('edit');
  windowMenu = items('window');
  catalog = new Catalog({
    commands: reg.commands,
    tools: reg.tools,
    panels: reg.panels,
    skeleton: menuSkeleton,
    contributions: reg.menuContributions,
  });
}, 60_000);

describe('generative layout commands', () => {
  it('sit in the Edit menu after the other generative commands and after Transform', () => {
    const at = (id: string) =>
      edit.findIndex((i) => i === id || (typeof i === 'object' && (i as { id: string }).id === id));
    expect(at('edit.ai-recompose')).toBe(at('assistant.ask') + 1);
    expect(at('edit.remove-reflections')).toBe(at('edit.ai-recompose') + 1);
    expect(at('edit.rotate-object')).toBe(at('edit.transform') + 1);
    for (const id of ['edit.ai-recompose', 'edit.remove-reflections', 'edit.rotate-object']) {
      const c = reg.commands.get(id)!;
      expect(c.label.endsWith('…')).toBe(true);
      expect(c.recordable).toBe(false);
      expect(c.description).toMatch(/Puter AI/);
    }
  });
  it('are found by the Assistant as AI commands', () => {
    const top = (q: string) => catalog.search(q, { kind: 'command', limit: 5 }).map((e) => e.id);
    expect(top('remove the glare on the window')).toContain('edit.remove-reflections');
    expect(top('rotate object in depth')).toContain('edit.rotate-object');
    expect(top('reposition')).toContain('edit.ai-recompose');
    expect(top('recompose')[0]).toBe('edit.ai-recompose');
    expect(catalog.get('edit.ai-recompose')?.input).toBe('ai');
  });
  it('switch editor modes from Window › Editor Mode', () => {
    const sub = windowMenu.find(
      (i) => typeof i === 'object' && (i as { id: string }).id === 'window.editor-mode',
    ) as { items: string[] } | undefined;
    expect(sub?.items).toEqual([
      'window.mode-assisted',
      'window.mode-pro',
      '-',
      'window.mode-switch',
    ]);
    expect(windowMenu.indexOf(sub)).toBe(windowMenu.indexOf('window.contextual-taskbar') + 1);
    expect(reg.commands.get('window.mode-switch')?.checked?.(reg.editor)).toBe(true);
  });
});

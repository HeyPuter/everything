import { beforeAll, describe, expect, it } from 'vitest';
import { brushSizeStep, normalizeShortcut, platformShortcut, shortcutConflicts } from '../src/app/shortcuts';
import { loadRegistry } from './registry-fixture';

describe('shortcut strings', () => {
  it('normalizes modifiers and keys, including "+" as the key', () => {
    expect(normalizeShortcut('shift+mod+z')).toBe('Mod+Shift+Z');
    expect(normalizeShortcut('Opt+Cmd+0')).toBe('Alt+0');
    expect(normalizeShortcut('Mod++')).toBe('Mod++');
    expect(normalizeShortcut('Alt+Shift+Backspace')).toBe('Alt+Shift+Backspace');
  });
  it('maps Ctrl onto Mod away from macOS', () => {
    expect(platformShortcut('Mod+Ctrl+F', true)).toBe('Mod+Ctrl+F');
    expect(platformShortcut('Mod+Ctrl+F', false)).toBeNull();
    expect(platformShortcut('Ctrl+Tab', false)).toBe('Mod+Tab');
    expect(platformShortcut('Mod++', false)).toBe('Mod++');
  });
  it('steps brush sizes finely when small', () => {
    expect(brushSizeStep(5, true)).toBe(6);
    expect(brushSizeStep(50, true)).toBe(60);
    expect(brushSizeStep(150, false)).toBe(125);
    expect(brushSizeStep(1, false)).toBe(1);
  });
});

describe('conflict detection', () => {
  const tools = [
    { id: 'brush', key: 'B', group: 'brush' },
    { id: 'pencil', key: 'B', group: 'brush' },
  ];
  it('accepts distinct bindings and tool groups sharing a key', () => {
    expect(shortcutConflicts([{ id: 'a', shortcut: 'Mod+A' }, { id: 'b', shortcut: ['Mod+B', 'F5'] }], tools, true)).toEqual([]);
  });
  it('reports two commands on one shortcut', () => {
    expect(shortcutConflicts([{ id: 'a', shortcut: 'Mod+Shift+A' }, { id: 'b', shortcut: 'shift+mod+a' }], [], true)).toEqual(['Mod+Shift+A is bound to both a and b']);
  });
  it('reports collisions that only exist on one platform', () => {
    const list = [{ id: 'a', shortcut: 'Mod+K' }, { id: 'b', shortcut: 'Ctrl+K' }];
    expect(shortcutConflicts(list, [], true)).toEqual([]);
    expect(shortcutConflicts(list, [], false)).toEqual(['Mod+K is bound to both a and b']);
    expect(shortcutConflicts([{ id: 'c', shortcut: 'Mod+Ctrl+F' }], [], false)).toEqual(['c: Mod+Ctrl+F cannot be typed on Windows/Linux']);
  });
  it('reports bare-key commands that hide tool keys and keys used by two slots', () => {
    expect(shortcutConflicts([{ id: 'swap', shortcut: 'B' }], tools, true)).toEqual(['brush: tool key B is taken by swap', 'pencil: tool key B is taken by swap']);
    expect(shortcutConflicts([], [...tools, { id: 'bucket', key: 'b', group: 'fill' }], true)).toEqual(['tool key B is used in the brush and fill slots']);
  });
});

describe('registered shortcuts', () => {
  let registry: Awaited<ReturnType<typeof loadRegistry>>;
  beforeAll(async () => {
    registry = await loadRegistry();
  }, 60_000);
  const shortcutOf = (id: string) => {
    const s = registry.commands.get(id)?.shortcut;
    return (Array.isArray(s) ? s : s ? [s] : []).map(normalizeShortcut);
  };

  it('has no two enabled commands on one shortcut, on any platform', () => {
    // Commands are dispatched globally (tools handle their own keys first), so
    // a shared shortcut is a conflict whatever the commands' enabled state.
    for (const mac of [true, false]) expect(shortcutConflicts(registry.commands.values(), registry.tools.values(), mac)).toEqual([]);
  });

  it('matches the conventional shortcuts of professional raster editors', () => {
    const expected: Record<string, string> = {
      'file.new': 'Mod+N', 'file.open': 'Mod+O', 'file.close': 'Mod+W', 'file.close-all': 'Mod+Alt+W', 'file.close-others': 'Mod+Alt+P',
      'file.save': 'Mod+S', 'file.save-as': 'Mod+Shift+S', 'file.save-copy': 'Mod+Alt+S', 'file.revert': 'F12',
      'file.export-as': 'Mod+Alt+Shift+W', 'file.export-web': 'Mod+Alt+Shift+S', 'file.quick-export-png': "Mod+Shift+'", 'layer.export-as': "Mod+Alt+Shift+'",
      'file.info': 'Mod+Alt+Shift+I', 'file.print': 'Mod+P', 'file.print-one-copy': 'Mod+Alt+Shift+P',
      'edit.undo': 'Mod+Z', 'edit.redo': 'Mod+Shift+Z', 'edit.toggle-last-state': 'Mod+Alt+Z', 'edit.fade': 'Mod+Shift+F',
      'edit.cut': 'Mod+X', 'edit.copy': 'Mod+C', 'edit.copy-merged': 'Mod+Shift+C', 'edit.paste': 'Mod+V', 'edit.paste-in-place': 'Mod+Shift+V', 'edit.paste-into': 'Mod+Alt+Shift+V',
      'edit.search': 'Mod+F', 'edit.fill': 'Shift+F5', 'edit.fill-foreground': 'Alt+Backspace', 'edit.fill-background': 'Mod+Backspace',
      'edit.context-scale': 'Mod+Alt+Shift+C', 'edit.free-transform': 'Mod+T', 'edit.transform-again': 'Mod+Shift+T',
      'edit.color-settings': 'Mod+Shift+K', 'edit.keyboard-shortcuts': 'Mod+Alt+Shift+K', 'edit.menus': 'Mod+Alt+Shift+M', 'edit.preferences': 'Mod+K',
      'adjust.levels': 'Mod+L', 'adjust.curves': 'Mod+M', 'adjust.hue-saturation': 'Mod+U', 'adjust.color-balance': 'Mod+B', 'adjust.black-white': 'Mod+Alt+Shift+B',
      'adjust.invert': 'Mod+I', 'adjust.desaturate': 'Mod+Shift+U', 'image.auto-tone': 'Mod+Shift+L', 'image.auto-contrast': 'Mod+Alt+Shift+L', 'image.auto-color': 'Mod+Shift+B',
      'image.image-size': 'Mod+Alt+I', 'image.upscale': 'Mod+Alt+Shift+U', 'image.canvas-size': 'Mod+Alt+C', 'analysis.record': 'Mod+Shift+M',
      'layer.new': 'Mod+Shift+N', 'layer.via-copy': 'Mod+J', 'layer.via-cut': 'Mod+Shift+J', 'layer.clipping-mask': 'Mod+Alt+G',
      'layer.group': 'Mod+G', 'layer.ungroup': 'Mod+Shift+G', 'layer.hide': 'Mod+,', 'layer.lock-all': 'Mod+/',
      'layer.bring-front': 'Mod+Shift+]', 'layer.bring-forward': 'Mod+]', 'layer.send-backward': 'Mod+[', 'layer.send-back': 'Mod+Shift+[',
      'layer.merge-down': 'Mod+E', 'layer.merge-visible': 'Mod+Shift+E', 'layer.stamp-visible': 'Mod+Alt+Shift+E',
      'layer.select-forward': 'Alt+]', 'layer.select-backward': 'Alt+[', 'layer.select-front': 'Alt+.', 'layer.select-back': 'Alt+,',
      'select.all': 'Mod+A', 'select.deselect': 'Mod+D', 'select.reselect': 'Mod+Shift+D', 'select.inverse': 'Mod+Shift+I',
      'select.all-layers': 'Mod+Alt+A', 'select.find-layers': 'Mod+Alt+Shift+F', 'select.mask-refine': 'Mod+Alt+R', 'select.modify-feather': 'Shift+F6', 'select.quick-mask': 'Q',
      'filter.adaptive-wide-angle': 'Mod+Alt+Shift+A', 'filter.develop': 'Mod+Shift+A', 'filter.lens-correction': 'Mod+Shift+R', 'filter.liquify': 'Mod+Shift+X', 'filter.vanishing-point': 'Mod+Alt+V',
      'view.proof-colors': 'Mod+Y', 'view.gamut-warning': 'Mod+Shift+Y', 'view.zoom-in': 'Mod+=', 'view.zoom-out': 'Mod+-', 'view.fit': 'Mod+0', 'view.actual-pixels': 'Mod+1',
      'view.extras': 'Mod+H', 'view.show-target-path': 'Mod+Shift+H', 'view.show-grid': "Mod+'", 'view.show-guides': 'Mod+;', 'view.rulers': 'Mod+R', 'view.snap': 'Mod+Shift+;', 'view.guides-lock': 'Mod+Alt+;',
      'view.cycle-screen-mode': 'F', 'window.toggle-panels': 'Tab', 'color.default': 'D', 'color.swap': 'X',
      'window.panel.brush-settings': 'F5', 'window.panel.color': 'F6', 'window.panel.layers': 'F7', 'window.panel.info': 'F8', 'window.panel.actions': 'Alt+F9',
    };
    const missing = Object.entries(expected).filter(([id, s]) => !shortcutOf(id).includes(normalizeShortcut(s)));
    expect(missing).toEqual([]);
  });

  it('gives every toolbar slot its conventional tool key', () => {
    const expected: Record<string, string[]> = {
      V: ['move', 'artboard'], M: ['rect-marquee', 'ellipse-marquee'], L: ['lasso', 'polygonal-lasso', 'magnetic-lasso'], W: ['object-selection', 'quick-selection', 'magic-wand'],
      C: ['crop', 'perspective-crop', 'slice', 'slice-select'], K: ['frame'], I: ['eyedropper', 'color-sampler', 'ruler', 'count', 'note', 'comment'],
      J: ['spot-healing', 'healing-brush', 'patch', 'context-move', 'remove-tool', 'red-eye'], B: ['brush', 'pencil', 'color-replacement', 'mixer-brush'],
      S: ['clone-stamp', 'pattern-stamp'], Y: ['history-brush', 'art-history'], E: ['eraser', 'background-eraser', 'magic-eraser'], G: ['gradient', 'bucket'],
      O: ['dodge', 'burn', 'sponge'], P: ['pen', 'freeform-pen', 'curvature-pen'], T: ['type', 'type-vertical', 'type-mask', 'type-mask-vertical'],
      A: ['path-select', 'direct-select'], U: ['rect-shape', 'ellipse-shape', 'triangle-shape', 'polygon-shape', 'line-shape', 'custom-shape'],
      H: ['hand'], R: ['rotate-view'], Z: ['zoom'],
    };
    const byKey: Record<string, string[]> = {};
    for (const t of registry.tools.values()) if (t.key) (byKey[t.key.toUpperCase()] ??= []).push(t.id);
    for (const [key, ids] of Object.entries(expected)) expect(byKey[key]?.sort(), `tool key ${key}`).toEqual([...ids].sort());
  });
});

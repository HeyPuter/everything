import { describe, it, expect } from 'vitest';
import { bootApp } from './helpers.js';
import { Panel } from '../src/ui/panels/panel.js';

class MenuPanel extends Panel {
  static id = 'menuTest';
  static title = 'Menu Test';
  static placement = 'strip';
  ran = 0;
  menu() {
    return [{ label: 'Do Thing', run: () => this.ran++ }, '-', { label: 'Disabled', enabled: false, run() {} }];
  }
}

class PlainPanel extends Panel {
  static id = 'plainTest';
  static title = 'Plain Test';
  static placement = 'strip';
}

describe('panel options menus', () => {
  it('shows a menu button in the flyout header for every panel (the workspace items)', () => {
    const app = bootApp({ install: (a) => (a.registerPanel(MenuPanel), a.registerPanel(PlainPanel)) });
    const btn = () => document.querySelector('.panel-flyout .panel-menu-btn');
    app.dock.openPanel('plainTest');
    expect(btn().hidden).toBe(false);
    btn().click();
    expect([...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((i) => i.textContent.trim())).toEqual(['Float Panel', 'Dock as Tab']);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    app.dock.openPanel('menuTest');
    expect(btn().hidden).toBe(false);
    expect(btn().getAttribute('aria-label')).toBe('Menu Test panel menu');
  });

  it('opens the panel menu and runs its items', () => {
    const app = bootApp({ install: (a) => a.registerPanel(MenuPanel) });
    app.dock.openPanel('menuTest');
    document.querySelector('.panel-flyout .panel-menu-btn').click();
    const items = [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')];
    // The panel's own items, then the workspace items.
    expect(items.map((i) => i.textContent.trim())).toEqual(['Do Thing', 'Disabled', 'Float Panel', 'Dock as Tab']);
    items[0].click();
    expect(app.dock.panels.get('menuTest').ran).toBe(1);
  });

  it('tracks the active dock tab', () => {
    const app = bootApp();
    const btn = document.querySelector('.dock-head .panel-menu-btn');
    // Every dock tab has a menu: at least Float Panel and Collapse to Icon.
    expect(btn.hidden).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe(`${app.dock.panels.get(app.dock.getLayout().active).constructor.title} panel menu`);
  });
});

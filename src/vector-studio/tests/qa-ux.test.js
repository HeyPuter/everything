// Regression tests from the UX, accessibility, responsive and performance QA pass.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const css = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'styles', f), 'utf8');

/** Token values per theme from tokens.css. */
function tokens() {
  const src = css('tokens.css');
  const block = (re) => {
    const m = re.exec(src);
    const out = {};
    for (const [, k, v] of m[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[k] = v.trim();
    return out;
  };
  const base = block(/:root \{([^}]*)\}/);
  return {
    light: { ...base, ...block(/:root\[data-theme-resolved='light'\] \{([^}]*)\}/) },
    dark: { ...base, ...block(/:root\[data-theme-resolved='dark'\] \{([^}]*)\}/) },
  };
}

function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe('theme contrast (WCAG AA 4.5:1 for small text)', () => {
  for (const [theme, t] of Object.entries(tokens())) {
    it(`${theme}: secondary and tertiary text on every surface`, () => {
      for (const fg of ['--text', '--text-2', '--text-3']) {
        for (const bg of ['--bg-app', '--bg-topbar', '--bg-panel', '--bg-panel-2', '--bg-elev', '--bg-input']) {
          expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
    it(`${theme}: text on accent buttons and menu highlights`, () => {
      expect(contrast(t['--on-accent'], t['--accent'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--on-accent'], t['--accent-hover'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--tooltip-fg'], t['--tooltip-bg'])).toBeGreaterThanOrEqual(4.5);
    });
    it(`${theme}: links on panels and dialogs`, () => {
      for (const bg of ['--bg-app', '--bg-panel', '--bg-elev']) expect(contrast(t['--link'], t[bg]), bg).toBeGreaterThanOrEqual(4.5);
    });
  }
  it('menu shortcuts keep full contrast on the highlighted row', () => {
    expect(css('overlays.css')).not.toMatch(/\.menu-item:hover \.menu-shortcut \{[^}]*opacity/);
  });
});

describe('tooltips', () => {
  it('hide the empty tooltip from assistive tech and link it to its control while shown', async () => {
    const { bootApp } = await import('./helpers.js');
    bootApp();
    const tip = document.getElementById('app-tooltip');
    expect(tip.getAttribute('aria-hidden')).toBe('true');
    const btn = document.querySelector('.tool-btn[data-tip]');
    btn.matches = (sel) => sel === ':focus-visible' || Element.prototype.matches.call(btn, sel);
    btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 350));
    expect(tip.hasAttribute('aria-hidden')).toBe(false);
    expect(tip.textContent).toBe(btn.dataset.tip);
    expect(btn.getAttribute('aria-describedby')).toBe('app-tooltip');
    btn.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(tip.getAttribute('aria-hidden')).toBe('true');
    expect(btn.hasAttribute('aria-describedby')).toBe(false);
  });
});

describe('home screen accessibility', () => {
  it('has valid list structure and names that include the visible card text', async () => {
    const { default: axe } = await import('axe-core');
    const { bootApp } = await import('./helpers.js');
    const { installHome } = await import('../src/ui/home.js');
    const app = bootApp();
    installHome(app);
    app.recentFiles = async () => [{ name: 'Logo.ai', when: 'today' }];
    app.showHome();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelectorAll('.recent-list [role="listitem"] > button.recent-item')).toHaveLength(1);
    const result = await axe.run(app.home, { runOnly: ['aria-required-children', 'aria-required-parent', 'label-content-name-mismatch', 'list', 'listitem', 'aria-allowed-role'] });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    // An empty recent list is a message, not a list.
    app.recentFiles = async () => [];
    app.showHome();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.home.querySelector('.recent-list').hasAttribute('role')).toBe(false);
  });
});

describe('landmarks and headings', () => {
  it('puts the panel strip in a landmark, has a page heading and a focusable shortcut table', async () => {
    const { default: axe } = await import('axe-core');
    const { bootApp } = await import('./helpers.js');
    const app = bootApp();
    app.newDocument();
    expect(document.querySelector('.panel-strip').closest('aside[aria-label]')).not.toBeNull();
    expect(document.querySelector('h1').textContent).toBe('Vector Studio');
    expect(document.querySelector('.panels-area > h2').textContent).toBe('Panels');
    expect(document.getElementById('canvas-desc').closest('main')).not.toBeNull();
    app.showShortcuts();
    const result = await axe.run(document, { runOnly: ['page-has-heading-one', 'landmark-complementary-is-top-level', 'landmark-unique', 'scrollable-region-focusable', 'landmark-no-duplicate-main'] });
    expect(result.violations.map((v) => v.id)).toEqual([]);
    expect(document.querySelector('.shortcut-table-wrap').tabIndex).toBe(0);
  });
});

describe('selection performance', () => {
  async function bigSelection(n) {
    const { bootApp } = await import('./helpers.js');
    const { createPath } = await import('../src/model/nodes.js');
    const { rectangle } = await import('../src/model/shapes.js');
    const app = bootApp();
    const ed = app.newDocument();
    const layer = ed.targetLayer();
    const ids = [];
    ed.doc.transact('add', () => {
      for (let i = 0; i < n; i++) {
        const p = createPath(rectangle(i * 6, 0, 5, 5), true, { fill: { type: 'color', color: '#ff0000' } });
        ed.doc.insert(p, layer.id);
        ids.push(p.id);
      }
    });
    ed.select(ids);
    return { app, ed, ids };
  }

  it('finds the top selection without comparing every pair', async () => {
    const { ed, ids } = await bigSelection(4000);
    let calls = 0;
    const orig = ed.doc.isAncestor.bind(ed.doc);
    ed.doc.isAncestor = (a, b) => (calls++, orig(a, b));
    expect(ed.topSelection()).toHaveLength(ids.length);
    expect(calls).toBeLessThan(ids.length);
    expect(ed.selectedAnchors(ids[5]).size).toBe(4);
  });

  it('caches paint order until the document changes', async () => {
    const { ed, ids } = await bigSelection(10);
    const a = ed.doc.paintOrder();
    expect(ed.doc.paintOrder()).toBe(a);
    ed.doc.transact('move', () => ed.doc.move(ids[0], ed.targetLayer().id));
    const b = ed.doc.paintOrder();
    expect(b).not.toBe(a);
    expect(b.get(ids[0])).toBeGreaterThan(b.get(ids[9]));
  });

  it('draws a large selection in a few canvas calls', async () => {
    const { ed } = await bigSelection(500);
    const { drawOverlay } = await import('../src/render/overlay.js');
    const counts = {};
    const ctx = new Proxy(
      { measureText: () => ({ width: 10 }) },
      {
        get(t, k) {
          if (k in t) return t[k];
          return (...args) => {
            counts[k] = (counts[k] || 0) + 1;
            return args;
          };
        },
        set(t, k, v) {
          t[k] = v;
          return true;
        },
      },
    );
    ed.tool = { selectionMode: 'object', showsBoundingBox: true };
    drawOverlay(ctx, ed, { selection: '#4f80ff', artboardLabel: '#000', guide: '#0ff', alignment: '#f0f' });
    const calls = (counts.stroke || 0) + (counts.fill || 0) + (counts.fillRect || 0) + (counts.strokeRect || 0);
    expect(calls).toBeLessThan(40);
  });
});

describe('selection-derived caches', () => {
  it('recompute bounds and common paint only when the selection or document changes', async () => {
    const { bootApp } = await import('./helpers.js');
    const { createPath } = await import('../src/model/nodes.js');
    const { rectangle } = await import('../src/model/shapes.js');
    const { commonStyle } = await import('../src/ops/paint-ops.js');
    const app = bootApp();
    const ed = app.newDocument();
    const a = createPath(rectangle(0, 0, 10, 10), true, { fill: { type: 'color', color: '#ff0000' } });
    const b = createPath(rectangle(20, 0, 10, 10), true, { fill: { type: 'color', color: '#ff0000' } });
    ed.doc.transact('add', () => [a, b].forEach((n) => ed.doc.insert(n, ed.targetLayer().id)));
    ed.select([a.id]);
    let computed = 0;
    expect(ed.memo('k', () => ++computed)).toBe(1);
    expect(ed.memo('k', () => ++computed)).toBe(1);
    expect(ed.selectionBounds()).toMatchObject({ x: 0, w: 10 });
    ed.selection.add(b.id); // direct mutation still invalidates
    expect(ed.memo('k', () => ++computed)).toBe(2);
    expect(ed.selectionBounds()).toMatchObject({ x: 0, w: 30 });
    expect(commonStyle(ed, 'fill')).toMatchObject({ color: '#ff0000' });
    ed.doc.transact('paint', () => ed.doc.update(b.id, { fill: { type: 'color', color: '#00ff00' } }));
    expect(commonStyle(ed, 'fill')).toBe('mixed');
    ed.doc.transact('move', () => ed.doc.update(b.id, { anchors: rectangle(40, 0, 10, 10) }));
    expect(ed.selectionBounds()).toMatchObject({ x: 0, w: 50 });
    ed.doc.undo();
    expect(ed.selectionBounds()).toMatchObject({ x: 0, w: 30 });
  });
});

describe('large selections stay linear', () => {
  it('builds the drag snap index without pairwise ancestor tests and skips excluded objects', async () => {
    const { bootApp } = await import('./helpers.js');
    const { createPath, createGroup } = await import('../src/model/nodes.js');
    const { rectangle } = await import('../src/model/shapes.js');
    const { buildSnapIndex } = await import('../src/tools/snap.js');
    const { lockOrHideOthers } = await import('../src/ops/object-ops.js');
    const app = bootApp();
    const ed = app.newDocument();
    const layer = ed.targetLayer();
    const ids = [];
    const kid = createPath(rectangle(-500, -500, 5, 5), true);
    const group = createGroup([kid.id]);
    ed.doc.transact('add', () => {
      for (let i = 0; i < 2000; i++) {
        const p = createPath(rectangle(i * 6, 0, 5, 5), true);
        ed.doc.insert(p, layer.id);
        ids.push(p.id);
      }
      ed.doc.insert(group, layer.id, Infinity, [{ ...kid, parent: group.id }]);
    });
    let calls = 0;
    const orig = ed.doc.isAncestor.bind(ed.doc);
    ed.doc.isAncestor = (a, b) => (calls++, orig(a, b));
    const { index } = buildSnapIndex(ed, new Set([...ids.slice(1), group.id]));
    expect(calls).toBe(0);
    expect(index.points.some((p) => p.x === -500)).toBe(false); // inside the excluded group
    expect(index.points.some((p) => p.x === 6)).toBe(false);
    expect(index.points.some((p) => p.x === 0 && p.kind === 'anchor')).toBe(true);
    ed.doc.isAncestor = orig;
    ed.select([kid.id]);
    lockOrHideOthers(ed, 'hidden');
    expect(ed.doc.get(group.id).hidden).toBe(false);
    expect(ed.doc.get(ids[0]).hidden).toBe(true);
  });
});

describe('touch input', () => {
  async function setup() {
    const { bootApp } = await import('./helpers.js');
    const { createPath } = await import('../src/model/nodes.js');
    const { rectangle } = await import('../src/model/shapes.js');
    const app = bootApp();
    const ed = app.newDocument();
    ed.view.set({ width: 800, height: 600, zoom: 1, panX: 0, panY: 0 });
    app.canvasHost.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 });
    const r = createPath(rectangle(100, 100, 200, 200), true, { fill: { type: 'solid', color: '#3366ff' } });
    ed.doc.transact('add', () => ed.doc.insert(r, ed.targetLayer().id));
    const other = createPath(rectangle(400, 100, 50, 50), true, { fill: { type: 'solid', color: '#ff0000' } });
    ed.doc.transact('add', () => ed.doc.insert(other, ed.targetLayer().id));
    const t = (pointerId, x, y) => ({ pointerId, pointerType: 'touch', clientX: x, clientY: y, button: 0, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, pressure: 0.5 });
    return { app, ed, r, other, input: app.input, t };
  }

  it('does not change the selection when a pinch starts with one finger', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const { ed, other, input, t } = await setup();
      ed.select([other.id]);
      input.down(t(1, 200, 200)); // on the big rectangle
      input.down(t(2, 260, 200));
      expect(input.gesture).not.toBeNull();
      input.move(t(2, 320, 200));
      input.up(t(1, 200, 200));
      input.up(t(2, 320, 200));
      vi.advanceTimersByTime(1000);
      expect([...ed.selection]).toEqual([other.id]);
      expect(ed.view.zoom).toBeGreaterThan(1);
      expect(document.querySelector('.menu')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('selects on tap and opens the context menu on a long press', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const { ed, r, other, input, t } = await setup();
      input.down(t(1, 200, 200));
      input.up(t(1, 200, 200));
      expect([...ed.selection]).toEqual([r.id]);
      input.down(t(1, 420, 120));
      vi.advanceTimersByTime(700);
      expect(document.querySelector('.menu[role="menu"]')).not.toBeNull();
      expect([...ed.selection]).toEqual([other.id]);
      input.up(t(1, 420, 120));
      expect(ed.doc.undoLabel).toBe('add');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('canvas context menu', () => {
  it('lists only applicable commands with descriptive labels', async () => {
    const { bootApp } = await import('./helpers.js');
    const { createPath } = await import('../src/model/nodes.js');
    const { rectangle } = await import('../src/model/shapes.js');
    const app = bootApp();
    const ed = app.newDocument();
    const a = createPath(rectangle(0, 0, 10, 10), true);
    const b = createPath(rectangle(5, 5, 10, 10), true);
    ed.doc.transact('add', () => [a, b].forEach((n) => ed.doc.insert(n, ed.targetLayer().id)));
    app.showContextMenu(10, 10);
    let labels = [...document.querySelectorAll('.menu .menu-label')].map((l) => l.textContent);
    expect(labels).not.toContain('Cut');
    expect(document.querySelectorAll('.menu [aria-disabled="true"]')).toHaveLength(0);
    document.querySelector('.menu').remove();
    ed.select([a.id, b.id]);
    app.showContextMenu(10, 10);
    labels = [...document.querySelectorAll('.menu .menu-label')].map((l) => l.textContent);
    expect(labels).toContain('Cut');
    expect(labels).toContain('Make Clipping Mask');
    expect(labels).toContain('Make Compound Path');
    expect(labels).not.toContain('Make');
    expect(document.querySelector('.menu .menu-sep:first-child')).toBeNull();
  });
});

describe('status bar zoom presets', () => {
  it('opens a themed menu of presets and applies the chosen zoom', async () => {
    const { bootApp } = await import('./helpers.js');
    const app = bootApp();
    const ed = app.newDocument();
    ed.view.set({ width: 800, height: 600 });
    const btn = document.querySelector('button.status-zoom-menu[aria-haspopup="menu"]');
    expect(btn.getAttribute('aria-label')).toBe('Zoom presets');
    btn.click();
    const items = [...document.querySelectorAll('.menu[aria-label="Zoom presets"] .menu-item')];
    expect(items.map((i) => i.textContent)).toContain('200%');
    items.find((i) => i.textContent.startsWith('200%')).click();
    expect(ed.view.zoom).toBeCloseTo(2);
    expect(document.querySelector('.status-zoom').value).toBe('200%');
  });
});

describe('keyboard focus', () => {
  it('lets Tab move focus from the page instead of hiding panels, but keeps Tab on a clicked canvas', async () => {
    const { bootApp } = await import('./helpers.js');
    const app = bootApp();
    app.newDocument();
    const tab = (target) => {
      const e = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(tab(document.body)).toBe(false);
    expect(app.root.classList.contains('hide-panels')).toBe(false);
    app.canvasHost.focus();
    expect(tab(app.canvasHost)).toBe(true);
    expect(app.root.classList.contains('hide-panels')).toBe(true);
  });
});

describe('panel strip and panel toggle', () => {
  it('makes the collapsed panel strip a single Tab stop with arrow navigation', async () => {
    const { bootApp } = await import('./helpers.js');
    const { Panel } = await import('../src/ui/panels/panel.js');
    const app = bootApp();
    // Register two strip panels on a fresh dock.
    class A extends Panel {
      static id = 'qa-a';
      static title = 'QA A';
      static icon = 'info';
      static placement = 'strip';
    }
    class B extends A {
      static id = 'qa-b';
      static title = 'QA B';
    }
    app.dock.register(A);
    app.dock.register(B);
    const btns = [...document.querySelectorAll('.strip-btn')];
    expect(btns.map((b) => b.tabIndex)).toEqual([0, -1]);
    btns[0].focus();
    btns[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(btns[1]);
    expect(btns.map((b) => b.tabIndex)).toEqual([-1, 0]);
  });

  it('reports whether panels are shown on the status bar toggle', async () => {
    const { bootApp } = await import('./helpers.js');
    const app = bootApp();
    app.newDocument();
    const btn = document.querySelector('.status-panels');
    app.setDockOpen(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    app.setDockOpen(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('canvas selection description', () => {
  it('describes the selection for screen readers and announces it on the canvas', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const { bootApp } = await import('./helpers.js');
      const { createPath, createText } = await import('../src/model/nodes.js');
      const { rectangle } = await import('../src/model/shapes.js');
      const app = bootApp();
      const ed = app.newDocument();
      const r = createPath(rectangle(0, 0, 20, 10), true, {}, { shape: { kind: 'rect' } });
      const t = createText('Hello', 50, 50);
      ed.doc.transact('add', () => [r, t].forEach((n) => ed.doc.insert(n, ed.targetLayer().id)));
      expect(app.canvasHost.getAttribute('aria-describedby')).toBe('canvas-desc');
      app.canvasHost.focus();
      ed.select([r.id]);
      vi.advanceTimersByTime(400);
      expect(document.getElementById('canvas-desc').textContent).toBe('Rectangle selected, 20 pt by 10 pt');
      expect(document.getElementById('live-region').textContent).toBe('Rectangle selected, 20 pt by 10 pt');
      ed.select([r.id, t.id]);
      vi.advanceTimersByTime(400);
      expect(document.getElementById('canvas-desc').textContent).toBe('2 objects selected');
      ed.select([t.id]);
      vi.advanceTimersByTime(400);
      expect(document.getElementById('canvas-desc').textContent).toMatch(/^Text "Hello" selected/);
      ed.clearSelection();
      vi.advanceTimersByTime(400);
      expect(document.getElementById('canvas-desc').textContent).toBe('No selection');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('global shortcuts and focused controls', () => {
  it('leaves Enter and Space to the focused button instead of running canvas shortcuts', async () => {
    const { bootApp } = await import('./helpers.js');
    const app = bootApp();
    app.newDocument();
    const btn = document.querySelector('.strip-btn') || document.querySelector('.tool-btn');
    btn.focus();
    for (const key of ['Enter', ' ']) {
      const e = new KeyboardEvent('keydown', { key, code: key === ' ' ? 'Space' : 'Enter', bubbles: true, cancelable: true });
      btn.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(app.input.spaceDown).toBeFalsy();
    // On the canvas Space is still a shortcut (temporary Hand tool).
    app.canvasHost.focus();
    const e = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
    app.canvasHost.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe('menu focus return', () => {
  it('returns focus to the document after a menu bar command, and to the opener for other menus', async () => {
    const { bootApp } = await import('./helpers.js');
    const { openMenu } = await import('../src/ui/menubar.js');
    const app = bootApp();
    app.newDocument();
    const selectMenu = [...document.querySelectorAll('.menubar-item')].find((b) => b.textContent === 'Select');
    selectMenu.focus();
    selectMenu.click();
    const all = [...document.querySelectorAll('.menu .menu-item')].find((m) => m.textContent.startsWith('All'));
    all.focus();
    all.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(app.canvasHost);
    const opener = document.querySelector('.tool-btn');
    opener.focus();
    let ran = false;
    openMenu(app, [{ type: 'cmd', label: 'Go', enabled: true, run: () => (ran = true) }], { x: 0, y: 0, anchor: opener });
    document.querySelector('.menu .menu-item').click();
    expect(ran).toBe(true);
    expect(document.activeElement).toBe(opener);
  });
});

describe('home screen chrome', () => {
  it('marks the app as having no document from the start so the empty tab strip is hidden', async () => {
    const { bootApp } = await import('./helpers.js');
    const app = bootApp();
    expect(app.root.classList.contains('no-doc')).toBe(true);
    const ed = app.newDocument();
    expect(app.root.classList.contains('no-doc')).toBe(false);
    await app.closeDocument(ed, { force: true });
    expect(app.root.classList.contains('no-doc')).toBe(true);
  });
});

describe('panel strip tooltips', () => {
  it('include the panel shortcut', async () => {
    const { bootApp } = await import('./helpers.js');
    const { Panel } = await import('../src/ui/panels/panel.js');
    const app = bootApp();
    class C extends Panel {
      static id = 'qa-c';
      static title = 'QA Color';
      static icon = 'info';
      static placement = 'strip';
      static shortcut = 'F6';
    }
    app.dock.register(C);
    const btn = document.querySelector('.strip-btn[data-panel="qa-c"]');
    expect(btn.dataset.tip).toBe('QA Color (F6)');
    expect(btn.getAttribute('aria-keyshortcuts')).toBe('F6');
  });
});

describe('live drag refresh throttling', () => {
  it('refreshes panels a few times a second while a transaction is open', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const { bootApp } = await import('./helpers.js');
      const { createPath } = await import('../src/model/nodes.js');
      const { rectangle } = await import('../src/model/shapes.js');
      const app = bootApp();
      const ed = app.newDocument();
      const r = createPath(rectangle(0, 0, 10, 10), true);
      ed.doc.transact('add', () => ed.doc.insert(r, ed.targetLayer().id));
      ed.select([r.id]);
      vi.advanceTimersByTime(100);
      const props = app.dock.panels.get('properties');
      let updates = 0;
      const orig = props.update.bind(props);
      props.update = () => (updates++, orig());
      const tx = ed.doc.begin('Move');
      for (let i = 1; i <= 30; i++) {
        ed.doc.update(r.id, { anchors: rectangle(i, 0, 10, 10) });
        vi.advanceTimersByTime(16); // about half a second of frames
      }
      expect(updates).toBeGreaterThan(0);
      expect(updates).toBeLessThanOrEqual(5);
      tx.commit();
      vi.advanceTimersByTime(200);
      expect(updates).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The Tools panel: tool groups with flyouts, the fill/stroke control, paint
 * mode buttons and screen mode. A vertical ARIA toolbar with roving
 * tabindex; Right Arrow (or a long press, right-click, or the corner
 * triangle) opens a tool group's flyout, and Alt+click cycles a group.
 */
import { h } from '../lib/dom.js';
import { icon } from './icons.js';
import { formatShortcut } from '../commands/registry.js';
import { paintSwatch, updatePaintSwatch } from './widgets.js';
import { commonStyle, swapFillStroke, defaultFillStroke, setFocusedPaint } from '../ops/paint-ops.js';

/** Toolbar layout: sections of groups of tool ids (first is the default). */
export const TOOL_LAYOUT = [
  { label: 'Select', groups: [['selection'], ['direct-selection', 'group-selection'], ['magic-wand'], ['lasso']] },
  {
    label: 'Draw',
    groups: [
      ['pen', 'add-anchor', 'delete-anchor', 'anchor-point'],
      ['curvature'],
      ['sketch-shape', 'pencil', 'smooth', 'path-eraser', 'join'],
      ['paintbrush', 'blob-brush'],
    ],
  },
  {
    label: 'Shapes',
    groups: [
      ['rectangle', 'rounded-rectangle', 'ellipse', 'polygon', 'star', 'flare'],
      ['line', 'arc', 'spiral', 'rect-grid', 'polar-grid'],
      ['shape-builder', 'paint-bucket', 'region-select'],
    ],
  },
  { label: 'Type', groups: [['type', 'area-type', 'type-on-path', 'vertical-type', 'vertical-area-type', 'vertical-type-on-path', 'character-edit']] },
  {
    label: 'Modify',
    groups: [
      ['rotate', 'reflect'],
      ['scale', 'shear', 'reshape'],
      ['width', 'warp', 'twirl', 'pucker', 'bloat', 'scallop', 'crystallize', 'wrinkle'],
      ['free-transform', 'pin-warp'],
      ['eraser', 'scissors', 'knife'],
      ['perspective-grid', 'perspective-select'],
    ],
  },
  {
    label: 'Color',
    groups: [
      ['gradient'],
      ['mesh'],
      ['eyedropper', 'measure'],
      ['blend'],
    ],
  },
  {
    label: 'Objects',
    groups: [
      ['symbol-sprayer', 'symbol-shifter', 'symbol-scruncher', 'symbol-sizer', 'symbol-spinner', 'symbol-stainer', 'symbol-screener', 'symbol-styler'],
      ['graph-column', 'graph-stacked-column', 'graph-bar', 'graph-stacked-bar', 'graph-line', 'graph-area', 'graph-scatter', 'graph-pie', 'graph-radar'],
    ],
  },
  { label: 'Navigate', groups: [['artboard', 'slice', 'slice-select'], ['hand', 'rotate-view', 'print-tiling'], ['zoom']] },
];

export function createToolbar(app) {
  const el = h('nav.toolbar', { 'aria-label': 'Tools' });
  const list = h('div.toolbar-tools', { role: 'toolbar', 'aria-orientation': 'vertical', 'aria-label': 'Tools' });
  const groupButtons = [];
  const current = new Map(); // group index -> active tool id in that group
  let flyout = null;

  // Toolbar sets (workspaces, Edit Toolbar) hide tools through app.toolbarFilter(id).
  const registered = (id) => app.toolClasses.has(id) && (!app.toolbarFilter || app.toolbarFilter(id));

  const closeFlyout = () => {
    if (!flyout) return;
    flyout.remove();
    flyout = null;
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e) => {
    if (flyout && !flyout.contains(e.target)) closeFlyout();
  };

  const tearoffs = new Set();

  /** A floating strip of the tools `ids`, at (x, y) in the viewport. */
  const tearOff = (ids, x = 80, y = 80) => {
    closeFlyout();
    const first = app.toolClasses.get(ids[0]);
    const name = `${first.label.replace(' Tool', '')} tools`;
    const strip = h('div.tool-tearoff', { role: 'toolbar', 'aria-label': name, 'aria-orientation': 'horizontal' });
    const btns = ids.map((id) => {
      const cls = app.toolClasses.get(id);
      const b = h('button.tool-btn', { type: 'button', 'aria-label': cls.label, 'aria-pressed': String(app.toolId === id), 'data-tip': tipFor(cls), tabindex: '-1', onclick: () => app.setTool(id), ondblclick: () => app.tool?.openOptions?.() }, icon(cls.icon, 20));
      b._id = id;
      return b;
    });
    (btns.find((b) => b._id === app.toolId) || btns[0]).tabIndex = 0;
    const grip = h('div.tearoff-grip', { 'aria-hidden': 'true', title: 'Drag to move' }, icon('grip', 12));
    const flip = h('button.tearoff-mini', { type: 'button', 'aria-label': 'Toggle orientation', 'data-tip': 'Horizontal or vertical', onclick: () => {
      const vertical = strip.classList.toggle('vertical');
      strip.setAttribute('aria-orientation', vertical ? 'vertical' : 'horizontal');
      place(strip.offsetLeft, strip.offsetTop);
    } }, icon('arrow-left-right', 12));
    const close = h('button.tearoff-mini', { type: 'button', 'aria-label': `Close ${name}`, 'data-tip': 'Close', onclick: () => remove() }, icon('x', 12));
    const head = h('div.tearoff-head', grip);
    strip.append(head, h('div.tearoff-tools', btns), h('div.tearoff-ctrls', flip, close));
    const place = (left, top) => {
      strip.style.left = `${Math.max(0, Math.min(window.innerWidth - strip.offsetWidth, left))}px`;
      strip.style.top = `${Math.max(0, Math.min(window.innerHeight - strip.offsetHeight, top))}px`;
    };
    const remove = () => {
      strip.remove();
      tearoffs.delete(entry);
      groupButtons.find((b) => b._ids.includes(ids[0]))?.focus();
    };
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, left: strip.offsetLeft, top: strip.offsetTop };
      try {
        head.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointers cannot be captured.
      }
      const move = (ev) => place(start.left + ev.clientX - start.x, start.top + ev.clientY - start.y);
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });
    strip.addEventListener('keydown', (e) => {
      const i = btns.indexOf(document.activeElement);
      const vertical = strip.classList.contains('vertical');
      const next = { [vertical ? 'ArrowDown' : 'ArrowRight']: 1, [vertical ? 'ArrowUp' : 'ArrowLeft']: -1 }[e.key];
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        app.canvasHost?.focus();
        return;
      }
      if (i < 0 || !next) return;
      e.preventDefault();
      e.stopPropagation();
      btns.forEach((b) => (b.tabIndex = -1));
      const b = btns[(i + next + btns.length) % btns.length];
      b.tabIndex = 0;
      b.focus();
    });
    const entry = { strip, btns, ids };
    tearoffs.add(entry);
    document.body.append(strip);
    place(x, y);
    return strip;
  };

  const tipFor = (cls) => (cls.shortcut ? `${cls.label} (${formatShortcut(cls.shortcut)})` : cls.label);

  const openFlyout = (btn, ids, focusFirst = true, allTools = false) => {
    closeFlyout();
    const r = btn.getBoundingClientRect();
    flyout = h('div.tool-flyout', { role: 'menu', 'aria-label': `${app.toolClasses.get(ids[0]).label.replace(' Tool', '')} tools` });
    for (const id of ids) {
      const cls = app.toolClasses.get(id);
      const item = h(
        'button.flyout-item',
        {
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': String(app.toolId === id),
          tabindex: '-1',
          onclick: () => {
            closeFlyout();
            app.setTool(id);
            btn.focus();
          },
          onkeydown: (e) => {
            const items = [...flyout.querySelectorAll('.flyout-item')];
            const i = items.indexOf(e.currentTarget);
            if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
              e.preventDefault();
              items[(i + 1) % items.length].focus();
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              items[(i - 1 + items.length) % items.length].focus();
            } else if (e.key === 'Escape' || e.key === 'ArrowLeft') {
              e.preventDefault();
              closeFlyout();
              btn.focus();
            }
            e.stopPropagation();
          },
        },
        icon(cls.icon, 18),
        h('span.flyout-label', cls.label),
        h('span.flyout-shortcut', cls.shortcut ? formatShortcut(cls.shortcut) : ''),
      );
      flyout.append(item);
    }
    if (ids.length > 1 && !allTools) {
      flyout.append(
        h('button.flyout-item.flyout-tearoff', {
          type: 'button',
          role: 'menuitem',
          tabindex: '-1',
          onclick: () => tearOff(ids, r.right + 4, r.top),
          onkeydown: (e) => {
            if (e.key === 'Escape' || e.key === 'ArrowLeft') {
              e.preventDefault();
              closeFlyout();
              btn.focus();
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const items = [...flyout.querySelectorAll('.flyout-item')];
              items[e.key === 'ArrowDown' ? 0 : items.length - 2].focus();
            }
            e.stopPropagation();
          },
        }, icon('app-window', 16), h('span.flyout-label', 'Tear Off as Floating Tools'), h('span.flyout-shortcut', '')),
      );
    }
    document.body.append(flyout);
    const fw = flyout.offsetWidth;
    const fh = flyout.offsetHeight;
    flyout.style.left = `${Math.min(window.innerWidth - fw - 4, r.right + 4)}px`;
    flyout.style.top = `${Math.min(window.innerHeight - fh - 4, r.top)}px`;
    document.addEventListener('pointerdown', outside, true);
    if (focusFirst) flyout.querySelector('.flyout-item')?.focus();
  };

  const buildTools = () => {
    let gi = 0;
    for (const sectionDef of TOOL_LAYOUT) {
      const groups = sectionDef.groups.map((g) => g.filter(registered)).filter((g) => g.length);
      if (!groups.length) continue;
      const sectionEl = h('div.tool-section', { role: 'group', 'aria-label': sectionDef.label }, h('div.tool-section-label', { 'aria-hidden': 'true' }, sectionDef.label));
      for (const ids of groups) {
        const index = gi++;
        current.set(index, ids[0]);
        const cls = app.toolClasses.get(ids[0]);
        const btn = h('button.tool-btn', {
          type: 'button',
          'aria-label': cls.label,
          'aria-pressed': 'false',
          'data-tip': tipFor(cls),
          tabindex: groupButtons.length === 0 ? '0' : '-1',
          'aria-haspopup': ids.length > 1 ? 'menu' : null,
        });
        btn.append(icon(cls.icon, 20));
        if (ids.length > 1) btn.append(h('span.tool-corner', { 'aria-hidden': 'true' }));
        btn._ids = ids;
        btn._index = index;
        let pressTimer = 0;
        let longPressed = false;
        btn.addEventListener('pointerdown', (e) => {
          longPressed = false;
          if (ids.length < 2 || e.button !== 0) return;
          pressTimer = setTimeout(() => {
            longPressed = true;
            openFlyout(btn, ids, false);
          }, 350);
        });
        btn.addEventListener('pointerup', () => clearTimeout(pressTimer));
        btn.addEventListener('pointerleave', () => clearTimeout(pressTimer));
        btn.addEventListener('click', (e) => {
          if (longPressed) return;
          if (e.altKey && ids.length > 1) {
            // Alt-click cycles through the group.
            const cur = current.get(index);
            const next = ids[(ids.indexOf(cur) + 1) % ids.length];
            app.setTool(next);
            return;
          }
          app.setTool(current.get(index));
        });
        btn.addEventListener('dblclick', () => app.tool?.openOptions?.());
        btn.addEventListener('contextmenu', (e) => {
          if (ids.length < 2) return;
          e.preventDefault();
          openFlyout(btn, ids);
        });
        btn.addEventListener('keydown', (e) => {
          const all = groupButtons;
          const i = all.indexOf(btn);
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const next = all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length];
            all.forEach((b) => (b.tabIndex = -1));
            next.tabIndex = 0;
            next.focus();
          } else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            const next = e.key === 'Home' ? all[0] : all[all.length - 1];
            all.forEach((b) => (b.tabIndex = -1));
            next.tabIndex = 0;
            next.focus();
          } else if (e.key === 'ArrowRight' && ids.length > 1) {
            e.preventDefault();
            openFlyout(btn, ids);
          }
        });
        groupButtons.push(btn);
        sectionEl.append(btn);
      }
      list.append(sectionEl);
    }
  };
  buildTools();

  // ---- Fill / stroke control ----
  const fillSw = paintSwatch(null, { className: 'fill' });
  const strokeSw = paintSwatch(null, { className: 'stroke' });
  const fillBtn = h('button.fs-fill', { type: 'button', 'aria-label': 'Fill', 'data-tip': 'Fill (X toggles Fill and Stroke)', onclick: () => focusPaint('fill'), ondblclick: () => app.openColorPicker?.('fill') }, fillSw);
  const strokeBtn = h('button.fs-stroke', { type: 'button', 'aria-label': 'Stroke', 'data-tip': 'Stroke (X toggles Fill and Stroke)', onclick: () => focusPaint('stroke'), ondblclick: () => app.openColorPicker?.('stroke') }, strokeSw, h('span.fs-stroke-hole', { 'aria-hidden': 'true' }));
  const swapBtn = h('button.fs-mini.fs-swap', { type: 'button', 'aria-label': 'Swap Fill and Stroke', 'data-tip': `Swap Fill and Stroke (${formatShortcut('Shift+X')})`, onclick: () => swapFillStroke(app.editor) }, icon('swap-fill-stroke', 12));
  const defBtn = h('button.fs-mini.fs-default', { type: 'button', 'aria-label': 'Default Fill and Stroke', 'data-tip': 'Default Fill and Stroke (D)', onclick: () => defaultFillStroke(app.editor) }, icon('default-fill-stroke', 12));
  const fs = h('div.fill-stroke', { role: 'group', 'aria-label': 'Fill and stroke' }, fillBtn, strokeBtn, swapBtn, defBtn);
  const modeBtns = [
    ['color', 'paint-color', 'Color', ','],
    ['gradient', 'paint-gradient', 'Gradient', '.'],
    ['none', 'paint-none', 'None', '/'],
  ].map(([kind, ic, label, key]) => h('button.paint-mode', { type: 'button', 'aria-label': label, 'data-tip': `${label} (${key})`, onclick: () => setFocusedPaint(app.editor, kind) }, icon(ic, 14)));
  const modes = h('div.paint-modes', { role: 'group', 'aria-label': 'Paint type' }, modeBtns);

  const focusPaint = (which) => {
    if (!app.editor) return;
    app.editor.focusPaint = which;
    app.editor.emit('style');
  };

  const screenBtn = h('button.tool-btn.small', { type: 'button', 'aria-label': 'Change Screen Mode', 'data-tip': 'Change Screen Mode (F)', onclick: () => app.commands.run('window.screenMode') }, icon('screen-mode', 18));
  const moreBtn = h('button.tool-btn.small', { type: 'button', 'aria-label': 'All tools', 'data-tip': 'All tools', onclick: (e) => (app.openToolDrawer ? app.openToolDrawer(e.currentTarget) : openAllTools(e.currentTarget)) }, icon('ellipsis', 18));

  const openAllTools = (btn) => {
    const ids = [...app.toolClasses.keys()];
    openFlyout(btn, ids, true, true);
    flyout?.classList.add('all-tools');
  };

  // Single or double column, toggled from the header chevrons.
  const colsBtn = h('button.toolbar-cols', { type: 'button', 'aria-label': 'Toggle single or double column tools', 'data-tip': 'Single or double column' });
  const scroller = h('div.toolbar-scroll', list);
  const applyColumns = () => {
    const pref = app.prefs.get('toolbarColumns');
    let two = pref === 2;
    if (pref === 'auto' || pref == null) {
      el.classList.remove('two-col');
      two = scroller.scrollHeight > scroller.clientHeight + 2;
    }
    el.classList.toggle('two-col', two);
    app.root.classList.toggle('tools-two-col', two);
    colsBtn.replaceChildren(icon(two ? 'chevrons-left' : 'chevrons-right', 12));
    colsBtn.setAttribute('aria-pressed', String(two));
  };
  colsBtn.addEventListener('click', () => {
    const two = el.classList.contains('two-col');
    app.prefs.set('toolbarColumns', two ? 1 : 2);
    applyColumns();
  });
  new ResizeObserver(() => {
    if (app.prefs.get('toolbarColumns') === 'auto') applyColumns();
  }).observe(el);
  requestAnimationFrame(applyColumns);
  el.append(h('div.toolbar-head', colsBtn), scroller, h('div.toolbar-bottom', fs, modes, h('div.toolbar-misc', moreBtn, screenBtn)));

  const refreshTool = () => {
    for (const btn of groupButtons) {
      const active = btn._ids.includes(app.toolId);
      if (active && current.get(btn._index) !== app.toolId) {
        current.set(btn._index, app.toolId);
        const cls = app.toolClasses.get(app.toolId);
        btn.replaceChild(icon(cls.icon, 20), btn.querySelector('svg'));
        btn.setAttribute('aria-label', cls.label);
        btn.setAttribute('data-tip', tipFor(cls));
      }
      btn.setAttribute('aria-pressed', String(active));
      btn.classList.toggle('active', active);
    }
    for (const t of tearoffs) for (const b of t.btns) b.setAttribute('aria-pressed', String(b._id === app.toolId));
  };

  const refreshPaint = () => {
    const ed = app.editor;
    const has = Boolean(ed);
    fs.classList.toggle('disabled', !has);
    if (!ed) return;
    const fill = commonStyle(ed, 'fill');
    const stroke = commonStyle(ed, 'stroke');
    updatePaintSwatch(fillSw, fill === 'mixed' ? null : fill, fill === 'mixed');
    updatePaintSwatch(strokeSw, stroke === 'mixed' ? null : stroke, stroke === 'mixed');
    fs.classList.toggle('stroke-front', ed.focusPaint === 'stroke');
    fillBtn.setAttribute('aria-pressed', String(ed.focusPaint === 'fill'));
    strokeBtn.setAttribute('aria-pressed', String(ed.focusPaint === 'stroke'));
  };

  /** Rebuild the tool buttons (after the toolbar set changes). */
  const rebuild = () => {
    closeFlyout();
    groupButtons.length = 0;
    current.clear();
    list.replaceChildren();
    buildTools();
    refreshTool();
    requestAnimationFrame(applyColumns);
  };

  /** Rewrite tool tooltips (after the user changes tool shortcuts). */
  const refreshTips = () => {
    for (const btn of groupButtons) {
      const cls = app.toolClasses.get(current.get(btn._index));
      if (cls) btn.setAttribute('data-tip', tipFor(cls));
    }
  };

  return { el, refreshTool, refreshPaint, refreshTips, closeFlyout, rebuild, list, tearOff };
}

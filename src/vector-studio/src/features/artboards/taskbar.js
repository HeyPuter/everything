/**
 * Task bar: a floating toolbar under the selection (or at the
 * bottom center of the canvas with nothing selected) with quick actions for
 * what is selected. It hides while dragging, panning or editing type,
 * follows view changes, can be moved by its grip (and then stays put until
 * reset), and is turned on and off with Window > Task Bar.
 * It is an ARIA toolbar: Alt+F10 (or Tab from the panels side) focuses it,
 * arrow keys move between its controls and Escape returns to the canvas.
 * (Tab on the canvas itself keeps its native meaning: hide panels.)
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../ui/icons.js';
import { paintSwatch, updatePaintSwatch, numberField } from '../../ui/widgets.js';
import { openPaintPopover } from '../../ui/popover.js';
import { commonStyle } from '../../ops/paint-ops.js';
import { openMenu, resolveItems } from '../../ui/menubar.js';

const ALIGN_MENU = ['align.left', 'align.hcenter', 'align.right', '-', 'align.top', 'align.vcenter', 'align.bottom', '-', 'distribute.hcenter', 'distribute.vcenter', 'distribute.hspace', 'distribute.vspace'];

/** Release command per live group kind (repeats, traced images, envelopes, ...). */
const LIVE_RELEASE = { repeat: 'repeat.release', trace: 'trace.release', envelope: 'envelope.release', paintRegions: 'paintRegions.release', interlace: 'interlace.release', onPath: 'objectsOnPath.release', graph: 'graph.release' };

/** Which quick-action set applies: 'none' | 'path' | 'shape' | 'multiple' | 'group' | 'clip' | 'live' | 'text' | 'blend' | 'image' | 'symbol' | 'other'. */
export function taskbarContext(editor) {
  if (!editor || !editor.selection.size) return 'none';
  const top = editor.topSelection();
  const nodes = top.map((id) => editor.doc.get(id)).filter(Boolean);
  if (nodes.length > 1) return 'multiple';
  const n = nodes[0];
  if (!n) return 'none';
  if (n.type === 'group' && n.blend) return 'blend';
  if (n.type === 'group' && n.live) return 'live';
  if (n.type === 'group' && n.clip) return 'clip';
  if (n.type === 'group') return 'group';
  if (n.type === 'text') return 'text';
  if (n.type === 'path' && n.shape) return 'shape';
  if (n.type === 'path' || n.type === 'compound') return 'path';
  if (n.type === 'image') return 'image';
  if (n.type === 'instance') return 'symbol';
  return 'other';
}

export function installTaskbar(app) {
  const bar = app.taskbar;
  if (!bar) return;
  bar.classList.add('ctx-taskbar');
  let contextKey = null;
  let swatches = null;
  let fontField = null;
  let suppressed = false;
  let settleTimer = 0;

  const enabled = () => app.prefs.get('contextualTaskbar') !== false;
  const pinned = () => app.prefs.get('taskbarPos');

  const button = (label, ic, onclick, { text = true, menu = false } = {}) => {
    const b = h('button.btn.tb-btn', { type: 'button', tabindex: '-1', 'aria-label': text ? null : label, 'data-tip': text ? null : label, 'aria-haspopup': menu ? 'menu' : null, onclick }, ic ? icon(ic, 16) : null, text ? h('span', label) : null);
    return b;
  };
  const cmdButton = (cmd, label, ic, opts) => {
    if (!app.commands.get(cmd)) return null;
    const b = button(label || app.commands.label(cmd), ic, () => app.commands.run(cmd), opts);
    b.dataset.cmd = cmd;
    return b;
  };
  const menuButton = (label, ic, spec, opts = {}) => button(label, ic, (e) => app.showMenuAt(e.currentTarget, spec, label), { ...opts, menu: true });

  const grip = h('button.tb-grip', { type: 'button', tabindex: '-1', 'aria-label': 'Move task bar', 'data-tip': 'Drag to move the task bar' }, icon('grip', 14));
  grip.addEventListener('pointerdown', (e) => startMove(e));
  grip.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 20 : 4;
    const d = { ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d || !e.altKey) return;
    // Alt+Up/Down nudges the bar (Left/Right move focus within the toolbar).
    e.preventDefault();
    e.stopPropagation();
    const cur = pinned() || { x: bar.offsetLeft, y: bar.offsetTop };
    app.prefs.set('taskbarPos', { x: cur.x + d[0], y: cur.y + d[1] });
    position();
  });

  const moreMenu = () => {
    const ctx = taskbarContext(app.editor);
    const items = [];
    const cmd = (id) => {
      if (app.commands.get(id)) items.push(id);
    };
    if (ctx !== 'none') {
      ['edit.copy', 'edit.cut', 'edit.duplicate', '-', 'object.bringToFront', 'object.sendToBack', '-', 'object.hide', 'object.lock', '-', 'object.transform.move', 'object.flipH', 'object.flipV'].forEach((id) => (id === '-' ? items.push('-') : cmd(id)));
    } else ['edit.paste', 'object.unlockAll', 'object.showAll'].forEach(cmd);
    return [
      ...items,
      '-',
      { label: 'Show Properties Panel', run: () => app.openPanel('properties') },
      { label: 'Hide Bar', run: () => app.commands.run('window.contextualTaskbar') },
      { label: 'Pin Bar Position', checked: Boolean(pinned()), run: () => app.prefs.set('taskbarPos', pinned() ? null : { x: bar.offsetLeft, y: bar.offsetTop }) },
      { label: 'Reset Bar Position', enabled: Boolean(pinned()), run: () => (app.prefs.set('taskbarPos', null), position()) },
    ];
  };
  const more = button('More options', 'ellipsis', (e) => openMore(e.currentTarget), { text: false, menu: true });
  const openMore = (anchor) => {
    const r = anchor.getBoundingClientRect();
    openMenu(app, resolveItems(app, moreMenu()), { x: r.left, y: r.bottom + 4, anchor, label: 'Task bar options' });
  };

  const fillSwatchBtn = () => {
    const sw = paintSwatch(null);
    const b = h('button.tb-swatch', { type: 'button', tabindex: '-1', 'aria-label': 'Fill', 'data-tip': 'Fill', 'aria-haspopup': 'dialog', onclick: (e) => openPaintPopover(app, e.currentTarget, 'fill') }, sw);
    return { b, sw };
  };
  const strokeSwatchBtn = () => {
    const sw = paintSwatch(null, { className: 'stroke-swatch' });
    const b = h('button.tb-swatch', { type: 'button', tabindex: '-1', 'aria-label': 'Stroke', 'data-tip': 'Stroke', 'aria-haspopup': 'dialog', onclick: (e) => openPaintPopover(app, e.currentTarget, 'stroke') }, sw);
    return { b, sw };
  };

  const shapesMenu = ['rectangle', 'ellipse', 'polygon', 'star', 'line'].filter((id) => app.toolClasses.has(id));

  function buildContent(ctx) {
    swatches = null;
    fontField = null;
    const items = [];
    if (ctx === 'none') {
      if (app.toolClasses.has('pencil')) items.push(button('Draw with Pencil', 'pencil', () => app.setTool('pencil')));
      if (shapesMenu.length) {
        items.push(
          button('Shapes', 'shapes', (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const items = resolveItems(app, shapesMenu.map((id) => ({ label: app.toolClasses.get(id).label.replace(' Tool', ''), run: () => app.setTool(id) })));
            openMenu(app, items, { x: r.left, y: r.bottom + 4, anchor: e.currentTarget, label: 'Shapes' });
          }, { menu: true }),
        );
      }
      items.push(cmdButton('file.place', 'Place Image', 'image-plus', { text: false }));
      items.push(cmdButton('select.all', 'Select All', 'square-mouse-pointer'));
    } else {
      const fill = fillSwatchBtn();
      const stroke = strokeSwatchBtn();
      swatches = { fill: fill.sw, stroke: stroke.sw };
      if (ctx === 'path') {
        items.push(button('Edit Path', 'pen-line', () => app.setTool('direct-selection')));
        items.push(cmdButton('path.offset', 'Offset Path', null));
        items.push(fill.b, stroke.b, cmdButton('object.lock', 'Lock', 'lock', { text: false }));
      } else if (ctx === 'shape') {
        // Live shapes: their params in the Properties panel, or plain paths.
        items.push(button('Edit Path', 'pen-line', () => app.setTool('direct-selection')));
        items.push(button('Shape Properties', 'sliders-horizontal', () => app.openPanel('properties'), { text: false }));
        items.push(cmdButton('shape.expand', 'Expand Shape', null));
        items.push(fill.b, stroke.b, cmdButton('object.lock', 'Lock', 'lock', { text: false }));
      } else if (ctx === 'clip') {
        items.push(cmdButton('object.clipRelease', 'Release Mask', null), cmdButton('object.isolate', 'Edit Contents', 'isolation'), cmdButton('object.lock', 'Lock', 'lock', { text: false }));
      } else if (ctx === 'image') {
        items.push(cmdButton('trace.make', 'Trace Image', 'wand'), cmdButton('object.cropImage', 'Crop Image', 'crop'), cmdButton('image.embed', 'Embed', null), cmdButton('object.lock', 'Lock', 'lock', { text: false }));
      } else if (ctx === 'symbol') {
        items.push(cmdButton('symbol.edit', 'Edit Symbol', 'component'), cmdButton('symbol.breakLink', 'Break Link', 'unlink'), cmdButton('symbol.reset', 'Reset', null), fill.b, stroke.b, cmdButton('object.lock', 'Lock', 'lock', { text: false }));
      } else if (ctx === 'multiple') {
        items.push(cmdButton('object.group', 'Group', 'group'));
        items.push(menuButton('Align', 'align-hcenter', ALIGN_MENU));
        items.push(cmdButton('pathfinder.unite', 'Unite', 'squares-unite'));
        items.push(cmdButton('blend.make', 'Blend', 'blend', { text: false }));
        items.push(fill.b, stroke.b);
      } else if (ctx === 'group') {
        items.push(cmdButton('object.ungroup', 'Ungroup', 'ungroup'), cmdButton('object.isolate', 'Isolate', 'isolation'), fill.b, stroke.b, cmdButton('object.lock', 'Lock', 'lock', { text: false }));
      } else if (ctx === 'live') {
        // Live groups (repeats, traced images, envelopes, ...) expand or release instead of ungrouping.
        const kind = app.editor.doc.get(app.editor.topSelection()[0])?.live?.kind;
        if (kind === 'envelope') items.push(cmdButton('envelope.editContents', null, null));
        items.push(cmdButton('object.expand', 'Expand', null), cmdButton(LIVE_RELEASE[kind], 'Release', null), fill.b, stroke.b, cmdButton('object.lock', 'Lock', 'lock', { text: false }));
      } else if (ctx === 'blend') {
        items.push(cmdButton('blend.options', 'Blend Options', 'blend'), cmdButton('blend.expand', 'Expand', null), cmdButton('blend.release', 'Release', null));
      } else if (ctx === 'text') {
        items.push(cmdButton('type.createOutlines', 'Create Outlines', 'type'));
        fontField = numberField({
          label: 'Font size',
          icon: 'case-sensitive',
          value: 12,
          min: 0.1,
          max: 1296,
          width: '64px',
          onCommit: (v) => {
            const ed = app.editor;
            const texts = ed.selectedNodes().filter((n) => n.type === 'text');
            ed.doc.transact('Font Size', () => texts.forEach((t) => ed.doc.update(t.id, { char: { ...t.char, fontSize: v } })));
          },
        });
        fontField.input.tabIndex = -1;
        items.push(fontField.el, fill.b, cmdButton('object.lock', 'Lock', 'lock', { text: false }));
      } else {
        items.push(cmdButton('object.lock', 'Lock', 'lock'), cmdButton('object.transform.move', 'Move', 'move'));
      }
    }
    // Feature modules add quick actions: app.taskbarExtras.push((ctx, { button, cmdButton, menuButton }) => [elements]).
    for (const extra of app.taskbarExtras || []) items.push(...[].concat(extra(ctx, { button, cmdButton, menuButton }) || []));
    items.push(more);
    bar.replaceChildren(grip, ...items.filter(Boolean));
    const focusables = controls();
    focusables.forEach((c, i) => (c.tabIndex = i === 1 ? 0 : -1));
  }

  const controls = () => [...bar.querySelectorAll('button, input')].filter((c) => !c.disabled);

  bar.addEventListener('keydown', (e) => {
    const list = controls();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      app.canvasHost.focus();
      return;
    }
    if (i < 0 || e.target.tagName === 'INPUT') return;
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % list.length;
    if (e.key === 'ArrowLeft') j = (i - 1 + list.length) % list.length;
    if (e.key === 'Home') j = 0;
    if (e.key === 'End') j = list.length - 1;
    if (j < 0) return;
    e.preventDefault();
    e.stopPropagation();
    list.forEach((c) => (c.tabIndex = -1));
    list[j].tabIndex = 0;
    list[j].focus();
  });

  function refreshValues() {
    const ed = app.editor;
    if (!ed) return;
    if (swatches) {
      const fill = commonStyle(ed, 'fill');
      const stroke = commonStyle(ed, 'stroke');
      updatePaintSwatch(swatches.fill, fill === 'mixed' ? null : fill, fill === 'mixed');
      updatePaintSwatch(swatches.stroke, stroke === 'mixed' ? null : stroke, stroke === 'mixed');
    }
    if (fontField) {
      const sizes = new Set(ed.selectedNodes().filter((n) => n.type === 'text').map((n) => n.char.fontSize));
      fontField.set(sizes.size === 1 ? [...sizes][0] : 'mixed');
    }
    for (const b of bar.querySelectorAll('[data-cmd]')) b.disabled = !app.commands.isEnabled(b.dataset.cmd);
  }

  function shouldShow() {
    const ed = app.editor;
    if (!enabled() || !ed || suppressed) return false;
    if (ed.textEdit || app.input?.active || app.input?.pan || app.input?.gesture) return false;
    if (app.toolId === 'artboard' || app.root.classList.contains('hide-panels')) return false;
    return !app.home || app.home.hidden;
  }

  function position() {
    const ed = app.editor;
    const stack = bar.parentElement;
    if (!ed || !stack) return;
    const sw = stack.clientWidth;
    let sh = stack.clientHeight;
    // On phones the panel dock is a bottom sheet over the canvas: stay above it.
    const st0 = stack.getBoundingClientRect();
    const dockRect = app.dock?.el?.getBoundingClientRect();
    if (dockRect && dockRect.height && dockRect.top > st0.top && dockRect.top < st0.bottom && dockRect.left < st0.right - 40 && dockRect.right > st0.left + 40) sh = Math.min(sh, dockRect.top - st0.top);
    const bw = bar.offsetWidth;
    const bh = bar.offsetHeight;
    const pin = pinned();
    let x;
    let y;
    if (pin) {
      x = pin.x;
      y = pin.y;
    } else {
      const host = app.canvasHost.getBoundingClientRect();
      const st = stack.getBoundingClientRect();
      const offX = host.left - st.left;
      const offY = host.top - st.top;
      const b = ed.selection.size ? ed.selectionBounds() : null;
      if (b) {
        const pts = [ed.view.toScreen(b.x, b.y), ed.view.toScreen(b.x + b.w, b.y), ed.view.toScreen(b.x, b.y + b.h), ed.view.toScreen(b.x + b.w, b.y + b.h)];
        const minX = Math.min(...pts.map((p) => p.x));
        const maxX = Math.max(...pts.map((p) => p.x));
        const minY = Math.min(...pts.map((p) => p.y));
        const maxY = Math.max(...pts.map((p) => p.y));
        x = offX + (minX + maxX) / 2 - bw / 2;
        y = offY + maxY + 18;
        // Not enough room below: go above the selection.
        if (y + bh > sh - 8) y = offY + minY - bh - 18;
      } else {
        x = sw / 2 - bw / 2;
        y = sh - bh - 28;
      }
    }
    x = Math.max(8, Math.min(sw - bw - 8, x));
    y = Math.max(8, Math.min(sh - bh - 8, y));
    bar.style.left = `${Math.round(x)}px`;
    bar.style.top = `${Math.round(y)}px`;
  }

  function refresh() {
    const show = shouldShow();
    if (!show) {
      // Keep focus inside if the user is working in the bar.
      if (!bar.contains(document.activeElement)) bar.hidden = true;
      return;
    }
    const ctx = taskbarContext(app.editor);
    const top = ctx === 'live' || ctx === 'other' ? app.editor.doc.get(app.editor.topSelection()[0]) : null;
    const liveKind = ctx === 'live' ? top?.live?.kind : ctx === 'other' ? top?.type : '';
    const key = `${ctx}:${liveKind}:${Boolean(app.commands.get('pathfinder.unite'))}:${Boolean(app.commands.get('type.createOutlines'))}`;
    if (key !== contextKey) {
      const hadFocus = bar.contains(document.activeElement);
      contextKey = key;
      buildContent(ctx);
      if (hadFocus) controls()[1]?.focus();
    }
    refreshValues();
    bar.hidden = false;
    position();
  }

  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      refresh();
    });
  };

  // Hide during view changes (panning, zooming) and come back when they settle.
  const onView = () => {
    if (pinned()) return;
    if (!bar.hidden && !bar.contains(document.activeElement)) bar.hidden = true;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(schedule, 180);
  };

  function startMove(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const left = bar.offsetLeft;
    const top = bar.offsetTop;
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already-released pointers cannot be captured.
    }
    const move = (ev) => {
      app.prefs.values.taskbarPos = { x: left + ev.clientX - x0, y: top + ev.clientY - y0 };
      position();
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      if (app.prefs.values.taskbarPos) app.prefs.set('taskbarPos', { ...app.prefs.values.taskbarPos });
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  }

  app.canvasHost.addEventListener('pointerdown', () => {
    suppressed = true;
    if (!bar.contains(document.activeElement)) bar.hidden = true;
  }, true);
  window.addEventListener('pointerup', () => {
    if (!suppressed) return;
    suppressed = false;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(schedule, 60);
  });
  app.canvasHost.addEventListener('wheel', onView, { passive: true });

  let unsubs = [];
  const attach = () => {
    for (const u of unsubs) u();
    unsubs = [];
    const ed = app.editor;
    if (ed) {
      unsubs.push(ed.on('selection', schedule), ed.on('doc-change', (e) => e.commit && schedule()), ed.on('view', onView), ed.on('style', schedule));
    }
    schedule();
  };
  app.on('active-editor', attach);
  app.on('tool', schedule);
  app.on('chrome', schedule);
  app.prefs.on('change', ({ key }) => (key === 'contextualTaskbar' || key === 'taskbarPos') && schedule());
  window.addEventListener('resize', schedule);
  attach();

  app.commands.register({
    id: 'window.contextualTaskbar',
    label: 'Task Bar',
    checked: (a) => a.prefs.get('contextualTaskbar') !== false,
    run: (a) => {
      a.prefs.set('contextualTaskbar', a.prefs.get('contextualTaskbar') === false);
      schedule();
    },
  });

  app.commands.register({
    id: 'window.focusTaskbar',
    label: 'Focus Task Bar',
    shortcut: 'Alt+F10',
    enabled: (a) => Boolean(a.editor) && a.prefs.get('contextualTaskbar') !== false,
    run: () => {
      refresh();
      if (bar.hidden) return;
      const list = controls();
      (list.find((c) => c.tabIndex === 0) || list[1] || list[0])?.focus();
    },
  });

  return { refresh: schedule, position };
}

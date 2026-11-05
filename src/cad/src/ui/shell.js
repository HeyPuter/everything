/**
 * Application chrome: title bar with the application menu and quick access
 * tools, ribbon, drawing tabs, the canvas workspace with its docked
 * palettes and navigation bar, the command line, the status bar, and the
 * compact toolbar used on phones.
 */
import { h, clear, MOD } from './dom.js';
import { icon } from './icons.js';
import { showMenu } from './menu.js';
import { commandTip } from './ribbon.js';

export const REPO_URL = 'https://github.com/heyputer/everything';

export function buildShell(app) {
  const qat = (cmd, ic, label, keys) => {
    const d = app.commands.get(cmd);
    return h('button.icon-btn.qat-btn', { type: 'button', 'aria-label': label, ...commandTip(d, label), 'data-tip-keys': keys || null, onClick: () => app.run(cmd) }, icon(ic, 17));
  };
  const undoBtn = qat('U', 'undo', 'Undo', `${MOD}+Z`);
  const redoBtn = qat('REDO', 'redo', 'Redo', `${MOD}+Y`);
  const appBtn = h(
    'button.app-btn',
    { type: 'button', 'aria-label': 'Application menu', 'aria-haspopup': 'menu', 'data-tip': 'Application menu', onClick: (e) => app.appMenu(e.currentTarget) },
    h('span.app-logo', icon('logo', 18)),
    icon('chevron-down', 12),
  );
  const title = h('div.title');
  const search = h(
    'button.search-btn',
    { type: 'button', 'aria-label': 'Search commands', 'aria-haspopup': 'dialog', 'data-tip': 'Search commands', 'data-tip-keys': `${MOD}+K`, onClick: () => app.commandPalette() },
    icon('search', 15),
    h('span.search-text', 'Search commands'),
    h('kbd', `${MOD} K`),
  );
  const account = h('div.account');
  const themeBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Theme', 'aria-haspopup': 'menu', 'data-tip': 'Theme', onClick: (e) => app.themeMenu(e.currentTarget) }, icon('monitor', 17));
  const github = h(
    'a.icon-btn.github-link',
    { href: REPO_URL, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Source code on GitHub (opens in a new tab)', 'data-tip': 'Source code on GitHub' },
    icon('github', 17),
  );
  const helpBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Help', 'data-tip': 'Help', 'data-tip-keys': 'F1', onClick: () => app.help() }, icon('help', 17));
  const moreBtn = h('button.icon-btn.only-phone', { type: 'button', 'aria-label': 'More', 'aria-haspopup': 'menu', onClick: (e) => app.appMenu(e.currentTarget) }, icon('more', 18));

  const titlebar = h(
    'header.titlebar',
    h(
      'div.tb-left',
      appBtn,
      h(
        'div.qat',
        { role: 'toolbar', 'aria-label': 'Quick access' },
        h('span.qat-files.hide-phone', qat('NEW', 'file-plus', 'New drawing', `${MOD}+N`), qat('OPEN', 'folder-open', 'Open', `${MOD}+O`), qat('SAVE', 'save', 'Save', `${MOD}+S`)),
        h('span.qat-sep.hide-phone'),
        undoBtn,
        redoBtn,
        h('span.qat-sep.hide-phone'),
        h('span.hide-phone', qat('PLOT', 'printer', 'Plot', `${MOD}+P`)),
      ),
    ),
    title,
    h('div.tb-right', search, themeBtn, helpBtn, github, account, moreBtn),
  );

  const doctabs = h('div.doctabs', { role: 'tablist', 'aria-label': 'Open drawings' });
  // A vertical wheel scrolls the tabs sideways when they overflow (they have no scrollbar).
  doctabs.addEventListener(
    'wheel',
    (e) => {
      if (doctabs.scrollWidth <= doctabs.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      doctabs.scrollLeft += e.deltaY;
      e.preventDefault();
    },
    { passive: false },
  );
  const newTab = h('button.icon-btn.doctab-new', { type: 'button', 'aria-label': 'New drawing', 'data-tip': 'New drawing', onClick: () => app.run('NEW') }, icon('plus', 16));
  const docbar = h('div.docbar', doctabs, newTab);

  // Canvas
  const glCanvas = h('canvas.gl-canvas', { 'aria-hidden': 'true' });
  const overlay = h('canvas.overlay-canvas', {
    tabindex: '0',
    role: 'application',
    'aria-label': 'Drawing area. Type a command or use the ribbon. Press F1 for help.',
    'aria-describedby': 'canvas-help',
  });
  const canvasHelp = h(
    'p.sr-only#canvas-help',
    'Use the mouse or touch to pick points and select objects. Type commands such as LINE or CIRCLE and press Enter. Coordinates can be typed as x,y or @distance<angle.',
  );
  const nav = h(
    'div.viewnav',
    { role: 'toolbar', 'aria-label': 'Navigation', 'aria-orientation': 'vertical' },
    navBtn(app, 'pan', 'Pan', () => app.run('PAN')),
    navBtn(app, 'zoom-extents', 'Zoom extents', () => app.editor.zoomExtents()),
    navBtn(app, 'zoom-window', 'Zoom window', () => app.run('ZOOM', { mode: 'window' })),
    navBtn(app, 'zoom-in', 'Zoom in', () => app.editor.zoomBy(1.6)),
    navBtn(app, 'zoom-out', 'Zoom out', () => app.editor.zoomBy(1 / 1.6)),
  );
  const emptyState = h('div.empty-state', { hidden: true });
  const canvasWrap = h('div.canvas-wrap', glCanvas, overlay, canvasHelp, nav, emptyState);

  // Dock with palettes
  const dockTabs = h('div.dock-tabs', { role: 'tablist', 'aria-label': 'Palettes' });
  const dockBody = h('div.dock-body');
  const dockClose = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Close palette', 'data-tip': 'Close palette', onClick: () => app.closeDock() }, icon('x', 16));
  const dockResize = h('div.dock-resize', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize palette', tabindex: '0' });
  const dock = h('aside.dock', { hidden: true, 'aria-label': 'Palettes' }, dockResize, h('div.dock-head', dockTabs, dockClose), dockBody);
  const workspace = h('div.workspace', canvasWrap, dock);

  // Phone toolbar
  const phonebar = h('nav.phonebar', { 'aria-label': 'Tools' });

  const root = h('div.app-root', titlebar, h('div.ribbon-slot'), docbar, workspace, h('div.status-slot'), phonebar);
  return { root, titlebar, title, account, themeBtn, undoBtn, redoBtn, doctabs, glCanvas, overlay, canvasWrap, nav, emptyState, dock, dockTabs, dockBody, dockResize, workspace, phonebar, github };
}

function navBtn(app, ic, label, fn) {
  return h('button.icon-btn.nav-btn', { type: 'button', 'aria-label': label, 'data-tip': label, onClick: fn }, icon(ic, 17));
}

/** Render drawing tabs. */
export function renderDocTabs(app, el) {
  clear(el);
  app.docs.forEach((doc, i) => {
    const active = doc === app.doc;
    const tab = h(
      `div.doctab${active ? '.active' : ''}`,
      { role: 'presentation' },
      h(
        'button.doctab-btn',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': String(active),
          tabindex: active ? '0' : '-1',
          title: doc.file?.path || doc.name,
          onClick: () => app.activate(doc),
          onAuxclick: (e) => {
            if (e.button === 1) app.closeDrawing(doc);
          },
          onKeydown: (e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              const j = (i + (e.key === 'ArrowRight' ? 1 : -1) + app.docs.length) % app.docs.length;
              app.activate(app.docs[j]);
              requestAnimationFrame(() => el.querySelector('.doctab.active .doctab-btn')?.focus());
            } else if (e.key === 'Delete') {
              // Keep the key from also erasing objects in the drawing.
              e.preventDefault();
              e.stopPropagation();
              app.closeDrawing(doc);
            }
          },
          onContextmenu: (e) => {
            e.preventDefault();
            showMenu({ x: e.clientX, y: e.clientY }, [
              { label: 'Save', icon: 'save', action: () => app.save(doc) },
              { label: 'Save as...', icon: 'save-all', action: () => app.saveAs(doc) },
              { separator: true },
              { label: 'Close', icon: 'x', action: () => app.closeDrawing(doc) },
              { label: 'Close all others', action: () => app.closeOthers(doc) },
            ]);
          },
        },
        h('span.doctab-name', doc.name),
        doc.drawing.modified ? [h('span.doctab-dot', { 'aria-hidden': 'true' }), h('span.sr-only', ', unsaved changes')] : null,
      ),
      // Mouse shortcut only: keyboard users close a tab with Delete or its context menu.
      h('button.icon-btn.sm.doctab-close', { type: 'button', tabindex: '-1', 'aria-hidden': 'true', title: `Close ${doc.name}`, onClick: () => app.closeDrawing(doc) }, icon('x', 14)),
    );
    el.append(tab);
  });
  // Keep the active tab in view, as when a new drawing is added past the right edge.
  const a = el.querySelector('.doctab.active')?.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  if (a && a.left < b.left) el.scrollLeft -= b.left - a.left;
  else if (a && a.right > b.right) el.scrollLeft += a.right - b.right;
}

/** Tool groups for the phone toolbar. */
export const PHONE_GROUPS = [
  { id: 'draw', label: 'Draw', icon: 'line', cmds: ['LINE', 'PLINE', 'CIRCLE', 'ARC', 'RECTANG', 'POLYGON', 'ELLIPSE', 'SPLINE', 'HATCH', 'POINT', 'XLINE', 'REVCLOUD'] },
  { id: 'modify', label: 'Modify', icon: 'move', cmds: ['MOVE', 'COPY', 'ROTATE', 'SCALE', 'MIRROR', 'OFFSET', 'TRIM', 'EXTEND', 'FILLET', 'CHAMFER', 'ARRAYRECT', 'ARRAYPOLAR', 'STRETCH', 'ERASE', 'EXPLODE', 'JOIN', 'BREAK', 'MATCHPROP'] },
  { id: 'annotate', label: 'Annotate', icon: 'dim-linear', cmds: ['MTEXT', 'TEXT', 'DIMLINEAR', 'DIMALIGNED', 'DIMANGULAR', 'DIMRADIUS', 'DIMDIAMETER', 'LEADER', 'DIMCONTINUE', 'DIMBASELINE'] },
  { id: 'layers', label: 'Layers', icon: 'layer-props', action: 'LAYER' },
  { id: 'props', label: 'Properties', icon: 'sliders', action: 'PROPERTIES' },
];

/**
 * Editor title bar: app menu, autosave status, project name, and the
 * account and Export buttons.
 */
import { h } from '../lib/dom.js';
import { shortcutLabel } from '../lib/platform.js';
import { icon, appIcon } from '../lib/icons.js';
import { menuButton } from './menu.js';
import { getTheme, setTheme, prefs } from './prefs.js';
import { promptDialog } from './dialog.js';

export function themeMenuItems() {
  const t = getTheme();
  return [
    { label: 'System', icon: 'monitor', checked: t === 'system', radio: true, onSelect: () => setTheme('system') },
    { label: 'Light', icon: 'sun', checked: t === 'light', radio: true, onSelect: () => setTheme('light') },
    { label: 'Dark', icon: 'moon', checked: t === 'dark', radio: true, onSelect: () => setTheme('dark') },
  ];
}

/** Panel arrangements offered by the layout menu (sizes in px, upper share of the height 0..1). */
export const LAYOUTS = [
  { id: 'default', label: 'Balanced', icon: 'layout', leftW: 440, rightW: 360, upperH: 0.56 },
  { id: 'media', label: 'Large media panel', icon: 'panelLeft', leftW: 600, rightW: 300, upperH: 0.6 },
  { id: 'details', label: 'Large details panel', icon: 'panelRight', leftW: 300, rightW: 520, upperH: 0.58 },
  { id: 'timeline', label: 'Large timeline', icon: 'panelBottom', leftW: 340, rightW: 320, upperH: 0.42 },
  { id: 'vertical', label: 'Vertical video', icon: 'rect', leftW: 420, rightW: 400, upperH: 0.68 },
];

/** Avatar button with the user's Puter profile picture when available. */
export function accountButton({ user, picture, env, onSignOut, onSignIn, extraItems = [] }) {
  const img = picture ? h('img.avatar-img', { src: picture, alt: '' }) : null;
  const initial = user?.username ? user.username[0].toUpperCase() : null;
  const btn = h('button.avatar-btn', { type: 'button', 'aria-label': user ? `Account: ${user.username}` : 'Account', 'data-tip': user ? user.username : 'Account' }, img || (initial ? h('span.avatar-initial', initial) : icon('user', 16)));
  menuButton(btn, () => [
    user ? { heading: user.username } : { heading: 'Not signed in' },
    ...extraItems,
    { label: 'Theme', icon: 'sun', submenu: themeMenuItems },
    // Inside the Puter desktop the session belongs to Puter, so there is no sign out here.
    user && env !== 'app' && onSignOut ? 'separator' : null,
    user && env !== 'app' && onSignOut ? { label: 'Sign out', icon: 'logout', onSelect: onSignOut } : null,
    !user && onSignIn ? 'separator' : null,
    !user && onSignIn ? { label: 'Sign in to save to Puter', icon: 'cloud', onSelect: onSignIn } : null,
  ].filter(Boolean), { align: 'end', label: 'Account' });
  return btn;
}

export function createTopbar(ctx) {
  const { store, commands } = ctx;
  const status = h('span.save-status', { role: 'status', 'aria-live': 'polite' });
  const nameBtn = h('button.project-name', { type: 'button', 'data-tip': 'Rename project' });
  const renderName = () => {
    nameBtn.textContent = store.project.name;
    nameBtn.setAttribute('aria-label', `Project name: ${store.project.name}. Rename`);
  };
  nameBtn.addEventListener('click', async () => {
    const name = await promptDialog({ title: 'Rename project', label: 'Project name', value: store.project.name, confirm: 'Rename' });
    if (name) ctx.actions.renameProject(name);
  });
  renderName();
  store.on('change', renderName);

  const cmd = (id, extra = {}) => {
    const c = commands.get(id);
    return { label: c.label, shortcut: c.keys[0], disabled: c.enabled ? !c.enabled() : false, onSelect: () => commands.run(id), ...extra };
  };
  const menuBtn = h('button.app-menu-btn', { type: 'button', 'aria-label': 'Main menu' }, appIcon(22), h('span.app-menu-label', 'Menu'), icon('chevronDown', 14));
  menuButton(menuBtn, () => [
    { label: 'Back to projects', icon: 'home', onSelect: () => ctx.exitToHome() },
    { label: 'New project', icon: 'plus', onSelect: () => ctx.newProject() },
    'separator',
    cmd('import', { icon: 'import', label: 'Import media...' }),
    cmd('scriptToVideo', { icon: 'script', label: 'Script to video...' }),
    cmd('findHighlights', { icon: 'highlights', label: 'Find highlights...' }),
    cmd('assistant', { icon: 'effects' }),
    cmd('export', { icon: 'export', label: 'Export...' }),
    cmd('shareReview', { icon: 'shareReview', label: 'Share for review...' }),
    cmd('reviewComments', { icon: 'comment', label: 'Review comments' }),
    cmd('save', { icon: 'cloudCheck' }),
    'separator',
    cmd('undo', { icon: 'undo' }),
    cmd('redo', { icon: 'redo' }),
    'separator',
    { label: 'Project settings...', icon: 'settings', onSelect: () => ctx.openProjectSettings() },
    cmd('preferences', { icon: 'settings', label: 'Preferences...' }),
    { label: 'Theme', icon: 'sun', submenu: themeMenuItems },
    cmd('shortcuts', { icon: 'keyboard', label: 'Keyboard shortcuts' }),
    'separator',
    { label: 'About Video Studio', icon: 'info', onSelect: () => ctx.openAbout() },
  ], { label: 'Main menu' });

  // Desktop menu bar; on narrow windows the app menu above holds everything.
  const menus = {
    File: () => [
      { label: 'New project', icon: 'plus', onSelect: () => ctx.newProject() },
      { label: 'Back to projects', icon: 'home', onSelect: () => ctx.exitToHome() },
      'separator',
      cmd('import', { icon: 'import', label: 'Import media...' }),
      ctx.openRecord ? { label: 'Record...', icon: 'camera', onSelect: () => ctx.openRecord() } : null,
      cmd('scriptToVideo', { icon: 'script', label: 'Script to video...' }),
      'separator',
      cmd('newTimeline', { icon: 'timelinePlus', label: 'New timeline...' }),
      { label: 'Timelines', icon: 'timelines', submenu: () => ctx.timelines?.menuItems() || [] },
      'separator',
      cmd('export', { icon: 'export', label: 'Export...' }),
      cmd('shareReview', { icon: 'shareReview', label: 'Share for review...' }),
      cmd('reviewComments', { icon: 'comment', label: 'Review comments', checked: Boolean(ctx.review?.open) }),
      ctx.exportStill ? { label: 'Export frame as image', icon: 'image', onSelect: () => ctx.exportStill() } : null,
      cmd('save', { icon: 'cloudCheck' }),
      'separator',
      { label: 'Project settings...', icon: 'settings', onSelect: () => ctx.openProjectSettings() },
    ].filter(Boolean),
    Edit: () => [
      cmd('undo', { icon: 'undo', label: store.history.canUndo() ? `Undo ${store.history.undoLabel}` : 'Undo' }),
      cmd('redo', { icon: 'redo', label: store.history.canRedo() ? `Redo ${store.history.redoLabel}` : 'Redo' }),
      cmd('history', { icon: 'clock', label: 'History' }),
      cmd('findReplace', { icon: 'search', label: 'Find and replace...' }),
      'separator',
      cmd('cut', { icon: 'scissors' }),
      cmd('copy', { icon: 'copy' }),
      cmd('paste', { icon: 'paste' }),
      cmd('duplicate', { icon: 'copy' }),
      cmd('delete', { icon: 'trash' }),
      'separator',
      cmd('copyAttributes', { icon: 'clipboard' }),
      cmd('pasteAttributes', { icon: 'paste', label: 'Paste attributes...' }),
      'separator',
      cmd('split', { icon: 'split' }),
      cmd('splitAll', { icon: 'split' }),
      cmd('group', { icon: 'group' }),
      cmd('ungroup', { icon: 'ungroup' }),
      cmd('toggleDisabled', { icon: 'powerOff' }),
      cmd('multicam', { icon: 'multicam', label: 'Create multi-camera clip...' }),
      cmd('flattenMulticam', { icon: 'rows' }),
      'separator',
      cmd('assistant', { icon: 'effects', checked: Boolean(ctx.assistant?.isOpen) }),
      cmd('splitScenes', { icon: 'scissors', label: 'Split at scene changes...' }),
      cmd('removeSilences', { icon: 'waveform', label: 'Remove silences...' }),
      cmd('syncBySound', { icon: 'waveform' }),
      cmd('removeBackground', { icon: 'cutout', label: 'Remove background' }),
      cmd('stabilize', { icon: 'focus', label: 'Stabilize...' }),
      cmd('removeFlicker', { icon: 'brightness', label: 'Remove flicker...' }),
      cmd('extractAudio', { icon: 'fileAudio' }),
      cmd('autoReframe', { icon: 'focus', label: 'Auto reframe...' }),
      cmd('findHighlights', { icon: 'highlights', label: 'Find highlights...' }),
      cmd('dub', { icon: 'languages', label: 'Dub into another language...' }),
      cmd('trackMotion', { icon: 'crosshair', label: 'Track motion...' }),
      'separator',
      cmd('markIn', { icon: 'markIn' }),
      cmd('markOut', { icon: 'markOut' }),
      cmd('cutRange', { icon: 'scissors' }),
      cmd('liftRange', { icon: 'trash' }),
      'separator',
      cmd('selectAll'),
      cmd('selectLeft'),
      cmd('selectRight'),
      cmd('deselect'),
      'separator',
      cmd('preferences', { icon: 'settings', label: 'Preferences...' }),
    ],
    View: () => [
      { label: 'Layout', icon: 'layout', submenu: () => layoutItems() },
      { label: 'Theme', icon: 'sun', submenu: themeMenuItems },
      'separator',
      cmd('zoomIn', { icon: 'zoomIn' }),
      cmd('zoomOut', { icon: 'zoomOut' }),
      cmd('zoomFit', { icon: 'zoomFit' }),
      'separator',
      cmd('toggleSnap', { checked: store.toggles.snap }),
      cmd('toggleRipple', { checked: store.toggles.ripple }),
      cmd('toggleLinkOverlays', { checked: store.toggles.linkOverlays }),
      cmd('toggleHoverPreview', { checked: store.toggles.hoverPreview }),
      'separator',
      cmd('toggleLoop', { icon: 'repeat', checked: Boolean(ctx.player?.loop) }),
      cmd('fullscreen', { icon: 'fullscreen' }),
    ],
    Help: () => [
      cmd('shortcuts', { icon: 'keyboard', label: 'Keyboard shortcuts' }),
      'separator',
      { label: 'About Video Studio', icon: 'info', onSelect: () => ctx.openAbout() },
    ],
  };
  const menubar = h('nav.menubar', { 'aria-label': 'Menu bar' }, Object.entries(menus).map(([name, items]) => {
    const b = h('button.menubar-item', { type: 'button' }, name);
    menuButton(b, items, { label: name });
    // With one menu open, pointing at another menu bar item switches to it.
    b.addEventListener('pointerenter', () => {
      const other = [...menubar.children].find((x) => x !== b && x.getAttribute('aria-expanded') === 'true');
      if (other) b.click();
    });
    return b;
  }));
  // Left and right arrows move between the menu bar's buttons.
  menubar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const btns = [...menubar.children];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length].focus();
  });

  function layoutItems() {
    const cur = prefs().layout || 'default';
    return [
      ...LAYOUTS.map((l) => ({ label: l.label, icon: l.icon, radio: true, checked: cur === l.id, onSelect: () => ctx.applyLayout?.(l.id) })),
      'separator',
      { label: 'Reset layout', icon: 'reset', onSelect: () => ctx.applyLayout?.(cur) },
    ];
  }
  const layoutBtn = h('button.icon-btn.layout-btn', { type: 'button', 'aria-label': 'Layout', 'data-tip': 'Layout' }, icon('layout', 18), icon('chevronDown', 12));
  menuButton(layoutBtn, layoutItems, { align: 'end', label: 'Layout' });

  const exportBtn = h('button.btn.primary.export-btn', { type: 'button', 'data-tip': 'Export', 'data-tip-key': 'Ctrl+E' }, icon('export', 16), h('span', 'Export'));
  exportBtn.addEventListener('click', () => ctx.openExport());
  const shareBtn = h('button.btn.share-btn', { type: 'button', 'data-tip': 'Share for review' }, icon('shareReview', 16), h('span', 'Share'));
  shareBtn.addEventListener('click', () => commands.run('shareReview'));
  const shortcutsBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Keyboard shortcuts', 'data-tip': 'Keyboard shortcuts' }, icon('keyboard', 18));
  const aiBtn = h('button.icon-btn.ai-btn', { type: 'button', 'aria-label': 'AI assistant', 'aria-controls': 'ai-panel', 'data-tip': 'AI assistant', 'data-tip-key': shortcutLabel(commands.get('assistant')?.keys[0] || 'Mod+K') }, icon('effects', 18));
  aiBtn.addEventListener('click', () => commands.run('assistant'));
  shortcutsBtn.addEventListener('click', () => ctx.openShortcuts());

  const account = accountButton(ctx.account);
  const el = h('header.topbar', { role: 'banner' },
    h('div.topbar-left', menuBtn, menubar, status),
    h('div.topbar-center', nameBtn),
    h('div.topbar-right', aiBtn, layoutBtn, shortcutsBtn, account, shareBtn, exportBtn),
  );

  const fmt = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const setStatus = ({ status: s, at }) => {
    const local = ctx.library.backend.kind === 'local';
    status.classList.toggle('error', s === 'error');
    if (s === 'saving') status.textContent = 'Saving...';
    else if (s === 'error') status.textContent = "Couldn't save. Retrying...";
    else if (s === 'pending') status.textContent = 'Unsaved changes';
    else status.textContent = `${local ? 'Saved in this browser' : 'Auto saved'}: ${fmt(at)}`;
  };
  ctx.saver.on('status', setStatus);
  setStatus({ status: 'saved', at: ctx.saver.lastSaved });
  const uploads = h('span.upload-status', { role: 'status' });
  ctx.library.on('uploads', ({ pending, failed }) => {
    uploads.classList.toggle('error', Boolean(failed));
    if (failed) uploads.textContent = `${failed} media file${failed === 1 ? '' : 's'} not uploaded. Retrying...`;
    else uploads.textContent = pending ? `Uploading ${pending} file${pending === 1 ? '' : 's'}...` : '';
  });
  el.querySelector('.topbar-left').append(uploads);
  return { el };
}

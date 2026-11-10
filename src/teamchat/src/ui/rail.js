/**
 * The narrow rail at the left edge: the workspace mark on top
 * (its menu), then Home, DMs, Activity, and Later, each switching what the
 * column beside it shows, and at the bottom a "new" menu, a theme toggle,
 * and the user's avatar with their menu (status, pause, settings, sign
 * out). Badges carry the unread direct messages and activity counts.
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { avatar, workspaceMark } from './avatar.js';
import { openMenu } from './menu.js';
import { toast } from './toast.js';
import { applyTheme, isDark, currentTheme } from './theme.js';
import { store } from '../lib/store.js';
import { navigate, parseHash, PANE_VIEWS } from '../lib/router.js';
import { parseRef } from '../lib/refs.js';
import { pauseMenuItems } from './notifymenu.js';
import { userMenuShown } from './usermenu.js';
import { confirmDialog } from './modal.js';
import {
  settingsDialog, createChannelDialog, browseChannelsDialog, newDmDialog, inviteDialog, workspaceSettingsDialog,
  membersDialog, createWorkspaceDialog, joinWorkspaceDialog, importWorkspaceDialog, addSharedChannelDialog,
} from './dialogs.js';

const ITEMS = [
  { key: 'home', label: 'Home', icon: 'home' },
  { key: 'dms', label: 'DMs', icon: 'messageText' },
  { key: 'activity', label: 'Activity', icon: 'bell' },
  { key: 'files', label: 'Files', icon: 'files' },
  { key: 'later', label: 'Later', icon: 'bookmark' },
];

/**
 * Sign out, asked first: the huddle is left and this browser's pushes are
 * taken down before the session goes (store.signOut), then the page starts
 * over at the sign-in page. Shared by the rail's menu and by the top bar's
 * <puter-user-menu> (usermenu.js), whose own Sign out it replaces.
 */
export async function signOutFlow() {
  const ok = await confirmDialog({ title: 'Sign out?', message: 'You can sign back in with your Puter account anytime.', confirmLabel: 'Sign out', danger: false });
  if (!ok) return;
  try {
    await store.signOut();
  } catch (e) {
    toast(e.message || 'Could not sign out', { icon: 'alert' });
    return;
  }
  location.hash = '';
  location.reload();
}

/**
 * The workspace menu, shared by the rail's mark and the sidebar's name: a
 * card saying which workspace and where it lives, then people, settings,
 * the other workspaces, and ways to add one.
 */
export function workspaceMenuItems() {
  const ws = store.ws;
  const ref = parseRef(store.wsId);
  const items = [];
  if (ws) items.push({ card: { node: workspaceMark(el('span.ws-mark.menu-card-mark', { 'aria-hidden': 'true' }), ws), title: ws.name, sub: ref ? ref.url.replace(/^https:\/\//, '') : null } }, 'sep');
  if (store.isAdmin()) items.push({ label: `Invite people to ${ws?.name || 'the workspace'}`, icon: 'userPlus', onSelect: () => inviteDialog() });
  if (store.isAdmin()) items.push({ label: 'Add a shared channel', icon: 'shared', sub: 'From a share link another workspace sent you', onSelect: () => addSharedChannelDialog() });
  items.push({ label: store.isGuest() ? 'People you can see' : 'Members', icon: 'users', onSelect: () => membersDialog() });
  items.push({ label: 'Workspace settings', icon: 'gear', onSelect: () => workspaceSettingsDialog() });
  if (store.workspaces.length > 1) {
    items.push('sep', { header: 'Switch workspace' });
    for (const w of store.workspaces) {
      items.push({
        label: w.name, leading: workspaceMark(el('span.ws-mark.ws-mark-sm', { 'aria-hidden': 'true' }), w, w.id), checked: w.id === store.wsId,
        sub: w.unreachable ? 'Server not reachable' : w.movedTo ? 'Moved, read-only copy' : null,
        onSelect: () => navigate({ ws: w.id }),
      });
    }
  }
  items.push('sep',
    { label: 'Create a workspace', icon: 'plus', onSelect: () => createWorkspaceDialog() },
    { label: 'Join with an invite', icon: 'login', onSelect: () => joinWorkspaceDialog() },
    { label: 'Import from an export', icon: 'download', onSelect: () => importWorkspaceDialog() });
  return items;
}

/** Which rail item the current route belongs to. */
export function railMode(route = parseHash(location.hash)) {
  if (route.view === 'files') return 'files';
  return PANE_VIEWS.includes(route.view) ? route.view : 'home';
}

export function renderRail(container) {
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; render(); });
  }

  function badgeFor(key) {
    if (!store.ws) return 0;
    if (key === 'dms') return store.dms().reduce((n, d) => (store.isMuted(d.id) ? n : n + store.unreadCount(d.id)), 0);
    if (key === 'activity') return store.inboxUnread();
    if (key === 'home') return store.joinedChannels().reduce((n, c) => n + (store.isMuted(c.id) ? 0 : store.mentionCount(c.id)), 0);
    return 0;
  }

  function go(key) {
    const r = parseHash(location.hash);
    if (key === 'home') {
      // Back to the channel list, on the conversation that is open if any. `view: null` is
      // said outright: navigate() keeps a pane (DMs, Activity, Later) beside a conversation
      // unless told not to, and Home's whole point is to leave the pane.
      navigate(r.conv && r.name === 'conversation' ? { ws: store.wsId, conv: r.conv, view: null } : { ws: store.wsId });
      return;
    }
    // The item already chosen, pressed again with a conversation open beside
    // its pane: the conversation stays, rather than giving
    // way to "Pick a conversation" for a press that asked for nothing new.
    if (railMode(r) === key && r.conv) return;
    navigate({ ws: store.wsId, view: key });
  }

  function render() {
    const ws = store.ws;
    const mode = railMode();
    const mark = el('button.rail-mark', {
      type: 'button', 'aria-label': ws ? `${ws.name}. Workspace menu` : 'Workspace', 'aria-haspopup': 'menu', title: ws?.name || '',
      onclick: (e) => openWorkspaceMenu(e.currentTarget),
    });
    if (ws) workspaceMark(mark, ws);
    // The badge's number said as what it counts: mentions in channels on
    // Home, unread direct messages on DMs, new activity on Activity.
    const counted = (key, n) => (key === 'home' ? `${n} mention${n === 1 ? '' : 's'}` : key === 'activity' ? `${n} new` : `${n} unread`);
    const items = ITEMS.map((it) => {
      const n = badgeFor(it.key);
      return el('button.rail-item', {
        type: 'button', 'aria-label': `${it.label}${n ? `, ${counted(it.key, n)}` : ''}`, 'aria-current': mode === it.key ? 'page' : null,
        onclick: () => go(it.key),
      },
      el('span.rail-icon', { html: icon(it.icon, 20, 1.9) }, n ? el('span.rail-badge', {}, String(n > 99 ? '99+' : n)) : null),
      el('span.rail-label', {}, it.label));
    });
    const plus = el('button.rail-round', {
      type: 'button', html: icon('plus', 20, 2.2), 'aria-label': 'New', title: 'New', 'aria-haspopup': 'menu',
      onclick: (e) => openMenu(e.currentTarget, [
        { header: 'Create' },
        { label: 'Message', icon: 'pencil', sub: 'Start a conversation with someone', onSelect: () => newDmDialog() },
        !store.isGuest() && { label: 'Channel', icon: 'hash', sub: 'Start a group conversation by topic', onSelect: () => createChannelDialog() },
        !store.isGuest() && { label: 'Browse channels', icon: 'search', sub: store.browsableChannels().length ? `${store.browsableChannels().length} you could join` : 'See every public channel', onSelect: () => browseChannelsDialog() },
        store.isAdmin() && 'sep',
        store.isAdmin() && { label: 'Invite people', icon: 'userPlus', sub: 'A link or a code that expires', onSelect: () => inviteDialog() },
        store.isAdmin() && { label: 'Add a shared channel', icon: 'shared', sub: 'A channel another workspace shared with you', onSelect: () => addSharedChannelDialog() },
      ], { align: 'start', side: 'top', label: 'Create' }),
    });
    const dark = isDark();
    const theme = el('button.rail-round', {
      type: 'button', html: icon(dark ? 'sun' : 'moon', 19, 2), 'aria-label': dark ? 'Switch to light theme' : 'Switch to dark theme', title: dark ? 'Light theme' : 'Dark theme',
      onclick: async () => {
        const next = isDark() ? 'light' : 'dark';
        applyTheme(next);
        // The button follows the theme at once (its icon and its name are
        // read from the page): redrawn only once the preference was written
        // to the account, a read and a write away, it showed the moon over a
        // page already dark for that long, and offline for the whole of the
        // failed write's wait.
        schedule();
        try {
          await store.updatePrefs({ theme: next });
        } catch { /* kept on this device anyway */ }
        schedule();
      },
    });
    const me = store.profile;
    const member = me ? store.member(me.uuid) : null;
    const paused = store.notificationsPaused();
    const meBtn = me ? el('button.rail-me', {
      type: 'button', 'aria-label': `You: ${member.name}. Status, notifications, and settings`, 'aria-haspopup': 'menu',
      onclick: (e) => openUserMenu(e.currentTarget),
    }, avatar({ ...member, uuid: me.uuid }, { size: 'sm', presence: paused ? null : true, paused })) : el('span');
    // The rail is rebuilt on every poll (its badges move): the button under
    // the keyboard is found again by its label's stem (the count after the
    // comma moves), else by its place, so focus does not fall to the page.
    const active = container.contains(document.activeElement) ? document.activeElement : null;
    const stem = (n) => (n.getAttribute('aria-label') || n.textContent || '').split(',')[0];
    const was = active ? { stem: stem(active), index: [...container.querySelectorAll('button')].indexOf(active) } : null;
    container.replaceChildren(mark, el('div.rail-items', {}, ...items), el('span.rail-spacer'), plus, theme, meBtn);
    container.hidden = !ws;
    if (was && !active.isConnected) {
      const buttons = [...container.querySelectorAll('button')];
      (buttons.find((n) => stem(n) === was.stem) || buttons[was.index])?.focus({ preventScroll: true });
    }
  }

  function openWorkspaceMenu(anchor) {
    openMenu(anchor, workspaceMenuItems(), { align: 'start', label: 'Workspace menu' });
  }

  function openUserMenu(anchor) {
    const me = store.profile;
    const m = store.member(me.uuid);
    const status = store.statusOf(me.uuid);
    const paused = store.notificationsPaused();
    const items = [
      { header: `${m.name} (@${m.username})` },
      { label: status ? `${status.emoji || ''} ${status.text || ''}`.trim() : 'Set a status', icon: status ? null : 'smilePlus', sub: status ? 'Change or clear in settings' : null, onSelect: () => settingsDialog({ section: 'status' }) },
      {
        label: paused ? 'Notifications paused' : 'Pause notifications', icon: paused ? 'bellOff' : 'bell', sub: paused ? 'Resume or change' : null,
        onSelect: () => openMenu(anchor, pauseMenuItems({ onChange: schedule }), { align: 'start', side: 'top', label: 'Pause notifications' }),
      },
      'sep',
      { label: 'Profile and settings', icon: 'gear', onSelect: () => settingsDialog() },
      { label: currentTheme() === 'system' ? 'Theme: system' : `Theme: ${currentTheme()}`, icon: 'monitor', sub: 'Choose in settings', onSelect: () => settingsDialog({ section: 'appearance' }) },
    ];
    // Not while puter.js's own account menu ends the top bar (usermenu.js):
    // Sign out is there, and runs the same steps.
    if (typeof puter !== 'undefined' && puter.env !== 'app' && !userMenuShown()) {
      items.push('sep', { label: 'Sign out', icon: 'logout', onSelect: signOutFlow });
    }
    openMenu(anchor, items, { align: 'start', side: 'top', label: 'You' });
  }

  const offs = [store.on('workspace', schedule), store.on('activity', schedule), store.on('profile', schedule)];
  window.addEventListener('hashchange', schedule);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedule);
  render();
  return {
    refresh: schedule,
    destroy() {
      offs.forEach((f) => f());
      window.removeEventListener('hashchange', schedule);
    },
  };
}

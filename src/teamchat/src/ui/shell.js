/**
 * The app shell: sidebar, main column, side panel, and the hash router that
 * decides what each shows. Also the place where workspace-level events
 * (removed from a workspace, incoming messages) turn into UI.
 */
import { el, focusables, composing, coarsePointer } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { closeAllModals } from './modal.js';
import { renderSidebar } from './sidebar.js';
import { renderRail, railMode } from './rail.js';
import { createDmsPane } from './dmspane.js';
import { createConversationView } from './conversation.js';
import { createSearchView } from './search.js';
import { createListView } from './views.js';
import { createFilesPage } from './filesview.js';
import { createDirectoryView } from './directory.js';
import { renderThreadPanel } from './panel.js';
import { installShortcuts, renderShortcutsPanel } from './shortcuts.js';
import { openDetailsDialog } from './details.js';
import { acceptConnectDialog } from './dialogs.js';
import { openOnboarding, homeEmpty, shouldOnboard } from './onboarding.js';
import { store, TRANSFER_FREEZE_MS, isPlatformPage } from '../lib/store.js';
import { ApiError } from '../lib/api.js';
import { parseHash, navigate, buildHash, PANE_VIEWS } from '../lib/router.js';
import { normalizeInviteCode } from '../shared/ids.js';
import { serverKeyOf, parseRef } from '../lib/refs.js';
import { SHARED_WORKER_URL } from '../config.js';
import { shouldNotify, playNotificationSound } from '../lib/notify.js';
import { previewWords } from './applink.js';
import { api } from '../lib/api.js';
import { parentOfThread } from '../shared/blocks.js';
import { clearAttachmentCache } from '../lib/files.js';
import { clearAvatarCache } from '../lib/avatars.js';
import { noteRecent, recentConvs, forgetRecent, noteSearch, recentSearches, forgetSearch, clearSearches } from '../lib/recent.js';
import { openMenu, closeMenu } from './menu.js';
import { avatar, groupAvatar } from './avatar.js';
import { channelIcon } from './icons.js';
import { mountHuddleDock, joinHuddleFlow } from './huddle.js';
import { EV_GRANT } from '../shared/events.js';

const LAST_WS_KEY = 'teamchat:lastws';

/**
 * How long an inconclusive look at the events consent question (GET
 * /api/server answered `why: 'unknown'`, or threw) is left before trying
 * again. An 'unknown' verdict turns into a real one the moment any member's
 * tab bootstraps, which is seconds after they open the app, so a minute is
 * soon enough to catch it; a workspace churning structurally on every
 * `'workspace'` emit then costs at most one GET /api/server a minute rather
 * than one per emit.
 */
const EV_CONSENT_RECHECK_MS = 60_000;

const SIDEBAR_W_KEY = 'teamchat:sidebarw';
const SIDEBAR_W_MIN = 220;
const SIDEBAR_W_MAX = 480;

/**
 * The sidebar's width, draggable at its right edge on desktop,
 * and remembered across sessions. The chosen width lands on the root as
 * --sidebar-w (the shell's grid column reads it) wrapped in a clamp whose
 * ceiling follows the viewport, so a window later made narrower squeezes
 * the sidebar back before it starves the main column. A double-click on
 * the handle, or Enter with it focused, puts the stylesheet default back.
 */
function mountSidebarResizer(sidebarEl) {
  const clamp = (w) => Math.round(Math.min(SIDEBAR_W_MAX, Math.max(SIDEBAR_W_MIN, w)));
  // The splitter tells assistive tech the width it really renders at: the
  // CSS clamp can squeeze a saved 480px to far less on a narrow window, and
  // the stylesheet default has no chosen number at all, so the value is read
  // back from the layout rather than echoing what was asked for.
  const syncNow = () => {
    if (!sidebarEl.isConnected) return;
    handle.setAttribute('aria-valuenow', Math.round(sidebarEl.getBoundingClientRect().width));
  };
  const apply = (w) => {
    // 68px of rail and 360px of main column come off the ceiling, whatever
    // width was saved on a wider window.
    document.documentElement.style.setProperty('--sidebar-w', `clamp(${SIDEBAR_W_MIN}px, ${w}px, calc(100vw - 428px))`);
    syncNow();
  };
  const save = (w) => {
    try { localStorage.setItem(SIDEBAR_W_KEY, String(w)); } catch { /* ignore */ }
  };
  const reset = () => {
    document.documentElement.style.removeProperty('--sidebar-w');
    syncNow();
    try { localStorage.removeItem(SIDEBAR_W_KEY); } catch { /* ignore */ }
  };

  const handle = el('div.side-resizer', {
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': 'Resize sidebar',
    'aria-valuemin': SIDEBAR_W_MIN,
    'aria-valuemax': SIDEBAR_W_MAX,
    tabindex: 0,
  });

  let width = null; // the chosen width, or null while on the default
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_W_KEY));
    if (Number.isFinite(saved) && saved > 0) { width = clamp(saved); apply(width); }
  } catch { /* ignore */ }

  let dragFrom = null; // { x, w } while a drag is on
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    dragFrom = { x: e.clientX, w: sidebarEl.getBoundingClientRect().width };
    handle.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragFrom) return;
    width = clamp(dragFrom.w + (e.clientX - dragFrom.x));
    apply(width);
  });
  const drop = () => {
    if (!dragFrom) return;
    dragFrom = null;
    handle.classList.remove('dragging');
    if (width != null) save(width);
  };
  handle.addEventListener('pointerup', drop);
  handle.addEventListener('pointercancel', drop);
  handle.addEventListener('dblclick', () => { width = null; reset(); });
  handle.addEventListener('keydown', (e) => {
    // Only the bare keys are the handle's: an arrow held with Alt, Cmd or
    // Ctrl is the browser's (Back and Forward) or a shortcut's, and passes,
    // as it does the lists, the tab rows and the groups of choices.
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      width = clamp(sidebarEl.getBoundingClientRect().width + (e.key === 'ArrowRight' ? 16 : -16));
      apply(width);
      save(width);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      width = e.key === 'Home' ? SIDEBAR_W_MIN : SIDEBAR_W_MAX;
      apply(width);
      save(width);
    } else if (e.key === 'Enter') {
      width = null;
      reset();
    }
  });
  // A separator that takes focus should always carry its value; the first
  // sync waits a frame for the shell to be laid out, and focus re-syncs in
  // case the window was resized meanwhile.
  handle.addEventListener('focus', syncNow);
  requestAnimationFrame(syncNow);

  sidebarEl.append(handle);
}

export function mountShell(appRoot) {
  const railEl = el('nav.rail', { 'aria-label': 'Views', hidden: true });
  const sidebarEl = el('nav.sidebar', { 'aria-label': 'Workspace' });
  // The sidebar shows either the Home list (channels, people) or, when a
  // rail item is chosen, a pane: direct messages, activity, or later.
  const homeEl = el('div.sidebar-home');
  const paneEl = el('div.sidebar-pane', { hidden: true });
  sidebarEl.append(homeEl, paneEl);
  mountSidebarResizer(sidebarEl);
  const mainSlot = el('div', { style: { display: 'contents' } });
  const panelEl = el('aside.panel', { hidden: true, 'aria-label': 'Side panel' });
  const shell = el('div.shell', {}, railEl, sidebarEl, mainSlot, panelEl);
  const topbar = buildTopbar();
  // While the workspace is being moved to another server its worker takes
  // no writes (each answered "try again in a few minutes") for up to half
  // an hour from the moment the move began, and reads stay open: a slim row
  // under the top bar says so, inside the frame so the bar stays clear, in
  // the offline strip's look. Its root stays in the frame as an empty live
  // region so the words are announced when they arrive. It follows the
  // store's workspace events (a refresh brings the field cleared when the
  // move completes or is given up) and, since the freeze also lapses on the
  // worker's clock without any event, a timer set to that moment.
  const moving = el('div.transfer-strip', { role: 'status', 'aria-live': 'polite' });
  let movingTimer = null;
  function syncMoving() {
    clearTimeout(movingTimer);
    movingTimer = null;
    const on = !!store.ws && store.isTransferring();
    if (on && !moving.childElementCount) {
      moving.replaceChildren(
        el('span.offline-icon', { html: icon('refresh', 15, 2), 'aria-hidden': 'true' }),
        // A space between the two sentences: the flex row lays them out with
        // its gap, but a screen reader reads the text as written.
        el('span', {}, 'This workspace is being moved to another server.'), ' ',
        el('span.offline-note', {}, 'You can read, but nothing can be posted for a few minutes.'));
    } else if (!on && moving.childElementCount) moving.replaceChildren();
    if (on) movingTimer = setTimeout(syncMoving, Math.max(250, store.ws.transferring.at + TRANSFER_FREEZE_MS - store.serverNow() + 250));
  }
  const frame = el('div.app-frame', {}, topbar.el, moving, shell);
  // The link's hash is no route (the router would read it as home and send
  // the reader to their first channel), so the click moves focus itself: to
  // the message list when a conversation is open, else to the main column.
  const skip = el('a.skip-link', {
    href: '#main',
    onclick: (e) => {
      e.preventDefault();
      const target = mainSlot.querySelector('.msg-list') || mainSlot.querySelector('.main') || mainSlot.firstElementChild;
      if (!(target instanceof HTMLElement)) return;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    },
  }, 'Skip to messages');
  appRoot.replaceChildren(skip, frame);

  renderSidebar(homeEl);
  renderRail(railEl);
  // The huddle window sits over the bottom of the sidebar while the user is in one, whatever is open.
  mountHuddleDock();
  let pane = null; // the list pane beside a conversation { destroy }
  let paneKind = null;
  let view = null; // current conversation view
  let viewConv = null;
  let viewMessage = null; // the message the conversation view was last asked to show
  let searchView = null;
  let listView = null; // Threads / Activity / Later
  let listKind = null;
  let panel = null; // current panel { destroy }
  let panelKey = null;
  let panelMessage = null;
  let details = null; // the open details dialog { conv, close }
  let currentWs = null;
  let onboardingOpen = false;

  function showMain(node) {
    mainSlot.replaceChildren(node);
    node.id = 'main';
    // The primary landmark, and where the skip link lands.
    node.setAttribute('role', 'main');
  }

  /**
   * Whether the keyboard is in the conversation's column or the panel beside
   * it, about to be taken down for the sidebar's list (a phone's Back to the
   * channel list, or to the pane a conversation was opened from; on a desk
   * the shortcut that opens a pane in the conversation's place). Asked
   * before the teardown, which leaves the keyboard on the page.
   */
  const keyboardInColumn = () => mainSlot.contains(document.activeElement) || panelEl.contains(document.activeElement);

  /**
   * The keyboard, once that column is gone: to the list that has taken the
   * screen, on the row of the conversation just left when the list has one
   * (a channel or person in the sidebar, a conversation in the DMs pane),
   * else the list's filter box, else its first control (the Activity and
   * Later panes' own Back). Not a box under a finger, where it would bring
   * the phone's keyboard up.
   */
  function focusSidebar(from) {
    const rendered = (n) => n.getClientRects().length > 0;
    const row = from ? [...sidebarEl.querySelectorAll('a[href]')].filter(rendered).find((a) => parseHash(a.getAttribute('href')).conv === from) : null;
    const box = coarsePointer() ? null : [...sidebarEl.querySelectorAll('.side-filter-input')].find(rendered);
    (row || box || focusables(sidebarEl).find((n) => !coarsePointer() || !/^(input|textarea)$/.test(n.localName)))?.focus({ preventScroll: true });
  }

  /**
   * A view that has taken the conversation's column while the keyboard was
   * in it (Threads by its shortcut from the message box, Files or the
   * Directory from a row of a pane): the keyboard goes to the view's first
   * control, or to the view itself while it has none (its list still
   * loading), so the next Tab starts inside it rather than at the top of
   * the window, where it started from the page body the box left it on. Not
   * a text box under a finger, where it would bring the phone's keyboard up.
   */
  function settleMain(node) {
    const control = focusables(node).find((n) => !coarsePointer() || !/^(input|textarea)$/.test(n.localName));
    if (control) control.focus({ preventScroll: true });
    else {
      node.setAttribute('tabindex', '-1');
      node.focus({ preventScroll: true });
    }
  }

  // The main column's heading is the page's first-level one: with a pane
  // (DMs, Activity, Later) beside it the pane's title is a second-level
  // heading, and the page had no first-level heading at all for a screen
  // reader to land on (a conversation's name is one, so is a view's title).
  function placeholderMain(text = 'Pick a conversation', sub = 'Choose a channel or a person from the sidebar to start.', ic = 'messages') {
    return el('div.main', {}, el('div.empty', { style: { flex: 1, justifyContent: 'center' } },
      el('div.empty-icon', { html: icon(ic, 24) }),
      el('h1', {}, text),
      el('p', {}, sub)));
  }

  /**
   * The bar across the top: back and forward through the
   * app's own history, and a search box for the whole workspace whose
   * results take the main column. Hidden on phones, where the search view
   * keeps its own box.
   */
  function buildTopbar() {
    // Said to be disabled, when the history runs out, rather than being so:
    // a disabled button hands its focus to the page (Back pressed from the
    // keyboard onto the first page the app has been on took the keyboard
    // with it), and is skipped by Tab; the press asks the browser for
    // nothing meanwhile.
    const idle = (btn) => btn.getAttribute('aria-disabled') === 'true';
    const back = el('button.icon-btn.top-nav', { type: 'button', html: icon('arrowLeft', 18, 2), 'aria-label': 'Back', title: 'Back', onclick: () => { if (!idle(back)) history.back(); } });
    const fwd = el('button.icon-btn.top-nav', { type: 'button', html: icon('arrowRight', 18, 2), 'aria-label': 'Forward', title: 'Forward', onclick: () => { if (!idle(fwd)) history.forward(); } });
    // History: where you have been lately, newest first, behind the clock.
    const hist = el('button.icon-btn.top-nav', {
      type: 'button', html: icon('clock', 18, 2), 'aria-label': 'History', title: 'History', 'aria-haspopup': 'menu',
      onclick: (e) => openHistoryMenu(e.currentTarget),
    });
    const input = el('input.top-search-input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search messages', autocomplete: 'off', spellcheck: false, enterkeyhint: 'search' });
    const clear = el('button.top-search-clear', {
      type: 'button', html: icon('x', 14, 2.4), 'aria-label': 'Clear search', hidden: true,
      onclick: () => { input.value = ''; clear.hidden = true; if (parseHash(location.hash).name === 'search') navigate({ ws: store.wsId, query: '' }, { replace: true }); input.focus(); },
    });
    const form = el('form.top-search', { role: 'search', onsubmit: (e) => { e.preventDefault(); if (store.wsId) { noteSearch(store.wsId, input.value); navigate({ ws: store.wsId, query: input.value.trim() }); } } },
      el('span.top-search-icon', { html: icon('search', 16, 2) }), input, clear);
    input.addEventListener('input', () => { clear.hidden = !input.value; });

    // The dropdown under an empty box: search inside the
    // open conversation, and the searches run lately, each removable.
    const drop = el('div.top-search-drop', { hidden: true, role: 'listbox', 'aria-label': 'Search suggestions' });
    form.append(drop);
    const scopeOf = () => {
      const r = parseHash(location.hash);
      // Nothing to search in a conversation that cannot be opened (a private channel nobody is left in).
      if (!r.conv || !store.canAccess(r.conv)) return null;
      const ch = store.channel(r.conv);
      if (ch) return { label: ch.name, icon: 'hash', filter: `in:#${ch.name} ` };
      const dm = store.me?.dms?.[r.conv];
      const others = dm?.members.filter((u) => u !== store.uuid) || [];
      if (others.length === 1) return { label: store.member(others[0]).name, icon: 'message', filter: `in:@${store.member(others[0]).username} ` };
      return null;
    };
    const pickText = (text) => { input.value = text; clear.hidden = !text; input.focus(); input.setSelectionRange(text.length, text.length); };
    const renderDrop = () => {
      const scope = scopeOf();
      const recent = recentSearches(store.wsId);
      drop.replaceChildren();
      if (scope) {
        drop.append(el('button.top-drop-row.top-drop-scope', {
          type: 'button', role: 'option', onmousedown: (e) => e.preventDefault(),
          onclick: () => { pickText(scope.filter); renderDrop(); },
        }, el('span.top-drop-icon', { html: icon('filter', 16, 2) }), el('span.top-drop-text', {}, 'Search in ', el('span', { html: icon(scope.icon, 13, 2.2) }), el('strong', {}, scope.label))));
      }
      if (recent.length) {
        // Clear and Forget redraw the list under the button pressed: the
        // keyboard, left on nothing, fell to the page, and the list closed
        // behind it a moment later (see focusout). It goes to the box after
        // Clear, and after Forget to the row that took the forgotten one's
        // place (its own Forget, the same key again forgetting the next), or
        // the last row, or what is left of the list, or the box.
        drop.append(el('div.top-drop-head', {}, el('span', {}, 'Recent searches'), el('button.top-drop-clear', {
          type: 'button', onmousedown: (e) => e.preventDefault(), onclick: () => { clearSearches(store.wsId); renderDrop(); input.focus(); },
        }, 'Clear')));
        recent.forEach((q, i) => {
          drop.append(el('div.top-drop-row.top-drop-recent', { role: 'option' },
            el('button.top-drop-main', {
              type: 'button', onmousedown: (e) => e.preventDefault(),
              onclick: () => { pickText(q); noteSearch(store.wsId, q); navigate({ ws: store.wsId, query: q }); hideDrop(); },
            }, el('span.top-drop-icon', { html: icon('clock', 16, 2) }), el('span.top-drop-text', {}, q)),
            el('button.top-drop-x', {
              type: 'button', html: icon('x', 14, 2.4), 'aria-label': `Forget “${q}”`, onmousedown: (e) => e.preventDefault(),
              onclick: () => {
                const had = drop.contains(document.activeElement);
                forgetSearch(store.wsId, q);
                renderDrop();
                if (!had) return;
                const rows = [...drop.querySelectorAll('.top-drop-recent')];
                (rows[Math.min(i, rows.length - 1)]?.querySelector('.top-drop-x') || drop.querySelector('.top-drop-scope, .top-drop-main') || input).focus({ preventScroll: true });
              },
            })));
        });
      }
      if (!drop.children.length) drop.append(el('p.top-drop-empty', {}, 'Search every channel and conversation you are in. Narrow with in:#channel, from:@person, has:file, has:link, before:, after:.'));
    };
    const showDrop = () => {
      if (!store.wsId || input.value.trim()) { hideDrop(); return; }
      renderDrop();
      drop.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };
    const hideDrop = () => { drop.hidden = true; input.setAttribute('aria-expanded', 'false'); };
    input.addEventListener('focus', showDrop);
    input.addEventListener('click', showDrop);
    input.addEventListener('input', () => { if (input.value.trim()) hideDrop(); else showDrop(); });
    input.addEventListener('blur', () => setTimeout(() => { if (!form.contains(document.activeElement)) hideDrop(); }, 100));
    input.addEventListener('keydown', (e) => {
      // Escape during an IME composition cancels the composition, nothing more.
      if (composing(e)) return;
      // Tab leaves the box for the next control on the page, as it leaves a
      // combobox: the list goes first, so the key does not walk its rows
      // (two buttons a recent search, up to eight of them, and Clear) before
      // reaching anything else. The down arrow is the way into the list, and
      // Tab within it moves between its buttons as before.
      if (e.key === 'Tab' && !drop.hidden) {
        hideDrop();
        return;
      }
      // The key is the box's while it has something to undo: the dropdown
      // first, then the text. Clearing a search field on Escape is the
      // browser's own doing in some (Chrome, Safari) and not others
      // (Firefox), and either way the key travelled on to the document,
      // where it closed the thread panel beside the box. Empty, the key goes
      // on as usual. A modified Escape is somebody else's key (Shift+Esc
      // marks everything read) and passes, as it does every other filter box.
      if (e.key === 'Escape') {
        if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
        if (!drop.hidden) { e.preventDefault(); hideDrop(); return; }
        if (input.value) { e.preventDefault(); input.value = ''; input.dispatchEvent(new Event('input')); }
        return;
      }
      // The first suggestion, not the first button: with no open conversation
      // to offer, the first button is the recent searches' Clear. Only the
      // bare arrow: held with Alt it is the next-conversation shortcut.
      if (e.key === 'ArrowDown' && !drop.hidden && !e.altKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); drop.querySelector('.top-drop-scope, .top-drop-main')?.focus(); }
    });
    drop.addEventListener('keydown', (e) => {
      if (e.altKey || e.metaKey || e.ctrlKey) return; // a shortcut's arrow, not the list's
      const rows = [...drop.querySelectorAll('.top-drop-scope, .top-drop-main')];
      const i = rows.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (rows[i + 1] || rows[0])?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (i <= 0) input.focus(); else rows[i - 1].focus(); }
      // The keyboard goes back to the box first, then the list closes: the
      // box shows the list whenever it takes the keyboard with nothing typed
      // (see showDrop), so a list closed and then left for the box came
      // straight back, and Escape on a row seemed to do nothing but move the
      // keyboard. The up arrow from the first row keeps the list open on
      // purpose: it is a step back up the list, not a way out of it.
      else if (e.key === 'Escape' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); input.focus(); hideDrop(); }
    });
    drop.addEventListener('focusout', () => setTimeout(() => { if (!form.contains(document.activeElement)) hideDrop(); }, 100));
    // Typing opens the results as you go, once there is something to look for.
    let t = null;
    input.addEventListener('input', () => {
      clearTimeout(t);
      const q = input.value.trim();
      if (!store.wsId) return;
      t = setTimeout(() => {
        // Only what the box still holds: the Clear button empties it without
        // an input event, and the pause must not search what was cleared.
        if (input.value.trim() !== q) return;
        if (q.length >= 2 || parseHash(location.hash).name === 'search') navigate({ ws: store.wsId, query: q }, { replace: parseHash(location.hash).name === 'search' });
      }, 350);
    });
    // The reader went somewhere else before the pause was up (a sidebar row,
    // Back): the search they were typing does not follow them there.
    window.addEventListener('hashchange', () => { if (parseHash(location.hash).name !== 'search') clearTimeout(t); });
    const node = el('header.topbar', { hidden: true }, el('div.top-nav-group', {}, back, fwd, hist), form, el('span.top-spacer'));
    // Whether the last route synced was the results page, so that leaving it
    // is told from a poll's sync on any other page (see below).
    let wasSearch = false;
    const sync = () => {
      const r = parseHash(location.hash);
      const leftResults = wasSearch && r.name !== 'search';
      wasSearch = r.name === 'search';
      node.hidden = !store.ws;
      input.placeholder = store.ws ? `Search ${store.ws.name}` : 'Search';
      const canBack = typeof navigation !== 'undefined' && navigation?.canGoBack !== undefined ? navigation.canGoBack : true;
      const canFwd = typeof navigation !== 'undefined' && navigation?.canGoForward !== undefined ? navigation.canGoForward : true;
      back.setAttribute('aria-disabled', String(!canBack));
      fwd.setAttribute('aria-disabled', String(!canFwd));
      if (r.name === 'search') {
        if (document.activeElement !== input && input.value !== (r.query || '')) input.value = r.query || '';
        form.classList.add('active');
      } else {
        form.classList.remove('active');
        // The results left for a conversation or a view (a row of the sidebar,
        // Back, Alt+Down): the box empties, whether or not
        // the keyboard is still in it; the query stays among the recent
        // searches (see route). Kept while the keyboard is in it otherwise:
        // on any other page the box holds what is being typed, whose search
        // has not run yet, and a poll's sync must not take it.
        if (leftResults || document.activeElement !== input) input.value = '';
      }
      clear.hidden = !input.value;
    };
    store.on('workspace', sync);
    window.addEventListener('hashchange', sync);
    return { el: node, sync, focus: () => { input.focus(); input.select(); } };
  }

  /** The clock's menu: recently opened conversations, with the current one on top. */
  function openHistoryMenu(anchor) {
    const items = [{ header: 'Recent' }];
    const cur = parseHash(location.hash).conv;
    // A direct message on the host of a shared channel is known here only
    // once that host has answered (see store._mergeLinkMe): a host still to
    // be read, out of reach and to be tried again, or whose connection has
    // ended (an admin may connect the workspaces again) has not said the
    // conversation is gone, only that it is not here yet.
    const hostPending = [...store.links.values()].some((l) => !l.loaded);
    for (const id of recentConvs(store.wsId)) {
      const ch = store.channel(id);
      const dm = store.me?.dms?.[id];
      // Gone, or no longer a place to go (a private channel nobody is left in): forgotten.
      if ((!ch && !dm) || !store.canAccess(id)) {
        if (!ch && !dm && id.startsWith('h_') && hostPending) continue; // left in the list for when its host answers
        forgetRecent(store.wsId, id);
        continue;
      }
      let leading = null;
      if (dm) {
        const others = dm.members.filter((u) => u !== store.uuid).map((u) => store.member(u));
        leading = others.length === 1 ? avatar(others[0], { size: 'xs', state: store.presenceOf(others[0].uuid) })
          : others.length ? groupAvatar(others, { size: 'xs' }) : avatar(store.member(store.uuid), { size: 'xs' });
        leading.classList.add('menu-avatar');
      }
      items.push({
        label: store.convTitle(id), icon: ch ? channelIcon(ch) : null, leading, checked: id === cur ? true : undefined,
        onSelect: () => navigate({ ws: store.wsId, conv: id, view: null }),
      });
    }
    if (items.length === 1) items.push({ label: 'Nothing yet', disabled: true, sub: 'Conversations you open show up here' });
    openMenu(anchor, items, { align: 'start', label: 'History' });
  }

  /** Swap the sidebar between the Home list and the pane the route asks for. */
  function showPane(kind) {
    if (kind === paneKind) return;
    pane?.destroy();
    pane = null;
    paneKind = kind;
    paneEl.replaceChildren();
    if (!kind) {
      paneEl.hidden = true;
      homeEl.hidden = false;
      return;
    }
    pane = kind === 'dms' ? createDmsPane() : createListView(kind, { pane: true });
    paneEl.append(pane.el);
    paneEl.hidden = false;
    homeEl.hidden = true;
  }

  function loadingMain() {
    return el('div.main', {}, el('div', { style: { padding: '20px', display: 'grid', gap: '12px' }, 'aria-busy': 'true' },
      el('div.skeleton', { style: { height: '20px', width: '40%' } }),
      ...Array.from({ length: 5 }, () => el('div.skeleton', { style: { height: '14px', width: `${45 + Math.random() * 40}%` } }))));
  }

  function closePanel(opener = null) {
    // Closed from within (its close button, Escape in the shortcuts list):
    // the keyboard goes to the conversation, not to the document. Not to
    // the message box under a finger: a tap on the panel's close button
    // puts the keyboard on it too (Chrome focuses a tapped button), and the
    // message box focused in its place brought the phone's keyboard up over
    // the conversation the thread had just given way to. On a touch screen
    // the keyboard goes to the column's first control that is not a text
    // box, as it does when a view takes the column (see settleMain).
    // `opener` is the control the panel was opened from, when the caller
    // knows it (the shortcuts list, see toggleShortcuts): the keyboard goes
    // back there while it still stands, as it does from a menu or a dialog.
    const inside = panelEl.contains(document.activeElement);
    panel?.destroy();
    panel = null;
    panelKey = null;
    panelEl.hidden = true;
    panelEl.replaceChildren();
    view?.renderHeader?.();
    if (!inside) return;
    if (handBack(opener)) return;
    const main = document.querySelector('.main') || document.body;
    const back = coarsePointer()
      ? focusables(main).find((n) => !/^(input|textarea)$/.test(n.localName))
      : document.querySelector('.main textarea') || focusables(main)[0];
    back?.focus({ preventScroll: true });
  }

  /**
   * The keyboard back on the control a panel was opened from, while it
   * stands (see closePanel): true when it took it. A button of a message's
   * hover bar is drawn only while its row is under the pointer or holds the
   * keyboard (see .msg-actions), and a browser will not focus a control that
   * is not drawn: with the keyboard in the panel the row held it no longer,
   * so the button was passed over as gone and the keyboard went to the
   * column's first text box instead, which over the Threads view is a card's
   * reply box. The row takes it first, which draws the bar, and the button
   * takes it from there, as the message list and the cards hand it on.
   */
  function handBack(control) {
    if (!(control instanceof HTMLElement) || !control.isConnected) return false;
    const drawn = () => control.getClientRects().length > 0 && !control.closest('[hidden]');
    const row = control.closest('.msg');
    if (!drawn() && row && row !== control) row.focus({ preventScroll: true });
    if (!drawn()) return false;
    control.focus({ preventScroll: true });
    return document.activeElement === control;
  }

  const panelOpen = () => !panelEl.hidden;

  /**
   * Cmd/Ctrl+/ shows the shortcut list in the side panel;
   * again hides it. Where the keyboard was when the list was asked for (a
   * row of the Threads view, a card's Open thread, a message of the
   * conversation), for it to go back there when the list is closed from
   * within (see closeShortcuts): left to the panel's own rule, the keyboard
   * went to the column's first text box, which over the Threads view is the
   * first card's reply box, and the reader who had been arrowing along the
   * cards found themselves typing a reply into a thread they had not picked.
   */
  let shortcutsOpener = null;
  function toggleShortcuts() {
    if (panelKey === 'shortcuts') {
      closeShortcuts();
      return;
    }
    const from = document.activeElement;
    shortcutsOpener = from instanceof HTMLElement && from !== document.body && !panelEl.contains(from) ? from : null;
    panel?.destroy();
    panelKey = 'shortcuts';
    panelEl.hidden = false;
    panelEl.setAttribute('aria-label', 'Keyboard shortcuts');
    panel = renderShortcutsPanel(panelEl, { onClose: closeShortcuts });
    view?.renderHeader?.();
  }

  /**
   * The shortcut list closed from within (its X, Escape, Cmd+/ or Cmd+.
   * again). Opened over a thread, it took the thread panel's place while the
   * route kept the thread; the route is drawn again, so the thread comes
   * back where it stood.
   */
  function closeShortcuts() {
    // Back to the control the list was opened from while it stands (see
    // toggleShortcuts); else the panel's own rule, the conversation's box.
    const back = shortcutsOpener;
    shortcutsOpener = null;
    closePanel(back);
    if (parseHash(location.hash).thread != null) route();
  }

  // The bootstrap in flight for the current workspace, so a second route()
  // for the same workspace can wait for it.
  let opening = null;

  async function route() {
    closeMenu();
    const startHash = location.hash;
    const r = parseHash(startHash);

    if (r.name === 'join') {
      await handleJoin(r.server, r.code);
      return;
    }
    if (r.name === 'connect') {
      await handleConnect(r.server, r.code);
      return;
    }

    if (r.name === 'home') {
      const last = localStorage.getItem(LAST_WS_KEY);
      const target = store.workspaces.find((w) => w.id === last) || store.workspaces[0];
      if (target) {
        navigate({ ws: target.id }, { replace: true });
        return;
      }
      // No workspace: empty home plus onboarding, once.
      currentWs = null;
      store.closeWorkspace();
      shell.classList.add('show-sidebar');
      showPane(null);
      closePanel();
      view?.destroy();
      view = null;
      viewConv = null;
      searchView?.destroy();
      searchView = null;
      listView?.destroy();
      listView = null;
      listKind = null;
      showMain(homeEmpty());
      shell.classList.remove('show-sidebar');
      sidebarEl.hidden = true;
      // Not on top of another dialog, and not twice.
      if (shouldOnboard() && !onboardingOpen && !document.querySelector('.modal-root')) {
        onboardingOpen = true;
        openOnboarding({ onClose: () => { onboardingOpen = false; } });
      }
      return;
    }

    sidebarEl.hidden = false;

    // Workspace switch. `retried`: the keyboard was in the column the wait
    // replaced (on the Try again of a load that failed) and the load has
    // come; the wait left it on the page, and what takes the column takes
    // it from there, as it would have from the column itself (see hand).
    let retried = false;
    if (r.ws !== currentWs) {
      closeAllModals();
      closePanel();
      // The sidebar pane too: one of the same kind on both sides of the
      // switch (Back and Forward between two workspaces' Later routes, a
      // pasted link) was kept as it was, listing the old workspace's saved
      // items and reminders under the new one's name, each opening onto a
      // conversation that is not here. The route below draws it afresh.
      showPane(null);
      view?.destroy();
      view = null;
      viewConv = null;
      searchView?.destroy();
      searchView = null;
      listView?.destroy();
      listView = null;
      listKind = null;
      clearAttachmentCache();
      clearAvatarCache();
      currentWs = r.ws;
      // Whether the keyboard is in the column the wait replaces (on the Try
      // again of a load that failed): the wait has nothing to hold it, so it
      // fell to the page, and a load that failed again brought the words
      // back with nobody on the button. It comes back to the button then;
      // and a load that comes hands it on (see retried).
      const retrying = mainSlot.contains(document.activeElement);
      showMain(loadingMain());
      try {
        opening = store.openWorkspace(r.ws);
        // The store has let the workspace left behind go by now, without a
        // word (its events come with the one being opened): the title, which
        // follows those events, would keep the old workspace's count through
        // the wait, and for good over the failure page below.
        updateTitle();
        await opening;
        // Only while this is still the workspace being opened: switched away
        // meanwhile, the store lets the answer go (null) and so must this,
        // or the bootstrap of the workspace left, landing after the one
        // switched to, would make it the one the app opens to next time.
        if (currentWs === r.ws) localStorage.setItem(LAST_WS_KEY, r.ws);
        retried = retrying;
      } catch (e) {
        if (currentWs !== r.ws) return;
        currentWs = null;
        // The worker's own word, not a page the platform answered with in
        // its place (a firewall's 403; see the store's isPlatformPage), which
        // is a failure to reach it, said below as one.
        if (e instanceof ApiError && (e.status === 403 || e.status === 404) && e.code !== 'no_backend' && !isPlatformPage(e)) {
          // Already said, and already being forgotten, on the worker's
          // earlier word (see store.on('error')): home follows once that
          // write lands, and nothing is said a second time in other words.
          if (r.ws === forgetting) return;
          toast('You do not have access to that workspace', { icon: 'alert' });
          await store.forgetWorkspace(r.ws).catch(() => {});
          // Home once the workspace is out of the list, unless the reader has
          // opened another meanwhile (as the worker's own word of lost access
          // has it; see store.on('error')): forgetting is a write to their
          // account, and sent home after it they were taken from the
          // conversation they had just opened there to that workspace's
          // first channel.
          if (currentWs === null) navigate('#/', { replace: true });
        } else {
          const page = errorMain(e, () => route());
          showMain(page);
          // No workspace is open behind this page: the title says so (see above).
          updateTitle();
          if (retrying) page.querySelector('button')?.focus({ preventScroll: true });
        }
        return;
      }
      // Navigated elsewhere while loading (another workspace, or another
      // conversation in this one): the route() call for that hash renders it.
      if (location.hash !== startHash) return;
    } else if (!store.ws && opening) {
      // The same workspace, still opening (a notification click routed while
      // the bootstrap runs): wait for it rather than draw a conversation the
      // store cannot yet find, then give way to the route that started it
      // if the hash moved on, or to its error view if it failed.
      await opening.catch(() => {});
      if (location.hash !== startHash || !store.ws) return;
    }

    // Search results take the main column in place of a conversation.
    // Whether the keyboard is in a pane about to be swapped or taken down
    // (the pane's own Back to the channel list, on a phone; on a desk the
    // shortcut that puts another pane in its place), asked before showPane
    // leaves it on the page: the list that takes the pane's place gets it,
    // as the list gets it from a conversation's column (see focusSidebar).
    // Or in the sidebar's own list, about to be hidden under a pane (Shift+Cmd+D
    // pressed on a channel row while arrowing through the list, on a phone the
    // list's Later row): hidden, the row let the keyboard fall to the page, and
    // the next Tab started over from the top of the window.
    const nextPane = PANE_VIEWS.includes(r.view) ? r.view : null;
    const paneHand = nextPane !== paneKind && (paneEl.contains(document.activeElement) || (!!nextPane && homeEl.contains(document.activeElement)));
    // On a phone the sidebar's list, or the pane in its place, is the screen
    // until a conversation opens, and then it is hidden under the
    // conversation: whether the keyboard is on one of its rows (the row just
    // pressed, or reached by the arrows), asked before the layout hides it,
    // which leaves the keyboard on the page (see the conversation below).
    const sideHand = matchMedia('(max-width: 719px)').matches && sidebarEl.contains(document.activeElement);
    showPane(nextPane);
    // A details dialog belongs to a conversation route; leaving for a view or a search closes it.
    if (details && r.name !== 'conversation') {
      const d = details;
      details = null;
      d.close();
    }

    if (r.name === 'search') {
      shell.classList.remove('show-sidebar');
      closePanel();
      view?.destroy();
      view = null;
      viewConv = null;
      // The view in the column too (Files, the Directory, Threads, Drafts &
      // sent): the results take its place, and the route back to that view
      // draws it afresh only when none stands (see below). Left standing,
      // its element out of the column, the way back found it there and drew
      // nothing, so the results page stayed in the column, dead, after the
      // reader had left it for the view they came from.
      listView?.destroy();
      listView = null;
      listKind = null;
      if (!searchView) {
        searchView = createSearchView(r.query, {
          onQuery: (q) => navigate({ ws: r.ws, query: q }, { replace: true }),
        });
        showMain(searchView.el);
        searchView.lastHash = location.hash;
      } else {
        searchView.setQuery(r.query);
      }
      searchView.lastHash = location.hash;
      return;
    }
    if (searchView) {
      const q = parseHash(searchView.lastHash || '').query;
      if (q) noteSearch(r.ws, q);
      searchView.destroy();
      searchView = null;
    }
    if (r.name === 'view') {
      // The conversation being left, and whether the keyboard goes with its
      // column, or went with the pane just swapped (see focusSidebar), or
      // was on the Try again the load just answered (see retried), taken
      // before the teardown.
      const left = viewConv;
      const hand = keyboardInColumn() || paneHand || retried;
      closePanel();
      view?.destroy();
      view = null;
      viewConv = null;
      if (PANE_VIEWS.includes(r.view)) {
        // The pane has the list; the main column waits for a pick (and on a
        // phone the pane is the screen).
        listView?.destroy();
        listView = null;
        listKind = null;
        const copy = {
          dms: ['Pick a conversation', 'Choose someone from the list to read and reply.', 'messageText'],
          activity: ['Pick something from Activity', 'Mentions, replies, and reactions open here.', 'bell'],
          later: ['Pick a saved item', 'Saved messages and reminders open here.', 'bookmark'],
        }[r.view];
        showMain(placeholderMain(...copy));
        shell.classList.toggle('show-sidebar', matchMedia('(max-width: 719px)').matches);
        if (hand) focusSidebar(left);
        return;
      }
      // On a phone the view takes the whole screen, and the sidebar's list,
      // with the keyboard on the row just pressed (Threads, Drafts & sent,
      // Directory), is hidden under it: asked before the layout hides it,
      // which leaves the keyboard on the page.
      const sideHand = matchMedia('(max-width: 719px)').matches && sidebarEl.contains(document.activeElement);
      shell.classList.remove('show-sidebar');
      if (!listView || listKind !== r.view) {
        listView?.destroy();
        listKind = r.view;
        listView = r.view === 'files' ? createFilesPage() : r.view === 'directory' ? createDirectoryView() : createListView(r.view);
        showMain(listView.el);
        // The keyboard that was in the column this view has taken goes into
        // the view (see settleMain), as it goes to the sidebar's list when
        // that takes the column; so does one from the list the view hid.
        if (hand || sideHand) settleMain(listView.el);
      }
      return;
    }
    if (listView) {
      listView.destroy();
      listView = null;
      listKind = null;
    }

    // Conversation.
    if (!r.conv) {
      const mobile = matchMedia('(max-width: 719px)').matches;
      if (mobile) {
        // Back to the channel list: the keyboard, when it was in the
        // conversation's column, or in the pane the list has just taken the
        // place of (its own Back), or on the Try again the load just
        // answered (see retried), goes to the list with it (see focusSidebar).
        const left = viewConv;
        const hand = keyboardInColumn() || paneHand || retried;
        shell.classList.add('show-sidebar');
        closePanel();
        view?.destroy();
        view = null;
        viewConv = null;
        showMain(placeholderMain());
        if (hand) focusSidebar(left);
        return;
      }
      const joined = store.joinedChannels();
      const first = joined.find((c) => c.name === 'general' && !c.archived) || joined.find((c) => c.def && !c.archived) || joined.find((c) => !c.archived) || joined[0] || store.dms()[0];
      if (first) {
        navigate({ ws: r.ws, conv: first.id }, { replace: true });
        return;
      }
      shell.classList.remove('show-sidebar');
      closePanel();
      showMain(placeholderMain('No conversations yet'));
      return;
    }

    shell.classList.remove('show-sidebar');
    // A linked message belongs to the thread when one is open, else to the conversation.
    const mainFocus = r.thread == null ? r.message : null;
    const tab = r.files ? 'files' : 'messages';
    // Kept only while it is on the page: a join link followed from a
    // conversation puts the loading skeleton in the view's place without
    // tearing the view down, and an invite refused (or one to a workspace
    // the reader is already in) leads back to that very conversation, which
    // would otherwise pass for still being on screen and leave the
    // skeleton there for good.
    if (viewConv !== r.conv || !view || !view.el.isConnected) {
      view?.destroy();
      viewConv = r.conv;
      viewMessage = mainFocus;
      view = createConversationView(r.conv, {
        onOpenThread: (seq) => navigate({ ws: r.ws, conv: r.conv, thread: seq }),
        onOpenDetails: () => navigate({ ws: r.ws, conv: r.conv, details: true }),
        focusSeq: mainFocus,
        tab,
      });
      showMain(view.el);
      store.setOpen(r.conv, r.thread);
      if (store.canAccess(r.conv)) noteRecent(store.wsId, r.conv);
    } else if (view.tab() !== tab) {
      view.setTab(tab);
      if (mainFocus != null) {
        viewMessage = mainFocus;
        view.jumpTo(mainFocus);
      }
    } else if (mainFocus != null && mainFocus !== viewMessage) {
      viewMessage = mainFocus;
      view.jumpTo(mainFocus);
    } else if (mainFocus == null) {
      viewMessage = null;
    }
    // The keyboard was on a row of the pane the route has just taken down
    // for the channel list (Alt+Down or Alt+Up pressed on a row of the
    // Direct messages list, which open the next conversation on its own,
    // without the pane): it goes to the list that took the pane's place, on
    // the row of the conversation now open, as it goes when a pane gives
    // way to the list for a pane view or a phone's Back (see focusSidebar).
    // On a phone the conversation has taken the screen and the list is
    // hidden under it: the keyboard goes into the conversation's column
    // instead (see settleMain). Left alone, the row's removal dropped it on
    // the page, and the next Tab started over from the top of the window.
    // The row is sought once the list has been drawn for this route: the
    // list redraws on the hash a moment after this runs (see renderSidebar,
    // whose redraw is queued before the route's own handler runs), and until
    // then its rows are the last route's, the conversation now open not yet
    // marked as open; in a folded section that keeps only its open and
    // unread rows in view, the row was still hidden when it was sought, and
    // the keyboard went to the filter box instead. The step this hands the
    // keyboard on for is the shortcut's; the row it lands on holds the
    // keyboard by then, as it does when the list is drawn before the route.
    if (paneHand) {
      if (matchMedia('(max-width: 719px)').matches) settleMain(view.el);
      else queueMicrotask(() => { if (parseHash(location.hash).conv === r.conv) focusSidebar(r.conv); });
    } else if (sideHand) {
      // A conversation opened on a phone from a row of the list or of the
      // pane (pressed, or Enter on it), which the conversation now hides:
      // the keyboard goes into the conversation's column, as it does when a
      // view takes the screen from a row (see the views above, sideHand),
      // rather than staying on a row the layout no longer shows, from where
      // a browser drops it to the page and the next Tab starts over from the
      // top of the window. On a desk the list stays beside the conversation,
      // and the row keeps the keyboard as before.
      settleMain(view.el);
    }

    // A conversation that cannot be opened has no details to offer (a private
    // channel nobody is left in, listed to admins only to be deleted): the
    // request is dropped from the route rather than a dialog drawn whose
    // every setting the worker refuses.
    if (r.details && !store.canAccess(r.conv)) {
      navigate({ ws: r.ws, conv: r.conv, files: r.files }, { replace: true });
      return;
    }
    // Details: a dialog over the conversation; its route keeps
    // it shareable and lets Back close it.
    if (r.details && details?.conv !== r.conv) {
      details?.close();
      const conv = r.conv;
      details = {
        conv,
        close: openDetailsDialog(conv, {
          onClose: () => {
            if (details?.conv !== conv) return;
            details = null;
            const now = parseHash(location.hash);
            if (now.details && now.conv === conv) navigate({ ws: now.ws, conv, files: now.files }, { replace: true });
          },
        }).close,
      };
    } else if (!r.details && details) {
      const d = details;
      details = null;
      d.close();
    }

    // Panel: threads.
    const key = r.thread != null ? `t:${r.conv}:${r.thread}` : null;
    const threadFocus = r.thread != null ? r.message : null;
    // The shortcut list is not a route: it stays while conversations change.
    if (key !== panelKey && !(panelKey === 'shortcuts' && key === null)) {
      if (!key) {
        // Every way of closing a thread (its X, Escape, Cmd+.) comes through
        // here: closed from within, the keyboard goes to the conversation.
        closePanel();
        panelMessage = null;
      } else {
        panel?.destroy();
        panel = null;
        panelKey = key;
        panelMessage = threadFocus;
        panelEl.replaceChildren();
        panelEl.hidden = false;
        panelEl.setAttribute('aria-label', 'Thread');
        const onClose = () => navigate({ ws: r.ws, conv: r.conv });
        panel = renderThreadPanel(panelEl, { convId: r.conv, seq: r.thread, focusSeq: threadFocus, onClose });
        view.renderHeader();
      }
    } else if (threadFocus != null && threadFocus !== panelMessage) {
      panelMessage = threadFocus;
      panel?.jumpTo?.(threadFocus);
    } else if (threadFocus == null) {
      // The route dropped its message: the same permalink opened again is news again.
      panelMessage = null;
    }
    store.setOpen(r.conv, r.thread);
  }

  function errorMain(e, retry) {
    return el('div.main', {}, el('div.empty', { style: { flex: 1, justifyContent: 'center' } },
      el('div.empty-icon', { html: icon('wifiOff', 24) }),
      el('h1', {}, 'Could not load the workspace'), // the page's heading (see placeholderMain)
      el('p', {}, e?.code === 'no_backend' ? 'No Teamchat server answers at this workspace\u2019s address. Its owner may have removed it.' : e?.code === 'bad_ref' ? 'That link does not point at a workspace.' : e.message),
      el('button.btn.mt', { type: 'button', onclick: retry }, 'Try again')));
  }

  async function handleJoin(server, raw) {
    const code = normalizeInviteCode(raw);
    // The wait takes the screen: on a phone the channel list may be the
    // screen when the link is followed (pasted into the address bar of the
    // tab, which changes only the fragment and reloads nothing), and the
    // list, kept in front, hid the skeleton, so nothing said the invite was
    // being taken up until the workspace opened seconds later. The route the
    // join leads to lays the screen out afresh.
    shell.classList.remove('show-sidebar');
    showMain(loadingMain());
    // Links without a server come from the single-worker era; they only
    // resolve when a shared worker is configured.
    const target = server || (SHARED_WORKER_URL ? serverKeyOf(SHARED_WORKER_URL) : null);
    if (!code || !target) {
      toast(!code ? 'That invite link is not valid' : 'That invite link is from an older version of Teamchat. Ask for a new one.', { icon: 'alert', duration: 6000 });
      navigate('#/', { replace: true });
      return;
    }
    try {
      const res = await store.join(target, code);
      if (res.movedTo) {
        // An old invite link: the workspace lives elsewhere now.
        toast(`${res.workspace.name} moved to another server; opening it there`, { duration: 6000 });
        navigate({ ws: res.movedTo }, { replace: true });
        return;
      }
      // A channel invite leads to its channel: someone already in the
      // workspace is put in it (a guest's one way into a second channel), and
      // lands there rather than wherever they last were. Already in the
      // channel itself (a member of a connected workspace opening a guest
      // link for the shared channel they are in), the toast names the
      // channel: they are in it, not in the workspace.
      toast(res.promoted ? `You are now a full member of ${res.workspace.name}`
        : res.already ? (res.joined ? `You are now in #${res.channel.name} on ${res.workspace.name}`
          : res.channel ? `You are already in #${res.channel.name} on ${res.workspace.name}` : `You are already in ${res.workspace.name}`)
        : res.guest ? `Welcome to ${res.workspace.name}. You are a guest: you see the channel you were invited to.` : `Welcome to ${res.workspace.name}`, { duration: res.guest ? 6000 : undefined });
      navigate({ ws: res.workspace.id, conv: res.channel?.id }, { replace: true });
    } catch (e) {
      const msg = e.code === 'invite_not_found' ? 'That invite link is not valid or has expired. Ask for a new one.'
        : e.code === 'no_backend' || e.code === 'network' ? 'The workspace server behind this invite is not reachable right now.'
          : e.message || 'Could not join';
      toast(msg, { icon: 'alert', duration: 6000 });
      navigate('#/', { replace: true });
    }
  }

  /**
   * A share link: another workspace's admin is offering one of their
   * channels. The dialog says what it is and asks which of the user's
   * workspaces to add it to; the route is replaced so Back does not offer
   * it again.
   */
  async function handleConnect(server, raw) {
    const code = normalizeInviteCode(raw);
    const last = localStorage.getItem(LAST_WS_KEY);
    const home = store.workspaces.find((w) => w.id === last) || store.workspaces[0];
    if (!code || !server) {
      toast('That share link is not valid', { icon: 'alert', duration: 6000 });
      navigate('#/', { replace: true });
      return;
    }
    // The dialog sits over whatever was open (the last workspace, or the empty home).
    navigate(home ? { ws: home.id } : '#/', { replace: true });
    acceptConnectDialog({ server, code });
  }

  /* ---- store events ---------------------------------------------------- */

  // Puter could not say who is asking: the sign-in behind every request
  // (a token the worker asks Puter about on each one) revoked by a sign-out
  // elsewhere, lapsed, or Puter not answering the worker for a moment. The
  // worker answers each poll and each send 401, and nothing on the screen
  // said why nothing arrived any more and every send came back "not sent"
  // with "Your Puter session is not valid". Said once, kept until acted on
  // (a reload finds the account out of reach and leads to the sign-in page;
  // see main.js boot), or put away: a moment's failure at Puter mends
  // itself, and the words allow for it.
  let signInSaid = false;
  store.on('error', (e) => {
    if (signInSaid || !(e instanceof ApiError && e.status === 401)) return;
    signInSaid = true;
    toast('Puter could not confirm your sign-in, so nothing is being sent or received. If this keeps up, sign in again.', {
      icon: 'alert', duration: Infinity, dismissible: true,
      action: { label: 'Sign in again', onClick: () => location.reload() },
    });
  });

  // The workspace being forgotten on the worker's word that the reader is no
  // longer a member (below), while the write to their account is out: a route
  // to it meanwhile (a row of its sidebar pressed) is refused the same way,
  // and is not told of again (see route).
  let forgetting = null;
  store.on('error', (e) => {
    // Lost access is the worker saying so; a bare 404 is the address not
    // answering (a worker being redeployed), which the next poll retries,
    // and so is a page the platform answered with in the worker's place (a
    // firewall's 403; see the store's isPlatformPage).
    if (e instanceof ApiError && (e.status === 403 || e.status === 404) && e.code !== 'no_backend' && !isPlatformPage(e) && currentWs) {
      toast('You no longer have access to this workspace', { icon: 'alert' });
      const gone = currentWs;
      currentWs = null;
      forgetting = gone;
      // Home once the workspace is out of the list, unless the reader has
      // opened another meanwhile: forgetting is a write to their account, and
      // sent home after it they were taken from the conversation they had
      // just opened there to that workspace's first channel.
      store.forgetWorkspace(gone).catch(() => {}).then(() => {
        if (forgetting === gone) forgetting = null;
        if (currentWs === null) navigate('#/', { replace: true });
      });
    }
  });

  store.on('notice', (msg) => toast(msg, { icon: 'sparkle', duration: 5000 }));
  store.on('huddle-error', (e) => toast(e?.message || 'Something went wrong with the huddle', { icon: 'alert', duration: 6000 }));

  /**
   * A huddle started in a direct message the user is in is a call: a toast
   * with Join while the tab is in view, a notification when it is not, under
   * the conversation's own notification setting. A channel's huddle only
   * marks the row and the header; nobody is rung for it.
   */
  store.on('huddle-started', (list) => {
    for (const { conv, by } of list) {
      // By kind as well as by the member document: a huddle in a brand-new
      // direct message arrives in the same poll as the DM's own record, and
      // this event fires before the refresh that lists it (the same
      // ordering the incoming announcer handles; see convKind) — the one
      // call in a conversation the document does not know yet must still
      // ring. A channel huddle rings nobody either way.
      if (!store.me?.dms?.[conv] && store.convKind(conv) !== 'dm') continue;
      const from = store.member(by);
      const title = store.convTitle(conv);
      const setting = store.notifySetting(conv);
      if (setting.mute || setting.level === 'nothing') continue;
      if (document.hidden) {
        // A call is addressed at its recipients the way a mention is (the
        // worker pushes it as one): a direct message set to "Mentions only"
        // still rings — the gate above already honored mute and "Nothing".
        maybeNotify({ event: 'mention', conv, kind: 'dm', title: from.name, body: 'started a huddle', route: { ws: store.wsId, conv } });
      } else if (!store.huddle) {
        // A call rings: the toast alone is easy to miss with the eyes elsewhere.
        if (store.profile?.prefs?.sound !== false && !store.notificationsPaused()) playNotificationSound();
        // The call's workspace, as it stood when the toast came: the toast
        // stands twelve seconds, and the reader may have opened another
        // workspace meanwhile, where a conversation of the same id (a direct
        // message between the same two people) is another conversation
        // altogether. Join then goes back to the call, as a click on the
        // banner does, rather than starting a huddle of its own there.
        const ws = store.wsId;
        toast(`${from.name} started a huddle in ${title}`, {
          icon: 'headphones', duration: 12_000,
          action: { label: 'Join', onClick: () => { if (store.wsId === ws) joinHuddleFlow(conv); else navigate({ ws, conv }); } },
        });
      }
    }
  });

  // The owner's one sharing grant (EV_GRANT), which members' live updates and
  // pushes both depend on, asked for on its own the first time an owner opens
  // a workspace with someone in it to share with: Puter's dialog straight
  // away (on a website, after Puter's own Continue prompt), no toast first.
  // Only the worker account's own owner is asked (GET /api/server's `owner`):
  // on a shared worker a workspace's creator may be someone else, with no
  // namespace there to share. A refusal is remembered (prefs.evConsent);
  // Workspace settings keeps the switch. An inconclusive look (a GET that
  // failed) is retried on a later 'workspace' emit, at most once a minute.
  let evConsentAskedFor = null; // the workspace whose answer was definite
  let evConsentTried = null; // { ws, at } of the last look
  store.on('workspace', () => { maybeAskEventsConsent().catch(() => {}); });

  async function maybeAskEventsConsent() {
    const wsId = store.wsId;
    const ws = store.ws;
    if (!wsId || evConsentAskedFor === wsId || !ws || ws.sample) return;
    if (typeof puter?.perms?.check !== 'function') return;
    // Nobody to share with yet: someone joining emits 'workspace' again.
    if (!Object.entries(ws.members || {}).some(([u, m]) => u !== store.uuid && !m?.gone && !m?.sample)) return;
    if (evConsentTried?.ws === wsId && Date.now() - evConsentTried.at < EV_CONSENT_RECHECK_MS) return;
    evConsentTried = { ws: wsId, at: Date.now() };
    const url = parseRef(wsId)?.url;
    if (!url) return;
    let info;
    let held;
    try {
      info = await api.server(url);
      const events = info?.owner ? info.events : null;
      // Not this worker's owner, already proven, or a refusal no consent lifts.
      if (!events || events.delegated || store.appUid() !== events.appUid
        || (events.why !== 'unknown' && events.why !== 'events_kv_handle_not_delegated')) {
        evConsentAskedFor = wsId;
        return;
      }
      held = await puter.perms.check('kvShare', EV_GRANT);
    } catch {
      return;
    }
    if (store.wsId !== wsId) return;
    evConsentAskedFor = wsId;
    if (!held) {
      if (store.profile?.prefs?.evConsent === 'declined') return;
      if (!(await puter.perms.request('kvShare', EV_GRANT).catch(() => false))) {
        store.updatePrefs({ evConsent: 'declined' }).catch(() => {});
        return;
      }
    } else if (info.events.why === 'unknown') {
      return; // granted, and no refusal cached on the worker to lift
    }
    // The worker caches a refusal for half an hour; this lifts it now.
    await api.updateServer(url, { events: true }).catch(() => {});
    if (store.profile?.prefs?.evConsent === 'declined') store.updatePrefs({ evConsent: null }).catch(() => {});
    store.refreshWorkspace().catch(() => {});
  }

  /**
   * The conversation a focused, visible window of this browser has on
   * screen, advertised to its other tabs: each tab's own viewing() check
   * knows only itself, so without this a hidden duplicate tab (or the tab
   * beside the installed window) dinged for every message in the very
   * conversation being read. The record is retracted when this window stops
   * showing it and expires on its own in 15s (kept fresh by the activity
   * events a watched workspace emits) in case a tab dies without saying so
   * — going stale errs toward chiming, never toward silence.
   */
  const VIEWING_KEY = 'teamchat:viewing';
  const tabId = Math.random().toString(36).slice(2);
  let advertised = { conv: undefined, thread: undefined, at: 0 };
  function advertiseViewing() {
    try {
      if (document.hidden || !document.hasFocus()) {
        if (advertised.at) {
          advertised = { conv: undefined, thread: undefined, at: 0 };
          const v = JSON.parse(localStorage.getItem(VIEWING_KEY) || 'null');
          if (v?.tab === tabId) localStorage.removeItem(VIEWING_KEY);
        }
        return;
      }
      const r = parseHash(location.hash);
      const next = { conv: r.conv || null, thread: r.thread || null, at: Date.now() };
      if (next.conv === advertised.conv && next.thread === advertised.thread && next.at - advertised.at < 5000) return;
      advertised = next;
      localStorage.setItem(VIEWING_KEY, JSON.stringify({ tab: tabId, ...next }));
    } catch { /* storage unavailable: tabs fall back to their own view */ }
  }
  window.addEventListener('focus', advertiseViewing);
  window.addEventListener('blur', advertiseViewing);
  window.addEventListener('pagehide', advertiseViewing);
  document.addEventListener('visibilitychange', advertiseViewing);
  window.addEventListener('hashchange', advertiseViewing);
  store.on('activity', advertiseViewing);
  advertiseViewing();

  /**
   * The in-app chime: the global switches, pauses and quiet hours, then the
   * conversation's own setting. Banners are Puter's, sent by the workspace
   * worker (see sendPushes). The chime also plays with the tab in view when
   * the news is from a conversation other than the open one — never for
   * what is already on screen, here or in another tab of this browser (see
   * advertiseViewing).
   */
  function maybeNotify({ event, conv, kind, title, body, seq, messageConv, route: target, onlyRead = false }) {
    const prefs = store.profile?.prefs || {};
    const sound = prefs.sound !== false;
    if (!sound || store.notificationsPaused()) return;
    if (!shouldNotify({ event, setting: store.notifySetting(conv), kind })) return;
    const shown = target || { ws: store.wsId, conv };
    const viewing = () => {
      const r = parseHash(location.hash);
      return r.conv === shown.conv && (!shown.thread || r.thread === shown.thread);
    };
    // Another tab of this browser, focused and visible, has the conversation
    // on screen: it stays silent for what it shows, and this tab does too.
    const viewedElsewhere = () => {
      try {
        const v = JSON.parse(localStorage.getItem(VIEWING_KEY) || 'null');
        return !!v && v.tab !== tabId && Date.now() - v.at < 15_000
          && v.conv === shown.conv && (!shown.thread || v.thread === shown.thread);
      } catch {
        return false;
      }
    };
    const fire = (text) => {
      // Named by the message, so two tabs of this browser ring once for it between them (see notify.js chimedAlready).
      if (sound && (document.hidden || !viewing()) && !viewedElsewhere()) playNotificationSound(seq ? { key: `${shown.ws}:${messageConv || conv}:${seq}` } : {});
    };
    if (!seq) {
      fire(body);
      return;
    }
    // The message itself, from the loaded window or one small read: for its
    // text when previews are on, and in any case for what it is — a system
    // line (someone joined, a huddle ended) is not a message to be told of,
    // and the New divider does not count it either.
    const at = messageConv || conv;
    const local = store.conv(at).messages.find((m) => m.seq === seq);
    const decide = (m) => {
      if (m?.kind === 'sys') return;
      // A line whose sender is the system says what it is only once read
      // (see onlyRead): with no line to go by, nothing is said, rather than
      // the words for a reminder over what may be a huddle's end.
      if (!m && onlyRead) return;
      // A reminder that came due, in the reader's own space: the note, or
      // the fact of it (the line itself starts "Reminder:", which the title says).
      if (m?.kind === 'rem') return fire(prefs.notifyPreview === false ? body : previewWords(m.text.replace(/^Reminder:?\s*/, ''), 120) || body);
      return fire(prefs.notifyPreview === false || !m?.text ? body : previewWords(m.text, 120));
    };
    if (local) decide(local);
    else {
      const host = store.hostOf(at);
      api.messages(host.ref, host.conv, { from: seq, to: seq }).then((d) => decide(d.messages[0])).catch(() => { if (!onlyRead) fire(body); });
    }
  }

  /**
   * The newest loaded message in a conversation, or in one of its loaded
   * threads, that mentions the user: what a mention notification previews
   * and opens. The channel's newest message is not it (a mention in a
   * thread does not move the channel; two messages may land in one poll),
   * and nothing is read for it: unloaded, the notification says only that
   * someone mentioned them and opens the conversation.
   */
  function latestMentionOf(conv) {
    const me = store.uuid;
    const named = (m) => m.mentions?.includes(me) || (!!m.broadcast && m.user !== me);
    let best = null;
    const consider = (id, m, route) => { if (named(m) && (!best || m.ts > best.ts)) best = { seq: m.seq, ts: m.ts, conv: id, route }; };
    for (const m of store.conv(conv).messages) consider(conv, m, { ws: store.wsId, conv, message: m.seq });
    for (const [id, c] of store.convs) {
      const t = parentOfThread(id);
      if (t && t.conv === conv) for (const m of c.messages) consider(id, m, { ws: store.wsId, conv, thread: t.seq, message: m.seq });
    }
    return best;
  }

  store.on('incoming', (list) => {
    const r = parseHash(location.hash);
    for (const item of list) {
      if (!document.hidden && r.conv === item.conv) continue;
      // By kind rather than by the member document: a new direct message's
      // first message arrives before the document that lists the
      // conversation (the same poll queues that refresh, after this event),
      // and it must ring like the direct message it is (see convKind).
      const isDm = store.convKind(item.conv) === 'dm';
      // A line the worker wrote with the system as its sender: a reminder
      // come due in the reader's own space, or the end of a huddle in a
      // direct message (the system writes that line too, with the huddle's
      // starter as its subject). Which it is, the line itself says once
      // read (see maybeNotify): a reminder is announced as one, a huddle's
      // end is not news to ring for, and a line that could not be read is
      // not called a reminder on a guess, as it was, with a chime for it.
      if (item.from === 'sys') {
        if (isDm) maybeNotify({ event: 'message', conv: item.conv, kind: 'dm', seq: item.seq, title: 'Reminder', body: 'A reminder came due', onlyRead: true });
        continue;
      }
      const from = store.member(item.from);
      if (isDm) {
        maybeNotify({ event: 'message', conv: item.conv, kind: 'dm', seq: item.seq, title: from.name, body: 'sent you a direct message' });
      } else if (store.channel(item.conv) && store.isJoined(item.conv)) {
        // Channels set to "all messages" hear every message, mentions
        // included; a channel set to mentions hears them from the member
        // doc refresh below.
        maybeNotify({ event: 'message', conv: item.conv, kind: 'channel', seq: item.seq, title: `${from.name} in ${store.convTitle(item.conv)}`, body: 'New message' });
      }
    }
  });

  // Mentions and followed-thread replies arrive through the member doc
  // refresh; notify on increases. The counts a workspace already carries
  // when it opens are history, shown as badges, so the first look at a
  // workspace only sets the baseline.
  let lastMentions = {};
  let lastThreads = {};
  let mentionsWs = null;
  // The hosts of shared channels whose counts were already in the baseline:
  // a host's mentions arrive with its link's first load, after the
  // workspace's own, and are history like them, not news.
  let knownHosts = new Set();
  store.on('workspace', () => {
    const cur = store.me?.mentions || {};
    const threads = store.me?.threads || {};
    const known = mentionsWs === store.wsId;
    mentionsWs = store.wsId;
    const hosts = new Set([...store.links.values()].filter((l) => l.loaded).map((l) => l.ref));
    const fresh = (conv) => { const { link } = store.hostOf(conv); return !!link && !knownHosts.has(link.ref); };
    for (const [conv, n] of Object.entries(known ? cur : {})) {
      if (n > (lastMentions[conv] || 0) && !fresh(conv)) {
        const kind = store.convKind(conv);
        const hit = latestMentionOf(conv);
        // A conversation heard at "all messages" (every direct message, a
        // channel set so) was announced when the message came in; the
        // mention in it is not a second notification. That only covers a
        // conversation-level message, though: the incoming path skips
        // thread conversations, so a mention inside one of this
        // conversation's threads is announced here — tagged by the parent,
        // the same tag the worker's push for it carries.
        const inThread = !!hit && hit.conv !== conv;
        if (!inThread && shouldNotify({ event: 'message', setting: store.notifySetting(conv), kind })) continue;
        maybeNotify({
          event: 'mention', conv, kind, seq: hit?.seq || null, messageConv: hit?.conv, route: hit?.route,
          title: `Mentioned in ${store.convTitle(conv)}`, body: 'Someone mentioned you',
        });
      }
    }
    for (const [thread, n] of Object.entries(known ? threads : {})) {
      if (n > (lastThreads[thread] || 0) && !fresh(thread)) {
        const parent = parentOfThread(thread);
        if (!parent) continue;
        maybeNotify({
          event: 'reply', conv: thread, kind: 'thread', seq: store.latestSeq(thread),
          title: `New reply in ${store.convTitle(parent.conv)}`, body: 'Someone replied in a thread you follow',
          route: { ws: store.wsId, conv: parent.conv, thread: parent.seq },
        });
      }
    }
    knownHosts = hosts;
    lastMentions = { ...cur };
    lastThreads = { ...threads };
    updateTitle();
  });
  store.on('activity', updateTitle);
  store.on('workspace', syncMoving);
  syncMoving();

  function updateTitle() {
    const n = store.ws ? store.totalBadge() : 0;
    const base = store.ws ? `${store.ws.name} | Teamchat` : 'Teamchat';
    document.title = n ? `(${n}) ${base}` : base;
    // The same count on the installed app's icon — the macOS Dock, the iOS
    // Home Screen — where the Badging API exists; zero clears it. This also
    // replaces the plain dot the service worker sets for a push that
    // arrives with no page running, which knows there is news but not how
    // much (see sw.js).
    try {
      navigator.setAppBadge?.(n).catch(() => {});
    } catch { /* the badge is a courtesy */ }
  }

  // Escape closes the side panel, the way it closes a dialog or a menu.
  // Anything that already handled the key (a menu, an open dialog, a message
  // being edited, the mention list) has called preventDefault, and a dialog
  // on top owns the key even before its own handler runs. During an IME
  // composition the key cancels the composition and nothing more: the
  // composer does not claim it, so it reached here from the thread's own
  // reply box and closed the thread under the word being typed.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.shiftKey || composing(e)) return;
    if (!panelOpen() || document.querySelector('.modal-root:not(.closing)')) return;
    e.preventDefault();
    if (panelKey === 'shortcuts') {
      closeShortcuts();
      return;
    }
    const r = parseHash(location.hash);
    navigate({ ws: r.ws, conv: r.conv });
  });

  // Cmd/Ctrl+K puts the cursor in search from anywhere in a workspace: the
  // top bar's box on desktop, the search view's own on a phone.
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || composing(e)) return;
    if (!store.wsId || document.querySelector('.modal-root:not(.closing)')) return;
    e.preventDefault();
    // An open menu goes: the keyboard is leaving it for the box, and it does
    // not close on its own when focus moves away (a route closes it; this
    // does not route on desktop).
    closeMenu();
    if (!topbar.el.hidden && matchMedia('(min-width: 720px)').matches) topbar.focus();
    else if (searchView) searchView.focus();
    else navigate({ ws: store.wsId, query: '' });
  });

  installShortcuts({
    toggleShortcuts,
    closePanel: () => {
      if (!panelOpen()) return;
      if (panelKey === 'shortcuts') {
        closeShortcuts();
        return;
      }
      const r = parseHash(location.hash);
      if (r.thread != null) navigate({ ws: r.ws, conv: r.conv });
      else closePanel();
    },
    // Shift+Cmd+D, M or S: the pane in the sidebar's place. The pane asked
    // for already showing, with a conversation open beside it: the
    // conversation stays, as it does when the rail's own item is pressed
    // again (see rail.js go), and the keyboard goes to the conversation's
    // row in the pane, the list the shortcut asked for; the route the
    // shortcut used to set gave the conversation up for "Pick a
    // conversation", a press that asked for nothing new. On a phone the pane
    // is a screen of its own behind the conversation, and the shortcut
    // opens it as before.
    openPane: (kind) => {
      const r = parseHash(location.hash);
      if (railMode(r) === kind && r.conv && !matchMedia('(max-width: 719px)').matches) {
        focusSidebar(r.conv);
        return;
      }
      navigate({ ws: store.wsId, view: kind });
    },
  });

  // Layout mode changes (rotation, resize) can require re-routing (mobile list vs desktop redirect).
  const mq = matchMedia('(max-width: 719px)');
  mq.addEventListener('change', () => route());

  window.addEventListener('hashchange', route);
  route();
  topbar.sync();

  return { route };
}

export { buildHash };

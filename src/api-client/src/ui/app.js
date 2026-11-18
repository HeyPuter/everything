/**
 * Application shell: header, sidebar, tabs, the active editor, console and
 * status bar. Owns the open tabs, the active environment, script sandbox and
 * request sending, and hands views a small API (this object).
 */
import { h, fill, debounce, modKey, announce, shortcut, isMac } from '../lib/dom.js';
import { uid } from '../lib/ids.js';
import { request as newRequest, normalizeRequest, normalizeDraft, folder as newFolder, cloneWithNewIds, draftKey, sameDraft } from '../core/model.js';
import { displayUrl } from '../core/url.js';
import { websocketRequest } from '../core/websocket.js';
import { createResolver } from '../core/variables.js';
import { execute, scopesFor, resolveScriptRequest } from '../core/execute.js';
import { send as sendResolved, puterSockets, charsetOf } from '../core/send.js';
import { decodeText } from '../core/pretty.js';
import { CookieJar } from '../core/cookies.js';
import { icon } from './icons.js';
import { prefs, setTheme } from './prefs.js';
import { toast } from './toast.js';
import { menuButton, closeMenu } from './menu.js';
import { confirmDialog, openDialog, promptDialog } from './dialog.js';
import { refreshVarInputs } from './var-input.js';
import { refreshEditorVariables } from './code-editor.js';
import { Sidebar } from './sidebar.js';
import { TabBar } from './tabbar.js';
import { RequestView } from './request-view.js';
import { CollectionView } from './collection-view.js';
import { EnvironmentView } from './environment-view.js';
import { ConsolePanel } from './console-panel.js';
import { LazyView } from './lazy-view.js';

// Loaded on first use to keep startup small.
const dialogs = () => import('./dialogs.js');
const openImportDialog = (...a) => dialogs().then((m) => m.openImportDialog(...a));
const openSettingsDialog = (...a) => dialogs().then((m) => m.openSettingsDialog(...a));
const openShortcutsDialog = (...a) => dialogs().then((m) => m.openShortcutsDialog(...a));
const openSaveDialog = (...a) => dialogs().then((m) => m.openSaveDialog(...a));
const openCookiesDialog = (...a) => dialogs().then((m) => m.openCookiesDialog(...a));
const openExportDialog = (...a) => dialogs().then((m) => m.openExportDialog(...a));
const openPalette = (...a) => import('./palette.js').then((m) => m.openPalette(...a));
const RunnerView = LazyView(() => import('./runner-view.js').then((m) => m.RunnerView));
const WebSocketView = LazyView(() => import('./websocket-view.js').then((m) => m.WebSocketView));

/** Tab kinds that edit a draft copy of a saved item and need Save. */
export const DRAFT_KINDS = new Set(['request', 'websocket']);

/** Script sandbox, created on the first script run. */
function lazySandbox(options) {
  let instance = null;
  const get = () => (instance ||= import('../core/scripts/sandbox.js').then((m) => new m.ScriptSandbox(options)));
  return { run: async (message, opts) => (await get()).run(message, opts) };
}

const VIEW_FOR = () => ({ request: RequestView, websocket: WebSocketView, collection: CollectionView, folder: CollectionView, environment: EnvironmentView, runner: RunnerView });

export const REPO_URL = 'https://github.com/heyputer/everything';

/** The sidebar never grows past what leaves the editor this much room. */
const MIN_EDITOR_WIDTH = 480;
/** The request to send once sign-in reloads the app: { tabId, transport, at }. */
const SEND_AFTER_SIGN_IN = 'api-client:send-after-sign-in';



export class App {
  constructor(root, { ws, sync, shared = null, session, onSignIn, onSignOut }) {
    this.root = root;
    this.ws = ws;
    this.sync = sync;
    this.shared = shared;
    this.session = session;
    this.onSignIn = onSignIn;
    this.onSignOut = onSignOut;
    this.tabs = [];
    this.activeId = null;
    this.views = new Map();
    this.localVars = new Map();
    this.environmentId = null;
    this.picture = null;
    this.persistTabs = debounce(() => this.#saveTabs(), 400);
    this.persistCookies = debounce(() => this.ws.setMeta('cookies', this.cookieJar.toJSON()), 800);
  }

  // Startup ---------------------------------------------------------------

  async start() {
    const env = await this.ws.getMeta('activeEnvironment');
    this.environmentId = env && this.ws.getEnvironment(env) ? env : null;
    this.cookieJar = CookieJar.fromJSON((await this.ws.getMeta('cookies')) || []);
    this.sandbox = lazySandbox({ onSend: (req, options) => this.#scriptSend(req, options) });
    this.console = new ConsolePanel(this);
    this.sidebar = new Sidebar(this);
    this.tabbar = new TabBar(this);
    this.#build();
    await this.sidebar.load();
    await this.#restoreTabs();
    this.#sendAfterSignIn();
    this.ws.on('change', (e) => this.#onWorkspaceChange(e));
    this.ws.on('storage-error', (err) => this.#onStorageError(err));
    this.sync?.on('status', () => this.#renderSync());
    this.#renderSync();
    document.addEventListener('keydown', (e) => this.#onKey(e));
    window.addEventListener('focus', () => {
      this.sync?.pullIfStale();
      this.shared?.refreshIfStale();
    });
    window.addEventListener('unhandledrejection', (e) => {
      if (e.reason?.name !== 'ReadOnlyError') return;
      e.preventDefault();
      toast({ kind: 'warning', title: 'View only', text: `${e.reason.message} Duplicate it to make your own copy.` });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.#flushEdits();
        this.sync?.flush();
        this.shared?.flush();
      } else this.sync?.pullIfStale();
    });
    window.addEventListener('pagehide', () => {
      this.#flushEdits();
      this.sidebar.saveExpanded.flush();
    });
    window.addEventListener('beforeunload', (e) => {
      this.#flushEdits();
      const syncing = this.sync?.status === 'pending' || this.sync?.status === 'syncing';
      // Edits to a collection shared with you upload on their own schedule, apart from your sync.
      if (syncing || this.shared?.pending) {
        this.sync?.flush();
        this.shared?.flush();
        e.preventDefault();
      }
    });
    this.#loadPicture();
  }

  /** Writes edits still waiting on a debounce, before the page goes away. */
  #flushEdits() {
    for (const view of this.views.values()) {
      // A view that loads on demand forwards calls but not properties such as flush.
      const v = view.inner ?? view;
      v.persist?.flush?.();
      v.save?.flush?.();
    }
    this.persistTabs.flush();
    this.persistCookies.flush();
    this.ws.flushWrites();
  }

  #onStorageError(err) {
    // One notice per burst: a full disk fails every save until space is freed.
    if (Date.now() - (this.storageErrorAt || 0) < 10000) return;
    this.storageErrorAt = Date.now();
    console.error(err);
    const where = this.sync ? 'It is still saved to your Puter cloud.' : 'It will be lost when you close the app.';
    const cause = err?.name === 'QuotaExceededError' ? 'This browser is out of storage space.' : 'This browser refused to store it.';
    toast({ kind: 'error', title: 'Could not save on this device', text: `${cause} ${where}` });
  }

  #build() {
    this.sidebarResizer = h('div.resizer.vertical', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize sidebar', tabindex: '0' });
    // Not an <aside>: on phones it becomes a dialog, a role an <aside> may not take.
    this.sidebarEl = h('div.sidebar#sidebar', { role: 'complementary', 'aria-label': 'Sidebar' }, this.sidebar.el, this.sidebarResizer);
    // As a drawer on phones, Tab cycles within it.
    this.sidebarEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || this.sidebarEl.getAttribute('aria-modal') !== 'true') return;
      const stops = [...this.sidebarEl.querySelectorAll('a[href], button, input, [tabindex]')].filter((el) => el.tabIndex >= 0 && !el.disabled && el.checkVisibility?.() !== false);
      const [first, last] = [stops[0], stops.at(-1)];
      if (document.activeElement !== (e.shiftKey ? first : last)) return;
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    });
    // The tab panel of the open tabs; it shows the active tab's view.
    this.content = h('div.tab-content#tab-panel');
    this.rightPanel = h('aside.right-panel', {
      'aria-label': 'Code snippet',
      hidden: true,
      // Lying over the editor it is closed like a sheet.
      onkeydown: (e) => {
        if (e.key === 'Escape' && this.#rightPanelOverlays()) {
          e.stopPropagation();
          this.toggleRightPanel(this.rightPanelKind, false);
        }
      },
    });
    this.mainEl = h(
      'main.main#main',
      { tabindex: '-1' },
      this.tabbar.el,
      h('div.main-row', this.content, this.rightPanel),
      this.console.el,
    );
    this.scrim = h('div.scrim', { onclick: () => this.toggleSidebar(false) });
    this.shell = h(
      'div.shell',
      h('a.skip-link', { href: '#main', onclick: (e) => { e.preventDefault(); this.focusMain(); } }, 'Skip to editor'),
      this.#header(),
      h('div.body', this.#rail(), this.sidebarEl, this.mainEl),
      this.#statusbar(),
      this.scrim,
    );
    this.root.replaceChildren(this.shell, h('div#live-region.sr-only', { 'aria-live': 'polite', 'aria-atomic': 'true' }));
    // Wired once the shell is on the page, where the rail's width (part of what the sidebar must leave) can be measured.
    const sidebarMax = () => Math.min(520, innerWidth - this.railEl.offsetWidth - MIN_EDITOR_WIDTH);
    this.#wireResizer(this.sidebarResizer, 'sidebarWidth', 200, sidebarMax, (w) => this.shell.style.setProperty('--sidebar-w', `${w}px`));
    const mq = matchMedia('(max-width: 899px)');
    this.compact = mq.matches;
    this.toggleSidebar(this.compact ? false : prefs.get('sidebarOpen'), { save: false });
    mq.addEventListener?.('change', (e) => {
      this.compact = e.matches;
      this.compactPanel = null;
      this.toggleSidebar(e.matches ? false : prefs.get('sidebarOpen'), { save: false });
      this.#renderRightPanel();
    });
    this.console.setOpen(prefs.get('consoleOpen'));
    this.tabbar.render();
    this.renderEmpty();
  }

  #header() {
    this.menuBtn = h('button.icon-btn.appbar-menu', { type: 'button', 'aria-label': 'Open sidebar', 'aria-controls': 'sidebar', onclick: () => this.toggleSidebar() }, icon('menu', 18));
    const search = h(
      'button.appbar-search',
      { type: 'button', onclick: () => openPalette(this), 'aria-label': 'Search collections, requests and environments', 'aria-keyshortcuts': isMac ? 'Meta+K' : 'Control+K' },
      icon('search', 15),
      h('span.appbar-search-text', 'Search'),
      h('kbd', shortcut('Mod+K')),
    );
    this.syncEl = h('div.sync-indicator', { role: 'status' });
    this.accountEl = h('div.account');
    this.#renderAccount();
    const importBtn = h('button.btn.sm.appbar-import', { type: 'button', 'aria-label': 'Import', title: `Import (${shortcut('Mod+O')})`, onclick: () => openImportDialog(this) }, icon('import', 15), h('span', 'Import'));
    const settings = h('button.icon-btn', { type: 'button', 'aria-label': 'Settings', title: 'Settings', onclick: () => openSettingsDialog(this) }, icon('settings', 17));
    const theme = h('button.icon-btn', { type: 'button', 'aria-label': 'Theme', title: 'Theme' }, icon('sun', 17));
    menuButton(theme, () => [
      { heading: 'Theme' },
      { label: 'System', icon: 'monitor', checked: prefs.get('theme') === 'system', run: () => this.setTheme('system') },
      { label: 'Light', icon: 'sun', checked: prefs.get('theme') === 'light', run: () => this.setTheme('light') },
      { label: 'Dark', icon: 'moon', checked: prefs.get('theme') === 'dark', run: () => this.setTheme('dark') },
    ], { align: 'end', label: 'Theme' });
    return h(
      'header.appbar',
      this.menuBtn,
      h('div.appbar-brand', h('img', { src: './icon-192.png', alt: '', width: 22, height: 22 }), h('h1.appbar-title', 'API Client'), h('span.alpha-tag', { title: 'Early preview: features may change' }, 'Alpha')),
      h('div.appbar-center', search),
      h('div.appbar-actions', importBtn, this.syncEl, theme, settings, this.accountEl),
    );
  }

  #rail() {
    const item = (key, ic, label) =>
      h(
        'button.rail-item',
        { type: 'button', dataset: { key }, 'aria-pressed': 'false', onclick: () => this.showSection(key) },
        icon(ic, 18),
        h('span', label),
      );
    this.railEl = h(
      'nav.rail',
      { 'aria-label': 'Sidebar sections' },
      item('collections', 'collections', 'Collections'),
      item('environments', 'globe', 'Environments'),
      item('history', 'history', 'History'),
    );
    return this.railEl;
  }

  #statusbar() {
    const btn = (label, ic, onclick, extra = {}) => h('button.status-btn', { type: 'button', onclick, 'aria-label': label || null, title: label || null, ...extra }, icon(ic, 14), h('span.status-label', label));
    this.consoleBtn = btn('Console', 'terminal', () => this.console.toggle(), { 'aria-pressed': 'false', 'aria-controls': 'console', 'aria-keyshortcuts': 'Control+`' });
    this.consoleBadge = h('span.status-badge', { hidden: true });
    this.consoleBtn.append(this.consoleBadge);
    this.transportBtn = btn('', 'zap', null, { title: 'How requests are sent' });
    menuButton(this.transportBtn, () => this.#transportItems(), { side: 'top', align: 'end', label: 'Send requests through' });
    this.#renderTransport();
    this.layoutBtn = h('button.status-btn', { type: 'button', 'aria-label': 'Response layout', title: 'Response layout' }, icon(prefs.get('layout') === 'side' ? 'columns' : 'rows', 14));
    menuButton(this.layoutBtn, () => [
      { heading: 'Response pane' },
      { label: 'Below the request', icon: 'rows', checked: prefs.get('layout') !== 'side', run: () => this.setLayout('stacked') },
      { label: 'Beside the request', icon: 'columns', checked: prefs.get('layout') === 'side', run: () => this.setLayout('side') },
    ], { side: 'top', align: 'end', label: 'Response layout' });
    return h(
      'footer.statusbar',
      h(
        'div.status-left',
        h('button.status-btn.icon-only', { type: 'button', 'aria-label': 'Toggle sidebar', title: `Toggle sidebar (${shortcut('Mod+\\')})`, onclick: () => this.toggleSidebar() }, icon('panelLeft', 14)),
        this.consoleBtn,
        btn('Cookies', 'cookie', () => openCookiesDialog(this)),
      ),
      h('div.status-msg', { role: 'status', ref: (el) => (this.statusMsg = el) }),
      h(
        'div.status-right',
        this.transportBtn,
        this.layoutBtn,
        h('button.status-btn.icon-only', { type: 'button', 'aria-label': 'Keyboard shortcuts', title: 'Keyboard shortcuts', onclick: () => openShortcutsDialog() }, icon('keyboard', 14)),
        h('a.status-btn.icon-only.github-link', { href: REPO_URL, target: '_blank', rel: 'noopener', 'aria-label': 'Source code on GitHub', title: 'Source code on GitHub' }, icon('github', 14)),
      ),
    );
  }

  /** max may be a function, for limits that follow the window size; the saved size is kept for when it grows again. */
  #wireResizer(el, key, min, max, apply, axis = 'x', invert = false) {
    let start = 0;
    let startSize = 0;
    const limit = () => Math.max(min, typeof max === 'function' ? max() : max);
    const clamp = (size) => Math.min(limit(), Math.max(min, size));
    const show = (size) => {
      apply(size);
      el.setAttribute('aria-valuemax', String(Math.round(limit())));
      el.setAttribute('aria-valuenow', String(Math.round(size)));
    };
    const set = (size) => {
      show(size);
      prefs.set(key, size);
    };
    el.setAttribute('aria-valuemin', String(min));
    const onMove = (e) => {
      const d = (axis === 'x' ? e.clientX : e.clientY) - start;
      set(clamp(startSize + (invert ? -d : d)));
    };
    const stop = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', stop);
      document.body.classList.remove('resizing');
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      start = axis === 'x' ? e.clientX : e.clientY;
      startSize = clamp(prefs.get(key));
      document.body.classList.add('resizing');
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', stop);
    });
    el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 40 : 10;
      const dec = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      const inc = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      if (e.key !== dec && e.key !== inc) return;
      e.preventDefault();
      set(clamp(clamp(prefs.get(key)) + ((e.key === inc) !== invert ? step : -step)));
    });
    // Returned so a panel can re-fit when it opens; the window does so on resize.
    const refit = () => show(clamp(prefs.get(key)));
    refit();
    if (typeof max === 'function') window.addEventListener('resize', refit);
    return refit;
  }

  wireResizer(...args) {
    return this.#wireResizer(...args);
  }

  // Account, sync, theme ----------------------------------------------------

  async #loadPicture() {
    if (!this.session.signedIn || !this.session.puter) return;
    try {
      this.picture = await this.session.puter.auth.getProfilePicture?.();
    } catch {
      this.picture = null;
    }
    this.#renderAccount();
  }

  #renderAccount() {
    const s = this.session;
    if (!s.puter) {
      fill(this.accountEl);
      return;
    }
    if (!s.signedIn) {
      fill(this.accountEl, h('button.btn.sm.primary', { type: 'button', onclick: () => this.signIn() }, icon('logIn', 15), h('span.signin-label', 'Sign in')));
      return;
    }
    const name = s.user?.username || 'Account';
    const avatar = h('span.avatar', this.picture ? h('img', { src: this.picture, alt: '' }) : name.slice(0, 1).toUpperCase());
    const btn = h('button.account-btn', { type: 'button', 'aria-label': `Account: ${name}` }, avatar);
    menuButton(btn, () => [
      { heading: name },
      { label: 'Sync now', icon: 'refresh', disabled: !this.sync, run: () => this.sync?.pull() },
      { label: 'Export everything', icon: 'download', run: () => openExportDialog(this) },
      s.env === 'app' ? null : '-',
      s.env === 'app' ? null : { label: 'Sign out', icon: 'logOut', run: () => this.signOut() },
    ], { align: 'end', label: 'Account' });
    fill(this.accountEl, btn);
  }

  /** thenSend: { tabId, transport } to send once signed in (sign-in reloads the app). */
  async signIn({ thenSend = null } = {}) {
    if (thenSend) {
      this.#flushEdits(); // the tab and its draft must be saved before the reload
      try {
        localStorage.setItem(SEND_AFTER_SIGN_IN, JSON.stringify({ ...thenSend, at: Date.now() }));
      } catch {}
    }
    try {
      await this.onSignIn();
    } catch (err) {
      try {
        localStorage.removeItem(SEND_AFTER_SIGN_IN);
      } catch {}
      if (err?.error === 'popup_blocked') toast({ kind: 'error', title: 'Sign-in window blocked', text: 'Allow pop-ups for this site and try again.' });
      else if (err?.error !== 'auth_window_closed') toast({ kind: 'error', title: 'Could not sign in', text: 'Please try again.' });
    }
  }

  /** Signs in to Puter, then sends the tab's request through the Puter relay. */
  signInAndSend(tab, transport = null) {
    if (!tab) return this.signIn();
    return this.signIn({ thenSend: { tabId: tab.id, transport } });
  }

  #sendAfterSignIn() {
    let pending = null;
    try {
      pending = JSON.parse(localStorage.getItem(SEND_AFTER_SIGN_IN) || 'null');
      localStorage.removeItem(SEND_AFTER_SIGN_IN);
    } catch {}
    // Stale when sign-in was abandoned and the app reopened much later.
    if (!pending || !this.session.signedIn || !(Date.now() - pending.at < 10 * 60 * 1000)) return;
    const tab = this.tabs.find((t) => t.id === pending.tabId && t.kind === 'request');
    if (!tab) return;
    this.activate(tab.id);
    this.sendTab(tab, { transport: pending.transport || null });
  }

  async signOut() {
    const ok = await confirmDialog({
      title: 'Sign out?',
      message: 'Your collections stay in your Puter account. This browser will show the signed-out workspace.',
      confirmLabel: 'Sign out',
    });
    if (ok) await this.onSignOut();
  }

  #renderSync() {
    if (!this.session.signedIn) {
      fill(this.syncEl, h('span.sync-local', { title: 'Saved in this browser only. Sign in to sync with your Puter account.' }, icon('cloudOff', 15), h('span.sr-only', 'Saved in this browser only')));
      return;
    }
    const status = this.sync?.status || 'idle';
    const map = {
      idle: ['cloud', 'Synced with Puter'],
      synced: ['cloudCheck', 'All changes saved to Puter'],
      pending: ['cloud', 'Saving changes...'],
      syncing: ['refresh', 'Syncing with Puter...'],
      error: ['cloudOff', 'Could not reach Puter. Changes are kept on this device and will sync later.'],
    };
    const [ic, text] = map[status] || map.idle;
    fill(this.syncEl, h(`span.sync-state${status === 'syncing' ? '.spin' : ''}${status === 'error' ? '.error' : ''}`, { title: text }, icon(ic, 15), h('span.sr-only', text)));
  }

  setTheme(theme) {
    setTheme(theme);
  }

  setLayout(layout) {
    prefs.set('layout', layout);
    fill(this.layoutBtn, icon(layout === 'side' ? 'columns' : 'rows', 14));
    for (const v of this.views.values()) v.setLayout?.(layout);
  }

  setStatus(text) {
    if (this.statusMsg) this.statusMsg.textContent = text;
  }

  // Transport -------------------------------------------------------------

  relay() {
    if (!this.session.signedIn || !this.session.puter?.net) return null;
    return { openSocket: puterSockets(this.session.puter), cookieJar: this.cookieJar };
  }

  #transportItems() {
    const t = prefs.get('transport');
    const signed = this.session.signedIn;
    return [
      { heading: 'Send requests through' },
      { label: 'Automatic', icon: 'zap', checked: t === 'auto', run: () => this.setTransport('auto') },
      { label: 'Browser only', icon: 'globe', checked: t === 'browser', run: () => this.setTransport('browser') },
      { label: signed ? 'Puter relay' : 'Puter relay (sign in)', icon: 'server', checked: t === 'relay', disabled: !signed, run: () => this.setTransport('relay') },
      '-',
      { label: 'What is the difference?', icon: 'help', run: () => openSettingsDialog(this, 'requests') },
    ];
  }

  setTransport(t) {
    prefs.set('transport', t);
    this.#renderTransport();
  }

  #renderTransport() {
    const t = prefs.get('transport');
    const label = { auto: 'Auto', browser: 'Browser', relay: 'Relay' }[t];
    fill(this.transportBtn, icon(t === 'relay' ? 'server' : t === 'browser' ? 'globe' : 'zap', 14), h('span.status-label', label));
    this.transportBtn.setAttribute('aria-label', `Send requests through: ${label}`);
  }

  sendOptions() {
    return {
      mode: prefs.get('transport'),
      relay: this.relay(),
      timeoutMs: prefs.get('timeoutMs'),
      followRedirects: prefs.get('followRedirects'),
    };
  }

  /** A script's send(); `signal` aborts it when the script ends or is stopped. */
  async #scriptSend(req, { signal } = {}) {
    const resolved = resolveScriptRequest(req);
    // Logged like the requests the app sends, so what a script sends (and the relay cookies it carries) can be seen.
    const log = (entry) => this.console.add({ kind: 'request', method: resolved.method, url: resolved.url, source: 'script', ...entry, at: Date.now() });
    const started = performance.now();
    let res;
    try {
      res = await sendResolved(resolved, { ...this.sendOptions(), signal });
    } catch (err) {
      log({ level: 'error', error: err?.message || String(err) });
      throw err;
    }
    this.afterRelay(res);
    log({
      level: res.status >= 400 ? 'warn' : 'info',
      status: res.status,
      timeMs: res.timings?.total ?? performance.now() - started,
      size: res.size?.body,
      transport: res.transport,
      requestHeaders: res.sentHeaders || resolved.headers.map((h) => [h.key, h.value]),
      responseHeaders: res.headers,
    });
    return { status: res.status, statusText: res.statusText, headers: res.headers, bodyText: decodeText(res.body, charsetOf(res.headers)), timeMs: res.timings?.total, sizeBytes: res.body.length };
  }

  afterRelay(res) {
    if (res?.transport === 'relay') this.persistCookies();
  }

  // Variables ---------------------------------------------------------------

  /** Variable lookup for a tab's context (its collection plus the active environment and globals). */
  varsFor(collectionId) {
    const ws = this.ws;
    const scopes = () => scopesFor(ws, { environmentId: this.environmentId, collection: collectionId ? ws.getCollection(collectionId) : null, local: this.localVars });
    const secretOf = (scope, key) => {
      const list = scope === 'environment' ? ws.getEnvironment(this.environmentId)?.variables : scope === 'collection' ? ws.getCollection(collectionId)?.variables : scope === 'globals' ? ws.globals.variables : null;
      return !!list?.findLast((v) => v.key === key && v.enabled !== false)?.secret;
    };
    return {
      get: (name) => {
        const r = createResolver(scopes()).get(name);
        if (!r || r.scope === 'dynamic') return null;
        return { ...r, secret: secretOf(r.scope, name) };
      },
      list: () => {
        const out = [];
        const seen = new Set();
        for (const s of scopes()) {
          if (!s) continue;
          const entries = s.vars instanceof Map ? [...s.vars].map(([key, value]) => ({ key, value, enabled: true })) : s.vars;
          // Within a scope the last enabled row of a key wins, as when sending.
          const last = new Map();
          for (const v of entries) if (v.key && v.enabled !== false) last.set(v.key, v);
          for (const v of last.values()) {
            if (seen.has(v.key)) continue;
            seen.add(v.key);
            out.push({ name: v.key, value: v.value, scope: s.name, secret: !!v.secret });
          }
        }
        return out;
      },
      resolve: (text) => createResolver(scopes()).resolve(text),
    };
  }

  async setEnvironment(id) {
    this.environmentId = id && this.ws.getEnvironment(id) ? id : null;
    await this.ws.setMeta('activeEnvironment', this.environmentId);
    this.tabbar.renderEnv();
    this.sidebar.render();
    this.refreshVariables();
    const name = this.environmentId ? this.ws.getEnvironment(this.environmentId).name : 'No environment';
    announce(`Environment: ${name}`);
  }

  refreshVariables() {
    refreshVarInputs();
    refreshEditorVariables();
    for (const v of this.views.values()) v.onVariablesChanged?.();
  }

  // Tabs ------------------------------------------------------------------

  get activeTab() {
    return this.tabs.find((t) => t.id === this.activeId) || null;
  }

  tabTitle(tab) {
    if (DRAFT_KINDS.has(tab.kind)) return tab.draft?.name || 'Untitled Request';
    if (tab.kind === 'environment') return tab.refId === 'globals' ? 'Globals' : this.ws.getEnvironment(tab.refId)?.name || 'Environment';
    const loc = this.ws.locate(tab.refId);
    if (tab.kind === 'runner') return `Run ${loc?.item.name || ''}`.trim();
    return loc?.item.name || 'Untitled';
  }

  isDirty(tab) {
    if (!DRAFT_KINDS.has(tab.kind)) return false;
    // A history entry still in preview is untouched: any edit or send keeps the tab.
    if (!tab.refId) return !(tab.historyId && tab.preview);
    if (tab.savedKey == null) {
      const saved = this.ws.locate(tab.refId)?.item;
      tab.savedKey = saved ? draftKey(saved) : NOTHING_SAVED;
    }
    return !sameDraft(draftKey(tab.draft), tab.savedKey);
  }

  /** Opens a history entry as an unsaved request; opening it again finds the same tab. */
  openHistory(entry, { preview = false } = {}) {
    const draft = normalizeRequest({ ...cloneWithNewIds(entry.request), name: entry.request.name || displayUrl(entry.request.url) || 'Untitled Request' });
    return this.openTab('request', null, { draft, preview, historyId: entry.id });
  }

  /**
   * Opens (or focuses) a tab. preview tabs are replaced by the next preview open.
   * historyId marks a draft opened from a history entry, so opening that entry again finds its tab.
   */
  openTab(kind, refId, { preview = false, draft = null, focus = true, historyId = null } = {}) {
    let tab = refId ? this.tabs.find((t) => t.kind === kind && t.refId === refId) : historyId ? this.tabs.find((t) => t.historyId === historyId && !t.refId) : null;
    if (tab) {
      if (!preview) tab.preview = false;
    } else {
      tab = { id: uid(), kind, refId: refId || null, preview, draft: null, historyId };
      if (DRAFT_KINDS.has(kind)) {
        const saved = refId ? this.ws.locate(refId)?.item : null;
        const blank = kind === 'websocket' ? websocketRequest() : newRequest({ name: 'Untitled Request' });
        tab.draft = draft ? normalizeDraft({ ...draft, type: kind }) : saved ? normalizeDraft(structuredClone(saved)) : blank;
        if (!refId && !historyId) tab.preview = false;
      }
      // Only a tab that is itself a preview replaces the current preview tab.
      const old = tab.preview ? this.tabs.find((t) => t.preview && !this.isDirty(t)) : null;
      if (old) {
        const i = this.tabs.indexOf(old);
        // Out of the list first: views (a WebSocket's connection) only clean up for tabs that are gone.
        this.tabs.splice(i, 1, tab);
        old.abort?.abort();
        this.#destroyView(old.id);
      } else {
        const at = this.tabs.findIndex((t) => t.id === this.activeId);
        this.tabs.splice(at < 0 ? this.tabs.length : at + 1, 0, tab);
      }
    }
    this.activate(tab.id, { focus });
    return tab;
  }

  newRequest(fields = {}) {
    return this.openTab('request', null, { draft: newRequest({ name: 'Untitled Request', ...fields }) });
  }

  newWebSocket(fields = {}) {
    return this.openTab('websocket', null, { draft: websocketRequest({ name: 'Untitled WebSocket', ...fields }) });
  }

  activate(id, { focus = false } = {}) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    const prev = this.activeId;
    this.activeId = id;
    if (prev && prev !== id) this.views.get(prev)?.onHide?.();
    let view = this.views.get(id);
    if (!view) {
      view = new (VIEW_FOR()[tab.kind])(this, tab);
      this.views.set(id, view);
    }
    this.content.replaceChildren(view.el);
    this.content.setAttribute('role', 'tabpanel');
    this.content.setAttribute('aria-labelledby', `tab-${tab.id}`);
    // Variables may have changed while the tab was in the background.
    refreshVarInputs(view.el);
    refreshEditorVariables(view.el);
    // The drawer closes first: the page behind it cannot take focus while it is open.
    if (this.compact) this.toggleSidebar(false);
    view.onShow?.({ focus });
    this.tabbar.render();
    this.sidebar.highlight(tab.refId);
    this.#renderRightPanel();
    this.persistTabs();
  }

  /** focus: move focus into the tab shown next (false when the caller places it). */
  async closeTab(id, { force = false, focus = true } = {}) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return false;
    if (!force && this.isDirty(tab) && !(!tab.refId && isPristine(tab.draft))) {
      // A second close while the first is still asking (a double-click) is ignored.
      if (tab.closing) return false;
      tab.closing = true;
      try {
        const choice = await this.#confirmClose(tab);
        if (choice === 'cancel') return false;
        if (choice === 'save' && !(await this.saveTab(tab))) return false;
      } finally {
        tab.closing = false;
      }
      // Closed some other way while the prompt was open.
      if (!this.tabs.includes(tab)) return false;
    }
    tab.abort?.abort();
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    this.#destroyView(id);
    if (this.activeId === id) {
      const next = this.tabs[i] || this.tabs[i - 1];
      if (next) this.activate(next.id, { focus });
      else {
        this.activeId = null;
        this.renderEmpty();
        this.tabbar.render();
        this.sidebar.highlight(null);
      }
    } else this.tabbar.render();
    this.persistTabs();
    return true;
  }

  async closeTabs(ids) {
    for (const id of ids) if (!(await this.closeTab(id))) return;
  }

  #confirmClose(tab) {
    return new Promise((resolve) => {
      let dlg;
      const btn = (label, value, cls = '') => h(`button.btn${cls}`, { type: 'button', onclick: () => dlg.close(value) }, label);
      dlg = openDialog({
        title: 'Save changes?',
        body: h('p', { style: { margin: 0, color: 'var(--text-muted)' } }, `"${this.tabTitle(tab)}" has unsaved changes.`),
        footer: [btn("Don't save", 'discard'), h('span.spacer'), btn('Cancel', 'cancel'), btn('Save', 'save', '.primary')],
      });
      dlg.result.then((v) => resolve(v || 'cancel'));
    });
  }

  #destroyView(id) {
    this.views.get(id)?.destroy?.();
    this.views.delete(id);
  }

  moveTab(id, toIndex) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [tab] = this.tabs.splice(i, 1);
    this.tabs.splice(Math.max(0, Math.min(toIndex, this.tabs.length)), 0, tab);
    this.tabbar.render();
    this.persistTabs();
  }

  /** Called by request views after every edit. */
  draftChanged(tab) {
    if (tab.preview) tab.preview = false;
    this.tabbar.render();
    this.persistTabs();
  }

  /** A sent request or open connection is kept: opening another preview must not replace it (and abort it). */
  keepTab(tab) {
    if (!tab.preview) return;
    tab.preview = false;
    this.tabbar.render();
    this.persistTabs();
  }

  async saveTab(tab = this.activeTab) {
    if (!tab || !DRAFT_KINDS.has(tab.kind)) return false;
    if (!tab.refId || !this.ws.locate(tab.refId)) return this.saveTabAs(tab);
    const owner = this.ws.locate(tab.refId).collection;
    if (owner.shared && !['write', 'manage'].includes(owner.shared.mode)) {
      toast({ kind: 'warning', title: 'View only', text: `"${owner.name}" is shared with you as view only.`, actions: [{ label: 'Save a copy', run: () => this.saveTabAs(tab) }] });
      return false;
    }
    await this.ws.saveRequest(tab.draft);
    tab.savedKey = null;
    tab.preview = false;
    this.tabbar.render();
    this.views.get(tab.id)?.onSaved?.();
    this.persistTabs();
    announce('Saved');
    return true;
  }

  saveTabAs(tab = this.activeTab) {
    if (!tab || !DRAFT_KINDS.has(tab.kind)) return Promise.resolve(false);
    // Save pressed again while the first is still opening its dialog (it loads on first use) shares that save.
    tab.saving ||= this.#saveTabAs(tab).finally(() => {
      tab.saving = null;
    });
    return tab.saving;
  }

  async #saveTabAs(tab) {
    const here = tab.refId ? this.ws.locate(tab.refId) : null;
    const target = await openSaveDialog(this, { name: tab.draft.name, collectionId: here?.collection.id, folderId: here?.parent?.type === 'folder' ? here.parent.id : undefined });
    if (!target) return false;
    let collectionId = target.collectionId;
    if (target.newCollection) collectionId = (await this.ws.addCollection({ name: target.newCollection })).id;
    const saved = tab.refId && this.ws.locate(tab.refId) ? cloneWithNewIds(tab.draft) : normalizeDraft(tab.draft);
    saved.name = target.name;
    // The copy's messages have new ids: keep the same message selected.
    const msg = tab.draft.messages?.findIndex((m) => m.id === tab.wsMessageId) ?? -1;
    if (msg >= 0) tab.wsMessageId = saved.messages[msg]?.id;
    await this.ws.addItem(collectionId, target.folderId || collectionId, saved);
    tab.refId = saved.id;
    tab.draft = normalizeDraft(structuredClone(saved));
    tab.savedKey = null;
    tab.preview = false;
    this.sidebar.reveal(saved.id);
    this.#destroyView(tab.id);
    this.activate(tab.id);
    toast({ kind: 'success', title: 'Request saved', text: `Saved to ${this.ws.getCollection(collectionId).name}.` });
    return true;
  }

  #saveTabs() {
    const tabs = this.tabs.map((t) => ({
      id: t.id,
      kind: t.kind,
      refId: t.refId,
      preview: !!t.preview,
      historyId: t.historyId || null,
      draft: DRAFT_KINDS.has(t.kind) && (!t.refId || this.isDirty(t)) ? t.draft : null,
    }));
    this.ws.setMeta('tabs', { active: this.activeId, tabs });
  }

  async #restoreTabs() {
    const saved = await this.ws.getMeta('tabs');
    if (!saved?.tabs?.length) return;
    for (const t of saved.tabs) {
      if (DRAFT_KINDS.has(t.kind)) {
        const exists = t.refId && this.ws.locate(t.refId);
        if (!exists && !t.draft) continue;
        this.tabs.push({ id: t.id, kind: t.kind, refId: exists ? t.refId : null, preview: t.preview, historyId: t.historyId || null, draft: normalizeDraft(t.draft || structuredClone(exists.item)) });
      } else if (t.kind === 'environment') {
        if (this.ws.getEnvironment(t.refId)) this.tabs.push({ id: t.id, kind: t.kind, refId: t.refId, preview: t.preview });
      } else if (this.ws.locate(t.refId)) this.tabs.push({ id: t.id, kind: t.kind, refId: t.refId, preview: t.preview });
    }
    const active = this.tabs.find((t) => t.id === saved.active) || this.tabs[0];
    if (active) this.activate(active.id);
    else this.tabbar.render();
  }

  renderEmpty() {
    // With no tabs open it is the launch screen, not a tab panel.
    this.content.removeAttribute('role');
    this.content.removeAttribute('aria-labelledby');
    const action = (ic, label, run, kbd) => h('button.launch-card', { type: 'button', onclick: run }, icon(ic, 20), h('span.launch-label', label), kbd ? h('kbd', kbd) : null);
    this.content.replaceChildren(
      h(
        'div.launch',
        h('h1.launch-title', 'Start with a request'),
        h('p.launch-sub', 'Build, send and test HTTP requests. Organize them in collections and switch between environments.'),
        h(
          'div.launch-grid',
          action('plus', 'New request', () => this.newRequest(), shortcut('Mod+Alt+N')),
          action('folderPlus', 'New collection', () => this.createCollection()),
          action('import', 'Import', () => openImportDialog(this)),
          action('globe', 'New environment', () => this.createEnvironment()),
          action('plug', 'New WebSocket', () => this.newWebSocket()),
          action('play', 'Run a collection', () => (this.ws.collections.length ? this.runCollection(this.ws.collections[0].id) : this.createCollection())),
        ),
        this.session.signedIn || !this.session.puter
          ? null
          : h('p.launch-note', icon('info', 14), h('span', 'You are not signed in, so your work is saved in this browser. '), h('button.link-btn', { type: 'button', onclick: () => this.signIn() }, 'Sign in'), h('span', ' to sync it across devices.')),
      ),
    );
    this.#renderRightPanel();
  }

  focusMain() {
    this.views.get(this.activeId)?.focus?.() || this.mainEl.focus();
  }

  // Right panel (code snippet) ----------------------------------------------

  /** The panel asked for: the saved choice, or on narrow screens only one opened since they became narrow. */
  get rightPanelKind() {
    return this.compact ? this.compactPanel || null : prefs.get('rightPanel');
  }

  /** Opens or closes the panel. `open` forces a state. */
  toggleRightPanel(kind = 'code', open = this.rightPanelKind !== kind) {
    const next = open ? kind : null;
    // Narrow screens do not save it: the panel would cover the editor every time the app opens.
    if (this.compact) this.compactPanel = next;
    else prefs.set('rightPanel', next);
    const hadFocus = this.rightPanel.contains(document.activeElement);
    if (next && !hadFocus) this.rightPanelOpener = document.activeElement;
    const rendered = this.#renderRightPanel();
    if (this.rightPanel.hidden) {
      const opener = this.rightPanelOpener;
      if (hadFocus) opener?.isConnected && opener.offsetParent ? opener.focus() : this.focusMain();
    } else if (this.#rightPanelOverlays()) {
      // Over the editor, focus moves into the panel so keyboard users are not left under it.
      Promise.resolve(rendered).then(() => this.rightPanel.querySelector('button, select')?.focus());
    }
  }

  /** In a narrow row the panel lies over the editor instead of beside it. */
  #rightPanelOverlays() {
    return getComputedStyle(this.rightPanel).position === 'absolute';
  }

  #renderRightPanel() {
    const tab = this.activeTab;
    const show = this.rightPanelKind && tab?.kind === 'request';
    this.rightPanel.hidden = !show;
    const rendered = show ? this.views.get(tab.id)?.renderRightPanel?.(this.rightPanel) : this.rightPanel.replaceChildren();
    for (const v of this.views.values()) v.onRightPanel?.(!!show);
    return rendered;
  }

  refreshRightPanel() {
    this.#renderRightPanel();
  }

  // Sidebar ---------------------------------------------------------------

  toggleSidebar(open = !this.shell.classList.contains('sidebar-open'), { save = true } = {}) {
    const wasOpen = this.shell.classList.contains('sidebar-open');
    this.shell.classList.toggle('sidebar-open', open);
    this.menuBtn?.setAttribute('aria-expanded', String(open));
    if (save && !this.compact) prefs.set('sidebarOpen', open);
    // On phones the open sidebar is a modal drawer: the page behind it is out of reach until it closes.
    const modal = open && this.compact;
    for (const el of this.shell.querySelectorAll(':scope > .skip-link, :scope > .appbar, :scope > .statusbar, .rail, .main')) el.inert = modal;
    this.sidebarEl.setAttribute('role', modal ? 'dialog' : 'complementary');
    if (modal) {
      this.sidebarEl.setAttribute('aria-modal', 'true');
      setTimeout(() => this.sidebar.focus(), 50);
    } else {
      this.sidebarEl.removeAttribute('aria-modal');
      if (wasOpen && this.compact && (this.sidebarEl.contains(document.activeElement) || document.activeElement === document.body)) this.menuBtn.focus();
    }
  }

  showSection(key, { open = true } = {}) {
    prefs.set('sidebarSection', key);
    if (open && !this.shell.classList.contains('sidebar-open')) this.toggleSidebar(true);
    this.sidebar.show(key);
    for (const b of this.railEl.children) b.setAttribute('aria-pressed', String(b.dataset.key === key));
  }

  // Workspace actions --------------------------------------------------------

  async createCollection() {
    const name = await promptDialog({ title: 'New collection', label: 'Name', value: 'New Collection', confirmLabel: 'Create' });
    if (!name) return null;
    const c = await this.ws.addCollection({ name });
    this.showSection('collections');
    this.sidebar.reveal(c.id);
    this.openTab('collection', c.id);
    return c;
  }

  async createEnvironment() {
    const name = await promptDialog({ title: 'New environment', label: 'Name', value: 'New Environment', confirmLabel: 'Create' });
    if (!name) return null;
    const e = await this.ws.addEnvironment({ name });
    this.showSection('environments');
    this.openTab('environment', e.id);
    return e;
  }

  async addRequestTo(collectionId, parentId) {
    const req = newRequest({ name: 'New Request' });
    await this.ws.addItem(collectionId, parentId || collectionId, req);
    this.sidebar.expand(parentId || collectionId);
    this.sidebar.reveal(req.id);
    this.openTab('request', req.id);
    return req;
  }

  async addWebSocketTo(collectionId, parentId) {
    const ws = websocketRequest({ name: 'New WebSocket' });
    await this.ws.addItem(collectionId, parentId || collectionId, ws);
    this.sidebar.expand(parentId || collectionId);
    this.sidebar.reveal(ws.id);
    this.openTab('websocket', ws.id);
    return ws;
  }

  async addFolderTo(collectionId, parentId) {
    const name = await promptDialog({ title: 'New folder', label: 'Name', value: 'New Folder', confirmLabel: 'Create' });
    if (!name) return null;
    const f = newFolder({ name });
    await this.ws.addItem(collectionId, parentId || collectionId, f);
    this.sidebar.expand(parentId || collectionId);
    this.sidebar.reveal(f.id);
    return f;
  }

  async renameItem(id) {
    const loc = this.ws.locate(id);
    if (!loc) return;
    const name = await promptDialog({ title: `Rename ${loc.item.type}`, label: 'Name', value: loc.item.name, confirmLabel: 'Rename' });
    if (!name || name === loc.item.name) return;
    await this.ws.updateItem(id, (item) => {
      item.name = name;
    });
  }

  /** Moves a request or folder to a place picked in a dialog: the way to move without dragging. */
  async moveItemTo(id) {
    const loc = this.ws.locate(id);
    if (!loc || loc.item.type === 'collection') return;
    const from = loc.parent.type === 'folder' ? loc.parent.id : null;
    const target = await openSaveDialog(this, { collectionId: loc.collection.id, folderId: from, moving: loc.item });
    if (!target || (target.collectionId === loc.collection.id && (target.folderId || null) === from)) return;
    const collectionId = target.newCollection ? (await this.ws.addCollection({ name: target.newCollection })).id : target.collectionId;
    if (!(await this.ws.moveItem(id, collectionId, target.folderId || collectionId))) return;
    this.sidebar.focusedId = id;
    this.sidebar.restoreFocus = true;
    this.sidebar.reveal(id);
    announce(`Moved to ${this.ws.locate(id).parents.map((p) => p.name).join(' / ')}`);
  }

  async deleteItem(id) {
    const loc = this.ws.locate(id);
    if (!loc) return;
    if (loc.item.type === 'collection' && loc.item.shared) return this.leaveShared(id);
    const kind = loc.item.type;
    const extra = kind === 'request' ? '' : ' and everything in it';
    const ok = await confirmDialog({ title: `Delete ${kind}?`, message: `"${loc.item.name}"${extra} will be deleted. This cannot be undone.`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    await this.ws.removeItem(id);
    toast({ kind: 'success', title: `${kind[0].toUpperCase()}${kind.slice(1)} deleted` });
  }

  async deleteEnvironment(id) {
    const env = this.ws.getEnvironment(id);
    if (!env) return;
    const ok = await confirmDialog({ title: 'Delete environment?', message: `"${env.name}" and its variables will be deleted. This cannot be undone.`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    if (this.environmentId === id) await this.setEnvironment(null);
    await this.ws.deleteEnvironment(id);
    // Deleting from the environment's own tab closes it; when no other tab takes focus, keep it on the page.
    if (document.activeElement === document.body) this.focusMain();
  }

  async shareCollection(id) {
    if (!this.session.signedIn || !this.shared) {
      toast({ kind: 'info', title: 'Sign in to share', text: 'Sharing uses your Puter account.', actions: this.session.puter ? [{ label: 'Sign in', run: () => this.signIn() }] : [] });
      return;
    }
    const { openShareDialog } = await import('./share-dialog.js');
    openShareDialog(this, id);
  }

  async leaveShared(id) {
    const c = this.ws.getCollection(id);
    if (!c?.shared) return;
    const ok = await confirmDialog({
      title: 'Remove shared collection?',
      message: `"${c.name}" will be removed from your list and you will lose access. ${c.shared.owner || 'The owner'} can share it with you again.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) await this.shared.leave(id);
  }

  runCollection(id) {
    this.openTab('runner', id);
  }

  #onWorkspaceChange(e) {
    this.sidebar.onChange(e);
    if (e.kind === 'collection') {
      for (const tab of [...this.tabs]) {
        if (DRAFT_KINDS.has(tab.kind) && tab.refId) {
          const loc = this.ws.locate(tab.refId);
          const before = tab.savedKey;
          const wasClean = before != null && sameDraft(draftKey(tab.draft), before);
          tab.savedKey = null;
          if (!loc) {
            if (wasClean || !this.isDirtyAgainst(tab)) this.closeTab(tab.id, { force: true });
            else tab.refId = null;
            continue;
          }
          const now = draftKey(loc.item);
          if (wasClean && !sameDraft(now, before)) {
            // The saved item changed (a rename, a move or another device): follow it.
            tab.draft = normalizeDraft(structuredClone(loc.item));
            tab.savedKey = now;
            this.views.get(tab.id)?.reload?.();
          } else {
            // Renamed elsewhere while the tab has edits: take the new name unless the tab renamed it too.
            const savedName = before ? before.name : null;
            if (savedName != null && loc.item.name !== savedName && tab.draft.name === savedName) {
              tab.draft.name = loc.item.name;
              this.persistTabs();
            }
            this.views.get(tab.id)?.onContextChanged?.();
          }
        } else if ((tab.kind === 'collection' || tab.kind === 'folder' || tab.kind === 'runner') && !this.ws.locate(tab.refId)) {
          this.closeTab(tab.id, { force: true });
        } else this.views.get(tab.id)?.onContextChanged?.(e);
      }
    }
    if (e.kind === 'environment' || e.kind === 'globals' || e.kind === 'collection') {
      if (e.kind === 'environment' && e.deleted) {
        if (this.environmentId === e.id) this.setEnvironment(null);
        for (const tab of this.tabs.filter((t) => t.kind === 'environment' && t.refId === e.id)) this.closeTab(tab.id, { force: true });
      }
      this.tabbar.renderEnv();
      // Also redraws the tab titles and unsaved marks a collection change may have changed.
      this.tabbar.render();
      this.refreshVariables();
      for (const v of this.views.values()) if (v.tab.kind === 'environment') v.onContextChanged?.(e);
    }
  }

  isDirtyAgainst(tab) {
    return !isPristine(tab.draft);
  }

  // Sending ---------------------------------------------------------------

  /** Runs the request in a tab and records the result. */
  async sendTab(tab, { transport = null } = {}) {
    if (tab?.kind === 'websocket') {
      this.views.get(tab.id)?.primaryAction?.();
      return;
    }
    if (!tab || tab.kind !== 'request') return;
    if (tab.abort) {
      tab.abort.abort();
      return;
    }
    const controller = new AbortController();
    tab.abort = controller;
    tab.sendStarted = performance.now();
    this.views.get(tab.id)?.onSending?.(true);
    this.keepTab(tab);
    const loc = tab.refId ? this.ws.locate(tab.refId) : null;
    const parents = loc ? loc.parents : [];
    const options = this.sendOptions();
    if (transport) options.mode = transport;
    // The request as sent, for history: the draft may be edited while it runs.
    const sent = structuredClone(tab.draft);
    const draft = transport ? { ...sent, settings: { ...sent.settings, transport } } : sent;
    let result;
    try {
      result = await execute(draft, parents, {
        ws: this.ws,
        environmentId: this.environmentId,
        local: this.localVars,
        sandbox: this.sandbox,
        sendOptions: options,
        signal: controller.signal,
        onLog: (entry) => this.console.add(entry),
      });
    } catch (err) {
      result = { error: { message: err.message || String(err) }, tests: [], logs: [], warnings: [] };
    }
    tab.abort = null;
    tab.result = result;
    this.afterRelay(result.response);
    // Looked up again: Save As rebuilds the tab's view while the request runs.
    const view = this.views.get(tab.id);
    view?.onSending?.(false);
    view?.showResult?.(result);
    const r = result.response;
    if (r) {
      announce(`${r.status} ${r.statusText || ''}, ${Math.round(r.timeMs)} milliseconds`);
      if (tab.refId) this.ws.saveResponse(tab.refId, { ...r, tests: result.tests, warnings: result.warnings }).catch(() => {});
    } else if (result.error && result.error.code !== 'aborted') announce(`Request failed: ${result.error.message}`);
    if (result.resolved || result.error?.code !== 'aborted') {
      await this.ws.addHistory({
        request: sent,
        response: r ? { status: r.status, statusText: r.statusText, timeMs: r.timeMs, size: r.size?.body } : { error: result.error?.message },
        collectionId: loc?.collection.id || null,
        transport: r?.transport || null,
      }).catch(() => {});
    }
    const failed = result.tests.filter((t) => !t.passed && !t.skipped).length;
    if (result.tests.length) this.setStatus(`${result.tests.length - failed} of ${result.tests.length} tests passed`);
  }

  // Shortcuts -------------------------------------------------------------

  #onKey(e) {
    // Editors and fields that handled the key themselves (for example Enter
    // in the URL bar) mark it; acting again would send twice.
    if (e.defaultPrevented) return;
    // AltGr arrives as Ctrl+Alt on Windows; it types characters such as } | € [ ] on many layouts.
    if (e.getModifierState?.('AltGraph')) return;
    const mod = modKey(e);
    const k = e.key;
    const code = e.code;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (document.querySelector('dialog[open]')) {
      // The shortcut does not run over a dialog, but the browser's Save Page, Open File or search must not open either.
      if (mod && !e.altKey && (code === 'KeyS' || code === 'KeyO' || code === 'KeyK')) e.preventDefault();
      return;
    }
    if ((mod || e.ctrlKey) && !e.altKey && k === 'Enter') {
      e.preventDefault();
      this.sendTab(this.activeTab);
    } else if (mod && !e.altKey && code === 'KeyS') {
      e.preventDefault();
      if (e.shiftKey) this.saveTabAs();
      else this.saveTab();
    } else if (mod && !e.altKey && !e.shiftKey && code === 'KeyK') {
      e.preventDefault();
      openPalette(this);
    } else if (mod && e.altKey && code === 'KeyN') {
      e.preventDefault();
      this.newRequest();
    } else if (mod && e.altKey && code === 'KeyW') {
      e.preventDefault();
      if (this.activeId) this.closeTab(this.activeId);
    } else if (mod && e.altKey && (code === 'BracketRight' || code === 'BracketLeft')) {
      e.preventDefault();
      const i = this.tabs.findIndex((t) => t.id === this.activeId);
      const next = this.tabs[(i + (code === 'BracketRight' ? 1 : -1) + this.tabs.length) % this.tabs.length];
      if (next) this.activate(next.id, { focus: true });
    } else if (mod && !e.altKey && code === 'Backslash') {
      e.preventDefault();
      this.toggleSidebar();
    } else if (e.ctrlKey && code === 'Backquote') {
      e.preventDefault();
      this.console.toggle();
    } else if (mod && e.altKey && code === 'KeyU') {
      e.preventDefault();
      this.views.get(this.activeId)?.focusUrl?.();
    } else if (mod && !e.altKey && code === 'KeyO') {
      e.preventDefault();
      openImportDialog(this);
    } else if ((mod && k === '/') || (!typing && k === '?')) {
      e.preventDefault();
      openShortcutsDialog();
    } else if (k === 'Escape' && this.compact && this.shell.classList.contains('sidebar-open')) {
      closeMenu();
      this.toggleSidebar(false);
    }
  }
}

// The saved side of isDirty for a tab whose request is gone: differs from every draft.
const NOTHING_SAVED = { json: '', long: [], name: null };

function isPristine(draft) {
  if (draft.type === 'websocket') return !draft.url && draft.messages.every((m) => !m.body);
  const blank = newRequest({ name: 'Untitled Request' });
  return draft.url === '' && draft.method === 'GET' && draft.name === blank.name && draft.headers.length === 0 && draft.params.length === 0 && draft.body.mode === 'none' && !draft.scripts.pre && !draft.scripts.post && draft.auth.type === 'inherit';
}


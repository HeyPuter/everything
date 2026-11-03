import './styles/base.css';
import './styles/components.css';
import './styles/shell.css';
import { el } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { button, iconButton } from './ui/bits.js';
import { avatar } from './ui/avatar.js';
import { toast } from './ui/toast.js';
import { openMenu } from './ui/menu.js';
import { applyTheme, currentTheme, onThemeChange } from './ui/theme.js';
import { onLocaleChange, t } from './lib/i18n/index.js';
import { getPuter, accountIdentity } from './lib/puter.js';
import { openDatabase as defaultOpenDatabase } from './lib/idb.js';
import { createPersonalStore as defaultPersonalStore } from './lib/store/personal.js';
import { bindPrefs, orderTabs } from './lib/prefs.js';
import { lastIdentity, rememberIdentity } from './lib/identity.js';
import { startPageHash } from './lib/start-page.js';
import { createSession as defaultCreateSession } from './lib/session.js';
import { createRouter, defaultTripTab, routeHash } from './lib/router.js';
import { routes as defaultRoutes } from './views/registry/routes.js';
import { tripTabs as defaultTripTabs } from './views/registry/tabs.js';
import { settingsSections as defaultSettingsSections } from './views/registry/settings.js';
import { createCommandRegistry, matchesShortcut, isEditable } from './views/registry/commands.js';
import { openCommandPalette, openShortcutHelp } from './views/shell/palette.js';
import { authView, settingsView, unavailableView } from './views/shell/views.js';
import { createInboxEntry } from './views/join/entry.js';
import { startPwa } from './lib/offline/pwa.js';
import { createTripRoute } from './views/trip/shell.js';

const themes = new Set(['system', 'light', 'dark']);
const syncKeys = { preview: 'app.syncPreview', idle: 'app.syncIdle', syncing: 'app.syncing', synced: 'app.synced', queued: 'app.queued', offline: 'app.syncOffline', credit: 'app.syncCredit', forbidden: 'app.syncForbidden', conflict: 'app.syncConflict' };
// Space kinds other than trips mount the route entry that lists them.
const SPACE_PAGES = Object.freeze({ collection: 'collections', journey: 'journeys' });
// Phone tab bar slots; more routes than this put the rest under "More".
const TABBAR_SLOTS = 5;
const isMac = () => /mac|iphone|ipad/i.test(globalThis.navigator?.userAgentData?.platform ?? globalThis.navigator?.platform ?? '');

/** No worker traffic starts here; views report sync state through `setSyncState`. */
export function createApp({ root, puter: injectedPuter, openDatabase = defaultOpenDatabase, createPersonalStore = defaultPersonalStore, createSession = defaultCreateSession,
  loadBackground = () => import('./lib/background.js'),
  window: targetWindow = globalThis.window, onRetrySync, reload = () => targetWindow.location.reload(), mac = isMac(),
  registries: { routes = defaultRoutes, tripTabs = defaultTripTabs, settingsSections = defaultSettingsSections } = {} } = {}) {
  if (!root?.replaceChildren) throw new TypeError('App root is required');
  const doc = root.ownerDocument;
  const registry = createCommandRegistry();
  const dialogs = new Set();
  const notifications = new Set();
  let destroyed = false;
  let epoch = 0;
  let bootPromise = Promise.resolve();
  let sdk;
  let account;
  let accountToken;
  let db;
  let personal;
  let session = null;
  let tripRoute = null;
  let stopBackground = null;
  let prefsBinding = null;
  let phase = 'idle';
  let route;
  let online = targetWindow.navigator.onLine !== false;
  let sync = { status: 'preview', pending: 0 };
  let shell;
  let settings;
  let palette;
  let desiredTheme = currentTheme();
  let pendingTheme;
  let themeVersion = 0;
  let preferenceRead = 0;
  let preference = { key: '' };
  let writes = Promise.resolve();
  let view = null;
  let inbox = null;
  const alive = (version) => !destroyed && version === epoch;
  function unmountView() {
    if (!view) return;
    const { controller, cleanup } = view; view = null; controller.abort();
    try { cleanup?.(); } catch { /* A failing view must not block navigation. */ }
  }
  /** Mounts a registry entry's lazy module: `load()` resolves to `{ mount(container, context) }`; `prepare()` adds context (trip routes: ref, space). */
  async function mountView(container, load, prepare) {
    unmountView();
    const current = { controller: new AbortController() }; view = current;
    const { signal } = current.controller;
    container.setAttribute('aria-busy', 'true');
    try {
      const [module, extra] = await Promise.all([load(), prepare ? prepare() : {}]);
      if (signal.aborted) return;
      const cleanup = await module.mount(container, { app: viewApi, route, account: { ...account }, puter: sdk, personal, session, signal, ...extra });
      if (signal.aborted) { if (typeof cleanup === 'function') cleanup(); return; }
      current.cleanup = typeof cleanup === 'function' ? cleanup : null;
    } catch {
      if (!signal.aborted) container.replaceChildren(el('p.view-error', { role: 'alert' }, t('app.viewError')));
    } finally { if (!signal.aborted) container.removeAttribute('aria-busy'); }
  }
  function showToast(key) {
    const notice = toast(t(key)); notifications.add(notice);
    if (notifications.size > 3) { const oldest = notifications.values().next().value; oldest.close(); notifications.delete(oldest); }
    return notice;
  }
  function closeDialogs() { for (const dialog of [...dialogs].reverse()) dialog.close('navigation'); dialogs.clear(); palette = null; }
  function track(dialog) { dialogs.add(dialog); void dialog.closed.then(() => dialogs.delete(dialog)); return dialog; }
  function resetAccount() {
    unmountView(); closeDialogs(); inbox?.destroy(); inbox = null; for (const notice of notifications) notice.close(); notifications.clear();
    prefsBinding?.close(); prefsBinding = null;
    stopBackground?.(); stopBackground = null;
    tripRoute?.leave(); tripRoute = null; session?.close(); session = null;
    db?.close(); db = null; personal = null; account = null; accountToken = null; settings = null; shell = null;
    writes = Promise.resolve();
    pendingTheme = undefined; preference = { key: '' }; themeVersion = 0; preferenceRead += 1;
    sync = { status: 'preview', pending: 0 };
  }
  function sessionValid() {
    if (phase !== 'ready') return false;
    if (sdk.authToken === accountToken) return true;
    void start(); return false;
  }
  function settled() { doc.documentElement.dataset.boot = 'ready'; }
  function offlineBar() { return el('div.offline-bar.app-offline', { role: 'status', hidden: online }, icon('offline', 16), t('app.offline')); }
  function showAuth(options = {}) {
    shell = null; settings = null;
    root.replaceChildren(offlineBar(), authView(options));
    settled(); root.querySelector('h1')?.focus({ preventScroll: true });
  }
  function setPreference(next) { preference = next; settings?.updatePreference(next); }
  function preferenceError(error) {
    return error?.status === 402 ? 'app.prefsCredit' : error?.status === 403 ? 'app.prefsForbidden' : error?.status === 409 ? 'app.prefsConflict' : 'app.prefsSaveError';
  }
  async function loadPreferences() {
    if (!sessionValid()) return;
    const version = epoch; const read = ++preferenceRead; const originalThemeVersion = themeVersion;
    const store = personal;
    setPreference({ key: 'app.prefsLoading' });
    try {
      const prefs = await store.get('me:prefs');
      if (!alive(version) || read !== preferenceRead) return;
      if (!sessionValid()) return;
      if (themeVersion === originalThemeVersion) {
        const theme = prefsBinding?.localTheme() ?? (prefs && Object.hasOwn(prefs, 'theme') ? prefs.theme : undefined);
        if (themes.has(theme)) applyTheme(theme);
        desiredTheme = currentTheme(); settings?.setTheme(desiredTheme);
        setPreference({ key: '' });
      }
    } catch {
      if (!alive(version) || read !== preferenceRead) return;
      if (!sessionValid()) return;
      if (themeVersion === originalThemeVersion) setPreference({ key: 'app.prefsLoadError', error: true, retry: 'load' });
    }
  }
  function saveTheme(theme) {
    if (!themes.has(theme) || !sessionValid()) return Promise.resolve();
    const version = epoch; const revision = ++themeVersion; const store = personal;
    desiredTheme = theme; pendingTheme = theme;
    applyTheme(theme); settings?.setTheme(theme);
    if (!online) { setPreference({ key: 'app.prefsOffline', error: true, retry: 'save' }); return Promise.resolve(); }
    setPreference({ key: 'app.prefsSaving' });
    writes = writes.catch(() => {}).then(async () => {
      if (!alive(version) || sdk.authToken !== accountToken) return;
      try {
        await store.patchPreferences({ theme });
        if (!alive(version) || revision !== themeVersion || !sessionValid()) return;
        pendingTheme = undefined; setPreference({ key: 'app.prefsSaved' });
      } catch (error) {
        if (!alive(version) || revision !== themeVersion || !sessionValid()) return;
        setPreference({ key: online ? preferenceError(error) : 'app.prefsOffline', error: true, retry: 'save' });
      }
    });
    return writes;
  }
  function updateStatus() {
    for (const node of root.querySelectorAll('.app-offline')) node.hidden = online;
    if (!shell) return;
    // "Synced" describes the last sync run; local changes still waiting to be sent make it "syncing".
    const status = !online && !['preview', 'idle'].includes(sync.status) ? 'offline' : sync.status === 'synced' && sync.pending ? 'syncing' : sync.status;
    shell.status.textContent = t(syncKeys[status], { count: sync.pending });
    shell.status.dataset.state = status;
    // Outside a trip there is nothing to report.
    shell.status.hidden = status === 'idle';
    shell.retry.hidden = !(onRetrySync || tripRoute?.active) || !['credit', 'forbidden', 'conflict', 'offline', 'queued'].includes(status);
  }
  function setSyncState(status, { pending = 0 } = {}) {
    if (!Object.hasOwn(syncKeys, status)) throw new TypeError('Invalid sync status');
    sync = { status, pending: Number.isSafeInteger(pending) && pending >= 0 ? pending : 0 }; updateStatus();
  }
  function navigate(target, options) { closeDialogs(); router.navigate(target, options); }
  async function signIn() {
    if (phase === 'signingIn' || destroyed) return;
    phase = 'signingIn'; const version = epoch;
    showAuth({ busy: true, onSignIn: signIn });
    try { await sdk.auth.signIn(); if (alive(version)) await start(); }
    catch { if (alive(version)) { phase = 'signedOut'; showAuth({ error: 'app.signInFailed', onSignIn: signIn }); } }
  }
  async function signOut(event) {
    if (!sessionValid() || sdk.env === 'app' || typeof sdk.auth.signOut !== 'function') return;
    const control = event?.currentTarget; control?.setAttribute('aria-busy', 'true');
    const version = epoch;
    try { await sdk.auth.signOut(); if (alive(version)) await start(); }
    catch { if (alive(version)) showToast('app.signOutFailed'); }
    finally { control?.setAttribute('aria-busy', 'false'); }
  }
  function openPalette() {
    if (!sessionValid() || palette) return;
    palette = track(openCommandPalette({ registry, onRun: runCommand, mac, onClose: () => { palette = null; } }));
  }
  function openHelp() { if (sessionValid()) track(openShortcutHelp({ registry, mac })); }
  const handlers = { home: () => navigate('#/'), appearance: () => navigate('#/settings/appearance'), help: openHelp, palette: openPalette };
  async function runCommand(command) {
    if (!sessionValid()) return;
    try {
      if (typeof command.run === 'function') await command.run(app);
      else if (Object.hasOwn(handlers, command.action)) await handlers[command.action]();
    } catch { if (!destroyed) showToast('app.commandFailed'); }
  }
  function shortcut(event) {
    if (event.defaultPrevented || phase !== 'ready') return;
    const command = registry.list().find((item) => matchesShortcut(event, item.shortcut, { mac }));
    if (!command || isEditable(event.target) && !command.editable) return;
    if (doc.querySelector('[aria-modal="true"]')) {
      if (palette && command.id === 'palette') { event.preventDefault(); palette.close('shortcut'); }
      return;
    }
    event.preventDefault(); void runCommand(command);
  }
  function activeRoute() {
    if (route.name === 'page') return route.id;
    if (route.name === 'space') return SPACE_PAGES[route.ref.k] ?? 'dashboard';
    return route.name;
  }
  const navLink = (item, active) => el('a.app-nav-link', { href: item.hash, 'aria-current': item.id === active ? 'page' : null }, icon(item.icon, 19), el('span', {}, t(item.labelKey)));
  function renderNavigation(className) {
    const active = activeRoute();
    return el(`nav.${className}`, { 'aria-label': t('app.primaryNav') }, routes.map((item) => navLink(item, active)));
  }
  /** Phone tab bar in the user's order (`tabOrder`); past five routes the last slot is a "More" menu. */
  function renderTabbar() {
    const active = activeRoute();
    const ordered = orderTabs(routes);
    const shown = ordered.length > TABBAR_SLOTS ? ordered.slice(0, TABBAR_SLOTS - 1) : ordered;
    const rest = ordered.slice(shown.length);
    const items = shown.map((item) => navLink(item, active));
    if (rest.length) {
      const more = el('button.app-nav-link.app-nav-more', {
        type: 'button', 'aria-current': rest.some((item) => item.id === active) ? 'page' : null,
        onclick: () => openMenu(more, rest.map((item) => ({ label: t(item.labelKey), icon: item.icon, onSelect: () => navigate(item.hash) }))),
      }, icon('menu', 19), el('span', {}, t('app.more')));
      items.push(more);
    }
    return el('nav.app-tabbar', { 'aria-label': t('app.primaryNav'), style: { '--tabbar-cols': String(items.length) } }, items);
  }
  function renderReady({ focus = false } = {}) {
    if (!sessionValid()) return;
    unmountView(); settings = null;
    const onTrip = route.name === 'space' && route.ref.k === 'trip' && Boolean(session);
    if (!onTrip && tripRoute?.active) tripRoute.leave();
    if (!onTrip && session) sync = { status: 'idle', pending: 0 };
    let title = t('app.trips'); let content; let mount = null;
    const dashboard = routes.find((item) => item.id === 'dashboard');
    const tab = tripTabs.find((item) => item.id === route.tab);
    // An unknown trip tab (an old or edited link) opens the default tab.
    if (onTrip && !tab) {
      const fallback = [defaultTripTab(undefined, tripTabs), tripTabs[0]?.id].find((id) => tripTabs.some((item) => item.id === id));
      if (fallback) { navigate(routeHash({ ...route, tab: fallback }), { replace: true }); return; }
    }
    // Pages (`#/atlas`), `#/collections`, and collection or journey spaces, which their list page's module mounts.
    const pageId = route.name === 'page' ? route.id : route.name === 'collections' ? 'collections' : route.name === 'space' ? SPACE_PAGES[route.ref.k] : null;
    const page = pageId && session ? routes.find((item) => item.id === pageId && typeof item.load === 'function') : null;
    if (route.name === 'dashboard') {
      content = el('div.shell-view'); mount = dashboard?.load ? { node: content, load: dashboard.load } : null;
    } else if (route.name === 'settings' && settingsSections.some((item) => item.id === route.section)) {
      title = t('app.settings');
      settings = settingsView({ section: route.section, sections: settingsSections, account, puter: sdk, theme: currentTheme(), onTheme: saveTheme, onSignOut: signOut,
        preference, onRetry: () => saveTheme(pendingTheme ?? desiredTheme), onReload: loadPreferences }); content = settings.element;
      if (settings.mountTarget) mount = { node: settings.mountTarget, load: settingsSections.find((item) => item.id === route.section).load };
    } else if (onTrip && tab) {
      ({ title, content, mount } = tripRoute.render(route, tripTabs));
    } else if (page) {
      title = t(page.labelKey); content = el('div.shell-view'); mount = { node: content, load: page.load };
    } else if (route.name === 'join') {
      title = t('join.title'); content = el('div.shell-view'); mount = { node: content, load: () => import('./views/join/index.js') };
    } else { title = t('app.invalidLink'); content = unavailableView('app.invalidLink', 'app.invalidLinkBody', navigate); }
    inbox ??= createInboxEntry(() => ({ app: viewApi, account: account ? { ...account } : null, puter: sdk, personal, session }));
    const heading = el('h1', { tabIndex: -1 }, title);
    const pageTitle = title;
    const main = el('main.app-main', { id: 'app-content', tabIndex: -1 },
      el('header.app-view-head', {}, heading, el('div.app-header-actions', {}, inbox.element, iconButton('search', t('app.commandPalette'), { onclick: openPalette }), iconButton('help', t('app.shortcuts'), { onclick: openHelp }))), content);
    const status = el('span.save-state', { role: 'status' });
    const retry = button(t('app.syncRetry'), { size: 'sm', variant: 'ghost', hidden: true, onclick: async () => {
      const retrySync = onRetrySync ?? (tripRoute?.active ? () => tripRoute.retry() : null);
      if (!sessionValid() || !retrySync) return;
      try { await retrySync(); } catch { if (!destroyed) setSyncState('offline'); }
    } });
    const accountLabel = el('span.app-account-name', {}, account.username || t('app.account'));
    const sidebar = el('aside.app-sidebar', {},
      el('div.app-brand', {}, el('img', { src: new URL('icons/icon-192.png', doc.baseURI).href, width: 32, height: 32, alt: '' }), el('span', {}, t('app.name')), el('span.preview-badge', {}, t('app.previewBadge'))),
      renderNavigation('app-side-nav'),
      el('div.app-sidebar-bottom', {}, el('div.app-account', {}, avatar({ id: account.uuid, name: account.username || t('app.account'), size: 28 }), accountLabel)),
    );
    shell = { status, retry, heading, title: pageTitle };
    root.replaceChildren(el('a.skip-link', { href: '#app-content', onclick: (event) => { event.preventDefault(); main.focus(); } }, t('app.skip')),
      el('div.app-shell', {}, sidebar, el('div.app-content', {}, offlineBar(), main, el('footer.app-sync', {}, status, retry)), renderTabbar()));
    doc.title = `${title} · ${t('app.name')}`; updateStatus(); settled();
    root.querySelector('.trip-tab[aria-current=page]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (focus) heading.focus();
    if (mount) void mountView(mount.node, mount.load, mount.prepare);
  }
  /** Trip pages rename their heading once the trip meta loads. */
  function setPageTitle(text) {
    if (!shell?.heading || route.name !== 'space' || shell.title === text) return;
    shell.title = text; shell.heading.textContent = text; doc.title = `${text} · ${t('app.name')}`;
  }
  /** Public trip links (`#/s/…`) need no account. */
  function renderPublic() {
    phase = 'public'; route = router.route; sdk = injectedPuter ?? globalThis.puter;
    const content = el('div.public-shell');
    root.replaceChildren(offlineBar(), content);
    doc.title = t('public.docTitle'); settled();
    void mountView(content, () => import('./views/public/index.js'));
  }
  const router = createRouter({ window: targetWindow, onRoute: (next) => {
    const previous = route; route = next;
    if ((next.name === 'public') !== (phase === 'public') && !['idle', 'destroyed'].includes(phase)) { void start(); return; }
    if (phase === 'public') { closeDialogs(); renderPublic(); return; }
    if (phase === 'ready') { closeDialogs(); renderReady({ focus: Boolean(previous) }); }
  } });
  const themeUnsubscribe = onThemeChange(({ theme }) => settings?.setTheme(theme));
  // A language change redraws the current view in the new language.
  const localeUnsubscribe = onLocaleChange(() => {
    if (phase === 'ready') { closeDialogs(); inbox?.destroy(); inbox = null; renderReady(); } else if (phase === 'public') renderPublic();
  });
  function connectivity(event) { online = event.type === 'online'; updateStatus(); }
  function focused() { if (phase === 'ready') sessionValid(); }
  targetWindow.addEventListener('online', connectivity); targetWindow.addEventListener('offline', connectivity); targetWindow.addEventListener('focus', focused);
  doc.addEventListener('keydown', shortcut);
  router.start();
  function start() {
    if (destroyed) return Promise.reject(new Error('App is destroyed'));
    const version = ++epoch; resetAccount(); phase = 'booting'; doc.documentElement.dataset.boot = 'loading';
    root.replaceChildren(offlineBar(), authView({ loading: true }));
    bootPromise = (async () => {
      let stage = 'sdk';
      try {
        if (router.route.name === 'public') { renderPublic(); return; }
        sdk = getPuter(injectedPuter ?? globalThis.puter);
        // Loaded alongside sign-in; started once the session exists.
        const background = Promise.resolve().then(loadBackground).catch(() => null);
        stage = 'auth';
        if (!await sdk.auth.isSignedIn()) {
          if (alive(version)) { phase = 'signedOut'; showAuth({ onSignIn: signIn }); }
          return;
        }
        const token = sdk.authToken;
        const identity = await accountIdentity(sdk).then((found) => {
          // A token swapped during the request may have answered for another account; never pair the two.
          if (sdk.authToken === token) void rememberIdentity(found, token);
          return found;
        }, async (error) => {
          // Offline (or "Work offline") the same token may still open this device's data; a refused token never does.
          if ([401, 403].includes(error?.status)) throw error;
          const remembered = online && !(error instanceof TypeError) ? null : await lastIdentity(token);
          if (!remembered || sdk.authToken !== token) throw error;
          return remembered;
        });
        if (!alive(version)) return;
        if (token !== sdk.authToken) throw new Error('account_changed');
        stage = 'storage';
        const opened = await openDatabase(identity.uuid);
        if (!alive(version)) { opened.close(); return; }
        if (token !== sdk.authToken) { opened.close(); throw new Error('account_changed'); }
        db = opened; account = { uuid: identity.uuid, username: typeof identity.username === 'string' ? identity.username : '' }; accountToken = token; personal = createPersonalStore({ puter: sdk, db });
        prefsBinding = bindPrefs({ personal, account: identity.uuid, window: targetWindow });
        const startHash = targetWindow.location.hash ? null : await startPageHash({ personal, ready: prefsBinding.ready });
        if (!alive(version)) return;
        if (startHash && !targetWindow.location.hash) targetWindow.history.replaceState(null, '', startHash);
        stage = 'session';
        const created = await createSession({ puter: sdk, account: { ...account }, db, personal });
        if (!alive(version)) { created.close(); return; }
        session = created;
        tripRoute = createTripRoute({ session, app: viewApi, puter: sdk, setSyncState, navigate, onTitle: setPageTitle, onRefused: showToast, reload });
        const runtime = await background;
        if (!alive(version)) return;
        try { stopBackground = runtime?.startBackground({ session, puter: sdk, app: viewApi }) ?? null; } catch { stopBackground = null; }
        phase = 'ready'; route = router.route; renderReady({ focus: true }); await loadPreferences();
      } catch (error) {
        if (!alive(version)) return;
        prefsBinding?.close(); prefsBinding = null;
        session?.close(); session = null; tripRoute = null;
        db?.close(); db = null; account = null; personal = null; accountToken = null;
        if (stage === 'auth' && error?.status === 401) { phase = 'signedOut'; showAuth({ error: 'app.sessionExpired', onSignIn: signIn }); }
        else { phase = 'error'; showAuth({ error: stage === 'sdk' ? 'app.sdkUnavailable' : stage === 'storage' ? 'app.storageError' : 'app.accountError', onRetry: () => { if (stage === 'sdk') reload(); else void start(); } }); }
      }
    })();
    return bootPromise;
  }
  const viewApi = Object.freeze({ navigate, setSyncState, commands: registry });
  const app = {
    start, navigate, setSyncState, commands: registry,
    get ready() { return bootPromise; },
    get state() { return { phase, account: account ? { ...account } : null, online, route: router.route, sync: { ...sync }, preference: { ...preference } }; },
    destroy() {
      if (destroyed) return; destroyed = true; epoch += 1; phase = 'destroyed'; resetAccount(); router.destroy(); themeUnsubscribe(); localeUnsubscribe();
      targetWindow.removeEventListener('online', connectivity); targetWindow.removeEventListener('offline', connectivity); targetWindow.removeEventListener('focus', focused);
      doc.removeEventListener('keydown', shortcut); root.replaceChildren();
    },
  };
  return app;
}
export async function bootApp({ root = document.getElementById('app'), puter = globalThis.puter, ...options } = {}) {
  // Service worker, update prompt and "Work offline"; runs before the shell reads `navigator.onLine`.
  void startPwa();
  const app = createApp({ root, puter, ...options }); await app.start(); return app;
}

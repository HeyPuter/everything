import { el, clear } from './dom.js';
import { icon, appIcon } from './icons.js';
import { store } from '../lib/store.js';
import { signlinks } from '../lib/services.js';
import { toast } from './toast.js';
import { confirmDialog } from './modal.js';
import { openOnboarding } from './onboarding.js';
import { openNewDocModal } from './newdoc.js';
import { afterPull, runTimers } from './actions.js';
import { documentsView } from '../views/documents.js';
import { detailView } from '../views/detail.js';
import { editorView } from '../views/editor.js';
import { selfSignView } from '../views/selfsign.js';
import { settingsView, confirmSignOut } from '../views/settings.js';
import { userMenu } from './usermenu.js';

const PULL_INTERVAL_MS = 60_000;

function parseRoute(hash) {
  const clean = (hash || '#/').split('?')[0];
  if (clean === '#/settings') return { name: 'settings' };
  const doc = /^#\/doc\/([A-Za-z0-9._-]+)(?:\/(edit|sign))?$/.exec(clean);
  if (doc) return { name: doc[2] || 'detail', docId: doc[1] };
  return { name: 'documents' };
}

export function mountShell(appRoot) {
  const sampleBanner = el('div');
  const viewWrap = el('div');
  // puter.js's <puter-user-menu> where the SDK has it (usermenu.js): the
  // account and the Apps launcher, laid over the far end of the view's head
  // on the desktop layout (shell.css), which keeps that much room free. Made
  // once, with the shell: the element loads the account each time it joins
  // the page. Its Sign out is the app's, asked first; a sign-in or sign-out
  // it did by itself leaves the page holding another account's documents, so
  // the page starts over.
  const accountMenu = userMenu({ onSignOut: confirmSignOut, onSessionChanged: () => location.reload() });
  // After the sample banner, so that it is the view's head it lies over.
  const main = el('main.main', { id: 'main' },
    sampleBanner,
    accountMenu && el('div.main-account', {}, el('div.main-account-inner', {}, accountMenu)),
    viewWrap);
  if (accountMenu && typeof ResizeObserver === 'function') {
    // Sign in is wider than the picture, and the Apps launcher is not always there.
    new ResizeObserver(() => {
      const width = accountMenu.getBoundingClientRect().width;
      if (width) main.style.setProperty('--account-w', `${Math.ceil(width)}px`);
    }).observe(accountMenu);
  }
  let currentView = null;

  function navigate(hash) {
    if (location.hash === hash) renderRoute();
    else location.hash = hash;
  }

  /* Sample-data banner: always visible while exploring, one-tap wipe. */
  function renderSampleBanner() {
    clear(sampleBanner);
    if (!store.settings.sampleData) return;
    sampleBanner.append(el('div.sample-banner', { style: { maxWidth: 'var(--content-max)', margin: '0 auto 16px' } },
      el('span', { html: icon('sparkle', 14, 2.2) }),
      el('span.grow', {}, 'Sample documents: explore freely, nothing here is real'),
      el('button', {
        type: 'button',
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Start fresh?',
            message: 'All sample documents are removed and you start with your own.',
            confirmLabel: 'Remove samples',
          });
          if (!ok) return;
          try {
            await store.wipeSampleData();
          } catch (err) {
            console.error(err);
            toast('Could not remove them. Check your connection', { icon: 'wifiOff' });
            return;
          }
          openOnboarding();
        },
      }, 'Start fresh')));
  }
  store.addEventListener('change', renderSampleBanner);
  renderSampleBanner();

  /* Sidebar (desktop) */
  const username = store.user?.username || 'Puter user';
  const inPuterApp = typeof puter !== 'undefined' && puter.env === 'app';
  const sidebarNav = el('div', { style: { display: 'contents' } });
  const sidebar = el('nav.sidebar', { 'aria-label': 'Main navigation' },
    el('div.brand', {},
      el('span.brand-mark', { html: appIcon(32), 'aria-hidden': 'true' }),
      'Signatures'),
    sidebarNav,
    el('div.sidebar-spacer'),
    el('button.btn.btn-primary.sidebar-new', {
      type: 'button', html: icon('plus', 17, 2.2),
      onclick: () => openNewDocModal({ navigate }),
    }, ' New document'),
    // Beside <puter-user-menu> the account is the element's to name and sign out.
    !accountMenu && el('div.sidebar-user', {},
      el('span.avatar', {}, username.charAt(0).toUpperCase()),
      el('span.name', { title: username }, username),
      // Inside the Puter desktop the platform owns the session; no sign-out.
      !inPuterApp && el('button.icon-btn', {
        type: 'button', html: icon('logout', 18, 2),
        'aria-label': 'Sign out', title: 'Sign out',
        onclick: confirmSignOut,
      }))
  );

  /* Tab bar (mobile) */
  const tabbar = el('nav.tabbar', { 'aria-label': 'Main navigation' });

  const NAV = [
    { hash: '#/', label: 'Documents', icon: 'home', match: (r) => r.name !== 'settings' },
    { hash: '#/settings', label: 'Settings', icon: 'gear', match: (r) => r.name === 'settings' },
  ];

  function renderNav() {
    const route = parseRoute(location.hash);
    clear(sidebarNav);
    clear(tabbar);
    for (const item of NAV) {
      const active = item.match(route);
      sidebarNav.append(el('a.nav-item', {
        href: item.hash,
        className: `nav-item${active ? ' active' : ''}`,
        html: icon(item.icon, 20, 1.9),
        'aria-current': active ? 'page' : null,
      }, el('span', {}, item.label)));
    }
    tabbar.append(el('a.tab-item', {
      href: '#/',
      className: `tab-item${route.name !== 'settings' ? ' active' : ''}`,
      html: icon('home', 22, 1.9),
      'aria-current': route.name !== 'settings' ? 'page' : null,
    }, el('span', {}, 'Documents')));
    tabbar.append(el('button.tab-item', {
      type: 'button',
      html: icon('plus', 22, 2.1),
      onclick: () => openNewDocModal({ navigate }),
    }, el('span', {}, 'New')));
    tabbar.append(el('a.tab-item', {
      href: '#/settings',
      className: `tab-item${route.name === 'settings' ? ' active' : ''}`,
      html: icon('gear', 22, 1.9),
      'aria-current': route.name === 'settings' ? 'page' : null,
    }, el('span', {}, 'Settings')));
  }

  const VIEWS = {
    documents: documentsView,
    detail: detailView,
    edit: editorView,
    sign: selfSignView,
    settings: settingsView,
  };

  function renderRoute() {
    const route = parseRoute(location.hash);
    renderNav();
    currentView?.destroy?.();
    clear(viewWrap);
    currentView = VIEWS[route.name]({ navigate, docId: route.docId });
    viewWrap.append(currentView);
    window.scrollTo({ top: 0 });
  }

  clear(appRoot);
  appRoot.append(el(accountMenu ? 'div.shell.has-user-menu' : 'div.shell', {}, sidebar, main), tabbar);

  window.addEventListener('hashchange', renderRoute);
  renderRoute();

  /* Background pull: signer activity lands without a manual refresh, and the
     clock-driven work (expiry, due reminders) rides along with it. */
  const pullTimer = setInterval(() => {
    const hasSent = store.listDocs().some((d) => (d.status === 'sent' || d.status === 'expired') && !d.sample);
    if (!hasSent || !navigator.onLine) return;
    signlinks.pull().then(afterPull).catch(() => {});
    runTimers().catch(() => {});
  }, PULL_INTERVAL_MS);
  window.addEventListener('beforeunload', () => clearInterval(pullTimer));
}

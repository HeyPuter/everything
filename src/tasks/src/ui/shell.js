import { el, clear } from '../lib/dom.js';
import { icon } from './icons.js';
import iconUrl from '../assets/icon-192.png';
import { toast } from './toast.js';
import { applyTheme } from './theme.js';
import { openModal, confirmDialog, closeAllModals } from './modal.js';
import { store } from '../lib/store.js';
import { todayISO, isOverdue, isDueToday } from '../lib/dates.js';
import { fuzzyIncludes } from '../lib/util.js';
import { openTaskForm } from './taskform.js';
import { openListForm } from './listform.js';
import { openOnboarding } from './onboarding.js';
import { makeSortable } from './sortable.js';
import { taskRow } from './taskrow.js';
import { todayView } from '../views/today.js';
import { upcomingView } from '../views/upcoming.js';
import { listsView, listDetailView } from '../views/lists.js';
import { calendarView } from '../views/calendar.js';
import { logbookView } from '../views/logbook.js';
import { settingsView } from '../views/settings.js';
import { sharedView } from '../views/shared.js';
import { joinView, approveView } from '../views/collab.js';
import { tagView } from '../views/tag.js';

/* The mobile tab bar holds four destinations plus More; routes marked
   tab: false live in the More sheet there. The desktop sidebar shows
   everything. */
const ROUTES = [
  { hash: '#/', label: 'Today', icon: 'checkBig', view: todayView },
  { hash: '#/upcoming', label: 'Upcoming', icon: 'calendarClock', view: upcomingView },
  { hash: '#/lists', label: 'Lists', icon: 'grid', view: listsView },
  { hash: '#/calendar', label: 'Calendar', icon: 'calendar', view: calendarView },
  { hash: '#/logbook', label: 'Logbook', icon: 'history', view: logbookView, tab: false },
  { hash: '#/settings', label: 'Settings', icon: 'gear', view: settingsView, tab: false },
];

const MORE_SUBS = {
  '#/logbook': 'Everything you have completed',
  '#/settings': 'Appearance, reminders, calendar feed, your data',
};

export function mountShell(appRoot) {
  const sampleBanner = el('div');
  const viewWrap = el('div');
  const content = el('div.content', {}, sampleBanner, viewWrap);
  const main = el('main.main', { id: 'main' }, content);
  const sidebarNav = el('nav', { 'aria-label': 'Main' });
  const sidebar = el('aside.sidebar', {},
    el('div.brand', {},
      el('img.brand-mark', { src: iconUrl, width: 28, height: 28, alt: '' }),
      'Tasks'
    ),
    el('button.btn.btn-primary.btn-block.sidebar-new', {
      html: icon('plus', 16, 2.4),
      onclick: () => openTaskForm({}),
    }, ' New task'),
    sidebarNav,
    el('div.sidebar-foot', {},
      el('button.nav-item', { html: icon('search', 18), onclick: openSearch },
        el('span', {}, 'Search'),
        el('span.count', {}, el('span.kbd', {}, '/'))
      )
    )
  );

  const tabbar = el('nav.tabbar', { 'aria-label': 'Main' });
  const fab = el('button.fab', {
    html: icon('plus', 24, 2.4), 'aria-label': 'New task',
    onclick: () => openTaskForm({}),
  });

  appRoot.replaceChildren(
    // The app routes on location.hash, so a plain #main anchor would be
    // swallowed by the router (and land on Today). Move focus directly.
    el('a.skip-link', {
      href: '#main',
      onclick: (e) => {
        e.preventDefault();
        main.setAttribute('tabindex', '-1');
        main.focus();
      },
    }, 'Skip to content'),
    el('div.shell', {}, sidebar, main),
    tabbar,
    fab
  );

  /* ---------- sample-data banner ---------- */

  function renderSampleBanner() {
    clear(sampleBanner);
    if (!store.settings.sampleData) return;
    sampleBanner.append(el('div.sample-banner', {},
      el('span', { html: icon('sparkle', 14, 2.2), style: { color: 'var(--accent)', display: 'inline-flex' } }),
      el('span.grow', {}, 'Sample data: explore freely, nothing here is yours'),
      el('button', {
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Start fresh?',
            message: 'All sample data is removed and you start with a clean slate.',
            confirmLabel: 'Wipe sample data',
          });
          if (!ok) return;
          try {
            await store.wipeAll();
          } catch (err) {
            console.error(err);
            toast('Could not wipe. Check your connection', { icon: 'wifiOff' });
            return;
          }
          location.hash = '#/';
          openOnboarding();
        },
      }, 'Start fresh')
    ));
  }

  /* ---------- navigation ---------- */

  function todayCount() {
    const today = todayISO();
    return store.tasks.filter((t) => !t.done && (isOverdue(t, today) || isDueToday(t, today))).length;
  }

  function routeFor(hash) {
    const clean = (hash || '#/').split('?')[0];
    if (clean.startsWith('#/list/')) {
      return { hash: clean, label: 'List', view: (nav) => listDetailView(clean.slice('#/list/'.length), nav) };
    }
    if (clean.startsWith('#/shared')) {
      return { hash: clean, label: 'Shared list', view: sharedView, bare: true };
    }
    if (clean.startsWith('#/tag/')) {
      let tag = clean.slice('#/tag/'.length);
      // A mangled link ('#/tag/%zz') must not throw out of the router and
      // blank the whole app; the raw segment just shows an empty tag view.
      try { tag = decodeURIComponent(tag); } catch { /* keep raw */ }
      return { hash: clean, label: 'Tag', view: (nav) => tagView(tag, nav) };
    }
    if (clean.startsWith('#/join')) {
      return { hash: clean, label: 'Join list', view: joinView };
    }
    if (clean.startsWith('#/approve')) {
      return { hash: clean, label: 'Approve member', view: approveView };
    }
    return ROUTES.find((r) => r.hash === clean) || ROUTES[0];
  }

  function renderNav() {
    const current = routeFor(location.hash).hash;
    const n = todayCount();

    clear(sidebarNav);
    for (const r of ROUTES) {
      sidebarNav.append(el('a.nav-item', {
        href: r.hash,
        'aria-current': current === r.hash ? 'page' : null,
        html: icon(r.icon, 18),
      },
        el('span', {}, r.label),
        r.hash === '#/' && n > 0 ? el('span.count', {}, String(n)) : null
      ));
    }
    sidebarNav.append(el('div.nav-section', {},
      el('span', {}, 'My lists'),
      el('button.icon-btn', {
        html: icon('plus', 15, 2.4), 'aria-label': 'New list',
        style: { width: '26px', height: '26px' },
        onclick: () => openListForm({}),
      })
    ));
    for (const l of store.lists) {
      const open = store.tasks.filter((t) => t.listId === l.id && !t.done).length;
      sidebarNav.append(el('a.nav-item', {
        href: `#/list/${l.id}`,
        dataset: { listId: l.id },
        'aria-current': current === `#/list/${l.id}` ? 'page' : null,
      },
        el('span.nav-dot', { style: { background: `var(--slot-${l.slot})` } }),
        el('span.grow', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          l.name,
          l.collab ? el('span.shared-mark', { html: icon('users', 12, 2.2), title: 'Shared: everyone can edit', style: { marginLeft: '6px' } })
            : l.shared ? el('span.shared-mark', { html: icon('eye', 12, 2.2), title: 'Shared as a view-only link', style: { marginLeft: '6px' } }) : null
        ),
        open ? el('span.count', {}, String(open)) : null
      ));
    }

    clear(tabbar);
    for (const r of ROUTES.filter((x) => x.tab !== false)) {
      tabbar.append(el('a.tab-item', {
        href: r.hash,
        'aria-current': current === r.hash ? 'page' : null,
        html: icon(r.icon, 21),
      }, el('span', {}, r.label)));
    }
    tabbar.append(el('button.tab-item', {
      html: icon('more', 21),
      'aria-haspopup': 'dialog',
      onclick: openMoreSheet,
    }, el('span', {}, 'More')));

    document.title = n > 0 ? `(${n}) Tasks` : 'Tasks';
  }

  function openMoreSheet() {
    const body = el('div.card', {},
      ROUTES.filter((r) => r.tab === false).map((r) =>
        el('button.setting-row', {
          onclick: () => { modal.close(); location.hash = r.hash; },
        },
          el('span.s-icon', { html: icon(r.icon, 19) }),
          el('div', {},
            el('div.s-label', {}, r.label),
            el('div.s-sub', {}, MORE_SUBS[r.hash] || '')
          ),
          el('span.s-end', { html: icon('chevR', 17) })
        ))
    );
    body.append(el('button.setting-row', { onclick: () => { modal.close(); openSearch(); } },
      el('span.s-icon', { html: icon('search', 19) }),
      el('div', {}, el('div.s-label', {}, 'Search'), el('div.s-sub', {}, 'Find any task by name or notes')),
      el('span.s-end', { html: icon('chevR', 17) })
    ));
    const modal = openModal({ title: 'More', content: body });
  }

  /* ---------- view rendering ---------- */

  let renderQueued = false;
  let lastViewHash = null;

  function renderView() {
    const route = routeFor(location.hash);
    // Store changes re-render the view wholesale — including merges that
    // land while the user is typing into the quick-add bar (a focus
    // refresh resolving, a collab sync). Same-route re-renders restore
    // the half-typed draft, caret and focus instead of eating it.
    const prev = document.getElementById('quick-add-input');
    const draft = route.hash === lastViewHash && prev?.value ? {
      value: prev.value,
      focused: document.activeElement === prev,
      start: prev.selectionStart,
      end: prev.selectionEnd,
      // Chips the user dismissed stay dismissed; re-parsing from the
      // text alone would resurrect them and silently re-apply a due
      // date (or list, or tag) they deliberately turned back into text.
      dismissed: prev.dismissedChips ? [...prev.dismissedChips] : [],
    } : null;
    lastViewHash = route.hash;
    clear(viewWrap);
    const node = route.view({ navigate: (h) => { location.hash = h; } });
    viewWrap.append(node);
    if (draft) {
      const input = document.getElementById('quick-add-input');
      if (input && !input.value) {
        input.value = draft.value;
        for (const key of draft.dismissed) input.dismissedChips?.add(key);
        input.dispatchEvent(new Event('input')); // rebuild the parse chips
        if (draft.focused) {
          input.focus();
          input.setSelectionRange(draft.start, draft.end);
        }
      }
    }
    sampleBanner.style.display = route.bare ? 'none' : '';
  }

  function renderAll() {
    renderSampleBanner();
    renderNav();
    renderView();
  }

  window.addEventListener('hashchange', () => {
    // Navigating away (e.g. tapping a tag chip inside the search sheet)
    // must not leave dialogs floating over the new view.
    closeAllModals();
    main.scrollTop = 0;
    window.scrollTo(0, 0);
    renderAll();
  });

  store.addEventListener('change', () => {
    // Coalesce bursts (e.g. import) into one re-render per frame.
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderAll();
    });
  });

  // Merges arrive from other devices and from shared-list members; keep the
  // notice quiet during active collaboration.
  let lastRemoteToast = 0;
  store.addEventListener('remote-change', () => {
    // Settings synced from elsewhere may carry a theme change.
    applyTheme(store.settings.theme || 'system');
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastRemoteToast < 30000) return;
    lastRemoteToast = Date.now();
    toast('Updated with the latest changes', { icon: 'cloud' });
  });

  store.addEventListener('collab-joined', (e) => {
    const { name, owner } = e.detail;
    toast(owner ? `${owner} shared "${name}" with you` : `"${name}" was shared with you`, { icon: 'users', duration: 6000 });
  });

  store.addEventListener('collab-ended', (e) => {
    toast(`"${e.detail.name}" is no longer shared. You keep your copy`, { icon: 'users', duration: 6000 });
  });

  /* ---------- search ---------- */

  function openSearch() {
    const results = el('div');
    const input = el('input.input', {
      placeholder: 'Search tasks… (#tag filters by tag)', 'aria-label': 'Search tasks',
      oninput: () => renderResults(input.value),
    });
    const body = el('div', {},
      el('div.search-input-wrap', { html: icon('search', 17) }, input),
      results
    );

    function renderResults(q) {
      clear(results);
      const query = q.trim();
      if (!query) return;
      const byTag = query.startsWith('#');
      const needle = query.slice(1).toLowerCase();
      const matches = store.tasks
        .filter((t) => byTag
          ? needle === '' ? t.tags?.length : t.tags?.some((x) => x.startsWith(needle))
          : fuzzyIncludes(t.title, query) || fuzzyIncludes(t.notes, query))
        .sort((a, b) => Number(a.done) - Number(b.done))
        .slice(0, 30);
      if (!matches.length) {
        results.append(el('p.small.muted', { style: { textAlign: 'center', padding: '18px 0' } },
          'Nothing found'));
        return;
      }
      results.append(el('div.card', {}, matches.map((t) => taskRow(t, { showList: true }))));
    }

    openModal({ title: 'Search', content: body });
    input.focus();
  }

  /* ---------- sidebar list reordering ---------- */

  makeSortable(sidebarNav, {
    itemSelector: '[data-list-id]',
    onDrop: (item, prev, next) => store.reorderList(item.dataset.listId, {
      prevId: prev?.dataset.listId || null,
      nextId: next?.dataset.listId || null,
    }),
  });

  /* ---------- reminder notifications ---------- */

  // Clicking a reminder notification lands on the task itself.
  window.addEventListener('tasks:open-task', (e) => {
    const task = store.taskById(e.detail?.id);
    if (task) openTaskForm({ task });
  });

  /* ---------- keyboard shortcuts ---------- */

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target;
    if (target instanceof HTMLElement &&
      (target.matches('input, select, textarea') || target.isContentEditable)) return;
    if (document.querySelector('.modal-root:not(.closing)')) return;
    if (e.key === 'n') {
      e.preventDefault();
      // The fastest capture path wins: the view's quick-add bar when there
      // is one, the full form elsewhere.
      const quickAdd = document.getElementById('quick-add-input');
      if (quickAdd) quickAdd.focus();
      else openTaskForm({});
    } else if (e.key === '/') {
      e.preventDefault();
      openSearch();
    }
  });

  renderAll();
}

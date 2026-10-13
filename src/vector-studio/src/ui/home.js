/**
 * Home screen shown when no document is open (and from the Home button):
 * new-file presets, open, and recent files. The file module fills the
 * recent list through `app.recentFiles()` when storage is available.
 */
import { h } from '../lib/dom.js';
import { icon } from './icons.js';

export const QUICK_PRESETS = [
  { name: 'Letter', width: 612, height: 792, units: 'pt', note: '8.5 x 11 in' },
  { name: 'A4', width: 595.28, height: 841.89, units: 'mm', note: '210 x 297 mm' },
  { name: 'Postcard', width: 288, height: 560, units: 'pt', note: '288 x 560 pt' },
  { name: 'Web', width: 1920, height: 1080, units: 'px', note: '1920 x 1080 px' },
  { name: 'Mobile', width: 390, height: 844, units: 'px', note: '390 x 844 px' },
  { name: 'Square', width: 1080, height: 1080, units: 'px', note: '1080 x 1080 px' },
  { name: 'Icon', width: 512, height: 512, units: 'px', note: '512 x 512 px' },
  { name: 'Poster', width: 1296, height: 1728, units: 'in', note: '18 x 24 in' },
];

export function installHome(app) {
  app.renderHome = (host) => renderHome(app, host);
}

function presetThumb(p) {
  const max = 64;
  const s = max / Math.max(p.width, p.height);
  return h('span.preset-thumb', { 'aria-hidden': 'true' }, h('span.preset-page', { style: { width: `${Math.max(8, p.width * s)}px`, height: `${Math.max(8, p.height * s)}px` } }));
}

/** Recent files sorted and filtered for display. */
export function arrangeRecent(items, { sort = 'recent', filter = '' } = {}) {
  const q = filter.trim().toLowerCase();
  const out = q ? items.filter((it) => String(it.name || '').toLowerCase().includes(q)) : items.slice();
  if (sort === 'name') out.sort((x, y) => String(x.name).localeCompare(String(y.name), undefined, { numeric: true, sensitivity: 'base' }));
  return out;
}

async function renderHome(app, host) {
  const prefs = app.prefs;
  const view = { mode: prefs?.get('homeRecentView') === 'list' ? 'list' : 'grid', sort: prefs?.get('homeRecentSort') === 'name' ? 'name' : 'recent', filter: '' };
  const recentList = h('div.recent-list', { 'aria-label': 'Recent files' }, h('p.muted', 'Loading recent files...'));
  recentList.classList.toggle('list-view', view.mode === 'list');
  const presetCards = QUICK_PRESETS.map((p) =>
    h(
      'button.preset-card',
      {
        type: 'button',
        onclick: () => app.newDocument({ name: undefined, width: p.width, height: p.height, units: p.units }),
      },
      presetThumb(p),
      // The name comes from the visible text (voice control users say what they see).
      h('span.preset-name', p.name),
      ' ',
      h('span.preset-note', p.note),
    ),
  );
  // Every other size and setting is one click away in the New Document dialog.
  const more = h('button.preset-card.preset-more', { type: 'button', onclick: () => app.commands.run('file.new') }, h('span.preset-thumb', { 'aria-hidden': 'true' }, icon('ellipsis', 24)), h('span.preset-name', 'More Presets'), ' ', h('span.preset-note', 'All sizes and settings'));
  const presets = h('div.preset-row', { id: 'home-presets' }, presetCards, more);
  const hideStarts = prefs?.get('homeHidePresets') === true;
  presets.hidden = hideStarts;
  const toggle = h('button.btn.small.ghost.home-toggle', { type: 'button', 'aria-expanded': String(!hideStarts), 'aria-controls': 'home-presets' }, hideStarts ? 'Show' : 'Hide');
  toggle.addEventListener('click', () => {
    presets.hidden = !presets.hidden;
    toggle.textContent = presets.hidden ? 'Show' : 'Hide';
    toggle.setAttribute('aria-expanded', String(!presets.hidden));
    prefs?.set('homeHidePresets', presets.hidden);
  });

  // Recent files: filter, sort and grid/list view.
  const filterInput = h('input.home-filter', { type: 'search', placeholder: 'Filter recent files', 'aria-label': 'Filter recent files', autocomplete: 'off', spellcheck: false });
  const sortSel = h('select.select.home-sort', { 'aria-label': 'Sort recent files' }, h('option', { value: 'recent', selected: view.sort === 'recent' }, 'Last opened'), h('option', { value: 'name', selected: view.sort === 'name' }, 'Name'));
  const viewBtns = [
    ['grid', 'layout-grid', 'Thumbnails'],
    ['list', 'menu', 'List'],
  ].map(([mode, ic, label]) => h('button.icon-btn.home-view', { type: 'button', 'aria-label': label, 'data-tip': label, 'aria-pressed': String(view.mode === mode), dataset: { mode } }, icon(ic, 16)));
  const recentTools = h('div.home-recent-tools', filterInput, sortSel, h('div.home-views', { role: 'group', 'aria-label': 'View' }, viewBtns));

  const side = h(
    'nav.home-side',
    { 'aria-label': 'Home' },
    h('button.btn.primary.block', { type: 'button', onclick: () => app.commands.run('file.new') }, icon('plus', 16), 'New file'),
    app.commands.get('file.open') ? h('button.btn.block', { type: 'button', onclick: () => app.commands.run('file.open') }, icon('folder-open', 16), 'Open') : null,
    app.editors.length ? h('button.btn.block.ghost', { type: 'button', onclick: () => app.activate(app.editor || app.editors[0]) }, icon('chevron-left', 16), 'Back to document') : null,
    h(
      'div.home-nav',
      h('button.home-nav-item', { type: 'button', onclick: () => host.scrollTo?.({ top: 0, behavior: 'smooth' }) }, icon('home', 16), 'Home'),
      h('button.home-nav-item', { type: 'button', onclick: () => host.querySelector('#home-recent-title')?.scrollIntoView?.({ behavior: 'smooth' }) }, icon('clock', 16), 'Recent'),
      h('button.home-nav-item', { type: 'button', onclick: () => host.querySelector('#files-home-title')?.scrollIntoView?.({ behavior: 'smooth' }) }, icon('files', 16), 'Your files'),
      app.commands.get('file.newFromTemplate') ? h('button.home-nav-item', { type: 'button', onclick: () => app.commands.run('file.newFromTemplate') }, icon('file-plus', 16), 'Templates') : null,
    ),
  );
  const main = h(
    'div.home-main',
    h('h1.home-title', app.user ? `Welcome back, ${app.user.username}` : 'Welcome to Vector Studio'),
    h('p.home-sub', 'Draw logos, icons, illustrations and layouts with precise vector tools.'),
    h('div.home-section-head', h('h2.home-h2', 'Start a new file fast'), toggle),
    presets,
    h('div.home-section-head', h('h2#home-recent-title.home-h2', 'Recent'), recentTools),
    recentList,
  );
  host.replaceChildren(h('div.home', side, main, h('footer.home-footer', h('a', { href: 'https://developer.puter.com', target: '_blank', rel: 'noopener' }, 'Powered by Puter'))));
  let items = [];
  const empty = (text) => {
    recentList.removeAttribute('role');
    recentList.replaceChildren(h('p.muted', text));
  };
  const draw = () => {
    if (!items.length) return empty('Files you open or save appear here.');
    const shown = arrangeRecent(items, view);
    if (!shown.length) return empty('No recent files match the filter.');
    // Only a populated list is a list: a lone message is not a list item.
    recentList.setAttribute('role', 'list');
    recentList.replaceChildren(
      ...shown.map((it) => {
        const open = h(
          'button.recent-item',
          { type: 'button', title: it.path || it.name, onclick: () => app.openRecent?.(it) },
          it.thumb ? h('img.recent-thumb', { src: it.thumb, alt: '' }) : h('span.recent-thumb', icon('file-image', 24)),
          h('span.recent-name', it.name),
          h('span.recent-meta', it.when || ''),
        );
        // A listitem wrapper keeps the button's own role (a button cannot also be a listitem).
        const cell = h('div.recent-cell', { role: 'listitem' }, open);
        if (!app.removeRecent) return cell;
        // The file module can drop entries from the list.
        cell.append(
          h('button.icon-btn.recent-remove', { type: 'button', 'aria-label': `Remove ${it.name} from recent`, 'data-tip': 'Remove from recent', onclick: async () => {
            await app.removeRecent(it);
            items = items.filter((x) => x !== it);
            draw();
          } }, icon('x', 12)),
        );
        return cell;
      }),
    );
  };
  filterInput.addEventListener('input', () => {
    view.filter = filterInput.value;
    draw();
  });
  sortSel.addEventListener('change', () => {
    view.sort = sortSel.value;
    prefs?.set('homeRecentSort', view.sort);
    draw();
  });
  for (const b of viewBtns) {
    b.addEventListener('click', () => {
      view.mode = b.dataset.mode;
      for (const x of viewBtns) x.setAttribute('aria-pressed', String(x === b));
      recentList.classList.toggle('list-view', view.mode === 'list');
      prefs?.set('homeRecentView', view.mode);
    });
  }
  try {
    items = (await app.recentFiles?.()) || [];
    recentTools.hidden = items.length === 0;
    draw();
  } catch {
    recentTools.hidden = true;
    empty('Recent files are unavailable right now.');
  }
}

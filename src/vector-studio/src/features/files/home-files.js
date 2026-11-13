/**
 * Home screen additions: the recent list hooks (app.recentFiles,
 * app.openRecent, app.removeRecent) and a "Your files" section listing the
 * .vstudio and .svg files in the default Puter folder.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../ui/icons.js';
import { relativeTime, formatBytes } from './naming.js';
import { readThumbnail } from './format.js';
import { hashKey } from './recent.js';

export function installHomeFiles(app, files) {
  app.recentFiles = async () => {
    const entries = files.recent.list();
    // Check cloud entries in the background; re-render if any disappeared.
    if (files.cloud && app.puter?.fs?.stat) {
      files.recent
        .validate((p) => app.puter.fs.stat(p))
        .then((removed) => {
          if (removed.length && !app.home.hidden) app.renderHome(app.home);
        })
        .catch(() => {});
    }
    return Promise.all(
      entries.map(async (e) => ({
        name: e.name,
        path: e.path,
        kind: e.kind,
        when: `${relativeTime(e.when)}${e.kind === 'local' ? ' · This computer' : ''}`,
        thumb: await files.recent.thumb(e),
        entry: e,
      })),
    );
  };
  app.openRecent = (item) => files.service.openRecent(item.entry || item);
  app.removeRecent = async (item) => {
    await files.recent.remove(item.entry || item);
  };

  const base = app.renderHome;
  app.renderHome = (host) => {
    const done = base(host);
    const main = host.querySelector('.home-main');
    if (main) main.append(yourFilesSection(app, files, host));
    return done;
  };
}

const thumbCache = new Map(); // path|modified -> data URL | null

/** Run at most `n` thumbnail downloads at a time. */
let active = 0;
const waiting = [];
async function limited(fn, n = 3) {
  if (active >= n) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

function yourFilesSection(app, files, host) {
  const list = h('div.recent-list.files-list', { 'aria-label': 'Your files' });
  // role=list only while it holds file items (messages and the sign-in card are not list items).
  const setItems = (on) => (on ? list.setAttribute('role', 'list') : list.removeAttribute('role'));
  const refresh = h('button.icon-btn', { type: 'button', 'aria-label': 'Refresh Your files', 'data-tip': 'Refresh' }, icon('refresh-cw', 14));
  const section = h('section.files-home', { 'aria-labelledby': 'files-home-title' }, h('div.files-home-head', h('h2#files-home-title.home-h2', 'Your files'), refresh), list);
  let generation = 0;
  const load = async () => {
    const request = ++generation, user = app.user, puter = app.puter;
    const current = () => request === generation && host.contains(section) && files.cloud && app.user === user && app.puter === puter;
    setItems(false);
    if (!files.cloud) {
      list.replaceChildren(
        h(
          'div.files-signin-card',
          h('p.muted', 'Sign in to keep your files in your own Puter cloud and see them here.'),
          app.onSignIn ? h('button.btn.primary', { type: 'button', onclick: () => app.onSignIn() }, icon('login', 14), 'Sign in') : null,
          h('button.btn', { type: 'button', onclick: () => files.service.openLocal() }, icon('folder-open', 14), 'Open from this computer'),
        ),
      );
      refresh.hidden = true;
      return;
    }
    refresh.hidden = false;
    list.replaceChildren(h('p.muted', 'Loading your files...'));
    let items;
    try {
      items = await files.service.listYourFiles();
    } catch (err) {
      if (!current()) return;
      list.replaceChildren(h('p.muted', `Your files are unavailable right now${navigator.onLine === false ? ' (offline)' : ''}.`), h('button.btn.small', { type: 'button', onclick: load }, 'Retry'));
      return;
    }
    if (!current()) return;
    if (!items.length) {
      list.replaceChildren(h('p.muted', 'Files you save with Save As appear here.'));
      return;
    }
    setItems(true);
    list.replaceChildren(
      ...items.slice(0, 48).map((it) => {
        const img = h('span.recent-thumb', icon(it.format === 'svg' ? 'file-code' : 'file-image', 24));
        const btn = h(
          'button.recent-item',
          { type: 'button', title: it.path, onclick: () => files.service.openPath(it.path, { name: it.name }) },
          img,
          h('span.recent-name', it.name),
          h('span.recent-meta', [relativeTime(it.modified), formatBytes(it.size)].filter(Boolean).join(' · ')),
        );
        loadThumb(app, files, it, current).then((src) => {
          if (src && current()) img.replaceWith(h('img.recent-thumb', { src, alt: '' }));
        });
        return h('div.recent-cell', { role: 'listitem' }, btn);
      }),
    );
  };
  refresh.addEventListener('click', load);
  load();
  return section;
}

/**
 * Thumbnail for a cloud file: the recent-list cache first, then the local
 * thumbnail cache, then (small native files only) the thumbnail stored in
 * the file itself, cached for next time.
 */
async function loadThumb(app, files, it, current) {
  if (!current()) return null;
  const key = `${it.path}|${it.modified}`;
  // A save may share the server's previous modified timestamp. Prefer its
  // fresh preview without adding disk reads to unchanged Home refreshes.
  const latest = files.recent.peekThumb?.({ kind: 'puter', path: it.path });
  if (latest) {
    thumbCache.set(key, latest);
    return latest;
  }
  if (thumbCache.has(key)) return thumbCache.get(key);
  const recent = await files.recent.thumb({ kind: 'puter', path: it.path });
  if (!current()) return null;
  if (recent) {
    thumbCache.set(key, recent);
    return recent;
  }
  const cachePath = `thumbs/file-${hashKey(key)}.json`;
  try {
    const hit = await files.cache?.readJSON(cachePath);
    if (!current()) return null;
    if (hit?.thumb) {
      thumbCache.set(key, hit.thumb);
      return hit.thumb;
    }
  } catch {
    // No cached thumbnail.
  }
  if (!current()) return null;
  if (it.format !== 'native' || it.size > 4 * 1024 * 1024) return null;
  try {
    const thumb = await limited(async () => {
      if (!current()) return null;
      const data = await app.puter.fs.read(it.path);
      return current() ? readThumbnail(data) : null;
    });
    if (!current()) return null;
    thumbCache.set(key, thumb);
    if (thumb) files.cache?.writeJSON(cachePath, { thumb }).catch(() => {});
    return thumb;
  } catch {
    return null;
  }
}

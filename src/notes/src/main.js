import './styles/tokens.css';
import './styles/icons.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/page.css';
import './styles/features.css';
import { h } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { sanitizeHtml } from './lib/sanitize.js';
import { applyTheme } from './ui/prefs.js';
import { Store } from './data/store.js';
import { puterBackend } from './data/backend.js';
import { App } from './ui/app.js';
import { PageEditor } from './editor/page-editor.js';
import { tagStylesheet } from './editor/tag-edit.js';
import { installTooltips } from './ui/tooltip.js';

const root = document.getElementById('app');
applyTheme();

function screen(...children) {
  root.removeAttribute('aria-busy');
  root.replaceChildren(h('main.splash', { id: 'main' }, ...children));
}

function loading(text = 'Opening your notebooks...') {
  root.setAttribute('aria-busy', 'true');
  root.replaceChildren(h('div.splash', { role: 'status' }, h('img.splash-logo', { src: './favicon.svg', alt: '' }), h('div.spinner'), h('p', text)));
}

function signInScreen(onSignedIn) {
  const btn = h('button.btn.primary.splash-cta', { type: 'button' }, 'Sign in');
  const error = h('p.field-error', { role: 'alert' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Waiting for Puter...';
    error.textContent = '';
    try {
      await puter.auth.signIn();
      onSignedIn();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Sign in';
      if (err?.error === 'popup_blocked') error.textContent = 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.';
      else if (err?.error !== 'auth_window_closed') error.textContent = "Couldn't sign in. Try again.";
    }
  });
  const feature = (ic, text) => h('li', icon(ic, 18, undefined, { plain: true }), h('span', text));
  screen(
    h('img.splash-logo', { src: './favicon.svg', alt: '' }),
    h('h1.splash-title', 'Notes'),
    h('p.splash-sub', 'A free-form digital notebook for everything you want to remember.'),
    h('ul.splash-features',
      feature('container', 'Write anywhere on the page, with notebooks, sections and pages'),
      feature('todo', 'Tag to-dos and ideas, then find them all in one place'),
      feature('pen', 'Draw and handwrite with pens and highlighters'),
      feature('cloud', 'Saved as files in your own Puter cloud'),
    ),
    btn,
    error,
  );
  btn.focus();
}

function errorScreen(title, message, retry) {
  screen(
    h('div.splash-icon', icon('cloudOff', 32)),
    h('h1.splash-title', title),
    h('p.splash-sub', message),
    retry ? h('button.btn.primary.splash-cta', { type: 'button', onclick: retry }, 'Try again') : null,
  );
}

async function startApp(backend, user, env) {
  loading();
  const store = new Store(backend);
  try {
    await store.load({ defaultName: user?.username ? `${user.username}'s Notebook` : 'My Notebook' });
  } catch (err) {
    console.error(err);
    errorScreen("Couldn't open your notebooks", 'Check your connection and try again.', () => location.reload());
    return;
  }
  const app = new App(root, {
    store,
    user,
    env,
    onSignOut: env === 'app' ? null : async () => {
      await puter.auth.signOut();
      location.hash = '';
      location.reload();
    },
  });
  window.notesApp = app;
  await app.start();
}

/** Public read-only view of a published page: #view=<read URL>. */
async function viewShared(url) {
  loading('Opening shared page...');
  let data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
    if (data?.format !== 'notes-shared-page') throw new Error('format');
  } catch {
    errorScreen('This link has expired or was removed', 'Ask the person who shared it for a new link.');
    return;
  }
  root.removeAttribute('aria-busy');
  // Phones show one level of the app at a time and hide the page unless it
  // is the current level; the shared view only has the page.
  root.dataset.mobileView = 'page';
  const style = document.createElement('style');
  style.textContent = tagStylesheet();
  document.head.append(style);
  // The snapshot is untrusted: keep only fields of the expected types.
  const str = (v) => (typeof v === 'string' ? v : '');
  const title = str(data.title);
  const published = new Date(str(data.published));
  document.title = `${title || 'Shared page'} - Notes`;
  const host = h('div.canvas-col');
  root.replaceChildren(h('div.shared-view',
    h('header.read-only-banner', { role: 'banner' }, h('img', { src: './favicon.svg', alt: '', width: 20, height: 20 }), h('strong', 'Notes'), h('span.banner-wide', 'Shared read-only page'), h('span.banner-narrow', 'Read-only'), h('span.spacer'), Number.isNaN(published.getTime()) ? null : h('span', h('span.banner-published', 'Published '), published.toLocaleDateString())),
    h('main#main.main', host),
  ));
  installTooltips(document);
  const fakeStore = { assetUrl: async () => null, pageChanged() {} };
  const editor = new PageEditor({ store: fakeStore, host, readOnly: true });
  editor.pageEl.classList.add('read-only');
  // Nothing on a shared page need be focusable, so the canvas itself is a
  // Tab stop: arrow keys and Page Down then scroll it.
  editor.scroller.tabIndex = 0;
  const outlines = Array.isArray(data.outlines)
    ? data.outlines.map((o, i) => ({ id: `s${i}`, x: Number(o.x) || 0, y: Number(o.y) || 0, w: Number(o.w) || null, html: sanitizeHtml(o.html || '') }))
    : [{ id: 's0', x: 48, y: 140, w: 760, html: sanitizeHtml(data.html || '') }];
  // Shared ink is untrusted: keep only well-formed numbers and hex colors.
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const color = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c)) ? c : '#1f1f1f');
  const ink = (Array.isArray(data.ink) ? data.ink : []).slice(0, 5000).flatMap((i, n) => {
    if (i?.type === 'stroke' && Array.isArray(i.points)) return [{ id: `i${n}`, type: 'stroke', color: color(i.color), width: num(i.width) || 2, highlighter: Boolean(i.highlighter), points: i.points.slice(0, 20000).map((p) => [num(p?.[0]), num(p?.[1]), num(p?.[2]) || 0.5]) }];
    if (i?.type === 'shape') return [{ id: `i${n}`, type: 'shape', kind: String(i.kind), color: color(i.color), width: num(i.width) || 2, x1: num(i.x1), y1: num(i.y1), x2: num(i.x2), y2: num(i.y2) }];
    return [];
  });
  const page = { id: 'shared', title, created: data.created, color: str(data.color) || null, rules: str(data.rules) || null, ink, outlines };
  await editor.open(page);
  // The date and time edit the page in the app; here they are plain text,
  // not buttons that take a Tab stop and do nothing.
  for (const btn of [editor.dateBtn, editor.timeBtn]) btn.replaceWith(h('span', btn.textContent));
}

async function boot() {
  const hash = location.hash;
  if (hash.startsWith('#view=')) {
    viewShared(decodeURIComponent(hash.slice(6)));
    return;
  }
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('local')) {
    const { localBackend } = await import('./data/local-backend.js');
    startApp(await localBackend(), { username: 'local' }, 'web');
    return;
  }
  if (typeof puter === 'undefined') {
    errorScreen("Couldn't reach Puter", 'Notes needs Puter to store your notebooks. Check your connection and try again.', () => location.reload());
    return;
  }
  const env = puter.env;
  const begin = async () => {
    loading();
    let user = null;
    try {
      user = await puter.auth.getUser();
    } catch {
      /* the store still works; the avatar falls back to an icon */
    }
    startApp(puterBackend(puter), user, env);
  };
  if (env === 'app' || puter.auth.isSignedIn()) begin();
  else signInScreen(begin);
}

boot();

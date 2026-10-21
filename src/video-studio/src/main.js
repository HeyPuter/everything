import './styles/fonts.js';
import './styles/tokens.css';
import './styles/base.css';
import './styles/editor.css';
import './styles/timeline.css';
import './styles/home.css';
import './styles/responsive.css';
import { h } from './lib/dom.js';
import { icon, appIcon } from './lib/icons.js';
import { applyTheme } from './ui/prefs.js';
import { Library } from './storage/library.js';
import { puterBackend, opfsBackend, opfsAvailable, memoryBackend } from './storage/backends.js';
import { Home } from './ui/home.js';
import { importProjectBundle } from './storage/bundle.js';
import { toast, confirmDialog } from './ui/dialog.js';
import { loadDsp } from './media/dsp.js';
import { parseReviewHash } from './review/protocol.js';

const root = document.getElementById('app');
applyTheme();
loadDsp();

let library = null;
let account = null;
let view = null;

function loading(text) {
  root.setAttribute('aria-busy', 'true');
  root.replaceChildren(h('div.splash', { role: 'status' }, appIcon(56), h('div.spinner'), h('p', text)));
}

function errorScreen(title, message, retry) {
  root.removeAttribute('aria-busy');
  root.replaceChildren(h('main#main.splash', icon('cloudOff', 32), h('h1.splash-title', title), h('p.splash-sub', message), retry ? h('button.btn.primary', { type: 'button', onclick: retry }, 'Try again') : null));
}

function showHome() {
  view?.dispose?.();
  if (/#(project|review)=/.test(location.hash)) history.replaceState(null, '', `${location.pathname}${location.search}`);
  view = new Home(root, {
    library,
    account,
    onOpen: (id) => openProject(id),
    onCreate: (opts) => createProject(opts),
    onImportFiles: (files) => createProject({ ratio: 'original' }, files),
  });
}

async function openProject(id, files) {
  view?.dispose?.();
  loading('Opening project...');
  let project;
  try {
    project = await library.openProject(id);
  } catch (err) {
    toast(err?.message || "Couldn't open the project.", { kind: 'error' });
    showHome();
    return;
  }
  if (project.deletedAt) {
    toast(`${project.name} is in the Trash. Restore it to open it.`, { kind: 'error' });
    history.replaceState(null, '', '#trash');
    showHome();
    return;
  }
  // Open in another tab too: edits in both would overwrite each other, so ask first.
  const claim = await library.claimProject(id);
  if (!claim.held) {
    const ok = await confirmDialog({
      title: 'Project open in another tab',
      message: `${project.name} is already open in another tab or window. Changes made in both places overwrite each other. Open it here anyway?`,
      confirm: 'Open anyway',
      cancel: 'Go back',
    });
    if (!ok) {
      claim.release();
      showHome();
      return;
    }
  }
  const { Editor } = await import('./ui/editor.js');
  view = new Editor(root, {
    library,
    project,
    claim,
    account,
    onExit: () => showHome(),
    onNewProject: () => createProject({ ratio: 'original' }),
    onOpenProject: (other) => openProject(other),
  });
  history.replaceState(null, '', `#project=${encodeURIComponent(id)}`);
  if (files?.length) {
    const assets = await view.ctx.actions.importFiles(files);
    let first = true;
    for (const a of assets) {
      view.ctx.actions.addAsset(a, { start: view.ctx.store.duration, adoptRatio: first });
      first = false;
    }
    view.ctx.store.seek(0);
  }
}

async function createProject(opts = {}, files) {
  loading('Creating project...');
  try {
    const n = (await library.listProjects()).length + 1;
    const project = await library.createProject({ name: `Project ${n}`, ratio: opts.ratio || 'original' });
    await openProject(project.id, files);
  } catch (err) {
    console.error(err);
    toast("Couldn't create a project.", { kind: 'error' });
    showHome();
  }
}

async function openBundle(file) {
  loading('Opening project file...');
  try {
    const { project } = await importProjectBundle(library, file);
    await openProject(project.id);
  } catch (err) {
    console.error(err);
    toast(err?.message || "Couldn't open the project file.", { kind: 'error' });
    showHome();
  }
}

async function profilePicture() {
  try {
    return await puter.auth.getProfilePicture();
  } catch {
    return null;
  }
}

async function startSignedIn(env) {
  loading('Loading your projects...');
  let user = null;
  try {
    user = await puter.auth.getUser();
  } catch {
    /* the avatar falls back to an icon */
  }
  library = new Library(puterBackend(puter));
  account = {
    user,
    env,
    picture: await profilePicture(),
    onSignOut: env === 'app' ? null : async () => {
      // Unsaved edits or uploads: ask before signing out drops them.
      if (view?.prepareToLeave && !(await view.prepareToLeave({ waitForUploads: true }))) return;
      await puter.auth.signOut();
      location.hash = '';
      location.reload();
    },
  };
  route();
}

function startLocal(env) {
  library = new Library(opfsAvailable() ? opfsBackend() : memoryBackend());
  account = {
    user: null,
    env,
    picture: null,
    onSignIn: typeof puter !== 'undefined' ? async () => {
      try {
        await puter.auth.signIn();
        location.reload();
      } catch {
        /* closed */
      }
    } : null,
  };
  route();
}

/** A review link (#review=...): the focused review screen, for reviewers and the owner alike. */
async function openReview(link) {
  view?.dispose?.();
  loading('Opening review...');
  const { ReviewPage } = await import('./ui/review/review-page.js');
  view = new ReviewPage(root, {
    puter: typeof puter !== 'undefined' ? puter : null,
    account,
    link,
    onHome: () => showHome(),
    // Signing in changes which library and account the app uses, so start over.
    onSignedIn: () => location.reload(),
  });
}

function route() {
  let review = null;
  try {
    review = parseReviewHash(location.hash);
  } catch (err) {
    errorScreen('This review link does not work', err.message, null);
    return;
  }
  const m = /#project=([^&]+)/.exec(location.hash);
  if (review) openReview(review);
  else if (m) openProject(decodeURIComponent(m[1]));
  else showHome();
  // Files opened with the app from the Puter desktop start a new project.
  if (typeof puter !== 'undefined' && puter.ui?.onLaunchedWithItems) {
    puter.ui.onLaunchedWithItems(async (items) => {
      const files = [];
      for (const it of items || []) {
        if (it.is_dir) continue;
        try {
          const blob = await puter.fs.read(it.path || it.uid);
          files.push(new File([blob], it.name, { type: blob.type }));
        } catch {
          /* skip unreadable */
        }
      }
      // Project files (exported from the home screen) open as projects.
      const bundles = files.filter((f) => /\.zip$/i.test(f.name));
      if (bundles.length) {
        openBundle(bundles[0]);
        return;
      }
      if (files.length) createProject({ ratio: 'original' }, files);
    });
  }
}

async function boot() {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('local')) {
    startLocal('web');
    return;
  }
  // Wait briefly for the deferred Puter.js script.
  for (let i = 0; i < 50 && typeof puter === 'undefined'; i++) await new Promise((r) => setTimeout(r, 100));
  if (typeof puter === 'undefined') {
    // Offline or blocked: still usable, saving in this browser.
    startLocal('web');
    return;
  }
  const env = puter.env;
  if (env === 'app' || puter.auth.isSignedIn()) startSignedIn(env);
  else startLocal(env);
}

// A review link pasted into an open tab only changes the hash.
window.addEventListener('hashchange', () => {
  if (!library) return;
  let link = null;
  try {
    link = parseReviewHash(location.hash);
  } catch {
    return;
  }
  if (link && (view?.link?.review !== link.review || link.token)) openReview(link);
});

// Media still uploading (or waiting to be tried again) after leaving the editor: warn before the page closes.
window.addEventListener('beforeunload', (e) => {
  if (!library?.unsavedMedia) return;
  e.preventDefault();
  e.returnValue = '';
});

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
});

if (typeof window !== 'undefined' && !window.__VIDEO_STUDIO_TEST__) boot();

// Development hook: drive the app from the console or browser automation.
//   await vs.importDev(['clip-a.mp4', 'music.mp3'], { add: true })
if (import.meta.env.DEV) {
  window.vs = {
    get view() {
      return view;
    },
    get ctx() {
      return view?.ctx;
    },
    async importDev(names, { add = false } = {}) {
      const files = [];
      for (const n of names) {
        const blob = await (await fetch(`/.dev-media/${n}`)).blob();
        files.push(new File([blob], n, { type: blob.type }));
      }
      return view.ctx.actions.importFiles(files, { addToTimeline: add });
    },
  };
}

/**
 * Entry point: apply the theme, connect to Puter (sign-in state, profile
 * picture, launch items), build the app and register feature modules.
 */
import './styles/index.css';
import { Prefs } from './prefs.js';
import { App } from './app.js';
import { applyTheme } from './theme.js';
import { installFeatures } from './features.js';

const prefs = new Prefs();
applyTheme(prefs.get('theme'));

function waitForPuter(timeout = 5000) {
  return new Promise((resolve) => {
    if (typeof window.puter !== 'undefined') return resolve(window.puter);
    const t0 = performance.now();
    const tick = () => {
      if (typeof window.puter !== 'undefined') resolve(window.puter);
      else if (performance.now() - t0 > timeout) resolve(null);
      else setTimeout(tick, 50);
    };
    tick();
  });
}

async function profile(puter) {
  try {
    const user = await puter.auth.getUser();
    let picture = null;
    try {
      picture = await puter.auth.getProfilePicture();
    } catch {
      picture = null;
    }
    return { user, picture };
  } catch {
    return { user: null, picture: null };
  }
}

async function boot() {
  const root = document.getElementById('app');
  const puter = await waitForPuter();
  const env = puter?.env || 'web';
  let user = null;
  let picture = null;
  if (puter && (env === 'app' || puter.auth.isSignedIn())) ({ user, picture } = await profile(puter));

  const app = new App(root, {
    prefs,
    env,
    user,
    picture,
    onSignIn: puter
      ? async () => {
          try {
            await puter.auth.signIn();
            const p = await profile(puter);
            app.setUser(p.user, p.picture);
          } catch {
            app.notify('Sign in was cancelled.');
          }
        }
      : null,
    onSignOut:
      puter && env !== 'app'
        ? async () => {
            await puter.auth.signOut();
            app.setUser(null, null);
          }
        : null,
  });
  app.puter = puter;
  installFeatures(app);
  app.start();
  window.addEventListener('themechange', () => {
    for (const v of app.views.values()) v.refreshColors();
    app.rulers?.refresh();
  });
  app.emit('ready');
  if (!app.editors.length && app.prefs.get('showStartScreen') !== false) app.showHome();
  if (import.meta.env.DEV) window.vs = app;
}

boot();

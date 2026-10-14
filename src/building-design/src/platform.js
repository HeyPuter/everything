/**
 * Everything that touches Puter directly for identity: environment, sign-in
 * state, user and profile picture. The app works without signing in; cloud
 * files and settings sync need an account.
 */
const PIC_KEY = 'bd.profilePicture';

export function puterAvailable() {
  return typeof globalThis.puter !== 'undefined';
}

let ready = null;

/**
 * Resolves true once the Puter SDK has loaded (it loads asynchronously so a
 * slow network never blocks drawing), or false if it fails to load.
 */
export function whenPuter(timeoutMs = 20000) {
  if (puterAvailable()) return Promise.resolve(true);
  if (ready) return ready;
  ready = new Promise((resolve) => {
    const script = document.getElementById('puter-sdk');
    const done = () => resolve(puterAvailable());
    if (!script) return done();
    script.addEventListener('load', done, { once: true });
    script.addEventListener('error', done, { once: true });
    setTimeout(done, timeoutMs);
  });
  return ready;
}

export function puterEnv() {
  try {
    return globalThis.puter?.env || 'web';
  } catch {
    return 'web';
  }
}

/** Inside the Puter desktop the user is always signed in and cannot sign out. */
export function canSignOut() {
  return puterEnv() !== 'app';
}

export async function isSignedIn() {
  if (!puterAvailable()) return false;
  try {
    return (await Promise.resolve(puter.auth.isSignedIn())) === true;
  } catch {
    return false;
  }
}

/** Must be called from a user gesture (opens a popup). */
export async function signIn() {
  await puter.auth.signIn();
}

export function signOut() {
  try {
    puter.auth.signOut();
  } catch {
    /* ignore */
  }
}

export async function getUser() {
  try {
    return await puter.auth.getUser();
  } catch {
    return null;
  }
}

/** Profile picture as a data URL, cached per user so it shows instantly next time. */
export function cachedProfilePicture(username) {
  try {
    const raw = JSON.parse(localStorage.getItem(PIC_KEY) || 'null');
    return raw && raw.user === username ? raw.url : null;
  } catch {
    return null;
  }
}

export async function fetchProfilePicture(username) {
  try {
    const url = await puter.auth.getProfilePicture?.();
    if (typeof url === 'string' && url.startsWith('data:image/') && url.length < 2_000_000) {
      try {
        localStorage.setItem(PIC_KEY, JSON.stringify({ user: username, url }));
      } catch {
        /* ignore quota */
      }
      return url;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function clearProfilePicture() {
  try {
    localStorage.removeItem(PIC_KEY);
  } catch {
    /* ignore */
  }
}


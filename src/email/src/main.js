import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';

import { renderApp } from './ui/app.js';
import { openCompose, closeComposers, isDraftSending } from './ui/compose.js';
import { renderIntro, renderLoading, renderError, renderPermission } from './ui/gate.js';
import { shouldOnboard, openOnboarding } from './ui/onboarding.js';
import { toast } from './ui/toast.js';
import { MAIL_DIR } from './lib/mailbox.js';
import { createDraftStore } from './lib/drafts.js';
import { createSettings } from './lib/settings.js';
import { createSampleDataPopulator } from './lib/demo.js';

let demoSession = null;
window.email = { populateSampleData: createSampleDataPopulator(() =>
  window.puter?.auth.isSignedIn() ? demoSession : null,
) };

const root = document.getElementById('app');

// The SDK loads with `defer` ahead of this module; the poll only covers a
// slow network still fetching it.
const waitForPuter = () => new Promise((resolve) => {
  if (window.puter) return resolve(true);
  let tries = 0;
  const timer = setInterval(() => {
    if (window.puter || ++tries > 100) {
      clearInterval(timer);
      resolve(Boolean(window.puter));
    }
  }, 100);
});

/**
 * The account-scoped key-value store behind read and starred state, so flags
 * follow the account across devices instead of belonging to one browser. No
 * filesystem permission is involved, so this costs no prompt. Absent on a
 * Puter without kv, in which case the flag stores stay local.
 */
const accountStore = () => (window.puter?.kv ? {
  get: (key) => puter.kv.get(key),
  set: (key, value) => puter.kv.set(key, value),
} : null);

/**
 * A request that never got an answer: the SDK's own network and timeout
 * errors, a failed fetch, or the bare request object its older transport
 * rejects with. None of these says anything about access.
 */
const unreachable = (error) => !error?.code || error instanceof TypeError
  || error.code === 'network_error' || error.code === 'request_timeout';

/**
 * Whether the folder can be read. Puter answers a refused or missing path
 * with a coded API error, which is the answer "no". A request that failed
 * to get an answer at all is thrown, not taken for "no": a network blip at
 * start-up showed the permission screen, whose only way on asked for a
 * permission already held.
 */
const canRead = async (path) => {
  try {
    await puter.fs.stat(path);
    return true;
  } catch (error) {
    if (unreachable(error)) throw error;
    return false;
  }
};

const requestPermission = (permission) =>
  puter.perms?.request
    ? puter.perms.request(permission)
    : puter.ui.requestPermission({ permission });

// Puter apps have their own session chrome; a logout option inside the app
// would fight it, so it only exists in the web environment.
const canSignOut = () => window.puter && puter.env !== 'app';

const signOut = async () => {
  if (!closeComposers()) return;
  try {
    await puter.auth.signOut();
  } catch {}
  start();
};

async function start() {
  demoSession = null;
  if (!window.puter) {
    renderError(root, 'The Puter SDK could not be loaded. Check your connection and try again.',
      () => location.reload());
    return;
  }

  if (!puter.auth.isSignedIn()) {
    renderIntro(root, {
      // A dismissed sign-in popup rejects. Letting that escape the button's
      // click handler was an unhandled rejection and told the user nothing;
      // coming back to the same screen is the honest answer, and the button
      // is ready to try again.
      onSignIn: async () => {
        try {
          await puter.auth.signIn();
        } catch {
          return;
        }
        start();
      },
    });
    return;
  }

  renderLoading(root, 'Checking your mailbox');

  let username;
  try {
    ({ username } = await puter.auth.whoami());
  } catch (e) {
    renderError(root, `Could not look up your account: ${e?.message ?? e}`, start);
    return;
  }

  const mailPath = `/${username}/${MAIL_DIR}`;
  const objectsPath = `${mailPath}/objects`;

  // Being able to stat the folder means read access is already held.
  let readable;
  try {
    readable = await canRead(mailPath);
  } catch (e) {
    renderError(root, `Could not reach your mailbox: ${e?.message ?? 'the network request failed'}`, start);
    return;
  }
  if (!readable) {
    renderPermission(root, {
      mailPath,
      requestAccess: async () => {
        try {
          await requestPermission(`fs:${mailPath}:read`);
        } catch {}
        return canRead(mailPath).catch(() => false);
      },
      onGranted: start,
      onSignOut: canSignOut() ? signOut : null,
    });
    return;
  }

  // One store shared by the shell (which lists drafts) and the dialog (which
  // writes them), so neither reads a stale copy. Scoped per account, so
  // drafts never leak between accounts.
  const drafts = createDraftStore(username);
  // Signature and the like: per account, like the drafts beside it.
  const settings = createSettings(username);
  // The draft the Compose pill continues: the newest one that is not on its
  // way. For the seconds a send is held with an Undo the newest draft is the
  // message just sent, and continuing that one meant Compose opened nothing.
  const resumable = () => drafts.list()
    .find((entry) => !isDraftSending({ username, mailPath, id: entry.id })) ?? null;

  const app = renderApp(root, {
    fs: puter.fs,
    mailPath,
    objectsPath,
    account: { username },
    getProfilePicture: () => puter.auth.getProfilePicture?.(),
    drafts,
    settings,
    flagStore: accountStore(),
    // The Events API, where this Puter has it: the shell watches `.mail` over
    // it instead of polling, so mail shows up as it lands and a change made
    // on another device shows up here. Without it the shell falls back to a
    // timed check.
    events: window.puter?.events ?? null,
    // `hooks` lets the shell hear about the sent copy it has to list, and
    // carries the signature, read fresh on every open.
    onCompose: (prefill, hooks) => openCompose({
      ...hooks,
      username,
      mailPath,
      prefill,
      drafts,
      // A reply always starts its own draft; the bare Compose pill continues
      // the newest one, which is what "closing keeps the draft" has to mean
      // to be worth anything.
      draft: hooks?.draft ?? (prefill ? null : resumable()),
    }),
    // Archiving and deleting move files inside .mail. Like sending, the app
    // tries first and only asks when the write is refused -- the permission
    // dialog prompts every time it is called, so asking on launch would mean
    // a dialog on every launch.
    requestWrite: () => requestPermission(`fs:${mailPath}:write`),
    // An attachment can be saved into the user's own files as well as
    // downloaded to the device. The OS's save dialog writes the bytes itself.
    saveToPuter: puter.ui?.showSaveFilePicker
      ? (blob, name) => puter.ui.showSaveFilePicker(blob, name)
      : null,
    onSignOut: canSignOut() ? signOut : null,
  });

  demoSession = { fs: puter.fs, mailPath, app };
  if (shouldOnboard()) openOnboarding();
}

waitForPuter().then(() => start()).catch((e) => {
  renderError(root, `Something went wrong: ${e?.message ?? e}`, () => location.reload());
  toast('Startup failed.', { iconName: 'alert' });
});

import './style.css';
import './shell/shell.css';
import './glass-icons.css';
import {
  el,
  icon,
  appIcon,
  button,
  iconButton,
  modal,
  waitForAppDialogsToClose,
  confirmAction,
  promptText,
  toast,
  download,
  applyTheme,
  themeValue,
  syncThemeColor,
  formatBytes,
} from './lib/ui.js';
import * as P from './lib/puter.js';
import { waitFor } from './lib/abort.js';
import {
  PdfSession,
  safeName,
  preparePdfForEditing,
  blankPdf,
  samplePdf,
  MAX_FILE_SIZE,
} from './core/document.js';

const root = document.querySelector('#app');
/** The library's URL. Opening the app lands in the editor instead. */
const LIBRARY_HASH = '#library';
const settingsAccountViews = new Set();
let user = null,
  sessionState = 'unknown', // until the SDK has been asked; then 'in' or 'out'
  accountGeneration = 0,
  accountToken,
  accountRefreshRequest = null,
  accountRefreshController = null,
  accountRefreshToken,
  accountRefreshHint,
  signInRequest = null,
  signInController = null,
  signOutPending = false,
  accountController = new AbortController(),
  editor = null,
  loading = false,
  openGeneration = 0,
  cloudOpenGeneration = 0,
  openController = null,
  homeGeneration = 0;
const run =
  (fn) =>
  async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      // Closing the sign-in dialog is a choice, not a failure worth a red toast.
      if (P.isSignInCancelled(e)) return;
      // Puter's SDK rejects with plain objects too, at times with the reason nested inside.
      toast(e?.message || e?.error?.message || 'Something went wrong. Please try again.', {
        error: true,
      });
    }
  };
function sameAccount(first, second) {
  if (!first || !second) return false;
  if (first.uuid && second.uuid) return first.uuid === second.uuid;
  // The desktop's provisional label resolves to its existing account, not a new session.
  return (
    first.username === 'Puter user' ||
    second.username === 'Puter user' ||
    first.username === second.username
  );
}
function cancelledSignIn() {
  const error = new Error('The sign-in was cancelled.');
  error.code = 'sign-in-cancelled';
  return error;
}
const sessionChanged = () => accountToken !== undefined && accountToken !== P.sessionToken();
/** The account changed (a sign-in, or the SDK's first answer): the open view follows. */
function setAccount(account, { profileOnly = false } = {}) {
  accountGeneration++;
  const resetCloud = !account || (user && !sameAccount(user, account));
  if (resetCloud) {
    cloudOpenGeneration++;
    // The SDK's profile read can still be pending after its sign-in event. Signing out
    // retires that read and its cloud continuations, and frees a fresh authentication attempt.
    const cancelled = cancelledSignIn();
    accountController.abort(cancelled);
    accountController = new AbortController();
    signInController?.abort(cancelled);
    signInController = null;
    signInRequest = null;
    accountRefreshController?.abort(cancelled);
    accountRefreshController = null;
    accountRefreshRequest = null;
  }
  user = account;
  accountToken = P.sessionToken();
  sessionState = account ? 'in' : 'out';
  for (const refresh of settingsAccountViews) refresh();
  if (editor) editor.updateAccount({ resetCloud });
  else if (profileOnly && !resetCloud) {
    // Resolving the desktop's existing session must preserve library work in progress.
    const label = root.querySelector('.account-label');
    if (label) label.textContent = label.title = account?.username || 'Local workspace';
  } else if (!loading) showHome({ accountRefresh: true });
}
/** SDK auth profiles can arrive out of order. Verify its current session before adopting one. */
function refreshSDKAccount(hint) {
  const token = P.sessionToken();
  if (
    accountRefreshRequest &&
    (token !== undefined
      ? token === accountRefreshToken
      : hint && sameAccount(hint, accountRefreshHint))
  )
    return accountRefreshRequest;
  if (
    !accountRefreshRequest &&
    token &&
    token === accountToken &&
    sameAccount(user, hint) &&
    user.username === hint.username
  ) {
    return Promise.resolve(user);
  }
  accountRefreshController?.abort(cancelledSignIn());
  const controller = (accountRefreshController = new AbortController());
  accountRefreshToken = token;
  accountRefreshHint = hint;
  let version = ++accountGeneration;
  const request = waitFor(async () => {
    const signedIn = await P.isSignedIn();
    controller.signal.throwIfAborted();
    if (version !== accountGeneration || token !== P.sessionToken()) return null;
    if (signedIn && !user) {
      // A confirmed session can be signed out while its profile is still loading.
      // Callback metadata may be stale, so only the verified profile supplies its name.
      setAccount({ username: 'Puter user' });
      version = accountGeneration;
    }
    return signedIn ? P.currentUser() : null;
  }, controller.signal)
    .then((account) => {
      controller.signal.throwIfAborted();
      if (version !== accountGeneration) return user;
      if (token !== P.sessionToken()) return refreshSDKAccount();
      if (account || user || sessionState !== 'out')
        setAccount(account, { profileOnly: sameAccount(user, account) });
      return user;
    })
    .finally(() => {
      if (accountRefreshRequest === request) accountRefreshRequest = null;
      if (accountRefreshController === controller) accountRefreshController = null;
    });
  accountRefreshRequest = request;
  // The SDK does not await its callback. Retired verification must not become unhandled.
  request.catch(() => {});
  return request;
}
/** Cloud continuations wait for a changed SDK session, then check their original account. */
async function settleAccount(signal) {
  if (sessionChanged()) refreshSDKAccount();
  while (accountRefreshRequest) {
    const request = accountRefreshRequest;
    try {
      await waitFor(() => request, signal);
    } catch (error) {
      if (
        !signal?.aborted &&
        P.isSignInCancelled(error) &&
        accountRefreshRequest &&
        accountRefreshRequest !== request
      )
        continue;
      throw error;
    }
  }
  signal?.throwIfAborted();
}
/** Cloud actions need a session: resolve the account, asking Puter to sign in when nobody is. */
async function ensureSignedIn({ signal = accountController.signal } = {}) {
  await settleAccount(signal);
  if (user) return user;
  // Repeated activations and other cloud actions share the same authentication window.
  // Release the request after success, cancellation, or failure so a later attempt can retry.
  if (!signInRequest) {
    const controller = (signInController = new AbortController());
    const request = waitFor(() => P.signIn(), controller.signal)
      .then(async (account) => {
        await settleAccount(controller.signal);
        controller.signal.throwIfAborted();
        if (!user) setAccount(account || { username: 'Puter user' });
        return user;
      })
      .finally(() => {
        if (signInRequest === request) signInRequest = null;
        if (signInController === controller) signInController = null;
      });
    signInRequest = request;
  }
  return signInRequest;
}
function settings() {
  const accountSummary = el('p', { class: 'muted' });
  const accountActions = el('div', { class: 'stack' });
  const select = el(
    'select',
    { id: 'theme-select', class: 'input', onchange: (e) => applyTheme(e.target.value) },
    ...['system', 'light', 'dark'].map((t) =>
      el(
        'option',
        { value: t, selected: themeValue() === t },
        `${t[0].toUpperCase()}${t.slice(1)}`,
      ),
    ),
  );
  const body = el(
    'div',
    { class: 'stack' },
    el('label', { for: 'theme-select' }, 'Appearance'),
    select,
    accountSummary,
    button('Keyboard shortcuts', 'Keyboard', () => {
      dialog.close();
      shortcuts();
    }),
    button('About PDF Editor', 'Info', () => {
      dialog.close();
      about();
    }),
    accountActions,
  );
  let accountAction;
  const refreshAccount = () => {
    if (!dialog.open) return;
    const focused = accountActions.contains(document.activeElement);
    accountSummary.textContent = user
      ? `Signed in as ${user.username}`
      : 'Work locally, or sign in to save PDFs in your Puter cloud.';
    const nextAction = !user ? 'sign-in' : P.isApp() ? null : 'sign-out';
    if (nextAction === accountAction) return;
    accountAction = nextAction;
    accountActions.replaceChildren();
    accountActions.hidden = !!user && P.isApp();
    if (user && !P.isApp())
      accountActions.append(
        button(
          'Sign out',
          'LogOut',
          run(async (event) => {
            // Settings can be reopened while the SDK is pending. Claim this operation
            // before its first await so repeated presses cannot start another sign-out.
            if (signOutPending) return;
            signOutPending = true;
            try {
              // Safari does not focus clicked buttons; the confirmation needs a return target.
              event.currentTarget.focus({ preventScroll: true });
              if (!(await canLeave())) return;
              await P.signOut();
              const leaving = dialog.open;
              if (leaving) dialog.close();
              // Closing Settings returns to work. Complete the account change without
              // discarding later edits, replacing a newer PDF, or aborting its file read.
              setAccount(null);
              if (leaving && editor) showHome();
            } finally {
              signOutPending = false;
            }
          }),
        ),
      );
    if (!user)
      accountActions.append(
        button(
          'Sign in with Puter',
          'Cloud',
          run(async () => {
            await ensureSignedIn();
            dialog.close();
          }),
          'btn primary',
        ),
      );
    if (focused) (accountActions.querySelector('button') || select).focus();
  };
  const dialog = modal('Settings', body);
  dialog.classList.add('app-dialog');
  refreshAccount();
  settingsAccountViews.add(refreshAccount);
  dialog.addEventListener('close', () => settingsAccountViews.delete(refreshAccount), {
    once: true,
  });
}
function shortcuts() {
  modal(
    'Keyboard shortcuts',
    el(
      'div',
      { class: 'shortcut-list' },
      ...[
        [P.isApp() ? 'Open from Puter' : 'Open a PDF', 'Ctrl / ⌘ O'],
        ['Save to Puter', 'Ctrl / ⌘ S'],
        [P.isApp() ? 'Save to another Puter folder' : 'Download', 'Ctrl / ⌘ Shift S'],
        ['Undo', 'Ctrl / ⌘ Z'],
        ['Redo', 'Ctrl / ⌘ Shift Z or Ctrl Y'],
        ['Find in PDF', 'Ctrl / ⌘ F'],
        ['Find next / previous', 'Ctrl / ⌘ G, with Shift; F3'],
        ['Print', 'Ctrl / ⌘ P'],
        ['Zoom in / out', 'Ctrl / ⌘ + / −'],
        ['Fit page', 'Ctrl / ⌘ 0'],
        ['Actual size', 'Ctrl / ⌘ 1'],
        ['Fit width', 'Ctrl / ⌘ 2'],
        ['Previous / next page', 'Alt ← / →'],
        ['First / last page', 'Home / End'],
        ['Go to page', 'Ctrl / ⌘ Shift N'],
        ['Rotate the page clockwise', 'Ctrl / ⌘ Shift R'],
        ['Delete the page', 'Ctrl / ⌘ Shift D'],
        ['Document properties', 'Ctrl / ⌘ D'],
        ['Full screen', 'Ctrl / ⌘ L'],
        ['Show or hide the side panel', 'F4'],
        ['Show or hide the tools pane', 'Shift F4'],
        ['Select tool / Hand tool', 'V / H'],
        ['Move the pages while held', 'Space'],
      ].map(([label, key]) => el('div', {}, el('span', {}, label), el('kbd', {}, key))),
    ),
  ).classList.add('app-dialog');
}
function about() {
  modal(
    'About PDF Editor',
    el(
      'div',
      { class: 'stack' },
      appIcon(64),
      el(
        'p',
        {},
        'A focused workspace for reading, annotating, filling forms, and organizing PDFs.',
      ),
      el(
        'p',
        {},
        'PDF.js renders your pages. pdf-lib writes changes. Processing happens on your device; cloud files are stored through Puter.',
      ),
      el(
        'p',
        { class: 'muted' },
        'Use Text to click and edit supported existing text, or add text in an empty area. Compatible paragraphs reflow within their column. Marks and images become part of the page. Deleting text is not redaction: use Redact a PDF to remove content for good. Scan & OCR recognizes English text on the device. Password-protected PDFs open with their password and are encrypted again when saved; certificate-secured files are unsupported. Editing a signed PDF invalidates its signatures; sign last.',
      ),
      el(
        'a',
        { href: './THIRD_PARTY_NOTICES.txt', target: '_blank', rel: 'noopener' },
        'Open-source licenses',
      ),
    ),
  ).classList.add('app-dialog');
}
async function canLeave(signal) {
  if (signal?.aborted) return false;
  if (!editor?.dirty) return true;
  // Sign-in and saving can outlive this PDF or a newer open that is still reading its bytes.
  const leavingEditor = editor;
  const generation = openGeneration;
  const isCurrent = () =>
    !signal?.aborted && editor === leavingEditor && generation === openGeneration;
  if (user) {
    // Saving is offered right here, as a desktop editor does, rather than sending the reader
    // back to find the Save button and then leave again.
    const choice = await new Promise((resolve) => {
      const dialog = modal(
        'Leave this PDF?',
        el(
          'p',
          {},
          `${leavingEditor.name} has unsaved changes. Save them to Puter before leaving, or leave and discard them.`,
        ),
        [
          button('Cancel', null, () => dialog.close()),
          button(
            'Leave without saving',
            null,
            () => {
              resolve('leave');
              dialog.close();
            },
            'btn danger',
          ),
          button(
            'Save and leave',
            null,
            () => {
              resolve('save');
              dialog.close();
            },
            'btn primary',
          ),
        ],
        { signal },
      );
      dialog.classList.add('leave-save-dialog');
      dialog.addEventListener('close', () => resolve('stay'), { once: true });
    });
    if (!isCurrent()) return false;
    if (choice !== 'save') return choice === 'leave';
    try {
      await leavingEditor.save();
    } catch (error) {
      if (isCurrent()) toast(error.message || 'The PDF could not be saved.', { error: true });
      return false;
    }
    // A save that was cancelled or overtaken by new edits leaves the PDF open.
    return isCurrent() && !leavingEditor.dirty;
  }
  // Without an account the PDF has nowhere to go yet: offer the sign-in that saving needs.
  const choice = await new Promise((resolve) => {
    const dialog = modal(
      'Save before leaving?',
      el(
        'p',
        {},
        'This PDF is not saved anywhere yet. Sign in to Puter to save it to your own cloud, or leave and discard the changes. To download it instead, keep editing and choose Download.',
      ),
      [
        button('Keep editing', null, () => dialog.close()),
        button(
          'Leave without saving',
          null,
          () => {
            resolve('leave');
            dialog.close();
          },
          'btn danger',
        ),
        button(
          'Sign in and save',
          null,
          () => {
            resolve('sign-in');
            dialog.close();
          },
          'btn primary',
        ),
      ],
      { signal },
    );
    dialog.classList.add('leave-save-dialog');
    dialog.addEventListener('close', () => resolve('stay'), { once: true });
  });
  if (!isCurrent()) return false;
  if (choice !== 'sign-in') return choice === 'leave';
  try {
    await ensureSignedIn();
  } catch {
    return false; // The sign-in was dismissed; the PDF stays open.
  }
  if (!isCurrent()) return false;
  await leavingEditor.save();
  return isCurrent() && !leavingEditor.dirty;
}
const PICTURE_TYPES = 'image/png,image/jpeg';
const isPdfFile = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
const isPictureFile = (file) =>
  PICTURE_TYPES.split(',').includes(file.type) || /\.(png|jpe?g)$/i.test(file.name);
function pickFiles(accept) {
  const input = el('input', { type: 'file', accept, multiple: true });
  input.onchange = run(async () => {
    if (input.files.length) await openFiles([...input.files]);
  });
  input.click();
}
const pickDevice = () => pickFiles(`.pdf,application/pdf,${PICTURE_TYPES}`);
const pickPictures = () => pickFiles(PICTURE_TYPES);
/**
 * Only one PDF is open at a time. When several files arrive together and one of them is a PDF,
 * it opens and the reader learns what became of the others, and where they can be combined.
 */
function oneOfSeveral(opened, name, count) {
  if (opened && count > 1)
    toast(
      `Opened ${name}. One PDF opens at a time; to put several files into one PDF, use Combine files in Tools.`,
    );
}
/** A PDF opens as it is; pictures become the pages of a new PDF, one each, in the given order. */
async function openFiles(files) {
  const pdf = files.find(isPdfFile);
  if (pdf) return oneOfSeveral(await openDevice(pdf), pdf.name, files.length);
  const pictures = files.filter(isPictureFile);
  if (!pictures.length) throw new Error('Choose a PDF, or PNG and JPEG pictures.');
  const name = pictures[0].name.replace(/\.[^.]+$/, '') || 'Pictures';
  await openDocument(async (signal) => {
    const [{ imagesToPdf, defaultPaper }, { normalizeImageFiles }] = await Promise.all([
      import('./core/image-pages.js'),
      import('./image-codec.js'),
    ]);
    signal.throwIfAborted();
    const images = await normalizeImageFiles(pictures, { lazy: true, signal });
    // An obsolete batch must not decode and embed pictures after its file reads finish.
    signal.throwIfAborted();
    return imagesToPdf(images, { paper: defaultPaper(), signal });
  }, `${name}.pdf`);
}
async function openDevice(file) {
  if (file.size > MAX_FILE_SIZE) throw new Error('Choose a PDF smaller than 100 MB.');
  return openDocument(async () => new Uint8Array(await file.arrayBuffer()), file.name);
}
async function openCloudItem(item) {
  if (Array.isArray(item)) item = item[0];
  if (item?.path) {
    if (item.size > MAX_FILE_SIZE) throw new Error('Choose a PDF smaller than 100 MB.');
    const source = { remote: null };
    return openDocument(
      (signal) =>
        waitFor(async () => {
          await settleAccount(signal);
          // Described before it is read: a description taken after a slow read could belong
          // to somebody else's newer file, which saving would then overwrite unasked.
          source.remote = P.canStat() ? await P.statFile(item.path).catch(() => null) : null;
          const bytes = await P.readFile(item.path, { maxBytes: MAX_FILE_SIZE, signal });
          await settleAccount(signal);
          return bytes;
        }, signal),
      item.name || item.path.split('/').pop(),
      item.path,
      { signal: accountController.signal, source },
    );
  }
}
const isPdfName = (name) => /\.pdf$/i.test(name || '');
const isPictureName = (name) => /\.(png|jpe?g)$/i.test(name || '');
/**
 * Files the desktop hands over: opened with the app, or dragged onto its window. A PDF opens
 * as it is, and pictures become the pages of a new PDF, as they do when chosen on this device.
 */
async function openDesktopItems(items) {
  const files = (items || []).filter((item) => item?.path && !P.isDirItem(item));
  if (!files.length) {
    if (items?.length) throw new Error('Folders cannot be opened. Open a PDF from the folder.');
    return;
  }
  const name = (item) => item.name || item.path.split('/').pop();
  const pdf = files.find((item) => isPdfName(name(item)));
  if (pdf) return oneOfSeveral(await openCloudItem(pdf), name(pdf), files.length);
  const pictures = files.filter((item) => isPictureName(name(item)));
  if (!pictures.length)
    throw new Error(`${name(files[0])} is not a PDF. Open a PDF, or PNG and JPEG pictures.`);
  const signal = accountController.signal;
  const blobs = await waitFor(
    () =>
      Promise.all(
        pictures.map((item) => P.readBlob(item.path, { maxBytes: MAX_FILE_SIZE, signal })),
      ),
    signal,
  );
  await openFiles(
    blobs.map((blob, i) => {
      const fileName = name(pictures[i]);
      const type = /\.png$/i.test(fileName) ? 'image/png' : 'image/jpeg';
      return new File([blob], fileName, { type });
    }),
  );
}
const pickCloud = run(async () => {
  // Authentication and the cloud picker can return after another file choice or navigation.
  // Claim the request before either one, and ignore obsolete answers and failures.
  const token = ++cloudOpenGeneration;
  let item;
  try {
    await ensureSignedIn();
    if (token !== cloudOpenGeneration) return;
    item = await P.pickFile();
  } catch (error) {
    if (token !== cloudOpenGeneration) return;
    throw error;
  }
  if (token === cloudOpenGeneration && item) await openCloudItem(item);
});
async function openDocument(
  readBytes,
  name,
  path = null,
  { signal: sourceSignal, source = null } = {},
) {
  if (sourceSignal?.aborted) return;
  cloudOpenGeneration++;
  // The newest request wins: a file launched from the desktop replaces the landing document
  // even while that one is still opening. Reserve its turn before reading or converting the
  // source, so an older slow read (or its failure) cannot replace the latest choice.
  loading = true;
  const token = ++openGeneration;
  openController?.abort();
  const controller = (openController = new AbortController());
  // Cloud files belong to the account that requested them. Retire their entire open,
  // including parsing and password prompts, when that session ends. Local opens stay independent.
  const abortSource = () => {
    controller.abort(sourceSignal.reason);
    if (token === openGeneration) {
      openGeneration++;
      loading = false;
    }
  };
  sourceSignal?.addEventListener('abort', abortSource, { once: true });
  let nextEditor;
  try {
    let bytes = await readBytes(controller.signal);
    if (token !== openGeneration) return;
    let protection = null,
      encryptedOriginal = null;
    try {
      bytes = await preparePdfForEditing(bytes);
    } catch (error) {
      if (token !== openGeneration) return;
      if (error.code !== 'encrypted') throw error;
      // A protected file opens once its password is known; the working copy is then plain.
      const { promptUnlock } = await import('./unlock-dialog.js');
      if (token !== openGeneration) return;
      const unlocked = await promptUnlock(bytes, safeName(name), {
        signal: controller.signal,
        beforeOpen: () => waitForAppDialogsToClose({ signal: controller.signal }),
      });
      if (token !== openGeneration) return;
      if (!unlocked) {
        // A library already on screen keeps its search, sort, and the file chosen in it.
        if (!editor && !root.querySelector('.home')) showHome();
        return;
      }
      // Certificate signatures cover the encrypted file, so it is kept to validate them.
      encryptedOriginal = bytes;
      bytes = unlocked.bytes;
      protection = unlocked.protection;
      bytes = await preparePdfForEditing(bytes);
    }
    if (
      token !== openGeneration ||
      !(await waitForAppDialogsToClose({ signal: controller.signal }))
    )
      return;
    if (token !== openGeneration || !(await canLeave(controller.signal))) return;
    const { createEditor } = await import('./editor.js');
    if (token !== openGeneration) return;
    editor?.destroy();
    homeGeneration++;
    const session = new PdfSession(bytes);
    nextEditor = createEditor({
      root,
      session,
      name: safeName(name),
      path,
      remote: (path && source?.remote) || null,
      protection,
      encryptedOriginal,
      settings,
      shortcuts,
      getUser: () => (accountRefreshRequest || sessionChanged() ? null : user),
      signedOut: () => sessionState === 'out',
      signIn: (signal) => ensureSignedIn({ signal }),
      goHome: run(async () => {
        if (await canLeave()) showHome();
      }),
      onOpen: pickDevice,
      onOpenCloud: pickCloud,
      onNew: run(() => openDocument(blankPdf, 'Untitled.pdf')),
      onOpenBytes: run((bytes, name) => openDocument(async () => bytes, name)),
    });
    editor = nextEditor;
    if (location.hash === LIBRARY_HASH)
      history.replaceState(null, '', location.pathname + location.search);
    await nextEditor.ready;
    // Whether this PDF is the one now open (a newer choice may have replaced it meanwhile).
    return token === openGeneration && editor === nextEditor;
  } catch (error) {
    if (token !== openGeneration) return;
    if (nextEditor && editor === nextEditor) showHome();
    throw error;
  } finally {
    sourceSignal?.removeEventListener('abort', abortSource);
    if (token === openGeneration) loading = false;
    if (openController === controller) openController = null;
    controller.abort();
  }
}
/** The app's name, and the library view's own heading. */
function brand() {
  return el('h1', { class: 'brand' }, appIcon(), el('span', {}, 'PDF Editor'));
}
function showHome({ accountRefresh = false } = {}) {
  // Updating the library after signing in belongs to the pending cloud-open workflow.
  // Actual navigation to the library retires that workflow instead.
  if (!accountRefresh) cloudOpenGeneration++;
  openGeneration++;
  openController?.abort();
  openController = null;
  loading = false;
  editor?.destroy();
  editor = null;
  document.title = 'PDF Editor';
  P.setWindowTitle('PDF Editor');
  if (location.hash !== LIBRARY_HASH) history.replaceState(null, '', LIBRARY_HASH);
  const generation = ++homeGeneration;
  const list = el('div', { class: 'file-list' });
  let files = [],
    loadGeneration = 0,
    filter = '',
    libraryState = 'ready',
    sort = 'modified';
  const search = el('input', {
    type: 'search',
    class: 'input search-input',
    placeholder: 'Search PDFs',
    'aria-label': 'Search PDFs',
    oninput: (e) => {
      filter = e.target.value.toLowerCase();
      renderFiles();
    },
  });
  const sortSelect = el(
    'select',
    {
      class: 'sort-select',
      'aria-label': 'Sort PDFs',
      onchange: (e) => {
        sort = e.target.value;
        renderFiles();
      },
    },
    el('option', { value: 'modified' }, 'Last modified'),
    el('option', { value: 'name' }, 'Name'),
    el('option', { value: 'size' }, 'Size'),
  );
  const renderFiles = () => {
    list.replaceChildren();
    if (libraryState === 'loading') {
      list.append(el('div', { class: 'empty-library' }, 'Loading your PDFs…'));
      return;
    }
    if (libraryState === 'error') {
      list.append(
        el(
          'div',
          { class: 'empty-library' },
          el('p', {}, 'Your library could not be loaded.'),
          button('Try again', 'RefreshCw', load),
        ),
      );
      return;
    }
    const shown = files
      .filter((f) => f.name.toLowerCase().includes(filter))
      .sort((a, b) =>
        sort === 'name'
          ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
          : (b[sort] || 0) - (a[sort] || 0),
      );
    if (!shown.length) {
      list.append(
        el(
          'div',
          { class: 'empty-library' },
          icon(filter ? 'Search' : 'FolderOpen', 30),
          el(
            'h3',
            {},
            filter
              ? 'No matching PDFs'
              : user
                ? 'Your library starts here'
                : 'Your PDFs, in your own cloud',
          ),
          el(
            'p',
            {},
            filter
              ? 'Try another file name.'
              : user
                ? 'Open a PDF and save it to Puter to find it here.'
                : 'Sign in with Puter to save and access your files across devices.',
          ),
          !user && !filter && button('Sign in with Puter', 'Cloud', run(ensureSignedIn)),
        ),
      );
      return;
    }
    list.append(
      el(
        'div',
        { class: 'file-table-head', 'aria-hidden': 'true' },
        el('span', {}, 'Name'),
        el('span', {}, 'Modified'),
        el('span', {}, 'Size'),
        el('span'),
      ),
    );
    shown.forEach((file) => {
      const timestamp = file.modified;
      const date = timestamp
        ? new Date(timestamp).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })
        : 'Unknown';
      list.append(
        el(
          'div',
          { class: 'file-row' },
          button(
            file.name,
            'FileText',
            run(() => openCloudItem(file)),
            'file-open',
          ),
          el('span', { class: 'file-date muted' }, date),
          el('span', { class: 'file-size muted' }, formatBytes(file.size || 0)),
          iconButton(`Options for ${file.name}`, 'MoreHorizontal', (e) => {
            // Safari does not focus clicked buttons; give the dialog a real return target.
            e.currentTarget.focus({ preventScroll: true });
            fileOptions(file);
          }),
        ),
      );
    });
  };
  function refreshAfterAction() {
    load();
    // Replacing the rows can remove the focused action button. Recover focus in that
    // case, but keep a newer focus choice made while the cloud action was pending.
    if (document.activeElement === document.body) search.focus({ preventScroll: true });
  }
  function fileOptions(file) {
    // This file and every confirmation derived from it belong to this account session.
    const signal = accountController.signal;
    // Download and Duplicate read (and write) in the cloud before the dialog closes; while
    // one runs, every action is disabled so a second click cannot start another copy.
    let working = false;
    const action = (fn) =>
      run(async () => {
        if (working || signal.aborted) return;
        working = true;
        const buttons = [...d.querySelectorAll('.dialog-body button')];
        buttons.forEach((b) => (b.disabled = true));
        try {
          await settleAccount(signal);
          await fn();
        } catch (error) {
          // A previous account's cloud failure must not appear in a newer workflow.
          if (!signal.aborted) throw error;
        } finally {
          working = false;
          buttons.forEach((b) => (b.disabled = false));
        }
      });
    const d = modal(
      file.name,
      el(
        'div',
        { class: 'stack' },
        button(
          'Open PDF',
          'FolderOpen',
          action(async () => {
            d.close();
            await openCloudItem(file);
          }),
        ),
        button(
          'Download',
          'Download',
          action(async () => {
            const bytes = await P.readFile(file.path, { signal });
            await settleAccount(signal);
            download(bytes, file.name);
            d.close();
          }),
        ),
        button(
          'Rename',
          'Pencil',
          action(async () => {
            d.close();
            const name = await promptText(
              'Rename PDF',
              'File name',
              file.name.replace(/\.pdf$/i, ''),
              { signal },
            );
            await settleAccount(signal);
            if (name && !signal.aborted) {
              await P.renameFile(file.path, name);
              if (!signal.aborted) refreshAfterAction();
            }
          }),
        ),
        button(
          'Duplicate',
          'Copy',
          action(async () => {
            // A cloud read can finish after sign-out and another account's sign-in.
            // Only the session that requested the copy may initiate its write.
            let bytes;
            try {
              bytes = await P.readFile(file.path, { signal });
              await settleAccount(signal);
              signal.throwIfAborted();
            } catch (error) {
              if (signal.aborted) return;
              throw error;
            }
            await P.saveFile(file.name.replace(/\.pdf$/i, ' copy'), bytes);
            d.close();
            if (!signal.aborted) refreshAfterAction();
          }),
        ),
        button(
          'Delete',
          'Trash2',
          action(async () => {
            d.close();
            if (
              await confirmAction(
                'Delete PDF?',
                `Delete ${file.name} from your Puter cloud? This cannot be undone.`,
                'Delete PDF',
                { signal },
              )
            ) {
              await settleAccount(signal);
              if (signal.aborted) return;
              await P.deleteFile(file.path);
              if (!signal.aborted) refreshAfterAction();
            }
          }),
          'btn danger',
        ),
      ),
      [],
      { signal },
    );
  }
  async function load() {
    const token = ++loadGeneration;
    const signal = accountController.signal;
    libraryState = user ? 'loading' : 'ready';
    renderFiles();
    if (!user) return;
    try {
      await settleAccount(signal);
      const next = await P.listFiles();
      await settleAccount(signal);
      if (generation !== homeGeneration || token !== loadGeneration) return;
      // Compare the same timestamps we display. Cloud metadata can use seconds or
      // milliseconds; sorting the raw values would put older millisecond dates first.
      files = next.map((file) => {
        const modified = Number(file.modified);
        return { ...file, modified: modified < 1e12 ? modified * 1000 : modified };
      });
      libraryState = 'ready';
      renderFiles();
    } catch {
      if (generation === homeGeneration && token === loadGeneration) {
        libraryState = 'error';
        renderFiles();
      }
    }
  }
  root.replaceChildren(
    el(
      'div',
      { class: 'home' },
      el(
        'header',
        { class: 'topbar' },
        brand(),
        el(
          'div',
          { class: 'header-right' },
          el(
            'span',
            { class: 'account-label', title: user?.username || 'Local workspace' },
            user?.username || 'Local workspace',
          ),
          iconButton('Settings', 'Settings2', settings),
        ),
      ),
      el(
        'main',
        { id: 'main', class: 'home-main', tabindex: '-1' },
        el(
          'div',
          { class: 'start-grid' },
          el(
            'button',
            { class: 'open-card', onclick: pickDevice, type: 'button' },
            el('span', { class: 'open-card-icon' }, icon('Upload', 27)),
            el('strong', {}, 'Open a PDF'),
            el('span', {}, 'Choose a PDF or pictures, or drop them anywhere'),
            el('span', { class: 'card-cta' }, 'Browse files', icon('ArrowUpRight', 16)),
          ),
          el(
            'div',
            { class: 'quick-actions' },
            button(
              'New blank PDF',
              'FilePlus2',
              run(() => openDocument(blankPdf, 'Untitled.pdf')),
              'quick-action',
            ),
            button('Pictures to PDF', 'Images', pickPictures, 'quick-action'),
            button('Open from Puter', 'Cloud', pickCloud, 'quick-action'),
            button(
              'Try a sample PDF',
              'BookOpen',
              run(() => openDocument(samplePdf, 'Getting started.pdf')),
              'quick-action',
            ),
          ),
        ),
        el(
          'section',
          { class: 'library', 'aria-labelledby': 'library-title' },
          el(
            'div',
            { class: 'library-head' },
            el('h2', { id: 'library-title' }, 'Your PDFs'),
            el(
              'div',
              { class: 'library-tools' },
              sortSelect,
              el('div', { class: 'search-wrap' }, icon('Search', 16), search),
            ),
          ),
          list,
        ),
        el(
          'div',
          { class: 'local-note' },
          icon('Cloud', 16),
          el(
            'span',
            {},
            'PDFs are processed on your device. Cloud files are saved in your Puter account.',
          ),
        ),
      ),
      el(
        'footer',
        { class: 'home-footer' },
        el('span', {}, 'PDF Editor'),
        button('Keyboard shortcuts', 'Keyboard', shortcuts, 'text-btn'),
      ),
    ),
  );
  load();
}
window.addEventListener('beforeunload', (e) => {
  if (editor?.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});
window.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    // On the Puter desktop the files are in the cloud, so Open browses it, as other desktop
    // apps do; the device picker stays in the File menu.
    if (P.isApp()) pickCloud();
    else pickDevice();
  }
});
let dragDepth = 0;
/**
 * A modal dialog owns the screen and the keyboard, as the Open shortcut above already respects.
 * A file dropped while one is open used to replace the document behind it, leaving the dialog
 * over a document it no longer belonged to, where its own button quietly did nothing.
 */
const dialogOpen = () => !!document.querySelector('dialog[open]');
window.addEventListener('dragenter', (e) => {
  if (!dialogOpen() && [...(e.dataTransfer?.types || [])].includes('Files')) {
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dropping');
  }
});
window.addEventListener('dragover', (e) => {
  if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dropping');
  }
});
window.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  // Only file drops belong to the app. Text dragged into a field keeps its native insertion,
  // which cancelling the event here would silently discard.
  if (!files.length && !document.body.classList.contains('dropping')) return;
  // The drop is always cancelled, even when it is ignored: the browser would otherwise leave
  // the app and show the file itself.
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  if (!files.length) return;
  // The message lands in the open dialog, which is where the reader is looking.
  if (dialogOpen()) return toast('Close this dialog to open a dropped file.', { error: true });
  run(() => openFiles(files))();
});
window.addEventListener('hashchange', () => {
  if (location.hash !== LIBRARY_HASH || !editor) return;
  run(async () => {
    const generation = openGeneration;
    if (await canLeave()) showHome();
    else if (generation === openGeneration)
      history.replaceState(null, '', location.pathname + location.search);
  })();
});
syncThemeColor();
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', syncThemeColor);
// Nobody has to sign in to work: the app opens straight into a blank PDF (or the library at
// its own URL), and Puter is asked for a sign-in at the first action that needs the cloud.
async function start() {
  if (location.hash === LIBRARY_HASH) {
    showHome();
    return;
  }
  try {
    await openDocument(blankPdf, 'Untitled.pdf');
  } catch (e) {
    if (!editor && !loading) showHome();
    toast(e.message || 'Something went wrong. Please try again.', { error: true });
  }
}
start();
// The SDK script is async, so the workspace renders before it arrives and the account state
// is applied once it has loaded. Only a signed-in account changes what the home shows.
const initPuter = async () => {
  // The SDK signs the user in on its own before some cloud calls; the views follow.
  P.onAuth(run(refreshSDKAccount));
  if (P.isApp()) {
    // The desktop already has a session. File and close events must not wait for its profile.
    setAccount({ username: 'Puter user' });
    const onItems = (items) => {
      items = Array.isArray(items) ? items : [items];
      if (items.length) run(() => openDesktopItems(items))();
    };
    // onItemsOpened also replays the launch file. Subscribing to both reads it twice.
    if (globalThis.puter.ui.onItemsOpened) globalThis.puter.ui.onItemsOpened(onItems);
    else globalThis.puter.ui.onLaunchedWithItems?.(onItems);
    // A second press of the close button while its question is open must not stack another
    // on top; the first answer decides. Only the question counts: a save it started that
    // never settles must not leave the button dead.
    P.onWindowClose(
      run(async () => {
        if (document.querySelector('dialog.leave-save-dialog[open]')) return;
        if (await canLeave()) P.exitApp();
      }),
    );
    if (!editor) P.setWindowTitle('PDF Editor');
  }
  // A sign-in or sign-out can finish while the SDK's initial session/profile read is
  // pending. Its older answer must not change the newer account or reset library work.
  const version = accountGeneration;
  // Observe credentials before either read waits: an explicit sign-in can finish first.
  const token = (accountToken = P.sessionToken());
  const signedIn = await P.isSignedIn();
  if (version !== accountGeneration) return;
  if (token !== P.sessionToken()) return refreshSDKAccount();
  if (signedIn) {
    const account = await P.currentUser();
    if (version !== accountGeneration) return;
    if (token !== P.sessionToken()) return refreshSDKAccount();
    setAccount(account || { username: 'Puter user' }, { profileOnly: P.isApp() });
  } else {
    accountToken = token;
    sessionState = 'out';
    editor?.updateAccount();
  }
};
if (globalThis.puter) initPuter();
else window.addEventListener('load', initPuter, { once: true });

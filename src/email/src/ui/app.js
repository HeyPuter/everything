import { el, clear, append } from './dom.js';
import { icon } from './icons.js';
import { loadingPlaceholder } from './loading.js';
import { calendarCard } from './calendar.js';
import { attachMenu } from './menu.js';
import { confirmDialog, openModal } from './modal.js';
import { toast } from './toast.js';
import { applyTheme, currentTheme, THEMES } from './theme.js';
import { openShortcuts, FOLDER_KEYS } from './shortcuts.js';
import { openSignatureDialog } from './signature.js';
import { discardComposer } from './compose.js';
import {
  createMailbox, enrichMessage, moveMessage, boxPath, BOX_DIRS,
} from '../lib/mailbox.js';
import { createMessageReads } from '../lib/messagereads.js';
import { checkAbort, yieldTask } from '../lib/work.js';
import { mailSubject, locate, planChanges } from '../lib/watch.js';
import {
  createReadState, createStarState, createOriginState, createImageState,
  memoryStorage,
} from '../lib/readstate.js';
import { draftToMessage } from '../lib/drafts.js';
import { mergeContacts } from '../lib/contacts.js';
import { createSettings } from '../lib/settings.js';
import {
  splitMessage, parseHeaders, parseAddress, parseAddressList, decodeWords, decodeBytes, subjectFromFilename,
  extractBodyText, extractHtml, listAttachments, listInlineParts, parseListUnsubscribe, referencedCids, listCalendarInvites,
} from '../lib/mime.js';
import { sanitizeHtml, hasRemoteContent } from '../lib/sanitize.js';
import { linkify } from '../lib/linkify.js';
import {
  formatWhen, formatFullDate, initialFor, hueFor, formatSize,
} from '../lib/format.js';
import {
  replyRecipients, replySubject, forwardSubject, forwardBlock, bytesToBase64, safeFilename,
  PUTER_DOMAINS,
} from '../lib/compose.js';
import {
  parseQuery, matchesQuery, needsIndex, needsSearchRead, mayMatchSubject, createSearchIndex,
} from '../lib/search.js';
import {
  groupThreads, singleThread, makeThread, normalizeSubject, conversationHistory,
  parseMessageId, parseReferences, splitQuotedTail,
} from '../lib/thread.js';

const ENRICH_CONCURRENCY = 6;
/**
 * Reads in flight while a folder is being grouped into conversations. Higher
 * than the row enrichment above because nothing is on screen yet: this is the
 * one read the list waits for rather than one it does behind the reader.
 */
const HEAD_CONCURRENCY = 12;
/**
 * Reads in flight while a search indexes the rest of the folder. The results
 * are what the user is waiting on -- a search over a folder of thousands is
 * the one place the app makes them wait on the index -- so it gets as many
 * reads as the visible rows do; at three, a folder of fifteen hundred took
 * twice as long to search as it does now. Not as many as grouping takes,
 * which leaves room for the rows and the message being read meanwhile.
 */
const INDEX_CONCURRENCY = 6;
const INDEX_FLUSH_MS = 2000;
const SEARCH_DEBOUNCE_MS = 200;
const RESULT_PAGE_SIZE = 60;
const FOLDER_WINDOW_SIZE = 300;
const THREAD_PAGE_SIZE = 60;
const NAV_LS_KEY = 'puter-mail:nav';
const THREAD_LS_KEY = 'puter-mail:conversations';
const NOTIFY_LS_KEY = 'puter-mail:notify';
// Seconds a send can be taken back for, and the one it is until changed.
const UNDO_SEND_CHOICES = [0, 5, 10, 20, 30];
const UNDO_SEND_DEFAULT = 5;
const BASE_TITLE = 'Puter Mail';
// What the reader shows where a message has no text of its own -- a photo
// sent from a phone with nothing typed under it. A note about the message,
// not part of it, so it is never quoted into an answer.
const EMPTY_BODY = '(no text content)';

/**
 * How often a visible tab looks for new mail when the mailbox cannot be
 * watched -- a Puter without the Events API, a server with it turned off, a
 * subscription that lapsed and could not be made again. Every check is a
 * readdir against the user's own filesystem -- normally one sorted recursive
 * page, or a root/day traversal for large roots and older SDKs. With the
 * watch standing nothing polls: mail is pushed as it lands. A hidden tab does
 * not poll at all; it checks once when it comes back, which is when the
 * answer matters.
 */
const POLL_MS = 60_000;
/**
 * How long a run of filesystem events is gathered before anything is done
 * about it. The server coalesces writes to one file over 250ms; this is per
 * batch, so a dozen messages delivered together are one listing rather than
 * twelve -- and it is long enough that a write this shell made has answered
 * before the event it caused is looked at, so it is recognised as the shell's
 * own rather than another device's.
 */
const WATCH_SETTLE_MS = 500;
const mobile = () => matchMedia('(max-width: 800px)').matches;

/**
 * The Gmail-style inbox shell: top bar with search, folder sidebar, and a
 * content card that swaps between the message list and an open message.
 * `ctx` carries the fs to read from (puter.fs in the app, the in-memory
 * sample mailbox in the tests) plus account/session callbacks. `ctx.events`
 * is the Events API when this Puter has one; the shell watches `.mail` over it
 * and polls only where it cannot.
 *
 * A folder is a mailbox listing plus a way of reading it. Inbox, Sent,
 * Archive and Trash are separate mailboxes over sibling folders under
 * `.mail`, all read by the same listing code; Starred is the inbox filtered
 * by the star flags. Sent only exists where sending does.
 *
 * Archive and delete are moves between those folders, which is what makes
 * undo exact: the reverse move restores the file, and read and star flags are
 * keyed on the filename, so they survive both.
 */
export function renderApp(root, ctx) {
  const messageReads = createMessageReads(ctx.fs);
  // Sending is what creates Sent and Drafts, so neither exists without it.
  const canSend = Boolean(ctx.onCompose);
  const draftStore = canSend ? ctx.drafts : null;

  /**
   * Drafts are not files, so they are not a mailbox -- but the list only
   * knows how to render a mailbox, so the store is wrapped in one. Nothing
   * here reads the filesystem: everything a draft row shows is already in the
   * stored draft.
   */
  const draftsBox = draftStore && (() => {
    const messages = [];
    const relist = () => {
      messages.length = 0;
      // The recipients as the chips they were typed into show them: by name,
      // where the address book has one. A draft stores bare addresses, so its
      // row read `ana@meridianlabs.example` where every other row -- and the
      // chip for the same person in the dialog it opens -- reads "Ana
      // Petrova". The book is the header index asked a second question, as
      // it is for the chips, and is read once per listing rather than per
      // row.
      const names = new Map(mergeContacts(searchIndex.addresses())
        .filter((contact) => contact.name)
        .map((contact) => [contact.email, contact.name]));
      messages.push(...draftStore.list().map((draft) => {
        const message = draftToMessage(draft);
        message.to = message.to.map((person) => ({
          ...person, name: names.get(person.email.toLowerCase()) || person.name,
        }));
        return message;
      }));
      return [...messages];
    };
    return {
      box: 'drafts',
      messages,
      open: async () => relist(),
      loadMore: async () => [],
      // Every draft is already in memory, so the whole folder is the listing.
      listAll: async () => messages,
      get total() { return messages.length; },
      remove(message) {
        const at = messages.indexOf(message);
        if (at !== -1) messages.splice(at, 1);
        return at;
      },
      insert(message) {
        messages.unshift(message);
        return 0;
      },
      get hasMore() { return false; },
      get listError() { return null; },
    };
  })();

  const boxes = {
    ...Object.fromEntries(Object.keys(BOX_DIRS)
      .filter((box) => box !== 'sent' || canSend)
      .map((box) => [box, createMailbox({
        fs: ctx.fs,
        objectsPath: box === 'inbox' ? ctx.objectsPath : boxPath(ctx.mailPath, box),
        box,
        // Only the tests set this: a small page is how "more than one page"
        // is reached over a sample mailbox of thirteen messages.
        ...(ctx.pageSize ? { pageSize: ctx.pageSize } : {}),
      })])),
    ...(draftsBox ? { drafts: draftsBox } : {}),
  };

  const VIEWS = [
    { id: 'inbox', label: 'Inbox', icon: 'inbox', box: 'inbox' },
    { id: 'starred', label: 'Starred', icon: 'star', box: 'inbox' },
    ...(canSend ? [{ id: 'sent', label: 'Sent', icon: 'send', box: 'sent' }] : []),
    ...(draftsBox ? [{ id: 'drafts', label: 'Drafts', icon: 'pencil', box: 'drafts' }] : []),
    { id: 'archive', label: 'Archive', icon: 'archive', box: 'archive' },
    { id: 'trash', label: 'Trash', icon: 'trash', box: 'trash' },
  ];

  /**
   * What each folder offers on a row and in the message toolbar. Archive and
   * Trash are undoable moves and never ask; a permanent delete is the one
   * thing undo cannot cover, so that one confirms.
   */
  const ACTIONS = {
    archive: { label: 'Archive', icon: 'archive', to: 'archive', done: 'Archived', busy: 'Archiving' },
    trash: { label: 'Delete', icon: 'trash', to: 'trash', done: 'Moved', busy: 'Moving' },
    restore: { label: 'Restore', icon: 'restore', to: null, done: 'Restored', busy: 'Restoring' },
    purge: { label: 'Delete forever', icon: 'trash', danger: true, busy: 'Deleting' },
    discard: { label: 'Discard draft', icon: 'trash', danger: true },
  };
  const ACTIONS_BY_VIEW = {
    inbox: ['archive', 'trash'],
    starred: ['archive', 'trash'],
    sent: ['trash'],
    drafts: ['discard'],
    archive: ['restore', 'trash'],
    trash: ['restore', 'purge'],
  };
  // Which listings have been read at least once, so a folder is listed when
  // it is first opened rather than at launch.
  const listed = new Set();
  /**
   * A folder whose contents changed behind its listing -- a message filed
   * into it, a sent copy written, a change heard from another device. It is
   * listed again when next opened, and the catalog that search and the
   * reader's conversation history run over is read again when next asked
   * for, rather than answering from before the change.
   */
  const outdate = (box) => {
    listed.delete(box);
    boxes[box]?.forget?.();
  };
  // Only the tests set `ctx.sample`: it mounts the shell over the in-memory
  // sample mailbox, which is static and belongs to no account, so its flags
  // stay in memory and nothing is watched or polled for it.
  const scope = ctx.sample ? 'sample' : ctx.account.username;
  const storage = ctx.sample ? memoryStorage() : window.localStorage;
  // Flags render from the local cache immediately and reconcile with the
  // account store in the background.
  const flagOptions = {
    remote: ctx.sample ? null : ctx.flagStore ?? null,
    onChange: () => {
      for (const unit of shownUnits()) if (unit.row) updateRow(unit);
      updateMeta();
      updateNavCounts();
    },
  };
  const readState = createReadState(scope, storage, flagOptions);
  const starState = createStarState(scope, storage, flagOptions);
  const originState = createOriginState(scope, storage);
  const imageState = createImageState(scope, storage);
  // Preferences that are not flags on a message. Shared with whoever mounted
  // the shell when it has one -- main.js scopes it to the account -- and kept
  // in memory otherwise, which is what the tests want.
  const settings = ctx.settings ?? createSettings(scope, storage);
  // The stored choice, held to the choices offered: a hand-edited entry of
  // 600 would be ten minutes of a message that says it was sent.
  // How tight the list is. Compact is the 36px row of a client for someone
  // who reads a lot of mail; the default is the 44px one that reads better.
  const DENSITIES = ['default', 'compact'];
  const density = () => {
    const value = settings.get('density', 'default');
    return DENSITIES.includes(value) ? value : 'default';
  };
  const applyDensity = () => frame.classList.toggle('density-compact', density() === 'compact');

  // Whether archiving or deleting from the reader opens the next conversation
  // rather than going back to the list. Off by default, as it is in Gmail:
  // going back is the safer answer for anyone who has not asked otherwise.
  const autoAdvance = () => settings.get('autoAdvance', false) === true;

  const undoSendSeconds = () => {
    const value = settings.get('undoSend', UNDO_SEND_DEFAULT);
    return UNDO_SEND_CHOICES.includes(value) ? value : UNDO_SEND_DEFAULT;
  };

  // Reconciling costs one read of the account store, so it happens when the
  // answer might have changed: at startup, on a manual refresh, and when the
  // tab comes back.
  let lastPull = 0;
  const pullFlags = (force = false) => {
    if (!flagOptions.remote) return;
    const now = Date.now();
    if (!force && now - lastPull < 30_000) return;
    lastPull = now;
    readState.pull();
    starState.pull();
  };

  let opened = null;      // message currently shown in the message view
  let queryText = '';     // what is in the search field
  let query = parseQuery('');
  let folder = 'inbox';   // one of VIEWS[].id

  // Sender and preview per filename, so the mailbox is read once for search
  // rather than once per search.
  const searchIndex = createSearchIndex(scope, storage);

  /**
   * The conversation view, on by default because that is what a Gmail-shaped
   * client is: a row is a conversation, and the reader stacks the messages in
   * it. Turning it off makes every conversation one message long, which is
   * the same list this app had before threading -- so there is one code path
   * rather than two.
   */
  let threading = (() => {
    try {
      return storage.getItem(THREAD_LS_KEY) !== 'off';
    } catch {
      return true;
    }
  })();

  const setThreading = async (on) => {
    if (on === threading) return;
    threading = on;
    try {
      storage.setItem(THREAD_LS_KEY, on ? 'on' : 'off');
    } catch {}
    // The open message belongs to a conversation that is about to stop
    // existing in the form it was opened in.
    if (frame.classList.contains('reading')) closeReader({ focusRow: false });
    clearSelection();
    // Grouping needs a message id per message, and the folder was listed
    // without reading for them.
    if (on && threadable()) {
      showListLoading();
      await readHeads(mailbox().messages);
    }
    regroup();
    if (searching()) renderResults({ force: true });
    else renderList();
    toast(on ? 'Conversation view is on.' : 'Conversation view is off.', { iconName: 'inbox' });
  };

  const view = () => VIEWS.find((v) => v.id === folder) ?? VIEWS[0];
  const mailbox = () => boxes[view().box];

  // Mail the user wrote is never new to them.
  const OUTGOING = new Set(['sent', 'drafts']);
  const isUnread = (message) =>
    !OUTGOING.has(message.box) && !readState.isRead(message.name);

  /**
   * A row in Sent or Drafts shows who the message went to, so an index entry
   * written before recipients were recorded is no answer for one -- and the
   * conversation view needs a message id, so an entry written before there was
   * threading is no answer for that.
   */
  const hydrate = (message, { needsThread = false } = {}) =>
    searchIndex.hydrate(message, {
      needsRecipients: OUTGOING.has(message.box),
      needsThread,
    });

  // The inbox is about who wrote to you; Sent and Drafts are about who you
  // wrote to.
  const personFor = (message) => (OUTGOING.has(message.box) ? message.to?.[0] : message.from);
  const personLabelFor = (message) => {
    if (!OUTGOING.has(message.box)) return message.from?.name ?? '…';
    if (!message.to) return '…';
    if (!message.to.length) return '(no recipient)';
    const [first, ...rest] = message.to;
    const name = first.name || first.email;
    return rest.length ? `${name}, +${rest.length}` : name;
  };

  // The reader's own addresses on the sending domains, which is what makes a
  // conversation read "Ana, me, Leo" rather than repeating an address they own.
  const ownAddresses = new Set((ctx.account?.username
    ? PUTER_DOMAINS.map((domain) => `${ctx.account.username}@${domain}`)
    : []).map((address) => address.toLowerCase()));

  // -- conversations -----------------------------------------------------------

  /**
   * The list's unit is a conversation, and with the conversation view off it
   * is a conversation of one. Everything downstream -- rows, selection, the
   * bulk actions, the reader -- works on these rather than on messages, so
   * turning threading off changes what is grouped and nothing else.
   *
   * `units` mirrors the rows in `optionsEl`, in order, so a row's place in the
   * folder is `units.indexOf(unit)` and nothing has to be remembered.
   */
  let units = [];
  let folderOffset = 0;

  // Which rows show a message, so a header read or a changed flag repaints
  // every one of them. A message can be in two units at once: its conversation
  // in the folder, and a result of its own in a search.
  const track = (unit) => {
    for (const message of unit.messages) {
      if (!message.units) message.units = new Set();
      message.units.add(unit);
    }
    return unit;
  };
  const forget = (unit) => {
    for (const message of unit.messages) message.units?.delete(unit);
  };

  /**
   * Drafts are never threaded. A draft is not in a conversation yet -- it has
   * no message id, nothing answers it, and its row opens the dialog it came
   * from rather than a message, so two of them behind one row would have no
   * answer to which one that is.
   */
  const threadable = () => threading && view().box !== 'drafts';

  const groupOf = (messages) => (threadable()
    ? groupThreads(messages)
    : messages.map((message) => singleThread(message))).map(track);

  /**
   * Rebuild the folder's conversations from its listing, keeping the row of
   * every conversation that is still there -- so a re-listing, a page of older
   * mail, or the conversation view being switched on does not empty the
   * scroller under the reader.
   *
   * Matched on the newest message rather than on the conversation's id,
   * because loading an older page can put a new *oldest* message in front of a
   * conversation already on screen, which changes its id and nothing else
   * about it. Filenames are stable, so this survives a re-listing that built
   * every message object again.
   */
  const regroup = () => {
    // Keyed by folder as well as filename: a row carries the actions of the
    // folder it was built in, and the same file exists under both `objects/`
    // and `archive/` at different times.
    const at = (unit) => `${unit.latest.box}/${unit.latest.name}`;
    const previous = new Map(units.map((unit) => [at(unit), unit]));
    for (const unit of units) forget(unit);
    units = groupOf(mailbox().messages);
    for (const unit of units) {
      const old = previous.get(at(unit)) ?? unit.messages
        .map((message) => previous.get(`${message.box}/${message.name}`)).find(Boolean);
      if (!old) continue;
      if (old.row) {
        unit.row = old.row;
        rowUnit.set(old.row, unit);
      }
      if (selected.has(old)) {
        selected.delete(old);
        selected.add(unit);
      }
      if (opened === old) opened = unit;
    }
    // Whatever the listing no longer holds falls out of the selection: the
    // action bar went on offering to act on conversations whose rows had been
    // replaced under it.
    const held = new Set(units);
    for (const unit of [...selected]) if (!held.has(unit)) selected.delete(unit);
    // A row that was kept is a row built for a conversation that has since
    // changed -- gained an older message, or been split back into its
    // messages -- so it says what it says now rather than what it said then.
    for (const unit of units) if (unit.row) updateRow(unit);
    // A conversation the listing no longer holds cannot stay open over it.
    if (opened && !searching() && !units.includes(opened)) closeReader({ focusRow: false });
  };

  /**
   * A conversation shown as one result of a search. Search answers about
   * messages, not conversations, so a result is a conversation of one -- kept
   * per message so its row survives the repaints that indexing drives.
   */
  const resultUnits = new WeakMap();
  const resultUnit = (message) => {
    let unit = resultUnits.get(message);
    if (!unit) {
      unit = track(singleThread(message));
      resultUnits.set(message, unit);
    }
    return unit;
  };

  // Whichever set of rows is on screen: the folder's conversations, or the
  // search results.
  const shownUnits = () => (searching() ? results.slice(resultOffset, resultOffset + RESULT_PAGE_SIZE).map(resultUnit) : folderWindow());

  const unitStarred = (unit) => unit.messages.some((m) => starState.isStarred(m.name));
  const unitUnread = (unit) => unit.messages.some((m) => isUnread(m));
  const unitClipped = (unit) => unit.messages.some((m) => m.hasAttachments);
  // The subject a filename gave can be corrected by the header read, so it is
  // asked for rather than cached.
  const unitSubject = (unit) => unit.oldest?.subject || unit.latest?.subject || '';

  /**
   * Who a conversation names. One message names its sender, exactly as it
   * always did. More than one names everyone who wrote, in the order they
   * first did -- which is the column Gmail puts the message count next to.
   */
  const personLabel = (unit) => {
    if (unit.count === 1) return personLabelFor(unit.latest);
    const names = [];
    for (const message of unit.messages) {
      const person = personFor(message);
      const email = (person?.email || '').toLowerCase();
      const label = ownAddresses.has(email)
        ? 'me'
        : (person?.name || person?.email || '…');
      if (!names.includes(label)) names.push(label);
    }
    return names.join(', ');
  };

  /** Every message the actions on a conversation apply to. */
  const messagesOf = (list) => list.flatMap((unit) => unit.messages);
  const countOf = (list) => list.reduce((n, unit) => n + unit.count, 0);

  // -- top bar ----------------------------------------------------------------

  const menuBtn = el('button.icon-btn', {
    type: 'button', html: icon('menu', 20), 'aria-label': 'Main menu', 'aria-expanded': 'false',
  });

  let searchTimer = null;
  const searchInput = el('input.search-input', {
    type: 'search',
    placeholder: 'Search mail',
    'aria-label': 'Search mail',
    // Typing in a mailbox of thousands cannot start a listing per keystroke.
    oninput: () => {
      searchController?.abort();
      indexQueue.length = 0;
      indexNext = 0;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(searchInput.value), SEARCH_DEBOUNCE_MS);
    },
  });

  const themeBtn = el('button.icon-btn', {
    type: 'button', html: icon('settings', 20), 'aria-label': 'Settings', title: 'Settings',
  });
  attachMenu(themeBtn, () => [
    { header: 'Theme' },
    ...THEMES.map((t) => ({
      label: t.label,
      icon: t.icon,
      checked: currentTheme() === t.id,
      onSelect: () => applyTheme(t.id),
    })),
    { separator: true },
    { header: 'Density' },
    ...DENSITIES.map((id) => ({
      label: id === 'compact' ? 'Compact' : 'Default',
      icon: id === 'compact' ? 'rows3' : 'rows2',
      checked: density() === id,
      onSelect: () => {
        settings.set('density', id);
        applyDensity();
      },
    })),
    { separator: true },
    { header: 'Reading' },
    {
      label: 'Conversation view',
      icon: 'inbox',
      checked: threading,
      // On or off, not one of a set.
      toggle: true,
      onSelect: () => setThreading(!threading),
    },
    {
      label: 'Open the next conversation after archiving or deleting',
      icon: 'chevronRight',
      checked: autoAdvance(),
      toggle: true,
      onSelect: () => {
        const on = !autoAdvance();
        settings.set('autoAdvance', on);
        toast(on
          ? 'Archiving or deleting an open conversation opens the next one.'
          : 'Archiving or deleting an open conversation goes back to the list.',
        { iconName: 'chevronRight' });
      },
    },
    // Writing only exists where sending does.
    canSend && { separator: true },
    canSend && { header: 'Writing' },
    // How long a send is held with an Undo before the message goes. Five
    // seconds is the length of the moment in which the missing attachment is
    // noticed; anything longer and "Sent" stops meaning sent.
    ...(canSend ? UNDO_SEND_CHOICES.map((seconds) => ({
      label: seconds ? `Undo send for ${seconds} seconds` : 'No undo send',
      icon: seconds ? 'undo' : 'send',
      checked: undoSendSeconds() === seconds,
      onSelect: () => {
        settings.set('undoSend', seconds);
        toast(seconds
          ? `A sent message can be taken back for ${seconds} seconds.`
          : 'Messages are sent as soon as you press Send.', { iconName: seconds ? 'undo' : 'send' });
      },
    })) : []),
    canSend && {
      label: 'Signature…',
      icon: 'signature',
      onSelect: () => openSignatureDialog({
        value: settings.get('signature', ''),
        onSave: (text) => {
          const ok = settings.set('signature', text);
          toast(
            !ok ? 'The signature could not be saved on this device.'
              : text ? 'Signature saved.' : 'Signature removed.',
            { iconName: ok ? 'signature' : 'alert' },
          );
        },
      }),
    },
    // Notification.requestPermission() has to be user initiated, so this
    // menu item is the only place it can be asked for.
    !ctx.sample && { separator: true },
    !ctx.sample && { header: 'New mail' },
    !ctx.sample && {
      label: 'Notify me on this device',
      icon: 'bell',
      checked: notifyWanted(),
      // On or off, not one of a set: the three themes above are the set.
      toggle: true,
      onSelect: () => setNotify(!notifyWanted()),
    },
    { separator: true },
    // `?` opens the same sheet, and is on it. This is how anyone who has never
    // pressed `?` finds out that they could.
    {
      label: 'Keyboard shortcuts',
      icon: 'keyboard',
      onSelect: () => openShortcuts({ folders: VIEWS, canCompose: Boolean(ctx.onCompose) }),
    },
  ]);

  const accountAvatar = el('span.avatar.avatar-sm', {
    'aria-hidden': 'true', style: { '--hue': hueFor(scope) },
  }, initialFor(ctx.account.username));
  const accountBtn = el('button.icon-btn.avatar-btn', {
    type: 'button', 'aria-label': 'Account', title: 'Account',
  }, accountAvatar);
  // Loading the picture must not delay the mailbox. Keep the initial until
  // the image decodes successfully, including when the SDK returns no picture.
  if (ctx.getProfilePicture) {
    Promise.resolve().then(() => ctx.getProfilePicture()).then((picture) => {
      if (!picture) return;
      const image = el('img.account-picture', {
        alt: '',
        onload: () => accountAvatar.replaceChildren(image),
      });
      image.src = picture;
    }).catch(() => {});
  }
  attachMenu(accountBtn, () => [
    { header: ctx.account.username },
    ctx.onSignOut && { separator: true },
    ctx.onSignOut && { label: 'Sign out', icon: 'logout', danger: true, onSelect: ctx.onSignOut },
  ]);

  const topbar = el('header.topbar', {},
    menuBtn,
    el('div.brand', {},
      el('img.brand-icon', { src: './app-icon.png', width: 24, height: 24, alt: '' }),
      el('h1.brand-name', {}, 'Puter Mail'),
    ),
    el('div.search', { role: 'search' },
      el('span.search-icon', { html: icon('search', 18) }),
      searchInput,
    ),
    el('div.topbar-actions', {},
      el('div.menu-anchor', {}, themeBtn),
      el('div.menu-anchor', {}, accountBtn),
    ),
  );

  // -- sidebar ----------------------------------------------------------------

  // With sending available the tonal pill is Compose, like Gmail's, and
  // refreshing lives in the list toolbar; without it the pill stays a refresh
  // button.
  // A listing that another part of the app has just changed is reloaded if it
  // is on screen, and otherwise left for the next visit to the folder.
  const invalidate = (box) => {
    outdate(box);
    updateNavCounts();
    if (view().box === box) return loadFolder();
  };

  const compose = (prefill, extra = {}) => ctx.onCompose(prefill, {
    ...extra,
    onFiled: async (path) => {
      own(path);
      try {
        await invalidate('sent');
        await refreshFiledConversation(path);
      } catch {
        toast('Reply saved in Sent. Reopen the conversation to refresh it.', { iconName: 'alert' });
      }
    },
    onDraftsChanged: draftsBox ? () => invalidate('drafts') : undefined,
    // The address book To and Cc complete against. It is the header index
    // asked a second question -- every sender the list has read, and every
    // recipient of everything sent -- so it costs no read of its own and is
    // as complete as the browsing that has happened so far.
    contacts: () => searchIndex.addresses(),
    // Read when the dialog opens rather than once at launch, so a signature
    // saved a moment ago is on the next message.
    signature: settings.get('signature', ''),
    undoSend: undoSendSeconds(),
  });

  // On a phone the pill is in the drawer, and choosing it is done with the
  // drawer: left open, it was still there behind the dialog, and still there
  // covering the list when the dialog closed.
  const composeBtn = ctx.onCompose && el('button.side-compose', {
    type: 'button', title: 'Compose a new message',
    onclick: () => {
      if (mobile()) setNavOpen(false);
      compose();
    },
  },
    el('span.nav-icon', { html: icon('pencil', 18) }),
    el('span.nav-label', {}, 'Compose'),
  );

  const refreshBtn = el('button.side-refresh', { type: 'button', title: 'Refresh inbox' },
    el('span.nav-icon', { html: icon('refresh', 18) }),
    el('span.nav-label', {}, 'Refresh'),
  );

  /**
   * Rows can be dragged onto a folder in the sidebar, which is the other way
   * every desktop mail client has always moved mail. What is dragged is what
   * a row action would act on -- the ticked rows if there are any, else the
   * row under the pointer -- and the drop is the same move the buttons make,
   * with the same Undo. Where a drop can land follows from where the rows
   * are: Archive and Trash from the inbox, Trash from Sent, Inbox and Trash
   * from Archive, Inbox and Archive from Trash. A draft is not a file and
   * cannot be dragged anywhere.
   */
  let dragging = null; // the conversations in flight, or null
  const DROP_TARGETS = {
    inbox: ['archive', 'trash'],
    starred: ['archive', 'trash'],
    sent: ['trash'],
    archive: ['inbox', 'trash'],
    trash: ['inbox', 'archive'],
  };
  const canDropOn = (id) => Boolean(dragging) && (DROP_TARGETS[folder] ?? []).includes(id);

  const dropOn = async (id) => {
    const list = dragging;
    dragging = null;
    if (!list?.length) return;
    // The drop is the end of the drag, and the rows are unfaded here rather
    // than in `dragend`, which fires after this with `dragging` already
    // cleared and so had nothing to unfade. A row keeps its node across the
    // move -- one that fails stays on screen, and one that went comes back
    // through Undo -- so left faded it stayed faded for good.
    for (const unit of list) unit.row?.classList.remove('is-dragging');
    const to = VIEWS.find((v) => v.id === id)?.box;
    if (!to) return;
    const at = Math.max(0, visibleRows().indexOf(list[0].row));
    const from = view().box;
    // Leaving Archive or Trash is a restore, whatever it is dropped on:
    // recording Trash as where a message came from would send the next
    // Restore straight back into it.
    const { moved, failed } = await move(list, to, {
      restoring: from === 'archive' || from === 'trash',
      onProgress: progressLine('Moving', countOf(list)),
    });
    renderAfterChange();
    restoreFocus(at);
    const label = VIEWS.find((v) => v.box === to)?.label ?? to;
    if (!moved.length) {
      toast(`Could not move ${describe(failed)}.`, { iconName: 'alert' });
      return;
    }
    toast(
      `Moved ${describe(moved.length)} to ${label}${failed ? `. ${describe(failed)} could not be moved` : ''}.`,
      { iconName: failed ? 'alert' : 'folder', action: { label: 'Undo', onSelect: () => undo(moved) } },
    );
  };

  const navItem = (id, iconName, label) => {
    const count = el('span.nav-count');
    const item = el('button.nav-item', {
      type: 'button', 'aria-current': 'false',
      onclick: () => setFolder(id),
      ondragenter: (e) => {
        if (!canDropOn(id)) return;
        e.preventDefault();
        item.classList.add('is-drop-target');
      },
      ondragover: (e) => {
        if (!canDropOn(id)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        item.classList.add('is-drop-target');
      },
      ondragleave: () => item.classList.remove('is-drop-target'),
      ondrop: (e) => {
        item.classList.remove('is-drop-target');
        if (!canDropOn(id)) return;
        e.preventDefault();
        dropOn(id);
      },
    },
      el('span.nav-icon', { html: icon(iconName, 18) }),
      el('span.nav-label', {}, label),
      count,
    );
    return { id, item, count };
  };

  const navs = VIEWS.map((v) => navItem(v.id, v.icon, v.label));

  const sidebar = el('nav.sidebar', { 'aria-label': 'Folders' },
    composeBtn || refreshBtn,
    navs.map((n) => n.item),
  );
  const navScrim = el('div.nav-scrim', { onclick: () => setNavOpen(false) });

  /**
   * What the hamburger controls depends on the width: the drawer on a
   * phone, the rail on a desktop. Its expanded state is read from whichever
   * of the two it stands for now, so resizing across the breakpoint does not
   * leave it announcing a rail that is a hidden drawer, or the reverse.
   */
  const syncMenuBtn = () => {
    const expanded = mobile()
      ? frame.classList.contains('nav-open')
      : !frame.classList.contains('nav-collapsed');
    menuBtn.setAttribute('aria-expanded', String(expanded));
  };

  const setNavOpen = (open) => {
    // Only pull focus back to the trigger when the drawer actually had it.
    // setFolder() closes the drawer on every folder switch, including the
    // setFolder('inbox') that runs at startup, and an unconditional focus()
    // there put a focus ring on the hamburger before the user touched
    // anything.
    const wasOpen = frame.classList.contains('nav-open');
    if (wasOpen === open) return;
    frame.classList.toggle('nav-open', open);
    syncMenuBtn();
    // Behind the scrim nothing is clickable, so nothing there should be
    // tabbable either -- the same reason openModal() inerts the app root.
    // Must happen before the focus calls below: focus() on a descendant of
    // an inert element does nothing.
    for (const region of [topbar, content]) region.toggleAttribute('inert', open);
    // The Compose/Refresh pill is the first control in the drawer; focusing
    // the first folder skipped past it.
    if (open) sidebar.querySelector('button')?.focus();
    else menuBtn.focus();
  };

  // Listeners on the document, the window and media queries outlive the
  // shell: signing out renders the gate over the same root. Each one stood
  // down when the shell had gone, but went on holding all of it -- every
  // listing, the header index, the last search -- about 11 MB per sign-out.
  // This signal removes them when the shell leaves the page.
  const shellListeners = new AbortController();
  const listening = { signal: shellListeners.signal };

  // Growing past the breakpoint turns the drawer back into a static rail, so
  // an open drawer has to be folded away or the page would stay inert with
  // no scrim left to dismiss it.
  matchMedia('(max-width: 800px)').addEventListener('change', (e) => {
    if (!frame.isConnected) return;
    if (!e.matches) setNavOpen(false);
    syncMenuBtn();
  }, listening);

  menuBtn.addEventListener('click', () => {
    if (mobile()) {
      setNavOpen(!frame.classList.contains('nav-open'));
      return;
    }
    const collapsed = frame.classList.toggle('nav-collapsed');
    syncMenuBtn();
    try {
      storage.setItem(NAV_LS_KEY, collapsed ? 'collapsed' : 'open');
    } catch {}
  });

  const setFolder = (id) => {
    const previous = mailbox();
    if (VIEWS.find(view => view.id === id)?.box !== previous.box && previous.cancelLoad?.()) {
      // A cancelled older page may have appended some messages whose heads
      // are not read yet. Reopen cleanly instead of treating them as ready.
      listed.delete(previous.box);
    }
    folderLoadRevision++;
    searchController?.abort();
    indexQueue.length = 0;
    indexNext = 0;
    folder = id;
    folderOffset = 0;
    // A new folder's results start at their first page, whichever way the
    // search over it is started.
    resultOffset = 0;
    clearNewMail();
    clearSelection();
    renderActionBar();
    for (const n of navs) n.item.setAttribute('aria-current', String(n.id === id));
    if (frame.classList.contains('reading')) closeReader({ focusRow: false });
    if (mobile()) setNavOpen(false);
    if (!listed.has(view().box)) {
      showListLoading();
      loadFolder();
      return;
    }
    // A query belongs to the folder it was typed in: switching folder
    // searches the new one rather than showing the old folder's results.
    if (searching()) {
      runSearch(searchInput.value);
      return;
    }
    renderList();
  };

  const updateNavCounts = () => {
    const unread = readState.unreadCount(boxes.inbox.messages.map((m) => m.name));
    navs[0].count.textContent = unread ? String(unread) : '';
    // The tab is the only part of the app a user sees while working in
    // another one.
    document.title = unread ? `${BASE_TITLE} (${unread})` : BASE_TITLE;
    const drafts = navs.find((n) => n.id === 'drafts');
    if (drafts) drafts.count.textContent = draftStore.count ? String(draftStore.count) : '';
  };

  // -- content card: list view -------------------------------------------------

  const meta = el('p.list-meta', { 'aria-live': 'polite' });
  // The scroller and the listbox are separate elements on purpose: a listbox
  // may only contain options, and the empty-state panel and the "Load older
  // messages" button both have to live inside the scroll area.
  const listEl = el('div.msglist');
  // Several rows can be ticked at once, and a screen reader is told so.
  const optionsEl = el('div.msglist-options', {
    role: 'listbox', 'aria-label': 'Messages', 'aria-multiselectable': 'true',
  });
  const listRefreshBtn = el('button.icon-btn', {
    type: 'button', html: icon('refresh', 18), 'aria-label': 'Refresh this folder', title: 'Refresh',
  });
  /**
   * Mark everything on screen as read, in one press. Ticking every row and
   * pressing Mark as read did a page of it; a folder of three hundred unread
   * newsletters wanted the rest as well, and the tab title went on counting
   * them until it got it. What "everything" is follows the list: the whole
   * folder ordinarily, the results in a search, the starred ones in Starred.
   * It is only offered while something listed is unread, and the toast that
   * says what it did carries the one way back.
   */
  const markAllBtn = el('button.icon-btn', {
    type: 'button', html: icon('checkCheck', 18), 'aria-label': 'Mark all as read',
    title: 'Mark all as read', hidden: true,
    onclick: () => markAllRead(),
  });

  const selectAll = el('input.select-all', {
    type: 'checkbox',
    // What it does, which is the rows under it rather than the folder behind
    // them: the folder is what the strip above the rows offers, and saying
    // "in this folder" here told anyone who could not see the difference that
    // this box had already done it.
    'aria-label': 'Select everything on this page',
    title: 'Select all',
    onchange: () => {
      const rows = visibleRows();
      for (const row of rows) {
        const unit = rowUnit.get(row);
        if (unit) setSelected(unit, selectAll.checked);
      }
      syncSelection();
    },
  });

  // Bulk actions: one click for a page of newsletters rather than sixty.
  const actionBar = el('div.list-actions', { role: 'group', 'aria-label': 'Actions for the selected messages', hidden: true });

  // Mail that arrived while the user was reading something, or was scrolled
  // down the list, is announced here rather than by moving what they are
  // looking at.
  const newMailPill = el('button.new-mail', {
    type: 'button', hidden: true,
    onclick: () => {
      if (frame.classList.contains('reading')) closeReader({ focusRow: false });
      if (folder !== 'inbox') setFolder('inbox');
      listEl.scrollTop = 0;
      clearNewMail();
      visibleRows()[0]?.focus();
    },
  });

  // The shell paints before the first readdir resolves, so the card needs
  // something to say while the mailbox is being listed. renderList() and the
  // error path both clear listEl, which retires this.
  listEl.append(loadingPlaceholder('list', 'Loading your messages'));

  const listView = el('div.list-view', {},
    el('div.list-toolbar', {},
      el('span.select-all-box', {}, selectAll),
      listRefreshBtn,
      markAllBtn,
      actionBar,
      newMailPill,
      meta,
    ),
    listEl,
  );

  // Rebuilt per folder: Trash offers restore and a permanent delete, the
  // inbox offers archive and delete, and Sent offers only delete.
  const renderActionBar = () => {
    clear(actionBar);
    append(actionBar, [
      ...(ACTIONS_BY_VIEW[folder] ?? []).map((id) => el(`button.icon-btn${ACTIONS[id].danger ? '.danger' : ''}`, {
        type: 'button', html: icon(ACTIONS[id].icon, 18),
        'aria-label': ACTIONS[id].label, title: ACTIONS[id].label,
        onclick: () => runAction(id, selection()),
      })),
      !OUTGOING.has(view().box) && el('button.icon-btn', {
        type: 'button', html: icon('mailOpen', 18),
        'aria-label': 'Mark as read', title: 'Mark as read',
        onclick: () => setRead(selection(), true),
      }),
      !OUTGOING.has(view().box) && el('button.icon-btn', {
        type: 'button', html: icon('mail', 18),
        'aria-label': 'Mark as unread', title: 'Mark as unread',
        onclick: () => setRead(selection(), false),
      }),
      el('button.icon-btn', {
        type: 'button', html: icon('x', 18),
        'aria-label': 'Clear selection', title: 'Clear selection',
        onclick: () => clearSelection(),
      }),
    ]);
  };

  // -- content card: message view ----------------------------------------------

  const backBtn = el('button.icon-btn', {
    type: 'button', html: icon('back', 20), 'aria-label': 'Back to list', title: 'Back',
    onclick: () => closeReader(),
  });
  const sourceBtn = el('button.icon-btn.msg-tool-wide', {
    type: 'button', html: icon('source', 18), 'aria-label': 'View source',
    title: 'View source', 'aria-pressed': 'false', hidden: true,
  });
  /**
   * Print the open conversation. The page's print stylesheet already prints
   * the reader and nothing else, so ⌘P has done this since there was a
   * reader; the button is how anyone finds out. Every message in the
   * conversation is opened first, because a printed page with `···` lines
   * standing for half the conversation is not the conversation.
   */
  const printBtn = el('button.icon-btn.msg-tool-wide', {
    type: 'button', html: icon('print', 18), 'aria-label': 'Print',
    title: 'Print', hidden: true,
    onclick: async () => {
      const unit = opened;
      printBtn.disabled = true;
      let printView;
      try {
        await readerReady;
        if (opened !== unit || !frame.isConnected) return;
        if (msgScroll.querySelector('.history-status')) {
          toast('Retry conversation history before printing.', { iconName: 'alert' });
          return;
        }
        if (readerMessages.length <= THREAD_PAGE_SIZE) {
          await expandCards(cards, () => opened === unit && frame.isConnected);
          if (opened === unit && cards.every(card => card.data)) window.print?.();
          return;
        }
        // Print is an explicit full-document export. Only its inert rendered
        // nodes accumulate; parsed bodies are released after each small batch.
        const messages = readerMessages;
        const loaded = new Map([...cards, latestCard].filter(card => card?.data)
          .map(card => [card.message.path, card]));
        const revision = readerRevision;
        const current = () => opened === unit && readerRevision === revision && frame.isConnected;
        printView = el('article.message.print-conversation', {}, headingEl.cloneNode(true));
        msgScroll.append(printView);
        for (let at = 0; at < messages.length && current(); at += 4) {
          const batch = messages.slice(at, at + 4).map(message =>
            loaded.get(message.path) ?? messageCard(message, { count: messages.length }));
          try {
            await expandCards(batch, current);
            if (!current()) return;
            if (batch.some(card => !card.data)) {
              toast('Could not read every message for printing. Please try again.', { iconName: 'alert' });
              return;
            }
            for (const card of batch) printView.append(card.node.cloneNode(true));
          } finally {
            for (const card of batch) if (!loaded.has(card.message.path)) card.dispose();
          }
          await yieldTask();
        }
        if (current()) window.print?.();
      } finally {
        printView?.remove();
        printBtn.disabled = false;
      }
    },
  });
  const msgScroll = el('div.msg-scroll');
  // Filled per message, since which actions apply depends on the folder.
  const msgActions = el('div.msg-actions-bar', { role: 'group', 'aria-label': 'Message actions' });

  /**
   * The conversation before and after the open one, in the order the list
   * shows them, so a folder can be read through without going back to the
   * list between messages. Newer is to the left and older to the right, as
   * the list runs top to bottom -- and as Gmail's arrows do. `j` and `k` are
   * the same two moves from the keyboard.
   */
  const newerBtn = el('button.icon-btn', {
    type: 'button', html: icon('chevronLeft', 20), 'aria-label': 'Newer conversation',
    title: 'Newer', onclick: () => step(-1),
  });
  const olderBtn = el('button.icon-btn', {
    type: 'button', html: icon('chevronRight', 20), 'aria-label': 'Older conversation',
    title: 'Older', onclick: () => step(1),
  });
  // Where the open conversation is in the list: "3 of 42".
  const position = el('span.msg-position', { 'aria-live': 'polite' });
  const readerNav = el('div.msg-nav', {
    role: 'group', 'aria-label': 'Move through the list', hidden: true,
  }, position, newerBtn, olderBtn);

  /** The conversation `offset` rows from the open one, or null at the end. */
  const neighbour = (offset) => {
    if (searching()) {
      const at = opened ? results.indexOf(opened.latest) : -1;
      return at >= 0 && results[at + offset] ? resultUnit(results[at + offset]) : null;
    }
    if (!opened?.row) return null;
    const rows = visibleRows();
    const at = rows.indexOf(opened.row);
    if (at < 0) return null;
    const row = rows[at + offset];
    return row ? rowUnit.get(row) ?? null : null;
  };

  const syncReaderNav = () => {
    const rows = visibleRows();
    const at = searching() ? results.indexOf(opened?.latest) : opened?.row ? rows.indexOf(opened.row) : -1;
    readerNav.hidden = at < 0;
    if (at < 0) return;
    position.textContent = `${at + 1} of ${searching() ? results.length : rows.length}`;
    newerBtn.disabled = !neighbour(-1);
    olderBtn.disabled = !neighbour(1);
  };

  const step = (offset) => {
    const next = neighbour(offset);
    if (!next) return false;
    // Whatever the reader was doing with the keyboard, the next conversation
    // starts at its subject, the way one opened from the list does.
    openConversation(next);
    return true;
  };

  /**
   * Every message in the conversation open, or every one folded to a line.
   * The reader opens what was unread and the newest, which is the right
   * default and not always what is wanted: reading a long thread from the
   * top means opening its messages one at a time, and putting a long one
   * away again means the reverse. One control, whose label says which of
   * the two it will do; hidden on a conversation of one, where there is
   * nothing to fold.
   */
  const foldBtn = el('button.icon-btn.msg-tool-wide', {
    type: 'button', html: icon('chevronsUpDown', 18), 'aria-label': 'Expand all',
    title: 'Expand all', hidden: true,
    onclick: async () => {
      if (!opened || cards.length < 2) return;
      if (cards.every((card) => card.open)) {
        for (const card of cards) card.collapse();
      } else {
        foldBtn.disabled = true;
        const unit = opened;
        await expandCards(cards, () => opened === unit && frame.isConnected);
        foldBtn.disabled = false;
      }
      syncFold();
    },
  });

  const syncFold = () => {
    const many = Boolean(opened) && cards.length > 1 && frame.classList.contains('reading');
    foldBtn.hidden = !many;
    if (!many) return;
    const allOpen = cards.length > 0 && cards.every((card) => card.open);
    const label = readerMessages.length > THREAD_PAGE_SIZE
      ? (allOpen ? 'Collapse messages on this page' : 'Expand messages on this page')
      : (allOpen ? 'Collapse all' : 'Expand all');
    foldBtn.innerHTML = icon(allOpen ? 'chevronsDownUp' : 'chevronsUpDown', 18);
    foldBtn.setAttribute('aria-label', label);
    foldBtn.title = label;
  };

  /**
   * On a narrow screen the toolbar cannot hold every control at a size a
   * finger can hit: nine buttons of 44px is wider than a phone, and the last
   * of them were cut off at the edge of the card. There, Expand all, Print
   * and View source move behind one button at the end of the toolbar, whose
   * menu presses the same three; on a wide screen those stand as buttons and
   * this one is not shown. Shown and hidden with them, since all three wait
   * on the newest message being read.
   */
  const toolsBtn = el('button.icon-btn.msg-tools', {
    type: 'button', html: icon('more', 20), 'aria-label': 'More actions', title: 'More', hidden: true,
  });
  attachMenu(toolsBtn, () => {
    const many = cards.length > 1;
    const allOpen = many && cards.every((card) => card.open);
    return [
      many && {
        label: foldBtn.getAttribute('aria-label'),
        icon: allOpen ? 'chevronsDownUp' : 'chevronsUpDown',
        onSelect: () => foldBtn.click(),
      },
      { label: 'Print', icon: 'print', onSelect: () => printBtn.click() },
      {
        label: 'View source', icon: 'source', toggle: true, checked: showingSource,
        onSelect: () => sourceBtn.click(),
      },
    ];
  });
  const showReaderTools = (on) => {
    sourceBtn.hidden = !on;
    printBtn.hidden = !on;
    toolsBtn.hidden = !on;
  };

  const messageView = el('div.message-view', {},
    el('div.msg-toolbar', {},
      backBtn, msgActions, el('span.spacer'), foldBtn, readerNav, printBtn, sourceBtn,
      el('span.menu-anchor.msg-tools-anchor', {}, toolsBtn)),
    msgScroll,
  );

  const renderMsgActions = (unit) => {
    clear(msgActions);
    if (!OUTGOING.has(unit.latest.box)) {
      msgActions.append(el('button.icon-btn', {
        type: 'button', html: icon('mail', 18),
        'aria-label': 'Mark as unread', title: 'Mark as unread',
        onclick: () => setRead([unit], false),
      }));
    }
    append(msgActions, (ACTIONS_BY_VIEW[folder] ?? []).map((id) =>
      el(`button.icon-btn${ACTIONS[id].danger ? '.danger' : ''}`, {
        type: 'button', html: icon(ACTIONS[id].icon, 18),
        'aria-label': ACTIONS[id].label, title: ACTIONS[id].label,
        onclick: () => runAction(id, [unit]),
      })));
  };

  const content = el('main.content', {}, el('div.card', {}, listView, messageView));

  const frame = el('div.app-frame', {},
    topbar,
    el('div.app-body', {},
      sidebar,
      navScrim,
      content,
    ),
  );
  clear(root).append(frame);

  // The stored rail state is applied whatever the width: the phone layout
  // draws the drawer the same either way, and a window that starts narrow
  // and is widened then shows the rail the way it was left.
  try {
    if (storage.getItem(NAV_LS_KEY) === 'collapsed') frame.classList.add('nav-collapsed');
  } catch {}
  applyDensity();
  // On mobile the sidebar starts as a closed drawer; on desktop it reflects
  // the stored rail state.
  syncMenuBtn();

  // -- header enrichment ---------------------------------------------------------

  // Sender and preview come from reading just the head of each file; rows
  // are enriched as they become visible, a few at a time.
  const enrichQueue = [];
  let enrichRunning = 0;
  const rowUnit = new WeakMap();

  /** Repaint every row that shows this message. */
  const repaint = (message) => {
    for (const unit of message.units ?? []) if (unit.row) updateRow(unit);
  };

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const unit = rowUnit.get(entry.target);
      if (!unit) continue;
      // A conversation was grouped from its messages' headers, so those are
      // already read; this is the unthreaded case, and the odd message a
      // conversation picked up without one.
      for (const message of unit.messages) {
        if (message.from !== undefined || message.queued) continue;
        // The search index holds exactly what a row shows, so a message that
        // has been read once never needs reading again.
        if (hydrate(message)) updateRow(unit);
        else {
          message.queued = true;
          enrichQueue.push(message);
        }
      }
    }
    pumpEnrich();
  }, { root: listEl, rootMargin: '400px' });

  const pumpEnrich = () => {
    while (enrichRunning < ENRICH_CONCURRENCY && enrichQueue.length) {
      const message = enrichQueue.shift();
      if (![...(message.units ?? [])].some(unit => unit.row?.isConnected && !unit.row.hidden)) {
        message.queued = false;
        continue;
      }
      enrichRunning++;
      enrichMessage(messageReads, message)
        .then((patch) => {
          Object.assign(message, patch);
          remember(message);
          repaint(message);
        })
        .finally(() => {
          enrichRunning--;
          pumpEnrich();
        });
    }
  };

  /**
   * Read the headers grouping needs, for a batch the list is about to show.
   *
   * This is the one read the list waits on rather than doing behind the
   * reader: a conversation cannot be drawn before it is known which messages
   * are in it, so the rows cannot be built from filenames alone the way they
   * are without threading. It is not an extra read -- it is the same 8 KB head
   * every row was going to cost as it scrolled past -- and the header index
   * keeps it, so a folder is only ever grouped from the filesystem once.
   */
  const readHeads = async (messages, { signal, active = () => true } = {}) => {
    const pending = [];
    for (const message of messages) {
      // A draft has no file behind it: reading its path failed and overwrote
      // the row with the failure, leaving no preview line and "(no recipient)"
      // where the draft's own recipient had been.
      if (!message.path || (message.messageId !== undefined && !message.unreadable)) continue;
      if (hydrate(message, { needsThread: true })) continue;
      pending.push(message);
    }
    if (!pending.length) return;

    const total = pending.length;
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (signal?.aborted || !active() || !frame.isConnected) return;
        const message = pending[next++];
        if (!message) return;
        Object.assign(message, await enrichMessage(messageReads, message));
        remember(message);
      }
    };
    await Promise.all(Array.from({ length: Math.min(HEAD_CONCURRENCY, total) }, worker));
    searchIndex.flush();
  };

  // -- rows ------------------------------------------------------------------------

  const rowPending = (unit) => Boolean(unit.latest.path && unit.latest.from === undefined);

  const rowLabel = (unit) => {
    const bits = [];
    if (unitUnread(unit)) bits.push('Unread');
    if (unitStarred(unit)) bits.push('Starred');
    bits.push(rowPending(unit) ? 'Loading message details' : OUTGOING.has(unit.latest.box)
      ? `To ${personLabel(unit)}`
      : `From ${personLabel(unit)}`);
    if (unit.count > 1) bits.push(`${unit.count} messages`);
    bits.push(unitSubject(unit) || 'no subject');
    if (!rowPending(unit)) bits.push(formatWhen(unit.latest));
    return bits.join(', ');
  };

  /**
   * `what` names the thing being starred, because there is more than one star
   * on screen now: a row per conversation in the list, and one per message in
   * an open conversation. A stack of controls all called "Star" is no answer
   * to which message a screen reader is about to star -- and the row's other
   * controls already name their row this way.
   */
  const syncStarBtn = (btn, starred, what = '') => {
    const verb = starred ? 'Unstar' : 'Star';
    btn.setAttribute('aria-pressed', String(starred));
    btn.setAttribute('aria-label', what ? `${verb} ${what}` : verb);
    btn.title = starred ? 'Starred' : 'Not starred';
  };

  const updateRow = (unit) => {
    const row = unit.row;
    if (!row) return;
    // Refresh creates new message objects even when their rows survive. Fill
    // known headers before painting so sender, preview and date never revert
    // to placeholders while an already-observed row waits for a new read.
    for (const message of unit.messages) {
      if (message.from === undefined) hydrate(message);
    }
    // The row is about the conversation, and what it shows of it is the
    // newest message: that is the preview line and the date Gmail shows too.
    const message = unit.latest;
    const pending = rowPending(unit);
    row.classList.toggle('row-pending', pending);
    row.setAttribute('aria-busy', String(pending));
    const subject = unitSubject(unit);
    const what = unit.count > 1 ? 'this conversation' : 'this message';
    row.querySelector('.row-sender').textContent = pending ? '' : personLabel(unit);
    const count = row.querySelector('.row-count');
    count.textContent = unit.count > 1 ? String(unit.count) : '';
    count.hidden = unit.count < 2;
    row.querySelector('.row-when').textContent = pending ? '' : formatWhen(message);
    row.querySelector('.row-subject').textContent = subject || '(no subject)';
    row.querySelector('.row-snippet').textContent = message.snippet ?? '';
    row.querySelector('.row-clip').hidden = !unitClipped(unit);
    // Until the header read lands there is no sender to draw an avatar from,
    // and falling through to initialFor('')/hueFor('') painted a red "?" disc
    // -- alarm colours on what is really a skeleton. Draw a neutral disc.
    const avatar = row.querySelector('.row-avatar');
    const person = personFor(unit.oldest);
    const label = person?.name || person?.email || '';
    avatar.classList.toggle('avatar-pending', !label);
    avatar.textContent = label ? initialFor(label) : '';
    if (label) {
      avatar.style.setProperty('--hue', hueFor(person.email || person.name || ''));
    }
    const unread = unitUnread(unit);
    row.classList.toggle('unread', unread);
    const readBtn = row.querySelector('.read-toggle');
    if (readBtn) {
      readBtn.innerHTML = icon(unread ? 'mailOpen' : 'mail', 16);
      readBtn.title = unread ? 'Mark as read' : 'Mark as unread';
      readBtn.setAttribute('aria-label',
        `${unread ? 'Mark as read' : 'Mark as unread'}: ${subject || what}`);
    }
    row.classList.toggle('is-selected', selected.has(unit));
    row.setAttribute('aria-selected', String(selected.has(unit) || unit === opened));
    row.querySelector('.row-check').checked = selected.has(unit);
    row.querySelector('.row-check').setAttribute('aria-label', `Select ${subject || what}`);
    syncStarBtn(row.querySelector('.star-btn'), unitStarred(unit), subject || what);
    row.setAttribute('aria-label', rowLabel(unit));
    // A failed/evicted header has no cache entry. Reused rows must be observed
    // again too, so visible messages can retry through the bounded read queue.
    if (unit.messages.some(message => message.path && message.from === undefined)) observer.observe(row);
  };

  /**
   * A conversation reads as starred when any message in it is, so one click
   * has to be able to clear a star that could be on any of them. Turning it on
   * marks the newest message, which is the one the row is about.
   */
  const toggleStar = (unit) => {
    if (unitStarred(unit)) {
      for (const message of unit.messages) starState.set(message.name, false);
    } else {
      starState.set(unit.latest.name, true);
    }
    updateRow(unit);
    if (opened === unit) syncCardStars();
    if (folder === 'starred' || searching()) {
      // Unstarring in Starred hides the row under the star that did it, and
      // the keyboard with it.
      const at = Math.max(0, visibleRows().indexOf(unit.row));
      refreshList();
      restoreFocus(at);
    }
  };

  const buildRow = (unit) => {
    const box = unit.latest.box;
    let row;
    /**
     * What this row stands for *now*. A row is kept across a regrouping -- a
     * re-listing, a page of older mail, the conversation view being switched
     * off -- and the conversation it stands for changes under it, so closing
     * over the one it was built for left the row opening a conversation that
     * no longer existed.
     */
    const current = () => rowUnit.get(row) ?? unit;
    const what = () => {
      const now = current();
      return unitSubject(now) || (now.count > 1 ? 'this conversation' : 'this message');
    };
    // The star and the tick sit inside the option row; they stay out of the
    // Tab order (both are reachable from the keyboard through the list's own
    // shortcuts) so 60 rows do not add 120 tab stops.
    const starBtn = el('button.star-btn', {
      type: 'button', tabindex: -1, html: icon('star', 18),
      onclick: (e) => { e.stopPropagation(); toggleStar(current()); },
    });
    const check = el('input.row-check', {
      type: 'checkbox', tabindex: -1,
      'aria-label': `Select ${what()}`,
      onclick: (e) => e.stopPropagation(),
      onchange: () => {
        setSelected(current(), check.checked);
        syncSelection();
      },
    });
    // Row actions take the place of the timestamp on hover and on focus, the
    // way they do in Gmail: the date is not what you want when your pointer
    // is on the row.
    const readBtn = !OUTGOING.has(box) && el('button.row-action.read-toggle', {
      type: 'button', tabindex: -1,
      onclick: (e) => {
        e.stopPropagation();
        const now = current();
        // A mixed selection follows the conversation that was clicked.
        setRead(targets(now), unitUnread(now));
      },
    });
    const actions = el('span.row-actions', {},
      readBtn,
      (ACTIONS_BY_VIEW[folder] ?? []).map((id) => el(`button.row-action${ACTIONS[id].danger ? '.danger' : ''}`, {
        type: 'button', tabindex: -1, html: icon(ACTIONS[id].icon, 16),
        'aria-label': `${ACTIONS[id].label}: ${what()}`,
        title: ACTIONS[id].label,
        onclick: (e) => {
          e.stopPropagation();
          runAction(id, targets(current()));
        },
      })),
    );
    row = el('div.row', {
      role: 'option', tabindex: -1, 'aria-selected': 'false',
      // A draft is not a file, so there is nowhere for it to go.
      draggable: box !== 'drafts',
      ondragstart: (e) => {
        if (box === 'drafts') return;
        dragging = targets(current());
        for (const unit of dragging) unit.row?.classList.add('is-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          // Something has to be set for the drag to start in every browser;
          // the subject is what a drop outside the app would make of it.
          try {
            e.dataTransfer.setData('text/plain', what());
          } catch {}
        }
        sidebar.classList.add('is-dragging-rows');
      },
      ondragend: () => {
        for (const unit of dragging ?? []) unit.row?.classList.remove('is-dragging');
        dragging = null;
        sidebar.classList.remove('is-dragging-rows');
        for (const n of navs) n.item.classList.remove('is-drop-target');
      },
    },
      el('span.row-marks', {}, check, starBtn),
      el('span.avatar.row-avatar', { 'aria-hidden': 'true' }, ''),
      // The count belongs to the people, not to the subject, so it lives
      // inside their column and is what survives when the names are too long
      // for it.
      el('span.row-people', {},
        el('span.row-sender', {}, '…'),
        el('span.row-count', { 'aria-hidden': 'true', hidden: true }),
      ),
      el('span.row-text', {},
        el('span.row-subject', {}, unitSubject(unit) || '(no subject)'),
        el('span.row-snippet', {}, ''),
      ),
      // The paperclip and the date end the row together: one flex item on a
      // desktop, and one grid cell on a phone, where the two-line row has a
      // single slot at the top right for them both.
      el('span.row-end', {},
        el('span.row-clip', { html: icon('paperclip', 14), hidden: true }),
        el('span.row-when', {}, ''),
      ),
      actions,
    );
    row.addEventListener('click', () => {
      // A draft has no file to read: it opens back into the dialog it came
      // from, which is the only place it can be worked on.
      if (box === 'drafts') compose(null, { draft: current().latest.draft });
      else openConversation(current());
    });
    if (box === 'drafts') row.classList.add('row-draft');
    unit.row = row;
    rowUnit.set(row, unit);
    updateRow(unit);
    // Nothing to enrich for a draft: there is no file behind it.
    if (box !== 'drafts') observer.observe(row);
    return row;
  };

  const visibleRows = () => [...listEl.querySelectorAll('.row')].filter((r) => !r.hidden);

  /**
   * Which row the keyboard is on, even when focus sits on one of the row's own
   * controls: clicking a star or a tick box focuses that button, and reading
   * that as "no row" sent the next arrow key to the top of the list rather
   * than to the next message. -1 when the keyboard is somewhere else entirely,
   * which is the ordinary case for `j` pressed while reading.
   */
  const focusedRowIndex = (rows = visibleRows()) => {
    const focused = document.activeElement?.closest?.('.row');
    return focused ? rows.indexOf(focused) : -1;
  };

  /**
   * One row in the Tab order: the one the keyboard is on, where it is on
   * one, else the first. Every repaint of the list used to hand the stop to
   * the first row whatever had focus, so after marking the fifth row read
   * the keyboard stood on a row that was no longer a tab stop, and Shift+Tab
   * from it went to the top of the list rather than to the control before
   * it.
   */
  const settleTabStops = (rows) => {
    const at = Math.max(0, focusedRowIndex(rows));
    rows.forEach((r, i) => { r.tabIndex = i === at ? 0 : -1; });
  };

  /**
   * Put the keyboard on a row, clamped to the ends of the list rather than
   * wrapping: arrowing off the bottom of a list that has more to load should
   * stop there, not reappear at the top. Only one row is ever in the Tab
   * order, so moving the keyboard moves that too.
   */
  const focusRow = (index) => {
    const rows = visibleRows();
    if (!rows.length) return;
    const next = Math.min(Math.max(index, 0), rows.length - 1);
    rows.forEach((r) => { r.tabIndex = -1; });
    rows[next].tabIndex = 0;
    rows[next].focus();
  };

  listEl.addEventListener('keydown', (e) => {
    // A mail shortcut is a bare keypress. A modifier combination belongs to
    // the browser and the OS: Cmd+S has to save the page rather than star the
    // focused row, and Cmd+Down has to scroll to the end of the list.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // The second key of a `g` chord names a folder and nothing else; the
    // document's handler answers it after this one. Answered here too, `g s`
    // starred the focused row on its way to Starred and `g e` archived it.
    if (chording) return;
    const rows = visibleRows();
    if (!rows.length) return;
    const focused = document.activeElement?.closest?.('.row');
    const current = focusedRowIndex(rows);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusRow(e.key === 'Home' ? 0
        : e.key === 'End' ? rows.length - 1
        : e.key === 'ArrowDown' ? current + 1
        : current - 1);
      // Enter and Space belong to whatever has focus: a button inside the row
      // already answers them itself, and opening the message as well would be
      // two answers to one keypress.
    } else if ((e.key === 'Enter' || e.key === ' ')
      && current >= 0 && document.activeElement === focused) {
      e.preventDefault();
      rows[current].click();
    } else if (current >= 0) {
      // The row controls are deliberately out of the Tab order, so the
      // keyboard reaches them the way mail clients have always done it.
      const unit = rowUnit.get(rows[current]);
      if (!unit) return;
      if (e.key === 'x') {
        e.preventDefault();
        setSelected(unit, !selected.has(unit));
        syncSelection();
      } else if (e.key === 's') {
        e.preventDefault();
        toggleStar(unit);
      } else if (e.key === 'u' || e.key === 'U') {
        // The same key both ways, like the row's own toggle.
        e.preventDefault();
        setRead(targets(unit), unitUnread(unit));
      } else if (e.key === 'e' && ACTIONS_BY_VIEW[folder]?.includes('archive')) {
        e.preventDefault();
        moveFocus(rows, current);
        runAction('archive', targets(unit));
      } else if ((e.key === 'Delete' || e.key === 'Backspace' || e.key === '#')
        && ACTIONS_BY_VIEW[folder]?.includes('trash')) {
        e.preventDefault();
        moveFocus(rows, current);
        runAction('trash', targets(unit));
      }
    }
  });

  // A row about to leave the list must hand its focus somewhere, or the
  // keyboard lands back at the top of the page.
  const moveFocus = (rows, current) => {
    const next = rows[current + 1] ?? rows[current - 1];
    if (next) {
      next.tabIndex = 0;
      next.focus();
    } else {
      listRefreshBtn.focus();
    }
  };

  /**
   * A control that has just removed itself takes the keyboard with it: the
   * Archive button on a row, or in the message toolbar of the message it
   * archives, or a bulk action whose toolbar empties out behind it. Focus
   * fell back to the document, so the next Tab started again from the top of
   * the page and the reader lost their place in the folder.
   *
   * Where the message was is where the keyboard should carry on from, so
   * focus goes to whatever row took its place -- and to the folder's own
   * toolbar when nothing did.
   */
  const restoreFocus = (index) => {
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected
      || Boolean(active.closest?.('[hidden]'));
    if (!lost) return;
    const rows = visibleRows();
    const next = rows[Math.min(index, rows.length - 1)];
    if (next) {
      next.tabIndex = 0;
      next.focus();
    } else {
      listRefreshBtn.focus();
    }
  };

  // -- selection ---------------------------------------------------------------

  // Conversations ticked in the current folder. Switching folder empties it:
  // the rows it referred to are no longer on screen.
  const selected = new Set();

  /**
   * Whether the selection is the whole folder rather than the rows on screen.
   * The rows are one page of it, and "select all" over a page of sixty is
   * not the same thing as the three hundred behind it -- Gmail says so in a
   * strip above the rows, and offers the rest. Taking any row out of the
   * selection makes it a selection of rows again.
   */
  let wholeFolder = false;
  let folderEntries = [];

  const setSelected = (unit, on) => {
    if (on) selected.add(unit);
    else {
      selected.delete(unit);
      wholeFolder = false;
    }
    unit.row?.classList.toggle('is-selected', on);
    // What is ticked is what is selected, to a screen reader as on screen:
    // ticked rows went on saying "not selected". The open row is selected too.
    unit.row?.setAttribute('aria-selected', String(on || unit === opened));
    const box = unit.row?.querySelector('.row-check');
    if (box) box.checked = on;
  };

  const clearSelection = () => {
    wholeFolder = false;
    for (const unit of [...selected]) setSelected(unit, false);
    syncSelection();
  };

  /**
   * The conversations an action on the selection applies to. Ordinarily the
   * ticked rows; with the whole folder selected, those plus every message the
   * folder holds that no row stands for, each as a conversation of one --
   * which is all that is known about a message that was never paged in. In
   * Starred the rest are the starred rest, since that is what the view is.
   */
  const selection = () => {
    const ticked = [...selected];
    if (!wholeFolder) return ticked;
    const shown = new Set(ticked.flatMap((unit) => unit.messages));
    const rest = folderEntries.filter((message) => !shown.has(message)
      && (folder !== 'starred' || starState.isStarred(message.name)));
    return [...ticked, ...rest.map((message) => singleThread(message))];
  };

  const selectionCount = () => messagesOf(selection()).length;

  /**
   * The strip above the rows: that the page is selected, and the way to the
   * rest of the folder -- or that the folder is, and the way back.
   */
  const selectNoteText = el('span.folder-note-text');
  const selectNoteBtn = el('button.btn.btn-small', { type: 'button' });
  const selectNote = el('div.folder-note.select-note', { hidden: true }, selectNoteText, selectNoteBtn);

  const selectWholeFolder = async () => {
    const box = mailbox();
    selectNoteBtn.disabled = true;
    try {
      folderEntries = searching() ? [...results] : await box.listAll();
    } catch (e) {
      toast(`Could not list this folder: ${e?.message ?? e}`, { iconName: 'alert' });
      return;
    } finally {
      selectNoteBtn.disabled = false;
    }
    // The folder changed under the listing, or the selection did.
    if (box !== mailbox() || !selected.size) return;
    wholeFolder = true;
    syncSelection();
  };

  selectNoteBtn.addEventListener('click', () => {
    if (wholeFolder) clearSelection();
    else selectWholeFolder();
  });

  const syncSelectNote = () => {
    const rows = visibleRows();
    // Offered where there is more to the folder than the rows: a folder that
    // has not all been paged in, or the page is everything and the note has
    // nothing to add. A search already lists the whole folder.
    const more = searching() ? results.length > rows.length
      : mailbox().hasMore || (mailbox().total ?? 0) > mailbox().messages.length;
    const show = selected.size > 0 && selected.size === rows.length && (more || wholeFolder);
    selectNote.hidden = !show;
    if (!show) return;
    const label = searching() ? 'these search results' : view().label;
    if (wholeFolder) {
      selectNoteText.textContent = `All ${describe(selectionCount())} in ${label} are selected.`;
      selectNoteBtn.textContent = 'Clear selection';
    } else {
      const total = searching() ? results.length : mailbox().total;
      selectNoteText.textContent = `All ${describeUnits(rows.length)} on this page are selected.`;
      selectNoteBtn.textContent = total
        ? `Select all ${describe(total)} in ${label}`
        : `Select everything in ${label}`;
    }
    if (optionsEl.isConnected && selectNote.parentNode !== listEl) listEl.prepend(selectNote);
  };

  // The selection toolbar replaces the folder counts while anything is
  // ticked, the way it does in every mail client.
  //
  // The tick box at the head of the list is about the rows under it, so it is
  // counted in rows: a conversation is one row whether it holds one message or
  // five. Counting the messages instead made "all of them" a bigger number
  // than there are rows, so selecting every row left the box looking empty --
  // neither checked nor indeterminate -- and the click that should have
  // cleared the selection only set it again, with no way back out from there.
  const syncSelection = () => {
    const rows = visibleRows();
    const count = selected.size;
    // A selection that has emptied -- by an action that took every ticked row
    // away -- is no longer of the whole folder either.
    if (!count) wholeFolder = false;
    selectAll.checked = count > 0 && count === rows.length;
    selectAll.indeterminate = count > 0 && count < rows.length;
    selectAll.disabled = rows.length === 0;
    actionBar.hidden = count === 0;
    syncSelectNote();
    updateMeta();
  };

  // -- archive, delete, restore --------------------------------------------------

  // Moving mail needs write access to .mail. Asking on launch would mean a
  // permission dialog every single launch, so -- exactly like sending -- the
  // app tries first and only asks when the write is refused, then retries
  // once. One request, however many writes were refused at the same moment:
  // a bulk action has several in flight, and each of them refused before the
  // answer came is retried on it rather than counted as failed.
  let writeAsk = null;      // the one permission request, once a write was refused
  let writeAnswered = false;
  const mailWrite = async (op) => {
    try {
      return await op();
    } catch (e) {
      if (writeAnswered || !ctx.requestWrite) throw e;
      writeAsk ??= Promise.resolve()
        .then(() => ctx.requestWrite())
        .catch(() => false)
        .finally(() => {
          writeAnswered = true;
        });
      if (!(await writeAsk)) throw e;
      return op();
    }
  };

  /**
   * Moves and deletes in flight at once during a bulk action. Each is one
   * request, and a whole folder is hundreds of them: one after another, an
   * archive of three hundred was most of a minute; a few at a time it is
   * seconds, and asks no more of the server than the header reads do.
   */
  const WRITE_CONCURRENCY = 4;
  // Day folders this shell has asked for, shared by every move it makes.
  const madeDirs = new Map();

  /** `work` over each of `items`, a few at a time, taken in the order given. */
  const eachInFlight = async (items, work) => {
    let next = 0;
    const worker = async () => {
      while (next < items.length) await work(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, items.length) }, worker));
  };

  const describe = (count) => `${count} message${count === 1 ? '' : 's'}`;

  // Messages with a move or a delete in flight. A second press of Archive --
  // a double click, `e` twice -- arrives before the first move has taken the
  // row away, and moving the same file twice failed the second time: it said
  // "Could not archive" under "Archived", and asked for write permission.
  const writing = new Set();
  const idle = (list) => list.filter((unit) => !unit.messages.some((message) => writing.has(message)));

  /**
   * The meta line counting a bulk operation down: "Archiving 40 of 300…".
   * Every move is one request, and a whole folder is hundreds of them in a
   * row. The rows on screen leave as their files do, which is progress enough
   * for a page -- but the rest of the folder has no rows, and for the minute
   * or two it took the toolbar went on saying how many were selected, as if
   * nothing had happened. Nothing for a move of one: its row is the sign.
   */
  const progressLine = (verb, total) => {
    if (total < 2) return undefined;
    let done = 0;
    return () => {
      meta.textContent = `${verb} ${++done} of ${total}…`;
    };
  };

  /**
   * Take the messages that have left a conversation out of the list. A whole
   * conversation is the normal case -- every action here applies to all of it
   * -- and then the row goes with it; a part of one can only come of a move
   * that failed halfway, and leaves the row showing what is left.
   *
   * Returns where the row was, so the keyboard can carry on from there.
   */
  const shrink = (unit, gone, from = null) => {
    const at = units.indexOf(unit);
    if (!gone.length) return at === -1 ? 0 : at;
    // Only in the folder the messages left: by now the list on screen may be
    // the folder they went to, where the same names are the messages that
    // have just arrived.
    if (at === -1 && !searching() && from && view().box === from) {
      // A listing made while the move was in flight rebuilt this conversation
      // over entries of its own for the same files, and those are the rows on
      // screen: left alone, an archived message stayed in the inbox.
      const names = new Set(gone.map((message) => message.name));
      for (const other of units.filter((candidate) => candidate !== unit
        && candidate.messages.some((message) => names.has(message.name)))) {
        shrink(other, other.messages.filter((message) => names.has(message.name)));
      }
    }
    const left = unit.messages.filter((message) => !gone.includes(message));
    for (const message of gone) message.units?.delete(unit);
    // Assigned before the branch below, not after it: an emptied conversation
    // keeps its object so an undo can put it back, and leaving the messages on
    // it meant the undo added them to a conversation that still listed them --
    // three messages restored into a row that then said six.
    unit.messages = left;
    if (!left.length) {
      if (at !== -1) units.splice(at, 1);
      // A row that never scrolled into view is still observed, and the
      // observer held it -- and its conversation -- after it had gone. An
      // undo that puts the row back observes it again if it still needs to.
      if (unit.row) observer.unobserve(unit.row);
      unit.row?.remove();
      selected.delete(unit);
      if (opened === unit) closeReader({ focusRow: false });
      return at === -1 ? 0 : at;
    }
    Object.assign(unit, makeThread(left));
    updateRow(unit);
    if (opened === unit) openConversation(unit);
    return at === -1 ? 0 : at;
  };

  /**
   * Put messages back into a conversation, and the conversation back into the
   * list at the place its newest message gives it. Day and filename both sort
   * newest-first as text, so the position is found rather than remembered --
   * correct even if other mail arrived in between.
   */
  const grow = (unit, back, owners) => {
    if (view().box === back[0]?.box && !searching()) {
      // A listing made while the undo was in flight may already show these
      // files, as rows of its own; putting this one back as well listed the
      // conversation twice. `owners` -- which conversation on screen holds
      // each file -- is built once per undo by the caller: built here, an undo
      // of a whole folder rebuilt it for every conversation it put back.
      back = back.filter((message) => {
        const owner = owners.get(message.name);
        return !owner || owner === unit;
      });
      if (!back.length) return;
      for (const message of back) owners.set(message.name, unit);
    }
    Object.assign(unit, makeThread([...unit.messages, ...back]));
    track(unit);
    if (units.includes(unit)) {
      updateRow(unit);
      return;
    }
    if (view().box !== unit.latest.box) return;
    const key = (other) => `${other.latest.day}/${other.latest.name}`;
    const found = units.findIndex((other) => key(other) < key(unit));
    const at = found === -1 ? units.length : found;
    units.splice(at, 0, unit);
    // The row is left to the render that follows every undo, which builds
    // rows for the loaded window only. Built here, an undo of a whole folder
    // made one per conversation put back -- ten thousand rows, nearly all of
    // them removed again by that render.
    if (unit.row) updateRow(unit);
  };

  /**
   * `restoring` marks a move that undoes a filing rather than performing one.
   * Where a message came from is only worth recording while it is being filed
   * away: recording it on the way back made Trash the remembered origin of a
   * message restored *into* Archive, so the next Restore filed it straight
   * back into Trash -- and said "Restored to Trash" while doing it.
   */
  const move = async (list, to, { restoring = false, onProgress } = {}) => {
    list = idle(list);
    const moved = [];
    let failed = 0;
    // A conversation moves whole: filing half of one would leave the rest of
    // it in a folder it no longer belongs to. Its row goes once every message
    // in it has answered, in whatever order the answers came.
    const gone = new Map(list.map((unit) => [unit, []]));
    const waiting = new Map(list.map((unit) => [unit, unit.messages.length]));
    const jobs = list.flatMap((unit) => unit.messages.map((message) => ({ unit, message })));
    const fromOf = new Map(list.map((unit) => [unit, unit.messages[0]?.box]));
    for (const { message } of jobs) writing.add(message);
    await eachInFlight(jobs, async ({ unit, message }) => {
      const from = message.box;
      const was = message.path;
      try {
        // Marked before the request goes out, so the event it causes cannot
        // reach a shell that has not yet heard of the write.
        own(was, `${boxPath(ctx.mailPath, to)}/${message.day}/${message.name}`);
        const path = await mailWrite(() =>
          moveMessage({ fs: ctx.fs, mailPath: ctx.mailPath, message, to, dirs: madeDirs }));
        boxes[from].remove(message);
        moved.push({ unit, message, from, was, restoring });
        gone.get(unit).push(message);
        message.path = path;
        message.box = to;
        // Restoring should put a message back where it came from, not
        // wherever the default is; Sent mail deleted by mistake is the case
        // that makes the difference.
        if (!restoring && (to === 'trash' || to === 'archive')) {
          originState.set(message.name, from);
        } else {
          originState.clear(message.name);
        }
        // The destination listing is now out of date.
        outdate(to);
      } catch {
        failed++;
      }
      writing.delete(message);
      onProgress?.();
      const left = waiting.get(unit) - 1;
      waiting.set(unit, left);
      if (left === 0) shrink(unit, gone.get(unit), fromOf.get(unit));
    });
    return { moved, failed };
  };

  const undo = async (moved) => {
    let failed = 0;
    const onProgress = progressLine('Restoring', moved.length);
    // Which messages went back into which conversation, so one is put back
    // once rather than once per message in it.
    const back = new Map();
    await eachInFlight([...moved].reverse(), async ({ unit, message, from, was, restoring }) => {
      // Where the move had put it, which for a restore is where it came from.
      const landed = message.box;
      try {
        own(message.path, was);
        await mailWrite(() =>
          moveMessage({ fs: ctx.fs, mailPath: ctx.mailPath, message, to: from, dirs: madeDirs }));
        // The folder the move had filed it in may have been opened since, and
        // listed the file under an entry of its own. The file has left it, so
        // the entry and its row go too: they stayed, over a file that was no
        // longer there, after an Undo pressed from that folder.
        const there = boxes[landed]?.find?.(message.name);
        if (there) {
          boxes[landed].remove(there);
          if (view().box === landed && !searching()) {
            for (const other of units.filter((candidate) => candidate.messages.includes(there))) {
              shrink(other, [there]);
            }
          }
        }
        message.path = was;
        message.box = from;
        boxes[from].insert(message);
        // Undoing a filing forgets the origin the filing recorded. Undoing a
        // restore puts the message back in the folder it was filed in, and
        // it came from wherever the restore had just returned it to -- the
        // origin the restore cleared. Forgetting it here sent a Sent message
        // that was deleted, restored and un-restored into the inbox on the
        // next Restore.
        if (restoring) originState.set(message.name, landed);
        else originState.clear(message.name);
        // Not outdate(from): insert() has put the message back into the
        // listing and its catalog in place, and dropping the catalog detached
        // it from a search running over it, which then went on listing
        // whatever was archived after the undo.
        back.set(unit, [...(back.get(unit) ?? []), message]);
      } catch {
        failed++;
      }
      onProgress?.();
    });
    const owners = new Map(units.flatMap((other) => other.messages.map((message) => [message.name, other])));
    for (const [unit, messages] of back) grow(unit, messages, owners);
    renderAfterChange();
    toast(
      failed ? `Could not restore ${describe(failed)}.` : `Restored ${describe(moved.length - failed)}.`,
      { iconName: failed ? 'alert' : 'undo' },
    );
  };

  // A folder that has just lost its last row needs its empty panel; anything
  // else only needs the counts brought up to date -- unless the empty panel is
  // what is on screen, because that replaced the whole scroller, options list
  // included. Filtering a list that is no longer in the document left an undo
  // of "archive everything" showing "No mail yet." over messages it had just
  // put back.
  const renderAfterChange = () => {
    if (searching()) renderResults();
    else if (!mailbox().messages.length || !optionsEl.isConnected) renderList();
    else applyFilter();
    syncSelection();
    updateNavCounts();
  };

  /**
   * Delete these conversations' files for good. `onProgress` is told after
   * every file, because emptying a Trash of hundreds is one request per file
   * and the list has to say something while that happens.
   */
  const deleteForever = async (list, { onProgress } = {}) => {
    list = idle(list);
    const fromOf = new Map(list.map((unit) => [unit, unit.messages[0]?.box]));
    let failed = 0;
    let done = 0;
    const gone = new Map(list.map((unit) => [unit, []]));
    const waiting = new Map(list.map((unit) => [unit, unit.messages.length]));
    const jobs = list.flatMap((unit) => unit.messages.map((message) => ({ unit, message })));
    for (const { message } of jobs) writing.add(message);
    await eachInFlight(jobs, async ({ unit, message }) => {
      try {
        own(message.path);
        await mailWrite(() => ctx.fs.delete(message.path));
        boxes[message.box].remove(message);
        originState.clear(message.name);
        gone.get(unit).push(message);
      } catch {
        failed++;
      }
      writing.delete(message);
      onProgress?.(++done);
      const left = waiting.get(unit) - 1;
      waiting.set(unit, left);
      if (left === 0) shrink(unit, gone.get(unit), fromOf.get(unit));
    });
    return failed;
  };

  const purge = async (list) => {
    const count = countOf(list);
    // The one action undo cannot cover, so it is the one that asks first --
    // and it asks with a dialog of this app's own, because `window.confirm` is
    // suppressed in the cross-origin iframe a Puter app runs in and would have
    // answered "no" to every permanent delete without showing anything.
    const confirmed = await confirmDialog({
      title: 'Delete forever?',
      message: `${describe(count)} will be deleted permanently. This cannot be undone.`,
      confirmLabel: 'Delete forever',
      danger: true,
    });
    if (!confirmed) return;
    const failed = await deleteForever(list, { onProgress: progressLine(ACTIONS.purge.busy, count) });
    renderAfterChange();
    toast(
      failed
        ? `Could not delete ${describe(failed)}.`
        : `${describe(count)} deleted permanently.`,
      { iconName: failed ? 'alert' : 'trash' },
    );
  };

  /**
   * Empty the Trash: every message in the folder, not only the page of it
   * that has been listed. Deleting from Trash one row at a time was the only
   * way to be rid of anything, and a folder that only ever grows is not a
   * trash can. The whole folder is listed first, so the confirmation names
   * the real count, and the deletes run behind the button that started them
   * with the meta line counting them down.
   */
  let emptying = false;
  const emptyTrash = async () => {
    if (emptying) return;
    const box = boxes.trash;
    let all;
    try {
      all = await box.listAll();
    } catch (e) {
      toast(`Could not list Trash: ${e?.message ?? e}`, { iconName: 'alert' });
      return;
    }
    const count = all.length;
    if (!count) return;
    const confirmed = await confirmDialog({
      title: 'Empty Trash?',
      message: `${describe(count)} will be deleted permanently. This cannot be undone.`,
      confirmLabel: 'Empty Trash',
      danger: true,
    });
    if (!confirmed) return;

    emptying = true;
    emptyTrashBtn.disabled = true;
    emptyTrashBtn.classList.add('is-busy');
    emptyTrashBtn.setAttribute('aria-busy', 'true');
    // The reader and the selection are about rows that are about to go.
    if (view().box === 'trash') {
      closeReader({ focusRow: false });
      clearSelection();
    }
    // What is on screen is deleted through its rows, so each one leaves as
    // its files do; what was never paged in is deleted as a conversation of
    // one, which is all that is known about it.
    const shown = new Set(units.flatMap((unit) => unit.messages));
    const list = view().box === 'trash'
      ? [...units, ...all.filter((message) => !shown.has(message)).map((message) => singleThread(message))]
      : all.map((message) => singleThread(message));
    const failed = await deleteForever(list, {
      onProgress: (done) => {
        if (view().box === 'trash' && !searching()) meta.textContent = `Deleting ${done} of ${count}…`;
      },
    });
    emptying = false;
    emptyTrashBtn.disabled = false;
    emptyTrashBtn.classList.remove('is-busy');
    emptyTrashBtn.setAttribute('aria-busy', 'false');
    if (view().box === 'trash') {
      renderAfterChange();
      restoreFocus(0);
    }
    toast(
      failed
        ? `Could not delete ${describe(failed)}.`
        : 'Trash emptied.',
      { iconName: failed ? 'alert' : 'trash' },
    );
  };

  const emptyTrashBtn = el('button.btn.btn-small', {
    type: 'button',
    onclick: emptyTrash,
  }, el('span.btn-icon', { html: icon('trash', 15) }), 'Empty Trash now');

  // Sits above the rows in Trash, the way Gmail's does: the one folder with
  // an action that applies to all of it and cannot be undone.
  const trashNote = el('div.folder-note', {},
    el('span.folder-note-text', {}, 'Messages in Trash stay here until you delete them for good.'),
    emptyTrashBtn,
  );

  // Discarding a draft is not a move -- there is no file -- so it is its own
  // path, with the same undo the moves have.
  const discardDrafts = (list) => {
    const gone = messagesOf(list).map((message) => message.draft);
    // Begin reads before remove queues deletion. Undo owns these snapshots
    // only for the lifetime of its toast.
    const keptFiles = gone.map((draft) => draftStore.loadAttachments?.(draft.id).catch(() => []) ?? Promise.resolve([]));
    for (const unit of list) {
      for (const message of unit.messages) {
        // A composer still open for this draft -- minimized to the dock while
        // its row was discarded here -- goes with it, or its next autosave
        // would put the draft straight back.
        discardComposer({ username: ctx.account.username, mailPath: ctx.mailPath, id: message.name });
        draftStore.remove(message.name);
        boxes[message.box].remove(message);
      }
      shrink(unit, unit.messages);
    }
    renderAfterChange();
    updateNavCounts();
    toast(`${describe(countOf(list))} discarded.`, {
      iconName: 'trash',
      action: {
        label: 'Undo',
        onSelect: () => {
          gone.forEach((draft, index) => {
            draftStore.save(draft);
            keptFiles[index].then((files) => draftStore.saveAttachments?.(draft.id, files)).catch(() => {});
          });
          invalidate('drafts');
          updateNavCounts();
        },
      },
    });
  };

  const runAction = async (id, list) => {
    // What is already on its way somewhere is not sent again.
    if (id !== 'discard') list = idle(list);
    if (!list.length) return;
    // Where the keyboard is, so it can be handed on if this takes the control
    // that has it off the page.
    const at = Math.max(0, visibleRows().indexOf(list[0].row));
    const count = countOf(list);
    if (id === 'discard') {
      discardDrafts(list);
      restoreFocus(at);
      return;
    }
    if (id === 'purge') {
      await purge(list);
      restoreFocus(at);
      return;
    }

    // Restore sends each conversation back where it came from, which is not
    // necessarily the same folder for every one in a selection. A conversation
    // was filed in one move, so its messages share an origin: the newest one's
    // answers for all of them.
    const groups = id === 'restore'
      ? [...list.reduce((map, unit) => {
        const to = originState.get(unit.latest.name);
        map.set(to, [...(map.get(to) ?? []), unit]);
        return map;
      }, new Map())]
      : [[ACTIONS[id].to, list]];

    // Filing the open conversation from the reader can carry on to the next
    // one, where the reader has asked for that. Which one is decided before
    // the move, while the row is still there to count from; whether it is
    // still on screen is checked after, because the move may have taken it.
    const fromReader = frame.classList.contains('reading') && opened
      && list.length === 1 && list[0] === opened;
    const next = fromReader && autoAdvance() ? (neighbour(1) ?? neighbour(-1)) : null;

    const moved = [];
    let failed = 0;
    const onProgress = progressLine(ACTIONS[id].busy, count);
    for (const [to, group] of groups) {
      const result = await move(group, to, { restoring: id === 'restore', onProgress });
      moved.push(...result.moved);
      failed += result.failed;
    }
    renderAfterChange();
    if (next && moved.length && !opened && shownUnits().includes(next) && next.row && !next.row.hidden) {
      openConversation(next);
    } else {
      restoreFocus(at);
    }

    if (!moved.length) {
      toast(`Could not ${ACTIONS[id].label.toLowerCase()} ${describe(failed)}.`, { iconName: 'alert' });
      return;
    }
    const where = id === 'trash'
      ? ' to Trash'
      : id === 'restore' && groups.length === 1
        ? ` to ${VIEWS.find((v) => v.box === groups[0][0])?.label ?? 'Inbox'}`
        : '';
    // What moved, then where it went: "Moved 3 messages to Trash". The other
    // way round read as a folder called "Trash 3 messages" -- and a
    // conversation makes several messages behind one click the normal case,
    // not the bulk one.
    toast(
      `${ACTIONS[id].done}${count > 1 ? ` ${describe(moved.length)}` : ''}${where}`
      + `${failed ? `. ${describe(failed)} could not be moved` : ''}.`,
      { iconName: failed ? 'alert' : ACTIONS[id].icon, action: { label: 'Undo', onSelect: () => undo(moved) } },
    );
  };

  // The target of a row or toolbar action: the ticked conversations if there
  // are any, otherwise the one the action was clicked on.
  const targets = (unit) => (selected.size ? selection() : [unit]);

  /**
   * Flags changed in one go share a stamp, and the flag store keeps the later
   * of them when it is full, so they are changed oldest first. Changed in the
   * order a listing returns them -- newest first -- marking more than the
   * store holds as read left the *newest* messages unread again.
   */
  const oldestFirst = (messages) => messages.map((message) => [`${message.day}/${message.name}`, message])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, message]) => message);

  /**
   * Mark as read, or back to unread -- which is how people queue mail for
   * later, and until now the app could only go one way.
   */
  const setRead = (list, read) => {
    // Where the keyboard is, in case this takes the control that has it off
    // the page: the bulk toolbar empties itself behind its own buttons, and
    // marking the open conversation unread closes the reader around its.
    const at = Math.max(0, visibleRows().indexOf(list[0]?.row));
    const changed = messagesOf(list).filter((message) =>
      !OUTGOING.has(message.box) && isUnread(message) === read);
    for (const message of oldestFirst(changed)) {
      if (read) readState.markRead(message.name);
      else readState.markUnread(message.name);
    }
    for (const unit of list) updateRow(unit);
    clearSelection();
    refreshList();
    updateNavCounts();
    // Marking the open conversation unread is a way of putting it back on the
    // list, so that is where the reader goes.
    if (changed.length && !read && list.includes(opened)) closeReader({ focusRow: false });
    restoreFocus(at);
    if (!changed.length) return;
    toast(
      `${describe(changed.length)} marked as ${read ? 'read' : 'unread'}.`,
      { iconName: read ? 'mailOpen' : 'mail' },
    );
  };

  /**
   * What "everything" is for Mark all as read, where it can be known without
   * a listing: the results in a search, and the starred conversations in
   * Starred -- which is what the view is, not the inbox behind it. Null for a
   * folder, whose answer is the whole folder and costs a listing.
   */
  const markAllShown = () => {
    if (searching()) return results;
    if (folder === 'starred') return messagesOf(units.filter((unit) => matches(unit)));
    return null;
  };

  let markingAll = false;
  const markAllRead = async () => {
    if (markingAll) return;
    markingAll = true;
    markAllBtn.disabled = true;
    let messages;
    try {
      messages = markAllShown();
      if (!messages) {
        // The folder, not the page of it that happens to be loaded.
        try {
          messages = await mailbox().listAll();
        } catch (error) {
          // A failed listing is not permission to mark a partial page, or
          // the different folder the user opened while this one was loading.
          toast(`Could not mark all as read: ${error?.message ?? error}`, { iconName: 'alert' });
          return;
        }
      }
    } finally {
      markingAll = false;
      markAllBtn.disabled = false;
    }
    const changed = messages.filter((message) => isUnread(message));
    if (!changed.length) {
      syncMarkAll();
      return;
    }
    const at = Math.max(0, visibleRows().indexOf(document.activeElement?.closest?.('.row')));
    const apply = (read) => {
      for (const message of oldestFirst(changed)) {
        if (read) readState.markRead(message.name);
        else readState.markUnread(message.name);
      }
      for (const unit of shownUnits()) if (unit.row) updateRow(unit);
      refreshList();
      updateNavCounts();
      updateMeta();
    };
    apply(true);
    // The button hid itself under the press that used it.
    restoreFocus(at);
    toast(`${describe(changed.length)} marked as read.`, {
      iconName: 'mailOpen',
      action: { label: 'Undo', onSelect: () => apply(false) },
    });
  };

  /**
   * Offered only where it would do something: a folder of mail the user
   * wrote is never unread, and neither is a folder they have read.
   *
   * Asked of exactly what the press would act on, which in Starred is the
   * starred conversations rather than the inbox they are filtered out of.
   * Reading the inbox instead offered the button over an empty Starred, and
   * pressing it there did nothing at all -- no toast, no change, no reason
   * given.
   */
  const syncMarkAll = () => {
    markAllBtn.hidden = OUTGOING.has(view().box)
      || (searching() && (searchStatus || searchBox !== mailbox()))
      || !(markAllShown() ?? mailbox().messages).some((message) => isUnread(message));
  };

  // -- list rendering -----------------------------------------------------------

  const filterEmpty = el('div.center', { hidden: true },
    el('span.center-icon'),
    el('p.center-note'),
  );

  const searching = () => !query.empty;

  // Conversations are only worth naming where one of them holds more than a
  // single message: a folder of singles reads the way it always did.
  const grouped = () => units.some((unit) => unit.count > 1);
  const describeUnits = (n) => `${n} conversation${n === 1 ? '' : 's'}`;
  const describeFolder = (total) => (grouped()
    ? `${describe(total)} in ${describeUnits(units.length)}`
    : describe(total));

  const updateMeta = () => {
    syncMarkAll();
    if (!searching() || selected.size) meta.classList.remove('loading-delayed');
    if (selected.size) {
      meta.textContent = wholeFolder
        ? `All ${describe(selectionCount())} in ${view().label} selected`
        : `${selected.size} selected`;
      return;
    }
    if (searching()) {
      updateSearchMeta();
      return;
    }
    const total = mailbox().messages.length;
    if (!total) {
      meta.textContent = '';
      return;
    }
    if (folder === 'starred') {
      const shown = visibleRows().length;
      meta.textContent = grouped()
        ? `${describeUnits(shown)} starred`
        : `${shown} starred message${shown === 1 ? '' : 's'}`;
    } else if (folder === 'drafts') {
      meta.textContent = `${total} draft${total === 1 ? '' : 's'}`;
    } else if (folder === 'sent' || folder === 'archive' || folder === 'trash') {
      meta.textContent = describeFolder(total);
    } else {
      const unread = readState.unreadCount(mailbox().messages.map((m) => m.name));
      meta.textContent = describeFolder(total) + (unread ? `, ${unread} unread` : '');
    }
    updateNavCounts();
  };

  const flags = (message) => ({
    isRead: !isUnread(message),
    isStarred: starState.isStarred(message.name),
  });

  /**
   * Starred filters conversations -- one starred message makes the whole
   * conversation starred, the way it does in Gmail. Search does not: it
   * answers about messages, and a result stands for the one message it found.
   */
  const matchesMessage = (message) => {
    if (folder === 'starred' && !starState.isStarred(message.name)) return false;
    if (!searching()) return true;
    return matchesQuery(query, message, query.flags.length ? flags(message) : undefined);
  };

  const matches = (unit) => (searching()
    ? matchesMessage(unit.latest)
    : folder !== 'starred' || unitStarred(unit));

  const applyFilter = () => {
    if (!searching() && optionsEl.isConnected) {
      const wanted = folderWindow();
      const keep = new Set(wanted);
      for (const unit of units) if (!keep.has(unit) && unit.row && unit !== opened) {
        observer.unobserve(unit.row);
        unit.row.remove();
        unit.row = null;
      }
      syncRows(wanted);
      syncFolderPages();
    }
    for (const unit of units) {
      if (unit.row) unit.row.hidden = !matches(unit);
      // A conversation the filter hides is not something the next bulk action
      // should quietly include.
      if (!matches(unit) && selected.has(unit)) setSelected(unit, false);
    }
    const rows = visibleRows();
    settleTabStops(rows);

    if (opened) syncReaderNav();

    if (mailbox().messages.length && !rows.length) {
      filterEmpty.querySelector('.center-icon').innerHTML = icon('star', 28, 1.4);
      // Starred filters the messages the inbox has listed, and there are
      // usually more of those than one page. "No starred messages" was a
      // claim about mail this view has never looked at -- and a wrong one for
      // anybody who had starred something further back than the first page.
      filterEmpty.querySelector('.center-note').textContent = mailbox().hasMore
        ? 'Nothing starred in the messages loaded so far.'
          + ' Load older messages to look further back.'
        : 'No starred messages. Star a message to find it here.';
      filterEmpty.hidden = false;
    } else {
      filterEmpty.hidden = true;
    }
    syncSelection();
  };

  /** Whichever of the two lists is on screen: the folder, or search results. */
  const refreshList = () => (searching() ? renderResults() : applyFilter());

  const folderWindow = () => {
    const matching = units.filter(unit => folder !== 'starred' || unitStarred(unit));
    folderOffset = Math.min(folderOffset, Math.max(0, Math.ceil(matching.length / FOLDER_WINDOW_SIZE) - 1) * FOLDER_WINDOW_SIZE);
    return matching.slice(folderOffset, folderOffset + FOLDER_WINDOW_SIZE);
  };

  const syncFolderPages = () => {
    listEl.querySelector('.folder-pages')?.remove();
    const count = units.filter(unit => folder !== 'starred' || unitStarred(unit)).length;
    if (count <= FOLDER_WINDOW_SIZE) return;
    const go = (offset) => {
      clearSelection();
      folderOffset = offset;
      applyFilter();
      listEl.scrollTop = 0;
      focusRow(0);
    };
    listEl.append(el('nav.result-pages.folder-pages', { 'aria-label': 'Loaded message pages' },
      el('button.btn.btn-small', { type: 'button', disabled: folderOffset === 0,
        onclick: () => go(folderOffset - FOLDER_WINDOW_SIZE) }, 'Newer loaded messages'),
      el('span', {}, `${folderOffset + 1}–${Math.min(count, folderOffset + FOLDER_WINDOW_SIZE)} of ${count} loaded conversations`),
      el('button.btn.btn-small', { type: 'button', disabled: folderOffset + FOLDER_WINDOW_SIZE >= count,
        onclick: () => go(folderOffset + FOLDER_WINDOW_SIZE) }, 'Older loaded messages')));
  };

  /**
   * Make the options list hold exactly these conversations' rows, in this
   * order. The rows are moved into place rather than cleared and re-appended:
   * emptying the scroller puts its scroll position back to the top, and
   * something is being read in there.
   */
  const syncRows = (wanted) => {
    const rows = wanted.map((unit) => unit.row ?? buildRow(unit));
    const keep = new Set(rows);
    for (const row of [...optionsEl.children]) if (!keep.has(row)) {
      observer.unobserve(row);
      const old = rowUnit.get(row);
      if (old && resultUnits.get(old.latest) === old) old.row = null;
      row.remove();
    }
    rows.forEach((row, i) => {
      // A row built while the folder was on screen may have been hidden by
      // the folder's own filter.
      row.hidden = false;
      if (optionsEl.children[i] !== row) {
        optionsEl.insertBefore(row, optionsEl.children[i] ?? null);
      }
    });
    settleTabStops(rows);
    return rows;
  };

  const releaseResultRows = () => {
    for (const row of optionsEl.children) {
      const unit = rowUnit.get(row);
      if (unit && resultUnits.get(unit.latest) === unit) {
        observer.unobserve(row);
        unit.row = null;
      }
    }
  };

  /**
   * Carry a selection across a rebuild. The rows may be new objects over the
   * same files, so the ticks follow the conversation by name rather than being
   * left on rows that are gone -- the action bar went on offering to act on
   * messages whose rows had been replaced under it.
   */
  const carrySelection = (next) => {
    if (!selected.size) return;
    const ticked = new Set([...selected].map((unit) => unit.id));
    selected.clear();
    for (const unit of next) if (ticked.has(unit.id)) selected.add(unit);
  };

  // -- searching the whole folder ----------------------------------------------

  /**
   * Search is not a filter over the rows on screen. The rows on screen are
   * one page of the folder, and their sender and preview only exist once a
   * row has been looked at -- so filtering them reported "no messages match"
   * for mail that was there all along. Instead the whole folder is listed
   * (filenames carry the subject, so that alone searches every subject), the
   * header index fills in sender and preview, and the list becomes the result
   * set.
   */
  let searchToken = 0;
  let searchController = null;
  let resultOffset = 0;
  let searchEntries = [];
  let searchCandidates = [];
  let results = [];
  let indexedCount = 0;
  let unreadableCount = 0;
  let lastResultKey = '';
  let searchBox = null;
  let searchStatus = '';

  /**
   * Whether an entry has been read successfully, or there is no file to read.
   * A failed attempt can be retried by the next search. A draft has no file --
   * everything its row shows is already in the draft -- so it counts as done
   * rather than leaving the folder "still searching" for good.
   */
  const searched = (entry) => (entry.from !== undefined && !entry.unreadable && !entry.searchIncomplete) || !entry.path;

  const searchState = () => ({
    total: searchEntries.length,
    indexed: indexedCount,
    failed: needsIndex(query) ? unreadableCount : 0,
    complete: !needsIndex(query) || indexedCount >= searchEntries.length,
  });

  const updateSearchMeta = () => {
    meta.classList.toggle('loading-delayed', searchStatus !== 'Search unavailable'
      && Boolean(searchStatus || searchBox !== mailbox() || !searchState().complete));
    if (searchStatus || searchBox !== mailbox()) {
      meta.textContent = searchBox !== mailbox() ? 'Searching…' : searchStatus;
      return;
    }
    const { total, indexed, failed, complete } = searchState();
    const found = `${results.length} result${results.length === 1 ? '' : 's'}`;
    // While the index is incomplete, say what has actually been searched
    // rather than implying a complete answer.
    meta.textContent = complete
      ? failed ? `${found} · could not read ${describe(failed)}`
        : `${found} in ${total} message${total === 1 ? '' : 's'}`
      : `${found} · searching ${indexed} of ${total}`;
  };

  // What the empty panel says under "no messages match": that the folder is
  // still being read, or -- once it has been -- what the search covered. It
  // changes without the (empty) result set changing, so it is brought up to
  // date on its own.
  const noResultsTitle = el('p');
  const noResultsNote = el('p.center-note');
  const syncNoResultsNote = () => {
    const { complete, failed } = searchState();
    noResultsTitle.textContent = failed ? 'No matching messages found so far.' : 'No messages match your search.';
    noResultsNote.textContent = complete
      ? failed ? 'Some messages could not be read. Search again to retry.'
        : 'Search covers the sender, subject, and preview line of every message in this folder.'
      : 'Still reading the rest of this folder…';
  };

  const renderResults = ({ force = false, rescan = true } = {}) => {
    // An older index read can finish while a new folder is being listed, or
    // after that listing failed. It may populate the cache, but it cannot
    // turn a pending or failed search into an answer from the previous one.
    if (searchStatus || searchBox !== mailbox()) return;
    results = [];
    // Only immutable subject mismatches are excluded. Rebuild after folder
    // mutations; header progress and result-page navigation reuse this set.
    if (rescan) searchCandidates = searchEntries.filter(entry => mayMatchSubject(query, entry));
    const indexNeeded = needsIndex(query);
    indexedCount = indexNeeded ? searchEntries.length - searchCandidates.length : searchEntries.length;
    unreadableCount = 0;
    for (const entry of searchCandidates) {
      if (matchesMessage(entry)) results.push(entry);
      // Failed attempts are finished for progress, but not successful reads:
      // report the gap instead of claiming a complete answer or waiting forever.
      if (indexNeeded) {
        const needsRead = needsSearchRead(query, entry);
        if (!needsRead || searched(entry) || entry.unreadable) indexedCount++;
        if (needsRead && entry.unreadable) unreadableCount++;
      }
    }

    // Indexing keeps finding matches; rebuilding the list on every one of
    // them would fight the user's scrolling for nothing.
    resultOffset = Math.min(resultOffset, Math.max(0, Math.ceil(results.length / RESULT_PAGE_SIZE) - 1) * RESULT_PAGE_SIZE);
    const pageResults = results.slice(resultOffset, resultOffset + RESULT_PAGE_SIZE);
    const waitingForResults = !results.length && !searchState().complete;
    const key = `${waitingForResults}:${results.length}:${resultOffset}:${pageResults.map(entry => entry.name).join('|')}`;
    if (!force && key === lastResultKey) {
      updateSearchMeta();
      // The note under an empty result is about the reading, not the
      // results, and the reading has moved on: left alone it went on saying
      // "still reading" under a meta line that said the search was done.
      if (!results.length) syncNoResultsNote();
      return;
    }
    lastResultKey = key;

    if (!results.length) {
      releaseResultRows();
      clear(optionsEl);
      if (waitingForResults) {
        clear(listEl).append(loadingPlaceholder('list', 'Searching your messages'));
      } else {
        syncNoResultsNote();
        clear(listEl).append(el('div.center', {},
          el('span.center-icon', { html: icon('search', 28, 1.4) }),
          noResultsTitle,
          noResultsNote));
      }
      updateSearchMeta();
      syncSelection();
      return;
    }

    // Every result is a conversation of one: search is about the message it
    // found, not about everything that message is in a thread with.
    const wanted = pageResults.map(resultUnit);
    carrySelection(wanted);
    syncRows(wanted);
    if (opened) syncReaderNav();
    // The empty panel replaced the whole scroller, so the options list has to
    // be put back; while it is already the only thing in there, leaving it
    // alone is the entire point of the above.
    if (optionsEl.parentNode !== listEl) clear(listEl).append(optionsEl);
    for (const child of [...listEl.children]) if (child !== optionsEl && child !== selectNote) child.remove();
    if (results.length > RESULT_PAGE_SIZE) {
      const go = (offset) => {
        clearSelection();
        resultOffset = offset;
        renderResults({ force: true, rescan: false });
        listEl.scrollTop = 0;
        focusRow(0);
      };
      listEl.append(el('nav.result-pages', { 'aria-label': 'Search result pages' },
        el('button.btn.btn-small', { type: 'button', disabled: resultOffset === 0,
          onclick: () => go(resultOffset - RESULT_PAGE_SIZE) }, 'Previous results'),
        el('span', { 'aria-live': 'polite' }, `${resultOffset + 1}–${resultOffset + pageResults.length} of ${results.length}`),
        el('button.btn.btn-small', { type: 'button', disabled: resultOffset + RESULT_PAGE_SIZE >= results.length,
          onclick: () => go(resultOffset + RESULT_PAGE_SIZE) }, 'Next results')));
    }
    updateSearchMeta();
    syncSelection();
  };

  // -- the header index --------------------------------------------------------

  const indexQueue = [];
  let indexNext = 0;
  let indexRunning = 0;
  let flushTimer = null;

  const remember = (message) => {
    // A read that failed says nothing about the message, so it is not worth
    // keeping: the index is never invalidated, and a cached "(unreadable)"
    // would outlive the blip that caused it by every future session.
    if (message.unreadable) return;
    // Whose recipients these are decides what the address book makes of
    // them: people written to, or only people on the same message.
    searchIndex.add(message, { outgoing: OUTGOING.has(message.box) });
    // Written every couple of seconds while reads are landing, not a couple
    // of seconds after the last of them: while a folder is being indexed a
    // read lands every few milliseconds, and a timer reset by each one held
    // the write until the whole folder was done -- so a tab closed partway
    // through a long search kept nothing of what it had read.
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      searchIndex.flush();
    }, INDEX_FLUSH_MS);
  };

  let repaintTimer = null;
  const repaintResults = () => {
    if (repaintTimer) return;
    repaintTimer = setTimeout(() => {
      repaintTimer = null;
      if (searching()) renderResults({ rescan: false });
    }, 250);
  };

  const pumpIndex = () => {
    if (!frame.isConnected || searchController?.signal.aborted || !searching()) {
      indexQueue.length = 0;
      indexNext = 0;
      return;
    }
    while (indexRunning < INDEX_CONCURRENCY && indexNext < indexQueue.length) {
      const message = indexQueue[indexNext++];
      if (searched(message) || !needsSearchRead(query, message)) continue;
      indexRunning++;
      enrichMessage(messageReads, message)
        .then((patch) => {
          Object.assign(message, patch);
          remember(message);
          repaint(message);
        })
        .finally(() => {
          indexRunning--;
          repaintResults();
          pumpIndex();
        });
    }
    if (!indexRunning && indexNext >= indexQueue.length) {
      indexQueue.length = 0;
      indexNext = 0;
      searchIndex.flush();
      if (searching()) renderResults({ rescan: false });
    }
  };

  /** Queue the heads the index does not have yet, and read them. */
  const indexMore = (entries) => {
    // Only entries with a file behind them. Queueing a draft read its
    // non-existent path, failed, and overwrote the row with the failure: no
    // preview line and "(no recipient)" where the draft's own recipient had
    // been.
    for (const entry of entries) if (!searched(entry) && needsSearchRead(query, entry)) indexQueue.push(entry);
    pumpIndex();
  };

  /** Read the heads of everything the index does not have yet. */
  const buildIndex = (entries) => {
    indexQueue.length = 0;
    indexNext = 0;
    indexMore(entries);
  };

  /**
   * `relist` is the same query asked again because the folder under it was
   * listed again -- a gap in the watch, mail restored from another device. It
   * is not the reader searching, so the open message, the ticks and the page
   * of results stay where they are.
   */
  const runSearch = async (value, { relist = false } = {}) => {
    searchController?.abort();
    searchController = new AbortController();
    const { signal } = searchController;
    if (!relist) resultOffset = 0;
    queryText = (value ?? '').trim();
    query = parseQuery(queryText);
    const token = ++searchToken;
    lastResultKey = '';
    searchBox = mailbox();
    searchStatus = 'Searching…';
    indexQueue.length = 0;
    indexNext = 0;
    searchEntries = [];
    searchCandidates = [];
    results = [];
    indexedCount = 0;
    unreadableCount = 0;
    if (!relist) {
      if (frame.classList.contains('reading')) closeReader({ focusRow: false });
      clearSelection();
    }

    if (!searching()) {
      searchStatus = '';
      renderList();
      return;
    }

    const box = mailbox();
    updateSearchMeta();
    let entries;
    try {
      entries = await box.listAll({
        signal,
        onProgress: (listedSoFar) => {
          if (signal.aborted || token !== searchToken || box !== mailbox()) return;
          searchStatus = `Listing ${listedSoFar} messages…`;
          updateSearchMeta();
        },
      });
    } catch (e) {
      if (signal.aborted || token !== searchToken || box !== mailbox()) return;
      searchStatus = 'Search unavailable';
      updateSearchMeta();
      clear(listEl).append(el('div.center', {},
        el('span.center-icon', { html: icon('alert', 28, 1.4) }),
        el('p', {}, `Could not search this folder: ${e?.message ?? e}`)));
      return;
    }
    // A newer query, or another folder, has taken over.
    if (signal.aborted || token !== searchToken || box !== mailbox()) return;

    // Everything the index already knows costs nothing to fill in. A row may
    // already exist for one of these -- built by the folder listing before it
    // was ever scrolled to -- and it has to be repainted here: the observer
    // that would otherwise have done it only acts on a message with nothing
    // filled in yet, so the row stayed at '…' with no sender and no preview
    // for as long as it was on screen.
    const candidates = [];
    for (let i = 0; i < entries.length; i++) {
      if (i && i % 500 === 0) {
        await yieldTask();
        if (signal.aborted || token !== searchToken || box !== mailbox()) return;
      }
      const entry = entries[i];
      if (!mayMatchSubject(query, entry)) continue;
      candidates.push(entry);
      if (entry.from === undefined && hydrate(entry)) repaint(entry);
    }
    searchEntries = entries;
    searchCandidates = candidates;
    searchStatus = '';
    if (relist) {
      // The listing built new entries for the same files. What was open or
      // ticked follows its file to the entry that replaced it, and goes if
      // the file has left the folder.
      const byName = new Map(entries.map((entry) => [entry.name, entry]));
      const follow = (unit) => {
        const now = byName.get(unit.latest.name);
        return !now ? null : now === unit.latest ? unit : resultUnit(now);
      };
      for (const unit of [...selected]) {
        const now = follow(unit);
        if (now === unit) continue;
        selected.delete(unit);
        if (now) selected.add(now);
      }
      if (opened && frame.classList.contains('reading')) {
        const now = follow(opened);
        if (!now) closeReader({ focusRow: false });
        else if (now !== opened) {
          opened = now;
          renderMsgActions(now);
        }
      }
    }
    renderResults({ force: true, rescan: false });

    // Subjects come from the filenames, so a subject-only query is already
    // complete; anything else needs the heads read.
    if (needsIndex(query)) buildIndex(candidates);
  };

  const renderList = () => {
    // regroup() carries the selection and the open conversation across itself.
    regroup();
    releaseResultRows();
    if (!mailbox().messages.length) {
      syncRows([]);
      clear(listEl);
      if (mailbox().hasMore && mailbox().total !== 0) {
        // Moving the loaded page does not empty the dates still behind it.
        // Only a complete catalog can prove those remaining dates are empty.
        const failed = Boolean(mailbox().listError);
        listEl.append(el('div.center', {},
          el('span.center-icon', { html: icon(failed ? 'alert' : 'inbox', 28, 1.4) }),
          el('p', {}, failed ? 'Could not load messages.' : 'No messages left on this page.'),
          el('p.center-note', {}, failed
            ? 'Retry loading the messages in this folder.'
            : 'Load older messages to check the rest of this folder.')),
        buildMoreButton());
        syncSelection();
        return;
      }
      const EMPTY = {
        sent: ['send', 'Nothing sent yet.',
          'A copy of every message you send is filed here, in your own account.'],
        archive: ['archive', 'Nothing archived.',
          'Archived messages are kept out of the inbox but never deleted. They stay in your account.'],
        trash: ['trash', 'Trash is empty.',
          'Messages you delete are kept here until you delete them for good.'],
        drafts: ['pencil', 'No drafts.',
          'A message you close before sending is kept here, on this device, until you send or discard it.'],
      };
      if (mailbox().listError) {
        // Nothing is listed because the listing failed. "No mail yet" was a
        // claim about mail this view could not read, with nothing to press,
        // and nothing retried it.
        listEl.append(el('div.center', { role: 'alert' },
          el('span.center-icon', { html: icon('alert', 28, 1.4) }),
          el('p', {}, 'Could not load this folder.'),
          el('p.center-note', {}, String(mailbox().listError?.message ?? mailbox().listError)),
          el('button.btn.btn-small', { type: 'button', onclick: () => refresh() }, 'Retry')));
        syncSelection();
        return;
      }
      const [iconName, title, note] = EMPTY[folder] ?? [];
      listEl.append(iconName
        ? el('div.center', {},
          el('span.center-icon', { html: icon(iconName, 28, 1.4) }),
          el('p', {}, title),
          el('p.center-note', {}, note))
        : el('div.center', {},
          el('span.center-icon', { html: icon('inbox', 28, 1.4) }),
          el('p', {}, 'No mail yet.'),
          el('p.center-note', {}, 'Messages delivered to your Puter mailbox appear here. Check back after your first message arrives.')));
      syncSelection();
      return;
    }

    // Keep existing rows attached during refresh. Even removing and restoring
    // the same nodes loses browser focus and can reset the scroller.
    if (optionsEl.parentNode !== listEl) clear(listEl).append(optionsEl);
    for (const child of [...listEl.children]) {
      if (child !== optionsEl && child !== selectNote) child.remove();
    }
    if (folder === 'trash') listEl.insertBefore(trashNote, optionsEl);
    listEl.append(filterEmpty);
    if (mailbox().hasMore) listEl.append(buildMoreButton());
    applyFilter();
  };

  const showListLoading = () => {
    clear(listEl).append(loadingPlaceholder('list', 'Loading your messages'));
    meta.classList.remove('loading-delayed');
    meta.textContent = '';
  };

  const loadingPages = new Set();
  const buildMoreButton = () => {
    const loading = loadingPages.has(mailbox());
    const more = el('button.btn-more', { type: 'button', disabled: loading, 'aria-busy': String(loading) },
      mailbox().listError ? 'Retry loading messages' : 'Load older messages');
    more.addEventListener('click', async () => {
      const box = mailbox();
      const revision = folderLoadRevision;
      if (loadingPages.has(box)) return;
      const hadFocus = document.activeElement === more;
      loadingPages.add(box);
      more.disabled = true;
      more.setAttribute('aria-busy', 'true');
      try {
        const added = await box.loadMore();
        // Grouping needs a message id per message, so the older page is read
        // before it is shown -- quietly, because the meta line is the count of
        // what is already on screen rather than a progress bar.
        if (threadable()) await readHeads(added, {
          active: () => box === mailbox() && revision === folderLoadRevision && !searching() });
      } finally {
        loadingPages.delete(box);
        // The user may have returned while this unabortable SDK call was
        // finishing. Release the replacement control without painting an
        // obsolete page over the new listing or stealing its focus.
        if (box === mailbox() && revision !== folderLoadRevision) {
          const current = listEl.querySelector('.btn-more');
          if (current) {
            current.disabled = false;
            current.setAttribute('aria-busy', 'false');
            current.textContent = box.listError ? 'Retry loading messages' : 'Load older messages';
          }
        }
      }
      // The folder can change while the batch is being listed, and so can what
      // is on screen. A search takes the scroller over and lists the whole
      // folder itself, so an older page has no business being appended to it:
      // it arrived as hidden rows, a second "Load older messages" button, and
      // the folder's own empty panel, in the middle of a result set. The page
      // is listed either way, and the folder shows it when the search is
      // cleared.
      if (box !== mailbox() || revision !== folderLoadRevision || searching()) return;
      const previousRows = hadFocus ? new Set(visibleRows()) : null;
      const resumeFocus = () => {
        if (!hadFocus) return;
        const active = document.activeElement;
        if (active && active !== document.body && active !== more) return;
        // Disabling/removing the button can drop focus on the document.
        // Continue at the newly shown rows, or Retry if no rows appeared,
        // unless the user moved to another control while the read was pending.
        const rows = visibleRows();
        const next = rows.findIndex((row) => !previousRows.has(row));
        if (next !== -1) focusRow(next);
        else {
          const retry = listEl.querySelector('.btn-more');
          if (retry) retry.focus();
          else restoreFocus(rows.length - 1);
        }
      };
      if (box.listError) {
        toast(`Could not load some messages: ${box.listError?.message ?? box.listError}`, { iconName: 'alert' });
      }
      if (!box.messages.length) {
        renderList();
        resumeFocus();
        return;
      }
      // Searching and returning can replace the button while this request
      // runs. Remove the current control before adding its updated version.
      listEl.querySelectorAll('.btn-more').forEach((button) => button.remove());
      // An older message can belong to a conversation already on screen -- it
      // is the start of one, usually -- so the page is grouped against what is
      // listed rather than on its own, and the rows that stay keep their place.
      regroup();
      folderOffset = Math.max(0, Math.ceil(units.length / FOLDER_WINDOW_SIZE) - 1) * FOLDER_WINDOW_SIZE;
      syncRows(folderWindow());
      if (optionsEl.parentNode !== listEl) clear(listEl).append(optionsEl);
      listEl.append(filterEmpty);
      if (box.hasMore) listEl.append(buildMoreButton());
      applyFilter();
      resumeFocus();
    });
    return more;
  };

  // -- message view ---------------------------------------------------------------

  /**
   * The cards of the open conversation. The toolbar's source switch and a star
   * toggled from the list both have to reach every one of them.
   */
  let cards = [];
  let readerMessages = [];
  let readerStart = 0;
  let latestCard = null;
  let threadPagesEl = null;
  let readerReady = Promise.resolve();

  // At most four full bodies are requested at a time by bulk reader actions.
  // Disposed cards never start another read or parse a late response.
  const expandCards = async (items, current = () => true) => {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length && current()) {
        const card = items[next++];
        if (!card.disposed && (!card.open || !card.data)) await card.expand();
        await yieldTask();
      }
    }));
  };

  const releaseCards = () => {
    for (const card of new Set([...cards, latestCard])) card?.dispose();
    cards = [];
    latestCard = null;
    readerMessages = [];
  };
  // The parts of the open conversation that are added to when it grows: the
  // heading with its count, the stack the cards go in, the reply block.
  let headingEl = null;
  let stackEl = null;
  let replyBlockEl = null;
  let readerRevision = 0;
  let historyController = null;
  let showingSource = false;
  /**
   * What Reply, Reply all and Forward do for the open conversation, so `r`,
   * `a` and `f` press the same buttons rather than rebuilding what those
   * buttons know. Null until the newest message has been read -- which is also
   * exactly when the buttons appear, so the keys and the toolbar become
   * available together.
   */
  let replyActions = null;

  const syncCardStars = () => {
    for (const card of new Set([...cards, latestCard])) card?.syncStar();
  };

  const closeReader = ({ focusRow = true } = {}) => {
    historyController?.abort();
    readerRevision++;
    frame.classList.remove('reading');
    showReaderTools(false);
    readerNav.hidden = true;
    foldBtn.hidden = true;
    showingSource = false;
    sourceBtn.setAttribute('aria-pressed', 'false');
    releaseCards();
    threadPagesEl = null;
    headingEl = null;
    stackEl = null;
    replyBlockEl = null;
    replyActions = null;
    clear(msgActions);
    clear(msgScroll);
    if (opened?.row) {
      opened.row.setAttribute('aria-selected', String(selected.has(opened)));
      if (focusRow) {
        // The row the keyboard comes back to is the list's one tab stop;
        // left on whichever row had it before, Shift+Tab from here jumped to
        // the top of the list.
        for (const row of visibleRows()) row.tabIndex = row === opened.row ? 0 : -1;
        opened.row.focus();
      }
    }
    opened = null;
  };

  /**
   * Save an attachment into the user's own Puter files, through the OS's save
   * dialog. Inside a cloud OS the download folder of the device is the wrong
   * place for a file half the time: the file belongs next to the other files,
   * where the other apps are. The picker writes the bytes itself and rejects
   * when it is dismissed, which is not a failure worth reporting.
   */
  const saveAttachment = async (attachment) => {
    let blob;
    try {
      blob = new Blob([attachment.bytes()], { type: attachment.type });
    } catch {
      toast('Could not decode this attachment.', { iconName: 'alert' });
      return;
    }
    const name = safeFilename(attachment.filename);
    let saved;
    try {
      saved = await ctx.saveToPuter(blob, name);
    } catch {
      return; // dismissed
    }
    toast(`Saved ${saved?.name || name} to your Puter files.`, { iconName: 'cloudUpload' });
  };

  const downloadBlob = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  /**
   * Which attachments the reader can show rather than only hand over: the
   * image types every browser draws. SVG is left out on purpose -- it is a
   * document that can carry script, and although an <img> would not run it,
   * a file that is not what it looks like is not one to open in place. A
   * very large image is a download, not a preview.
   */
  const PREVIEW_TYPES = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;
  const PREVIEW_MAX_BYTES = 15 * 1024 * 1024;
  const previewable = (attachment) => PREVIEW_TYPES.test(attachment.type)
    && attachment.size <= PREVIEW_MAX_BYTES;

  /**
   * Show an image attachment in a dialog of its own, with the download beside
   * it. A photo sent by mail is looked at far more often than it is filed,
   * and downloading it to find out what it was is the long way round. The
   * bytes are decoded here and only here, into a blob URL that goes when the
   * dialog does.
   */
  const previewAttachment = (attachment) => {
    const name = safeFilename(attachment.filename);
    let url;
    try {
      url = URL.createObjectURL(new Blob([attachment.bytes()], { type: attachment.type }));
    } catch {
      toast('Could not decode this attachment.', { iconName: 'alert' });
      return;
    }
    let modal;
    const image = el('img.preview-image', {
      src: url, alt: name,
      // A file that claims to be an image and is not draws nothing; say so
      // rather than leaving an empty dialog.
      onerror: () => {
        image.replaceWith(el('p.preview-failed', {}, 'This file could not be shown as an image.'));
      },
    });
    const content = el('div.preview', {},
      el('div.preview-stage', {}, image),
      el('div.preview-actions', {},
        el('span.preview-size', {}, formatSize(attachment.size)),
        el('span.spacer'),
        ctx.saveToPuter && el('button.btn', {
          type: 'button', onclick: () => saveAttachment(attachment),
        }, el('span.btn-icon', { html: icon('cloudUpload', 15) }), 'Save to Puter'),
        el('button.btn.btn-primary', {
          type: 'button', onclick: () => downloadAttachment(attachment),
        }, el('span.btn-icon', { html: icon('download', 15) }), 'Download'),
      ),
    );
    modal = openModal({
      title: name,
      content,
      onClose: () => URL.revokeObjectURL(url),
    });
    modal.panel.classList.add('preview-panel');
    return modal;
  };

  const downloadAttachment = (attachment) => {
    try {
      // The name the message chose is a label, not a path, and not a place to
      // hide a right-to-left override that makes .exe read as .pdf.
      downloadBlob(new Blob([attachment.bytes()], { type: attachment.type }),
        safeFilename(attachment.filename));
    } catch {
      toast('Could not decode this attachment.', { iconName: 'alert' });
    }
  };

  /**
   * The sender's address onto the clipboard. It is on screen beside the name,
   * in angle brackets, and selecting exactly the part between them with a
   * pointer is the fiddly thing it has always been. Where the clipboard is
   * not available -- an insecure context, or a browser that asks first and
   * was told no -- the toast says so rather than claiming a copy that did not
   * happen.
   */
  const copyAddress = async (card) => {
    const email = card.data?.from?.email;
    if (!email) return;
    try {
      await navigator.clipboard.writeText(email);
      toast(`Copied ${email}.`, { iconName: 'copy' });
    } catch {
      toast('Could not copy to the clipboard.', { iconName: 'alert' });
    }
  };

  /**
   * The headers of a message that say who it is from and to, laid out as a
   * table: what the reader wants when the sender's name is not enough, and
   * View source is too much. Encoded words are decoded, so a name written as
   * `=?UTF-8?B?...?=` reads as the name; everything else is shown as it came,
   * because a Message-ID or a Reply-To is exactly the thing being checked.
   */
  const showDetails = (card) => {
    const { headers, attachments } = card.data;
    const decoded = (name) => (headers.get(name) ? decodeWords(headers.get(name)) : '');
    const date = new Date(headers.get('date') || '');
    const rows = [
      ['From', decoded('from')],
      ['Reply-To', decoded('reply-to')],
      ['To', decoded('to')],
      ['Cc', decoded('cc')],
      ['Date', Number.isNaN(date.valueOf()) ? headers.get('date') || '' : formatFullDate(date)],
      ['Subject', decoded('subject')],
      ['Message-ID', headers.get('message-id') || ''],
      ['In-Reply-To', headers.get('in-reply-to') || ''],
      ['List', decoded('list-id')],
      ['Attachments', attachments.length
        ? attachments.map((a) => `${safeFilename(a.filename)} (${formatSize(a.size)})`).join(', ')
        : ''],
    ].filter(([, value]) => value);
    const modal = openModal({
      title: 'Message details',
      content: el('dl.details', {}, rows.map(([name, value]) => [
        el('dt.details-name', {}, name),
        el('dd.details-value', {}, value),
      ])),
    });
    modal.panel.classList.add('details-panel');
    return modal;
  };

  /**
   * The message as it arrived, as a file: the same bytes View source shows,
   * under the subject's name with `.eml` on the end, which every mail client
   * opens. It is how a message leaves this app for another one.
   */
  const downloadMessage = (card) => {
    const { raw, subject } = card.data;
    const base = safeFilename(subject || 'message').replace(/\.eml$/i, '') || 'message';
    try {
      downloadBlob(new Blob([raw], { type: 'message/rfc822' }), `${base}.eml`);
    } catch {
      toast('Could not download this message.', { iconName: 'alert' });
    }
  };

  /**
   * A message body, built node by node from the segments the linkifier
   * returns. No mail-derived string is ever assigned to innerHTML: a URL
   * becomes an anchor, an address becomes the same compose the Reply button
   * uses, and everything else stays a text node.
   */
  const linkNodes = (text) => linkify(text).map((segment) => {
    if (segment.text !== undefined) return document.createTextNode(segment.text);

    if (segment.email) {
      return ctx.onCompose
        ? el('button.msg-link', {
          type: 'button',
          title: `Write to ${segment.email}`,
          onclick: () => compose({ to: segment.email }),
        }, segment.label)
        : el('a.msg-link', {
          href: `mailto:${segment.email}`,
          title: `Write to ${segment.email}`,
        }, segment.label);
    }

    const anchor = el('a.msg-link', {
      href: segment.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      // Hover and focus both show where it actually goes.
      title: segment.url,
    }, segment.label);

    // Mail is where phishing arrives. When the host as written is not the
    // host the browser would connect to -- a homograph, or userinfo in
    // front of the real host -- say so next to the link.
    if (!segment.mismatch) return anchor;
    return el('span.msg-link-pair', {}, anchor, el('span.msg-link-host', {
      title: `This link goes to ${segment.host}`,
    }, ` (${segment.host})`));
  });

  /**
   * A "to" or "cc" line in an open message's header: the people by name, the
   * way the rows name them, with the header as it was written held in the
   * tooltip for anyone who wants the addresses. The reader's own address
   * reads as "me", so a message to three people says who the other two are
   * rather than repeating an address they own. A header that names nobody
   * this parser can read is shown as it came.
   */
  const peopleLine = (label, value) => {
    if (!value || (Array.isArray(value) && !value.length)) return null;
    // List headers already contain parsed recipients; the full body carries
    // the original header text. Both should paint the same visible names.
    const parsed = Array.isArray(value) ? value : parseAddressList(value);
    const original = Array.isArray(value) ? value.map(person => person.email
      ? `${person.name || person.email} <${person.email}>` : person.name).join(', ') : value;
    const people = parsed.map((person) => {
      if (ownAddresses.has((person.email || '').toLowerCase())) return 'me';
      return person.name || person.email;
    }).filter(Boolean);
    return el('div.msg-to', { title: `${label}: ${original}` },
      `${label} ${people.length ? people.join(', ') : original}`);
  };

  /**
   * The way off a mailing list, beside the sender of a message that names one
   * in `List-Unsubscribe`. Most of what a newsletter offers for this is a
   * link buried at the foot of its HTML, which the plain text view flattens
   * and the sanitizer may well have disarmed -- and the header is what the
   * list actually honours.
   *
   * A `mailto:` becomes a message from this app, prefilled and shown before
   * it goes, so the user sees exactly what is sent and from where; failing
   * that a URL is opened as an ordinary link, in a new tab, with the host said
   * in the tooltip. Nothing is posted on the user's behalf: a one-click POST
   * from the browser would be an opaque request whose outcome could not be
   * reported, to a host the header chose.
   */
  const unsubscribeControl = (data) => {
    const ways = data?.unsubscribe;
    if (!ways || (!ways.mailto && !ways.url)) return null;
    if (ways.mailto && ctx.onCompose) {
      return el('button.msg-unsubscribe', {
        type: 'button',
        title: `Write to ${ways.mailto.to} to unsubscribe`,
        onclick: () => compose({
          kind: 'unsubscribe',
          to: ways.mailto.to,
          subject: ways.mailto.subject || 'Unsubscribe',
          body: ways.mailto.body,
        }),
      }, 'Unsubscribe');
    }
    const href = ways.url ?? `mailto:${ways.mailto.to}`;
    let host = '';
    try {
      host = new URL(href).host;
    } catch {}
    return el('a.msg-unsubscribe', {
      href,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: ways.url ? `Unsubscribe at ${host}` : `Write to ${ways.mailto.to} to unsubscribe`,
    }, 'Unsubscribe');
  };

  /**
   * One message inside the open conversation.
   *
   * Collapsed it is a single line -- who wrote, the preview, the date, its own
   * star -- and its file has not been read. Expanded it reads its own file, so
   * a conversation of twenty downloads only what is actually opened. A
   * conversation of one is never collapsible: on its own there is nothing to
   * collapse it in favour of, and it is the message view this app has always
   * had.
   */
  const messageCard = (message, thread, onRead = () => {}, onToggle = () => {}) => {
    /**
     * Whether this is one message among several, which is what decides if it
     * folds to a line. Asked each time rather than settled once, because a
     * conversation grows under its reader -- the history behind it arrives,
     * a reply lands -- and a message that was on its own is then one of
     * several. `card.thread` is the conversation the reader holds now.
     */
    const collapsible = () => card.thread.count > 1;
    // The star is a sibling of the region that expands the message, not a
    // child of it: a control inside a control is one the keyboard and a screen
    // reader both have to guess at.
    const opener = el('div.msg-item-open');
    const head = el('div.msg-meta.msg-item-head', {}, opener);
    const full = el('div.msg-full', { hidden: true });
    const node = el('div.msg-item', {}, head, full);

    let reading = null; // the read in flight, so two clicks make one read
    let repaintBody = () => {};

    const star = el('button.star-btn', {
      type: 'button',
      html: icon('star', 18),
      onclick: () => {
        starState.toggle(message.name);
        card.syncStar();
        // A star inside a conversation is a star on that message, and the row
        // shows the conversation's -- so the row has to be told.
        for (const other of message.units ?? []) if (other.row) updateRow(other);
        if (folder === 'starred' || searching()) refreshList();
      },
    });

    // Who wrote this one. The header names them, and so does every control
    // beside it: in a stack of messages "which message?" is the whole question.
    // Until the file has been read this is what the row knew, and '…' after
    // that -- the same placeholder the row shows at the same moment.
    const sender = () => {
      const person = card.data?.from ?? message.from ?? { name: '…', email: '' };
      // The reader's own message reads as "me", as it does in the rows and
      // on the "to" line. The composer sends from the bare address, with no
      // display name, so a conversation with a reply of the reader's in it
      // was otherwise three names and one address -- their own.
      const mine = ownAddresses.has((person.email || '').toLowerCase());
      return { person, mine, name: mine ? 'me' : (person.name || person.email || '(unknown sender)') };
    };

    // The name alone is not enough: a conversation is mostly two people
    // taking turns, so one name repeats, and two controls with one label are
    // no answer to which message either is about. The date -- said the way
    // the collapsed line shows it -- is what tells them apart.
    const which = () => `the message from ${sender().name}, ${formatWhen(message)}`;

    const card = {
      message,
      node,
      thread,
      open: false,
      disposed: false,
      data: null,
      // Told when the file has been read. The reader points this at its reply
      // block, and points it there again when the conversation is redrawn
      // around the card, so a read that lands after that still counts.
      onRead,
      syncStar: () => syncStarBtn(star, starState.isStarred(message.name), which()),
      paint: () => repaintBody(),
    };
    const toggle = () => (card.open ? card.collapse() : card.expand());
    /**
     * In a conversation the name is the control that opens and closes the
     * message: a real button, so that the menu beside the date and the
     * Unsubscribe link beside the name are controls of their own rather than
     * children of one. The whole line used to be the button, with those
     * inside it -- and a button inside a button is one a screen reader does
     * not reach, since what is inside a button is taken to be its label. The
     * line itself stays a click target for the pointer. One element for the
     * life of the card, like the star, so the keyboard stays on it when the
     * head is drawn again around it.
     */
    const expander = el('button.msg-from-name.msg-expander', { type: 'button', onclick: toggle });

    /**
     * What else can be done with this one message, beside its date. Reply,
     * Reply all and Forward at the foot of the conversation answer the newest
     * message, which is usually right and sometimes not: the thing to answer
     * is the question three messages up, not the "thanks" under it. In a
     * conversation the menu carries the same three for this message; on its
     * own, where the block below already answers it, it does not repeat them.
     * Download original is the message as a file, wherever it is.
     */
    const moreMenu = () => {
      const anchor = el('span.menu-anchor');
      const button = el('button.icon-btn.msg-more', {
        type: 'button', html: icon('more', 18),
        'aria-label': `More actions for ${which()}`,
        title: 'More',
      });
      anchor.append(button);
      attachMenu(button, () => {
        const answers = collapsible() && ctx.onCompose ? answersFor(card) : null;
        return [
          answers && { label: 'Reply', icon: 'reply', onSelect: answers.reply },
          answers?.replyAll && { label: 'Reply all', icon: 'replyAll', onSelect: answers.replyAll },
          answers && { label: 'Forward', icon: 'forward', onSelect: answers.forward },
          answers && { separator: true },
          card.data?.from?.email && {
            label: 'Copy sender\'s address', icon: 'copy', onSelect: () => copyAddress(card),
          },
          { label: 'Show details', icon: 'info', onSelect: () => showDetails(card) },
          { label: 'Download original (.eml)', icon: 'fileDown', onSelect: () => downloadMessage(card) },
        ];
      });
      return anchor;
    };

    const renderHead = () => {
      const { person, mine, name } = sender();
      const folds = collapsible();
      // Taking the head apart blurs whatever in it had the keyboard.
      const hadKeyboard = document.activeElement === expander;
      if (folds) {
        expander.textContent = name;
        expander.setAttribute('aria-expanded', String(card.open));
        expander.setAttribute('aria-label', `${card.open ? 'Collapse' : 'Expand'} ${which()}`);
      }
      clear(opener);
      append(opener, [
        // The disc is the reader's own, from their address, rather than an M.
        el('span.avatar', {
          'aria-hidden': 'true',
          style: { '--hue': hueFor(person.email || person.name || '') },
        }, initialFor(mine ? person.email : name)),
        el('div.msg-who', {},
          el('div.msg-from', {},
            // On its own a message has a name that is only a name.
            folds ? expander : el('span.msg-from-name', {}, name),
            card.open && person.email && person.email !== name
              && el('span.msg-from-email', {}, `<${person.email}>`),
            card.open && unsubscribeControl(card.data),
          ),
          card.open
            ? [peopleLine('to', card.data?.to ?? message.to), peopleLine('cc', card.data?.cc)]
            // Collapsed, the preview line is what says which message this is.
            : el('div.msg-item-snippet', {}, message.snippet ?? ''),
        ),
        el('div.msg-side', {},
          // formatFullDate() answers '' for a Date header that will not parse,
          // so an expanded message falls back to what the row shows -- which
          // knows about the file's own timestamp.
          el('time.msg-date', {}, card.open
            ? formatFullDate(card.data?.date ?? message.date) || formatWhen(message)
            : formatWhen(message)),
          card.open && (card.data ? moreMenu()
            : el('span.msg-more-placeholder', { 'aria-hidden': 'true' })),
        ),
      ]);
      if (head.lastChild !== star) head.append(star);
      card.syncStar();
      opener.classList.toggle('msg-item-toggle', folds);
      if (hadKeyboard && folds) expander.focus({ preventScroll: true });
    };

    // -- the message itself, once its file has been read ----------------------

    const build = (raw) => {
      const { head: rawHead, body } = splitMessage(raw);
      const headers = parseHeaders(rawHead);
      // Kept as it is, empty included: it is what a reply and a forward are
      // built on, and a placeholder written here went out as a subject line
      // reading "Re: (no subject)". Where it is shown, it is shown as one.
      const subject = decodeWords(headers.get('subject') || '') || message.subject || '';
      const from = parseAddress(headers.get('from') || '');
      const date = new Date(headers.get('date') || '');
      // The markup first, because the attachment list needs it: a part the
      // HTML shows by `cid:` is layout rather than a file. Given it, the list
      // does not walk the message again looking for the same part.
      const html = extractHtml(body, headers);
      const attachments = listAttachments(body, headers, 0, referencedCids(html));
      const invites = listCalendarInvites(body, headers);
      const written = extractBodyText(body, headers);
      // Kept as it is, empty included, for the same reason the subject above
      // is: a reply and a forward are built on it. A photo sent from a phone
      // with nothing typed under it is a message with no text, and the note
      // the reader shows in its place went out inside the answer to it, as
      // `> (no text content)`. Where it is shown, it is shown as one.
      const text = written.text;

      card.data = {
        raw, headers, subject, from, date, attachments, text, html,
        to: headers.get('to') ? decodeWords(headers.get('to')) : '',
        // Who else it went to. Reply all is offered on the strength of this
        // line, and until it was shown the reader had no way of seeing who
        // that would answer short of View source.
        cc: headers.get('cc') ? decodeWords(headers.get('cc')) : '',
        // The way out of the list this came from, if it names one. Mail the
        // user sent names none, whatever its headers say.
        unsubscribe: OUTGOING.has(message.box) ? null : parseListUnsubscribe(headers.get('list-unsubscribe')),
      };

      const bodyPre = el('pre.msg-body');

      /**
       * The copy of the message above that a reply carries at the end of
       * itself. In a conversation it is on screen twice, so it is folded away
       * behind a control the way Gmail folds it -- and only in a conversation,
       * because a message on its own has nothing above it to repeat.
       */
      const folded = splitQuotedTail(text);
      // What is shown of the message: the reply in front of its quote, in a
      // conversation; all of it, on its own.
      const split = () => (collapsible() && folded.quoted ? folded : { text, quoted: '' });
      let showQuoted = false;
      const quotedBtn = folded.quoted && el('button.msg-quoted', {
        type: 'button',
        'aria-expanded': 'false',
      }, '···');
      if (quotedBtn) {
        quotedBtn.onclick = () => {
          showQuoted = !showQuoted;
          repaintBody();
          // The repaint empties the pre and fills it again, so the button this
          // click was on left the document and came back. Without this the
          // keyboard is dropped on <body> by the act of using it.
          quotedBtn.focus();
        };
      }

      // -- the HTML view ------------------------------------------------------
      //
      // Plain text stays the default and stays fully functional. This is a
      // second view, rendered only when the reader asks for it, in an iframe
      // with neither allow-scripts nor allow-same-origin: no mail script can
      // run, and the frame is a unique opaque origin that cannot reach this
      // app's storage or its Puter token. A CSP inside the frame blocks remote
      // content, and the markup is sanitized before it gets there anyway.

      // Both of these walk the whole message, and neither is worth anything
      // until the formatted view is asked for -- which most messages never
      // are. Done on opening, they were work every message paid for so that
      // the few that are shown as markup could skip it.
      let inline = null;
      const dataUrls = new Map();
      // An inline image arrived with the message, so it is not remote content:
      // cid: references become data: URLs from the part they name.
      const resolveCid = (cid) => {
        if (!dataUrls.has(cid)) {
          inline ??= listInlineParts(body, headers);
          const part = inline.find((item) => item.cid === cid);
          try {
            dataUrls.set(cid, part ? `data:${part.type};base64,${bytesToBase64(part.bytes())}` : null);
          } catch {
            dataUrls.set(cid, null);
          }
        }
        return dataUrls.get(cid);
      };

      const sender = (from.email || '').toLowerCase();
      // What the frame may fetch is decided by what the reader has allowed, not
      // by what this app managed to spot in the markup: a tracker somewhere
      // hasRemoteContent does not look must still not load. Detection only
      // decides whether the reader is told anything is being held back.
      let remoteContent = null;
      const blocksImages = () => (remoteContent ??= html ? hasRemoteContent(html) : false);
      let showImages = imageState.allows(sender);

      const htmlWrap = el('div.msg-html', { hidden: true });

      const frameDocument = (safe) => [
        '<!doctype html><html><head><meta charset="utf-8">',
        // What actually stops a tracking pixel: nothing may load unless it is
        // named here, and remote images are only named once the reader asks.
        '<meta http-equiv="Content-Security-Policy" content="',
        "default-src 'none'; base-uri 'none'; form-action 'none'; ",
        "style-src 'unsafe-inline'; ",
        `img-src data:${showImages ? ' https: http:' : ''}`,
        '">',
        '<meta name="referrer" content="no-referrer">',
        '<style>',
        'html{color-scheme:light}',
        // Mail is designed for a white page; rendering it on a dark one is a
        // worse lie than showing it as it was sent.
        'body{margin:0;padding:12px;background:#fff;color:#1f1f1f;',
        'font:14px/1.5 Roboto,-apple-system,"Segoe UI",Arial,sans-serif;',
        // A wide table scrolls inside the frame rather than dragging the page
        // sideways.
        'overflow-x:auto;overflow-wrap:break-word}',
        'img{max-width:100%;height:auto}',
        'table{max-width:100%}',
        'a{color:#0b57d0}',
        // A link the sanitizer took the href off -- a javascript: URL, or a
        // relative one with nothing to resolve against -- is text now, and
        // should not go on looking like something to click. The message's own
        // inline colour is overridden on purpose: it was written for a link.
        'a:not([href]){color:inherit!important;text-decoration:none!important;cursor:inherit}',
        '</style></head><body>',
        safe,
        '</body></html>',
      ].join('');

      const renderHtml = () => {
        clear(htmlWrap);
        const safe = sanitizeHtml(html, { resolveCid, allowRemoteImages: showImages });

        if (!showImages && blocksImages()) {
          htmlWrap.append(el('div.msg-images', {},
            el('span.msg-images-icon', { html: icon('shield', 15) }),
            el('span.msg-images-text', {},
              'Remote images are blocked, so nothing in this message can report that you opened it.'),
            // The two choices stay together in one group: as separate flex
            // children they broke apart on a narrow reading pane, leaving
            // "Always from ..." stranded on its own line at the far left.
            el('span.msg-images-actions', {},
              el('button.btn.btn-small', {
                type: 'button',
                onclick: () => {
                  showImages = true;
                  renderHtml();
                },
              }, 'Show images'),
              sender && el('button.btn.btn-small.btn-ghost', {
                type: 'button',
                onclick: () => {
                  imageState.allow(sender);
                  showImages = true;
                  renderHtml();
                  toast(`Images from ${sender} will be shown from now on.`, { iconName: 'shield' });
                },
              }, `Always from ${sender}`),
            ),
          ));
        }

        // Built with setAttribute rather than the element helper so the sandbox
        // is exactly this and nothing else.
        const box = document.createElement('iframe');
        box.className = 'msg-frame';
        box.setAttribute('title', `${subject || '(no subject)'} — original formatting`);
        // allow-popups is what lets a link open; allow-popups-to-escape-sandbox
        // means the page it opens is an ordinary tab rather than a crippled
        // one. Neither allow-scripts nor allow-same-origin is here, which is
        // the whole point.
        box.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
        box.setAttribute('referrerpolicy', 'no-referrer');
        box.srcdoc = frameDocument(safe);
        htmlWrap.append(box);
      };

      let showingHtml = false;
      const formatBtn = html && el('button.btn.btn-small.btn-ghost', { type: 'button' });

      repaintBody = () => {
        bodyPre.hidden = showingHtml && !showingSource;
        htmlWrap.hidden = !showingHtml || showingSource;
        clear(bodyPre);
        // The source view stays raw and unlinkified: it is there to show what
        // actually arrived.
        if (showingSource) {
          bodyPre.append(document.createTextNode(decodeBytes(raw)));
        } else {
          const shown = split();
          // The note that stands in for a message with nothing in it. Said
          // here, where it is read, rather than in `text`, which is what an
          // answer to this message quotes.
          append(bodyPre, linkNodes(shown.text || (invites.length ? '' : EMPTY_BODY)));
          if (quotedBtn && shown.quoted) {
            // It stays on screen once the quote is out, because it is the only
            // way back: hiding it meant a quote could be unfolded but never
            // folded again, and left `aria-expanded="true"` on a control a
            // screen reader could no longer reach.
            const label = showQuoted ? 'Hide the quoted message' : 'Show the quoted message';
            quotedBtn.setAttribute('aria-expanded', String(showQuoted));
            quotedBtn.setAttribute('aria-label', label);
            quotedBtn.title = label;
            // A line of its own: appended straight after the text it follows,
            // it read as the last word of the signature above it.
            bodyPre.append(document.createTextNode('\n'), quotedBtn);
            // Set apart rather than run on: unfolded, the copy of the message
            // above was the same ink at the same size as the answer to it, and
            // where a client fenced its quote off instead of putting '> ' in
            // front of every line there was nothing at all to tell them apart.
            if (showQuoted) bodyPre.append(el('span.msg-quote', {}, linkNodes(shown.quoted)));
          }
        }
        bodyPre.classList.toggle('msg-source', showingSource);
        if (formatBtn) {
          formatBtn.textContent = showingHtml ? 'Show plain text' : 'Show original formatting';
          formatBtn.disabled = showingSource;
        }
      };

      if (formatBtn) {
        formatBtn.onclick = () => {
          showingHtml = !showingHtml;
          // Nothing is rendered until the reader asks for it, and only for this
          // message.
          if (showingHtml && !htmlWrap.firstChild) renderHtml();
          repaintBody();
        };
      }

      clear(full);
      append(full, [
        invites.map((event) => calendarCard(event, downloadAttachment)),
        attachments.length > 0 && el('div.msg-attachments', {
          role: 'group', 'aria-label': `${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`,
        }, attachments.map((a) => {
          // Shown and downloaded under the same defused name, so what the reader
          // reads is what lands in their downloads folder.
          const name = safeFilename(a.filename);
          // An image opens in place, with the download inside the preview;
          // everything else downloads, which is all there is to do with it.
          const preview = previewable(a);
          const download = el('button.attachment', {
            type: 'button',
            title: preview ? `Preview ${name}` : `Download ${name}`,
            onclick: () => (preview ? previewAttachment(a) : downloadAttachment(a)),
          },
            el('span.attachment-icon', { html: icon(preview ? 'image' : 'paperclip', 14) }),
            el('span.attachment-name', {}, name),
            el('span.attachment-size', {}, formatSize(a.size)),
            el('span.attachment-dl', { html: icon(preview ? 'eye' : 'download', 14) }),
          );
          // The other place a file can go inside a cloud OS: the user's own
          // Puter files, the way the compose dialog can attach from them.
          if (!ctx.saveToPuter) return download;
          return el('span.attachment-group', {},
            download,
            el('button.attachment-save', {
              type: 'button', html: icon('cloudUpload', 15),
              title: `Save ${name} to your Puter files`,
              'aria-label': `Save ${name} to your Puter files`,
              onclick: () => saveAttachment(a),
            }),
          );
        })),
        // The note explains text that came out of an HTML part, which is why
        // it is only there when it did: a message that was written as text and
        // carries HTML alongside it -- which is most mail a person types in a
        // mail client -- was not "sent as HTML" in any sense its reader cares
        // about, and saying so about the text they are reading is wrong. The
        // way into the other view stays either way.
        formatBtn && el(`div.msg-format${written.flattened ? '' : '.msg-format-quiet'}`, {},
          written.flattened && el('span.msg-format-note', {}, 'This message was sent as HTML.'),
          formatBtn),
        bodyPre,
        htmlWrap,
      ]);
      repaintBody();
      // The header shows more once the file has been read: the full date, the
      // sender's address, and who else it went to.
      renderHead();
    };

    const load = () => {
      if (card.disposed) return Promise.resolve(null);
      if (reading) return reading;
      clear(full).append(loadingPlaceholder('body', 'Loading message'));
      reading = (async () => {
        let raw;
        try {
          const blob = await messageReads.read(message.path);
          if (card.disposed) return null;
          raw = new Uint8Array(await blob.arrayBuffer());
          if (card.disposed) return null;
        } catch (e) {
          if (card.disposed) return null;
          // Left null before the button below is built, so the click it is
          // waiting for starts a read rather than handing back this one.
          reading = null;
          clear(full).append(el('div.center', {},
            el('span.center-icon', { html: icon('alert', 28, 1.4) }),
            el('p', {}, `Could not read this message: ${e?.message ?? e}`),
            // Collapsing and expanding again is the other way to try, and it
            // is neither obvious nor open to a message that is on its own --
            // which is the message this happening to matters most for, since
            // a conversation of one that will not read is the whole screen.
            el('button.btn.btn-small', { type: 'button', onclick: () => load() }, 'Try again'),
          ));
          return null;
        }
        build(raw);
        card.onRead();
        return card.data;
      })();
      return reading;
    };

    card.expand = () => {
      if (card.disposed) return Promise.resolve(null);
      card.open = true;
      node.classList.add('is-open');
      full.hidden = false;
      renderHead();
      onToggle();
      return load();
    };

    card.collapse = () => {
      if (card.disposed) return;
      card.open = false;
      node.classList.remove('is-open');
      full.hidden = true;
      renderHead();
      onToggle();
    };

    // The whole line opens and closes the message under the pointer, the way
    // it does in Gmail. The head carries controls of its own -- the name,
    // which is the toggle the keyboard and a screen reader use, the
    // Unsubscribe link, the menu beside the date and whatever that menu opens
    // -- and a press on one of those is not a press on the line: the menu
    // button used to collapse the message it was about, taking the menu with
    // it, and the name would now toggle twice.
    const onControl = (e) => e.target instanceof Element
      && e.target.closest('button, a, [role="menu"]') !== null;
    opener.addEventListener('click', (e) => {
      if (!collapsible() || onControl(e)) return;
      toggle();
    });

    /**
     * The conversation has been redrawn around this message. Nothing about
     * the card changes unless it has gone from being on its own to being one
     * of several, or back: then the head gains or loses its toggle, and the
     * body folds away the quote it carries, or shows it whole again.
     */
    card.rethread = (next) => {
      const was = collapsible();
      card.thread = next;
      if (was === collapsible()) return;
      renderHead();
      repaintBody();
    };

    card.dispose = () => {
      card.disposed = true;
      card.data = null;
      card.onRead = () => {};
      repaintBody = () => {};
      reading = null;
      clear(full);
      node.remove();
    };
    renderHead();
    return card;
  };

  /**
   * What answering one message means: who a reply goes to, the quote it
   * carries, and the thread headers that keep it in the conversation. Built
   * for the newest message into the block at the foot of the reader, and for
   * any open message from its own menu.
   */
  const answersFor = (card) => {
    const { headers, subject, from, date, text, attachments } = card.data;
    const when = formatFullDate(date);

    // What the user may not be replied to as: their own addresses on the
    // sending domains, removed from every reply-all.
    const own = [...ownAddresses];

    // Threading: a reply points at the message it answers and carries the
    // chain it belongs to, which is what makes the conversation hold together
    // in the recipient's client -- and what this app groups its own list by.
    const messageId = parseMessageId(headers);
    const chain = parseReferences(headers);
    const thread = {
      inReplyTo: messageId,
      references: messageId ? [...chain, messageId] : chain,
    };

    const quoted = `\n\n${when ? `On ${when}, ` : ''}`
      + `${from.name || from.email || 'unknown sender'} wrote:\n`
      + text.split('\n').map((line) => `> ${line}`).join('\n');

    const reply = (all) => {
      const { to: recipients, cc } = replyRecipients(headers, own, { all });
      compose({
        kind: all ? 'replyAll' : 'reply',
        to: recipients.join(', '),
        cc: cc.join(', '),
        subject: replySubject(subject),
        body: quoted,
        ...thread,
      });
    };

    const forward = () => compose({
      kind: 'forward',
      to: '',
      subject: forwardSubject(subject),
      body: `\n\n${forwardBlock({
        from: decodeWords(headers.get('from') || '') || from.email,
        date: when,
        subject,
        to: decodeWords(headers.get('to') || ''),
        cc: decodeWords(headers.get('cc') || ''),
      })}\n\n${text}`,
      // The bytes are already decoded here, so the forward carries the
      // original files rather than losing them.
      attachments: attachments.map((attachment) => ({
        filename: attachment.filename,
        type: attachment.type,
        read: async () => attachment.bytes(),
      })),
    });

    // Reply all only earns a place when it would do something Reply does not.
    const alsoCopied = replyRecipients(headers, own, { all: true }).cc.length > 0;

    // `replyAll` is null on a message with nobody else on it, for the same
    // reason the button is absent: reply-all there is reply, and a control
    // that silently does something other than what it says is worse than one
    // that does nothing.
    return {
      reply: () => reply(false),
      replyAll: alsoCopied ? () => reply(true) : null,
      forward,
    };
  };

  /**
   * Reply, Reply all and Forward, on the conversation's newest message --
   * which is the one an answer belongs under, and the one Gmail answers too.
   * The keyboard's `r`, `a` and `f` press the same three.
   */
  const buildReplies = (node, card) => {
    if (!ctx.onCompose || !card?.data) return;
    const answers = answersFor(card);
    replyActions = answers;

    const actionBtn = (label, iconName, onclick) => el('button.btn', { type: 'button', onclick },
      el('span.btn-icon', { html: icon(iconName, 15) }), label);

    clear(node);
    append(node, [
      actionBtn('Reply', 'reply', answers.reply),
      answers.replyAll && actionBtn('Reply all', 'replyAll', answers.replyAll),
      actionBtn('Forward', 'forward', answers.forward),
    ]);
    node.hidden = false;
  };

  /**
   * The whole conversation, wherever its messages are filed: the folder's
   * own, plus the replies sent from here, the original that was archived,
   * the start of it on a page that has not been loaded. What is found is the
   * reader's alone -- archiving an inbox conversation must not move its Sent
   * copies -- so it is kept apart from the folder's unit.
   *
   * The folders are asked through the catalogs the shell already keeps, so a
   * folder is listed once and then answers from memory. Listing them afresh
   * on every open cost a readdir per day folder of the inbox, Sent and
   * Archive together -- hundreds of requests behind one click on a mailbox
   * with a year in it, and the same hundreds again on the next click. A
   * catalog is dropped when its folder changes (`outdate`), so what is
   * answered from memory is never older than the last change made here.
   * Only the messages whose subject could match need their headers read.
   */
  async function conversationMessages(unit, signal) {
    if (!threadable() || !canSend || unit.latest.box === 'trash') return { messages: unit.messages, failed: false };
    const key = normalizeSubject(unit.subject);
    const listings = await Promise.allSettled(['inbox', 'sent', 'archive'].map(async (box) =>
      (await boxes[box].listAll({ signal })).filter((message) => normalizeSubject(message.subject) === key)));
    checkAbort(signal);
    const candidates = listings.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    await readHeads(candidates, { signal });
    checkAbort(signal);
    return { messages: conversationHistory(unit.messages, candidates, ownAddresses),
      failed: listings.some(result => result.status === 'rejected') || candidates.some(message => message.unreadable) };
  }

  /**
   * A reply sent from here has been filed in Sent: put it under the
   * conversation it answers, if that is what is open. Judged against what the
   * reader shows now rather than against the moment the send began, so a
   * conversation that grew in between -- its history arrived, another reply
   * landed -- takes the copy in rather than dropping it.
   */
  async function refreshFiledConversation(path) {
    const unit = opened;
    if (!unit || !threadable()) return;
    const location = locate(ctx.mailPath, path);
    if (!location?.name) return;
    const filed = { ...location, path, subject: subjectFromFilename(location.name) };
    await readHeads([filed]);
    if (opened !== unit) return;
    const messages = conversationHistory(readerMessages, [filed], ownAddresses);
    if (!messages.some((message) => message.path === path)) return;
    await openConversation(unit, { messages, refresh: true, reveal: true });
  }

  /**
   * The subject once, with how many messages are under it. The count is a
   * bare numeral, so read out with the heading it came out as "Thursday
   * walkthrough3"; a label on the heading says what the numeral means -- the
   * same thing the rows say, which name their count too -- and carries the
   * subject with it, so what is heard is still what is on screen. Brought up
   * to date in place when the conversation grows, so a heading that has the
   * keyboard keeps it.
   */
  const syncHeading = (heading, subject, count) => {
    let badge = heading.querySelector('.msg-count');
    if (count > 1) {
      heading.setAttribute('aria-label', `${subject}, ${count} messages`);
      if (!badge) {
        badge = el('span.msg-count', { 'aria-hidden': 'true' });
        heading.append(badge);
      }
      badge.textContent = String(count);
      badge.title = `${count} messages in this conversation`;
    } else {
      heading.removeAttribute('aria-label');
      badge?.remove();
    }
  };

  /**
   * Open a conversation: the subject once, then the messages in it stacked
   * oldest to newest. The newest is open; recent unread messages also open
   * when their complete bytes are already cached. Other messages remain
   * lines to click, so opening a thread does not fetch their attachments.
   *
   * `refresh` is the same conversation growing under its reader: the history
   * behind it has arrived, a reply has just been sent, one has just landed.
   * The cards already on screen are kept exactly as they are -- open or
   * folded, a quote unfolded, the formatted view, the keyboard on whichever
   * control had it -- and only the messages new to the reader get cards, put
   * in their place in the stack. Drawing the whole thing again dropped the
   * keyboard on <body>, folded every quote back, put the plain text back over
   * the formatted view, read every open message's file a second time, and
   * scrolled to the foot of the conversation whatever was being read up top.
   * `reveal` scrolls the newest message into view, for a reply just sent.
   */
  function openConversation(unit, options) {
    readerReady = renderConversation(unit, options);
    return readerReady;
  }

  async function renderConversation(unit, { messages = null, refresh = false, reveal = false, historyResolved = false } = {}) {
    if (searching()) {
      const at = results.indexOf(unit.latest);
      if (at >= 0 && Math.floor(at / RESULT_PAGE_SIZE) * RESULT_PAGE_SIZE !== resultOffset) {
        resultOffset = Math.floor(at / RESULT_PAGE_SIZE) * RESULT_PAGE_SIZE;
        renderResults({ force: true });
      }
    }
    const revision = ++readerRevision;
    historyController?.abort();
    historyController = new AbortController();
    const { signal } = historyController;
    // Install the rejection handler immediately: body loading may outlast a
    // cancelled history request, which must never become an unhandled error.
    const historyPending = historyResolved ? null : conversationMessages(unit, signal)
      .catch(error => ({ messages: unit.messages, failed: true, error }));
    messages ??= unit.messages;
    // The cards already on screen for this conversation, by file.
    const kept = refresh && opened === unit && stackEl?.isConnected
      ? new Map([...new Set([...cards, latestCard])].filter(Boolean).map((card) => [card.message.path, card]))
      : null;
    if (opened?.row && opened !== unit) opened.row.setAttribute('aria-selected', String(selected.has(opened)));
    opened = unit;
    unit.row?.setAttribute('aria-selected', 'true');
    frame.classList.add('reading');
    if (!kept) {
      releaseCards();
      showingSource = false;
      sourceBtn.setAttribute('aria-pressed', 'false');
      showReaderTools(false);
    }
    renderMsgActions(unit);
    syncReaderNav();
    replyActions = null;
    // Oldest first, whatever order they were handed over in: what was found
    // in other folders is given after what was already on screen.
    const history = makeThread(messages);
    messages = history.messages;
    const lastPage = Math.floor(Math.max(0, messages.length - 1) / THREAD_PAGE_SIZE) * THREAD_PAGE_SIZE;
    const atLatest = readerStart + THREAD_PAGE_SIZE >= readerMessages.length;
    const anchor = cards[0]?.message.path;
    const anchored = anchor ? messages.findIndex(message => message.path === anchor) : -1;
    readerStart = !kept || reveal || (atLatest && !stackEl?.contains(document.activeElement))
      ? lastPage : Math.max(0, anchored);
    readerMessages = messages;

    // Preserve whole-conversation read state, including folded cards and
    // history found outside this folder. Otherwise loading another page can
    // make a conversation just opened here appear unread again.
    const unread = history.messages.filter((message) => isUnread(message));
    if (unread.length) {
      for (const message of unread) readState.markRead(message.name);
      updateRow(unit);
      updateMeta();
      // updateMeta() ends at the meta line during a search -- a search's line
      // is about the results, not the folder -- so what was just read has to
      // be counted out of the inbox badge and the tab title here, or a result
      // opened from a search left both saying it was still unread.
      updateNavCounts();
    }

    const subject = unitSubject(unit) || '(no subject)';
    if (kept) {
      // Reply, Reply all and Forward answer the newest message, which may
      // not be the one they were built for.
      clear(replyBlockEl);
      replyBlockEl.hidden = true;
    } else {
      headingEl = el('h2.msg-subject', { tabindex: -1 }, subject);
      stackEl = el('div.msg-thread');
      threadPagesEl = el('nav.thread-pages', { 'aria-label': 'Conversation messages', hidden: true });
      replyBlockEl = el('div.msg-reply', { hidden: true });
      clear(msgScroll).append(el('article.message', {}, headingEl, threadPagesEl, stackEl, replyBlockEl));
    }
    syncHeading(headingEl, subject, history.count);
    stackEl.setAttribute('aria-busy', String(Boolean(historyPending)));

    /**
     * Reply, Reply all and Forward answer the newest message, so they cannot
     * be built until it has been read. A message that failed and was tried
     * again is one the reply block may still be waiting on, which is why the
     * cards say when they have read rather than only being waited on once.
     */
    const replyBlock = replyBlockEl;
    const readyReplies = () => {
      if (opened !== unit || revision !== readerRevision || replyBlock.firstChild) return;
      buildReplies(replyBlock, latestCard);
    };

    latestCard = kept?.get(history.latest.path) ?? messageCard(history.latest, history, readyReplies, syncFold);
    const renderPage = (start, { focus = false, available = null } = {}) => {
      if (opened !== unit || revision !== readerRevision) return;
      const previous = available ?? new Map([...new Set([...cards, latestCard])].map(card => [card.message.path, card]));
      readerStart = Math.max(0, Math.min(start, lastPage));
      cards = messages.slice(readerStart, readerStart + THREAD_PAGE_SIZE).map(message =>
        previous.get(message.path) ?? (message === history.latest ? latestCard : messageCard(message, history, readyReplies, syncFold)));
      const retained = new Set([...cards, latestCard]);
      for (const card of previous.values()) if (!retained.has(card)) card.dispose();
      for (const card of retained) {
        card.onRead = readyReplies;
        card.rethread(history);
      }
      // Move retained nodes in place so a history refresh preserves keyboard,
      // quotes and formatting on the page being read.
      const nodes = cards.map(card => card.node);
      const wanted = new Set(nodes);
      for (const node of [...stackEl.children]) if (!wanted.has(node)) node.remove();
      nodes.forEach((node, i) => {
        if (stackEl.children[i] !== node) stackEl.insertBefore(node, stackEl.children[i] ?? null);
      });
      clear(threadPagesEl);
      threadPagesEl.hidden = messages.length <= THREAD_PAGE_SIZE;
      if (!threadPagesEl.hidden) {
        const button = (label, text, at, disabled) => el('button.btn.btn-small', {
          type: 'button', 'aria-label': label, disabled,
          onclick: () => renderPage(at, { focus: true }),
        }, text);
        threadPagesEl.append(
          button('First messages in conversation', 'First', 0, readerStart === 0),
          button('Older messages in conversation', 'Older', readerStart - THREAD_PAGE_SIZE, readerStart === 0),
          el('span.thread-page-status', { role: 'status' },
            `Messages ${readerStart + 1}–${readerStart + cards.length} of ${messages.length}`),
          button('Newer messages in conversation', 'Newer', readerStart + THREAD_PAGE_SIZE,
            readerStart + cards.length >= messages.length),
          button('Latest messages in conversation', 'Latest', lastPage,
            readerStart + cards.length >= messages.length),
        );
      }
      syncFold();
      if (focus) {
        for (const card of cards) if (card.data) card.paint();
        msgScroll.scrollTop = 0;
        cards[0]?.node.querySelector('.msg-expander')?.focus({ preventScroll: true });
      }
    };
    renderPage(readerStart, { available: kept ?? new Map([[history.latest.path, latestCard]]) });

    // Short messages often arrived in their entirety with the header read.
    // Expand those unread messages for free, but do not fetch other bodies
    // (and embedded attachments) until the reader explicitly opens them.
    const cachedUnread = unread.filter(message => messageReads.hasComplete(message.path)).slice(-5);
    const openNow = new Set([history.latest, ...cachedUnread]);
    const reads = [...new Set([...cards, latestCard])]
      .filter((card) => !kept?.has(card.message.path) && openNow.has(card.message))
      .map((card) => card.expand());

    if (!kept) {
      msgScroll.scrollTop = 0;
      if (!refresh) headingEl.focus({ preventScroll: true });
    }

    await Promise.all(reads);
    if (opened !== unit || revision !== readerRevision) return; // another reader request won
    if (reveal) cards[cards.length - 1]?.node.scrollIntoView?.({ block: 'nearest' });
    showReaderTools(true);
    readyReplies();
    if (historyPending) {
      const complete = await historyPending;
      if (signal.aborted || opened !== unit || revision !== readerRevision) return;
      stackEl.setAttribute('aria-busy', 'false');
      // What the reader shows may have grown while the folders were being
      // asked -- a reply sent, one delivered -- so what was found is added to
      // that rather than put in its place.
      const shown = new Set(readerMessages.map(message => message.path));
      const found = complete.messages.filter((message) => !shown.has(message.path));
      if (found.length) {
        await openConversation(unit, {
          messages: [...readerMessages, ...found], refresh: true, historyResolved: true,
        });
      }
      if (complete.failed && opened === unit) {
        headingEl.after(el('div.history-status', { role: 'status' },
          'Some conversation history could not be read. ',
          el('button.btn.btn-small', { type: 'button', onclick: () => openConversation(unit) }, 'Retry history')));
      }
    }
  }

  sourceBtn.onclick = () => {
    showingSource = !showingSource;
    sourceBtn.setAttribute('aria-pressed', String(showingSource));
    for (const card of cards) card.paint();
  };

  searchInput.addEventListener('search', () => {
    // The native clear button fires this; the query has to follow the field.
    clearTimeout(searchTimer);
    runSearch(searchInput.value);
  });

  searchInput.addEventListener('keydown', (e) => {
    // Escape empties the field. Chrome and Safari do that themselves for a
    // type=search input; Firefox draws no clear button and does nothing on
    // Escape, so a search there could only be undone by selecting the text
    // and deleting it. Doing it here makes the behaviour the same everywhere,
    // and there is nothing left for the browser to clear afterwards.
    if (e.key !== 'Escape' || !searchInput.value) return;
    e.preventDefault();
    searchInput.value = '';
    clearTimeout(searchTimer);
    runSearch('');
  });

  // -- the keyboard, outside the list -----------------------------------------------

  /**
   * The list has answered its own keys since there were rows to press them on,
   * but only ever while focus was inside it -- so Compose had no key at all,
   * and Archive had one that stopped working the moment a message was opened.
   * These are the same shortcuts, asked of the whole app.
   *
   * Bound to the document rather than to the frame, because most of the time
   * there is nothing in the app holding the keyboard at all: closing a message
   * leaves focus on the body, and a listener on the frame never hears a key
   * pressed there. What the frame would have given for free -- not firing
   * under a dialog -- is asked for instead.
   *
   * `?` prints the whole list (shortcuts.js), because five shortcuts that
   * nothing mentions are five shortcuts nobody uses.
   */

  // Where a keypress is a character being typed rather than a command.
  // A tick box or a button takes no characters, and treating it as a field
  // left every shortcut dead from the moment a row's tick box was clicked.
  const NOT_TYPED = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'color', 'range', 'file']);
  const typingIn = (target) => target instanceof HTMLElement
    && (target.isContentEditable
      || (target.tagName === 'INPUT' && !NOT_TYPED.has(target.type))
      || target.tagName === 'TEXTAREA'
      || target.tagName === 'SELECT');

  /**
   * Whether something in front of the app is holding the keyboard. Every
   * dialog in this app is an `openModal`, and every dropdown an `attachMenu`,
   * so both are one query each -- and both answer their own keys, which is
   * the point: `e` in an open menu is arrowing to Explore, not archiving the
   * message behind it.
   */
  const overlayOpen = () =>
    Boolean(document.querySelector('.modal-root:not([hidden]), .menu[role="menu"]'));

  // The `g` of a `g i`, and what forgets it. Long enough to be a chord typed
  // by a person; short enough that a `g` pressed by mistake is not still
  // waiting to swallow a key half a minute later.
  const CHORD_MS = 1500;
  let chording = false;
  let chordTimer = 0;
  const endChord = () => {
    clearTimeout(chordTimer);
    chording = false;
  };

  const onShortcut = (e) => {
    // Signing out renders the gate over the same root, and this listener is
    // on the document rather than on anything that render replaced -- so the
    // one left behind has to stand down, the way the poll's listeners below
    // do.
    if (!frame.isConnected) return;
    // A bare keypress, like the list's own. Shift is not a modifier here:
    // `?` and `#` are typed with it.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // A key that only changes what the next key types is not a key of its
    // own. Shift arrives as a keydown before the `#` it shifts, and ended a
    // `g` chord before it: `g #` deleted the open conversation instead of
    // going to Trash.
    if (e.key === 'Shift' || e.key === 'CapsLock' || e.key === 'AltGraph') return;
    if (typingIn(e.target) || overlayOpen()) return;

    // Mid-chord, the key means a folder and nothing else -- including when it
    // names no folder, which ends the chord rather than falling through to
    // whatever that key does on its own.
    if (chording) {
      endChord();
      const to = VIEWS.find((v) => FOLDER_KEYS[v.id] === e.key);
      if (!to) return;
      e.preventDefault();
      setFolder(to.id);
      return;
    }

    const reading = frame.classList.contains('reading');

    switch (e.key) {
      case 'Escape':
        // The way back: out of the drawer, then out of the open message.
        // Answered here, on the document, rather than on the frame, because
        // a click on the text of a message -- to select a line of it, or on
        // nothing in particular -- leaves the keyboard on the body, and a
        // listener on the frame never heard a key pressed there: Escape
        // closed the message only while a control inside it happened to
        // have focus. The search field answers its own Escape, and is a
        // field being typed in, so it never reaches this.
        if (frame.classList.contains('nav-open')) {
          setNavOpen(false);
          return;
        }
        if (reading) closeReader();
        return;
      case 'g':
        e.preventDefault();
        chording = true;
        chordTimer = setTimeout(endChord, CHORD_MS);
        return;
      case '/':
        e.preventDefault();
        // The open drawer makes the top bar inert, and focusing an inert
        // field does nothing at all.
        if (frame.classList.contains('nav-open')) setNavOpen(false);
        searchInput.focus();
        searchInput.select();
        return;
      case '?':
        e.preventDefault();
        openShortcuts({ folders: VIEWS, canCompose: Boolean(ctx.onCompose) });
        return;
      case 'c':
        if (!ctx.onCompose) return;
        e.preventDefault();
        // As the Compose pill does: left open, the drawer was still covering
        // the list when the message was sent.
        if (frame.classList.contains('nav-open')) setNavOpen(false);
        compose();
        return;
      case 'j':
      case 'k': {
        // With a message open, the same keys read on to the next or the
        // previous conversation -- what they do in Gmail's reader, and what
        // lets a folder be read through without going back to the list.
        // Moving the keyboard through rows covered by the reader, which is
        // the whole screen on a phone, would put focus where nobody can see.
        if (reading) {
          if (opened && step(e.key === 'j' ? 1 : -1)) e.preventDefault();
          return;
        }
        const current = focusedRowIndex();
        e.preventDefault();
        focusRow(current < 0 ? 0 : current + (e.key === 'j' ? 1 : -1));
        return;
      }
      default:
        break;
    }

    // Everything below acts on the open conversation. While the list has
    // focus these same keys are the list's, and answering them here as well
    // would act on the message twice.
    if (!opened || !reading || listEl.contains(e.target)) return;
    // The open conversation and nothing else -- which is what the message
    // toolbar's own buttons act on. A row's key reaches for the selection
    // instead, because a ticked list is what a row is about; a message that is
    // open on screen is not, and archiving six other things because they are
    // still ticked behind the reader is not what `e` looked like it would do.
    const unit = opened;
    const here = [unit];

    switch (e.key) {
      case 'r':
        if (!replyActions) return;
        e.preventDefault();
        replyActions.reply();
        return;
      case 'a':
        if (!replyActions?.replyAll) return;
        e.preventDefault();
        replyActions.replyAll();
        return;
      case 'f':
        if (!replyActions) return;
        e.preventDefault();
        replyActions.forward();
        return;
      case 's':
        e.preventDefault();
        toggleStar(unit);
        return;
      case 'u':
      case 'U':
        e.preventDefault();
        setRead(here, unitUnread(unit));
        return;
      case 'e':
        if (!ACTIONS_BY_VIEW[folder]?.includes('archive')) return;
        e.preventDefault();
        runAction('archive', here);
        return;
      case '#':
      case 'Delete':
      case 'Backspace':
        if (!ACTIONS_BY_VIEW[folder]?.includes('trash')) return;
        e.preventDefault();
        runAction('trash', here);
        return;
      default:
    }
  };

  document.addEventListener('keydown', onShortcut, listening);

  // -- loading ---------------------------------------------------------------------

  /** Lists the current folder. Resolves to whether it was actually listed. */
  let folderLoadRevision = 0;
  const loadFolder = async () => {
    const box = mailbox();
    const revision = ++folderLoadRevision;
    const active = () => box === mailbox() && revision === folderLoadRevision && frame.isConnected;
    try {
      await box.open();
    } catch (e) {
      if (!active()) return false;
      clear(listEl).append(el('div.center', {},
        el('span.center-icon', { html: icon('alert', 28, 1.4) }),
        el('p', {}, `Could not load this folder: ${e?.message ?? e}`),
      ));
      return false;
    }
    // Another folder may have been opened while this listing was read; its
    // own load is the one that should paint.
    if (!active()) return false;
    // Conversations cannot be drawn before it is known which messages are in
    // them, so this is the one read the list waits for. It is the same head
    // read every row was going to cost anyway, and the index keeps it.
    if (threadable()) await readHeads(box.messages, { active });
    if (!active()) return false;
    // A folder that could not be read at all is listed again when next opened.
    if (!box.listError || box.messages.length) listed.add(box.box);
    // A listing that could not be read leaves the previous one in place, so
    // there is still something to render; the caller reports the failure.
    // Both paths carry the selection across the rebuild themselves: a
    // re-listing builds a new entry per file, so anything ticked would
    // otherwise be an object the folder no longer holds -- and the action bar
    // went on offering to act on messages whose rows had been replaced under
    // it.
    if (searching()) runSearch(searchInput.value, { relist: true });
    else renderList();
    return !box.listError;
  };

  // -- new mail ---------------------------------------------------------------

  const notifyWanted = () => {
    try {
      return storage.getItem(NOTIFY_LS_KEY) === '1'
        && window.Notification?.permission === 'granted';
    } catch {
      return false;
    }
  };

  const setNotify = async (on) => {
    const remember = (value) => {
      try {
        storage.setItem(NOTIFY_LS_KEY, value);
      } catch {}
    };
    if (!on) {
      remember('0');
      toast('New mail notifications are off.', { iconName: 'bell' });
      return;
    }
    if (!window.Notification) {
      toast('This browser cannot show notifications.', { iconName: 'alert' });
      return;
    }
    let permission = Notification.permission;
    // Only a user gesture may ask, which is why this lives in a menu.
    if (permission === 'default') permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      remember('0');
      toast('Notifications are blocked for this site.', { iconName: 'alert' });
      return;
    }
    remember('1');
    toast('You will be notified when mail arrives.', { iconName: 'bell' });
  };

  const notifyNewMail = async (added) => {
    // A notification while the user is looking at the app would tell them
    // something they can already see.
    if (!notifyWanted() || document.hasFocus()) return;
    let body = `${added.length} new messages`;
    if (added.length === 1) {
      const [message] = added;
      // One extra 8 KB head read buys the sender's name; a bare subject in a
      // notification is not much use.
      if (!message.from) Object.assign(message, await enrichMessage(messageReads, message));
      repaint(message);
      body = `${message.from?.name || 'Unknown sender'} — ${message.subject || '(no subject)'}`;
    }
    try {
      const note = new Notification(`${BASE_TITLE}: new mail`, {
        body,
        // One replaceable notification rather than a pile of them.
        tag: 'puter-mail-new',
        icon: './icon-192.png',
      });
      // The click is the reader asking to see it. One message opens; a
      // handful of them goes to the top of the inbox, which is where they
      // are. Either way a search that was on screen is cleared first, since
      // what arrived is in the folder and not necessarily in the results.
      note.onclick = () => {
        window.focus();
        note.close();
        if (!frame.isConnected) return;
        if (searching()) {
          searchInput.value = '';
          clearTimeout(searchTimer);
          runSearch('');
        }
        if (folder !== 'inbox') setFolder('inbox');
        clearNewMail();
        const one = added.length === 1
          ? units.find((unit) => unit.messages.includes(added[0]))
          : null;
        if (one) {
          openConversation(one);
          return;
        }
        if (frame.classList.contains('reading')) closeReader({ focusRow: false });
        listEl.scrollTop = 0;
        visibleRows()[0]?.focus();
      };
    } catch {
      // Some browsers only allow notifications from a service worker.
    }
  };

  const clearNewMail = () => {
    pendingNew = 0;
    newMailPill.hidden = true;
    newMailPill.textContent = '';
  };

  const showNewMail = (count) => {
    pendingNew += count;
    newMailPill.hidden = false;
    newMailPill.textContent = pendingNew === 1 ? '1 new message' : `${pendingNew} new messages`;
  };

  /**
   * Prepend whatever has arrived, joining it to the conversation it answers
   * where there is one. The rows already on screen stay where they are --
   * scroll anchoring keeps what the reader is looking at in place -- so a
   * conversation that has grown moves to the top rather than the list being
   * rebuilt around it.
   */
  const joinConversations = (added) => {
    // How many went straight under the reader: on screen already, opened and
    // read, so not news the pill has to break.
    let shown = 0;
    // Oldest first, so each one lands above the one before it.
    for (const message of [...added].reverse()) {
      // The same rule the whole folder is grouped by, asked one conversation
      // at a time. The subject is the cheap half of it, so a conversation that
      // cannot match is never grouped against.
      const key = normalizeSubject(message.subject ?? '');
      const found = threadable() && units.find((unit) => unit.key === key
        && groupThreads([message, ...unit.messages]).length === 1);
      if (found) {
        units.splice(units.indexOf(found), 1);
        Object.assign(found, makeThread([...found.messages, message]));
        track(found);
        units.unshift(found);
        updateRow(found);
        optionsEl.prepend(found.row ?? buildRow(found));
        // The conversation it answers is open: the reply goes under what is
        // being read, opened, the way one landing does in Gmail. The row
        // said four messages and the reader three until it was closed and
        // opened again, with a pill announcing mail that was already there.
        if (opened === found) {
          openConversation(found, {
            messages: [...readerMessages, message], refresh: true,
          });
          shown++;
        }
        continue;
      }
      const unit = track(singleThread(message));
      units.unshift(unit);
      optionsEl.prepend(buildRow(unit));
    }
    applyFilter();
    return shown;
  };

  /** Show whatever has arrived, without disturbing the reader or the list. */
  const receive = async (added) => {
    // Grouping needs a message id per message, and mail that has just arrived
    // has never been read. A handful of heads, so nothing waits long on it.
    if (threading) await readHeads(added);
    if (!frame.isConnected) return;
    // What went straight under the reader -- a reply to the conversation
    // being read -- is on screen already, opened and marked read. The pill
    // announced it as new all the same, and the user closed the reader to
    // find it counting the message they had just finished reading.
    let shown = 0;
    if (view().box === 'inbox') {
      if (searching()) {
        // A search is on screen, not the folder: new mail joins the results
        // only if it matches -- and it has to be read before it can. The
        // folder was indexed before this message existed, so without this the
        // "searching 11 of 12" line never finished and the message matched
        // nothing but its own subject.
        if (needsIndex(query)) indexMore(added);
        renderResults();
      } else if (optionsEl.isConnected) {
        shown = joinConversations(added);
      } else {
        renderList(); // the folder was showing its empty panel
      }
    }
    updateNavCounts();
    // Mail arriving under an open message, or above where the user has
    // scrolled to, needs saying out loud rather than silently inserting.
    const unseen = added.length - shown;
    if (unseen && (frame.classList.contains('reading') || view().box !== 'inbox' || listEl.scrollTop > 8)) {
      showNewMail(unseen);
    }
    notifyNewMail(added);
  };

  // -- watching the mailbox ---------------------------------------------------------

  let pendingNew = 0;
  let syncing = false;
  let syncAgain = false;

  /**
   * List what has arrived in the inbox and show it. A check that finds nothing
   * says nothing: no toast, no re-render, no scroll movement, no cleared
   * search. The only visible effect of an uneventful check is that nothing
   * happens.
   *
   * Serialised: a call made while one is running is folded into one more pass
   * after it, so a run of events costs at most two listings, and two checks
   * never race each other into listing the same message twice.
   */
  const syncInbox = async () => {
    if (ctx.sample || !frame.isConnected) return;
    if (syncing) {
      syncAgain = true;
      return;
    }
    // The inbox on screen has never been read: its first listing failed. A
    // check now is the next try at reading it, and what it finds is the
    // folder, not new mail -- listed the way opening it would. Elsewhere the
    // mailbox lists it again quietly itself, and an inbox that was read once
    // and failed a check since is checked as usual.
    if (boxes.inbox.unread && view().box === 'inbox' && !searching()) {
      loadFolder();
      return;
    }
    syncing = true;
    try {
      do {
        syncAgain = false;
        const unread = boxes.inbox.unread;
        const added = await boxes.inbox.sync();
        if (added.length && frame.isConnected) await receive(added);
        // Read for the first time, quietly: its count is news to the folders.
        else if (unread && !boxes.inbox.unread) updateNavCounts();
      } while (syncAgain && frame.isConnected);
    } catch {
      // A failed check is not worth reporting; the next one may succeed, and
      // the rows on screen are still the ones that were listed.
    } finally {
      syncing = false;
    }
  };

  /**
   * Paths this shell has just written, so the events they cause are not taken
   * for another device's. An event says nothing about who made a change
   * beyond the account, and this account's other tabs and devices are exactly
   * what the watch is listening for. A mark is spent by the first event that
   * answers it, so what another device does to the same file next -- restore
   * what was archived here a moment ago -- is heard; ten seconds is how long
   * an unanswered one is kept, long past the settle and any coalescing on the
   * server.
   */
  const OWN_WRITE_MS = 10_000;
  const ownWrites = new Map();
  const own = (...paths) => {
    const now = Date.now();
    // Kept in the order they were marked, so the expired marks are the ones
    // at the front: a bulk move marking thousands of paths no longer walks
    // every live mark again for each one.
    for (const [path, at] of ownWrites) {
      if (now - at <= OWN_WRITE_MS) break;
      ownWrites.delete(path);
    }
    for (const path of paths) {
      if (!path) continue;
      ownWrites.delete(path);
      ownWrites.set(path, now);
    }
  };
  const heardOwn = (path) => {
    const at = ownWrites.get(path);
    if (at === undefined) return false;
    ownWrites.delete(path);
    return Date.now() - at <= OWN_WRITE_MS;
  };

  const nameOf = (path) => path.slice(path.lastIndexOf('/') + 1);
  /** Whether a folder's listing holds the message at this path. */
  const holds = (box, path) => Boolean(boxes[box]?.find?.(nameOf(path)));

  /**
   * Take messages another hand moved or deleted out of the folder they were
   * listed in, the way an action here would have: the row goes, or the
   * conversation loses the message, and nothing is re-listed. Returns whether
   * any of them were held at all.
   */
  const dropMessages = (box, paths) => {
    const gone = paths.map((path) => boxes[box].find(nameOf(path))).filter(Boolean);
    // Unloaded messages may already be buffered from a partially shown day.
    // A departure there must invalidate that buffer too.
    if (gone.length < paths.length) boxes[box].forget();
    if (!gone.length) return false;
    for (const message of gone) boxes[box].remove(message);
    if (view().box === box) {
      for (const unit of units.filter((unit) => unit.messages.some((m) => gone.includes(m)))) {
        shrink(unit, unit.messages.filter((m) => gone.includes(m)));
      }
      renderAfterChange();
    } else {
      updateNavCounts();
    }
    return true;
  };

  /**
   * Act on what a run of events said. Mail delivered to the inbox is the
   * common case and the cheap one: sync() lists exactly what landed above the
   * newest message held, the rows already on screen stay where they are, and
   * what landed is announced. Everything else is what a manual refresh used
   * to be for -- a message filed, restored or deleted from another device --
   * and is patched in place where it can be, re-listed where it cannot, and
   * never announced: mail put back where it was is not new.
   */
  const applyPlan = (plan) => {
    if (plan.gap) messageReads.forget();
    for (const box of plan.disturbed) messageReads.forget(boxPath(ctx.mailPath, box));
    for (const [, paths] of [...plan.arrived, ...plan.filed, ...plan.left]) {
      for (const path of paths) messageReads.forget(path);
    }
    if (plan.gap) {
      // Something happened that the events did not say. Every folder is
      // re-read: the one on screen now, the others when next opened.
      for (const box of Object.keys(boxes)) if (box !== 'drafts') invalidate(box);
      return;
    }
    // What this shell did not do and does not already show.
    const fresh = (box, paths) => [...paths].filter((path) => !heardOwn(path) && !holds(box, path));
    // Whether a message at this path would be among the days the inbox has
    // listed. Below them it needs nothing: "Load older messages" lists those
    // days fresh when it reaches them.
    const withinListed = (path) => {
      const oldest = boxes.inbox.messages.at(-1)?.day ?? '';
      return (locate(ctx.mailPath, path)?.day ?? '') >= oldest;
    };

    for (const [box, paths] of plan.left) dropMessages(box, [...paths].filter((path) => !heardOwn(path)));
    for (const box of plan.disturbed) invalidate(box);

    for (const [box, paths] of [...plan.arrived, ...plan.filed]) {
      if (plan.disturbed.has(box)) continue;
      const unknown = fresh(box, paths);
      if (!unknown.length) continue;
      if (box !== 'inbox') {
        invalidate(box);
        continue;
      }
      if (plan.filed.get(box) === paths) {
        // Restored into the inbox from another device. It sorts wherever its
        // day puts it, so the listing is read again rather than patched.
        if (unknown.some(withinListed)) invalidate('inbox');
        continue;
      }
      syncInbox().then(() => {
        // Mail lands above everything held, and sync() lists exactly that.
        // A file written into an older day did not, and only a re-listing
        // finds it.
        const missed = unknown.some((path) => !holds('inbox', path) && withinListed(path));
        if (missed && frame.isConnected) invalidate('inbox');
      });
    }
  };

  const watch = { sub: null, starting: null, live: false, queue: [], timer: null };

  const applyEvents = () => {
    watch.timer = null;
    const batch = watch.queue.splice(0);
    if (!frame.isConnected) {
      stopWatching();
      return;
    }
    applyPlan(planChanges(ctx.mailPath, batch));
  };

  /**
   * One event per file that changed, gathered for a moment before anything is
   * done about them: a dozen messages delivered together are then one listing
   * rather than twelve, and a write this shell made has answered by the time
   * the event it caused is looked at, so it is recognised as the shell's own.
   */
  const onMailEvent = ({ event } = {}) => {
    if (!frame.isConnected) {
      stopWatching();
      return;
    }
    watch.queue.push(event);
    clearTimeout(watch.timer);
    watch.timer = setTimeout(applyEvents, WATCH_SETTLE_MS);
  };

  const stopWatching = () => {
    clearTimeout(watch.timer);
    watch.timer = null;
    watch.queue.length = 0;
    watch.live = false;
    const { sub } = watch;
    watch.sub = null;
    try {
      Promise.resolve(sub?.off?.()).catch(() => {});
    } catch {
      // Nothing is listening for the answer.
    }
  };

  let pollTimer = null;

  const canPoll = () => !ctx.sample && frame.isConnected && !watch.live
    && !document.hidden && navigator.onLine !== false;

  const stopPolling = () => {
    clearTimeout(pollTimer);
    pollTimer = null;
  };

  const schedulePoll = () => {
    stopPolling();
    if (!canPoll()) return;
    pollTimer = setTimeout(poll, POLL_MS);
  };

  /**
   * Subscribe to changes under `.mail`. One subscription covers every folder,
   * and it costs nothing while nothing changes. Where it cannot be had -- a
   * Puter without the Events API, a server with it turned off, a lapse the
   * SDK could not reconnect from -- the shell falls back to the timed check,
   * and asks for the subscription again at the moments a connection tends to
   * come back. Every path out of here that does not end with the watch
   * standing leaves the timer running.
   */
  const startWatching = () => {
    if (ctx.sample || !frame.isConnected || watch.live || watch.starting) return watch.starting;
    if (!ctx.events?.onLocal) {
      schedulePoll();
      return null;
    }
    let sub = null;
    watch.starting = (async () => {
      try {
        sub = await ctx.events.onLocal(mailSubject(ctx.mailPath), onMailEvent, {
          // The subscription is over and the SDK could not make it again.
          // Until this shell can, mail is looked for the old way.
          onError: () => {
            if (watch.sub !== sub) return;
            watch.sub = null;
            watch.live = false;
            schedulePoll();
          },
        });
        if (!frame.isConnected) {
          Promise.resolve(sub.off?.()).catch(() => {});
          return;
        }
        watch.sub = sub;
        watch.live = true;
        stopPolling();
        // Mail that landed between the listing and the subscription standing
        // was heard by neither.
        syncInbox();
      } catch {
        schedulePoll();
      } finally {
        watch.starting = null;
      }
    })();
    return watch.starting;
  };

  /**
   * The fallback: a visible tab looks for new mail on a timer. Every tick is
   * also another try for the subscription, which stops the timer if it gets
   * one and keeps it running if it does not.
   */
  const poll = async () => {
    if (!canPoll()) {
      schedulePoll();
      return;
    }
    await startWatching();
    if (!watch.live) await syncInbox();
  };

  // Stop background consumers when sign-out or navigation replaces the shell.
  new MutationObserver((records, observer) => {
    if (frame.isConnected) return;
    observer.disconnect();
    originState.flush();
    shellListeners.abort();
    searchController?.abort();
    historyController?.abort();
    indexQueue.length = 0;
    enrichQueue.length = 0;
    for (const box of Object.values(boxes)) box.cancelLoad?.();
    releaseCards();
    messageReads.forget();
  }).observe(root, { childList: true });

  if (!ctx.sample) {
    // The subscription is the shell's, and the shell can be replaced:
    // signing out renders the gate over the same root. The one left behind
    // ends its subscription, or the socket would stay open for a handler
    // with nothing to show events to.
    new MutationObserver((records, observer) => {
      if (frame.isConnected) return;
      observer.disconnect();
      stopWatching();
      stopPolling();
    }).observe(root, { childList: true });

    // A tab coming back is when the answer matters most -- and the moment a
    // connection that slept with the laptop is back. One check covers what a
    // dropped connection may have missed, and the subscription is made again
    // if it had lapsed. A hidden tab stops the fallback timer; the watch
    // costs nothing to leave standing.
    document.addEventListener('visibilitychange', () => {
      if (!frame.isConnected) return;
      if (document.hidden) {
        stopPolling();
        // A tab put away may not come back, and what it has read is worth
        // keeping.
        searchIndex.flush();
        originState.flush();
        return;
      }
      startWatching();
      syncInbox();
      pullFlags();
    }, listening);
    window.addEventListener('online', () => {
      if (!frame.isConnected) return;
      startWatching();
      syncInbox();
    }, listening);
    // Offline, every check is a failure waiting to happen.
    window.addEventListener('offline', stopPolling, listening);
    listEl.addEventListener('scroll', () => {
      if (pendingNew && listEl.scrollTop <= 8 && !frame.classList.contains('reading')) clearNewMail();
    }, { passive: true });
  }

  const refresh = async () => {
    messageReads.forget();
    // A refresh keeps the current rows on screen rather than flashing an
    // empty card, so the only place it can report progress is the control
    // that started it.
    for (const btn of [refreshBtn, listRefreshBtn]) {
      btn.disabled = true;
      btn.classList.add('is-busy');
      btn.setAttribute('aria-busy', 'true');
    }
    closeReader({ focusRow: false });
    clearNewMail();
    pullFlags(true);
    const box = mailbox();
    // Captured with the mailbox: the folder can change while the listing is
    // read, and the toast is about the folder that was refreshed.
    const label = view().label;
    const ok = await loadFolder();
    for (const btn of [refreshBtn, listRefreshBtn]) {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      btn.setAttribute('aria-busy', 'false');
    }
    // Confirming a refresh that did not happen is worse than saying nothing:
    // the rows on screen would be the ones from before. A mailbox whose
    // objects folder has not been created yet -- a new account -- is not a
    // failure, and lists as empty.
    toast(
      ok ? `${label} refreshed.`
        : box.messages.length ? 'Could not refresh. Showing the last messages loaded.'
          : `Could not load ${label}.`,
      { iconName: ok ? 'refresh' : 'alert' },
    );
  };
  refreshBtn.addEventListener('click', () => {
    if (mobile()) setNavOpen(false);
    refresh();
  });
  listRefreshBtn.addEventListener('click', refresh);

  setFolder('inbox');
  startWatching();
  pullFlags(true);
  return {
    mailWrite,
    async refreshInbox() {
      searchInput.value = '';
      clearTimeout(searchTimer);
      runSearch('');
      setFolder('inbox');
      await refresh();
    },
  };
}

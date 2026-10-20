/**
 * Mailbox access over the layout written by the `emailrx` backend extension:
 *
 *   /<username>/.mail/objects/<YYYY-MM-DD>/<uuidv7>--<base64url subject>
 *
 * Each file is the raw RFC 822 message. uuid v7 sorts chronologically as
 * text, and so do the date folders, so "newest first" needs no metadata
 * lookups. The fs argument only needs readdir/read/stat, so the same code
 * runs against puter.fs and the in-memory sample mailbox.
 */

import {
  splitMessage, parseHeaders, parseContentType, parseAddress, parseAddressList,
  decodeWords, subjectFromFilename, previewText, paramValue,
} from './mime.js';
import { bytesToBase64 } from './compose.js';
import { cleanSnippet } from './format.js';
import { parseMessageId, parseReferences, splitQuotedTail } from './thread.js';
import { checkAbort, sharedTask, yieldTask } from './work.js';

export const MAIL_DIR = '.mail';
export const SENT_DIR = 'sent';

/**
 * Where each folder lives under `.mail`. `objects/` is written by emailrx;
 * the other three are this app's, and nothing on the backend touches them, so
 * moving a file out of `objects/` is safe -- nothing recreates or reconciles
 * it.
 */
export const BOX_DIRS = {
  inbox: 'objects',
  sent: SENT_DIR,
  archive: 'archive',
  trash: 'trash',
};

export const boxPath = (mailPath, box) => `${mailPath}/${BOX_DIRS[box]}`;
export const PAGE_SIZE = 60;      // messages to pull per "load older" batch
export const HEADER_BYTES = 8192; // enough for the header block of a normal message
/**
 * How much further to read when the header block runs past the first read.
 * Mail relayed through a few hops arrives behind a dozen Received, DKIM,
 * ARC and Authentication-Results headers of most of a kilobyte each, and
 * From, Subject and the message ids sit *after* all of them -- so a head
 * cut at 8 KB held none of the fields the row is about. Eight times that is
 * past any header block a real message carries, and the second read is only
 * paid by the messages that need it.
 */
const HEADER_RETRY_FACTOR = 8;
// Bound parallel day requests for sparse pages and the legacy catalog path.
const LIST_CONCURRENCY = 6;
const DAY_LIST_SIZE = 256;
const CATALOG_PAGE_SIZE = 1000;

const isMissingDirectory = (error) =>
  error?.code === 'subject_does_not_exist' || error?.code === 'not_found';

function directoryPage(result, previousCursor) {
  if (!result || !Array.isArray(result.items)
    || (result.cursor != null && typeof result.cursor !== 'string')
    || (result.cursor && result.cursor === previousCursor)) {
    throw new Error('Could not read directory page: invalid response or cursor');
  }
  return { items: result.items, cursor: result.cursor || null };
}

export function createMailbox({ fs, objectsPath, box = 'inbox', pageSize = PAGE_SIZE }) {
  let pendingDayCursor = null;
  let paginated = null; // detected from the root listing; older SDKs return arrays
  let dayCursors = new Map();
  let pendingDays = []; // date folders not yet exhausted, newest first
  let recursiveListing = false;
  let recursiveDirectories = 0;
  let recursivePage = null;
  let listError = null; // why the last listing could not read the mailbox
  let catalog = null;   // every message in the folder, listed once for search
  let catalogNext = 0;
  const messages = [];
  const loaded = new Set();
  /**
   * Which listing the state above belongs to. Every open() starts a new one,
   * and a read that began under the previous listing lands in the wrong place
   * if it is allowed to finish: two open() calls a moment apart -- a folder
   * clicked twice while it loads -- shared `pendingDays`, so each shifted a
   * day the other had already listed and pushed the same files again, and a
   * sync() that raced a re-listing found a file the new listing already held
   * and put it on top a second time. A read checks the generation after each
   * await and stands down when a newer listing has taken over.
   */
  let generation = 0;
  let paging = null;
  let catalogRevision = 0;
  let dayFiles = new Map(); // unconsumed files from fetched directory pages
  let opening = null;   // the open() in flight, shared by anyone who asks
  /**
   * One entry object per filename, for as long as this listing stands. The
   * paged list and the full catalog are two views of the same mailbox, so
   * they have to be views of the *same* objects: a second object for a file
   * one of them had already listed carried its own row, its own header read
   * and its own flags, which the other view never saw. A message archived
   * after being paged in stayed in the catalog, so a later search offered a
   * row for a file that was no longer there.
   */
  const known = new Map();
  // A page already in flight may still contain a file just moved away.
  // Remember departures until the next listing so late pages cannot restore it.
  const removed = new Set();
  /**
   * The `${day}/${name}` of the newest message this listing has held, kept
   * apart from `messages[0]` because messages leave. Archive every row on the
   * first page of a big inbox and `messages` is empty while the folder is
   * not; sync() took that for a listing that had never happened and listed
   * the folder afresh, which handed back the next sixty *older* messages as
   * arrivals -- a "60 new messages" pill, and a notification to match, for
   * mail that had been there all along. Null until something has been listed.
   */
  let newest = null;
  // Whether a listing has been started, and whether one has answered -- with
  // the folder, or with the news that there is no folder yet -- rather than
  // being cancelled or failing.
  let attempted = false;
  let answered = false;
  const keyOf = (message) => `${message.day}/${message.name}`;
  const noteNewest = () => {
    if (messages.length && (!newest || keyOf(messages[0]) > newest)) newest = keyOf(messages[0]);
  };

  const entryFor = (item, day) => {
    const existing = known.get(item.name);
    if (existing) return existing;
    const entry = {
      path: item.path,
      name: item.name,
      box,
      day,
      size: item.size,
      modified: item.modified,
      subject: subjectFromFilename(item.name),
    };
    known.set(item.name, entry);
    return entry;
  };

  // Probe without a limit: an older SDK may ignore cursor but honour limit,
  // returning a truncated array with no way to tell that more mail exists.
  // Once page envelopes are supported, every subsequent request is bounded.
  const readDays = async (cursor = null, limit = DAY_LIST_SIZE) => {
    const result = await fs.readdir(objectsPath, {
      cursor, sortBy: 'name', sortOrder: 'desc',
      ...(paginated ? { limit } : {}),
    });
    if (paginated !== true && Array.isArray(result)) {
      paginated = false;
      return { items: result, cursor: null };
    }
    const page = directoryPage(result, cursor);
    paginated = true;
    return page;
  };

  const readDay = async (day, cursor = null, limit = pageSize) => {
    const result = await fs.readdir(`${objectsPath}/${day}`, paginated ? {
      cursor, limit, sortBy: 'name', sortOrder: 'desc',
    } : undefined);
    return paginated ? directoryPage(result, cursor) : { items: result, cursor: null };
  };

  const readRecursive = async (cursor = null, limit = pageSize) => directoryPage(
    await fs.readdir(objectsPath, {
      recursive: true, depth: 2, cursor, limit,
      sortBy: 'name', sortOrder: 'desc',
    }), cursor);

  const recursiveFile = (item) => {
    if (item.is_dir || !item.path?.startsWith(`${objectsPath}/`)) return null;
    const [day, name, ...nested] = item.path.slice(objectsPath.length + 1).split('/');
    if (!day || !name || nested.length || name !== item.name) return null;
    const { path, size, modified } = item;
    return { item: { name, path, size, modified }, day };
  };

  // Date directories sort ahead of UUIDv7 filenames. Allow for the root's
  // directory entries on the first page, then fetch only a message batch.
  const recursiveLimit = (cursor) => Math.min(CATALOG_PAGE_SIZE,
    pageSize + (cursor ? 0 : recursiveDirectories));

  const readRecursivePage = async () => {
    const gen = generation;
    const state = recursivePage;
    const added = [];
    let error = null;
    while (state.more && added.length < pageSize) {
      if (!state.items) {
        const revision = catalogRevision;
        try {
          const page = await readRecursive(state.cursor, recursiveLimit(state.cursor));
          if (gen !== generation) return [];
          if (revision !== catalogRevision) continue;
          state.items = page.items.map(recursiveFile).filter(Boolean);
          state.nextCursor = page.cursor;
        } catch (cause) {
          if (gen !== generation) return [];
          error = cause;
          break;
        }
      }
      while (state.items.length && added.length < pageSize) {
        const { item, day } = state.items.shift();
        if (loaded.has(item.name) || removed.has(item.name)) continue;
        const entry = entryFor(item, day);
        loaded.add(entry.name);
        messages.push(entry);
        added.push(entry);
      }
      if (!state.items.length) {
        state.cursor = state.nextCursor;
        state.items = null;
        state.more = Boolean(state.cursor);
      }
    }
    listError = error;
    messages.sort((a, b) => keyOf(b).localeCompare(keyOf(a)));
    noteNewest();
    return added;
  };

  // Keep the unused part of a busy day in memory. A page is bounded by
  // messages, not days: threading reads every header in the returned page.
  const readPage = async () => {
    if (catalog) {
      // History/search already paid for this metadata. Page over the same
      // objects without listing their date folders again. Keep the native
      // cursors intact for use if a later event invalidates the catalog.
      const added = [];
      while (catalogNext < catalog.length && added.length < pageSize) {
        const entry = catalog[catalogNext++];
        if (loaded.has(entry.name)) continue;
        loaded.add(entry.name);
        messages.push(entry);
        added.push(entry);
      }
      messages.sort((a, b) => `${b.day}/${b.name}`.localeCompare(`${a.day}/${a.name}`));
      listError = null;
      noteNewest();
      return added;
    }
    if (recursiveListing) return readRecursivePage();
    const gen = generation;
    const buffered = dayFiles;
    const added = [];
    const retryDays = [];
    let error = null;
    let density = pageSize; // read one day first; fan out only for sparse mail
    while ((pendingDays.length || pendingDayCursor) && added.length < pageSize) {
      if (!pendingDays.length) {
        const revision = catalogRevision;
        try {
          const page = await readDays(pendingDayCursor);
          if (gen !== generation) return [];
          if (revision !== catalogRevision) continue;
          pendingDays.push(...dayNames(page.items));
          pendingDayCursor = page.cursor;
        } catch (cause) {
          if (gen !== generation) return [];
          error ??= cause;
          break;
        }
        continue;
      }
      const day = pendingDays[0];
      if (!buffered.has(day)) {
        const width = Math.min(LIST_CONCURRENCY,
          Math.max(1, Math.ceil((pageSize - added.length) / density)));
        const days = pendingDays.slice(0, width).filter((date) => !buffered.has(date));
        const revision = catalogRevision;
        const limit = Math.max(1, Math.ceil((pageSize - added.length) / days.length));
        const results = await Promise.allSettled(days.map((date) => readDay(date, dayCursors.get(date), limit)));
        if (gen !== generation) return [];
        if (revision !== catalogRevision) continue;
        let filesRead = 0;
        results.forEach((result, index) => {
          const date = days[index];
          if (result.status === 'rejected') {
            retryDays.push(date);
            pendingDays.splice(pendingDays.indexOf(date), 1);
            error ??= result.reason;
          } else {
            const files = result.value.items.filter((item) => !item.is_dir)
              .sort((a, b) => b.name.localeCompare(a.name));
            buffered.set(date, files);
            dayCursors.set(date, result.value.cursor);
            filesRead += files.length;
          }
        });
        density = Math.max(1, filesRead / days.length);
        continue;
      }
      const files = buffered.get(day);
      let consumed = 0;
      while (consumed < files.length && added.length < pageSize) {
        const item = files[consumed++];
        if (loaded.has(item.name) || removed.has(item.name)) continue;
        const entry = entryFor(item, day);
        loaded.add(item.name);
        messages.push(entry);
        added.push(entry);
      }
      if (consumed === files.length) {
        buffered.delete(day);
        if (!dayCursors.get(day)) {
          pendingDays.shift();
          dayCursors.delete(day);
        }
      } else {
        buffered.set(day, files.slice(consumed));
      }
    }
    pendingDays.unshift(...retryDays);
    listError = error;
    // Retried days and restored mail may sort above an already loaded page.
    messages.sort((a, b) => `${b.day}/${b.name}`.localeCompare(`${a.day}/${a.name}`));
    noteNewest();
    return added;
  };

  const startPage = () => {
    if (!paging) {
      const request = readPage().finally(() => {
        if (paging === request) paging = null;
      });
      paging = request;
    }
    return paging;
  };

  const loadMore = () => opening ?? startPage();

  const dayNames = (days) => days
    .filter((item) => item.is_dir)
    .map((item) => item.name)
    .sort((a, b) => b.localeCompare(a));

  /**
   * Every message in the folder, newest first, listed once and kept. This is
   * what search runs over: a filename carries the subject, so listing the day
   * folders is enough to search every subject in the mailbox without reading
   * a single message.
   *
   * Messages that have already been paged in are the same objects here, so a
   * row, a header read, or a flag is never duplicated or done twice.
   */
  const readCatalog = async (onProgress, signal, attempt = 0) => {
    checkAbort(signal);
    if (attempt > 3) throw new Error('Mailbox changed while listing. Please retry.');
    const restart = () => readCatalog(onProgress, signal, attempt + 1);
    // A listing in flight is about to replace every entry object this would
    // otherwise be built from, so it is waited for rather than raced.
    if (opening) await opening;
    checkAbort(signal);
    if (catalog) return catalog;
    const gen = generation;
    const revision = catalogRevision;
    let root = null;
    try {
      if (paginated !== true) root = await readDays();
    } catch (error) {
      // Sent and Archive are created on first use. An absent root has no
      // history; leave it uncached so a later filing can be discovered.
      if (isMissingDirectory(error)) return [];
      throw error;
    }
    checkAbort(signal);
    if (gen !== generation || revision !== catalogRevision) return restart();
    if (paginated) {
      const found = new Map();
      let cursor = null;
      do {
        checkAbort(signal);
        let page;
        try {
          page = await readRecursive(cursor, CATALOG_PAGE_SIZE);
        } catch (error) {
          if (!cursor && isMissingDirectory(error)) return [];
          throw error;
        }
        checkAbort(signal);
        if (gen !== generation || revision !== catalogRevision) return restart();
        for (const item of page.items) {
          const file = recursiveFile(item);
          if (file) found.set(`${file.day}/${file.item.name}`, file);
        }
        onProgress?.(found.size);
        cursor = page.cursor;
      } while (cursor);
      // Progress callbacks may invalidate the catalog too.
      checkAbort(signal);
      if (gen !== generation || revision !== catalogRevision) return restart();
      const sorted = [...found.values()]
        .filter(({ item }) => !removed.has(item.name))
        .sort((a, b) => b.item.path.localeCompare(a.item.path));
      const entries = [];
      for (let i = 0; i < sorted.length; i++) {
        if (i && i % 500 === 0) {
          await yieldTask();
          checkAbort(signal);
          if (gen !== generation || revision !== catalogRevision) return restart();
        }
        const { item, day } = sorted[i];
        if (!removed.has(item.name)) entries.push(entryFor(item, day));
      }
      catalog = entries;
      catalogNext = 0;
      return catalog;
    }
    const days = dayNames(root.items);
    checkAbort(signal);
    if (gen !== generation || revision !== catalogRevision) return restart();
    // A few days at a time, in whatever order the answers come back. Each
    // day's files are kept by the day's place, so the catalog reads newest
    // first however the reads landed.
    const perDay = new Array(days.length);
    let next = 0;
    let listed = 0;
    let failure = null;
    const worker = async () => {
      while (next < days.length && !failure && gen === generation && revision === catalogRevision) {
        checkAbort(signal);
        const index = next++;
        try {
          const files = await fs.readdir(`${objectsPath}/${days[index]}`);
          checkAbort(signal);
          perDay[index] = files
            .filter((item) => !item.is_dir)
            .sort((a, b) => b.name.localeCompare(a.name));
          listed += perDay[index].length;
          if (gen === generation && revision === catalogRevision) onProgress?.(listed);
        } catch (error) {
          // Search and whole-folder actions require a complete catalog. A
          // failed day is not empty: report the failure and leave the catalog
          // uncached so the next attempt can recover the missing messages.
          failure ??= error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, days.length) }, worker));
    // A re-listing took over partway: what was gathered is a mix of two
    // listings, so the catalog is built again over the one that stands.
    checkAbort(signal);
    if (gen !== generation || revision !== catalogRevision) return restart();
    if (failure) throw failure;
    const all = [];
    days.forEach((day, index) => {
      for (const item of perDay[index]) if (!removed.has(item.name)) all.push(entryFor(item, day));
    });
    catalog = all;
    catalogNext = 0;
    return catalog;
  };

  const listAll = sharedTask((signal, progress) => readCatalog(progress, signal));

  const relist = async () => {
    const gen = ++generation;
    attempted = true;
    paging = null;
    let page;
    try {
      page = await readDays(null, CATALOG_PAGE_SIZE);
    } catch (e) {
      if (gen !== generation) return [];
      if (isMissingDirectory(e)) answered = true;
      // Two different situations: there is no `objects` folder yet (a
      // mailbox nothing has been delivered to), or the read itself failed.
      // Keeping the previous listing is right for both -- on a first open
      // there is nothing to keep, and on a re-open a blip does not look like
      // the mail has been deleted. Only the failed read is an error the
      // caller has to say out loud and offer to retry: a missing folder is
      // an empty mailbox, the same distinction the catalog makes.
      listError = isMissingDirectory(e) ? null : e;
      return [];
    }
    if (gen !== generation) return [];
    listError = null;
    messages.length = 0;
    loaded.clear();
    newest = null;
    // A re-listing may have found messages the old catalog never had, or lost
    // ones it did; it is rebuilt on the next search rather than patched.
    catalog = null;
    known.clear();
    removed.clear();
    dayFiles = new Map();
    dayCursors = new Map();
    pendingDays = dayNames(page.items);
    pendingDayCursor = page.cursor;
    // Keep the unbounded compatibility probe for old SDKs. If the root
    // itself needs paging, walking recent days avoids scanning potentially
    // thousands of directories before recursive name sorting reaches mail.
    recursiveListing = paginated && !page.cursor;
    recursiveDirectories = pendingDays.length;
    recursivePage = { cursor: null, items: null, nextCursor: null, more: pendingDays.length > 0 };
    const added = await startPage();
    // A page whose every day failed to read has not answered either.
    if (gen === generation && (messages.length || !listError)) answered = true;
    return added;
  };

  // A second open() while the first is still listing gets the same listing:
  // it is as fresh as anything a second one could produce, and running the two
  // at once had them listing the same days into one array.
  const open = () => {
    if (!opening) {
      const request = relist().finally(() => {
        if (opening === request) opening = null;
      });
      opening = request;
    }
    return opening;
  };

  // SDK requests already issued must finish, but an abandoned folder must
  // not keep scanning empty dates or scheduling further native pages.
  const cancelLoad = () => {
    if (!opening && !paging) return false;
    generation++;
    opening = null;
    paging = null;
    return true;
  };

  /**
   * The cheap "has anything arrived?" check, and the listing of what has, in
   * one pass. Recursive name ordering stops at the newest known UUIDv7.
   * The legacy/large-directory traversal reads only dates at or above that
   * boundary. Neither check consumes the user's older-mail cursor.
   *
   * The messages already held are left untouched, rows and header reads
   * included, so the caller can prepend the new ones without rebuilding the
   * list, moving the scroll position, or clearing a search.
   */
  const sync = async () => {
    // A listing already in flight will hold everything this could find, so
    // there is nothing to add on top of it -- and adding on top of it was how
    // a message came to be listed twice.
    if (opening) {
      await opening;
      return [];
    }
    // Nothing has ever been listed -- or the folder was empty when it was --
    // so there is no boundary to check above; the listing is the check. An
    // emptied page is neither: what it held is remembered, and only what
    // sorts above it has arrived.
    //
    // A first listing that was cancelled (the reader went to another folder
    // before it finished) or failed is not that: what it would have shown
    // was there before anything was ever shown, and announcing it said "14
    // new messages" about mail that had been read last week.
    if (attempted && !answered) {
      await open();
      return [];
    }
    if (!newest) return open();

    const gen = generation;
    const boundary = newest;
    const boundaryDay = boundary.slice(0, boundary.indexOf('/'));
    const arrivals = [];
    let cursor = null;
    let reachedBoundary = false;
    try {
      if (recursiveListing) {
        // This cursor is independent of the user's older-mail position.
        const boundaryName = boundary.slice(boundary.indexOf('/') + 1);
        do {
          const page = await readRecursive(cursor, recursiveLimit(cursor));
          if (gen !== generation) return [];
          for (const item of page.items) {
            const file = recursiveFile(item);
            if (!file) continue;
            if (item.name <= boundaryName) {
              reachedBoundary = true;
              break;
            }
            arrivals.push(file);
          }
          cursor = page.cursor;
        } while (cursor && !reachedBoundary);
      } else {
        do {
          const page = await readDays(cursor);
          if (gen !== generation) return [];
          for (const day of dayNames(page.items)) {
            if (day < boundaryDay) {
              reachedBoundary = true;
              break;
            }
            let fileCursor = null;
            do {
              const files = await readDay(day, fileCursor);
              if (gen !== generation) return [];
              let reachedMessage = false;
              for (const item of files.items.filter((item) => !item.is_dir)
                .sort((a, b) => b.name.localeCompare(a.name))) {
                if (`${day}/${item.name}` <= boundary) {
                  reachedMessage = true;
                  break;
                }
                arrivals.push({ item, day });
              }
              fileCursor = reachedMessage ? null : files.cursor;
            } while (fileCursor);
            if (day === boundaryDay) {
              reachedBoundary = true;
              break;
            }
          }
          cursor = page.cursor;
        } while (cursor && !reachedBoundary);
      }
    } catch (error) {
      if (gen === generation) listError = error;
      // Do not advance past a failed page: the next check must retry every
      // arrival, including ones on earlier pages of this same day.
      return [];
    }
    listError = null;

    // Only register arrivals after the whole check succeeds. The watch uses
    // known entries to decide whether a delivery has already been handled.
    const added = arrivals.filter(({ item }) => !removed.has(item.name))
      .map(({ item, day }) => entryFor(item, day));
    added.sort((a, b) => `${b.day}/${b.name}`.localeCompare(`${a.day}/${a.name}`));
    // Everything here sorts above the newest message held, so none of it can
    // already be in the paged list -- but a search that listed the whole
    // folder after the mail arrived has it in the catalog already.
    messages.unshift(...added);
    for (const entry of added) loaded.add(entry.name);
    noteNewest();
    if (catalog) {
      const listed = new Set(catalog);
      const fresh = added.filter((entry) => !listed.has(entry));
      catalog.unshift(...fresh);
      catalogNext += fresh.length;
    }
    return added;
  };

  // The entry for the same file, which is not always the same object: a
  // listing made while a move or an undo was in flight builds entries of its
  // own for the files it finds, and matched by identity the old entry missed
  // them -- an archived message stayed listed, an undone one was listed twice.
  //
  // Identity is asked first and natively; the filename only when that misses,
  // because a bulk move or undo asks this once per message of the folder.
  const indexOfFile = (list, message, mayHold = true) => {
    const at = list.indexOf(message);
    return at !== -1 || !mayHold ? at : list.findIndex((entry) => entry.name === message.name);
  };

  // A message leaving the folder is a splice, not a re-list: `pendingDays` is
  // untouched, so "Load older messages" carries on from where it was.
  const remove = (message) => {
    removed.add(message.name);
    known.delete(message.name);
    const buffered = dayFiles.get(message.day);
    if (buffered) dayFiles.set(message.day, buffered.filter((item) => item.name !== message.name));
    const index = indexOfFile(messages, message, loaded.has(message.name));
    if (index !== -1) messages.splice(index, 1);
    loaded.delete(message.name);
    if (catalog) {
      const at = indexOfFile(catalog, message);
      if (at !== -1) {
        catalog.splice(at, 1);
        if (at < catalogNext) catalogNext--;
      }
    }
    return index;
  };

  // Undo puts the message back where it was. Day and filename both sort
  // newest-first as text, so the position is found rather than remembered --
  // correct even if other messages arrived in between.
  const insert = (message) => {
    removed.delete(message.name);
    // Already listed again under an entry of its own: that one stands.
    if (loaded.has(message.name)) return indexOfFile(messages, message);
    const listedAgain = known.get(message.name);
    known.set(message.name, message);
    const key = (m) => `${m.day}/${m.name}`;
    const place = (list) => {
      const at = list.findIndex((m) => key(m) < key(message));
      const index = at === -1 ? list.length : at;
      list.splice(index, 0, message);
      return index;
    };
    const index = place(messages);
    loaded.add(message.name);
    noteNewest();
    if (catalog && !catalog.includes(message) && !(listedAgain && catalog.includes(listedAgain))) {
      if (place(catalog) < catalogNext) catalogNext++;
    }
    return index;
  };

  return {
    messages,
    box,
    open,
    loadMore,
    cancelLoad,
    sync,
    listAll,
    remove,
    insert,
    /**
     * The entry for this filename, if the listing holds it -- paged in or in
     * the catalog -- else null. What the watch asks before acting on an event:
     * a file this listing never had cannot have left it, and one it already
     * has did not just arrive.
     */
    find: (name) => known.get(name) ?? null,
    /**
     * Drop the catalog, because the folder changed in a way this listing did
     * not see: a message filed into it from another folder, a sent copy
     * written, a change another device made. The next listAll() reads the
     * folder again; the paged list and its entry objects stand, and the
     * catalog is built over the same objects when it is next asked for.
     */
    forget: () => {
      catalogRevision++;
      catalog = null;
      dayFiles.clear();
      dayCursors.clear();
      // The cursor advances only after its buffer is consumed, so dropping
      // stale metadata retries that page without skipping unconsumed mail.
      if (recursivePage) recursivePage.items = null;
    },
    get hasMore() {
      if (catalog) {
        while (catalogNext < catalog.length && loaded.has(catalog[catalogNext].name)) catalogNext++;
        return catalogNext < catalog.length;
      }
      if (recursiveListing) return recursivePage.more;
      return pendingDays.length > 0 || Boolean(pendingDayCursor);
    },
    /** How many messages the folder holds in total, once listAll() has run. */
    get total() { return catalog ? catalog.length : null; },
    /** The error from the last listing that could not read, else null. */
    get listError() { return listError; },
  };
}

/**
 * Fill in sender, date, and a preview line by reading only the head of the
 * file. A message can be 25MB; the list needs the first few KB.
 */
export async function enrichMessage(fs, message, headerBytes = HEADER_BYTES) {
  try {
    const readHead = async (count) => {
      const blob = await fs.read(message.path, { byte_count: count });
      // Some deployed SDK/backend combinations return the full MIME file.
      // Bound parsing even then: attachments do not belong in a row preview.
      const bytes = new Uint8Array(await blob.slice(0, count).arrayBuffer());
      return { ...splitMessage(bytes), length: bytes.length };
    };
    let split = await readHead(headerBytes);
    // No blank line in a read that filled its range: the header block goes
    // on past the cut, and so may every field this is reading for. One more
    // read, much longer, rather than a row with no sender and no preview --
    // and, since the ids were among what was cut off, no conversation.
    if (!split.complete && split.length >= headerBytes) {
      split = await readHead(headerBytes * HEADER_RETRY_FACTOR);
      if (!split.complete && split.length >= headerBytes * HEADER_RETRY_FACTOR) {
        throw new Error('Message headers exceed the bounded read');
      }
    }
    const { head, body } = split;
    const headers = parseHeaders(head);
    const contentType = parseContentType(headers.get('content-type') || '');
    const disposition = parseContentType(headers.get('content-disposition') || '');
    const namedFile = Boolean(paramValue(disposition.attrs, 'filename') || paramValue(contentType.attrs, 'name'));
    // A message with no From header, or one that names nobody, still needs a
    // sender to show. Said in words, not as a comment the address parser
    // would rightly strip to nothing.
    const from = parseAddress(headers.get('from') || '');
    if (!from.name && !from.email) from.name = '(unknown sender)';
    const patch = {
      from,
      to: parseAddressList(headers.get('to') || ''),
      // The preview line is what the writer wrote, not the copy of the message
      // they were answering: a reply of one line used to run straight into
      // "On Wednesday, Tom wrote: > ..." and the row said nothing about the
      // reply itself. The quoted tail is what the reader folds away too.
      snippet: cleanSnippet(splitQuotedTail(previewText(body, headers)).text),
      // A single-part message that is a file is a message with an attachment,
      // however it is disposed: with no HTML around it, nothing can be showing
      // an "inline" part, and the reader lists it as the file it is.
      hasAttachments: contentType.type === 'multipart/mixed'
        || contentType.type === 'message/rfc822'
        || disposition.type === 'attachment' || namedFile,
      // What the conversation view groups on. It rides along on the head read
      // the row already costs, so threading a folder needs no reads of its
      // own -- and an empty id is recorded as an empty id, so a message that
      // simply has no Message-ID is not read again looking for one.
      messageId: parseMessageId(headers),
      references: parseReferences(headers),
      unreadable: false,
      searchIncomplete: false,
    };
    const date = new Date(headers.get('date') || '');
    if (!Number.isNaN(date.valueOf())) patch.date = date;
    if (!message.subject) patch.subject = decodeWords(headers.get('subject') || '');
    return patch;
  } catch {
    // `unreadable` marks this as a fact about the read, not about the message:
    // the caller must not cache it, or one network blip would leave the row
    // saying "(unreadable)" for good.
    return {
      from: { name: '(unreadable)', email: '' },
      to: [],
      snippet: '',
      hasAttachments: false,
      // A message whose head could not be read cannot be threaded, so it
      // stands as a conversation of its own rather than being read again on
      // every regrouping.
      messageId: '',
      references: [],
      unreadable: true,
    };
  }
}

// -- filing a message ---------------------------------------------------------

/**
 * uuid v7: a 48-bit big-endian millisecond timestamp, the version and variant
 * bits, and randomness for the rest. The timestamp prefix is the whole point
 * here -- it makes the text order of the filenames the same as their time
 * order, which is what lets the listing show newest first with no metadata
 * reads.
 */
export const uuidv7 = (ms = Date.now(), random = crypto.getRandomValues(new Uint8Array(10))) => {
  const bytes = Uint8Array.from(random);
  const hex = [...Array(6)].map((unused, i) =>
    Math.floor(ms / 2 ** (8 * (5 - i))) % 256).map((b) => b.toString(16).padStart(2, '0')).join('');
  bytes[0] = (bytes[0] & 0x0f) | 0x70; // version 7
  bytes[2] = (bytes[2] & 0x3f) | 0x80; // variant 10
  const rest = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${rest.slice(0, 4)}-${rest.slice(4, 8)}-${rest.slice(8)}`;
};

// Day folder, in UTC so it agrees with the uuid's timestamp whatever the
// device's clock offset is.
export const dayFolder = (date) => date.toISOString().slice(0, 10);

/**
 * The filename `emailrx` uses: `<uuidv7>--<base64url subject>`. Keeping the
 * same rule means the same listing code reads both folders.
 */
export const mailFilename = (subject = '', date = new Date(), random) => {
  const encoded = bytesToBase64(new TextEncoder().encode(subject))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${uuidv7(date.getTime(), random)}--${encoded}`;
};

/**
 * Move a message file into another mailbox folder, keeping its day folder and
 * its filename -- read and star flags are keyed on the filename, so they
 * survive the move, and so does the chronological ordering. Returns the new
 * path.
 *
 * The folder is made first, because `move` will not make it. Given a
 * destination it cannot stat, `move` reads the path as a *new name* for the
 * file rather than a folder to put it in -- so archiving the first message of
 * any day asked for the message to become a file called `2026-08-23`, inside
 * an `archive/` that did not exist either, and the whole thing came back 404.
 * `archive/`, `trash/` and their day folders are this app's to create, and
 * nothing had ever created them.
 *
 * Naming the file explicitly settles the same ambiguity from the other side:
 * the destination can then only be the folder. It also spares the stat that
 * `move` would otherwise do to work it out, so this costs no more requests
 * than it did before.
 */
export async function moveMessage({ fs, mailPath, message, to, dirs = null }) {
  const dir = `${boxPath(mailPath, to)}/${message.day}`;
  // `dirs` remembers the day folders this session has already asked for, so a
  // bulk move of a busy day asks once rather than once per message: archiving
  // a folder was one mkdir for every move, twice the requests it needed.
  const remembered = Boolean(dirs?.has(dir));
  const ensure = () => {
    let made = dirs?.get(dir);
    if (!made) {
      // Already there, which is every message after the first one filed on
      // that day. A folder that genuinely cannot be made is the move's to
      // report: it is the operation that has to succeed.
      made = fs.mkdir(dir, { createMissingParents: true }).then(() => {}, () => {});
      dirs?.set(dir, made);
    }
    return made;
  };
  await ensure();
  try {
    await fs.move(message.path, dir, { newName: message.name });
  } catch (error) {
    // A remembered folder may have been removed since; ask for it again, once.
    if (!remembered) throw error;
    dirs.delete(dir);
    await ensure();
    await fs.move(message.path, dir, { newName: message.name });
  }
  return `${dir}/${message.name}`;
}

/**
 * File the exact bytes that were sent into `.mail/sent/<day>/<name>`, a
 * sibling of `objects/` so a sent copy never shows up in the inbox listing.
 * Resolves to the path written; throws whatever the write threw, which the
 * caller reports without calling the send itself a failure.
 */
export async function fileSentCopy({ fs, mailPath, raw, subject, date = new Date() }) {
  const path = `${mailPath}/${SENT_DIR}/${dayFolder(date)}/${mailFilename(subject, date)}`;
  await fs.write(path, new Blob([raw], { type: 'message/rfc822' }), {
    createMissingParents: true,
    overwrite: false,
  });
  return path;
}

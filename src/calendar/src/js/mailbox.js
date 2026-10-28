/**
 * Mailbox connection lifecycle for inbound-mail invitations. Owns:
 *
 *   - the capability probe + batched permission request,
 *   - subscribing (or adopting an existing subscription) to
 *     `fs:~/.mail/objects/**:add` as a `queue` subscription,
 *   - `cal:mail:cfg` (mode/subId/watermark/…),
 *   - the watermark rescan (via `puter.email.list`), which runs the SAME
 *     handler source in-page (via `new Function`) so a foreground session or
 *     a missed-delivery gap is recovered without a second implementation.
 *
 * Never touches `cal:evt:` — that's mail-intake.js, downstream of the KV
 * records this module's handler (worker or in-page) writes.
 */
import handlerSource from '../workers/mail-handler.js?raw';
import { isBlocked } from './offline.js';

// The handler name carries the record-shape contract version: an old client
// never binds to a newer, incompatible handler and vice versa. Lives here,
// in ONE place, so scripts/publish-mail-handler.mjs importing it can't drift.
export const HANDLER_NAME = 'calendar-mail-v2';
export const MAIL_SUBJECT = 'fs:~/.mail/objects/**:add';
export const RECORD_VERSION = 1;

const CFG_KEY = 'cal:mail:cfg';
const GAP_KEY = 'cal:mail:gap';
const RESCAN_MIN_MS = 5 * 60_000;
const LIST_PAGE_LIMIT = 100;
const MAX_SCAN_MESSAGES = 200;
const MAX_MESSAGE_BYTES = 3 << 20; // 3 MiB — same cap the handler itself enforces
// How far back a sweep reaches. Only bites when there is no watermark — a
// first connect, or a gap — where the alternative is downloading 200 messages
// of whatever age the mailbox happens to hold.
const MAX_SCAN_AGE_MS = 14 * 86_400_000;

function coerce(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function errorCode(err) {
  return (err && (err.code || (err.error && err.error.code))) || '';
}
function errorMessage(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return err.message || (typeof err.error === 'string' ? err.error : '') || '';
}

/** Map a `puter.events.list()` row's `suspendedReason` to the dialog copy. */
function suspensionMessage(reason) {
  if (reason === 'handler_not_found' || reason === 'failures') {
    return 'This needs the developer to republish the mail handler.';
  }
  if (reason === 'no_credit') return 'Add credit to your Puter account to resume.';
  if (reason === 'permission_revoked') return 'Permission was revoked — reconnect to resume.';
  return reason || 'Paused.';
}

export function createMailbox({
  kv,
  store,
  user,
  getPuter = () => (typeof puter !== 'undefined' ? puter : null),
  blocked = isBlocked,
  source = handlerSource,
  now = () => Date.now(),
}) {
  let cfg = null;
  let state = 'off'; // 'off'|'connecting'|'ok'|'suspended'|'foreground'|'unavailable'
  let suspendedReason = '';
  let lastError = '';
  let lastScanAt = 0;
  let rescanPromise = null;
  let localHandler = null; // lazily instantiated: null = not tried, false = failed
  const listeners = new Set();

  function notify() {
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        /* a listener bug must not break the mailbox */
      }
    }
  }

  function username() {
    return (user && user.username) || '';
  }
  function selfEmail() {
    return (user && typeof user.email === 'string' && user.email.trim().toLowerCase()) || '';
  }

  function available() {
    const p = getPuter();
    return Boolean(
      p && p.events && typeof p.events.onPersistent === 'function' && p.perms && !blocked(),
    );
  }

  async function loadCfg() {
    cfg = coerce(await kv.get(CFG_KEY)) || null;
    return cfg;
  }

  async function saveCfg(patch) {
    cfg = {
      v: 1,
      mode: 'off',
      subId: '',
      handlerName: HANDLER_NAME,
      subject: MAIL_SUBJECT,
      watermark: '',
      ...cfg,
      ...patch,
    };
    await kv.set(CFG_KEY, cfg);
    notify();
    return cfg;
  }

  /** Instantiate the handler in-page from its `?raw` source, once. `false` on
   *  failure (a future CSP blocking `new Function`) — never throws again. */
  function ensureLocalHandler() {
    if (localHandler !== null) return localHandler;
    try {
      localHandler = new Function('return (\n' + source + '\n)')();
    } catch {
      localHandler = false;
    }
    return localHandler;
  }

  function status() {
    return {
      mode: (cfg && cfg.mode) || 'off',
      state,
      subId: (cfg && cfg.subId) || '',
      suspendedReason,
      lastError,
      watermark: (cfg && cfg.watermark) || '',
      lastScanAt,
    };
  }

  /* ---- connect / subscribe --------------------------------------------- */

  async function requestMailAndBackgroundPerms() {
    const p = getPuter();
    return p.perms.request([
      { resource: 'permission', permission: `fs:/${username()}/.mail:read`, create: true },
      { resource: 'permission', permission: 'events:background' },
    ]);
  }

  /** Adopt a live subscription on our subject+handlerName if one already
   *  exists (never duplicate), else create it. */
  async function adoptOrSubscribe() {
    const p = getPuter();
    let existing = null;
    try {
      const list = await p.events.list();
      existing = (Array.isArray(list) ? list : []).find(
        (s) => s && s.subject === MAIL_SUBJECT && s.handlerName === HANDLER_NAME && !s.suspendedAt,
      );
    } catch {
      /* best-effort — fall through to subscribing fresh */
    }
    if (existing) return { subId: existing.id || existing.subId || '' };
    const sub = await p.events.onPersistent({
      subject: MAIL_SUBJECT,
      queue: true,
      handlerName: HANDLER_NAME,
      context: { v: 1, self: selfEmail(), user: username() },
    });
    return { subId: (sub && (sub.id || sub.subId)) || '' };
  }

  async function subscribeAndScan() {
    const { subId } = await adoptOrSubscribe();
    await saveCfg({ mode: 'background', subId, connectedAt: now(), lastError: '' });
    state = 'ok';
    lastError = '';
    notify();
    await rescan();
    return status();
  }

  async function enterForeground(message) {
    lastError = message || '';
    await saveCfg({ mode: 'foreground', subId: '' });
    await rescan();
    // A future CSP blocking `new Function` disables the local scan entirely —
    // foreground mode with no working scan is not really "on".
    state = ensureLocalHandler() ? 'foreground' : 'unavailable';
    notify();
    return status();
  }

  async function connect() {
    lastError = '';
    suspendedReason = '';
    if (!available()) {
      state = 'unavailable';
      notify();
      return status();
    }
    state = 'connecting';
    notify();

    try {
      // A denial RESOLVES falsy — it does not throw. The array is in the order
      // the batch was asked for: mailbox read, then background consent.
      const granted = await requestMailAndBackgroundPerms();
      const [mailRead, background] = Array.isArray(granted) ? granted : [granted, granted];
      if (!mailRead) {
        lastError = 'Calendar needs access to your Puter mailbox to detect invitations.';
        state = 'off';
        await saveCfg({ mode: 'off' });
        return status();
      }
      // Mailbox yes, background no: still useful, just only while a tab is open.
      if (!background) return enterForeground('Background permission was declined.');
    } catch (err) {
      const code = errorCode(err);
      if (code === 'events_disabled') {
        lastError = 'Not available on this Puter server.';
        state = 'off';
        await saveCfg({ mode: 'off' });
        return status();
      }
      if (code === 'events_durable_requires_account') {
        lastError = 'Needs a full Puter account (not a temporary one).';
        state = 'off';
        await saveCfg({ mode: 'off' });
        return status();
      }
      if (code === 'events_background_consent_required') {
        try {
          await getPuter().perms.request({ resource: 'permission', permission: 'events:background' });
        } catch {
          return enterForeground('Background permission was declined.');
        }
      } else {
        lastError = errorMessage(err) || 'Could not request permission.';
        state = 'off';
        notify();
        return status();
      }
    }

    // Without an app there is no events worker to run the handler, and the
    // server accepts the subscription anyway, so check here.
    if (!getPuter().appID) return enterForeground('No app identity is available here.');

    try {
      return await subscribeAndScan();
    } catch (err) {
      const code = errorCode(err);
      if (code === 'subject_does_not_exist') {
        try {
          await getPuter().perms.request({
            resource: 'permission',
            permission: `fs:/${username()}/.mail:read`,
            create: true,
          });
          return await subscribeAndScan();
        } catch (err2) {
          lastError = errorMessage(err2) || 'Could not set up the mailbox.';
          state = 'off';
          notify();
          return status();
        }
      }
      // The consent check happens at subscribe, so this surfaces here rather
      // than out of perms.request.
      if (code === 'events_background_consent_required') {
        return enterForeground('Background permission was declined.');
      }
      if (code === 'events_handler_not_found' || code === 'events_handler_hash_mismatch') {
        lastError = "The calendar's mail handler is not deployed.";
        state = 'off';
        await saveCfg({ mode: 'off' });
        return status();
      }
      if (code === 'events_subscription_limit' || code === 'too_many_requests') {
        lastError = 'Too many requests — try again in a moment.';
        state = 'off';
        notify();
        return status();
      }
      lastError = errorMessage(err) || 'Could not connect.';
      state = 'off';
      notify();
      return status();
    }
  }

  // Permission_revoked needs a full re-prompt (re-granting does not resume a
  // suspended subscription); every other suspension reason just retries the
  // same flow, which is the one mechanism the dialog's Reconnect button needs.
  async function reconnect() {
    return connect();
  }

  async function disconnect() {
    const p = getPuter();
    const subId = cfg && cfg.subId;
    if (subId && p && p.events && typeof p.events.unsubscribe === 'function') {
      try {
        await p.events.unsubscribe(subId);
      } catch {
        /* best-effort */
      }
    }
    // The pending tray is left alone — the user may still want to add what
    // was found — and the permission itself is not revoked (the dialog links
    // out to Puter's own settings for that).
    await saveCfg({ mode: 'off', subId: '' });
    state = 'off';
    suspendedReason = '';
    notify();
  }

  async function start() {
    await loadCfg();
    if (!cfg || cfg.mode === 'off') {
      state = 'off';
      notify();
      return status();
    }
    if (cfg.mode === 'foreground') {
      await rescan();
      state = ensureLocalHandler() ? 'foreground' : 'unavailable';
      notify();
      return status();
    }
    // background: cheap suspension check via events.list(), then scan.
    if (!available()) {
      state = 'unavailable';
      notify();
      return status();
    }
    try {
      const p = getPuter();
      const list = await p.events.list();
      const row = (Array.isArray(list) ? list : []).find((s) => (s.id || s.subId) === cfg.subId);
      if (row && row.suspendedAt) {
        suspendedReason = suspensionMessage(row.suspendedReason);
        state = 'suspended';
      } else {
        state = 'ok';
      }
    } catch {
      state = 'ok'; // can't verify right now — foreground scanning covers the gap either way
    }
    notify();
    await rescan(); // foreground scanning takes over while suspended, so nothing is lost
    return status();
  }

  /* ---- rescan / watermark ------------------------------------------------ */

  async function rescan({ force = false } = {}) {
    if (rescanPromise) return rescanPromise;
    if (!force && now() - lastScanAt < RESCAN_MIN_MS) return;
    const handler = ensureLocalHandler();
    if (!handler) {
      lastError = 'Local scanning is unavailable.';
      notify();
      return;
    }
    rescanPromise = doRescan(handler).finally(() => {
      rescanPromise = null;
    });
    return rescanPromise;
  }

  /**
   * `puter.email.list` newest first, stopping at the first item at or before
   * the watermark (lowercase uuidv7 ids sort chronologically as plain
   * strings) or older than MAX_SCAN_AGE_MS — the listing is newest-first, so
   * the first too-old item ends the pass. A `gap` ignores the stored watermark
   * for this one pass — the 200-message cap and the age bound still apply —
   * and is cleared once the pass finishes.
   */
  async function doRescan(handler) {
    const p = getPuter();
    const emailApi = p && p.email;
    if (!emailApi || typeof emailApi.list !== 'function') return;
    lastScanAt = now();

    let gap = null;
    try {
      gap = coerce(await kv.get(GAP_KEY));
    } catch {
      /* ignore */
    }
    const fullSweep = Boolean(gap);
    const watermark = fullSweep ? '' : (cfg && cfg.watermark) || '';

    const ctx = Object.freeze({ v: 1, self: selfEmail(), user: username() });
    const oldest = now() - MAX_SCAN_AGE_MS;
    let processed = 0;
    let greatest = watermark;
    let cursor;

    while (processed < MAX_SCAN_MESSAGES) {
      let page;
      try {
        page = await emailApi.list({ limit: LIST_PAGE_LIMIT, cursor });
      } catch {
        break; // best-effort — a bad page must not wedge the whole rescan
      }
      const items = Array.isArray(page && page.items) ? page.items : [];
      let stop = false;
      for (const item of items) {
        if (processed >= MAX_SCAN_MESSAGES) break;
        if (!item || !item.id) continue;
        if (watermark && item.id <= watermark) {
          stop = true;
          break;
        }
        // Newest first, so the first message past the horizon ends the sweep
        // rather than just being skipped.
        const at = Date.parse(item.date);
        if (Number.isFinite(at) && at < oldest) {
          stop = true;
          break;
        }
        processed++;
        if (!greatest || item.id > greatest) greatest = item.id;
        const size = Number(item.size);
        if (Number.isFinite(size) && size > MAX_MESSAGE_BYTES) continue; // skip without a get
        try {
          await handler({
            event: { id: 'scan-' + item.id, op: 'add', uid: item.uid, path: item.path, self: true, ts: now() },
            ctx,
            user: p,
            fetch: typeof fetch !== 'undefined' ? fetch : undefined,
            ack() {},
          });
        } catch {
          /* one bad message must not abort the whole sweep */
        }
      }
      if (stop || !page || !page.cursor) break;
      cursor = page.cursor;
    }

    if (greatest && greatest !== ((cfg && cfg.watermark) || '')) {
      await saveCfg({ watermark: greatest });
    }
    if (fullSweep) {
      try {
        await kv.del(GAP_KEY);
      } catch {
        /* best-effort */
      }
    }
  }

  return {
    start,
    status,
    connect,
    disconnect,
    reconnect,
    rescan,
    onChange(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    available,
  };
}

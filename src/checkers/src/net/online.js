/**
 * Online play over the Puter Peer API (WebRTC data channels with built-in
 * signaling — https://docs.puter.com/Peer/).
 *
 * The Puter SDK is loaded lazily, only when the user enters online mode, so
 * offline play never pays for it. An OnlineSession wraps one private
 * host/guest game: the host serves an invite code, exactly one guest may
 * connect, and both sides exchange JSON messages:
 *
 *   {t:'start', v, color, name, time}
 *                                host -> guest: assigned color, host's name,
 *                                and the time control the host chose
 *   {t:'joined', name}           guest -> host: handshake complete
 *   {t:'move', path, clock}      one message per TURN, not per hop — a jump
 *                                chain crosses the wire as the whole path the
 *                                mover finished, so the position, the turn,
 *                                and the clock handover stay atomic. `clock`
 *                                is the mover's own remaining ms, so the
 *                                receiver can correct for drift instead of
 *                                counting the opponent down blind
 *   {t:'flag', color}            the game ended on time; `color` ran out
 *   {t:'resign'}
 *   {t:'rematch'} / {t:'rematch-yes'} / {t:'rematch-no'}
 *   {t:'bye'}                    sent before an intentional leave
 *
 * Sessions are fire-and-forget: leave() tears everything down silently, while
 * remote/spontaneous closure surfaces through onClose exactly once.
 */

const PUTER_SRC = 'https://js.puter.com/v2/';
// This is a new app with no deployed peers, so there is no earlier version to
// stay compatible with — start the count at 1.
const PROTOCOL_VERSION = 1;
const OPEN_TIMEOUT_MS = 30000;

let puterPromise = null;
const loadedListeners = new Set();

/**
 * Run `fn` once the SDK is on the page: right away if it already is, otherwise
 * after the first loadPuter() that finds it there. It never starts a load
 * itself.
 */
export function whenPuterLoaded(fn) {
  if (globalThis.puter) fn(globalThis.puter);
  else loadedListeners.add(fn);
}

function announceLoaded(puter) {
  const listeners = [...loadedListeners];
  loadedListeners.clear();
  for (const fn of listeners) {
    try {
      fn(puter);
    } catch {
      // A listener's trouble must not fail the load it was waiting on.
    }
  }
}

/** Load the Puter SDK on demand; resolves with the `puter` global. */
export function loadPuter() {
  if (window.puter) {
    announceLoaded(window.puter);
    return Promise.resolve(window.puter);
  }
  if (!puterPromise) {
    puterPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = PUTER_SRC;
      script.onload = () => {
        if (window.puter) {
          announceLoaded(window.puter);
          resolve(window.puter);
        } else {
          reject(new Error('Puter SDK loaded but is unavailable.'));
        }
      };
      script.onerror = () => {
        puterPromise = null; // allow a retry after transient network failures
        script.remove();
        reject(new Error('Could not load the Puter SDK. Check your connection.'));
      };
      document.head.appendChild(script);
    });
  }
  return puterPromise;
}

/**
 * Make sure the user is signed in before touching the peer API. Doing this
 * explicitly (rather than letting serve()/connect() prompt implicitly) keeps
 * the popup inside the user's click gesture and turns a dismissed or blocked
 * popup into a clean rejection instead of a hang.
 */
async function ensureSignedIn(puter) {
  if (puter.auth?.isSignedIn?.()) return;
  await puter.auth.signIn();
}

/**
 * Display names cross the wire (and the Puter metadata is typed loosely), so
 * accept only reasonable strings — anything else renders as the generic
 * "Opponent"/"Your friend" fallback.
 */
function cleanName(value) {
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, 40) || null;
}

/**
 * Time controls are opaque ids here — this module relays the host's choice
 * without knowing what any of them mean, and the caller resolves it (falling
 * back to an untimed game for an id it doesn't recognize).
 */
function cleanTimeId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id && id.length <= 16 ? id : null;
}

/** A remaining-time reading from a peer: a sane, finite number of ms or null. */
function cleanClock(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * A move path off the wire. One message carries a whole turn — chains
 * included — so the position, the turn, and the clock handover stay atomic.
 * Never trust a peer: this is the one message type that could otherwise hand
 * the engine an out-of-range square. A repeated square is not rejected here —
 * a king capturing around a diamond of pieces legally returns to the square
 * it started from, so path[0] === path[path.length-1] is a real, legal turn.
 * (The length cap still holds: the longest legal chain is 9 captures, path
 * length 10.) The caller matches the path against the engine's own legal
 * moves before applying it, which is strictly stronger than anything this
 * function could check on its own.
 */
function cleanPath(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 12) return null;
  for (const square of value) {
    if (!Number.isInteger(square) || square < 1 || square > 32) return null;
  }
  return value.slice();
}

export class OnlineSession {
  /**
   * @param {{
   *   onStart({myColor, opponentName, role, timeId}): void, // handshake done
   *   onMove({path, clock}): void,
   *   onFlag(color): void,
   *   onResign(): void,
   *   onRematchOffer(): void,
   *   onRematchAccept(): void,
   *   onRematchDecline(): void,
   *   onClose({reason, wasConnected}): void,  // remote or spontaneous end
   *   onError(message): void,
   * }} handlers
   */
  constructor(handlers) {
    this.handlers = handlers;
    this.role = null; // 'host' | 'guest'
    this.myColor = null;
    this.timeId = null; // the host's time control, opaque to this module
    this.opponentName = null;
    this.inviteCode = null;
    this.connected = false;
    this._server = null;
    this._conn = null;
    this._myName = null;
    this._openTimer = 0;
    this._ended = false;
  }

  /** Create a private game. Resolves with the invite code once serving. */
  async host(myColor, timeId) {
    const puter = await loadPuter();
    this.role = 'host';
    this.myColor = myColor;
    this.timeId = cleanTimeId(timeId);
    await ensureSignedIn(puter);
    if (this._ended) return null;
    const server = await puter.peer.serve();
    if (this._ended) {
      // leave() ran while serve() was awaiting (e.g. auth prompt dismissed
      // after the user already cancelled) — don't keep a stray server.
      server.close?.();
      return null;
    }
    this._server = server;
    this.inviteCode = server.inviteCode;
    this._fetchMyName(puter);

    server.addEventListener('connection', (event) => {
      if (this._ended) {
        // The server may outlive leave() (close() support varies); tell late
        // joiners why instead of letting them wait out the open timeout.
        try {
          event.conn.close?.('This game is no longer available.');
        } catch {
          // Nothing to clean up.
        }
        return;
      }
      if (this._conn) {
        // Private 1v1: turn away anyone else using the same invite code.
        event.conn.close('This game already has two players.');
        return;
      }
      this.opponentName = cleanName(event.user?.username);
      this._adopt(event.conn);
    });
    return this.inviteCode;
  }

  /** Join a game created by a friend. */
  async join(inviteCode) {
    const puter = await loadPuter();
    this.role = 'guest';
    await ensureSignedIn(puter);
    if (this._ended) return;
    const conn = await puter.peer.connect(inviteCode);
    if (this._ended) {
      conn.close('Cancelled.');
      return;
    }
    this._fetchMyName(puter);
    this.opponentName = cleanName(conn.owner?.username);
    this._adopt(conn);
  }

  _fetchMyName(puter) {
    // serve()/connect() already authenticated us, so this cannot prompt.
    puter.auth
      .getUser()
      .then((user) => {
        this._myName = user?.username || null;
      })
      .catch(() => {});
  }

  _adopt(conn) {
    // Every listener checks `this._conn === conn` so that a connection the
    // session has already moved past (a host reverting to waiting) can no
    // longer affect it.
    this._conn = conn;
    this._openTimer = setTimeout(() => {
      this._connFailed(conn, 'Could not reach the other player.');
    }, OPEN_TIMEOUT_MS);

    conn.addEventListener('open', () => {
      if (this._ended || this._conn !== conn) return;
      if (this.role === 'host') {
        // The guest plays the other color; handshake completes on 'joined'.
        this._send({
          t: 'start',
          v: PROTOCOL_VERSION,
          color: this.myColor === 'w' ? 'b' : 'w',
          name: this._myName,
          time: this.timeId,
        });
      }
    });
    conn.addEventListener('message', (event) => {
      if (this._conn === conn) this._onMessage(event);
    });
    conn.addEventListener('close', (event) => {
      if (this._conn !== conn) return;
      const reason = event.reason === 'bye' ? 'left' : event.reason;
      // A close with no reason before the handshake only reaches a guest —
      // hosts go back to waiting instead (see _connFailed) — and by far the
      // likeliest cause is a code that is mistyped or no longer being served,
      // so say so rather than reporting a bare failure.
      this._connFailed(
        conn,
        reason ||
          (this.connected
            ? 'left'
            : 'Could not join — check the code and try again.'),
      );
    });
    conn.addEventListener('error', (event) => {
      if (this._conn !== conn) return;
      const detail = event.error?.message || '';
      this.handlers.onError(
        detail ? `Connection error: ${detail}` : 'Connection error.',
      );
    });
  }

  /**
   * A connection ended or timed out. A host whose handshake never completed
   * reverts to waiting for another joiner (the invite code stays valid);
   * anything else ends the session.
   */
  _connFailed(conn, reason) {
    if (this._ended || this._conn !== conn) return;
    if (this.role === 'host' && !this.connected) {
      clearTimeout(this._openTimer);
      try {
        conn.close?.('Connection failed.');
      } catch {
        // Already closed.
      }
      this._conn = null;
      this.opponentName = null;
      this.handlers.onError(
        "That join attempt didn't complete — still waiting for your friend.",
      );
      return;
    }
    this._end(reason);
  }

  _onMessage(event) {
    if (this._ended || typeof event.data !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.t) {
      case 'start': {
        if (this.role !== 'guest' || this.connected) return;
        if (msg.v !== PROTOCOL_VERSION) {
          this._sendBye();
          this._end('Your friend is on a different version of the app — reload and try again.');
          return;
        }
        this.myColor = msg.color === 'w' ? 'w' : 'b';
        this.timeId = cleanTimeId(msg.time);
        this.opponentName = cleanName(msg.name) || this.opponentName;
        this._send({ t: 'joined', name: this._myName });
        this._markConnected();
        break;
      }
      case 'joined': {
        if (this.role !== 'host' || this.connected) return;
        this.opponentName = cleanName(msg.name) || this.opponentName;
        this._markConnected();
        break;
      }
      case 'move': {
        if (!this.connected) break;
        const path = cleanPath(msg.path);
        if (path) {
          this.handlers.onMove({ path, clock: cleanClock(msg.clock) });
        } else {
          // A path this malformed should never come from this app itself —
          // surface it rather than silently dropping the message, which would
          // otherwise leave the mover's board advanced and this side's
          // waiting forever with no explanation.
          this.handlers.onError('Received an invalid move from your opponent.');
        }
        break;
      }
      case 'flag':
        if (this.connected && (msg.color === 'w' || msg.color === 'b')) {
          this.handlers.onFlag(msg.color);
        }
        break;
      case 'resign':
        if (this.connected) this.handlers.onResign();
        break;
      case 'rematch':
        if (this.connected) this.handlers.onRematchOffer();
        break;
      case 'rematch-yes':
        if (this.connected) this.handlers.onRematchAccept();
        break;
      case 'rematch-no':
        if (this.connected) this.handlers.onRematchDecline();
        break;
      case 'bye':
        // A guest backing out before the handshake shouldn't end hosting.
        if (this.role === 'host' && !this.connected) {
          this._connFailed(this._conn, 'left');
        } else {
          this._end('left');
        }
        break;
      default:
        // Unknown message types are ignored for forward compatibility.
        break;
    }
  }

  _markConnected() {
    clearTimeout(this._openTimer);
    this.connected = true;
    this.handlers.onStart({
      myColor: this.myColor,
      opponentName: this.opponentName,
      role: this.role,
      timeId: this.timeId,
    });
  }

  _send(msg) {
    if (!this._conn) return;
    try {
      this._conn.send(JSON.stringify(msg));
    } catch {
      // The close event will surface the failure; nothing useful to do here.
    }
  }

  /** `clock` is our own remaining ms after the turn, or null when untimed. */
  sendMove({ path }, clock = null) {
    this._send({ t: 'move', path, clock });
  }

  /** Report a flag fall. Both sides may send this; `color` is who ran out. */
  sendFlag(color) {
    this._send({ t: 'flag', color });
  }

  sendResign() {
    this._send({ t: 'resign' });
  }

  sendRematchOffer() {
    this._send({ t: 'rematch' });
  }

  sendRematchAccept() {
    this._send({ t: 'rematch-yes' });
  }

  sendRematchDecline() {
    this._send({ t: 'rematch-no' });
  }

  /** Swap colors for a rematch (both peers do this symmetrically). */
  swapColors() {
    this.myColor = this.myColor === 'w' ? 'b' : 'w';
  }

  _sendBye() {
    this._send({ t: 'bye' });
  }

  /** Remote or spontaneous end: tear down and notify once. */
  _end(reason) {
    if (this._ended) return;
    const wasConnected = this.connected;
    this._teardown();
    this.handlers.onClose({ reason, wasConnected });
  }

  /** Local, intentional end (cancel/leave/mode switch): silent teardown. */
  leave() {
    if (this._ended) return;
    this._sendBye();
    this._teardown();
  }

  _teardown() {
    this._ended = true;
    this.connected = false;
    clearTimeout(this._openTimer);
    try {
      this._conn?.close?.('bye');
    } catch {
      // Already closed.
    }
    try {
      this._server?.close?.();
    } catch {
      // Already closed.
    }
    this._conn = null;
    this._server = null;
  }
}

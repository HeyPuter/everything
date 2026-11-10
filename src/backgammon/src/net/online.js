/**
 * Online play over the Puter Peer API (WebRTC data channels with built-in
 * signaling — https://docs.puter.com/Peer/).
 *
 * The Puter SDK is loaded lazily, only when the user enters online mode, so
 * offline play never pays for it. An OnlineSession wraps one private
 * host/guest game: the host serves an invite code, exactly one guest may
 * connect, and both sides exchange JSON messages:
 *
 *   {t:'start', v, color, name, time, cube}
 *                              host -> guest: assigned colour, host's name,
 *                              the time control, and whether the doubling cube
 *                              is in play — all of them the host's to choose
 *   {t:'joined', name}         guest -> host: handshake complete
 *   {t:'commit', h, i}         a roll begins — see "Rolling" below
 *   {t:'entropy', n, i}
 *   {t:'reveal', n, i}
 *   {t:'play', m, clock}       one message per TURN: the whole list of checker
 *                              moves, so the position, the turn, and the clock
 *                              handover stay atomic. `clock` is the mover's own
 *                              remaining ms, so the receiver can correct for
 *                              drift instead of counting them down blind
 *   {t:'double'} / {t:'take'} / {t:'drop'}
 *   {t:'resign'}
 *   {t:'flag', color}          the game ended on time; `color` ran out
 *   {t:'rematch'} / {t:'rematch-yes'} / {t:'rematch-no'}
 *   {t:'bye'}                  sent before an intentional leave
 *
 * ## Rolling
 *
 * Chess and checkers have nothing to agree on but the moves. Backgammon has
 * the dice, and a peer-to-peer game with no server has nobody to throw them.
 * Letting whoever is on roll generate their own numbers is not a game.
 *
 * So each roll is a commit-reveal round, and it takes three messages:
 *
 *   commit   the roller picks a secret and sends only its SHA-256
 *   entropy  the other side answers with a secret of its own, in the clear
 *   reveal   the roller opens its secret; both sides check it against the
 *            commitment and derive the same dice from the pair
 *
 * Neither side can steer the outcome. The roller was committed before it saw
 * the opponent's contribution; the opponent answered without being able to
 * read the roller's. A reveal that does not match its commitment ends the
 * session — there is no innocent way for that to happen.
 *
 * The round counter `i` makes each round single-use, so a message cannot be
 * replayed. What stops a *fresh* round being started to escape a bad roll —
 * or being opened by the wrong side, on a turn whose cube decision it would
 * pre-empt — is the game itself: the controller only accepts dice while it is
 * actually waiting for them and from the side whose roll it is, which is why
 * `onDice` says who opened the round.
 *
 * Sessions are fire-and-forget: leave() tears everything down silently, while
 * remote/spontaneous closure surfaces through onClose exactly once.
 */

import { deriveDice, hashNonce, isNonce, randomNonce } from '../engine/dice.js';

const PUTER_SRC = 'https://js.puter.com/v2/';
// Bumped to 2 when the host began telling the guest whether the cube is in
// play: a peer that did not know about the field would default to its own
// setting, and the two would be playing different games. A mismatch ends the
// session with an explanation, which is the right outcome either way.
const PROTOCOL_VERSION = 2;
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

const isSlot = (n) => Number.isInteger(n) && n >= 0 && n <= 25;
const isDie = (n) => Number.isInteger(n) && n >= 1 && n <= 6;

/**
 * A turn off the wire: up to four checker moves, each `[from, to, die]`.
 * Whether a move hits is deliberately not carried — the receiver's own engine
 * decides that from its own board. Never trust a peer: this is the message
 * that could otherwise hand the engine an out-of-range slot. The caller then
 * matches the whole list against its own legal moves, which is strictly
 * stronger than anything this function could check on its own.
 */
function cleanMoves(value) {
  if (!Array.isArray(value) || value.length > 4) return null;
  const moves = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 3) return null;
    const [from, to, die] = entry;
    if (!isSlot(from) || !isSlot(to) || !isDie(die)) return null;
    moves.push({ from, to, die });
  }
  return moves;
}

const isRound = (n) => Number.isInteger(n) && n >= 0 && n < 100000;

export class OnlineSession {
  /**
   * @param {{
   *   onStart({myColor, opponentName, role, timeId, cubeless}): void,
   *   onDice(dice, rolledHere): void,        // a round settled; did we open it?
   *   onPlay({moves, clock}): void,
   *   onDouble(): void,
   *   onTake(): void,
   *   onDrop(): void,
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
    this.cubeless = false; // the host's choice; a guest is dealt it
    this.opponentName = null;
    this.inviteCode = null;
    this.connected = false;
    this._server = null;
    this._conn = null;
    this._myName = null;
    this._openTimer = 0;
    this._ended = false;
    /** How many commit-reveal rounds have completed; the next one's number. */
    this._rounds = 0;
    /** The round in flight: {side, nonce, hash, theirNonce} or null. */
    this._pendingRoll = null;
  }

  /** Create a private game. Resolves with the invite code once serving. */
  async host(myColor, timeId, cubeless) {
    const puter = await loadPuter();
    this.role = 'host';
    this.myColor = myColor;
    this.timeId = cleanTimeId(timeId);
    this.cubeless = !!cubeless;
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
        // The guest plays the other colour; handshake completes on 'joined'.
        this._send({
          t: 'start',
          v: PROTOCOL_VERSION,
          color: this.myColor === 'w' ? 'b' : 'w',
          name: this._myName,
          time: this.timeId,
          cube: !this.cubeless,
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
          (this.connected ? 'left' : 'Could not join — check the code and try again.'),
      );
    });
    conn.addEventListener('error', (event) => {
      if (this._conn !== conn) return;
      const detail = event.error?.message || '';
      this.handlers.onError(detail ? `Connection error: ${detail}` : 'Connection error.');
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

  /* ---------------------------------------------------------------- */
  /* The dice                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Begin a roll. Called by the side that is about to roll — and, for the
   * opening roll that decides who starts, by the host.
   *
   * Resolves as soon as the commitment is on the wire; the dice themselves
   * arrive later, through `onDice`, once the other side has answered.
   */
  async startRoll() {
    if (!this.connected || this._ended || this._pendingRoll) return;
    const nonce = randomNonce();
    const hash = await hashNonce(nonce);
    if (!this.connected || this._ended || this._pendingRoll) return;
    this._pendingRoll = { side: 'roller', nonce, hash, theirNonce: null };
    this._send({ t: 'commit', h: hash, i: this._rounds });
  }

  /** Is a roll already under way? Used to keep the UI from asking twice. */
  get rolling() {
    return !!this._pendingRoll;
  }

  async _onCommit(msg) {
    if (!this.connected) return;
    if (!isRound(msg.i) || msg.i !== this._rounds) {
      // Either a stale message or an attempt to re-run a round that is
      // already settled. Neither can come from an honest peer.
      this._cheated('Your opponent sent an out-of-order roll.');
      return;
    }
    if (this._pendingRoll) {
      this._cheated('Your opponent tried to roll out of turn.');
      return;
    }
    if (typeof msg.h !== 'string' || !/^[0-9a-f]{64}$/.test(msg.h)) {
      this._cheated('Your opponent sent a malformed roll.');
      return;
    }
    const nonce = randomNonce();
    this._pendingRoll = { side: 'replier', nonce, hash: msg.h, theirNonce: null };
    this._send({ t: 'entropy', n: nonce, i: msg.i });
  }

  async _onEntropy(msg) {
    const round = this._pendingRoll;
    if (!round || round.side !== 'roller' || msg.i !== this._rounds) return;
    if (!isNonce(msg.n)) {
      this._cheated('Your opponent sent a malformed roll.');
      return;
    }
    round.theirNonce = msg.n;
    this._send({ t: 'reveal', n: round.nonce, i: msg.i });
    const dice = await deriveDice(round.nonce, msg.n);
    this._settleRoll(dice);
  }

  async _onReveal(msg) {
    const round = this._pendingRoll;
    if (!round || round.side !== 'replier' || msg.i !== this._rounds) return;
    if (!isNonce(msg.n)) {
      this._cheated('Your opponent sent a malformed roll.');
      return;
    }
    // The whole point of the exchange: the secret must be the one that was
    // committed to before our own contribution was visible.
    if ((await hashNonce(msg.n)) !== round.hash) {
      this._cheated('Your opponent changed the dice after seeing your roll.');
      return;
    }
    const dice = await deriveDice(msg.n, round.nonce);
    this._settleRoll(dice);
  }

  /**
   * A round has produced its dice. Who opened it goes along with them: the
   * protocol only guarantees that the numbers are fair, and whether it was
   * this side's roll to take is for the game to judge.
   */
  _settleRoll(dice) {
    if (this._ended || !this._pendingRoll) return;
    const rolledHere = this._pendingRoll.side === 'roller';
    this._pendingRoll = null;
    this._rounds += 1;
    this.handlers.onDice(dice, rolledHere);
  }

  /** A peer that cannot be playing honestly. Say so plainly, and stop. */
  _cheated(message) {
    this.handlers.onError(message);
    this._sendBye();
    this._end(message);
  }

  /* ---------------------------------------------------------------- */
  /* Messages                                                          */
  /* ---------------------------------------------------------------- */

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
        // Anything but an explicit true means no cube: a guest should end up
        // with the more restrictive game, never a cube its host is not playing.
        this.cubeless = msg.cube !== true;
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
      case 'commit':
        this._onCommit(msg);
        break;
      case 'entropy':
        this._onEntropy(msg);
        break;
      case 'reveal':
        this._onReveal(msg);
        break;
      case 'play': {
        if (!this.connected) break;
        const moves = cleanMoves(msg.m);
        if (moves) {
          this.handlers.onPlay({ moves, clock: cleanClock(msg.clock) });
        } else {
          // A turn this malformed should never come from this app itself —
          // surface it rather than silently dropping the message, which would
          // otherwise leave the mover's board advanced and this side's waiting
          // forever with no explanation.
          this.handlers.onError('Received an invalid move from your opponent.');
        }
        break;
      }
      case 'double':
        if (this.connected) this.handlers.onDouble();
        break;
      case 'take':
        if (this.connected) this.handlers.onTake();
        break;
      case 'drop':
        if (this.connected) this.handlers.onDrop();
        break;
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
      cubeless: this.cubeless,
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
  sendPlay(moves, clock = null) {
    this._send({ t: 'play', m: moves.map((m) => [m.from, m.to, m.die]), clock });
  }

  sendDouble() {
    this._send({ t: 'double' });
  }

  sendTake() {
    this._send({ t: 'take' });
  }

  sendDrop() {
    this._send({ t: 'drop' });
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

  /**
   * Swap colours for a rematch (both peers do this symmetrically) and drop any
   * roll in flight, so the new game's first round starts clean on both sides.
   */
  swapColors() {
    this.myColor = this.myColor === 'w' ? 'b' : 'w';
    this._pendingRoll = null;
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
    this._pendingRoll = null;
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

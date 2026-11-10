import './style.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';

import {
  createIcons,
  Cpu,
  User,
  Users,
  Globe,
  Plus,
  Undo2,
  Trophy,
  Flag,
  Handshake,
  Sun,
  Moon,
  Monitor,
  Copy,
  Check,
  Link,
  LogOut,
  RotateCcw,
  ChevronFirst,
  ChevronLeft,
  ChevronRight,
  ChevronLast,
  ClipboardCopy,
  Download,
} from 'lucide';

import { Checkers, colorOf, isKing } from './engine/checkers.js';
import { chooseMove, LEVELS } from './engine/ai.js';
import { BoardView } from './ui/boardView.js';
import { continuations, nextHops } from './game/chain.js';
import { OnlineSession, loadPuter, whenPuterLoaded } from './net/online.js';
import {
  USER_MENU_TAG,
  inUserMenu,
  mountUserMenu,
  setUserMenuTheme,
} from './ui/userMenu.js';
import { clearGame, loadGame, saveGame } from './game/persistence.js';
import { buildPdn, pdnFilename } from './game/pdn.js';
import {
  Clock,
  DEFAULT_TIME_ID,
  LOW_TIME_MS,
  TIME_CONTROLS,
  formatClock,
  isTimeId,
  speakClock,
  timeControl,
} from './game/clock.js';
import { track } from './analytics.js';

// The full icon set index.html references, across every mode this app plays:
// against the computer, pass & play, and online.
createIcons({
  icons: {
    Cpu,
    User,
    Users,
    Globe,
    Plus,
    Undo2,
    Trophy,
    Flag,
    Handshake,
    Sun,
    Moon,
    Monitor,
    Copy,
    Check,
    Link,
    LogOut,
    RotateCcw,
    ChevronFirst,
    ChevronLeft,
    ChevronRight,
    ChevronLast,
    ClipboardCopy,
    Download,
  },
});

const $ = (id) => document.getElementById(id);

const els = {
  board: $('board'),
  resultBanner: $('result-banner'),
  topbarRight: document.querySelector('.topbar-right'),
  topbarNote: $('topbar-note'),
  modeButtons: document.querySelectorAll('.mode-switch [data-mode]'),
  cardTop: $('card-top'),
  cardBottom: $('card-bottom'),
  topName: $('top-name'),
  topCaption: $('top-caption'),
  bottomName: $('bottom-name'),
  bottomCaption: $('bottom-caption'),
  topIconCpu: document.querySelector('#card-top .icon-cpu'),
  topIconUser: document.querySelector('#card-top .icon-user'),
  capturesTop: $('captures-top'),
  capturesBottom: $('captures-bottom'),
  materialTop: $('material-top'),
  materialBottom: $('material-bottom'),
  clockTop: $('clock-top'),
  clockBottom: $('clock-bottom'),
  movesCard: $('moves-card'),
  movesToggle: $('moves-toggle'),
  movesBody: $('moves-body'),
  moveCount: $('move-count'),
  moveList: $('move-list'),
  movesEmpty: $('moves-empty'),
  reviewFirstBtn: $('review-first-btn'),
  reviewPrevBtn: $('review-prev-btn'),
  reviewNextBtn: $('review-next-btn'),
  reviewLastBtn: $('review-last-btn'),
  reviewNote: $('review-note'),
  pgnCopyBtn: $('pgn-copy-btn'),
  pgnDownloadBtn: $('pgn-download-btn'),
  srStatus: $('sr-status'),
  toast: $('toast'),
  controls: $('controls'),
  fieldRow: $('field-row'),
  levelField: $('level-field'),
  colorField: $('color-field'),
  colorLabel: $('color-label'),
  timeField: $('time-field'),
  levelSelect: $('level-select'),
  colorSelect: $('color-select'),
  timeSelect: $('time-select'),
  buttonRow: $('button-row'),
  newGameBtn: $('new-game-btn'),
  undoBtn: $('undo-btn'),
  rematchBtn: $('rematch-btn'),
  rematchLabel: $('rematch-label'),
  resignBtn: $('resign-btn'),
  leaveBtn: $('leave-btn'),
  controlsHint: $('controls-hint'),
  onlineCard: $('online-card'),
  onlineIdle: $('online-idle'),
  onlineHosting: $('online-hosting'),
  onlineJoining: $('online-joining'),
  onlineInviteNote: $('online-invite-note'),
  onlineError: $('online-error'),
  hostBtn: $('host-btn'),
  hostBtnLabel: $('host-btn-label'),
  joinForm: $('join-form'),
  joinInput: $('join-input'),
  joinBtn: $('join-btn'),
  inviteCode: $('invite-code'),
  copyCodeBtn: $('copy-code-btn'),
  copyLinkBtn: $('copy-link-btn'),
  copyLinkLabel: $('copy-link-label'),
  cancelHostBtn: $('cancel-host-btn'),
  cancelJoinBtn: $('cancel-join-btn'),
  gameoverDialog: $('gameover-dialog'),
  gameoverTitle: $('gameover-title'),
  gameoverSub: $('gameover-sub'),
  gameoverNew: $('gameover-new'),
  gameoverClose: $('gameover-close'),
  gameoverIcons: {
    win: $('gameover-icon-win'),
    loss: $('gameover-icon-loss'),
    draw: $('gameover-icon-draw'),
  },
  confirmDialog: $('confirm-dialog'),
  confirmTitle: $('confirm-title'),
  confirmSub: $('confirm-sub'),
  confirmYes: $('confirm-yes'),
  confirmNo: $('confirm-no'),
  rematchDialog: $('rematch-dialog'),
  rematchSub: $('rematch-sub'),
  rematchAccept: $('rematch-accept'),
  rematchDecline: $('rematch-decline'),
  themeButtons: document.querySelectorAll('.theme-toggle [data-theme-choice]'),
};

const SETTINGS_KEY = 'checkers-settings';
const MODES = ['computer', 'local', 'online'];
const MODE_NOTES = {
  computer: 'Player vs. Computer',
  local: 'Pass & Play',
  online: 'Online Match',
};
/** Clock repaint rate. Tenths are shown when the time is low; this reads them. */
const CLOCK_TICK_MS = 100;
/**
 * How long an opponent's empty clock has to stay empty before this side claims
 * the win. Our copy of their clock runs one network hop ahead of theirs, and a
 * backgrounded tab can hold their move in the queue past the moment they made
 * it, so a flag is never claimed on the instant it appears.
 */
const FLAG_GRACE_MS = 2500;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const game = new Checkers();
let mode = 'computer'; // 'computer' | 'local' | 'online'
let myColor = 'b'; // side controlled at this device (computer & online modes)
let level = 'medium';
let colorSetting = 'b'; // Black moves first, so it is the natural default
let timeSetting = DEFAULT_TIME_ID; // time control for the next game we start
let themeSetting = 'system';
// The move list is a disclosure, closed unless the player has opened it.
// Most people never read the notation, and an empty panel was the largest
// thing in the sidebar. Opening it is remembered; auto-opening is not.
let movesOpen = false;
let thinking = false;
let thinkingLevel = null; // level the in-flight search actually uses
let aiToken = 0;
let manualEnd = null; // {kind,...} for an end the engine can't see: a flag fall

// Clocks. `clock` belongs to the game on the board (an untimed game gets a
// disabled one), and `clockStack` holds each side's time as it stood at the
// start of every ply, which is what undo rewinds to.
let clock = new Clock(null);
let clockTimer = 0;
let clockStack = [];
let flagSeenAt = 0; // when an opponent's clock was first seen empty
let lowAnnounced = { w: false, b: false }; // said "time is low" this game

// True while a piece is still sliding from `boardView.animateMove`/
// `animatePath` for a move already applied to the engine. The engine updates
// synchronously in `game.move()`, but the DOM relocation of the moved piece
// is deferred to the animation's completion callback (see boardView.js) — a
// render that lands in that window finds the destination square empty and
// draws a fresh piece there, and the deferred relocation then drops the
// original element into the same square too. Blocking input for that one
// window is what stops a new render from being triggered inside it.
let busy = false;
let selected = null;
let targets = new Map();
const NO_TARGETS = new Map(); // shared empty map — nothing is pickable while reviewing
const NO_IDLE = new Set(); // shared empty set — no piece is shown as frozen
let pendingToggleOff = false;

// The ply the board is showing while stepping back through a finished (or
// still-live) game: null means "the current position", any other number is
// how many plies of `game.history()` are on screen. The engine's own
// position never moves for this — see positionAt below.
let reviewIndex = null;

// A jump sequence in progress. The engine only applies whole turns, so while
// this is non-empty the board is showing `game.preview(pendingPath)` and the
// engine's own position is still one turn behind the screen.
let pendingPath = [];

// Captured pieces, one entry per ply of `game.history()`, holding the piece
// letters removed that turn. The engine's own Move only records the squares
// a capture cleared (`captured: number[]`), not what stood on them, and that
// is by design — the controller is the only place that cares which piece a
// square held, purely to draw it on the player cards.
let captureLog = [];

let gameOverTimer = 0;
let announcedPlies = 0;
let toastTimer = 0;

// Whether anything is currently in storage, so a game that cannot be saved
// (online, finished, not started) only clears it once instead of every render.
let hasSave = true;

// Online play.
let session = null; // OnlineSession while hosting/joining/playing
let userMenu = null; // the SDK's <puter-user-menu>, once it is in the top bar
let onlineUiState = 'idle'; // 'idle'|'creating'|'hosting'|'joining'|'playing'|'ended'
let onlineReturnState = 'idle'; // where a failed create/join falls back to
let opponentName = null; // kept after the session ends for result text
let rematchOffered = false; // we offered a rematch and await the reply
let rematchAnswered = false; // guards the incoming-offer dialog's close event
let confirmAction = null;
let copyCodeTimer = 0;
let copyLinkTimer = 0;

const colorName = (color) => (color === 'w' ? 'White' : 'Black');
const otherColor = (color) => (color === 'w' ? 'b' : 'w');
const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);
/** The PDN result for a game `winner` won. */
const resultFor = (winner) => (winner === 'w' ? '1-0' : '0-1');

/** The color shown at the bottom of the board. */
function bottomColor() {
  return mode === 'local' ? 'b' : myColor;
}

function gameFinished() {
  return !!manualEnd || game.isGameOver();
}

function opponentLabel() {
  return opponentName || 'Your friend';
}

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/*                                                                     */
/* Three events, each standing for something a player actually got out */
/* of the app: a game played, a game seen through to its end, and two  */
/* people connected for an online match. Everything short of those —   */
/* an invite that is never accepted, a menu opened, a setting changed  */
/* — is intent rather than value, and is deliberately not tracked. A   */
/* rematch needs no event of its own: its first ply reports a Game     */
/* Started like any other. The two flags reset with the board, so undo */
/* and repeated game-over renders cannot double-count.                 */
/* ------------------------------------------------------------------ */

let startTracked = false;
let endTracked = false;

function resetTracking() {
  startTracked = false;
  endTracked = false;
}

/** A reset board is not a game — the first ply is what makes it one. */
function trackGameStart() {
  if (startTracked) return;
  startTracked = true;
  track('Game Started', {
    mode,
    level: mode === 'computer' ? level : null,
    clock: gameTimeId(),
  });
}

function trackGameEnd(end) {
  if (endTracked || game.history().length === 0) return;
  endTracked = true;
  track('Game Completed', { mode, result: end.kind, reason: end.reason });
}

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (stored && LEVELS[stored.level]) level = stored.level;
    if (stored && ['w', 'b', 'random'].includes(stored.color)) colorSetting = stored.color;
    if (stored && isTimeId(stored.time)) timeSetting = stored.time;
    if (stored && ['light', 'dark', 'system'].includes(stored.theme)) {
      themeSetting = stored.theme;
    }
    if (stored && MODES.includes(stored.mode)) mode = stored.mode;
    if (stored && typeof stored.movesOpen === 'boolean') movesOpen = stored.movesOpen;
  } catch {
    // Corrupt or missing settings: keep defaults.
  }
  els.levelSelect.value = level;
  els.colorSelect.value = colorSetting;
  els.timeSelect.value = timeSetting;
}

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        level,
        color: colorSetting,
        time: timeSetting,
        theme: themeSetting,
        mode,
        movesOpen,
      }),
    );
  } catch {
    // Storage unavailable (private browsing, denied permission): settings
    // still apply for this session, they just won't persist.
  }
}

/**
 * Fill the clock picker from TIME_CONTROLS, grouped the way the menu reads
 * (Bullet / Blitz / Rapid). Building it here rather than in the markup keeps
 * the ids that cross the wire and land in saved games in one place.
 */
function buildTimeOptions() {
  const groups = new Map();
  const items = [];
  for (const control of TIME_CONTROLS) {
    const option = document.createElement('option');
    option.value = control.id;
    option.textContent = control.label;
    if (!control.group) {
      items.push(option);
      continue;
    }
    let group = groups.get(control.group);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = control.group;
      groups.set(control.group, group);
      items.push(group);
    }
    group.appendChild(option);
  }
  els.timeSelect.replaceChildren(...items);
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const effective =
    themeSetting === 'system' ? (systemDark.matches ? 'dark' : 'light') : themeSetting;
  document.documentElement.dataset.theme = effective;
  // The theme-color metas pick by OS scheme; when the in-app theme overrides
  // it, keep the browser chrome in sync with the page background.
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute('content', bg);
  }
  for (const button of els.themeButtons) {
    const active = button.dataset.themeChoice === themeSetting;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  }
  setUserMenuTheme(userMenu, themeSetting);
}

systemDark.addEventListener('change', () => {
  if (themeSetting === 'system') applyTheme();
});

/* ------------------------------------------------------------------ */
/* Clocks                                                              */
/*                                                                     */
/* The clock always belongs to the game on the board, and syncClock()   */
/* is what keeps that true: it is idempotent (re-asserting the side     */
/* already running charges nothing), so renderAll can simply call it    */
/* rather than every state change having to remember to.               */
/* ------------------------------------------------------------------ */

/** The id of the time control the game on the board is using. */
function gameTimeId() {
  return clock.control ? clock.control.id : DEFAULT_TIME_ID;
}

/** Put a fresh clock on the board. */
function resetClock(id) {
  clock = new Clock(timeControl(id));
  clockStack = [];
  flagSeenAt = 0;
  lowAnnounced = { w: false, b: false };
}

/** Is either side on the clock right now? */
function clockLive() {
  if (gameFinished()) return false;
  // The clock starts with the first move. Nothing else marks the moment a game
  // is under way — the board is simply there, and picking a control or opening
  // the tab is not the same as sitting down to play — so charging the first
  // mover before a piece has moved would run a clock down while nobody is
  // playing, and could lose a game on time that was never started.
  if (game.history().length === 0) return false;
  if (mode === 'online') return onlineUiState === 'playing' && !!session?.connected;
  return true;
}

function syncClock() {
  clock.setRunning(clockLive() ? game.turn() : null);
  if (clock.running) startClockTimer();
  else stopClockTimer();
}

function startClockTimer() {
  if (!clockTimer) clockTimer = setInterval(onClockTick, CLOCK_TICK_MS);
}

function stopClockTimer() {
  clearInterval(clockTimer);
  clockTimer = 0;
}

function onClockTick() {
  renderClocks();
  announceLowTime();
  const flagged = clock.flagged();
  if (!flagged) {
    flagSeenAt = 0;
    return;
  }
  if (mode === 'online' && flagged !== myColor) {
    if (!flagSeenAt) {
      flagSeenAt = performance.now();
      return;
    }
    if (performance.now() - flagSeenAt < FLAG_GRACE_MS) return;
  }
  handleFlagFall(flagged);
}

/**
 * The clock turning red says "you are nearly out of time" to anyone who can
 * see it; role="timer" is deliberately never announced, so nothing says it to
 * anyone who cannot. Say it once per side, as that side crosses the mark.
 */
function announceLowTime() {
  const running = clock.running;
  if (!running || lowAnnounced[running]) return;
  const ms = clock.remaining(running);
  // Nothing to warn about once the time is actually gone: the flag fall that
  // follows announces itself.
  if (ms <= 0 || ms >= LOW_TIME_MS) return;
  lowAnnounced[running] = true;
  els.srStatus.textContent =
    mode !== 'local' && running === myColor
      ? `Your time is low — ${speakClock(ms)} left.`
      : `${cap(sideName(running))} is low on time — ${speakClock(ms)} left.`;
}

function handleFlagFall(loser) {
  if (gameFinished()) return;
  flagSeenAt = 0;
  clock.setRunning(null);
  stopClockTimer();
  // A search still running would otherwise land a move after the flag fell.
  aiToken++;
  thinking = false;
  if (mode === 'online') session?.sendFlag(loser);
  endGameManually(describeTimeout(loser));
}

/** Running out of time loses. Checkers has no "but they could not have won". */
function describeTimeout(loser) {
  const winner = otherColor(loser);
  const base = { reason: 'timeout', termination: 'time forfeit' };
  const sub = `${cap(sideName(loser))} ran out of time.`;
  if (mode === 'local') {
    return {
      ...base,
      kind: 'win',
      result: resultFor(winner),
      title: `${colorName(winner)} wins`,
      sub,
    };
  }
  return {
    ...base,
    kind: loser === myColor ? 'loss' : 'win',
    result: resultFor(winner),
    title: loser === myColor ? 'You lose' : 'You win',
    sub,
  };
}

/**
 * Move the clock on after `mover` played: remember where it stood so undo can
 * put it back, charge the time they spent, add the increment, and hand over.
 * Returns the mover's remaining ms — what an online peer needs to hear.
 */
function afterPlyApplied(move) {
  clockStack.push(clock.baseline());
  let left = null;
  if (clock.enabled) {
    clock.setRunning(null); // charges the mover for the time they just spent
    if (clock.remaining(move.color) > 0) clock.addIncrement(move.color);
    // Hand over now rather than after the move animation, or every move would
    // hand the other side a few free tenths of a second.
    syncClock();
    left = clock.remaining(move.color);
  }
  trackGameStart();
  return left;
}

/**
 * Take the opponent's word for their own clock, within reason: their reading
 * is exact where ours only estimated it while they were thinking, but a number
 * above anything the time control could have handed them is capped. They can
 * only ever have their starting time plus one increment per move they made.
 */
function applyRemoteClock(color, ms) {
  if (!clock.enabled || typeof ms !== 'number') return;
  const { initial, increment } = clock.control;
  const theirMoves = game.history().reduce((n, m) => n + (m.color === color ? 1 : 0), 0);
  clock.set(color, Math.min(ms, initial + increment * theirMoves));
}

/* ------------------------------------------------------------------ */
/* Reviewing earlier positions                                         */
/* ------------------------------------------------------------------ */

function reviewing() {
  return reviewIndex !== null;
}

/** How many plies the board is showing — the whole game unless reviewing. */
function viewPlies() {
  return reviewIndex === null ? game.history().length : reviewIndex;
}

/** An undo (or a new game) can leave the review index past the last move. */
function clampReview() {
  if (reviewIndex !== null && reviewIndex >= game.history().length) reviewIndex = null;
}

/**
 * The position after `plies` moves of the current game, replayed from the
 * start. A whole game is a few dozen turns and the engine makes short work of
 * them, which is cheaper to keep correct than a cache that would have to be
 * invalidated every time the live game moves on underneath it.
 */
function positionAt(plies) {
  const replay = new Checkers();
  const history = game.history();
  for (let i = 0; i < plies; i++) {
    replay.move({ path: history[i].path });
  }
  return replay;
}

/** How a ply is written in checkers: "12." for Black's move, "12…" for White's. */
function plyLabel(plies) {
  return `${Math.ceil(plies / 2)}${plies % 2 === 1 ? '.' : '…'}`;
}

function goToPly(target) {
  const total = game.history().length;
  const plies = Math.max(0, Math.min(total, target));
  const next = plies === total ? null : plies;
  if (next === reviewIndex) return;
  reviewIndex = next;
  // Stepping into an older position with the panel closed would move the
  // board with nothing on screen naming the move you landed on. Open it —
  // but without remembering, since the player did not ask for it.
  if (next !== null && !movesOpen) setMovesOpen(true, { remember: false });
  // A piece cannot stay picked up, and a jump chain cannot stay pending,
  // across a jump to another position — clearSelection() clears pendingPath
  // too, so a chain in progress can never leave a phantom board behind.
  boardView.cancelDrag();
  clearSelection();
  renderAll();
  announceReview();
}

function announceReview() {
  const plies = viewPlies();
  if (!reviewing()) {
    els.srStatus.textContent = 'Back to the current position.';
  } else if (plies === 0) {
    els.srStatus.textContent = 'Starting position.';
  } else {
    const move = game.history()[plies - 1];
    els.srStatus.textContent = `${colorName(move.color)} played ${move.pdn}. Reviewing.`;
  }
}

/* ------------------------------------------------------------------ */
/* Saving a game in progress                                           */
/* ------------------------------------------------------------------ */

/**
 * Keep storage in step with the board. Called from renderAll, so no state
 * change can forget to; also called when the page is hidden or leaving, which
 * is the only way a clock reading taken mid-move gets stored.
 *
 * A jump chain in progress is never saved, and needs no code here to arrange
 * that: the engine applies only whole turns, so `game.history()` already
 * holds nothing but completed ones while a chain lives in `pendingPath`. A
 * save taken mid-chain naturally records only the turns finished so far, and
 * a reload resumes at the start of the turn the chain belonged to — a legal
 * position, with the capture still compulsory.
 */
function saveNow() {
  if (mode === 'online' || gameFinished() || game.history().length === 0) {
    // Nothing worth resuming: an online game cannot outlive its connection, a
    // finished one should not greet the player as if it were still going, and
    // an untouched board is what a fresh visit gets anyway.
    if (hasSave) {
      clearGame();
      hasSave = false;
    }
    return;
  }
  saveGame({
    mode,
    myColor,
    time: gameTimeId(),
    moves: game.history().map((m) => m.path),
    clock: clock.enabled ? clock.snapshot() : null,
    clockStack: clock.enabled ? clockStack : [],
  });
  hasSave = true;
}

/**
 * Put back the game stored by an earlier visit. Returns false when there is
 * nothing to restore, or when what is there doesn't replay — in which case
 * the caller starts a new game as usual.
 */
function restoreGame() {
  const saved = loadGame();
  if (!saved || saved.mode !== mode) return false;

  let ok = true;
  const captures = [];
  try {
    game.reset();
    for (const path of saved.moves) {
      // Read off what each captured square held before applying the move —
      // once applied, those squares are empty and the piece is lost for good.
      const legal = game
        .moves({ square: path[0] })
        .find((m) => m.path.length === path.length && m.path.every((sq, i) => sq === path[i]));
      if (!legal) {
        ok = false;
        break;
      }
      captures.push(legal.captured.map((sq) => game.get(sq)));
      if (!game.move({ path })) {
        ok = false;
        break;
      }
    }
  } catch {
    ok = false; // malformed squares throw inside the engine
  }
  // Finished games are not stored, so one showing up here means the save was
  // written by something else; don't trust the rest of it either.
  if (ok && game.isGameOver()) ok = false;
  if (!ok) {
    game.reset();
    clearGame();
    hasSave = false;
    return false;
  }

  aiToken++;
  thinking = false;
  myColor = saved.myColor;
  manualEnd = null;
  reviewIndex = null;
  captureLog = captures;
  resetClock(saved.time);
  if (clock.enabled && saved.clock) clock.restore(saved.clock);
  if (clock.enabled) clockStack = saved.clockStack.map((c) => ({ ...c }));
  // A stored game has moves, so it was already counted as started.
  resetTracking();
  startTracked = true;
  clearSelection();
  clearTimeout(gameOverTimer);
  closeDialogs();
  boardView.setOrientation(bottomColor());
  announcedPlies = game.history().length;
  els.srStatus.textContent =
    mode === 'local'
      ? `Game restored. ${colorName(game.turn())} to move.`
      : `Game restored. You play ${colorName(myColor)}.`;
  renderAll();
  showToast('Picked up where you left off.');
  if (mode === 'computer' && game.turn() !== myColor) computerTurn();
  return true;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

const boardView = new BoardView(els.board, { onSquarePress, onDrop, onSquareActivate });

/**
 * Flip the busy flag and mirror it onto the board as a class, so the cursor
 * (and any other CSS hooked off it) reflects that nothing is clickable while
 * a move is still animating. Every caller of `boardView.animateMove`/
 * `animatePath` below sets this true immediately before the call and false
 * as the first thing inside the completion callback — including the
 * reduced-motion and no-piece-found fallbacks inside boardView, since those
 * still always invoke the same callback exactly once.
 */
function setBusy(value) {
  busy = value;
  els.board.classList.toggle('busy', busy);
}

function renderAll() {
  // An undo (or a new game) can leave the review index dangling; settle that
  // before anything below reads it.
  clampReview();
  // Before anything is drawn, so the clocks are painted in the state they are
  // actually in rather than the one they were in a moment ago.
  syncClock();
  const plies = viewPlies();
  const live = !reviewing();
  const status = game.status();
  const last = game.lastMove();
  // The board shows the position being reviewed; everything that describes
  // the game as it stands — the player cards, the clocks, the result — stays
  // live. While live, a jump chain in progress previews ahead of the engine's
  // own position (preview() draws it); while reviewing, pendingPath is always
  // empty (goToPly clears it), so the position is simply replayed from move
  // zero.
  let shownBoard;
  let shownLast;
  if (live) {
    shownBoard = pendingPath.length ? game.preview(pendingPath) : game.board();
    shownLast = last;
  } else {
    const replay = positionAt(plies);
    shownBoard = replay.board();
    shownLast = replay.lastMove();
  }
  boardView.render({
    board: shownBoard,
    selected: live ? selected : null,
    targets: live ? targets : NO_TARGETS,
    lastMove: shownLast
      ? { from: shownLast.path[0], to: shownLast.path[shownLast.path.length - 1] }
      : null,
    chained: live && pendingPath.length ? pendingPath[pendingPath.length - 1] : null,
    idle: live ? idleSquares(status) : NO_IDLE,
  });
  els.board.classList.toggle('reviewing', !live);

  renderPlayers(status);
  renderClocks();
  renderCaptures(plies);
  renderMoves(plies);
  renderReviewBar(plies);
  renderBanner(status);
  announceState(status, last);

  els.undoBtn.disabled = !canUndo();
  updateModeUi();
  saveNow();
}

/** Undo takes back a whole turn, so it is off while a jump is half-played. */
function canUndo() {
  if (busy) return false; // a move is still animating — nothing to take back onto yet
  if (pendingPath.length) return false; // no half-turn to take back
  if (mode === 'online' || reviewing()) return false; // no taking back a real opponent's turn
  if (mode === 'computer') {
    return !thinking && game.history().some((m) => m.color === myColor);
  }
  return game.history().length > 0;
}

/** Name of the side that owns `color`, as spoken to this device's player. */
function moverName(color) {
  if (mode === 'local') return colorName(color);
  if (color === myColor) return 'You';
  return mode === 'computer' ? 'Computer' : opponentName || 'Opponent';
}

/**
 * How to name the player of `color` inside a sentence. Lower case, so callers
 * can place it mid-sentence and capitalize it when it comes first.
 */
function sideName(color) {
  if (mode === 'local') return colorName(color);
  if (color === myColor) return 'you';
  return mode === 'computer' ? 'the computer' : opponentLabel();
}

/** Tell assistive technology about moves and game results. */
function announceState(status, lastMove) {
  const plies = game.history().length;
  if (plies === announcedPlies) return;
  let text;
  if (plies < announcedPlies) {
    text = 'Move taken back.';
  } else {
    text = `${moverName(lastMove.color)} played ${lastMove.pdn}.`;
    if (status.over) {
      const end = describeEnd(status);
      text += ` ${end.title} — ${end.sub}`;
    }
  }
  announcedPlies = plies;
  els.srStatus.textContent = text;
}

/** A hop landed but the sequence is not over — the piece stays locked. */
function announceChain() {
  els.srStatus.textContent = 'Capture available — the jump must continue.';
}

function renderPlayers(status) {
  const bottom = bottomColor();
  const top = otherColor(bottom);
  const finished = gameFinished();

  let topIsCpu = false;
  if (mode === 'computer') {
    topIsCpu = true;
    els.topName.textContent = 'Computer';
    els.topCaption.textContent = thinking
      ? `${LEVELS[thinkingLevel].label} · thinking`
      : LEVELS[level].label;
    els.bottomName.textContent = 'You';
    els.bottomCaption.textContent = `Playing ${colorName(bottom)}`;
  } else if (mode === 'local') {
    els.topName.textContent = colorName(top);
    els.topCaption.textContent = MODE_NOTES.local;
    els.bottomName.textContent = colorName(bottom);
    els.bottomCaption.textContent = MODE_NOTES.local;
  } else {
    // Opponent names come off the wire — textContent only, never innerHTML.
    els.topName.textContent = opponentName || 'Opponent';
    els.topCaption.textContent = `Playing ${colorName(top)} · ${
      session?.connected ? 'connected' : 'disconnected'
    }`;
    els.bottomName.textContent = 'You';
    els.bottomCaption.textContent = `Playing ${colorName(bottom)}`;
  }
  els.topIconCpu?.classList.toggle('hidden', !topIsCpu);
  els.topIconUser?.classList.toggle('hidden', topIsCpu);

  els.cardTop.classList.toggle('thinking', mode === 'computer' && thinking);
  els.cardTop.classList.toggle('active', !finished && status.turn === top);
  els.cardBottom.classList.toggle('active', !finished && status.turn === bottom);
}

/** Plural-safe "N man"/"N men"/"N king"/"N kings". */
function countWord(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural}`;
}

function renderCaptures(plies) {
  const bottom = bottomColor();
  const byBottom = [];
  const byTop = [];
  const history = game.history();
  // Only what has been captured in the position on the board, so a reviewed
  // position and the pieces beside it describe the same moment.
  for (let i = 0; i < plies; i++) {
    const taken = captureLog[i];
    if (!taken || taken.length === 0) continue;
    (history[i].color === bottom ? byBottom : byTop).push(...taken);
  }
  const fill = (capEl, countEl, pieces) => {
    // Kings first: the rarer, more valuable piece leads the row.
    const sorted = pieces.slice().sort((a, b) => Number(isKing(b)) - Number(isKing(a)));
    capEl.replaceChildren(
      ...sorted.map((piece) => {
        const badge = document.createElement('span');
        badge.className = 'cap';
        badge.dataset.piece = colorOf(piece);
        badge.setAttribute('aria-hidden', 'true'); // the count beside it speaks for these
        return badge;
      }),
    );
    const men = pieces.filter((p) => !isKing(p)).length;
    const kings = pieces.length - men;
    const parts = [];
    if (men) parts.push(countWord(men, 'man', 'men'));
    if (kings) parts.push(countWord(kings, 'king', 'kings'));
    countEl.textContent = parts.join(', ');
  };
  fill(els.capturesBottom, els.materialBottom, byBottom);
  fill(els.capturesTop, els.materialTop, byTop);
}

/**
 * Open or close the move list. `remember` is false when the app opens it on
 * the player's behalf (entering review, where the panel holds the only words
 * describing which position is on the board) — that should not overwrite a
 * preference the player set deliberately.
 */
function setMovesOpen(open, { remember = true } = {}) {
  if (movesOpen === open) return;
  movesOpen = open;
  if (remember) saveSettings();
  renderAll();
}

function renderMovesDisclosure(history) {
  els.movesCard.classList.toggle('collapsed', !movesOpen);
  els.movesToggle.setAttribute('aria-expanded', String(movesOpen));
  // A closed row that just said "Moves" would read as an empty panel; the
  // count is what tells you there is something behind it.
  els.moveCount.textContent =
    movesOpen || history.length === 0 ? '' : `${Math.ceil(history.length / 2)}`;
}

function renderMoves(plies) {
  const history = game.history();
  renderMovesDisclosure(history);
  if (!movesOpen) return; // nothing below is visible, and none of it is cheap
  els.movesEmpty.classList.toggle('hidden', history.length > 0);
  // Which ply holds the keyboard. The list is rebuilt whole, so without this a
  // move activated from it — or one arriving from a computer reply — would
  // drop focus to the top of the page, and the next Tab would start over.
  const focusedPly =
    els.moveList.contains(document.activeElement) && document.activeElement.dataset.ply;
  const rows = [];
  for (let i = 0; i < history.length; i += 2) {
    const row = document.createElement('li');
    row.className = 'move-row';
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = `${i / 2 + 1}.`;
    row.appendChild(num);
    for (const j of [i, i + 1]) {
      const move = history[j];
      if (!move) {
        // Black has moved and White has not: a blank that holds the column.
        row.appendChild(Object.assign(document.createElement('span'), { className: 'ply' }));
        continue;
      }
      const ply = document.createElement('button');
      ply.type = 'button';
      ply.className = 'ply';
      ply.textContent = move.pdn;
      ply.dataset.ply = String(j + 1);
      ply.setAttribute(
        'aria-label',
        `${colorName(move.color)} move ${Math.ceil((j + 1) / 2)}, ${move.pdn}`,
      );
      // The position on the board — the latest move while playing, the one
      // being reviewed while stepping back through the game.
      if (j + 1 === plies) {
        ply.classList.add('current');
        ply.setAttribute('aria-current', 'true');
      }
      row.appendChild(ply);
    }
    rows.push(row);
  }
  els.moveList.replaceChildren(...rows);
  // Put the keyboard back on the same ply. Scrolling is left to the line
  // below, which knows which move the board is showing.
  if (focusedPly) {
    els.moveList
      .querySelector(`button.ply[data-ply="${focusedPly}"]`)
      ?.focus({ preventScroll: true });
  }
  scrollMoveIntoView();
}

/**
 * Keep the move on the board in sight: at the bottom of the list while the
 * game is live, and inside the visible rows while reviewing. Scrolling is
 * measured against the list's own box so that it, and never an ancestor, is
 * what moves.
 */
function scrollMoveIntoView() {
  const list = els.moveList;
  if (!reviewing()) {
    list.scrollTop = list.scrollHeight;
    return;
  }
  const current = list.querySelector('.ply.current');
  if (!current) {
    list.scrollTop = 0; // the starting position, above the first move
    return;
  }
  const box = list.getBoundingClientRect();
  const rect = current.getBoundingClientRect();
  if (rect.top < box.top) list.scrollTop += rect.top - box.top;
  else if (rect.bottom > box.bottom) list.scrollTop += rect.bottom - box.bottom;
}

function renderClocks() {
  const shown = clock.enabled;
  els.clockTop.classList.toggle('hidden', !shown);
  els.clockBottom.classList.toggle('hidden', !shown);
  if (!shown) return;
  const bottom = bottomColor();
  const pairs = [
    [els.clockTop, otherColor(bottom)],
    [els.clockBottom, bottom],
  ];
  for (const [el, color] of pairs) {
    const ms = clock.remaining(color);
    const text = formatClock(ms);
    // This runs ten times a second; don't touch the DOM when nothing moved.
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('running', clock.running === color);
    el.classList.toggle('low', ms < LOW_TIME_MS);
    el.classList.toggle('out', ms <= 0);
  }
}

function renderReviewBar(plies) {
  const total = game.history().length;
  // Disabling the focused button blurs it there and then, so note where the
  // keyboard was before the flags below can take it away.
  const focused = document.activeElement;
  els.reviewFirstBtn.disabled = plies === 0;
  els.reviewPrevBtn.disabled = plies === 0;
  els.reviewNextBtn.disabled = plies >= total;
  els.reviewLastBtn.disabled = plies >= total;
  els.pgnCopyBtn.disabled = total === 0;
  els.pgnDownloadBtn.disabled = total === 0;
  keepReviewFocus(focused);
  if (!reviewing()) {
    els.reviewNote.textContent = '';
  } else if (plies === 0) {
    els.reviewNote.textContent = 'Reviewing the start';
  } else {
    els.reviewNote.textContent = `Reviewing ${plyLabel(plies)} ${game.history()[plies - 1].pdn}`;
  }
}

/**
 * Reaching either end of the game disables the button that got you there —
 * both of them, since first/prev and next/last go dark together. Hand the
 * keyboard to the pair that still leads somewhere, rather than let it fall to
 * the top of the page halfway through stepping over a game.
 */
function keepReviewFocus(focused) {
  const pairs = [
    [els.reviewFirstBtn, els.reviewNextBtn],
    [els.reviewPrevBtn, els.reviewNextBtn],
    [els.reviewNextBtn, els.reviewPrevBtn],
    [els.reviewLastBtn, els.reviewPrevBtn],
  ];
  for (const [button, fallback] of pairs) {
    if (focused === button && button.disabled && !fallback.disabled) {
      fallback.focus({ preventScroll: true });
      return;
    }
  }
}

/**
 * Describe a game the engine has called. Checkers has no checkmate: a side
 * with no legal move simply loses, and `reason` names the other two ways a
 * game ends on its own. `result` and `termination` are the PDN spellings of
 * the same thing, for the export; every end the app makes up itself (a flag
 * fall) carries them too, so the exporter never has to work out what
 * happened.
 */
function describeEnd(status) {
  if (status.reason === 'no moves') {
    const winner = status.result === '1-0' ? 'w' : 'b';
    const base = {
      kind: 'win',
      reason: 'no moves',
      result: status.result,
      termination: 'normal',
    };
    if (mode === 'local') {
      return {
        ...base,
        title: `${colorName(winner)} wins`,
        sub: `${colorName(otherColor(winner))} has no legal move.`,
      };
    }
    const iWon = winner === myColor;
    return {
      ...base,
      kind: iWon ? 'win' : 'loss',
      title: iWon ? 'You win' : 'You lose',
      sub: iWon
        ? mode === 'online'
          ? `${opponentLabel()} has no legal move.`
          : 'The computer has no legal move.'
        : 'You have no legal move.',
    };
  }
  const reasons = {
    'threefold repetition': 'The same position occurred three times.',
    '40-move rule': 'Forty turns passed with no capture or man move.',
  };
  return {
    kind: 'draw',
    reason: status.reason,
    result: status.result,
    termination: 'normal',
    title: 'Draw',
    sub: reasons[status.reason] || 'Drawn position.',
  };
}

/** How the game on the board ended, or null while it is still going. */
function currentEnd() {
  if (manualEnd) return manualEnd;
  const status = game.status();
  return status.over ? describeEnd(status) : null;
}

// Fills in the result text and color; whether it is on screen at all is this
// function's call too, so an unfinished game shows nothing. A manual end (a
// flag fall) outranks whatever the engine itself would say, since the engine
// never saw it happen.
function renderBanner(status) {
  const end = manualEnd || (status.over ? describeEnd(status) : null);
  els.resultBanner.className = end ? `result-banner ${end.kind}` : 'result-banner hidden';
  els.resultBanner.textContent = end ? `${end.title} · ${end.sub}` : '';
}

function showEnd(end) {
  trackGameEnd(end);
  els.gameoverTitle.textContent = end.title;
  els.gameoverSub.textContent = end.sub;
  for (const [kind, el] of Object.entries(els.gameoverIcons)) {
    el.classList.toggle('shown', kind === end.kind);
  }
  clearTimeout(gameOverTimer);
  gameOverTimer = setTimeout(() => {
    if (!els.gameoverDialog.open) els.gameoverDialog.showModal();
  }, 450);
}

/** End the game for a reason the engine cannot see: running out of time, a
 *  resignation, a flag fall, or an opponent walking away. */
function endGameManually(end) {
  manualEnd = end;
  clearSelection();
  // A confirm dialog opened before the game ended (e.g. our own pending
  // resign) is now stale — acting on it could overwrite this result.
  closeDialogs();
  els.srStatus.textContent = `${end.title} — ${end.sub}`;
  renderAll();
  showEnd(end);
}

function showToast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 4000);
}

/* ------------------------------------------------------------------ */
/* Mode-dependent chrome                                               */
/* ------------------------------------------------------------------ */

function updateModeUi() {
  for (const button of els.modeButtons) {
    const active = button.dataset.mode === mode;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  }
  els.topbarNote.textContent = MODE_NOTES[mode];

  const online = mode === 'online';
  const showIdle = online && ['idle', 'creating', 'ended'].includes(onlineUiState);
  els.onlineCard.classList.toggle('hidden', !online || onlineUiState === 'playing');
  els.onlineIdle.classList.toggle('hidden', !showIdle);
  els.onlineHosting.classList.toggle('hidden', onlineUiState !== 'hosting');
  els.onlineJoining.classList.toggle('hidden', onlineUiState !== 'joining');

  const creating = onlineUiState === 'creating';
  els.hostBtn.disabled = creating;
  els.hostBtnLabel.textContent = creating ? 'Creating…' : 'Create game';
  els.joinInput.disabled = creating;
  els.joinBtn.disabled = creating;

  // The board-side cards only make sense once an online game exists. The
  // result banner goes with them: while the setup panel is up, a leftover
  // "You win" would read as a verdict on the game being arranged.
  const showGame = !online || onlineUiState === 'playing' || onlineUiState === 'ended';
  els.cardTop.classList.toggle('hidden', !showGame);
  els.cardBottom.classList.toggle('hidden', !showGame);
  els.movesCard.classList.toggle('hidden', !showGame);
  els.resultBanner.classList.toggle('hidden', !showGame || !els.resultBanner.textContent);

  // Difficulty and color only mean anything against the computer; pass &
  // play always seats Black at the bottom with both sides human. Only the
  // host of an online game picks a color and a clock — a guest is dealt both.
  const showLevel = mode === 'computer';
  const showColor = mode === 'computer' || showIdle;
  const showTime = !online || showIdle;
  els.levelField.classList.toggle('hidden', !showLevel);
  els.colorField.classList.toggle('hidden', !showColor);
  els.colorLabel.textContent = online ? 'You play' : 'Play as';
  els.timeField.classList.toggle('hidden', !showTime);
  els.fieldRow.classList.toggle('hidden', !(showLevel || showColor || showTime));
  if (online) {
    els.controlsHint.textContent =
      'Color and clock apply to games you create, not ones you join.';
  } else if (showColor) {
    els.controlsHint.textContent = 'Color and clock take effect when a new game starts.';
  } else {
    els.controlsHint.textContent = 'The clock takes effect when a new game starts.';
  }
  els.controlsHint.classList.toggle('hidden', !(showColor || showTime));

  const finished = gameFinished();
  const playingOnline = online && onlineUiState === 'playing' && !!session?.connected;
  els.newGameBtn.classList.toggle('hidden', online);
  els.undoBtn.classList.toggle('hidden', online);
  els.resignBtn.classList.toggle('hidden', !(playingOnline && !finished));
  els.rematchBtn.classList.toggle('hidden', !(playingOnline && finished));
  els.leaveBtn.classList.toggle('hidden', !playingOnline);
  els.rematchBtn.disabled = rematchOffered;
  els.rematchLabel.textContent = rematchOffered ? 'Rematch offered…' : 'Rematch';
  els.buttonRow.classList.toggle('hidden', online && !playingOnline);
  els.controls.classList.toggle('hidden', online && !playingOnline && !showIdle);

  els.gameoverNew.textContent = online ? 'Rematch' : 'New game';
  els.gameoverNew.classList.toggle('hidden', online && !session?.connected);
  els.gameoverNew.disabled = online && rematchOffered;
}

function setOnlineError(message) {
  els.onlineError.textContent = message;
  els.onlineError.hidden = !message;
}

/* ------------------------------------------------------------------ */
/* Interaction                                                         */
/* ------------------------------------------------------------------ */

function clearSelection() {
  boardView.cancelDrag();
  selected = null;
  targets = new Map();
  pendingToggleOff = false;
  pendingPath = [];
}

/** Squares the player may press right now, mapped to "is this a capture". */
function targetsFor(square) {
  if (pendingPath.length === 0) return nextHops(game.moves({ square }), 1);
  return nextHops(
    continuations(game.moves({ square: pendingPath[0] }), pendingPath),
    pendingPath.length,
  );
}

/** The color the person at this device may pick up right now, or null. */
function movableColorNow() {
  // An older position is a picture of the game, not a place to play from.
  if (reviewing() || gameFinished()) return null;
  if (mode === 'computer') return thinking ? null : myColor;
  if (mode === 'local') return game.turn(); // pass & play: whoever's turn it is
  return session?.connected && onlineUiState === 'playing' ? myColor : null;
}

/**
 * Squares holding a piece of the side to move that has no legal move, but
 * only while a capture is compulsory.
 *
 * That restriction is the point. Forced capture is the rule newcomers are
 * caught by: a jump anywhere on the board freezes every piece that cannot
 * take, and twelve identical men give no sign of which one that leaves. In an
 * ordinary position a stuck piece is stuck behind neighbours the player can
 * already see, so fading half the board there would be noise rather than
 * information.
 *
 * A chain in progress is its own, louder signal (the pulsing ring), and the
 * board is not the mover's to touch at all while the computer or an opponent
 * is thinking — neither case wants this.
 */
function idleSquares(status) {
  if (!status.mustCapture || pendingPath.length) return NO_IDLE;
  if (movableColorNow() !== status.turn) return NO_IDLE;
  const movers = new Set(game.moves().map((m) => m.path[0]));
  const board = game.board();
  const idle = new Set();
  for (let square = 1; square <= 32; square++) {
    const piece = board[square];
    if (piece && colorOf(piece) === status.turn && !movers.has(square)) {
      idle.add(square);
    }
  }
  return idle;
}

/** Can the person at this device pick this piece up at all? */
function pickable(square) {
  return game.moves({ square }).length > 0;
}

function onSquarePress(square, event) {
  if (busy) return; // a move is still animating — see setBusy's doc comment
  const movable = movableColorNow();
  if (!movable) return;
  if (selected && targets.has(square)) {
    attemptMove(selected, square, { animate: true });
    return;
  }
  // A jump sequence is compulsory: nothing but its next hop is pickable.
  if (pendingPath.length) return;
  const piece = game.get(square);
  if (piece && colorOf(piece) === movable && game.turn() === movable) {
    // A piece with nothing to play is not worth picking up — and saying why
    // matters most when a compulsory capture elsewhere is what froze it.
    if (!pickable(square)) {
      showToast(
        game.status().mustCapture
          ? 'A capture is available, so it has to be played.'
          : 'That piece has no legal move.',
      );
      return;
    }
    pendingToggleOff = selected === square;
    selected = square;
    targets = targetsFor(square);
    renderAll();
    boardView.startDrag(square, event);
  } else if (selected) {
    clearSelection();
    renderAll();
  }
}

// Keyboard activation (Enter/Space on a focused square): same semantics as a
// pointer press, minus the drag, and pressing the selected square deselects.
function onSquareActivate(square) {
  if (busy) return; // a move is still animating — see setBusy's doc comment
  const movable = movableColorNow();
  if (!movable) return;
  if (selected && targets.has(square)) {
    attemptMove(selected, square, { animate: true });
    return;
  }
  if (pendingPath.length) return;
  if (selected === square) {
    clearSelection();
    renderAll();
    return;
  }
  const piece = game.get(square);
  if (piece && colorOf(piece) === movable && game.turn() === movable) {
    if (!pickable(square)) {
      showToast(
        game.status().mustCapture
          ? 'A capture is available, so it has to be played.'
          : 'That piece has no legal move.',
      );
      return;
    }
    selected = square;
    targets = targetsFor(square);
    renderAll();
  } else if (selected) {
    clearSelection();
    renderAll();
  }
}

function onDrop(from, to, moved) {
  if (busy) return; // a move is still animating — see setBusy's doc comment
  if (to && to !== from && targets.has(to)) {
    // The piece is already at the destination — the user dragged it there —
    // so animating the move again would slide it back to its origin first.
    attemptMove(from, to, { animate: false });
    return;
  }
  if (to === from && !moved && pendingToggleOff) {
    clearSelection();
  }
  renderAll();
}

/**
 * Pressing a target square either advances the chain or commits the turn.
 * `path` is every square visited so far this turn — the whole pending
 * sequence plus the one just pressed — and `continuations` narrows the
 * engine's complete turns down to the ones that still match it.
 *
 * `animate` is false only from `onDrop`: the piece is already sitting on the
 * destination square (the user dragged it there), so sliding it again would
 * first make it reappear on its origin square and then replay the move —
 * see boardView's `animateMove` doc comment on `keepPiece`/relocation. The
 * press and keyboard paths still animate, since nothing has moved yet there.
 */
function attemptMove(from, to, { animate }) {
  const path = pendingPath.length ? [...pendingPath, to] : [from, to];
  const candidates = continuations(game.moves({ square: path[0] }), path);
  if (candidates.length === 0) {
    clearSelection();
    renderAll();
    return;
  }
  // Exactly one legal turn ends here: commit it. Otherwise the sequence
  // continues and the piece stays locked. Forced capture means these two
  // cases never overlap — see tests/chain.test.js.
  const complete = candidates.find((m) => m.path.length === path.length);
  const legFrom = path[path.length - 2];
  if (!complete) {
    // The chain continues: the engine's own position does not move yet, so
    // the clock must not either. afterPlyApplied belongs only to the branch
    // below, once per turn, never once per hop.
    pendingPath = path;
    selected = to;
    targets = targetsFor(to);
    const proceed = () => {
      setBusy(false);
      renderAll();
      announceChain();
    };
    if (animate) {
      setBusy(true);
      boardView.animateMove(legFrom, to, proceed, { keepPiece: true });
    } else {
      // Nothing to slide — the piece is already on `to` — and nothing here
      // is asynchronous, so there is no window for `busy` to guard.
      proceed();
    }
    return;
  }
  const taken = complete.captured.map((sq) => game.get(sq));
  const played = game.move({ path: complete.path });
  if (!played) {
    clearSelection();
    renderAll();
    return;
  }
  captureLog.push(taken);
  // The clock has to change hands before the move is sent to a peer, so the
  // peer is told what our clock actually reads after the move.
  const left = afterPlyApplied(played);
  if (mode === 'online') session?.sendMove(played, left);
  clearSelection();
  const proceed = () => {
    setBusy(false);
    renderAll();
    afterMove();
  };
  if (animate) {
    setBusy(true);
    boardView.animateMove(legFrom, to, proceed, { keepPiece: true });
  } else {
    proceed();
  }
}

function afterMove() {
  const status = game.status();
  if (status.over) {
    renderAll();
    showEnd(describeEnd(status));
    return;
  }
  if (mode === 'computer' && game.turn() !== myColor) {
    computerTurn();
  }
}

function computerTurn() {
  thinking = true;
  thinkingLevel = level;
  renderAll();
  const token = ++aiToken;
  chooseMove(game, thinkingLevel).then((reply) => {
    if (token !== aiToken || mode !== 'computer') return;
    thinking = false;
    if (!reply) {
      renderAll();
      return;
    }
    const taken = reply.captured.map((sq) => game.get(sq));
    const played = game.move({ path: reply.path });
    if (!played) {
      renderAll();
      return;
    }
    captureLog.push(taken);
    afterPlyApplied(played); // also counts the game as started: the computer
                              // opens when the player chose Black
    // The computer plays a whole turn at once, so its reply animates hop by
    // hop rather than as one square-to-square slide.
    setBusy(true);
    showPath(reply.path, () => {
      setBusy(false);
      renderAll();
      const status = game.status();
      if (status.over) showEnd(describeEnd(status));
    });
  });
}

/**
 * Animate a whole jump chain arriving as a finished turn — a computer reply
 * or a remote move — and then re-render. While an older position is on the
 * board there is nothing to slide: the move has landed in the game, but not
 * in what the player is looking at.
 */
function showPath(path, done) {
  if (reviewing()) done();
  else boardView.animatePath(path, done);
}

/* ------------------------------------------------------------------ */
/* Confirm dialog                                                      */
/* ------------------------------------------------------------------ */

function askConfirm({ title, sub, confirmLabel }, onConfirm) {
  confirmAction = onConfirm;
  els.confirmTitle.textContent = title;
  els.confirmSub.textContent = sub;
  els.confirmYes.textContent = confirmLabel;
  els.confirmDialog.showModal();
}

function closeDialogs() {
  rematchAnswered = true; // closing the offer dialog here must not send a decline
  if (els.gameoverDialog.open) els.gameoverDialog.close();
  if (els.confirmDialog.open) els.confirmDialog.close();
  if (els.rematchDialog.open) els.rematchDialog.close();
}

/* ------------------------------------------------------------------ */
/* Game flow controls                                                  */
/* ------------------------------------------------------------------ */

function newGame() {
  if (mode === 'online') return; // online games start via the session flow
  aiToken++;
  thinking = false;
  setBusy(false); // an escape hatch: a fresh game must never inherit a stuck board
  myColor =
    mode === 'computer'
      ? colorSetting === 'random'
        ? Math.random() < 0.5
          ? 'w'
          : 'b'
        : colorSetting
      : 'b';
  manualEnd = null;
  reviewIndex = null;
  game.reset();
  resetClock(timeSetting);
  captureLog = [];
  resetTracking();
  clearSelection();
  clearTimeout(gameOverTimer);
  closeDialogs();
  boardView.setOrientation(bottomColor());
  announcedPlies = 0;
  els.srStatus.textContent =
    mode === 'local' ? 'New game. Black to move.' : `New game. You play ${colorName(myColor)}.`;
  renderAll();
  if (mode === 'computer' && game.turn() !== myColor) computerTurn();
}

/** Protect an unfinished game from an accidental press of New game. */
function requestNewGame() {
  if (mode === 'online') return;
  if (gameFinished() || (game.history().length === 0 && pendingPath.length === 0)) {
    newGame();
    return;
  }
  askConfirm(
    {
      title: 'Start a new game?',
      sub: 'The game in progress will be lost.',
      confirmLabel: 'New game',
    },
    newGame,
  );
}

function undoTurn() {
  if (!canUndo()) return;
  aiToken++;
  thinking = false;
  // Taking a move back also takes back an end the app declared for itself —
  // running out of time is the one a player can undo their way out of.
  manualEnd = null;
  clearTimeout(gameOverTimer);
  if (els.gameoverDialog.open) els.gameoverDialog.close();
  if (mode === 'computer') {
    // Take back the player's last move along with any computer reply.
    do {
      undoPly();
    } while (game.turn() !== myColor && game.history().length > 0);
  } else {
    undoPly();
  }
  clearSelection();
  renderAll();
}

/** Take back one ply, unwinding the capture log and rewinding the clocks. */
function undoPly() {
  if (!game.undo()) return;
  captureLog.pop();
  const before = clockStack.pop();
  if (before) clock.restore(before);
}

/** Drop every game/session in progress ahead of a mode change. */
function teardownForModeChange() {
  if (session) {
    session.leave();
    session = null;
  }
  aiToken++;
  thinking = false;
  setBusy(false); // an escape hatch: the next mode must never inherit a stuck board
  opponentName = null;
  rematchOffered = false;
  manualEnd = null;
  reviewIndex = null;
  closeDialogs();
}

function setMode(next) {
  if (next === mode || !MODES.includes(next)) return;
  const perform = () => {
    teardownForModeChange();
    mode = next;
    saveSettings();
    if (mode === 'online') {
      enterOnlineIdle();
    } else {
      newGame();
    }
  };
  if (mode === 'online' && session?.connected && !gameFinished() && game.history().length > 0) {
    askConfirm(
      {
        title: 'Leave the online game?',
        sub: 'Leaving now counts as abandoning the game — your friend wins.',
        confirmLabel: 'Leave',
      },
      perform,
    );
  } else {
    perform();
  }
}

/* ------------------------------------------------------------------ */
/* Online play                                                         */
/* ------------------------------------------------------------------ */

function enterOnlineIdle({ inviteCode = null } = {}) {
  onlineUiState = 'idle';
  onlineReturnState = 'idle';
  myColor = 'b'; // Black moves first — the same placeholder default as the rest of the app
  manualEnd = null;
  reviewIndex = null;
  game.reset();
  // No clock until a game exists: an online game runs on the host's control,
  // which this side only learns at the handshake.
  resetClock(DEFAULT_TIME_ID);
  captureLog = [];
  resetTracking();
  clearSelection();
  clearTimeout(gameOverTimer);
  boardView.setOrientation('b');
  announcedPlies = 0;
  setOnlineError('');
  els.onlineInviteNote.hidden = !inviteCode;
  els.joinInput.value = inviteCode || '';
  els.srStatus.textContent = inviteCode
    ? 'You have been invited to a game. Press Join to connect.'
    : 'Online mode. Create a game or join with an invite code.';
  renderAll();
  if (inviteCode) els.joinBtn.focus();
  warmUpOnline();
}

/**
 * Warm up the SDK and TURN relays so create/join feels instant. Only when
 * already signed in — never trigger an auth prompt just by opening the tab.
 */
function warmUpOnline() {
  loadPuter()
    .then((puter) => {
      if (puter.auth?.isSignedIn?.()) return puter.peer.ensureTurnRelays?.();
      return null;
    })
    .catch(() => {});
}

function makeSession() {
  const s = new OnlineSession({
    onStart: (info) => session === s && handleSessionStart(info),
    onMove: (move) => session === s && handleRemoteMove(move),
    onFlag: (color) => session === s && handleRemoteFlag(color),
    onResign: () => session === s && handleOpponentResign(),
    onRematchOffer: () => session === s && handleRematchOffer(),
    onRematchAccept: () => session === s && gameFinished() && startRematch(),
    onRematchDecline: () => session === s && handleRematchDecline(),
    onClose: (info) => session === s && handleSessionClose(info),
    onError: (message) => session === s && showToast(message),
  });
  return s;
}

async function createGame() {
  if (mode !== 'online' || !['idle', 'ended'].includes(onlineUiState)) return;
  const fromState = onlineUiState; // restore on failure ('ended' keeps its board)
  onlineReturnState = fromState;
  setOnlineError('');
  els.onlineInviteNote.hidden = true;
  onlineUiState = 'creating';
  updateModeUi();
  const color = colorSetting === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : colorSetting;
  const s = (session = makeSession());
  try {
    const code = await s.host(color, timeSetting);
    if (session !== s) return; // cancelled or mode switched meanwhile
    if (!code) {
      onlineUiState = fromState;
      updateModeUi();
      return;
    }
    els.inviteCode.textContent = code;
    onlineUiState = 'hosting';
    updateModeUi();
    els.copyLinkBtn.focus();
    els.srStatus.textContent = 'Game created. Share the invite code with your friend.';
  } catch (err) {
    if (session !== s) return;
    session = null;
    onlineUiState = fromState;
    updateModeUi();
    setOnlineError(friendlyError(err, 'Could not create the game. Please try again.'));
  }
}

async function joinGame(rawCode) {
  if (mode !== 'online' || !['idle', 'ended'].includes(onlineUiState)) return;
  const fromState = onlineUiState; // restore on failure ('ended' keeps its board)
  onlineReturnState = fromState;
  const code = normalizeInviteCode(rawCode);
  if (!code) {
    setOnlineError('Enter an invite code first.');
    els.joinInput.focus();
    return;
  }
  setOnlineError('');
  onlineUiState = 'joining';
  updateModeUi();
  const s = (session = makeSession());
  try {
    await s.join(code);
    // Transport is up; handleSessionStart flips the UI once the host's
    // handshake arrives, and handleSessionClose covers every failure.
  } catch (err) {
    if (session !== s) return;
    session = null;
    onlineUiState = fromState;
    updateModeUi();
    setOnlineError(friendlyError(err, 'Could not join — check the code and try again.'));
    els.joinInput.focus();
  }
}

/**
 * Join straight from an opened invite link. Signed-in users connect with no
 * further clicks; signed-out users keep the prefilled one-click Join, because
 * the sign-in popup needs a real user gesture to avoid popup blockers.
 */
async function attemptAutoJoin(code) {
  try {
    const puter = await loadPuter();
    if (!puter.auth?.isSignedIn?.()) return;
  } catch {
    return; // SDK unavailable; the manual Join path is still on screen
  }
  // The user may have acted while the SDK loaded — only proceed if the
  // invite is still sitting untouched in the join box.
  if (mode !== 'online' || !['idle', 'ended'].includes(onlineUiState)) return;
  if (els.joinInput.value.trim() !== code) return;
  joinGame(code);
}

/** Accept a bare code or a full invite link pasted into the join box. */
function normalizeInviteCode(raw) {
  const text = (raw || '').trim();
  const match = /#g=([^&\s]+)/.exec(text);
  if (!match) return text;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function friendlyError(err, fallback) {
  const message =
    (typeof err === 'string' && err) || err?.message || err?.error?.message || '';
  return message ? String(message) : fallback;
}

function cancelOnlineSetup() {
  session?.leave();
  session = null;
  // Backing out lands where the attempt started, exactly like a create/join
  // that fails: hosting from a finished game and then cancelling must not
  // throw that game's cards and move list away while its board and result are
  // still on screen.
  onlineUiState = onlineReturnState;
  setOnlineError('');
  updateModeUi();
}

function handleSessionStart({ myColor: assigned, opponentName: name, role, timeId }) {
  myColor = assigned;
  opponentName = name || null;
  track('Online Game Connected', { role });
  const control = timeControl(timeId);
  // A guest is told the clock along with the color, since neither was theirs
  // to choose.
  startOnlineGame(
    `Connected to ${opponentLabel()}. You play ${colorName(myColor)}${
      control ? ` — ${control.label}` : ''
    }.`,
  );
}

function startRematch() {
  if (!session?.connected) return;
  session.swapColors();
  myColor = session.myColor;
  startOnlineGame(`Rematch started — you now play ${colorName(myColor)}.`);
}

function startOnlineGame(announcement) {
  aiToken++;
  thinking = false;
  setBusy(false); // an escape hatch: a fresh game must never inherit a stuck board
  onlineUiState = 'playing';
  rematchOffered = false;
  manualEnd = null;
  reviewIndex = null;
  game.reset();
  // Both games of a rematch run on the control the host set at the start.
  resetClock(session?.timeId || DEFAULT_TIME_ID);
  captureLog = [];
  resetTracking();
  clearSelection();
  clearTimeout(gameOverTimer);
  closeDialogs();
  boardView.setOrientation(myColor);
  announcedPlies = 0;
  els.srStatus.textContent = announcement;
  showToast(announcement);
  renderAll();
}

function handleRemoteMove({ path, clock: remoteClock }) {
  if (mode !== 'online' || onlineUiState !== 'playing' || gameFinished()) return;
  if (game.turn() === myColor) {
    desync();
    return;
  }
  // Read what each captured square held before applying the move — once
  // applied, those squares are empty and the piece is lost for good.
  const legal = game
    .moves({ square: path[0] })
    .find((m) => m.path.length === path.length && m.path.every((sq, i) => sq === path[i]));
  if (!legal) {
    desync();
    return;
  }
  const taken = legal.captured.map((sq) => game.get(sq));
  const played = game.move({ path });
  if (!played) {
    desync();
    return;
  }
  captureLog.push(taken);
  // Also counts the game as started: the opponent may have the first move.
  afterPlyApplied(played);
  applyRemoteClock(played.color, remoteClock);
  clearSelection();
  setBusy(true);
  showPath(played.path, () => {
    setBusy(false);
    renderAll();
    const status = game.status();
    if (status.over) showEnd(describeEnd(status));
  });
}

/**
 * The opponent says the game ended on time. Either side may be the one to
 * notice — they report their own flag, and they claim ours if we went quiet —
 * so this accepts whichever color they name.
 */
function handleRemoteFlag(loser) {
  if (mode !== 'online' || onlineUiState !== 'playing' || gameFinished()) return;
  clock.setRunning(null);
  stopClockTimer();
  endGameManually(describeTimeout(loser));
}

/** The peers disagree about the position; there is no way to keep playing. */
function desync() {
  session?.leave();
  session = null;
  onlineUiState = 'ended';
  setBusy(false); // an escape hatch: an unsynced board must never stay locked
  clearSelection();
  closeDialogs();
  const text = 'The game went out of sync and had to end. Please start a new one.';
  showToast(text);
  els.srStatus.textContent = text;
  renderAll();
}

function handleOpponentResign() {
  if (mode !== 'online' || gameFinished()) return;
  endGameManually({
    kind: 'win',
    reason: 'opponent resigned',
    result: resultFor(myColor),
    termination: 'normal',
    title: 'You win',
    sub: `${opponentLabel()} resigned.`,
  });
}

function requestResign() {
  if (!(mode === 'online' && session?.connected && !gameFinished())) return;
  askConfirm(
    {
      title: 'Resign this game?',
      sub: `${opponentLabel()} will win the game.`,
      confirmLabel: 'Resign',
    },
    () => {
      // The game may have ended while the dialog was open (opponent resigned
      // or left) — never let a stale confirmation overwrite that result.
      if (!session?.connected || gameFinished()) return;
      session.sendResign();
      endGameManually({
        kind: 'loss',
        reason: 'resigned',
        result: resultFor(otherColor(myColor)),
        termination: 'normal',
        title: 'You lose',
        sub: 'You resigned.',
      });
    },
  );
}

function requestLeave() {
  if (mode !== 'online') return;
  const perform = () => {
    session?.leave();
    session = null;
    opponentName = null;
    rematchOffered = false;
    enterOnlineIdle();
  };
  if (session?.connected && !gameFinished() && game.history().length > 0) {
    askConfirm(
      {
        title: 'Leave the game?',
        sub: 'Leaving now counts as abandoning the game — your friend wins.',
        confirmLabel: 'Leave',
      },
      perform,
    );
  } else {
    perform();
  }
}

function offerRematch() {
  if (!(mode === 'online' && session?.connected && gameFinished()) || rematchOffered) {
    return;
  }
  rematchOffered = true;
  session.sendRematchOffer();
  if (els.gameoverDialog.open) els.gameoverDialog.close();
  clearTimeout(gameOverTimer);
  showToast(`Rematch offered — waiting for ${opponentLabel()}.`);
  updateModeUi();
}

function handleRematchOffer() {
  if (!(mode === 'online' && session?.connected && gameFinished())) return;
  if (rematchOffered) {
    // Both sides asked for a rematch — just start it.
    session.sendRematchAccept();
    startRematch();
    return;
  }
  if (els.gameoverDialog.open) els.gameoverDialog.close();
  clearTimeout(gameOverTimer); // keep the delayed game-over dialog from covering this
  els.rematchSub.textContent = `${opponentLabel()} wants to play again — colors swap.`;
  rematchAnswered = false;
  // A repeated offer while the dialog is already up must not throw.
  if (!els.rematchDialog.open) els.rematchDialog.showModal();
}

function handleRematchDecline() {
  rematchOffered = false;
  showToast(`${opponentLabel()} declined the rematch.`);
  updateModeUi();
}

function handleSessionClose({ reason, wasConnected }) {
  session = null;
  rematchOffered = false;
  if (!wasConnected) {
    // Joining fell through before the game began (hosts keep waiting through
    // failed attempts, so only guests land here). Fall back to the state the
    // attempt started from, so a reviewable finished game stays on screen.
    onlineUiState = onlineReturnState;
    updateModeUi();
    setOnlineError(
      reason === 'left'
        ? 'Your friend cancelled the game.'
        : reason || 'Connection failed — please try again.',
    );
    return;
  }
  onlineUiState = 'ended';
  closeDialogs();
  if (!gameFinished()) {
    // Leaving before the first move aborts the game rather than losing it.
    endGameManually(
      game.history().length === 0
        ? {
            kind: 'draw',
            reason: 'aborted',
            result: '*',
            termination: 'abandoned',
            title: 'Game aborted',
            sub: `${opponentLabel()} left before the first move.`,
          }
        : {
            kind: 'win',
            reason: 'opponent left',
            result: resultFor(myColor),
            termination: 'abandoned',
            title: 'You win',
            sub: `${opponentLabel()} left the game.`,
          },
    );
  } else {
    showToast(`${opponentLabel()} left the game.`);
    renderAll();
  }
}

/* ------------------------------------------------------------------ */
/* Invite codes and links                                              */
/* ------------------------------------------------------------------ */

function inviteLink() {
  return `${location.origin}${location.pathname}#g=${encodeURIComponent(
    session?.inviteCode || '',
  )}`;
}

function readInviteFromUrl() {
  const match = /^#g=(.+)$/.exec(location.hash || '');
  if (!match) return null;
  // Strip the hash so a refresh doesn't try to rejoin a stale game.
  history.replaceState(null, '', location.pathname + location.search);
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

async function copyInviteCode() {
  if (!session?.inviteCode) return;
  if (await copyToClipboard(session.inviteCode)) {
    showToast('Invite code copied.');
    const copyIcon = els.copyCodeBtn.querySelector('.icon-copy');
    const checkIcon = els.copyCodeBtn.querySelector('.icon-check');
    copyIcon?.classList.add('hidden');
    checkIcon?.classList.remove('hidden');
    clearTimeout(copyCodeTimer);
    copyCodeTimer = setTimeout(() => {
      copyIcon?.classList.remove('hidden');
      checkIcon?.classList.add('hidden');
    }, 1600);
  } else {
    showToast('Copy failed — select the code and copy it manually.');
  }
}

async function copyInviteLink() {
  if (!session?.inviteCode) return;
  if (await copyToClipboard(inviteLink())) {
    showToast('Invite link copied — send it to your friend.');
    els.copyLinkLabel.textContent = 'Link copied!';
    clearTimeout(copyLinkTimer);
    copyLinkTimer = setTimeout(() => {
      els.copyLinkLabel.textContent = 'Copy invite link';
    }, 1600);
  } else {
    showToast('Copy failed — select the code and copy it manually.');
  }
}

/* ------------------------------------------------------------------ */
/* PDN export                                                          */
/* ------------------------------------------------------------------ */

/** Player names for the export, in the language of the current mode. */
function pdnNames() {
  // Black moves first, so pass & play seats it as "Player 1" the same way
  // White would in a game where White opened.
  if (mode === 'local') return { b: 'Player 1', w: 'Player 2' };
  const me = mode === 'online' ? 'You' : 'Player';
  const them = mode === 'online' ? opponentName || 'Opponent' : `Computer (${LEVELS[level].label})`;
  return myColor === 'b' ? { b: me, w: them } : { b: them, w: me };
}

function currentPdn(date) {
  const end = currentEnd();
  const names = pdnNames();
  return buildPdn({
    moves: game.history().map((m) => m.pdn),
    result: end ? end.result : '*',
    black: names.b,
    white: names.w,
    date,
    control: clock.control,
    termination: end ? end.termination : 'unterminated',
  });
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function copyPdn() {
  if (game.history().length === 0) return;
  if (await copyToClipboard(currentPdn(new Date()))) {
    showToast('Game copied as PDN.');
  } else {
    showToast('Copy failed — your browser blocked clipboard access.');
  }
}

function downloadPdn() {
  if (game.history().length === 0) return;
  const now = new Date();
  let url = null;
  try {
    url = URL.createObjectURL(
      new Blob([currentPdn(now)], { type: 'application/x-checkers-pdn' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = pdnFilename(now);
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Released on a later task, once the download has certainly started.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast('Game saved as a PDN file.');
  } catch {
    if (url) URL.revokeObjectURL(url);
    copyPdn(); // no downloads here; the clipboard still gets the player the game
  }
}

/* ------------------------------------------------------------------ */
/* Account                                                             */
/* ------------------------------------------------------------------ */

// The SDK's <puter-user-menu> (ui/userMenu.js) signs the player in and out
// from the top bar. Nothing but online play uses the account, so that is all
// there is to keep in step with it.

/** Once the SDK has loaded: the element takes its place in the top bar. */
function showUserMenu() {
  userMenu = mountUserMenu(els.topbarRight, {
    theme: themeSetting,
    signOutGuard: confirmSignOut,
    onSignIn: handleSignedIn,
    onSignOut: handleSignedOut,
  });
}

/**
 * The element's Sign out is immediate. With an online game under way that
 * would abandon it without a word, so ask first, exactly as Leave does.
 * Returns what to do in place of the element's own Sign out, or null when
 * there is nothing to ask about.
 */
function confirmSignOut() {
  if (
    !(
      mode === 'online' &&
      session?.connected &&
      !gameFinished() &&
      game.history().length > 0
    )
  ) {
    return null;
  }
  return () =>
    askConfirm(
      {
        title: 'Sign out and leave the game?',
        sub: 'Leaving now counts as abandoning the game — your friend wins.',
        confirmLabel: 'Sign out',
      },
      () => {
        // Say goodbye while the connection is still ours, then sign out; the
        // element follows the SDK and goes back to Sign in by itself.
        closeOnlineForSignOut();
        Promise.resolve(window.puter?.auth?.signOut?.()).catch(() => {});
      },
    );
}

/**
 * Signed out: whatever was going on online ends here rather than running on
 * against an account that is gone. Hosting or joining backs out to where it
 * started; a game that is still being played is left, as with Leave; a
 * finished one stays on the board for review. Returns whether anything ended.
 */
function closeOnlineForSignOut() {
  if (!session) return false;
  if (!session.connected) {
    cancelOnlineSetup();
    return true;
  }
  session.leave();
  session = null;
  rematchOffered = false;
  if (gameFinished()) {
    onlineUiState = 'ended';
    closeDialogs();
    renderAll();
  } else {
    opponentName = null;
    closeDialogs();
    enterOnlineIdle();
  }
  return true;
}

/** The element signed out by itself. */
function handleSignedOut() {
  if (!closeOnlineForSignOut()) return;
  const text = 'You signed out, so the online game was closed.';
  showToast(text);
  els.srStatus.textContent = text;
}

/** The element signed in: the online tab can get ready as it would have. */
function handleSignedIn() {
  if (mode === 'online') warmUpOnline();
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

for (const button of els.modeButtons) {
  button.addEventListener('click', () => setMode(button.dataset.mode));
}

els.newGameBtn.addEventListener('click', requestNewGame);
els.undoBtn.addEventListener('click', undoTurn);
els.resignBtn.addEventListener('click', requestResign);
els.leaveBtn.addEventListener('click', requestLeave);
els.rematchBtn.addEventListener('click', offerRematch);
els.gameoverNew.addEventListener('click', () => {
  if (mode === 'online') offerRematch();
  else newGame();
});
els.gameoverClose.addEventListener('click', () => els.gameoverDialog.close());

els.hostBtn.addEventListener('click', createGame);
els.joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  joinGame(els.joinInput.value);
});
els.copyCodeBtn.addEventListener('click', copyInviteCode);
els.copyLinkBtn.addEventListener('click', copyInviteLink);
els.cancelHostBtn.addEventListener('click', cancelOnlineSetup);
els.cancelJoinBtn.addEventListener('click', cancelOnlineSetup);

els.reviewFirstBtn.addEventListener('click', () => goToPly(0));
els.reviewPrevBtn.addEventListener('click', () => goToPly(viewPlies() - 1));
els.reviewNextBtn.addEventListener('click', () => goToPly(viewPlies() + 1));
els.reviewLastBtn.addEventListener('click', () => goToPly(game.history().length));

// The move list is rebuilt on every render, so the click lands on the list.
els.moveList.addEventListener('click', (e) => {
  const ply = e.target.closest('button.ply');
  if (ply) goToPly(Number(ply.dataset.ply));
});

els.movesToggle.addEventListener('click', () => setMovesOpen(!movesOpen));

els.pgnCopyBtn.addEventListener('click', copyPdn);
els.pgnDownloadBtn.addEventListener('click', downloadPdn);

els.levelSelect.addEventListener('change', () => {
  level = els.levelSelect.value;
  saveSettings();
  renderAll();
});

els.colorSelect.addEventListener('change', () => {
  colorSetting = els.colorSelect.value;
  saveSettings();
});

els.timeSelect.addEventListener('change', () => {
  timeSetting = els.timeSelect.value;
  saveSettings();
  // Nothing has been played yet, so there is no game to disturb: put the new
  // clock on the board at once rather than making the player press New game
  // to see the choice they just made.
  if (mode !== 'online' && !gameFinished() && game.history().length === 0) {
    resetClock(timeSetting);
  }
  renderAll();
});

for (const button of els.themeButtons) {
  button.addEventListener('click', () => {
    themeSetting = button.dataset.themeChoice;
    saveSettings();
    applyTheme();
  });
}

// Clicking the backdrop dismisses a dialog. Backdrop clicks target the dialog
// element itself but land outside its box; padding clicks land inside it.
function closeOnBackdropClick(dialog) {
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (!inside) dialog.close();
  });
}
closeOnBackdropClick(els.gameoverDialog);
closeOnBackdropClick(els.confirmDialog);
closeOnBackdropClick(els.rematchDialog);

els.confirmYes.addEventListener('click', () => {
  const action = confirmAction;
  confirmAction = null;
  els.confirmDialog.close();
  action?.();
});
els.confirmNo.addEventListener('click', () => els.confirmDialog.close());
els.confirmDialog.addEventListener('close', () => {
  confirmAction = null;
});

els.rematchAccept.addEventListener('click', () => {
  rematchAnswered = true;
  els.rematchDialog.close();
  if (session?.connected) {
    session.sendRematchAccept();
    startRematch();
  }
});
els.rematchDecline.addEventListener('click', () => {
  rematchAnswered = true;
  els.rematchDialog.close();
  session?.sendRematchDecline();
});
// Dismissing the offer any other way (Escape, backdrop) declines it, so the
// other player is never left waiting.
els.rematchDialog.addEventListener('close', () => {
  if (!rematchAnswered) {
    rematchAnswered = true;
    session?.sendRematchDecline();
  }
});

function anyDialogOpen() {
  return els.gameoverDialog.open || els.confirmDialog.open || els.rematchDialog.open;
}

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Escape in the account menu closes that menu and nothing else.
  if (inUserMenu(e.target)) return;
  // Dialogs close natively on Escape; handle them here too so the shortcut
  // cannot be lost, and so Escape means "close dialog" before "deselect".
  if (els.gameoverDialog.open) {
    els.gameoverDialog.close();
  } else if (els.confirmDialog.open) {
    els.confirmDialog.close();
  } else if (els.rematchDialog.open) {
    els.rematchDialog.close();
  } else if (pendingPath.length) {
    showToast('You must finish the jump.');
  } else if (selected) {
    // A piece still held under the pointer is dropped along with the
    // selection, rather than left riding the cursor with nowhere to land.
    boardView.cancelDrag();
    clearSelection();
    renderAll();
  }
});

// Step through the game with the arrow keys. Two things already own these
// keys and keep them: a focused square, where they move around the board's
// ARIA grid, and a form control, where they change its value.
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  if (anyDialogOpen()) return;
  if (
    e.target instanceof Element &&
    e.target.closest(`#board, input, select, textarea, ${USER_MENU_TAG}`)
  ) {
    return;
  }
  const plies = viewPlies();
  switch (e.key) {
    case 'ArrowLeft': goToPly(plies - 1); break;
    case 'ArrowRight': goToPly(plies + 1); break;
    case 'Home': goToPly(0); break;
    case 'End': goToPly(game.history().length); break;
    default: return;
  }
  e.preventDefault();
});

// Best-effort goodbye so the other player hears about it right away instead
// of waiting for the connection to time out. Stop charging before the page
// goes: one heading into the back/forward cache is frozen and one being
// unloaded is gone, and neither should cost the player the time it spends
// there. Settling first also means the save below records the clock as it
// actually stood.
window.addEventListener('pagehide', () => {
  session?.leave();
  clock.setRunning(null);
  stopClockTimer();
  saveNow();
});

// A tab put into the background may never be looked at again — store the
// clock where it stands rather than leaving the reading from the last move.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveNow();
});

// Restored from the back/forward cache: pagehide already said goodbye, so the
// session object is dead — reflect that instead of showing stale state. The
// render also picks the clock back up where pagehide put it down.
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  if (session) {
    session = null;
    rematchOffered = false;
    if (mode === 'online') {
      onlineUiState = onlineUiState === 'playing' ? 'ended' : 'idle';
      showToast('The connection was closed when you left the page.');
    }
  }
  renderAll();
});

// An invite link opened while the app is already running only changes the
// hash (no reload) — pick it up here. A connected game is never interrupted.
window.addEventListener('hashchange', () => {
  const code = readInviteFromUrl();
  if (!code) return;
  if (session?.connected) {
    // Never yank the player out of a live game — but don't be silent either.
    showToast('You are in a game — finish or leave it before joining another.');
    return;
  }
  teardownForModeChange();
  if (mode !== 'online') {
    mode = 'online';
    saveSettings();
  }
  enterOnlineIdle({ inviteCode: code });
  attemptAutoJoin(code);
});

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

buildTimeOptions();
loadSettings();
applyTheme();
// The SDK arrives with online play, if at all; the account menu comes with it.
whenPuterLoaded(showUserMenu);

const inviteFromUrl = readInviteFromUrl();
if (inviteFromUrl && mode !== 'online') {
  // Arriving through an invite link overrides the remembered mode (and is
  // remembered, matching how a link opened into a running app behaves).
  mode = 'online';
  saveSettings();
}
if (mode === 'online') {
  enterOnlineIdle({ inviteCode: inviteFromUrl });
  if (inviteFromUrl) attemptAutoJoin(inviteFromUrl);
} else if (!restoreGame()) {
  // Nothing to pick up (or what was stored no longer replays): start fresh.
  newGame();
}

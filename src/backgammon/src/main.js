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
  ChevronsUp,
  ClipboardCopy,
  Dices,
  Download,
} from 'lucide';

import { Backgammon, opponent } from './engine/backgammon.js';
import { canDeriveFairly, rollDice } from './engine/dice.js';
import { LEVELS, choosePlay, shouldDouble, shouldTake } from './engine/ai.js';
import { BoardView, nameOf } from './ui/boardView.js';
import { OnlineSession, loadPuter, whenPuterLoaded } from './net/online.js';
import {
  USER_MENU_TAG,
  inUserMenu,
  mountUserMenu,
  setUserMenuTheme,
} from './ui/userMenu.js';
import {
  clearGame,
  eventsFrom,
  loadGame,
  replaySavedGame,
  saveGame,
} from './game/persistence.js';
import { buildMat, entryNotation, matFilename, movesNotation, rollNotation } from './game/notation.js';
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
    ChevronsUp,
    ClipboardCopy,
    Dices,
    Download,
  },
});

const $ = (id) => document.getElementById(id);

const els = {
  board: $('board'),
  cube: $('cube'),
  cubeValue: $('cube-value'),
  cubeNote: $('cube-note'),
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
  pipsTop: $('pips-top'),
  pipsBottom: $('pips-bottom'),
  borneTop: $('borne-top'),
  borneBottom: $('borne-bottom'),
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
  matCopyBtn: $('mat-copy-btn'),
  matDownloadBtn: $('mat-download-btn'),
  srStatus: $('sr-status'),
  toast: $('toast'),
  sidebar: document.querySelector('.sidebar'),
  controls: $('controls'),
  actionRow: $('action-row'),
  actionNote: $('action-note'),
  rollBtn: $('roll-btn'),
  rollLabel: $('roll-label'),
  doubleBtn: $('double-btn'),
  fieldRow: $('field-row'),
  levelField: $('level-field'),
  colorField: $('color-field'),
  cubeField: $('cube-field'),
  cubeSelect: $('cube-select'),
  colorLabel: $('color-label'),
  timeField: $('time-field'),
  levelSelect: $('level-select'),
  colorSelect: $('color-select'),
  timeSelect: $('time-select'),
  buttonRow: $('button-row'),
  newGameBtn: $('new-game-btn'),
  undoBtn: $('undo-btn'),
  undoLabel: $('undo-label'),
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
  cubeDialog: $('cube-dialog'),
  cubeOffer: $('cube-offer'),
  cubeTitle: $('cube-title'),
  cubeSub: $('cube-sub'),
  cubeTake: $('cube-take'),
  cubeDrop: $('cube-drop'),
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

const SETTINGS_KEY = 'backgammon-settings';
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
/** How long a turn with no legal play stays on screen before it hands over. */
const NO_PLAY_MS = 1300;
/** A beat before the computer rolls, so the handover is visible. */
const COMPUTER_ROLL_MS = 500;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

// Reassigned when a stored game is picked back up, which arrives as a game
// object of its own rather than as instructions to replay into this one.
let game = new Backgammon();
let mode = 'computer'; // 'computer' | 'local' | 'online'
let myColor = 'w'; // side controlled at this device (computer & online modes)
let level = 'medium';
let colorSetting = 'w';
let timeSetting = DEFAULT_TIME_ID; // time control for the next game we start
/**
 * Whether the doubling cube is in play in the games this device starts.
 *
 * Off by default. The cube is what makes backgammon the game it is, but a very
 * large number of people learned backgammon without it and would rather not
 * meet a cube on the bar with no idea what it is — and the setting is right
 * there for anyone who wants it, which is not true in reverse.
 */
let cubeSetting = false;
let themeSetting = 'system';
// The move list is a disclosure, closed unless the player has opened it.
// Most people never read the notation, and an empty panel was the largest
// thing in the sidebar. Opening it is remembered; auto-opening is not.
let movesOpen = false;
let thinking = false;
let thinkingLevel = null; // level the in-flight search actually uses
let manualEnd = null; // an end the engine can't see: a flag fall, a walkout

/**
 * Cancels work in flight. Every asynchronous step — the computer's roll and
 * search, the pause on a turn with no legal play, an animation — captures this
 * and gives up if it has moved on. A new game, an undo, a mode change and a
 * flag fall all bump it.
 */
let token = 0;

// Clocks. `clock` belongs to the game on the board (an untimed game gets a
// disabled one), and `clockStack` holds each side's time as it stood at the
// start of every entry, which is what undo rewinds to.
let clock = new Clock(null);
let clockTimer = 0;
let clockStack = [];
let flagSeenAt = 0; // when an opponent's clock was first seen empty
let lowAnnounced = { w: false, b: false }; // said "time is low" this game

// True while checkers are still sliding for a turn already applied to the
// engine, or while a turn with no legal play is being shown. Input is blocked
// for that window so a second press cannot land inside it.
let busy = false;

// Building a turn. The engine only applies whole turns, so while this is
// non-empty the board shows game.preview(pendingMoves) and the engine's own
// position is still one turn behind the screen.
let pendingMoves = [];
let selected = null; // the slot a checker has been lifted from
let targets = new Map(); // slot -> the move that lands there
const NO_TARGETS = new Map(); // shared empty map — nothing is pickable while reviewing
const NO_MOVABLE = new Set();
let pendingToggleOff = false;

// The entry the board is showing while stepping back through the game: null
// means "the current position", any other number is how many entries of
// game.history() are on screen. The engine's own position never moves for
// this — see positionAt below.
let reviewIndex = null;

/**
 * Points won across this sitting. Backgammon is played for points rather than
 * games — a gammon is worth two and the cube multiplies both — so a bare
 * "won/lost" would throw away most of what happened. Kept by seat rather than
 * by colour, since a rematch swaps the colours but not the players.
 */
let score = { me: 0, them: 0 };
/** Whether the game on the board has already been added to that total. */
let scored = false;

let gameOverTimer = 0;
let announced = ''; // the last thing said to the status region
let toastTimer = 0;

// Whether this mode's save slot may hold something, so a game that cannot be
// saved (finished, not started) only clears it once instead of every render.
let hasSave = true;

// Online play.
let session = null; // OnlineSession while hosting/joining/playing
let userMenu = null; // the SDK's <puter-user-menu>, once it is in the top bar
let onlineUiState = 'idle'; // 'idle'|'creating'|'hosting'|'joining'|'playing'|'ended'
let onlineReturnState = 'idle'; // where a failed create/join falls back to
let opponentName = null; // kept after the session ends for result text
let rematchOffered = false; // we offered a rematch and await the reply
let rematchAnswered = false; // guards the incoming-offer dialog's close event
let waitingForDice = false; // a commit-reveal round is in flight
// The host's cube choice, which a guest is dealt along with its colour and
// clock and which both games of a rematch keep.
let onlineCubeless = false;
let confirmAction = null;
let copyCodeTimer = 0;
let copyLinkTimer = 0;

const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** The colour shown at the bottom of the board. */
function bottomColor() {
  // Pass & play always seats White at the bottom: with both players at one
  // device there is no "my" side to orient to.
  return mode === 'local' ? 'w' : myColor;
}

/**
 * Is there a game on the board at all? False only in online mode while the
 * setup panel is up, where the board is a backdrop rather than a game.
 */
function boardInPlay() {
  return mode !== 'online' || onlineUiState === 'playing' || onlineUiState === 'ended';
}

function gameFinished() {
  return !!manualEnd || game.isGameOver();
}

function opponentLabel() {
  return opponentName || 'Your friend';
}

/** The colour the person at this device is playing right now, or null. */
function myTurnColor() {
  if (reviewing() || gameFinished()) return null;
  if (mode === 'local') return game.turn();
  if (mode === 'computer') return thinking ? null : myColor;
  return session?.connected && onlineUiState === 'playing' ? myColor : null;
}

/** Is it this device's move, with dice on the table? */
function myMove() {
  return game.phase() === 'move' && myTurnColor() === game.turn();
}

/**
 * The side the game is waiting on: the side to move — except while a double
 * is on the table, when it is the side that has to answer it. The clock
 * charges this side and the turn marker sits on it. The doubler has done
 * their part; a decision that could be stalled at the doubler's expense would
 * make the cube a way to run an opponent out of time.
 */
function actingColor() {
  return game.phase() === 'double' ? game.doubledTo() : game.turn();
}

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/*                                                                     */
/* Three events, and only three. Each one is a player getting          */
/* something out of the app rather than merely touching it:            */
/*                                                                     */
/*   Game Completed         they played a game through to its end      */
/*   Played Again           and then started another                   */
/*   Online Game Connected  two people actually got a game together    */
/*                                                                     */
/* Deliberately not tracked: opening a game, which is intent rather    */
/* than value and which pageviews already count; and creating an       */
/* invite, since an invite nobody joins is a dead end — the connection */
/* is the same funnel step that actually landed.                       */
/* ------------------------------------------------------------------ */

/** Guards against a repeated game-over render counting the same game twice. */
let endTracked = false;
/**
 * A game has been finished and not yet followed by another. The clearest
 * signal there is that a game was worth playing is that the player
 * immediately wanted a second one, and it is the same signal whether they
 * pressed New game or accepted a rematch.
 */
let playedAgainPending = false;

function resetTracking() {
  endTracked = false;
}

/** A board with no turns on it is not a game, however it came to an end. */
function trackGameEnd(end) {
  if (endTracked || game.history().length === 0) return;
  endTracked = true;
  playedAgainPending = true;
  track('Game Completed', {
    mode,
    result: end.kind,
    reason: end.reason,
    points: end.points,
    level: mode === 'computer' ? level : null,
    clock: gameTimeId(),
    cube: game.cubeless() ? 'off' : 'on',
  });
}

/** Called wherever a new game begins; fires only if one just ended. */
function trackPlayedAgain() {
  if (!playedAgainPending) return;
  playedAgainPending = false;
  track('Played Again', { mode });
}

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (stored && LEVELS[stored.level]) level = stored.level;
    if (stored && ['w', 'b', 'random'].includes(stored.color)) colorSetting = stored.color;
    if (stored && isTimeId(stored.time)) timeSetting = stored.time;
    if (stored && typeof stored.cube === 'boolean') cubeSetting = stored.cube;
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
  els.cubeSelect.value = cubeSetting ? 'on' : 'off';
}

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        level,
        color: colorSetting,
        time: timeSetting,
        cube: cubeSetting,
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
/* Layout                                                              */
/* ------------------------------------------------------------------ */

/** The width below which the board and the sidebar stack — style.css's
    breakpoint, which a media query cannot read from a custom property. */
const stacked = window.matchMedia('(max-width: 920px)');

/**
 * Stacked, the sidebar runs past the fold on most screens, and a Roll button
 * at the foot of it spends the whole game out of view — every turn becomes a
 * scroll down to roll and a scroll back up to move. Rolling is the one thing
 * the player does every turn, so the turn's controls sit directly under the
 * board instead, and everything less frequent keeps its place below. Wide,
 * the controls column takes them back.
 */
function placeActionRow() {
  if (stacked.matches) {
    els.sidebar.prepend(els.actionRow);
  } else {
    els.controls.prepend(els.actionRow);
  }
}

stacked.addEventListener('change', placeActionRow);
placeActionRow();

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
  // The clock starts with the opening roll — the moment the game actually
  // begins. A board nobody has touched costs nothing, and neither does
  // picking a time control or opening the tab.
  if (game.phase() === 'opening') return false;
  if (mode === 'online') return onlineUiState === 'playing' && !!session?.connected;
  return true;
}

function syncClock() {
  clock.setRunning(clockLive() ? actingColor() : null);
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
  announce(
    mode !== 'local' && running === myColor
      ? `Your time is low — ${speakClock(ms)} left.`
      : `${cap(sideName(running))} is low on time — ${speakClock(ms)} left.`,
  );
}

function handleFlagFall(loser) {
  if (gameFinished()) return;
  flagSeenAt = 0;
  clock.setRunning(null);
  stopClockTimer();
  // Work still in flight would otherwise land a turn after the flag fell.
  token++;
  thinking = false;
  setBusy(false);
  if (mode === 'online') session?.sendFlag(loser);
  endGameManually(describeTimeout(loser));
}

/** Running out of time loses, at whatever the cube says the game is worth. */
function describeTimeout(loser) {
  const winner = opponent(loser);
  const points = game.cube().value;
  return {
    ...outcomeFor(winner, points),
    reason: 'timeout',
    sub: `${cap(sideName(loser))} ran out of time.`,
  };
}

/**
 * Move the clock on after a turn: remember where it stood so undo can put it
 * back, charge the time it took, add the increment, and hand over. Returns the
 * mover's remaining ms — what an online peer needs to hear.
 */
function afterEntryApplied(color, handsOver) {
  clockStack.push(clock.baseline());
  let left = null;
  if (clock.enabled) {
    if (handsOver) {
      clock.setRunning(null); // charges the mover for the time they just spent
      if (clock.remaining(color) > 0) clock.addIncrement(color);
      // Hand over now rather than after the animation, or every turn would
      // give the other side a few free tenths of a second.
      syncClock();
    }
    left = clock.remaining(color);
  }
  return left;
}

/**
 * Take the opponent's word for their own clock, within reason: their reading
 * is exact where ours only estimated it while they were thinking, but a number
 * above anything the time control could have handed them is capped. They can
 * only ever have their starting time plus one increment per turn they took.
 */
function applyRemoteClock(color, ms) {
  if (!clock.enabled || typeof ms !== 'number') return;
  const { initial, increment } = clock.control;
  const theirTurns = game
    .history()
    .reduce((n, e) => n + (e.kind === 'move' && e.color === color ? 1 : 0), 0);
  clock.set(color, Math.min(ms, initial + increment * theirTurns));
}

/* ------------------------------------------------------------------ */
/* Reviewing earlier positions                                         */
/* ------------------------------------------------------------------ */

function reviewing() {
  return reviewIndex !== null;
}

/** How many history entries the board is showing — all of them unless reviewing. */
function viewEntries() {
  return reviewIndex === null ? game.history().length : reviewIndex;
}

/** An undo (or a new game) can leave the review index past the last entry. */
function clampReview() {
  if (reviewIndex !== null && reviewIndex >= game.history().length) reviewIndex = null;
}

/**
 * The position after `count` entries of the current game, replayed from the
 * start. A whole game is a few dozen turns and the engine makes short work of
 * them, which is cheaper to keep correct than a cache that would have to be
 * invalidated every time the live game moves on underneath it.
 */
function positionAt(count) {
  const replay = new Backgammon();
  const history = game.history();
  for (let i = 0; i < count; i++) {
    const entry = history[i];
    switch (entry.kind) {
      case 'move':
        replay.setRoll(entry.roll[0], entry.roll[1]);
        replay.play(entry.moves);
        break;
      case 'double':
        replay.double();
        break;
      case 'take':
        replay.take();
        break;
      case 'drop':
        replay.drop();
        break;
      case 'resign':
        replay.resign(entry.color, entry.multiplier);
        break;
      default:
        break;
    }
  }
  return replay;
}

function goToPly(target) {
  const total = game.history().length;
  const count = Math.max(0, Math.min(total, target));
  const next = count === total ? null : count;
  if (next === reviewIndex) return;
  reviewIndex = next;
  // Stepping into an older position with the panel closed would move the
  // board with nothing on screen naming the turn you landed on. Open it —
  // but without remembering, since the player did not ask for it.
  if (next !== null && !movesOpen) setMovesOpen(true, { remember: false });
  // A checker cannot stay picked up, and a half-built turn cannot stay
  // pending, across a jump to another position.
  boardView.cancelDrag();
  clearSelection();
  renderAll();
  announceReview();
}

function announceReview() {
  const count = viewEntries();
  if (!reviewing()) {
    announce('Back to the current position.');
  } else if (count === 0) {
    announce('Starting position.');
  } else {
    announce(`${entryNotation(game.history()[count - 1]).trim()}. Reviewing.`);
  }
}

/* ------------------------------------------------------------------ */
/* Saving a game in progress                                           */
/* ------------------------------------------------------------------ */

/**
 * Keep storage in step with the board. Called from renderAll, so no state
 * change can forget to; also called when the page is hidden or leaving, which
 * is the only way a clock reading taken mid-turn gets stored.
 *
 * A half-built turn is never saved, and needs no code here to arrange that:
 * the engine applies only whole turns, so its history holds nothing but
 * finished ones while `pendingMoves` is being assembled. What *is* saved is
 * the roll on the table — which is the whole point. A backgammon game that
 * resumed with fresh dice would let a player reload their way out of a bad
 * throw, and no amount of care over the online protocol would matter if the
 * offline one handed the numbers back.
 */
function saveNow() {
  // An online game cannot outlive its connection, so there is nothing to
  // store — and nothing to clear either: the games saved for the other two
  // modes are still waiting to be picked up, and looking in on online play
  // must not throw them away.
  if (mode === 'online') return;
  const worthSaving = !gameFinished() && (game.history().length > 0 || !!game.roll());
  if (!worthSaving) {
    // Nothing worth resuming: a finished game should not greet the player as
    // if it were still going, and an untouched board is what a fresh visit
    // gets anyway.
    if (hasSave) {
      clearGame(mode);
      hasSave = false;
    }
    return;
  }
  saveGame({
    mode,
    myColor,
    time: gameTimeId(),
    cubeless: game.cubeless(),
    events: eventsFrom(game.history()),
    roll: game.roll(),
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
  const saved = loadGame(mode);
  if (!saved || saved.mode !== mode) return false;
  const replayed = replaySavedGame(saved);
  if (!replayed) {
    clearGame(mode);
    hasSave = false;
    return false;
  }

  token++;
  thinking = false;
  setBusy(false);
  // The replay comes back as a game in its own right, history and all, so it
  // simply becomes the game on the board.
  game = replayed;
  myColor = saved.myColor;
  manualEnd = null;
  reviewIndex = null;
  resetClock(saved.time);
  if (clock.enabled && saved.clock) clock.restore(saved.clock);
  if (clock.enabled) clockStack = saved.clockStack.map((c) => ({ ...c }));
  resetTracking();
  clearSelection();
  clearTimeout(gameOverTimer);
  closeDialogs();
  boardView.setOrientation(bottomColor());
  announced = '';
  announce(
    mode === 'local'
      ? `Game restored. ${nameOf(game.turn())} to play.`
      : `Game restored. You play ${nameOf(myColor)}.`,
  );
  renderAll();
  showToast('Picked up where you left off.');
  resumeTurn();
  return true;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

const boardView = new BoardView(els.board, { onSlotPress, onDrop, onSlotActivate });

/**
 * Flip the busy flag and mirror it onto the board as a class, so the cursor
 * (and anything else hooked off it) reflects that nothing is clickable while
 * a turn is still playing out.
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
  drawBoard();
  renderPlayers();
  renderClocks();
  renderCube();
  renderMoves(viewEntries());
  renderReviewBar(viewEntries());
  renderBanner();
  renderActions();
  els.undoBtn.disabled = !canUndo();
  els.undoLabel.textContent = pendingMoves.length ? 'Undo move' : 'Undo turn';
  updateModeUi();
  saveNow();
}

/**
 * Draw the position on the board. While reviewing, that is an older position
 * replayed from the start; while live, it is the engine's own board with any
 * half-built turn previewed over the top of it.
 */
function drawBoard(pending = pendingMoves) {
  const live = !reviewing();
  const source = live ? game : positionAt(viewEntries());
  const shown = live ? source.preview(pending) : { points: source.points(), off: sourceOff(source) };
  const last = live ? game.lastPlay() : source.lastPlay();
  const mover = game.turn() || bottomColor();
  boardView.render({
    points: shown.points,
    off: shown.off,
    moverColor: live ? mover : source.turn() || mover,
    selected: live ? selected : null,
    targets: live ? targets : NO_TARGETS,
    movable: live ? movableSlots(pending) : NO_MOVABLE,
    dice: live ? diceState(pending) : reviewDice(source),
    lastMoves: last && pending.length === 0 ? last.moves : [],
  });
  els.board.classList.toggle('reviewing', !live);
}

const sourceOff = (g) => ({ w: g.off('w'), b: g.off('b') });

/** The dice showing on the board, and which of them have been spent. */
function diceState(pending) {
  const values = game.diceSequence();
  if (values.length === 0) return null;
  const used = values.map(() => false);
  for (const move of pending) {
    const i = values.findIndex((die, at) => die === move.die && !used[at]);
    if (i !== -1) used[i] = true;
  }
  return { values, used, color: game.turn() };
}

/** The dice of the turn being reviewed, all shown as spent — they were. */
function reviewDice(replay) {
  const last = replay.lastPlay();
  if (!last) return null;
  const values = last.roll[0] === last.roll[1] ? [last.roll[0], last.roll[0], last.roll[0], last.roll[0]] : last.roll;
  return { values, used: values.map(() => true), color: last.color };
}

/** The slots the person at this device may pick a checker up from. */
function movableSlots(pending) {
  if (busy || !myMove()) return NO_MOVABLE;
  return new Set(game.legalMoves(pending).map((m) => m.from));
}

/**
 * Undo takes back one checker move, or one whole turn once none is pending.
 *
 * A whole turn can only be taken back before the next dice are thrown.
 * Rolling is what makes the turn before it final — exactly as at a real
 * board — and a fresh roll sitting untouched on the table is the one thing
 * undo must never discard: a player who could roll, dislike the numbers, and
 * undo their way back to a turn that then rolls again would be choosing
 * their own dice. Once a checker has moved, undo works on the move instead.
 */
function canUndo() {
  if (busy || reviewing() || thinking) return false;
  if (pendingMoves.length) return true;
  if (mode === 'online') return false; // no taking back a real opponent's turn
  if (gameFinished()) return false;
  if (game.phase() === 'move') return false; // the dice have been thrown
  const last = game.lastEntry();
  if (!last || last.kind !== 'move') return false;
  if (mode === 'computer') return game.history().some((e) => e.kind === 'move' && e.color === myColor);
  return true;
}

/** Name of the side that owns `color`, as spoken to this device's player. */
function moverName(color) {
  if (mode === 'local') return nameOf(color);
  if (color === myColor) return 'You';
  return mode === 'computer' ? 'Computer' : opponentName || 'Opponent';
}

/**
 * How to name the player of `color` inside a sentence. Lower case, so callers
 * can place it mid-sentence and capitalize it when it comes first.
 */
function sideName(color) {
  if (mode === 'local') return nameOf(color);
  if (color === myColor) return 'you';
  return mode === 'computer' ? 'the computer' : opponentLabel();
}

/** Tell assistive technology something, without repeating itself. */
function announce(text) {
  if (!text || text === announced) return;
  announced = text;
  els.srStatus.textContent = text;
}

function renderPlayers() {
  const bottom = bottomColor();
  const top = opponent(bottom);
  const finished = gameFinished();

  let topIsCpu = false;
  if (mode === 'computer') {
    topIsCpu = true;
    els.topName.textContent = 'Computer';
    els.topCaption.textContent = thinking
      ? `${LEVELS[thinkingLevel].label} · thinking`
      : LEVELS[level].label;
    els.bottomName.textContent = 'You';
    els.bottomCaption.textContent = `Playing ${nameOf(bottom)}`;
  } else if (mode === 'local') {
    els.topName.textContent = nameOf(top);
    els.topCaption.textContent = MODE_NOTES.local;
    els.bottomName.textContent = nameOf(bottom);
    els.bottomCaption.textContent = MODE_NOTES.local;
  } else {
    // Opponent names come off the wire — textContent only, never innerHTML.
    els.topName.textContent = opponentName || 'Opponent';
    els.topCaption.textContent = `Playing ${nameOf(top)} · ${
      session?.connected ? 'connected' : 'disconnected'
    }`;
    els.bottomName.textContent = 'You';
    els.bottomCaption.textContent = `Playing ${nameOf(bottom)}`;
  }
  // The session score is the running total of points, and only worth the room
  // once something has actually been won.
  if (score.me || score.them) {
    els.bottomCaption.textContent += ` · ${score.me} pt${score.me === 1 ? '' : 's'}`;
    els.topCaption.textContent += ` · ${score.them} pt${score.them === 1 ? '' : 's'}`;
  }

  els.topIconCpu?.classList.toggle('hidden', !topIsCpu);
  els.topIconUser?.classList.toggle('hidden', topIsCpu);

  const acting = finished ? null : actingColor();
  els.cardTop.classList.toggle('thinking', mode === 'computer' && thinking);
  els.cardTop.classList.toggle('active', acting === top);
  els.cardBottom.classList.toggle('active', acting === bottom);

  renderPips(bottom, top);
}

/**
 * The pip count — how far each side still has to travel — measured on the
 * position being shown, so a reviewed board and the numbers beside it
 * describe the same moment.
 */
function renderPips(bottom, top) {
  const shown = reviewing() ? positionAt(viewEntries()) : game;
  const fill = (pipsEl, borneEl, color) => {
    pipsEl.textContent = `${shown.pipCount(color)} pips`;
    const off = shown.off(color);
    borneEl.textContent = off ? `${off} off` : '';
  };
  fill(els.pipsBottom, els.borneBottom, bottom);
  fill(els.pipsTop, els.borneTop, top);
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
  els.moveCount.textContent = movesOpen || history.length === 0 ? '' : `${history.length}`;
}

/**
 * The move list, laid out the way a backgammon score sheet is: a column per
 * player, a row per round. An entry goes in its own player's column, and a
 * round that only one of them has played leaves the other cell blank.
 */
function renderMoves(shownCount) {
  const history = game.history();
  renderMovesDisclosure(history);
  if (!movesOpen) return; // nothing below is visible, and none of it is cheap
  els.movesEmpty.classList.toggle('hidden', history.length > 0);
  // Which entry holds the keyboard. The list is rebuilt whole, so without this
  // a turn activated from it — or one arriving from the computer — would drop
  // focus to the top of the page, and the next Tab would start over.
  const focused =
    els.moveList.contains(document.activeElement) && document.activeElement.dataset.ply;

  const rows = [];
  let current = null;
  history.forEach((entry, i) => {
    const column = entry.color === 'w' ? 0 : 1;
    if (!current || current.cells[column] !== null) {
      current = { cells: [null, null] };
      rows.push(current);
    }
    current.cells[column] = { entry, index: i + 1 };
  });

  els.moveList.replaceChildren(
    ...rows.map((row, i) => {
      const li = document.createElement('li');
      li.className = 'move-row';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = `${i + 1}.`;
      li.appendChild(num);
      for (const cell of row.cells) {
        if (!cell) {
          li.appendChild(Object.assign(document.createElement('span'), { className: 'ply' }));
          continue;
        }
        li.appendChild(movesCell(cell, shownCount));
      }
      return li;
    }),
  );
  if (focused) {
    els.moveList.querySelector(`button.ply[data-ply="${focused}"]`)?.focus({ preventScroll: true });
  }
  scrollMoveIntoView();
}

function movesCell({ entry, index }, shownCount) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ply';
  button.dataset.ply = String(index);
  if (entry.kind === 'move') {
    const roll = document.createElement('span');
    roll.className = 'roll';
    roll.textContent = rollNotation(entry.roll);
    button.append(roll, ` ${movesNotation(entry.color, entry.moves) || '—'}`);
  } else {
    button.textContent = entryNotation(entry).trim();
  }
  button.setAttribute('aria-label', `${nameOf(entry.color)}: ${entryNotation(entry).trim()}`);
  // The position on the board — the latest turn while playing, the one being
  // reviewed while stepping back through the game.
  if (index === shownCount) {
    button.classList.add('current');
    button.setAttribute('aria-current', 'true');
  }
  return button;
}

/**
 * Keep the turn on the board in sight: at the bottom of the list while the
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
    list.scrollTop = 0; // the starting position, above the first turn
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
  for (const [el, color] of [
    [els.clockTop, opponent(bottom)],
    [els.clockBottom, bottom],
  ]) {
    const ms = clock.remaining(color);
    const text = formatClock(ms);
    // This runs ten times a second; don't touch the DOM when nothing moved.
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('running', clock.running === color);
    el.classList.toggle('low', ms < LOW_TIME_MS);
    el.classList.toggle('out', ms <= 0);
  }
}

/**
 * The cube, on the half of the board belonging to whoever owns it. Its
 * position is the whole of what cube ownership means, so it is said with
 * placement; the label underneath says it again for a screen reader.
 */
function renderCube() {
  // A game without the cube has no cube on the board. That is the whole of the
  // setting as far as the board is concerned — and it is what stops a player
  // who did not ask for one having to work out what the 1 on the bar means.
  if (game.cubeless() || !boardInPlay()) {
    els.cube.classList.add('hidden');
    return;
  }
  els.cube.classList.remove('hidden');
  const shown = reviewing() ? positionAt(viewEntries()) : game;
  const { value, owner } = shown.cube();
  els.cubeValue.textContent = String(value);
  const side = owner === null ? 'middle' : owner === bottomColor() ? 'bottom' : 'top';
  els.cube.dataset.owner = side;
  const note =
    owner === null
      ? `Doubling cube at ${value}, in the middle — either player may double.`
      : `Doubling cube at ${value}, held by ${sideName(owner)}.`;
  els.cubeNote.textContent = note;
  // The placement says who owns it, and that is worth saying in words too for
  // anyone meeting a cube for the first time.
  els.cube.title = note;
}

function renderReviewBar(shownCount) {
  const total = game.history().length;
  // Disabling the focused button blurs it there and then, so note where the
  // keyboard was before the flags below can take it away.
  const focused = document.activeElement;
  els.reviewFirstBtn.disabled = shownCount === 0;
  els.reviewPrevBtn.disabled = shownCount === 0;
  els.reviewNextBtn.disabled = shownCount >= total;
  els.reviewLastBtn.disabled = shownCount >= total;
  els.matCopyBtn.disabled = total === 0;
  els.matDownloadBtn.disabled = total === 0;
  keepReviewFocus(focused);
  if (!reviewing()) {
    els.reviewNote.textContent = '';
  } else if (shownCount === 0) {
    els.reviewNote.textContent = 'Reviewing the start';
  } else {
    els.reviewNote.textContent = `Reviewing ${entryNotation(game.history()[shownCount - 1]).trim()}`;
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

/* ------------------------------------------------------------------ */
/* Describing an ending                                                */
/* ------------------------------------------------------------------ */

/** The shape every ending shares: who won, how much, and how it reads here. */
function outcomeFor(winner, points, detail = '') {
  const size = `${points} point${points === 1 ? '' : 's'}`;
  if (mode === 'local') {
    return {
      kind: 'win',
      winner,
      points,
      title: `${nameOf(winner)} wins ${size}`,
      sub: detail,
    };
  }
  const mine = winner === myColor;
  return {
    kind: mine ? 'win' : 'loss',
    winner,
    points,
    title: `${mine ? 'You win' : 'You lose'} ${size}`,
    sub: detail,
  };
}

/** Describe a game the engine itself has called. */
function describeEnd(status) {
  const loser = opponent(status.winner);
  if (status.reason === 'dropped') {
    return {
      ...outcomeFor(status.winner, status.points, `${cap(sideName(loser))} refused the cube.`),
      reason: 'dropped',
    };
  }
  if (status.reason === 'resigned') {
    return {
      ...outcomeFor(status.winner, status.points, `${cap(sideName(loser))} resigned.`),
      reason: 'resigned',
    };
  }
  const size = { 1: 'A single game.', 2: 'A gammon — double stakes.', 3: 'A backgammon — triple stakes.' };
  return {
    ...outcomeFor(
      status.winner,
      status.points,
      `${cap(sideName(status.winner))} bore off first. ${size[status.multiplier]}`,
    ),
    reason: status.reason,
  };
}

/** How the game on the board ended, or null while it is still going. */
function currentEnd() {
  if (manualEnd) return manualEnd;
  const status = game.status();
  return status.over ? describeEnd(status) : null;
}

// Fills in the result text and colour; whether it is on screen at all is this
// function's call too, so an unfinished game shows nothing.
function renderBanner() {
  const end = currentEnd();
  els.resultBanner.className = end ? `result-banner ${end.kind}` : 'result-banner hidden';
  els.resultBanner.textContent = end ? `${end.title}${end.sub ? ` · ${end.sub}` : ''}` : '';
}

function showEnd(end) {
  trackGameEnd(end);
  scoreGame(end);
  els.gameoverTitle.textContent = end.title;
  els.gameoverSub.textContent = end.sub;
  for (const [kind, el] of Object.entries(els.gameoverIcons)) {
    el.classList.toggle('shown', kind === end.kind);
  }
  clearTimeout(gameOverTimer);
  gameOverTimer = setTimeout(() => {
    if (!els.gameoverDialog.open) els.gameoverDialog.showModal();
  }, 500);
}

/**
 * Add the points to the sitting's running total. showEnd can be reached more
 * than once for the same game — a re-render, a dialog reopened — so the flag,
 * not the end object, is what makes this once per game.
 */
function scoreGame(end) {
  if (scored || !end.points || !end.winner) return;
  scored = true;
  const mine = mode === 'local' ? end.winner === 'w' : end.winner === myColor;
  if (mine) score.me += end.points;
  else score.them += end.points;
  renderPlayers();
}

/** End the game for a reason the rules cannot see: a flag fall, a walkout. */
function endGameManually(end) {
  manualEnd = end;
  clearSelection();
  // A dialog opened before the game ended (our own pending resign, a cube
  // offer) is now stale — acting on it could overwrite this result.
  closeDialogs();
  announce(`${end.title}. ${end.sub}`);
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
  const showGame = boardInPlay();
  els.cardTop.classList.toggle('hidden', !showGame);
  els.cardBottom.classList.toggle('hidden', !showGame);
  els.movesCard.classList.toggle('hidden', !showGame);
  els.resultBanner.classList.toggle('hidden', !showGame || !els.resultBanner.textContent);

  // Difficulty and colour only mean anything against the computer; pass &
  // play always seats White at the bottom with both sides human. Only the
  // host of an online game picks a colour and a clock — a guest is dealt both.
  const showLevel = mode === 'computer';
  const showColor = mode === 'computer' || showIdle;
  const showTime = !online || showIdle;
  const showCube = !online || showIdle;
  els.levelField.classList.toggle('hidden', !showLevel);
  els.colorField.classList.toggle('hidden', !showColor);
  els.colorLabel.textContent = online ? 'You play' : 'Play as';
  els.timeField.classList.toggle('hidden', !showTime);
  els.cubeField.classList.toggle('hidden', !showCube);
  els.fieldRow.classList.toggle('hidden', !(showLevel || showColor || showTime || showCube));
  if (online) {
    els.controlsHint.textContent =
      'Colour, clock and cube apply to games you create, not ones you join.';
  } else if (showColor) {
    els.controlsHint.textContent = 'Colour, clock and cube take effect when a new game starts.';
  } else {
    els.controlsHint.textContent = 'The clock and cube take effect when a new game starts.';
  }
  els.controlsHint.classList.toggle('hidden', !(showColor || showTime || showCube));

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

/**
 * The turn's own controls: what the game is waiting for, and the one or two
 * buttons that answer it. Everything here follows from the engine's phase and
 * whose turn it is, so there is no separate UI state to keep in step.
 */
function renderActions() {
  const online = mode === 'online';
  const playable = !online || (onlineUiState === 'playing' && !!session?.connected);
  if (!playable || gameFinished()) {
    els.actionRow.classList.add('hidden');
    return;
  }
  els.actionRow.classList.remove('hidden');

  const phase = game.phase();
  const turn = game.turn();
  const mine = myTurnColor();
  // In the opening nobody is on turn yet. Offline this device throws for both
  // players; online the host does, so the two peers cannot both open a roll.
  const opening = phase === 'opening';
  const myRoll = opening ? !online || session?.role === 'host' : mine !== null && mine === turn;

  let note = '';
  let showRoll = false;
  let rollLabel = 'Roll';
  let showDouble = false;

  if (reviewing()) {
    note = 'Reviewing an earlier position.';
  } else if (opening) {
    showRoll = myRoll;
    rollLabel = 'Roll to start';
    note = myRoll ? 'Highest die opens.' : `Waiting for ${opponentLabel()} to open.`;
  } else if (phase === 'double') {
    const asked = game.doubledTo();
    note =
      asked === mine || mode === 'local'
        ? `${cap(sideName(opponent(asked)))} doubled to ${game.cube().value * 2}.`
        : `Waiting for ${sideName(asked)} to answer.`;
  } else if (phase === 'roll') {
    showRoll = myRoll && !waitingForDice;
    showDouble = myRoll && game.canDouble(turn) && !waitingForDice;
    // Pass & play names the side: with two people at one device, "your" is
    // whoever happens to be holding it.
    note = waitingForDice
      ? 'Rolling…'
      : myRoll && mode !== 'local'
        ? 'Your roll.'
        : `${cap(sideName(turn))} to roll.`;
  } else if (phase === 'move') {
    if (thinking) note = 'The computer is thinking…';
    else if (mine !== turn) note = `${cap(sideName(turn))} to play.`;
    else if (game.maxUsed() === 0) note = 'No legal move — the turn passes.';
    else {
      const left = game.maxUsed() - pendingMoves.length;
      note = left === 1 ? 'One die left to play.' : `${left} dice left to play.`;
    }
  }

  els.actionNote.textContent = note;
  els.rollBtn.classList.toggle('hidden', !showRoll);
  els.rollLabel.textContent = rollLabel;
  els.rollBtn.disabled = busy;
  els.doubleBtn.classList.toggle('hidden', !showDouble);
}

function setOnlineError(message) {
  els.onlineError.textContent = message;
  els.onlineError.hidden = !message;
}

/* ------------------------------------------------------------------ */
/* Interaction                                                         */
/* ------------------------------------------------------------------ */

function clearSelection() {
  selected = null;
  targets = new Map();
  pendingToggleOff = false;
  pendingMoves = [];
}

/** Where a checker lifted from `slot` may land, by destination slot. */
function targetsFor(slot) {
  const map = new Map();
  for (const move of game.legalMoves(pendingMoves)) {
    if (move.from !== slot) continue;
    // Two dice can reach the same point; either will do, so the first wins.
    if (!map.has(move.to)) map.set(move.to, move);
  }
  return map;
}

function onSlotPress(slot, event) {
  if (!pickUpAllowed()) return;
  if (selected !== null && targets.has(slot)) {
    applyMove(targets.get(slot));
    return;
  }
  const moves = targetsFor(slot);
  if (moves.size > 0) {
    pendingToggleOff = selected === slot;
    selected = slot;
    targets = moves;
    renderAll();
    boardView.startDrag(slot, event);
  } else if (selected !== null) {
    clearPick();
    renderAll();
  }
}

// Keyboard activation (Enter/Space on a focused slot): the same semantics as a
// pointer press, minus the drag, and pressing the picked-up slot puts it down.
function onSlotActivate(slot) {
  if (!pickUpAllowed()) return;
  if (selected !== null && targets.has(slot)) {
    applyMove(targets.get(slot));
    return;
  }
  if (selected === slot) {
    clearPick();
    renderAll();
    return;
  }
  const moves = targetsFor(slot);
  if (moves.size > 0) {
    selected = slot;
    targets = moves;
    renderAll();
  } else if (selected !== null) {
    clearPick();
    renderAll();
  }
}

function onDrop(from, to, moved) {
  if (!pickUpAllowed()) return;
  if (to !== null && to !== from && targets.has(to)) {
    applyMove(targets.get(to));
    return;
  }
  if (to === from && !moved && pendingToggleOff) clearPick();
  renderAll();
}

function pickUpAllowed() {
  return !busy && !reviewing() && myMove();
}

/** Put a lifted checker down without touching the turn built so far. */
function clearPick() {
  selected = null;
  targets = new Map();
  pendingToggleOff = false;
}

/**
 * Add one checker move to the turn being built, and commit the turn once every
 * die that can be played has been. The engine's own position does not move
 * until then — which is what keeps the clock, the history, the save file and
 * the wire all dealing in whole turns.
 */
function applyMove(move) {
  pendingMoves.push(move);
  clearPick();
  if (!game.isPlayComplete(pendingMoves)) {
    renderAll();
    return;
  }
  commitTurn(pendingMoves.slice());
}

function commitTurn(moves) {
  const played = game.play(moves);
  pendingMoves = [];
  clearPick();
  if (!played) {
    // Should be unreachable: every move was checked as it was added.
    renderAll();
    return;
  }
  const left = afterEntryApplied(played.color, true);
  if (mode === 'online') session?.sendPlay(played.moves, left);
  announce(`${moverName(played.color)} played ${entryNotation(played)}.`);
  renderAll();
  afterTurn();
}

/** Whatever happens next once a turn is over. */
function afterTurn() {
  const status = game.status();
  if (status.over) {
    showEnd(describeEnd(status));
    return;
  }
  resumeTurn();
}

/**
 * Hand the game to whoever is next. Called after a turn, after a cube
 * decision, and when a saved game is picked back up — anywhere the game might
 * be waiting on the computer rather than on a person.
 */
function resumeTurn() {
  // A save can hold a double still waiting for its answer, and the take/drop
  // question it was showing went with the page: ask it again.
  if (!gameFinished() && game.phase() === 'double') {
    askCube();
    return;
  }
  if (gameFinished() || mode !== 'computer') {
    if (myMove() && game.maxUsed() === 0) passTurn();
    return;
  }
  if (game.turn() === myColor) {
    if (myMove() && game.maxUsed() === 0) passTurn();
    return;
  }
  computerTurn();
}

/** A roll with no legal play at all: show it, then hand over. */
function passTurn() {
  if (busy) return;
  setBusy(true);
  const mine = token;
  renderAll();
  setTimeout(() => {
    if (mine !== token) return;
    setBusy(false);
    commitTurn([]);
  }, NO_PLAY_MS);
}

/* ------------------------------------------------------------------ */
/* Rolling                                                             */
/* ------------------------------------------------------------------ */

/**
 * Throw the dice for this device.
 *
 * Offline that is a local throw. Online it is a commit-reveal round with the
 * opponent (see src/net/online.js), so the dice arrive later through
 * `handleRemoteDice` rather than being returned here.
 */
function rollNow() {
  if (busy || gameFinished() || reviewing()) return;
  const phase = game.phase();
  if (phase !== 'roll' && phase !== 'opening') return;
  if (mode === 'online') {
    if (waitingForDice || !session?.connected) return;
    waitingForDice = true;
    renderActions();
    session.startRoll().catch(() => {
      waitingForDice = false;
      showToast('Could not roll — the connection may have dropped.');
      renderAll();
    });
    return;
  }
  applyRoll(rollDice());
}

/**
 * Put a roll on the board. The opening roll is two players' single dice, so a
 * tie decides nothing and is simply thrown again.
 */
function applyRoll(dice) {
  const opening = game.phase() === 'opening';
  if (!game.setRoll(dice[0], dice[1])) {
    if (opening && dice[0] === dice[1]) {
      announce(`Both threw ${dice[0]}. Rolling again.`);
      if (mode === 'online') {
        // Both peers derived the same tie, so both know another round is owed;
        // the host opens it, exactly as it opened the first.
        if (session?.role === 'host') rollNow();
        else renderAll();
        return;
      }
      applyRoll(rollDice());
    }
    return;
  }
  if (opening) {
    announce(
      `${nameOf('w')} rolled ${dice[0]}, ${nameOf('b')} rolled ${dice[1]}. ` +
        `${moverName(game.turn())} to play ${rollNotation(dice)}.`,
    );
    boardView.setOrientation(bottomColor());
  } else {
    announce(`${moverName(game.turn())} rolled ${rollNotation(dice)}.`);
  }
  renderAll();
  resumeTurn();
}

/* ------------------------------------------------------------------ */
/* The computer                                                        */
/* ------------------------------------------------------------------ */

function computerTurn() {
  const mine = token;
  const phase = game.phase();
  if (phase === 'roll') {
    // Turn the cube before the dice, which is the only time it may be turned.
    if (shouldDouble(game, game.turn())) {
      setTimeout(() => {
        if (mine === token && game.phase() === 'roll') offerDouble(game.turn());
      }, COMPUTER_ROLL_MS);
      return;
    }
    setTimeout(() => {
      if (mine === token && game.phase() === 'roll') applyRoll(rollDice());
    }, COMPUTER_ROLL_MS);
    return;
  }
  if (phase !== 'move') return;
  if (game.maxUsed() === 0) {
    passTurn();
    return;
  }
  thinking = true;
  thinkingLevel = level;
  renderAll();
  choosePlay(game, thinkingLevel).then((moves) => {
    if (mine !== token || mode !== 'computer') return;
    thinking = false;
    if (!moves) {
      renderAll();
      return;
    }
    playAnimated(moves, (played) => afterEntryApplied(played.color, true));
  });
}

/**
 * Apply a whole turn that arrived finished — the computer's, or an opponent's
 * — playing it out on screen one checker at a time so the player can see what
 * happened.
 *
 * The boards the animation walks through are captured *before* the engine is
 * told about the turn. Once it has been told, its own position is the one at
 * the end, and every frame of the walk would draw that instead — so the whole
 * sequence has to be photographed first and then played back.
 *
 * @returns false if the engine refused the play, which the caller decides
 *   what to make of: unreachable for the computer's own moves, and a peer
 *   out of step (or not playing straight) for a turn off the wire.
 */
function playAnimated(moves, onApplied) {
  const color = game.turn();
  const dice = game.diceSequence();
  const before = game.preview([]);
  const walked = [];
  const frames = moves.map((move) => {
    walked.push(move);
    return { board: game.preview(walked.slice()), used: walked.length };
  });

  const played = game.play(moves);
  if (!played) {
    renderAll();
    return false;
  }
  onApplied?.(played);
  announce(`${moverName(played.color)} played ${entryNotation(played)}.`);

  const drawFrame = ({ board, used }) => {
    boardView.render({
      points: board.points,
      off: board.off,
      moverColor: color,
      selected: null,
      targets: NO_TARGETS,
      movable: NO_MOVABLE,
      dice: { values: dice, used: dice.map((_, i) => i < used), color },
      lastMoves: [],
    });
  };

  const mine = token;
  setBusy(true);
  drawFrame({ board: before, used: 0 });
  boardView.animatePlay(
    moves.map((move, i) => ({
      from: move.from,
      to: move.to,
      draw: () => drawFrame(frames[i]),
    })),
    () => {
      if (mine !== token) return;
      setBusy(false);
      renderAll();
      afterTurn();
    },
    color,
  );
  return true;
}

/* ------------------------------------------------------------------ */
/* The doubling cube                                                   */
/* ------------------------------------------------------------------ */

function requestDouble() {
  const turn = game.turn();
  if (busy || reviewing() || !turn) return;
  if (myTurnColor() !== turn || !game.canDouble(turn)) return;
  offerDouble(turn);
  if (mode === 'online') session?.sendDouble();
}

/** Put the cube on the table, and ask whoever has to answer it. */
function offerDouble(color) {
  const offer = game.double();
  if (!offer) return;
  afterEntryApplied(color, false);
  announce(`${moverName(color)} doubled to ${offer.to}.`);
  renderAll();
  askCube();
}

/**
 * Ask for a take or a drop — of the player at this device, of the computer, or
 * of nobody at all when it is an online opponent's decision to make.
 */
function askCube() {
  const asked = game.doubledTo();
  if (!asked) return;
  const stake = game.cube().value * 2;
  if (mode === 'computer' && asked !== myColor) {
    const mine = token;
    setTimeout(() => {
      if (mine !== token || game.phase() !== 'double') return;
      if (shouldTake(game, asked)) answerCube(true);
      else answerCube(false);
    }, 900);
    return;
  }
  if (mode === 'online' && asked !== myColor) return; // theirs to answer
  els.cubeOffer.textContent = String(stake);
  els.cubeTitle.textContent = mode === 'local' ? `${nameOf(asked)}, take or drop?` : 'You have been doubled';
  els.cubeSub.textContent = `${cap(sideName(opponent(asked)))} doubled the stake to ${stake}. Take it, or drop and lose ${game.cube().value}.`;
  if (!els.cubeDialog.open) els.cubeDialog.showModal();
}

function answerCube(take) {
  if (game.phase() !== 'double') return;
  const asked = game.doubledTo();
  if (els.cubeDialog.open) els.cubeDialog.close();
  if (take) {
    const entry = game.take();
    if (!entry) return;
    afterEntryApplied(asked, false);
    if (mode === 'online' && asked === myColor) session?.sendTake();
    announce(`${moverName(asked)} took. The stake is ${entry.value}.`);
    showToast(`${cap(sideName(asked))} took — the game is worth ${entry.value}.`);
    renderAll();
    resumeTurn();
    return;
  }
  const entry = game.drop();
  if (!entry) return;
  afterEntryApplied(asked, false);
  if (mode === 'online' && asked === myColor) session?.sendDrop();
  renderAll();
  showEnd(describeEnd(game.status()));
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
  if (els.cubeDialog.open) els.cubeDialog.close();
}

/* ------------------------------------------------------------------ */
/* Game flow controls                                                  */
/* ------------------------------------------------------------------ */

function newGame() {
  if (mode === 'online') return; // online games start via the session flow
  token++;
  thinking = false;
  setBusy(false); // an escape hatch: a fresh game must never inherit a stuck board
  waitingForDice = false;
  myColor =
    mode === 'computer'
      ? colorSetting === 'random'
        ? Math.random() < 0.5
          ? 'w'
          : 'b'
        : colorSetting
      : 'w';
  manualEnd = null;
  reviewIndex = null;
  scored = false;
  game.reset();
  game.setCubeless(!cubeSetting);
  resetClock(timeSetting);
  trackPlayedAgain();
  resetTracking();
  clearSelection();
  clearTimeout(gameOverTimer);
  closeDialogs();
  boardView.setOrientation(bottomColor());
  announced = '';
  announce(
    mode === 'local'
      ? 'New game. Roll to see who starts.'
      : `New game. You play ${nameOf(myColor)}. Roll to see who starts.`,
  );
  renderAll();
}

/**
 * Undo, which means one of two different things depending on where the turn
 * has got to: take back the last checker moved, or — once no half-built turn
 * is left — take back the whole turn before it.
 *
 * Taking back a turn puts its dice back on the table exactly as they were.
 * Undo in a game with dice would otherwise be a re-roll, and re-rolling until
 * the numbers suit is not a game.
 */
function undo() {
  if (!canUndo()) return;
  if (pendingMoves.length) {
    pendingMoves.pop();
    clearPick();
    renderAll();
    return;
  }
  token++;
  thinking = false;
  // Taking a turn back also takes back an end the app declared for itself —
  // running out of time is the one a player can undo their way out of.
  manualEnd = null;
  clearTimeout(gameOverTimer);
  if (els.gameoverDialog.open) els.gameoverDialog.close();
  // Keep going while the position it lands on is not one the player can act
  // in: the computer's own reply, or a roll that had no legal play and would
  // simply pass itself again.
  while (game.lastEntry()?.kind === 'move') {
    undoEntry();
    const stuck = game.phase() === 'move' && game.maxUsed() === 0;
    const theirs = mode === 'computer' && game.turn() !== myColor;
    if ((!stuck && !theirs) || game.history().length === 0) break;
  }
  clearSelection();
  announce('Turn taken back.');
  renderAll();
  // The loop above stops at a cube action, which cannot be taken back — so it
  // can land on a position that is not the player's to act in after all. Hand
  // it on rather than leave a board nothing will move.
  resumeTurn();
}

/** Take back one history entry, rewinding the clocks with it. */
function undoEntry() {
  if (!game.undo()) return;
  const before = clockStack.pop();
  if (before) clock.restore(before);
}

/** Drop every game/session in progress ahead of a mode change. */
function teardownForModeChange() {
  // The game being left is stored as it stands — clock reading included, which
  // the last render will not have caught up with — so that coming back to
  // this mode picks it up exactly where it was.
  saveNow();
  // Each mode keeps a save of its own; assume the next one has something in
  // storage until a render proves otherwise.
  hasSave = true;
  if (session) {
    session.leave();
    session = null;
  }
  token++;
  thinking = false;
  setBusy(false); // an escape hatch: the next mode must never inherit a stuck board
  waitingForDice = false;
  opponentName = null;
  rematchOffered = false;
  manualEnd = null;
  reviewIndex = null;
  scored = false;
  score = { me: 0, them: 0 }; // a new mode is a new sitting
  closeDialogs();
}

function setMode(next) {
  if (next === mode || !MODES.includes(next)) return;
  const perform = () => {
    teardownForModeChange();
    mode = next;
    saveSettings();
    if (mode === 'online') enterOnlineIdle();
    else if (!restoreGame()) newGame();
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
  myColor = 'w';
  manualEnd = null;
  reviewIndex = null;
  scored = false;
  waitingForDice = false;
  onlineCubeless = !cubeSetting;
  game.reset();
  game.setCubeless(onlineCubeless);
  // No clock until a game exists: an online game runs on the host's control,
  // which this side only learns at the handshake.
  resetClock(DEFAULT_TIME_ID);
  resetTracking();
  clearSelection();
  clearTimeout(gameOverTimer);
  boardView.setOrientation('w');
  announced = '';
  setOnlineError('');
  els.onlineInviteNote.hidden = !inviteCode;
  els.joinInput.value = inviteCode || '';
  announce(
    inviteCode
      ? 'You have been invited to a game. Press Join to connect.'
      : 'Online mode. Create a game or join with an invite code.',
  );
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
    onDice: (dice, rolledHere) => session === s && handleRemoteDice(dice, rolledHere),
    onPlay: (play) => session === s && handleRemotePlay(play),
    onDouble: () => session === s && handleRemoteDouble(),
    onTake: () => session === s && handleRemoteCubeAnswer(true),
    onDrop: () => session === s && handleRemoteCubeAnswer(false),
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
    const code = await s.host(color, timeSetting, !cubeSetting);
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
    announce('Game created. Share the invite code with your friend.');
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
  const fromState = onlineUiState;
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
  const message = (typeof err === 'string' && err) || err?.message || err?.error?.message || '';
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

function handleSessionStart({ myColor: assigned, opponentName: name, role, timeId, cubeless }) {
  myColor = assigned;
  onlineCubeless = cubeless;
  opponentName = name || null;
  score = { me: 0, them: 0 };
  track('Online Game Connected', { role });
  const control = timeControl(timeId);
  startOnlineGame(
    `Connected to ${opponentLabel()}. You play ${nameOf(myColor)}${
      control ? ` — ${control.label}` : ''
    }${cubeless ? '' : ', with the doubling cube'}.`,
  );
  if (!canDeriveFairly()) {
    // Without WebCrypto the commit-reveal round cannot run, and this app will
    // not fall back to letting one side pick its own numbers.
    showToast('This browser cannot roll dice securely — online play needs a secure connection.');
  }
}

function startRematch() {
  if (!session?.connected) return;
  session.swapColors();
  myColor = session.myColor;
  startOnlineGame(`Rematch started — you now play ${nameOf(myColor)}.`);
}

function startOnlineGame(announcement) {
  token++;
  thinking = false;
  setBusy(false);
  waitingForDice = false;
  onlineUiState = 'playing';
  rematchOffered = false;
  manualEnd = null;
  reviewIndex = null;
  scored = false;
  game.reset();
  // Both games of a rematch run on the control — and the cube — the host set
  // at the start.
  game.setCubeless(onlineCubeless);
  resetClock(session?.timeId || DEFAULT_TIME_ID);
  trackPlayedAgain();
  resetTracking();
  clearSelection();
  clearTimeout(gameOverTimer);
  closeDialogs();
  boardView.setOrientation(myColor);
  announced = '';
  announce(announcement);
  showToast(announcement);
  renderAll();
}

/**
 * A commit-reveal round has settled and both peers now hold the same two dice.
 * Whether the roll was owed at all is not something the session can see, so
 * it is judged here, where the game's phase and turn are known: a roll
 * arriving when nobody was waiting for one is an opponent trying to throw
 * again, and one the opponent opened on this side's turn would take the turn
 * away — along with the double it might have started with.
 */
function handleRemoteDice(dice, rolledHere) {
  if (mode !== 'online' || onlineUiState !== 'playing' || gameFinished()) return;
  waitingForDice = false;
  const phase = game.phase();
  if (phase !== 'roll' && phase !== 'opening') {
    protocolError('Your opponent tried to roll again mid-turn.');
    return;
  }
  // The host throws the opening roll; after that the side to move throws.
  const myRoll = phase === 'opening' ? session?.role === 'host' : game.turn() === myColor;
  if (myRoll !== !!rolledHere) {
    protocolError(
      rolledHere ? 'The game went out of sync and had to end.' : 'Your opponent rolled on your turn.',
    );
    return;
  }
  applyRoll(dice);
}

function handleRemotePlay({ moves, clock: remoteClock }) {
  if (mode !== 'online' || onlineUiState !== 'playing' || gameFinished()) return;
  if (game.phase() !== 'move' || game.turn() === myColor) {
    protocolError('The game went out of sync and had to end.');
    return;
  }
  const color = game.turn();
  const applied = playAnimated(moves, (played) => {
    afterEntryApplied(played.color, true);
    applyRemoteClock(color, remoteClock);
  });
  // A play the rules refuse cannot simply be dropped: the other board has
  // already moved on, and this one would wait forever with no explanation.
  if (!applied) protocolError('Your opponent made a play the rules do not allow.');
}

function handleRemoteDouble() {
  if (mode !== 'online' || onlineUiState !== 'playing' || gameFinished()) return;
  // A double the rules do not allow — not their turn, dice already thrown,
  // the cube owned by this side, or no cube in this game at all — cannot
  // come from an honest peer, and dropping it quietly would leave their
  // board waiting on an answer this one never knows it owes.
  if (game.phase() !== 'roll' || game.turn() === myColor || !game.canDouble(game.turn())) {
    protocolError('Your opponent doubled when the cube was not theirs to turn.');
    return;
  }
  offerDouble(game.turn());
}

function handleRemoteCubeAnswer(took) {
  if (mode !== 'online' || onlineUiState !== 'playing' || game.phase() !== 'double') return;
  // Only the side that was doubled gets to answer. An answer arriving while
  // the cube is on this side's table could only be the opponent answering on
  // this side's behalf — with a take, so that a double it would have dropped
  // stands at twice the stake.
  if (game.doubledTo() === myColor) {
    protocolError('Your opponent answered a double that was yours to answer.');
    return;
  }
  answerCube(took);
}

/**
 * The peers disagree about the game, or one of them is not playing straight.
 * Either way there is no way to keep playing.
 */
function protocolError(text) {
  session?.leave();
  session = null;
  onlineUiState = 'ended';
  setBusy(false);
  clearSelection();
  closeDialogs();
  showToast(`${text} Please start a new one.`);
  announce(text);
  renderAll();
}

/**
 * The opponent says the game ended on time. Either side may be the one to
 * notice — they report their own flag, and they claim ours if we went quiet —
 * so this accepts whichever colour they name, within reason: their own flag
 * is theirs to concede, but a claim that *this* side ran out is checked
 * against this side's own clock, which is the authoritative one for it. An
 * honest peer's copy of our clock runs at most a network hop ahead, and it
 * waits out the grace period before claiming, so a reading still comfortably
 * above that cannot be a flag — and in an untimed game nothing can be.
 */
function handleRemoteFlag(loser) {
  if (mode !== 'online' || onlineUiState !== 'playing' || gameFinished()) return;
  if (loser === myColor && clock.remaining(myColor) > FLAG_GRACE_MS * 2) return;
  clock.setRunning(null);
  stopClockTimer();
  endGameManually(describeTimeout(loser));
}

function handleOpponentResign() {
  if (mode !== 'online' || gameFinished()) return;
  endGameManually({
    ...outcomeFor(myColor, game.cube().value, `${opponentLabel()} resigned.`),
    reason: 'opponent resigned',
  });
}

function requestResign() {
  if (!(mode === 'online' && session?.connected && !gameFinished())) return;
  askConfirm(
    {
      title: 'Resign this game?',
      sub: `${opponentLabel()} will win ${game.cube().value} point${
        game.cube().value === 1 ? '' : 's'
      }.`,
      confirmLabel: 'Resign',
    },
    () => {
      // The game may have ended while the dialog was open (opponent resigned
      // or left) — never let a stale confirmation overwrite that result.
      if (!session?.connected || gameFinished()) return;
      session.sendResign();
      endGameManually({
        ...outcomeFor(opponent(myColor), game.cube().value, 'You resigned.'),
        reason: 'resigned',
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
    score = { me: 0, them: 0 };
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
  if (!(mode === 'online' && session?.connected && gameFinished()) || rematchOffered) return;
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
  els.rematchSub.textContent = `${opponentLabel()} wants to play again — colours swap.`;
  rematchAnswered = false;
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
  waitingForDice = false;
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
    // Leaving before the game began aborts it rather than losing it.
    endGameManually(
      game.history().length === 0 && game.phase() === 'opening'
        ? {
            kind: 'draw',
            winner: null,
            points: 0,
            reason: 'aborted',
            title: 'Game aborted',
            sub: `${opponentLabel()} left before the first roll.`,
          }
        : {
            ...outcomeFor(myColor, game.cube().value, `${opponentLabel()} left the game.`),
            reason: 'opponent left',
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
/* Export                                                              */
/* ------------------------------------------------------------------ */

/** Player names for the export, in the language of the current mode. */
function matNames() {
  if (mode === 'local') return { w: 'White', b: 'Black' };
  const me = mode === 'online' ? 'You' : 'Player';
  const them = mode === 'online' ? opponentName || 'Opponent' : `Computer (${LEVELS[level].label})`;
  return myColor === 'w' ? { w: me, b: them } : { w: them, b: me };
}

function currentMat(date) {
  const end = currentEnd();
  const names = matNames();
  return buildMat({
    history: game.history(),
    white: names.w,
    black: names.b,
    result: end && end.winner ? { winner: end.winner, points: end.points } : null,
    date,
    control: clock.control,
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

async function copyMat() {
  if (game.history().length === 0) return;
  if (await copyToClipboard(currentMat(new Date()))) showToast('Game copied as a .mat transcript.');
  else showToast('Copy failed — your browser blocked clipboard access.');
}

function downloadMat() {
  if (game.history().length === 0) return;
  const now = new Date();
  let url = null;
  try {
    url = URL.createObjectURL(new Blob([currentMat(now)], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = matFilename(now);
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Released on a later task, once the download has certainly started.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast('Game saved as a .mat file.');
  } catch {
    if (url) URL.revokeObjectURL(url);
    copyMat(); // no downloads here; the clipboard still gets the player the game
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
  waitingForDice = false;
  if (gameFinished()) {
    onlineUiState = 'ended';
    closeDialogs();
    renderAll();
  } else {
    opponentName = null;
    score = { me: 0, them: 0 };
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
  announce(text);
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

els.rollBtn.addEventListener('click', rollNow);
els.doubleBtn.addEventListener('click', requestDouble);
els.newGameBtn.addEventListener('click', newGame);
els.undoBtn.addEventListener('click', undo);
els.resignBtn.addEventListener('click', requestResign);
els.leaveBtn.addEventListener('click', requestLeave);
els.rematchBtn.addEventListener('click', offerRematch);
els.gameoverNew.addEventListener('click', () => {
  if (mode === 'online') offerRematch();
  else newGame();
});
els.gameoverClose.addEventListener('click', () => els.gameoverDialog.close());

els.cubeTake.addEventListener('click', () => answerCube(true));
els.cubeDrop.addEventListener('click', () => answerCube(false));

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
els.reviewPrevBtn.addEventListener('click', () => goToPly(viewEntries() - 1));
els.reviewNextBtn.addEventListener('click', () => goToPly(viewEntries() + 1));
els.reviewLastBtn.addEventListener('click', () => goToPly(game.history().length));

// The move list is rebuilt on every render, so the click lands on the list.
els.moveList.addEventListener('click', (e) => {
  const ply = e.target.closest('button.ply');
  if (ply) goToPly(Number(ply.dataset.ply));
});

els.movesToggle.addEventListener('click', () => setMovesOpen(!movesOpen));

els.matCopyBtn.addEventListener('click', copyMat);
els.matDownloadBtn.addEventListener('click', downloadMat);

els.levelSelect.addEventListener('change', () => {
  level = els.levelSelect.value;
  saveSettings();
  renderAll();
});

els.colorSelect.addEventListener('change', () => {
  colorSetting = els.colorSelect.value;
  saveSettings();
});

els.cubeSelect.addEventListener('change', () => {
  cubeSetting = els.cubeSelect.value === 'on';
  saveSettings();
  // Nothing has been thrown yet, so there is no game to disturb: put the cube
  // on the board (or take it off) at once rather than making the player press
  // New game to see the choice they just made.
  if (mode !== 'online' && !gameFinished() && game.phase() === 'opening') {
    game.setCubeless(!cubeSetting);
  }
  renderAll();
});

els.timeSelect.addEventListener('change', () => {
  timeSetting = els.timeSelect.value;
  saveSettings();
  // Nothing has been thrown yet, so there is no game to disturb: put the new
  // clock on the board at once rather than making the player press New game
  // to see the choice they just made.
  if (mode !== 'online' && !gameFinished() && game.phase() === 'opening') {
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

// The cube dialog is deliberately not dismissible by backdrop or Escape: an
// unanswered double leaves the game with nowhere to go, and on the other side
// of a wire it leaves a real person waiting.
els.cubeDialog.addEventListener('cancel', (e) => e.preventDefault());

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
  return (
    els.gameoverDialog.open ||
    els.confirmDialog.open ||
    els.rematchDialog.open ||
    els.cubeDialog.open
  );
}

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Escape in the account menu closes that menu and nothing else.
  if (inUserMenu(e.target)) return;
  // Dialogs close natively on Escape; handle them here too so the shortcut
  // cannot be lost, and so Escape means "close dialog" before "put down".
  if (els.gameoverDialog.open) els.gameoverDialog.close();
  else if (els.confirmDialog.open) els.confirmDialog.close();
  else if (els.rematchDialog.open) els.rematchDialog.close();
  else if (selected !== null) {
    // A checker still held under the pointer is dropped along with the
    // selection, rather than left riding the cursor with nowhere to land.
    boardView.cancelDrag();
    clearPick();
    renderAll();
  }
});

// Step through the game with the arrow keys. Two things already own these
// keys and keep them: a focused slot, where they move around the board's
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
  const count = viewEntries();
  switch (e.key) {
    case 'ArrowLeft': goToPly(count - 1); break;
    case 'ArrowRight': goToPly(count + 1); break;
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
// clock where it stands rather than leaving the reading from the last turn.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveNow();
});

// Restored from the back/forward cache: pagehide already said goodbye, so the
// session object is dead — reflect that instead of showing stale state.
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  if (session) {
    session = null;
    rematchOffered = false;
    waitingForDice = false;
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

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
  FileUp,
} from 'lucide';

import { Chess, colorOf } from './engine/chess.js';
import { chooseMove, LEVELS } from './engine/ai.js';
import { BoardView, pieceUrl, pieceLabel } from './ui/boardView.js';
import { OnlineSession, loadPuter } from './net/online.js';
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
import { buildPgn, parsePgn, pgnFilename, replayPgn } from './game/pgn.js';
import { clearGame, loadGame, saveGame } from './game/persistence.js';
import { track } from './analytics.js';

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
    FileUp,
  },
});

const $ = (id) => document.getElementById(id);

const els = {
  board: $('board'),
  resultBanner: $('result-banner'),
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
  moveList: $('move-list'),
  movesEmpty: $('moves-empty'),
  pgnImportBtn: $('pgn-import-btn'),
  pgnCopyBtn: $('pgn-copy-btn'),
  pgnDownloadBtn: $('pgn-download-btn'),
  pgnDialog: $('pgn-dialog'),
  pgnInput: $('pgn-input'),
  pgnError: $('pgn-error'),
  pgnFile: $('pgn-file'),
  pgnFileBtn: $('pgn-file-btn'),
  pgnCancel: $('pgn-cancel'),
  pgnLoad: $('pgn-load'),
  reviewFirstBtn: $('review-first-btn'),
  reviewPrevBtn: $('review-prev-btn'),
  reviewNextBtn: $('review-next-btn'),
  reviewLastBtn: $('review-last-btn'),
  reviewNote: $('review-note'),
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
  promoDialog: $('promo-dialog'),
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

const SETTINGS_KEY = 'chess-settings';
// Display values for material difference (knight/bishop both count as 3).
const DISPLAY_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const MODES = ['computer', 'local', 'online'];
const MODE_NOTES = {
  computer: 'Player vs. Computer',
  local: 'Pass & Play',
  online: 'Online Match',
};
/** How the mode switch names each mode. */
const MODE_LABELS = { computer: 'Computer', local: 'Pass & Play', online: 'Online' };
/** Clock repaint rate. Tenths are shown when the time is low; this reads them. */
const CLOCK_TICK_MS = 100;
/**
 * How long an opponent's empty clock has to stay empty before this side claims
 * the win. Our copy of their clock runs one network hop ahead of theirs, and a
 * backgrounded tab can hold their move in the queue past the moment they made
 * it, so a flag is never claimed on the instant it appears.
 */
const FLAG_GRACE_MS = 2500;
/** Shared by every board render that has nothing to highlight. */
const NO_TARGETS = new Map();

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const game = new Chess();
let mode = 'computer'; // 'computer' | 'local' | 'online'
let myColor = 'w'; // side controlled at this device (computer & online modes)
let level = 'medium';
let colorSetting = 'w';
let timeSetting = DEFAULT_TIME_ID; // time control for the next game we start
let themeSetting = 'system';
let thinking = false;
let thinkingLevel = null; // level the in-flight search actually uses
let aiToken = 0;
let selected = null;
let targets = new Map();
let pendingToggleOff = false;
let promoResolve = null;
let gameOverTimer = 0;
let announcedPlies = 0;

// Clocks. `clock` belongs to the game on the board (an untimed game gets a
// disabled one), and `clockStack` holds each side's time as it stood at the
// start of every ply, which is what undo rewinds to.
let clock = new Clock(null);
let clockTimer = 0;
let clockStack = [];
let flagSeenAt = 0; // when an opponent's clock was first seen empty
let lowAnnounced = { w: false, b: false }; // said "time is low" this game

// Reviewing an earlier position. null means the board shows the live game;
// otherwise it is the number of plies being shown.
let reviewIndex = null;

// Whether anything is currently in storage, so a game that cannot be saved
// (online, finished, not started) only clears it once instead of every render.
let hasSave = true;

// What the move list was last scrolled for: the ply on the board and the
// length of the game. While neither changes, the list keeps whatever scroll
// position the player has given it.
let movesShown = { plies: -1, total: -1 };

// Online play.
let session = null; // OnlineSession while hosting/joining/playing
let onlineUiState = 'idle'; // 'idle'|'creating'|'hosting'|'joining'|'playing'|'ended'
let onlineReturnState = 'idle'; // where a failed create/join falls back to
let opponentName = null; // kept after the session ends for result text
let manualEnd = null; // {kind,title,sub} for ends the engine can't see (resign, abandon)
let rematchOffered = false; // we offered a rematch and await the reply
let rematchAnswered = false; // guards the incoming-offer dialog's close event
let importedNames = null; // {w, b} player names from a loaded PGN, or null
let confirmAction = null;
let toastTimer = 0;
let copyCodeTimer = 0;
let copyLinkTimer = 0;

const colorName = (color) => (color === 'w' ? 'White' : 'Black');
const otherColor = (color) => (color === 'w' ? 'b' : 'w');
const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);
/** The PGN result for a game `winner` won. */
const resultFor = (winner) => (winner === 'w' ? '1-0' : '0-1');

/** The color shown at the bottom of the board. */
function bottomColor() {
  return mode === 'local' ? 'w' : myColor;
}

function gameFinished() {
  return !!manualEnd || game.isGameOver();
}

/**
 * Is there a game on the board worth protecting from a stray click? One that
 * is still going and that the player has actually put moves into — against the
 * computer, the computer's own opening move does not count.
 */
function gameInProgress() {
  if (mode === 'online' || gameFinished()) return false;
  if (mode === 'computer') return game.history().some((m) => m.color === myColor);
  return game.history().length > 0;
}

function opponentLabel() {
  return opponentName || 'Your friend';
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

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/*                                                                     */
/* Five events, each standing for something a player actually got out  */
/* of the app: a game played, a game seen through to its end, an       */
/* invite made, a friend actually reaching the board, and a rematch.   */
/* Both flags reset with the board, so undo and repeated game-over     */
/* renders cannot double-count.                                        */
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
  // Games that ended before anyone moved (an opponent leaving the lobby)
  // never happened as far as the numbers are concerned.
  if (endTracked || game.history().length === 0) return;
  endTracked = true;
  // `result` is this device's point of view. Pass & play has no "you", so a
  // decisive game there is always reported as a win.
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

/**
 * The result of a flag fall. Running out of time loses — unless the opponent
 * could not deliver mate with what is left on the board, which under FIDE 6.9
 * makes the game a draw instead.
 */
function describeTimeout(loser) {
  const winner = otherColor(loser);
  const base = { reason: 'timeout', termination: 'time forfeit' };
  if (!game.hasMatingMaterial(winner)) {
    return {
      ...base,
      kind: 'draw',
      result: '1/2-1/2',
      title: 'Draw',
      sub: `${cap(sideName(loser))} ran out of time, but ${sideName(winner)} cannot checkmate.`,
    };
  }
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
 * start. A whole game is a few hundred moves and the engine makes short work
 * of them, which is cheaper to keep correct than a cache that would have to be
 * invalidated every time the live game moves on underneath it.
 */
function positionAt(plies) {
  const replay = new Chess();
  const history = game.history();
  for (let i = 0; i < plies; i++) {
    replay.move({
      from: history[i].from,
      to: history[i].to,
      promotion: history[i].promotion || 'q',
    });
  }
  return replay;
}

/** How a ply is written in chess: "12." for White's move, "12…" for Black's. */
function plyLabel(plies) {
  return `${Math.ceil(plies / 2)}${plies % 2 === 1 ? '.' : '…'}`;
}

function goToPly(target) {
  const total = game.history().length;
  const plies = Math.max(0, Math.min(total, target));
  const next = plies === total ? null : plies;
  if (next === reviewIndex) return;
  reviewIndex = next;
  // A piece cannot stay picked up across a jump to another position.
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
    els.srStatus.textContent = `${colorName(move.color)} played ${move.san}. Reviewing.`;
  }
}

/* ------------------------------------------------------------------ */
/* Saving a game in progress                                           */
/* ------------------------------------------------------------------ */

/**
 * Keep storage in step with the board. Called from renderAll, so no state
 * change can forget to; also called when the page is hidden or leaving, which
 * is the only way a clock reading taken mid-move gets stored.
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
    moves: game.history().map((m) => ({ from: m.from, to: m.to, promotion: m.promotion })),
    clock: clock.enabled ? clock.snapshot() : null,
    clockStack: clock.enabled ? clockStack : [],
  });
  hasSave = true;
}

/**
 * Put back the game stored by an earlier visit. Returns false when there is
 * nothing to restore, or when what is there doesn't replay — in which case the
 * caller starts a new game as usual.
 */
function restoreGame() {
  const saved = loadGame();
  if (!saved || saved.mode !== mode) return false;

  let ok = true;
  try {
    game.reset();
    for (const move of saved.moves) {
      if (!game.move({ from: move.from, to: move.to, promotion: move.promotion || 'q' })) {
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
  resetClock(saved.time);
  if (clock.enabled && saved.clock) clock.restore(saved.clock);
  if (clock.enabled) clockStack = saved.clockStack.map((c) => ({ ...c }));
  // A stored game has moves, so it was already counted as started.
  resetTracking();
  startTracked = true;
  finishPromotion(null);
  clearSelection();
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

function renderAll() {
  clampReview();
  // Before anything is drawn, so the clocks are painted in the state they are
  // actually in rather than the one they were in a moment ago.
  syncClock();
  const plies = viewPlies();
  const live = !reviewing();
  // The board shows the position being reviewed; everything that describes the
  // game as it stands — the player cards, the clocks, the result — stays live.
  const shown = live ? game : positionAt(plies);
  const liveStatus = game.status();
  const shownStatus = live ? liveStatus : shown.status();
  const shownLast = shown.lastMove();

  boardView.render({
    board: shown.board(),
    selected: live ? selected : null,
    targets: live ? targets : NO_TARGETS,
    lastMove: shownLast ? { from: shownLast.from, to: shownLast.to } : null,
    checkSquare: shownStatus.check ? shown.kingSquare(shownStatus.turn) : null,
  });
  els.board.classList.toggle('reviewing', !live);

  renderPlayers(liveStatus);
  renderClocks();
  renderCaptures(plies);
  renderMoves(plies);
  renderReviewBar(plies);
  renderBanner(liveStatus);
  announceState(liveStatus, game.lastMove());

  els.undoBtn.disabled = !canUndo();
  updateModeUi();
  saveNow();
}

/** Undo takes back from the live position, so it is off while reviewing. */
function canUndo() {
  if (mode === 'online' || reviewing()) return false;
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

/** Tell assistive technology about moves, check, and game results. */
function announceState(status, lastMove) {
  const plies = game.history().length;
  if (plies === announcedPlies) return;
  let text;
  if (plies < announcedPlies) {
    text = 'Move taken back.';
  } else {
    text = `${moverName(lastMove.color)} played ${lastMove.san}.`;
    if (status.over) {
      const end = describeEnd(status);
      text += ` ${end.title} — ${end.sub}`;
    } else if (status.check) {
      text += ' Check.';
    }
  }
  announcedPlies = plies;
  els.srStatus.textContent = text;
}

function renderPlayers(status) {
  const bottom = bottomColor();
  const top = otherColor(bottom);
  const finished = status.over || !!manualEnd;

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
    els.topName.textContent = (importedNames && importedNames[top]) || colorName(top);
    els.topCaption.textContent = MODE_NOTES.local;
    els.bottomName.textContent = (importedNames && importedNames[bottom]) || colorName(bottom);
    els.bottomCaption.textContent = MODE_NOTES.local;
  } else {
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

function renderCaptures(plies) {
  const bottom = bottomColor();
  const byBottom = [];
  const byTop = [];
  // Only what has been captured in the position on the board, so a reviewed
  // position and the pieces beside it describe the same moment.
  for (const move of game.history().slice(0, plies)) {
    if (!move.captured) continue;
    (move.color === bottom ? byBottom : byTop).push(move.captured);
  }
  const value = (list) =>
    list.reduce((sum, piece) => sum + DISPLAY_VALUES[piece.toLowerCase()], 0);
  const fill = (el, list) => {
    list.sort(
      (a, b) => DISPLAY_VALUES[b.toLowerCase()] - DISPLAY_VALUES[a.toLowerCase()],
    );
    el.replaceChildren(
      ...list.map((piece) => {
        const img = document.createElement('img');
        img.src = pieceUrl(piece);
        img.alt = pieceLabel(piece);
        return img;
      }),
    );
  };
  fill(els.capturesBottom, byBottom);
  fill(els.capturesTop, byTop);
  const diff = value(byBottom) - value(byTop);
  els.materialBottom.textContent = diff > 0 ? `+${diff}` : '';
  els.materialTop.textContent = diff < 0 ? `+${-diff}` : '';
}

function renderMoves(plies) {
  const history = game.history();
  els.movesEmpty.classList.toggle('hidden', history.length > 0);
  // Which ply holds the keyboard. The list is rebuilt whole, so without this a
  // move activated from it — or one arriving from the opponent — would drop
  // focus to the top of the page, and the next Tab would start over.
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
        // White has moved and Black has not: a blank that holds the column.
        row.appendChild(Object.assign(document.createElement('span'), { className: 'ply' }));
        continue;
      }
      const ply = document.createElement('button');
      ply.type = 'button';
      ply.className = 'ply';
      ply.textContent = move.san;
      ply.dataset.ply = String(j + 1);
      ply.setAttribute(
        'aria-label',
        `${colorName(move.color)} move ${Math.ceil((j + 1) / 2)}, ${move.san}`,
      );
      if (j + 1 === plies) {
        ply.classList.add('current');
        ply.setAttribute('aria-current', 'true');
      }
      row.appendChild(ply);
    }
    rows.push(row);
  }
  els.moveList.replaceChildren(...rows);
  // Put the keyboard back on the same ply. Scrolling is left to the lines
  // below, which know which move the board is showing.
  if (focusedPly) {
    els.moveList
      .querySelector(`button.ply[data-ply="${focusedPly}"]`)
      ?.focus({ preventScroll: true });
  }
  // Scroll only when the move on the board has changed. The list is rebuilt on
  // every render — picking up a piece is one — and a player who has scrolled
  // up to look over the opening should not be yanked back down for it.
  if (plies !== movesShown.plies || history.length !== movesShown.total) {
    movesShown = { plies, total: history.length };
    scrollMoveIntoView();
  }
}

/**
 * Keep the move on the board in sight: at the bottom of the list while the
 * game is live, and inside the visible rows while reviewing. Scrolling is
 * measured against the list's own box so that it, and never an ancestor,
 * is what moves.
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
    els.reviewNote.textContent = `Reviewing ${plyLabel(plies)} ${game.history()[plies - 1].san}`;
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
 * Describe a game the engine has called. `result` and `termination` are the
 * PGN spellings of the same thing, for the export; every end the app makes up
 * itself (a resignation, a flag fall, an opponent walking away) carries them
 * too, so the exporter never has to work out what happened.
 */
function describeEnd(status) {
  if (status.reason === 'checkmate') {
    const base = { reason: 'checkmate', result: status.result, termination: 'normal' };
    if (mode === 'local') {
      const winner = status.result === '1-0' ? 'White' : 'Black';
      const loser = winner === 'White' ? 'Black' : 'White';
      return {
        ...base,
        kind: 'win',
        title: `${winner} wins`,
        sub: `Checkmate — ${loser}'s king is trapped.`,
      };
    }
    const iWon = (status.result === '1-0') === (myColor === 'w');
    if (iWon) {
      return {
        ...base,
        kind: 'win',
        title: 'You win',
        sub:
          mode === 'online'
            ? `Checkmate — ${opponentLabel()} has no escape.`
            : 'Checkmate — the computer has no escape.',
      };
    }
    return {
      ...base,
      kind: 'loss',
      title: 'You lose',
      sub: 'Checkmate — your king is trapped.',
    };
  }
  const reasons = {
    stalemate: 'Stalemate — no legal moves remain.',
    'insufficient material': 'Neither side has enough material to mate.',
    'fifty-move rule': 'Fifty moves without a capture or pawn move.',
    'threefold repetition': 'The same position occurred three times.',
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

// Fills in the result text and color; whether it is on screen at all is
// updateModeUi's call, so the banner comes and goes with the player cards and
// the move list it belongs to.
function renderBanner(status) {
  const end = manualEnd || (status.over ? describeEnd(status) : null);
  els.resultBanner.className = end ? `result-banner ${end.kind}` : 'result-banner';
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

  const showLevel = mode === 'computer';
  const showColor = mode === 'computer' || showIdle;
  // Pass & play and games against the computer set their own clock; an online
  // game runs on the host's, so a guest has nothing to pick.
  const showTime = !online || showIdle;
  els.levelField.classList.toggle('hidden', !showLevel);
  els.colorField.classList.toggle('hidden', !showColor);
  els.colorLabel.textContent = online ? 'You play' : 'Play as';
  els.timeField.classList.toggle('hidden', !showTime);
  els.fieldRow.classList.toggle('hidden', !(showLevel || showColor || showTime));
  // The hint belongs to the settings that only take hold at the start of a
  // game, so it comes and goes with them. Only the host of an online game
  // picks a side and a clock — a guest is dealt both, which is worth saying
  // next to controls that sit above the Join box.
  if (online) {
    els.controlsHint.textContent =
      'Color and clock apply to games you create, not ones you join.';
  } else if (showColor) {
    els.controlsHint.textContent = 'Color and clock take effect when a new game starts.';
  } else {
    els.controlsHint.textContent = 'The clock takes effect when a new game starts.';
  }

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
  els.controlsHint.classList.toggle('hidden', !(showColor || showTime));
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
}

function targetsFor(square) {
  const map = new Map();
  for (const move of game.moves({ square })) {
    map.set(move.to, !!move.captured);
  }
  return map;
}

/** The color the person at this device may pick up right now, or null. */
function movableColorNow() {
  // An older position is a picture of the game, not a place to play from.
  if (reviewing() || gameFinished()) return null;
  if (mode === 'computer') return thinking ? null : myColor;
  if (mode === 'local') return game.turn();
  return session?.connected && onlineUiState === 'playing' ? myColor : null;
}

function onSquarePress(square, event) {
  const movable = movableColorNow();
  if (!movable) return;
  if (selected && targets.has(square)) {
    attemptMove(selected, square, { animate: true });
    return;
  }
  const piece = game.get(square);
  if (piece && colorOf(piece) === movable && game.turn() === movable) {
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
  const movable = movableColorNow();
  if (!movable) return;
  if (selected === square) {
    clearSelection();
    renderAll();
    return;
  }
  if (selected && targets.has(square)) {
    attemptMove(selected, square, { animate: true });
    return;
  }
  const piece = game.get(square);
  if (piece && colorOf(piece) === movable && game.turn() === movable) {
    selected = square;
    targets = targetsFor(square);
    renderAll();
  } else if (selected) {
    clearSelection();
    renderAll();
  }
}

function onDrop(from, to, moved) {
  if (to && to !== from && targets.has(to)) {
    attemptMove(from, to, { animate: false });
    return;
  }
  if (to === from && !moved && pendingToggleOff) {
    clearSelection();
  }
  renderAll();
}

function attemptMove(from, to, { animate }) {
  const candidates = game.moves({ square: from }).filter((m) => m.to === to);
  if (candidates.length === 0) {
    clearSelection();
    renderAll();
    return;
  }
  const commit = (promotion) => {
    const played = game.move({ from, to, promotion });
    if (!played) {
      clearSelection();
      renderAll();
      return;
    }
    // The clock has to change hands before the move is sent, so the peer is
    // told what our clock actually reads after the move.
    const left = afterPlyApplied(played);
    if (mode === 'online') session?.sendMove(played, left);
    clearSelection();
    const proceed = () => {
      renderAll();
      afterMove();
    };
    if (animate) boardView.animateMove(from, to, proceed);
    else proceed();
  };
  if (candidates[0].promotion) {
    askPromotion().then((promotion) => {
      if (promotion) {
        commit(promotion);
      } else {
        clearSelection();
        renderAll();
      }
    });
  } else {
    commit('q');
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
    const played = game.move({
      from: reply.from,
      to: reply.to,
      promotion: reply.promotion || 'q',
    });
    if (!played) {
      renderAll();
      return;
    }
    afterPlyApplied(played); // also counts the game as started: the computer
                             // opens when the player chose Black
    showMove(reply.from, reply.to, () => {
      renderAll();
      const status = game.status();
      if (status.over) showEnd(describeEnd(status));
    });
  });
}

/**
 * Slide a piece into place and then re-render. While an older position is on
 * the board there is nothing to slide — the move has landed in the game, but
 * not in what the player is looking at.
 */
function showMove(from, to, done) {
  if (reviewing()) done();
  else boardView.animateMove(from, to, done);
}

/* ------------------------------------------------------------------ */
/* Promotion dialog                                                    */
/* ------------------------------------------------------------------ */

function askPromotion() {
  const mover = game.turn(); // promotion is asked before the move commits
  for (const button of els.promoDialog.querySelectorAll('[data-promo]')) {
    const piece = button.dataset.promo;
    button.querySelector('img').src = pieceUrl(
      mover === 'w' ? piece.toUpperCase() : piece,
    );
  }
  els.promoDialog.showModal();
  return new Promise((resolve) => {
    promoResolve = resolve;
  });
}

function finishPromotion(choice) {
  if (!promoResolve) return;
  const resolve = promoResolve;
  promoResolve = null;
  if (els.promoDialog.open) els.promoDialog.close();
  resolve(choice);
}

/* ------------------------------------------------------------------ */
/* Confirm dialog                                                      */
/* ------------------------------------------------------------------ */

/**
 * `danger` paints the confirming button red: for giving up a game (resign,
 * leave) rather than merely moving on from one (a new game, another mode).
 */
function askConfirm({ title, sub, confirmLabel, danger = true }, onConfirm) {
  confirmAction = onConfirm;
  els.confirmTitle.textContent = title;
  els.confirmSub.textContent = sub;
  els.confirmYes.textContent = confirmLabel;
  els.confirmYes.classList.toggle('btn-danger-solid', danger);
  els.confirmYes.classList.toggle('btn-primary', !danger);
  els.confirmDialog.showModal();
}

function closeDialogs() {
  rematchAnswered = true; // closing the offer dialog here must not send a decline
  if (els.gameoverDialog.open) els.gameoverDialog.close();
  if (els.confirmDialog.open) els.confirmDialog.close();
  if (els.rematchDialog.open) els.rematchDialog.close();
  if (els.pgnDialog.open) els.pgnDialog.close();
}

/* ------------------------------------------------------------------ */
/* Game flow controls                                                  */
/* ------------------------------------------------------------------ */

function newGame() {
  if (mode === 'online') return; // online games start via the session flow
  aiToken++;
  thinking = false;
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
  importedNames = null;
  game.reset();
  resetClock(timeSetting);
  resetTracking();
  finishPromotion(null);
  clearSelection();
  clearTimeout(gameOverTimer);
  closeDialogs();
  boardView.setOrientation(bottomColor());
  announcedPlies = 0;
  els.srStatus.textContent =
    mode === 'local'
      ? 'New game. White to move.'
      : `New game. You play ${colorName(myColor)}.`;
  renderAll();
  if (mode === 'computer' && game.turn() !== myColor) computerTurn();
}

/** The New game button: a game in progress is worth a second look first. */
function requestNewGame() {
  if (mode === 'online') return;
  if (!gameInProgress()) {
    newGame();
    return;
  }
  askConfirm(
    {
      title: 'Start a new game?',
      sub: 'The game in progress will be lost.',
      confirmLabel: 'New game',
      danger: false,
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
  finishPromotion(null);
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

/** Take back one ply, rewinding both clocks to where they stood before it. */
function undoPly() {
  if (!game.undo()) return;
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
  opponentName = null;
  rematchOffered = false;
  manualEnd = null;
  reviewIndex = null;
  importedNames = null;
  closeDialogs();
  finishPromotion(null);
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
  if (
    mode === 'online' &&
    session?.connected &&
    !gameFinished() &&
    game.history().length > 0
  ) {
    askConfirm(
      {
        title: 'Leave the online game?',
        sub: 'Leaving now counts as abandoning the game — your friend wins.',
        confirmLabel: 'Leave',
      },
      perform,
    );
  } else if (gameInProgress()) {
    // Switching modes starts over, and the game on the board is not kept for
    // coming back to. The mode buttons sit right above the board, so make sure
    // the player meant it.
    askConfirm(
      {
        title: `Switch to ${MODE_LABELS[next]}?`,
        sub: `Your ${
          mode === 'computer' ? 'game against the computer' : 'pass & play game'
        } will be lost.`,
        confirmLabel: 'Switch',
        danger: false,
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
  game.reset();
  // No clock until a game exists: an online game runs on the host's control,
  // which this side only learns at the handshake.
  resetClock(DEFAULT_TIME_ID);
  resetTracking();
  clearSelection();
  clearTimeout(gameOverTimer);
  boardView.setOrientation('w');
  announcedPlies = 0;
  setOnlineError('');
  els.onlineInviteNote.hidden = !inviteCode;
  els.joinInput.value = inviteCode || '';
  els.srStatus.textContent = inviteCode
    ? 'You have been invited to a game. Press Join to connect.'
    : 'Online mode. Create a game or join with an invite code.';
  renderAll();
  if (inviteCode) els.joinBtn.focus();
  // Warm up the SDK and TURN relays so create/join feels instant. Only when
  // already signed in — never trigger an auth prompt just by opening the tab.
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
  const color =
    colorSetting === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : colorSetting;
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
    track('Invite Created');
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
  track('Rematch Started');
  startOnlineGame(`Rematch started — you now play ${colorName(myColor)}.`);
}

function startOnlineGame(announcement) {
  aiToken++;
  thinking = false;
  onlineUiState = 'playing';
  rematchOffered = false;
  manualEnd = null;
  reviewIndex = null;
  game.reset();
  // Both games of a rematch run on the control the host set at the start.
  resetClock(session?.timeId || DEFAULT_TIME_ID);
  resetTracking();
  finishPromotion(null);
  clearSelection();
  clearTimeout(gameOverTimer);
  closeDialogs();
  boardView.setOrientation(myColor);
  announcedPlies = 0;
  els.srStatus.textContent = announcement;
  showToast(announcement);
  renderAll();
}

function handleRemoteMove({ from, to, promotion, clock: remoteClock }) {
  if (mode !== 'online' || onlineUiState !== 'playing' || gameFinished()) return;
  if (game.turn() === myColor) {
    desync();
    return;
  }
  let played = null;
  try {
    played = game.move({ from, to, promotion: promotion || 'q' });
  } catch {
    played = null; // malformed squares throw inside the engine
  }
  if (!played) {
    desync();
    return;
  }
  // Also counts the game as started: the opponent may have the first move.
  afterPlyApplied(played);
  applyRemoteClock(played.color, remoteClock);
  clearSelection();
  showMove(played.from, played.to, () => {
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
  finishPromotion(null);
  clearSelection();
  closeDialogs();
  const text = 'The game went out of sync and had to end. Please start a new one.';
  showToast(text);
  els.srStatus.textContent = text;
  renderAll();
}

/** End the game for a reason the engine cannot see: a resignation, a flag
 *  fall, an opponent walking away. */
function endGameManually(end) {
  manualEnd = end;
  finishPromotion(null);
  clearSelection();
  // A confirm dialog opened before the game ended (e.g. our own pending
  // resign) is now stale — acting on it could overwrite this result.
  closeDialogs();
  els.srStatus.textContent = `${end.title} — ${end.sub}`;
  renderAll();
  showEnd(end);
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

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
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
/* PGN export                                                          */
/* ------------------------------------------------------------------ */

/** Player names for the export, in the language of the current mode. */
function pgnNames() {
  if (importedNames) return importedNames;
  if (mode === 'local') return { w: 'Player 1', b: 'Player 2' };
  const me = mode === 'online' ? 'You' : 'Player';
  const them = mode === 'online' ? opponentName || 'Opponent' : `Computer (${LEVELS[level].label})`;
  return myColor === 'w' ? { w: me, b: them } : { w: them, b: me };
}

function currentPgn(date) {
  const end = currentEnd();
  const names = pgnNames();
  return buildPgn({
    sans: game.history().map((m) => m.san),
    result: end ? end.result : '*',
    white: names.w,
    black: names.b,
    date,
    control: clock.control,
    termination: end ? end.termination : 'unterminated',
  });
}

async function copyPgn() {
  if (game.history().length === 0) return;
  if (await copyToClipboard(currentPgn(new Date()))) {
    showToast('Game copied as PGN.');
  } else {
    showToast('Copy failed — your browser blocked clipboard access.');
  }
}

function downloadPgn() {
  if (game.history().length === 0) return;
  const now = new Date();
  let url = null;
  try {
    url = URL.createObjectURL(
      new Blob([currentPgn(now)], { type: 'application/x-chess-pgn' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = pgnFilename(now);
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Released on a later task, once the download has certainly started.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast('Game saved as a PGN file.');
  } catch {
    if (url) URL.revokeObjectURL(url);
    copyPgn(); // no downloads here; the clipboard still gets the player the game
  }
}

/* ------------------------------------------------------------------ */
/* PGN import                                                          */
/* ------------------------------------------------------------------ */

function showPgnError(message) {
  els.pgnError.textContent = message || '';
  els.pgnError.hidden = !message;
}

function openPgnDialog() {
  showPgnError('');
  els.pgnInput.value = '';
  els.pgnFile.value = '';
  els.pgnDialog.showModal();
  els.pgnInput.focus();
}

function requestPgnImport() {
  if (mode === 'online' && session?.connected && !gameFinished() && game.history().length > 0) {
    askConfirm(
      {
        title: 'Leave the online game?',
        sub: 'Loading a PGN leaves this match. Your friend wins.',
        confirmLabel: 'Leave',
      },
      openPgnDialog,
    );
    return;
  }
  openPgnDialog();
}

function namesFromTags(tags) {
  const w = (tags.White || '').trim();
  const b = (tags.Black || '').trim();
  if (!w && !b) return null;
  return { w: w || 'White', b: b || 'Black' };
}

function endFromPgnResult(result, termination) {
  const note = termination && termination !== 'normal' ? termination : null;
  if (result === '1/2-1/2') {
    return {
      kind: 'draw',
      reason: 'pgn',
      result,
      termination: note || 'normal',
      title: 'Draw',
      sub: note ? cap(note) : 'The PGN records this game as drawn.',
    };
  }
  if (result === '1-0' || result === '0-1') {
    const winner = result === '1-0' ? 'White' : 'Black';
    return {
      kind: 'win',
      reason: 'pgn',
      result,
      termination: note || 'normal',
      title: `${winner} wins`,
      sub: note ? cap(note) : `The PGN records a win for ${winner}.`,
    };
  }
  return null;
}

function applyImportedGame(parsed) {
  if (session) {
    session.leave();
    session = null;
  }
  aiToken++;
  thinking = false;
  opponentName = null;
  rematchOffered = false;
  onlineUiState = 'idle';
  mode = 'local';
  saveSettings();
  myColor = 'w';
  importedNames = namesFromTags(parsed.tags);
  replayPgn(parsed, game);
  manualEnd = null;
  if (parsed.result && parsed.result !== '*' && !game.isGameOver()) {
    manualEnd = endFromPgnResult(parsed.result, parsed.tags.Termination);
  }
  reviewIndex = null;
  resetClock(DEFAULT_TIME_ID);
  resetTracking();
  if (game.history().length > 0) startTracked = true;
  finishPromotion(null);
  clearSelection();
  clearTimeout(gameOverTimer);
  closeDialogs();
  boardView.setOrientation('w');
  announcedPlies = game.history().length;
  const n = game.history().length;
  els.srStatus.textContent =
    n === 0
      ? 'Loaded a PGN position. White to move.'
      : `Loaded a PGN with ${n} move${n === 1 ? '' : 's'}.`;
  renderAll();
  showToast(
    n === 0
      ? 'Position loaded. You can play on from here.'
      : `Loaded ${n} move${n === 1 ? '' : 's'}. Step through them with the arrows.`,
  );
}

function loadPgnFromText(text) {
  const parsed = parsePgn(text);
  if (parsed.error) {
    showPgnError(parsed.error);
    return;
  }
  const probe = new Chess();
  const replayed = replayPgn(parsed, probe);
  if (replayed.error) {
    showPgnError(replayed.error);
    return;
  }
  const perform = () => applyImportedGame(parsed);
  if (gameInProgress()) {
    els.pgnDialog.close();
    askConfirm(
      {
        title: 'Load this PGN?',
        sub: 'The game in progress will be lost.',
        confirmLabel: 'Load',
        danger: false,
      },
      perform,
    );
    return;
  }
  perform();
}

async function loadPgnFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    els.pgnInput.value = text;
    showPgnError('');
  } catch {
    showPgnError('That file could not be read.');
  }
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

els.reviewFirstBtn.addEventListener('click', () => goToPly(0));
els.reviewPrevBtn.addEventListener('click', () => goToPly(viewPlies() - 1));
els.reviewNextBtn.addEventListener('click', () => goToPly(viewPlies() + 1));
els.reviewLastBtn.addEventListener('click', () => goToPly(game.history().length));

// The move list is rebuilt on every render, so the click lands on the list.
els.moveList.addEventListener('click', (e) => {
  const ply = e.target.closest('button.ply');
  if (ply) goToPly(Number(ply.dataset.ply));
});

els.pgnImportBtn.addEventListener('click', requestPgnImport);
els.pgnCopyBtn.addEventListener('click', copyPgn);
els.pgnDownloadBtn.addEventListener('click', downloadPgn);
els.pgnLoad.addEventListener('click', () => loadPgnFromText(els.pgnInput.value));
els.pgnCancel.addEventListener('click', () => els.pgnDialog.close());
els.pgnFileBtn.addEventListener('click', () => els.pgnFile.click());
els.pgnFile.addEventListener('change', () => {
  const file = els.pgnFile.files && els.pgnFile.files[0];
  loadPgnFile(file);
});

for (const button of els.themeButtons) {
  button.addEventListener('click', () => {
    themeSetting = button.dataset.themeChoice;
    saveSettings();
    applyTheme();
  });
}

for (const button of els.promoDialog.querySelectorAll('[data-promo]')) {
  button.addEventListener('click', () => finishPromotion(button.dataset.promo));
}
// Native <dialog> close (Escape, close()) — resolve a pending promotion as
// cancelled. finishPromotion is a no-op when nothing is pending.
els.promoDialog.addEventListener('close', () => finishPromotion(null));

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

// Clicking the backdrop dismisses a dialog. Backdrop clicks target the dialog
// element itself but land outside its box; padding clicks land inside it.
function closeOnBackdropClick(dialog) {
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left && e.clientX <= rect.right &&
      e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!inside) dialog.close();
  });
}
closeOnBackdropClick(els.promoDialog);
closeOnBackdropClick(els.gameoverDialog);
closeOnBackdropClick(els.confirmDialog);
closeOnBackdropClick(els.rematchDialog);
closeOnBackdropClick(els.pgnDialog);

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Dialogs close natively on Escape; handle them here too so the shortcut
  // cannot be lost, and so Escape means "close dialog" before "deselect".
  if (els.promoDialog.open) {
    finishPromotion(null);
  } else if (els.gameoverDialog.open) {
    els.gameoverDialog.close();
  } else if (els.confirmDialog.open) {
    els.confirmDialog.close();
  } else if (els.rematchDialog.open) {
    els.rematchDialog.close();
  } else if (els.pgnDialog.open) {
    els.pgnDialog.close();
  } else if (selected) {
    // Escape means "put it back": a piece still held under the pointer is
    // dropped along with the selection, rather than left riding the cursor
    // with nowhere legal to land.
    boardView.cancelDrag();
    clearSelection();
    renderAll();
  }
});

function anyDialogOpen() {
  return (
    els.promoDialog.open ||
    els.gameoverDialog.open ||
    els.confirmDialog.open ||
    els.rematchDialog.open ||
    els.pgnDialog.open
  );
}

// Step through the game with the arrow keys. Two things already own these
// keys and keep them: a focused square, where they move around the board's
// ARIA grid, and a form control, where they change its value.
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  if (anyDialogOpen()) return;
  if (e.target instanceof Element && e.target.closest('#board, input, select, textarea')) {
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
// of waiting for the connection to time out.
window.addEventListener('pagehide', () => {
  session?.leave();
  // Stop charging before the page goes: one heading into the back/forward
  // cache is frozen and one being unloaded is gone, and neither should cost
  // the player the time it spends there. Settling first also means the save
  // below records the clock as it actually stood.
  clock.setRunning(null);
  stopClockTimer();
  saveNow();
});

// A tab put into the background may never be looked at again — store the clock
// where it stands rather than leaving the reading from the last move.
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

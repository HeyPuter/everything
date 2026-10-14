import './styles/base.css';
import './styles/layout.css';
import './styles/card.css';
import './styles/animations.css';

// Offline support (public/sw.js). Production-only: a service worker on the
// dev server would turn every subsequent change into a stale-cache mystery,
// since it would start intercepting fetches for files Vite hasn't rebuilt
// yet. .catch(() => {}) matters -- registration rejects on file:// and in
// some private-browsing modes, and an unhandled rejection here is a bug
// report waiting to happen for something that isn't actually a bug.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

import {
  MODES, DEFAULT_MODE, findMode, modeOf, dealMode, rulesFor, serialize, deserialize,
} from './game/modes.js';
import { render } from './ui/board.js';
import { preloadCardmeister } from './ui/cardview.js';
import { createDragController } from './ui/drag.js';
import { createAnimator } from './ui/animate.js';
import {
  loadLocalStats, saveLocalStats, recordGameStarted, recordGameWon, mergeStats,
  loadLocalSave, saveLocalSave, clearLocalSave, loadModePref, saveModePref,
  modeStats, recordVegasResult, vegasBank, isVegasSettled, deviceId,
} from './services/stats.js';
import * as cloud from './services/puter-sync.js';
import { shouldAdoptRemote } from './services/save-arbitration.js';

// Start the cardmeister download immediately rather than waiting for the
// first rich-face build mid-render, so the opening deal doesn't paint as
// blank/unstyled cards for one script round-trip.
preloadCardmeister();

const boardEl = document.getElementById('board');
const movesEl = document.getElementById('moves');
const winEl = document.getElementById('win');
const winStatsEl = document.getElementById('winStats');
const scoreStatEl = document.getElementById('scoreStat');
const scoreEl = document.getElementById('score');
const bankStatEl = document.getElementById('bankStat');
const bankEl = document.getElementById('bank');
const modeBtn = document.getElementById('mode');
const modeMenu = document.getElementById('modeMenu');
const modeLabelEl = document.getElementById('modeLabel');
const toastEl = document.getElementById('toast');

const modePref = loadModePref();
let game = dealMode(findMode(modePref) ? modePref : DEFAULT_MODE);
let stats = loadLocalStats();
let countedThisGame = false;
// This browser's share of the Vegas bank (see stats.js mergeVegas).
const DEVICE_ID = deviceId();
let signedIn = false;
// True only once a load-time cloud pull of the save has actually succeeded.
// A failed (or never-attempted) pull leaves this false, so we never push our
// local board on top of a remote game we failed to read — see writeSave/dropSave.
let remoteSaveTrusted = false;
// True once the board on screen is the player's, and not a candidate for
// being silently replaced by a load-time cloud restore. This is not "the
// player made a move" — dealing a fresh game via New also sets it, because
// the player just as clearly owns that board and a stale remote save must
// not be adopted over it either. See the load-time block for why this
// matters: it's the guard that stops a slow cloud round-trip from clobbering
// whatever the player is now looking at.
let playerOwnsBoard = false;

const animator = createAnimator({ boardEl });

const rules = () => rulesFor(game);

// U+2212 rather than a hyphen, so -$52 reads as a minus sign.
function money(n) {
  return (n < 0 ? '\u2212$' : '$') + Math.abs(n);
}

function updateStats() {
  movesEl.textContent = game.moves;
  const vegas = game.scoring === 'vegas';
  scoreStatEl.hidden = !vegas;
  bankStatEl.hidden = !vegas;
  if (vegas) {
    scoreEl.textContent = money(game.score);
    // Shown as if this game were already settled, so the bank never jumps
    // when it is.
    const pending = isVegasSettled(stats, game.id) ? 0 : game.score;
    bankEl.textContent = money(vegasBank(stats) + pending);
  }
}

function updateModeLabel() {
  const m = findMode(modeOf(game));
  modeLabelEl.textContent = `${m.group} \u00b7 ${m.label}`;
  for (const item of modeMenu.querySelectorAll('.menu-item')) {
    item.setAttribute('aria-checked', String(item.dataset.mode === m.key));
  }
}

let toastTimer = 0;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

function requestRender() {
  render({
    boardEl,
    game,
    rules: rules(),
    hooks: {
      attachDrag: (el, info) => drag.attachDrag(el, info),
      attachStockTap: el => drag.attachStockTap(el),
      afterCard: animator.afterCard,
    },
  });
  animator.dropUnclaimed();
  updateStats();
}

function checkWin() {
  if (!rules().isWon(game)) return;
  animator.startCelebration(showWin, game.foundations.map(pile => pile[0].suit));
}

// Resume: save only committed state, never mid-drag or mid-animation, so this
// hangs off the same points that already trigger a re-render after a move.
const SAVE_DEBOUNCE_MS = 800;
let saveTimer = null;

function writeSave() {
  // A won board is never resumable — showWin()'s dropSave() is what's
  // supposed to own clearing it, but the celebration animation delays that
  // call, and this debounce/flush can otherwise race ahead of it and
  // resurrect the finished board.
  if (rules().isWon(game)) return;
  // An untouched deal (moves === 0, nothing to undo) isn't worth persisting
  // — flushSave() runs on every visibilitychange, so merely opening the page
  // and switching tabs would otherwise write it. Under last-write-wins that
  // never-played deal could later outrank a real in-progress game saved from
  // another device, just because its timestamp happens to be newer.
  if (game.moves === 0 && game.history.length === 0) return;
  const save = serialize(game, Date.now());
  saveLocalSave(save);
  // Only push remotely once the load-time pull actually succeeded — pushing
  // on top of a remote we failed to read could clobber a newer game left on
  // another device (same anti-clobber discipline as stats sync).
  if (remoteSaveTrusted && signedIn) cloud.pushSave(save);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeSave, SAVE_DEBOUNCE_MS);
}

function flushSave() {
  clearTimeout(saveTimer);
  writeSave();
}

function dropSave() {
  clearTimeout(saveTimer);
  clearLocalSave();
  // If the load-time cloud pull hasn't resolved yet, remoteSaveTrusted is
  // still false and this can't safely clear the remote (see its
  // declaration) — a stale remote save can briefly survive a New pressed
  // during that window. Accepted rather than adding a pending-clear flag:
  // restoreFromCloud() always sets remoteSaveTrusted once the pull settles,
  // regardless of whether it was adopted, so the very next dropSave() (next
  // New/win) clears it correctly, and the very next scheduleSave() flush
  // overwrites it with the current board. playerOwnsBoard (set by newGame())
  // already stops the stale remote from ever being adopted in the
  // meantime, which was the actual data-loss risk — this is just a
  // several-second window where an orphaned remote value sits unread.
  if (remoteSaveTrusted && signedIn) cloud.clearSave();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSave();
});

// A KV write is not guaranteed to finish during unload, so only touch local here.
window.addEventListener('beforeunload', () => {
  clearTimeout(saveTimer);
  if (rules().isWon(game)) return; // same reasoning as writeSave() — never resurrect a finished board
  if (game.moves === 0 && game.history.length === 0) return; // skip untouched deals, as writeSave() does
  saveLocalSave(serialize(game, Date.now()));
});

// Puts a finished Vegas game's score into the bank: when it is won, or
// when it is abandoned for a new deal or replaced by a different cloud
// save. Only a game that was actually played (see countGameOnce) costs its
// ante: dealing and walking away is free, the same way it doesn't count as
// a game played. The bank remembers settled game ids, so a game that comes
// back (from the cloud, or a save written before it was settled) is never
// paid in twice.
function settleVegas() {
  if (game.scoring !== 'vegas' || !countedThisGame) return false;
  if (isVegasSettled(stats, game.id)) return false;
  stats = recordVegasResult(stats, {
    gameId: game.id, score: game.score, deviceId: DEVICE_ID, now: Date.now(),
  });
  saveLocalStats(stats);
  return true;
}

function showWin() {
  const mode = modeOf(game);
  stats = recordGameWon(stats, game.moves, Date.now(), mode);
  saveLocalStats(stats);
  if (game.scoring === 'vegas') {
    settleVegas();
    winStatsEl.textContent = `${game.moves} moves, ${money(game.score)} this game. `
      + `Bank: ${money(vegasBank(stats))}.`;
    updateStats();
  } else {
    const best = modeStats(stats, mode).bestMoves;
    winStatsEl.textContent = `${game.moves} moves. Nicely done.`
      + (best === game.moves ? ' New best.' : ` Best: ${best}.`);
  }
  winEl.classList.add('show');
  if (signedIn) syncStats(); // pull, merge, push — same guard as everywhere else; fire-and-forget
  dropSave(); // a won board is not resumable — clear it so a reload deals fresh
}

// A game counts as played once the player actually moves, so opening the page
// and walking away does not pad the count.
function countGameOnce() {
  if (countedThisGame) return;
  countedThisGame = true;
  stats = recordGameStarted(stats, Date.now(), modeOf(game));
  saveLocalStats(stats);
}

const drag = createDragController({
  boardEl,
  getGame: () => game,
  getRules: rules,
  requestRender,
  onMoveApplied: ({ flipped, completed }) => {
    playerOwnsBoard = true;
    countGameOnce();
    animator.queueFlips([].concat(flipped ?? []));
    flyCompletedRuns(completed);
    checkWin();
    scheduleSave();
  },
});

// A finished Spider run leaves the tableau on its own, so fly its King from
// where it sat to its foundation slot, or it would just vanish. Called
// before the re-render, while the King is still in the old board's DOM.
function flyCompletedRuns(kingIds) {
  for (const id of kingIds || []) {
    const el = boardEl.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    if (el) animator.queueFlights([id], el.getBoundingClientRect(), { slide: true });
  }
}

const REFUSED_DRAW = {
  'no-redeals': 'No passes left through the deck.',
  'empty-column': 'Fill every empty column before dealing.',
};

function onStockTap() {
  const stockPileEl = boardEl.querySelector('.pile[data-kind="stock"]');
  const srcRect = stockPileEl ? stockPileEl.getBoundingClientRect() : null;
  const result = rules().draw(game);
  if (!result.ok) {
    if (REFUSED_DRAW[result.reason]) toast(REFUSED_DRAW[result.reason]);
    return;
  }
  countGameOnce();
  playerOwnsBoard = true;
  if (srcRect) animator.queueFlights(result.drawn, srcRect);
  animator.queueFlips(result.flipped);
  flyCompletedRuns(result.completed);
  requestRender();
  checkWin();
  scheduleSave();
}

// Deals a new game of `key`, or of the game on the table when no key is
// given. Abandoning a Vegas game settles its score first.
function newGame(key = modeOf(game)) {
  drag.cancelDrag();
  animator.cancelCelebration();
  const settled = settleVegas();
  game = dealMode(key);
  saveModePref(key);
  countedThisGame = false;
  // The player just dealt this board on purpose — it must never be
  // silently swapped out by a load-time cloud restore that is still
  // in flight. See the playerOwnsBoard declaration for why "owns", not
  // "interacted", is the right name for this flag.
  playerOwnsBoard = true;
  winEl.classList.remove('show');
  updateModeLabel();
  requestRender();
  if (settled && signedIn) syncStats(); // the bank changed
  dropSave(); // a fresh deal replaces whatever was saved, so drop the old save
}

function doUndo() {
  // A won game is over: undoing out of it would let the same win (and, in
  // Vegas, the same payout) be recorded again.
  if (rules().isWon(game)) return;
  if (!rules().undo(game)) return;
  playerOwnsBoard = true;
  requestRender();
  scheduleSave();
}

boardEl.addEventListener('stock-tap', onStockTap);
document.getElementById('newgame').onclick = () => newGame();
document.getElementById('winNew').onclick = () => newGame();
document.getElementById('undo').onclick = doUndo;

// ---- Game menu ----
const CHECK_ICON = '<svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

function buildModeMenu() {
  let group = null;
  for (const m of MODES) {
    if (m.group !== group) {
      group = m.group;
      const h = document.createElement('div');
      h.className = 'menu-group';
      h.setAttribute('role', 'presentation');
      h.textContent = group;
      modeMenu.appendChild(h);
    }
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'menu-item';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', 'false');
    item.tabIndex = -1;
    item.dataset.mode = m.key;
    item.innerHTML = CHECK_ICON;
    const label = document.createElement('span');
    label.textContent = m.label;
    item.appendChild(label);
    item.setAttribute('aria-label', `${m.group}, ${m.label}`);
    item.addEventListener('click', () => chooseMode(m.key));
    modeMenu.appendChild(item);
  }
}

function menuItems() {
  return [...modeMenu.querySelectorAll('.menu-item')];
}

function openModeMenu() {
  modeMenu.hidden = false;
  modeBtn.setAttribute('aria-expanded', 'true');
  const items = menuItems();
  (items.find(i => i.getAttribute('aria-checked') === 'true') || items[0]).focus();
}

function closeModeMenu(refocus) {
  if (modeMenu.hidden) return;
  modeMenu.hidden = true;
  modeBtn.setAttribute('aria-expanded', 'false');
  if (refocus) modeBtn.focus();
}

// Picking the game already on the table just closes the menu; anything
// else deals a fresh game of that kind, the same as pressing New.
function chooseMode(key) {
  closeModeMenu(true);
  if (key !== modeOf(game)) newGame(key);
}

modeBtn.addEventListener('click', () => {
  if (modeMenu.hidden) openModeMenu();
  else closeModeMenu(false);
});
modeMenu.addEventListener('keydown', e => {
  const items = menuItems();
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    items[(i + step + items.length) % items.length].focus();
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    items[e.key === 'Home' ? 0 : items.length - 1].focus();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeModeMenu(true);
  } else if (e.key === 'Tab') {
    closeModeMenu(false);
  }
});
document.addEventListener('pointerdown', e => {
  if (!modeMenu.hidden && !e.target.closest('.menu-wrap')) closeModeMenu(false);
});
buildModeMenu();
updateModeLabel();

// Coalesced with rAF: an unthrottled resize handler would run requestRender
// on every fired event, and in rich mode every render rebuilds 52 custom
// elements, each of which builds a data-URI SVG and hands it to the image
// decoder — expensive to repeat dozens of times across one resize drag.
let resizeRaf = 0;
window.addEventListener('resize', () => {
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    requestRender();
  });
});
window.addEventListener('keydown', e => {
  if (!modeMenu.hidden) return; // the menu handles its own keys
  if (e.key === 'z' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doUndo(); }
  if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) newGame();
});

async function syncStats() {
  const pulled = await cloud.pullStats();
  if (!pulled.ok) return false; // cannot merge safely — do not write
  stats = mergeStats(stats, pulled.value);
  saveLocalStats(stats);
  return cloud.pushStats(stats); // true only if the remote write landed
}

// Resume: adopting a save means the game it describes was already counted as
// played when it was first started, so countedThisGame must come back true —
// otherwise the next move would count it again and inflate the "played" stat.
function adoptSave(save) {
  const restored = deserialize(save);
  if (!restored) return false;
  // Replacing a different Vegas game in progress abandons it, which settles
  // it (a no-op at boot, where `game` is an untouched fresh deal).
  if (restored.id !== game.id && settleVegas() && signedIn) syncStats();
  game = restored;
  countedThisGame = true;
  saveModePref(modeOf(game));
  updateModeLabel();
  return true;
}

function restoreLocal() {
  const local = loadLocalSave();
  return local ? { save: local, ts: local.ts || 0 } : null;
}

// Sets remoteSaveTrusted as a side effect: true only when this pull actually
// succeeds, so a failed read never licenses a later push over an unseen save.
async function restoreFromCloud() {
  if (!signedIn) return null;
  const pulled = await cloud.pullSave();
  remoteSaveTrusted = pulled.ok;
  if (!pulled.ok || !pulled.value) return null;
  return { save: pulled.value, ts: pulled.value.ts || 0 };
}

// Resume: restore synchronously from local before the first paint so the
// player gets their board back immediately, with zero network round-trips in
// the critical path. Must sit after `game`/`countedThisGame` are declared
// above, or this throws a TDZ ReferenceError. The captured ts is reused below
// instead of reading localStorage a second time — see the load-time block.
const bootSave = restoreLocal();
if (bootSave) adoptSave(bootSave.save);

requestRender();

// Load-time cloud path: only touch the cloud if already signed in, so opening
// the game never throws a login dialog at anyone. Puter's docs state that an
// app published on Puter.com has the user automatically signed in there, so
// isSignedIn() alone already gives silent auto-sync in the one place this
// game expects to run; loaded as a plain website instead, it stays silent
// too, because isSignedIn() itself never prompts (see puter-sync.js).
(async () => {
  signedIn = await cloud.isSignedIn();
  if (!signedIn) return;

  await syncStats(); // pull, merge, push — fire-and-forget beyond its local effect

  // Last-write-wins on timestamp, no merge, and compared against `bootSave`
  // (captured above) rather than a fresh restoreLocal() call — the several
  // round-trips above (isSignedIn, pullStats, pushStats, and the pullSave
  // inside restoreFromCloud) leave plenty of time for the player to already
  // be a few moves into the game the boot restore handed them, or to have
  // pressed New for a fresh deal. Re-reading localStorage here would pick
  // that up and let a merely-newer remote save silently overwrite it.
  // playerOwnsBoard is the real guard: once the player has committed any
  // change to the board they're looking at — including dealing a new one —
  // their in-memory game is authoritative and cloud save-adoption is
  // skipped entirely — this also avoids swapping `game` out from under an
  // in-progress drag via getGame(). The adopt/skip decision itself is a
  // pure function so it can be unit tested — see save-arbitration.js.
  const remote = await restoreFromCloud();
  const bootTs = bootSave ? bootSave.ts : 0;
  const remoteTs = remote ? remote.ts : 0;
  const adopt = remote && shouldAdoptRemote({ bootTs, remoteTs, playerOwnsBoard });
  if (adopt && adoptSave(remote.save)) requestRender();
})();

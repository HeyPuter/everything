import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/700.css';
import './style.css';

import { DIFFICULTIES, DIFFICULTY_IDS, isDifficulty } from './game/difficulties.js';
import {
  chord,
  createGame,
  minesRemaining,
  reveal,
  toggleFlag,
} from './game/engine.js';
import {
  loadBestTimes,
  recordBestTime,
  saveBestTimes,
} from './game/bestTimes.js';
import { createTimer, elapsedSeconds, formatSeconds } from './game/timer.js';
import { createBoardView } from './ui/boardView.js';

const SETTINGS_KEY = 'minesweeper.settings.v1';

/** @returns {{ difficulty: string, theme: string }} */
function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      difficulty: isDifficulty(raw.difficulty) ? raw.difficulty : 'beginner',
      theme: raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system' ? raw.theme : 'system',
    };
  } catch {
    return { difficulty: 'beginner', theme: 'system' };
  }
}

/** @param {{ difficulty: string, theme: string }} settings */
function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

function resolveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const settings = loadSettings();
let game = createGame(settings.difficulty);
let bestTimes = loadBestTimes();
const timer = createTimer();
let tickId = null;
let pressActive = false;

const el = {
  board: document.getElementById('board'),
  mineCount: document.getElementById('mine-count'),
  timer: document.getElementById('timer'),
  reset: document.getElementById('reset'),
  face: document.getElementById('face-glyph'),
  status: document.getElementById('status-line'),
  bestList: document.getElementById('best-times'),
};

function applyTheme() {
  const resolved = resolveTheme(settings.theme);
  document.documentElement.dataset.theme = resolved;
  document.querySelectorAll('[data-theme]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.theme === settings.theme));
  });
}

function padMeter(n) {
  const clamped = Math.max(-99, Math.min(999, n));
  if (clamped < 0) return `-${String(Math.abs(clamped)).padStart(2, '0')}`;
  return String(clamped).padStart(3, '0');
}

function faceForStatus() {
  if (pressActive && game.status === 'playing') return '😮';
  if (game.status === 'won') return '😎';
  if (game.status === 'lost') return '😵';
  return '🙂';
}

function updateHud() {
  el.mineCount.textContent = padMeter(minesRemaining(game));
  el.timer.textContent = formatSeconds(timer.elapsedMs);
  el.face.textContent = faceForStatus();

  if (game.status === 'won') {
    el.status.textContent = 'You cleared the board.';
  } else if (game.status === 'lost') {
    el.status.textContent = 'Boom — try again.';
  } else if (game.status === 'playing') {
    el.status.textContent = `${DIFFICULTIES[game.difficulty].label} · clear every safe cell`;
  } else {
    el.status.textContent = `${DIFFICULTIES[game.difficulty].label} · first click is always safe`;
  }
}

function renderBestTimes() {
  for (const id of DIFFICULTY_IDS) {
    const row = el.bestList.querySelector(`[data-best="${id}"] strong`);
    if (!row) continue;
    const best = bestTimes[id];
    row.textContent = best == null ? '—' : formatSeconds(best * 1000);
  }
}

function stopTick() {
  if (tickId !== null) {
    clearInterval(tickId);
    tickId = null;
  }
}

function startTick() {
  stopTick();
  tickId = window.setInterval(() => {
    el.timer.textContent = formatSeconds(timer.elapsedMs);
  }, 200);
}

function onWin() {
  timer.pause();
  stopTick();
  const seconds = elapsedSeconds(timer.elapsedMs);
  const { times, improved } = recordBestTime(bestTimes, game.difficulty, Math.max(1, seconds));
  bestTimes = times;
  saveBestTimes(bestTimes);
  renderBestTimes();
  if (improved) {
    el.status.textContent = `New best time: ${formatSeconds(seconds * 1000)}`;
  }
}

function afterMove() {
  updateHud();
  boardView.render();

  if (game.status === 'playing' && !timer.running) {
    timer.start();
    startTick();
  }
  if (game.status === 'won') onWin();
  if (game.status === 'lost') {
    timer.pause();
    stopTick();
  }
}

function newGame(difficulty = game.difficulty) {
  stopTick();
  timer.reset();
  pressActive = false;
  game = createGame(difficulty);
  settings.difficulty = difficulty;
  saveSettings(settings);
  document.querySelectorAll('[data-difficulty]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.difficulty === difficulty));
  });
  boardView.render();
  updateHud();
}

const boardView = createBoardView({
  root: el.board,
  getGame: () => game,
  onReveal(row, col) {
    if (reveal(game, row, col)) afterMove();
  },
  onFlag(row, col) {
    if (toggleFlag(game, row, col)) {
      updateHud();
      boardView.render();
    }
  },
  onChord(row, col) {
    if (chord(game, row, col)) afterMove();
  },
  onPress(pressed) {
    pressActive = pressed;
    el.face.textContent = faceForStatus();
  },
});

el.reset.addEventListener('click', () => newGame());

document.querySelectorAll('[data-difficulty]').forEach((btn) => {
  btn.addEventListener('click', () => {
    newGame(btn.dataset.difficulty);
  });
});

document.querySelectorAll('[data-theme]').forEach((btn) => {
  btn.addEventListener('click', () => {
    settings.theme = btn.dataset.theme;
    saveSettings(settings);
    applyTheme();
  });
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (settings.theme === 'system') applyTheme();
});

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.key === 'r' || event.key === 'R') {
    event.preventDefault();
    newGame();
  }
  if (event.key === '1') newGame('beginner');
  if (event.key === '2') newGame('intermediate');
  if (event.key === '3') newGame('expert');
});

applyTheme();
renderBestTimes();
newGame(settings.difficulty);

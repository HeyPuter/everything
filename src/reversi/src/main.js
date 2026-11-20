import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/700.css';
import './style.css';

import { BLACK, SIZE, WHITE, indexOf } from './game/board.js';
import { chooseMove } from './game/ai.js';
import {
  createGame,
  currentLegalMoves,
  isAiTurn,
  play,
  scores,
} from './game/engine.js';

const SETTINGS_KEY = 'reversi.settings.v1';

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      mode: raw.mode === 'hotseat' ? 'hotseat' : 'ai',
      theme: raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system' ? raw.theme : 'system',
      hints: raw.hints !== false,
    };
  } catch {
    return { mode: 'ai', theme: 'system', hints: true };
  }
}

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
/** @type {import('./game/engine.js').Game} */
let game = createGame({ mode: settings.mode, human: BLACK });
let aiTimer = null;

const el = {
  board: document.getElementById('board'),
  status: document.getElementById('status'),
  blackCount: document.getElementById('black-count'),
  whiteCount: document.getElementById('white-count'),
  blackScore: document.querySelector('.black-score'),
  whiteScore: document.querySelector('.white-score'),
  blackLabel: document.getElementById('black-label'),
  whiteLabel: document.getElementById('white-label'),
};

function applyTheme() {
  document.documentElement.dataset.theme = resolveTheme(settings.theme);
  document.querySelectorAll('[data-theme]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.theme === settings.theme));
  });
}

function colourName(player) {
  return player === BLACK ? 'Black' : 'White';
}

function updateHud() {
  const { black, white } = scores(game);
  el.blackCount.textContent = String(black);
  el.whiteCount.textContent = String(white);
  el.blackScore.dataset.active = String(game.turn === BLACK);
  el.whiteScore.dataset.active = String(game.turn === WHITE);

  if (game.mode === 'ai') {
    el.blackLabel.textContent = game.human === BLACK ? 'You' : 'Computer';
    el.whiteLabel.textContent = game.human === WHITE ? 'You' : 'Computer';
  } else {
    el.blackLabel.textContent = 'Black';
    el.whiteLabel.textContent = 'White';
  }

  if (game.over) {
    if (game.winner === 'draw') el.status.textContent = `Draw · ${black}–${white}`;
    else el.status.textContent = `${game.winner === 'black' ? 'Black' : 'White'} wins · ${black}–${white}`;
  } else if (game.lastPassed) {
    el.status.textContent = `${colourName(game.turn === BLACK ? WHITE : BLACK)} passes · ${colourName(game.turn)} to move`;
  } else {
    el.status.textContent = `${colourName(game.turn)} to move`;
  }
}

function renderBoard() {
  const legal = new Map(
    currentLegalMoves(game).map((m) => [`${m.row},${m.col}`, m]),
  );
  const frag = document.createDocumentFragment();
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cell';
      btn.dataset.row = String(row);
      btn.dataset.col = String(col);
      btn.setAttribute('role', 'gridcell');
      const value = game.board[indexOf(row, col)];
      const key = `${row},${col}`;
      if (value === BLACK) {
        btn.classList.add('has-disc', 'is-black');
        btn.setAttribute('aria-label', `Black disc at row ${row + 1} column ${col + 1}`);
        btn.innerHTML = '<span class="disc" aria-hidden="true"></span>';
      } else if (value === WHITE) {
        btn.classList.add('has-disc', 'is-white');
        btn.setAttribute('aria-label', `White disc at row ${row + 1} column ${col + 1}`);
        btn.innerHTML = '<span class="disc" aria-hidden="true"></span>';
      } else if (legal.has(key) && settings.hints && !isAiTurn(game)) {
        btn.classList.add('is-legal');
        btn.setAttribute('aria-label', `Legal move at row ${row + 1} column ${col + 1}`);
        btn.innerHTML = '<span class="hint" aria-hidden="true"></span>';
      } else {
        btn.setAttribute('aria-label', `Empty square row ${row + 1} column ${col + 1}`);
      }
      if (game.over || isAiTurn(game) || !legal.has(key)) {
        btn.tabIndex = -1;
        if (!legal.has(key)) btn.disabled = value !== 0 ? false : !legal.has(key);
      } else {
        btn.tabIndex = 0;
      }
      if (!legal.has(key) || game.over || isAiTurn(game)) {
        if (value === 0) btn.disabled = true;
      }
      frag.appendChild(btn);
    }
  }
  el.board.replaceChildren(frag);
}

function scheduleAi() {
  clearTimeout(aiTimer);
  if (!isAiTurn(game)) return;
  aiTimer = window.setTimeout(() => {
    const move = chooseMove(game.board, game.turn);
    if (move) play(game, move.row, move.col);
    refresh();
  }, 420);
}

function refresh() {
  updateHud();
  renderBoard();
  scheduleAi();
}

function newGame() {
  clearTimeout(aiTimer);
  game = createGame({ mode: settings.mode, human: BLACK });
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === settings.mode));
  });
  refresh();
}

el.board.addEventListener('click', (event) => {
  const cell = /** @type {HTMLElement | null} */ (event.target)?.closest?.('.cell');
  if (!cell || cell.disabled || isAiTurn(game) || game.over) return;
  const row = Number(cell.dataset.row);
  const col = Number(cell.dataset.col);
  if (play(game, row, col)) refresh();
});

document.getElementById('new-game').addEventListener('click', () => newGame());

document.querySelectorAll('[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    settings.mode = btn.dataset.mode === 'hotseat' ? 'hotseat' : 'ai';
    saveSettings(settings);
    newGame();
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
  if (event.key === 'n' || event.key === 'N') {
    event.preventDefault();
    newGame();
  }
  if (event.key === 'h' || event.key === 'H') {
    settings.hints = !settings.hints;
    saveSettings(settings);
    renderBoard();
  }
});

applyTheme();
newGame();

import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/700.css';
import './style.css';

import { RANK_LABELS, SUIT_SYMBOLS, isRed } from './game/cards.js';
import { CLASSIC_DEAL_MAX } from './game/deal.js';
import {
  autoDestination,
  autoFoundationPass,
  cardsHome,
  canMove,
  cascadeStack,
  createGame,
  move,
  peek,
} from './game/engine.js';

const SETTINGS_KEY = 'freecell.settings.v1';

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      deal: Number.isInteger(raw.deal) && raw.deal >= 1 ? raw.deal : 1,
      theme:
        raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system'
          ? raw.theme
          : 'system',
    };
  } catch {
    return { deal: 1, theme: 'system' };
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
let game = autoFoundationPass(createGame(settings.deal));
/** @type {import('./game/engine.js').Loc | null} */
let selection = null;
/** @type {number} */
let selectedCount = 1;

const el = {
  freecells: document.getElementById('freecells'),
  foundations: document.getElementById('foundations'),
  cascades: document.getElementById('cascades'),
  dealInput: /** @type {HTMLInputElement} */ (document.getElementById('deal-number')),
  status: document.getElementById('status'),
  newGame: document.getElementById('new-game'),
  randomDeal: document.getElementById('random-deal'),
  autoMove: document.getElementById('auto-move'),
};

function applyTheme() {
  document.documentElement.dataset.theme = resolveTheme(settings.theme);
  document.querySelectorAll('[data-theme]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.theme === settings.theme));
  });
}

function cardButton(card, { buried = false } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `card${isRed(card) ? ' red' : ''}${buried ? ' buried' : ''}`;
  btn.dataset.cardId = String(card.id);
  btn.setAttribute('aria-label', `${RANK_LABELS[card.rank]} of ${card.suit}`);
  btn.innerHTML = `<span class="rank">${RANK_LABELS[card.rank]}</span><span class="suit" aria-hidden="true">${SUIT_SYMBOLS[card.suit]}</span>`;
  return btn;
}

function pileSelected(kind, index) {
  return selection && selection.kind === kind && selection.index === index;
}

function renderPile(container, kind, index, cardsOrCard) {
  const pile = document.createElement('div');
  pile.className = `pile${kind === 'cascade' ? ' cascade' : ''}${pileSelected(kind, index) ? ' selected' : ''}`;
  pile.dataset.kind = kind;
  pile.dataset.index = String(index);
  pile.setAttribute('role', 'button');
  pile.tabIndex = 0;

  const label = document.createElement('span');
  label.className = 'pile-label';
  label.textContent = kind === 'freecell' ? 'Free' : kind === 'foundation' ? 'Home' : '';
  if (label.textContent) pile.appendChild(label);

  if (kind === 'cascade') {
    const cards = /** @type {import('./game/cards.js').Card[]} */ (cardsOrCard);
    const movableDepth = cascadeStack(game, index, cards.length ? cards.length - 1 : 0).length;
    cards.forEach((card, i) => {
      const depthFromTop = cards.length - 1 - i;
      const buried = depthFromTop >= Math.max(movableDepth, 1) && depthFromTop > 0;
      const btn = cardButton(card, { buried: false });
      if (buried && depthFromTop + 1 > movableDepth) {
        // still clickable only if part of legal run from top
      }
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onSelect({ kind, index }, depthFromTop + 1);
      });
      pile.appendChild(btn);
    });
  } else {
    const card = /** @type {import('./game/cards.js').Card | null} */ (cardsOrCard);
    if (card) {
      const btn = cardButton(card);
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onSelect({ kind, index }, 1);
      });
      pile.appendChild(btn);
    }
  }

  pile.addEventListener('click', () => onSelect({ kind, index }, 1));
  pile.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      onSelect({ kind, index }, 1);
    }
  });
  container.appendChild(pile);
}

function render() {
  el.freecells.replaceChildren();
  el.foundations.replaceChildren();
  el.cascades.replaceChildren();
  el.dealInput.value = String(game.dealNumber);

  for (let i = 0; i < 4; i += 1) renderPile(el.freecells, 'freecell', i, game.freecells[i]);
  for (let i = 0; i < 4; i += 1) renderPile(el.foundations, 'foundation', i, game.foundations[i]);
  for (let i = 0; i < 8; i += 1) renderPile(el.cascades, 'cascade', i, game.cascades[i]);

  const home = cardsHome(game);
  el.status.textContent = game.won
    ? `Deal #${game.dealNumber} cleared in ${game.moves} moves.`
    : `Deal #${game.dealNumber} · ${home}/52 home · ${game.moves} moves`;
}

/**
 * @param {import('./game/engine.js').Loc} loc
 * @param {number} count
 */
function onSelect(loc, count) {
  if (game.won) return;

  if (!selection) {
    const card = peek(game, loc);
    if (!card && loc.kind !== 'cascade') return;
    if (loc.kind === 'cascade') {
      const stack = cascadeStack(game, loc.index, count - 1);
      if (!stack.length) return;
      selectedCount = stack.length;
    } else {
      selectedCount = 1;
    }
    selection = loc;
    render();
    return;
  }

  if (selection.kind === loc.kind && selection.index === loc.index) {
    // Double-select: try auto destination
    const dest = autoDestination(game, selection);
    if (dest) {
      const next = move(game, selection, dest, selectedCount);
      if (next) {
        game = autoFoundationPass(next);
        selection = null;
        selectedCount = 1;
        render();
        return;
      }
    }
    selection = null;
    selectedCount = 1;
    render();
    return;
  }

  let next = move(game, selection, loc, selectedCount);
  if (!next && selectedCount > 1) {
    // Retry as single card from top
    next = move(game, selection, loc, 1);
  }
  if (next) {
    game = autoFoundationPass(next);
    selection = null;
    selectedCount = 1;
  } else if (peek(game, loc)) {
    selection = loc;
    selectedCount = loc.kind === 'cascade' ? cascadeStack(game, loc.index, 0).length || 1 : 1;
  } else {
    selection = null;
    selectedCount = 1;
  }
  render();
}

function newDeal(n) {
  const deal = Math.max(1, Math.min(0x7fffffff, Number(n) || 1));
  settings.deal = deal;
  saveSettings(settings);
  game = autoFoundationPass(createGame(deal));
  selection = null;
  selectedCount = 1;
  render();
}

el.newGame.addEventListener('click', () => newDeal(el.dealInput.value));
el.randomDeal.addEventListener('click', () => {
  newDeal(1 + Math.floor(Math.random() * CLASSIC_DEAL_MAX));
});
el.autoMove.addEventListener('click', () => {
  game = autoFoundationPass(game);
  render();
});
el.dealInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') newDeal(el.dealInput.value);
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

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    selection = null;
    selectedCount = 1;
    render();
  }
  if (ev.key === 'n' && !ev.metaKey && !ev.ctrlKey && document.activeElement?.tagName !== 'INPUT') {
    newDeal(game.dealNumber);
  }
});

// silence unused canMove in tree-shaking edge cases for tests importing main — keep helper available for debug
void canMove;

applyTheme();
render();

import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/700.css';
import './style.css';

import {
  acknowledgeTrick,
  advanceAi,
  createMatch,
  legalCardsFor,
  newMatch,
  nextHand,
  playCard,
  SEAT_NAMES,
  selectHumanPass,
} from './game/engine.js';
import { renderBacks, renderCard } from './ui/cards.js';

const SETTINGS_KEY = 'hearts.settings.v1';
const PASS_LABELS = {
  left: 'Pass left',
  right: 'Pass right',
  across: 'Pass across',
  hold: 'No pass (hold)',
};

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      theme:
        raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system'
          ? raw.theme
          : 'system',
    };
  } catch {
    return { theme: 'system' };
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
let game = createMatch();
/** @type {Set<number>} */
let selectedPass = new Set();
let busy = false;

const el = {
  hand: document.getElementById('hand'),
  trick: document.getElementById('trick'),
  status: document.getElementById('status-line'),
  handLabel: document.getElementById('hand-label'),
  btnPass: document.getElementById('btn-pass'),
  btnContinue: document.getElementById('btn-continue'),
  btnNew: document.getElementById('btn-new'),
  oppN: document.getElementById('opp-north'),
  oppW: document.getElementById('opp-west'),
  oppE: document.getElementById('opp-east'),
  scores: [0, 1, 2, 3].map((i) => document.getElementById(`score-${i}`)),
};

function applyTheme() {
  document.documentElement.dataset.theme = resolveTheme(settings.theme);
  document.querySelectorAll('[data-theme]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.theme === settings.theme));
  });
}

function updateScores() {
  for (let i = 0; i < 4; i += 1) {
    el.scores[i].textContent = String(game.totals[i]);
  }
}

function statusText() {
  if (game.phase === 'passing') {
    return `Select 3 cards to ${game.passDir} (${selectedPass.size}/3).`;
  }
  if (game.phase === 'play') {
    if (game.toPlay === 0) return 'Your turn — play a highlighted card.';
    return `${SEAT_NAMES[game.toPlay]} is thinking…`;
  }
  if (game.phase === 'trick_end') {
    return `${SEAT_NAMES[game.leader]} takes the trick.`;
  }
  if (game.phase === 'hand_end') {
    const parts = game.lastHandScores.map((n, i) => `${SEAT_NAMES[i]} +${n}`).join(' · ');
    const moon =
      game.moonShooter != null ? ` ${SEAT_NAMES[game.moonShooter]} shot the moon!` : '';
    return `Hand over. ${parts}.${moon}`;
  }
  if (game.phase === 'match_end') {
    const names = game.matchWinners.map((i) => SEAT_NAMES[i]).join(' & ');
    return `Match over — ${names} win${game.matchWinners.length === 1 ? 's' : ''}.`;
  }
  return '';
}

function renderOpponents() {
  el.oppN.replaceChildren(renderBacks(game.hands[2].length));
  el.oppW.replaceChildren(renderBacks(game.hands[1].length));
  el.oppE.replaceChildren(renderBacks(game.hands[3].length));
}

function renderTrick() {
  el.trick.replaceChildren();
  // Fixed seat slots: West, North, East, South visually around — show in play order positions 0..3 as played.
  const slots = [null, null, null, null];
  for (let i = 0; i < game.trick.length; i += 1) {
    slots[i] = game.trick[i];
  }
  for (const card of slots) {
    if (card) el.trick.appendChild(renderCard(card));
    else {
      const placeholder = document.createElement('div');
      placeholder.style.width = '4.2rem';
      placeholder.style.height = '6rem';
      el.trick.appendChild(placeholder);
    }
  }
}

function renderHand() {
  el.hand.replaceChildren();
  const legal =
    game.phase === 'play' && game.toPlay === 0
      ? new Set(legalCardsFor(game, 0).map((c) => c.id))
      : null;

  for (const card of game.hands[0]) {
    if (game.phase === 'passing') {
      el.hand.appendChild(
        renderCard(card, {
          selectable: true,
          selected: selectedPass.has(card.id),
          onClick: () => togglePass(card.id),
        }),
      );
      continue;
    }

    const canPlay = legal ? legal.has(card.id) : false;
    el.hand.appendChild(
      renderCard(card, {
        selectable: canPlay && !busy,
        dim: legal != null && !canPlay,
        onClick: () => onPlay(card.id),
      }),
    );
  }
}

function togglePass(id) {
  if (selectedPass.has(id)) selectedPass.delete(id);
  else if (selectedPass.size < 3) selectedPass.add(id);
  el.btnPass.disabled = selectedPass.size !== 3;
  render();
}

function render() {
  el.handLabel.textContent = `Hand ${game.handIndex + 1} · ${PASS_LABELS[game.passDir]}`;
  el.status.textContent = statusText();
  updateScores();
  renderOpponents();
  renderTrick();
  renderHand();

  el.btnPass.hidden = game.phase !== 'passing';
  el.btnPass.disabled = selectedPass.size !== 3;
  el.btnContinue.hidden = !['trick_end', 'hand_end', 'match_end'].includes(game.phase);
  el.btnContinue.textContent =
    game.phase === 'match_end'
      ? 'New match'
      : game.phase === 'hand_end'
        ? 'Next hand'
        : 'Continue';
}

async function onPlay(cardId) {
  if (busy || game.phase !== 'play' || game.toPlay !== 0) return;
  if (!playCard(game, cardId, 0)) return;
  render();
  await afterHumanAction();
}

async function afterHumanAction() {
  if (game.phase === 'trick_end') {
    await pause(650);
    acknowledgeTrick(game);
    render();
  }
  await driveAi();
}

async function driveAi() {
  busy = true;
  render();
  let guard = 0;
  while (guard < 20) {
    guard += 1;
    const state = advanceAi(game);
    render();
    if (state === 'await_human' || state === 'passing') break;
    if (state === 'trick_end') {
      await pause(700);
      acknowledgeTrick(game);
      render();
      continue;
    }
    if (state === 'hand_end' || state === 'match_end') break;
  }
  busy = false;
  render();
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

el.btnPass.addEventListener('click', async () => {
  if (selectedPass.size !== 3) return;
  if (!selectHumanPass(game, [...selectedPass])) return;
  selectedPass = new Set();
  render();
  await driveAi();
});

el.btnContinue.addEventListener('click', async () => {
  if (game.phase === 'trick_end') {
    acknowledgeTrick(game);
    render();
    await driveAi();
    return;
  }
  if (game.phase === 'hand_end') {
    nextHand(game);
    selectedPass = new Set();
    render();
    await driveAi();
    return;
  }
  if (game.phase === 'match_end') {
    newMatch(game);
    selectedPass = new Set();
    render();
  }
});

el.btnNew.addEventListener('click', async () => {
  newMatch(game);
  selectedPass = new Set();
  render();
  await driveAi();
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

applyTheme();
render();
driveAi();

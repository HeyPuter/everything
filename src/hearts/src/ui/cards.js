import { RANKS, SUIT_GLYPHS } from '../game/cards.js';

/**
 * @param {import('../game/cards.js').Card} card
 * @param {{ selectable?: boolean, selected?: boolean, dim?: boolean, onClick?: () => void }} [opts]
 */
export function renderCard(card, opts = {}) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `playing-card ${card.color}${opts.selectable ? ' selectable' : ''}${
    opts.selected ? ' selected' : ''
  }${opts.dim ? ' dim' : ''}`;
  el.disabled = Boolean(opts.dim) || !opts.selectable;
  el.setAttribute('aria-label', `${RANKS[card.rank]} of ${card.suit}`);
  el.innerHTML = `<span class="rank">${RANKS[card.rank]}</span><span class="suit">${SUIT_GLYPHS[card.suit]}</span>`;
  if (opts.onClick && opts.selectable) el.addEventListener('click', opts.onClick);
  return el;
}

/** Face-down opponent card backs. */
export function renderBacks(count) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i += 1) {
    const back = document.createElement('span');
    back.className = 'back';
    back.setAttribute('aria-hidden', 'true');
    frag.appendChild(back);
  }
  return frag;
}

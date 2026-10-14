export const RICH_MODE_MIN_CARD_W = 76;

// cols is the tableau's column count: 7 for Klondike, 10 for Spider. Ten
// columns on a phone leave very little card, so the gaps shrink with them.
export function computeSizes(boardWidth, cols = 7) {
  const minGap = cols > 7 ? 4 : 8;
  const gap = Math.max(minGap, Math.min(16, boardWidth * 0.018));
  const cardW = Math.max(0, (boardWidth - gap * (cols - 1)) / cols);
  return { cardW, cardH: cardW * 1.4, gap };
}

// Natural fan spacing for a tableau column, before any squeezing.
export function fanSpacing(cardH) {
  return { down: Math.max(10, cardH * 0.10), up: Math.max(18, cardH * 0.22) };
}

// A long column (a Spider column late in the game, or a Klondike one on a
// short window) would run off the bottom of the board, which clips it. Fit
// it to `avail` px by squeezing face-down cards first, since nothing on
// them needs reading, and then face-up ones down to a floor that still
// shows the rank. Past that floor the column is allowed to overflow.
export function fitFan({ down, up, faceDown, faceUp, cardH, avail }) {
  const need = faceDown * down + faceUp * up + cardH;
  if (need <= avail) return { down, up };
  const minDown = Math.min(down, 4);
  // The rank index on a rich card sits a little below the top edge, so the
  // floor grows with the card.
  const minUp = Math.min(up, Math.max(16, cardH * 0.17));
  let spare = avail - cardH - faceUp * up;
  if (faceDown && spare >= faceDown * minDown) {
    return { down: Math.min(down, spare / faceDown), up };
  }
  spare = avail - cardH - faceDown * minDown;
  const fitUp = faceUp ? spare / faceUp : up;
  return { down: minDown, up: Math.max(minUp, Math.min(up, fitUp)) };
}

export function renderModeFor(cardW) {
  return cardW >= RICH_MODE_MIN_CARD_W ? 'rich' : 'simple';
}

export function cardRadiusFor(cardW) {
  return Math.max(4, Math.min(10, cardW * 0.075));
}

export function applySizes(rootEl, { cardW, cardH, gap }) {
  const s = rootEl.style;
  s.setProperty('--card-w', cardW + 'px');
  s.setProperty('--card-h', cardH + 'px');
  s.setProperty('--gap', gap + 'px');
  s.setProperty('--card-radius', cardRadiusFor(cardW) + 'px');
}

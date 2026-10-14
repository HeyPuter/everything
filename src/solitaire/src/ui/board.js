import { computeSizes, applySizes, renderModeFor, fanSpacing, fitFan } from './layout.js';
import { cardEl, slotEl } from './cardview.js';

function makePile(kind, index) {
  const p = document.createElement('div');
  p.className = 'pile';
  p.dataset.kind = kind;
  p.dataset.index = index;
  return p;
}

// Gap between the top row and the tableau; matches .row.tableau's offset
// in layout.css.
const TABLEAU_GAP = 24;

// Lays out one tableau column, squeezing its fan to fit the board's height.
// The fan used is recorded on the pile so a drag ghost can match it.
function renderColumn(pile, col, ctx, i) {
  const { sizes, mode, hooks, availH } = ctx;
  if (!col.length) {
    pile.appendChild(slotEl());
    return;
  }
  const natural = fanSpacing(sizes.cardH);
  const faceDown = col.slice(0, -1).filter(c => !c.faceUp).length;
  const fan = fitFan({
    ...natural, faceDown, faceUp: col.length - 1 - faceDown, cardH: sizes.cardH, avail: availH,
  });
  pile.dataset.fan = fan.up;
  let offset = 0;
  col.forEach((c, idx) => {
    const e = cardEl(c, mode);
    e.style.top = offset + 'px';
    pile.appendChild(e);
    if (c.faceUp) hooks.attachDrag(e, { from: 'tableau', fromIndex: i, cardIndex: idx });
    hooks.afterCard(e, c);
    offset += c.faceUp ? fan.up : fan.down;
  });
  pile.style.height = (offset + sizes.cardH) + 'px';
}

function renderTableau(boardEl, game, ctx) {
  const tab = document.createElement('div');
  tab.className = 'row tableau';
  boardEl.appendChild(tab);
  game.tableau.forEach((col, i) => {
    const pile = makePile('tableau', i);
    pile.classList.add('tableau');
    renderColumn(pile, col, ctx, i);
    tab.appendChild(pile);
  });
}

function stockCounter(text) {
  const counter = document.createElement('div');
  counter.className = 'stock-counter';
  counter.textContent = text;
  return counter;
}

export function render(ctx) {
  const { boardEl, game, rules, hooks } = ctx;

  boardEl.dataset.game = game.kind;
  boardEl.style.setProperty('--cols', rules.columns);
  const sizes = computeSizes(boardEl.clientWidth, rules.columns);
  applySizes(document.documentElement, sizes);
  const mode = renderModeFor(sizes.cardW);
  boardEl.dataset.mode = mode;
  const availH = boardEl.clientHeight - sizes.cardH - TABLEAU_GAP;
  const layout = { sizes, mode, hooks, availH };

  boardEl.innerHTML = '';
  renderKlondike(boardEl, game, rules, layout);
}

function renderKlondike(boardEl, game, rules, layout) {
  const { sizes, mode, hooks } = layout;

  const top = document.createElement('div');
  top.className = 'row top';
  boardEl.appendChild(top);

  // Stock
  const stockPile = makePile('stock', 0);
  if (game.stock.length === 0) {
    stockPile.appendChild(slotEl(rules.canDraw(game) ? 'refresh' : 'block'));
  } else {
    game.stock.slice(-Math.min(3, game.stock.length)).forEach(c => {
      stockPile.appendChild(cardEl({ ...c, faceUp: false }, mode));
    });
  }
  hooks.attachStockTap(stockPile);
  if (game.stock.length) stockPile.appendChild(stockCounter(game.stock.length));
  top.appendChild(stockPile);

  // Waste — last few fanned right so the pile reads as a stack
  const wastePile = makePile('waste', 0);
  if (!game.waste.length) {
    wastePile.appendChild(slotEl());
  } else {
    const fanX = Math.max(6, sizes.cardW * 0.10);
    const visible = game.waste.slice(-3);
    const startIdx = game.waste.length - visible.length;
    const placed = [];
    visible.forEach((c, i) => {
      const e = cardEl(c, mode);
      e.style.left = (i * fanX) + 'px';
      if (i === visible.length - 1) {
        hooks.attachDrag(e, { from: 'waste', fromIndex: startIdx + i });
      } else {
        e.style.pointerEvents = 'none';
      }
      wastePile.appendChild(e);
      placed.push([e, c]);
    });
    // Every visible card, not just the top one: a draw-three flies all three.
    for (const [e, c] of placed) hooks.afterCard(e, c);
  }
  top.appendChild(wastePile);

  top.appendChild(document.createElement('div')); // spacer

  // Foundations
  for (let i = 0; i < 4; i++) {
    const fp = makePile('foundation', i);
    const pile = game.foundations[i];
    if (!pile.length) {
      fp.appendChild(slotEl('star'));
    } else {
      const last = pile[pile.length - 1];
      const e = cardEl(last, mode);
      hooks.attachDrag(e, { from: 'foundation', fromIndex: i });
      fp.appendChild(e);
    }
    top.appendChild(fp);
  }

  renderTableau(boardEl, game, layout);
}

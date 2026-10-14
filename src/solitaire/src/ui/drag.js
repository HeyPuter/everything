import { cardEl } from './cardview.js';

export const DRAG_THRESHOLD = 6;   // px before a press counts as a drag, not a click
export const DROP_TOLERANCE = 50;  // px of slack when the cursor misses every pile

// Pure. Three tiers, most specific first: direct cursor hit (smallest pile wins),
// then largest overlap with the dragged ghost, then nearest pile within tolerance.
export function pickDropTarget(point, ghostRect, piles) {
  const { x, y } = point;
  let direct = null;
  let directArea = Infinity;
  let overlapBest = null;
  let overlapBestArea = 0;
  let nearBest = null;
  let nearBestDist = Infinity;

  for (const { kind, index, rect } of piles) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      const area = (rect.right - rect.left) * (rect.bottom - rect.top);
      if (area < directArea) { direct = { kind, index }; directArea = area; }
      continue;
    }
    if (ghostRect) {
      const ox = Math.max(0, Math.min(rect.right, ghostRect.right) - Math.max(rect.left, ghostRect.left));
      const oy = Math.max(0, Math.min(rect.bottom, ghostRect.bottom) - Math.max(rect.top, ghostRect.top));
      const area = ox * oy;
      if (area > overlapBestArea) { overlapBestArea = area; overlapBest = { kind, index }; }
      if (area > 0) continue;
    }
    const cx = Math.max(rect.left, Math.min(x, rect.right));
    const cy = Math.max(rect.top, Math.min(y, rect.bottom));
    const d = Math.hypot(x - cx, y - cy);
    if (d < DROP_TOLERANCE && d < nearBestDist) { nearBestDist = d; nearBest = { kind, index }; }
  }
  return direct || overlapBest || nearBest;
}

// getRules() returns the game-specific rules adapter (see game/modes.js), so
// the same drag code moves Klondike and Spider cards.
export function createDragController({ boardEl, getGame, getRules, requestRender, onMoveApplied }) {
  let dragging = null;

  function collectPiles() {
    return [...boardEl.querySelectorAll('.pile')]
      .filter(p => p.dataset.kind !== 'stock' && p.dataset.kind !== 'waste')
      .map(p => {
        const r = p.getBoundingClientRect();
        const rect = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        if (p.dataset.kind === 'tableau') rect.bottom = r.top + p.offsetHeight;
        return { kind: p.dataset.kind, index: parseInt(p.dataset.index, 10), rect };
      });
  }

  function findDropTarget(x, y) {
    const ghostRect = dragging && dragging.ghost && dragging.moved
      ? dragging.ghost.getBoundingClientRect() : null;
    return pickDropTarget({ x, y }, ghostRect, collectPiles());
  }

  function commit(from, to, cards) {
    const result = getRules().applyMove(getGame(), from, to, cards);
    if (result.ok) onMoveApplied(result);
    return result.ok;
  }

  function autoMove(info) {
    const game = getGame();
    const rules = getRules();
    if (!rules.canPickUp(game, info)) return false;
    const cards = rules.getMovingCards(game, info);
    for (const to of rules.autoTargets(game, info, cards)) {
      if (commit(info, to, cards)) return true;
    }
    return false;
  }

  function updateDropHover(x, y) {
    boardEl.querySelectorAll('.pile.drop-hover').forEach(p => p.classList.remove('drop-hover'));
    if (!dragging) return;
    const drop = findDropTarget(x, y);
    if (!drop) return;
    if (!getRules().canDrop(getGame(), dragging.cards, dragging.info, drop)) return;
    const pile = boardEl.querySelector(
      `.pile[data-kind="${drop.kind}"][data-index="${drop.index}"]`);
    if (pile) pile.classList.add('drop-hover');
  }

  function beginDragVisual() {
    if (!dragging || dragging.moved) return;
    dragging.moved = true;
    dragging.ghost.style.visibility = '';
    const info = dragging.info;
    if (info.from === 'tableau') {
      const col = getGame().tableau[info.fromIndex];
      const pile = boardEl.querySelector(
        `.pile[data-kind="tableau"][data-index="${info.fromIndex}"]`);
      const cardEls = pile.querySelectorAll('.card');
      for (let i = info.cardIndex; i < col.length; i++) {
        if (cardEls[i]) cardEls[i].style.visibility = 'hidden';
      }
    } else if (dragging.startEl) {
      dragging.startEl.style.visibility = 'hidden';
    }
  }

  function onPointerMove(ev) {
    if (!dragging) return;
    if (!dragging.moved) {
      const dx = ev.clientX - dragging.startX;
      const dy = ev.clientY - dragging.startY;
      if ((dx * dx + dy * dy) < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      beginDragVisual();
    }
    dragging.ghost.style.left = (ev.clientX - dragging.offsetX) + 'px';
    dragging.ghost.style.top = (ev.clientY - dragging.offsetY) + 'px';
    updateDropHover(ev.clientX, ev.clientY);
  }

  function onPointerUp(ev) {
    boardEl.querySelectorAll('.pile.drop-hover').forEach(p => p.classList.remove('drop-hover'));
    document.removeEventListener('pointermove', onPointerMove);
    if (!dragging) return;

    const drop = findDropTarget(ev.clientX, ev.clientY);
    if (drop && dragging.moved) commit(dragging.info, drop, dragging.cards);
    else if (!dragging.moved) autoMove(dragging.info);

    cancelDrag();
    requestRender();
  }

  function cancelDrag() {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    if (!dragging) return false;
    dragging.ghost.remove();
    boardEl.querySelectorAll('.card').forEach(c => { c.style.visibility = ''; });
    boardEl.querySelectorAll('.pile.drop-hover').forEach(p => p.classList.remove('drop-hover'));
    dragging = null;
    return true;
  }

  // A cancelled drag (window switch, browser gesture) must tear down and
  // re-render, or the hidden source cards stay invisible and undraggable.
  function onPointerCancel() {
    if (cancelDrag()) requestRender();
  }

  function onPointerDown(ev, el, info) {
    if (dragging) return;   // a second pointer mid-drag would orphan the first ghost
    if (ev.button !== 0) return;
    const game = getGame();
    const rules = getRules();
    if (!rules.canPickUp(game, info)) return;
    const cards = rules.getMovingCards(game, info);

    const rect = el.getBoundingClientRect();
    const cardH = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--card-h'));
    // A crowded column squeezes its fan to fit the board (see board.js), and
    // the ghost has to match it or the lifted cards jump apart.
    const pileEl = el.closest('.pile');
    const fanFaceUp = parseFloat(pileEl?.dataset.fan) || Math.max(18, cardH * 0.22);
    const mode = boardEl.dataset.mode;

    const ghost = document.createElement('div');
    ghost.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;`
      + `width:${rect.width}px;pointer-events:none;z-index:1000;`;

    cards.forEach((c, idx) => {
      const ce = cardEl(c, mode);
      ce.style.position = 'absolute';
      ce.style.top = (idx * fanFaceUp) + 'px';
      ce.style.left = '0';
      ce.style.width = '100%';
      ce.style.height = cardH + 'px';
      ce.classList.add('dragging');
      ghost.appendChild(ce);
    });

    document.body.appendChild(ghost);
    // Hidden until the pointer crosses the threshold; until then a release is a click.
    ghost.style.visibility = 'hidden';

    dragging = {
      cards, info, ghost,
      offsetX: ev.clientX - rect.left,
      offsetY: ev.clientY - rect.top,
      startX: ev.clientX, startY: ev.clientY,
      moved: false, startEl: el,
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp, { once: true });
    document.addEventListener('pointercancel', onPointerCancel, { once: true });
    ev.preventDefault();
  }

  function attachDrag(el, info) {
    el.classList.add('draggable');
    el.addEventListener('pointerdown', ev => onPointerDown(ev, el, info));
    el.addEventListener('dblclick', () => { if (autoMove(info)) requestRender(); });
  }

  // Pointer-based rather than click: the board calls preventDefault() on
  // pointerdown, so mobile browsers defer the synthetic click on first tap.
  function attachStockTap(el) {
    let downX = null;
    let downY = null;
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      downX = e.clientX; downY = e.clientY;
      e.preventDefault();
    });
    el.addEventListener('pointerup', e => {
      if (downX == null) return;
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      downX = null;
      if (moved < DRAG_THRESHOLD) el.dispatchEvent(
        new CustomEvent('stock-tap', { bubbles: true }));
    });
    el.addEventListener('pointercancel', () => { downX = null; });
  }

  return { attachDrag, attachStockTap, cancelDrag };
}

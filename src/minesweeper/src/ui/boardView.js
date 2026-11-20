/**
 * Renders the Minesweeper grid and wires pointer / keyboard input.
 * Visuals are original — no Microsoft bitmaps or trademarked chrome.
 */

/**
 * @param {object} options
 * @param {HTMLElement} options.root
 * @param {() => import('../game/engine.js').Game} options.getGame
 * @param {(row: number, col: number) => void} options.onReveal
 * @param {(row: number, col: number) => void} options.onFlag
 * @param {(row: number, col: number) => void} options.onChord
 * @param {(pressed: boolean) => void} [options.onPress]
 */
export function createBoardView({ root, getGame, onReveal, onFlag, onChord, onPress }) {
  let focusRow = 0;
  let focusCol = 0;
  /** @type {Set<number>} */
  const pressedButtons = new Set();
  let chordArmed = false;

  function cellEl(row, col) {
    return root.querySelector(`[data-row="${row}"][data-col="${col}"]`);
  }

  function render() {
    const game = getGame();
    const { board, status, explodedIndex } = game;
    root.style.setProperty('--cols', String(board.cols));
    root.style.setProperty('--rows', String(board.rows));
    root.setAttribute('role', 'grid');
    root.setAttribute('aria-rowcount', String(board.rows));
    root.setAttribute('aria-colcount', String(board.cols));
    root.dataset.status = status;

    const frag = document.createDocumentFragment();
    for (let row = 0; row < board.rows; row++) {
      for (let col = 0; col < board.cols; col++) {
        const cell = board.cells[row * board.cols + col];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cell';
        btn.dataset.row = String(row);
        btn.dataset.col = String(col);
        btn.setAttribute('role', 'gridcell');
        btn.setAttribute('aria-rowindex', String(row + 1));
        btn.setAttribute('aria-colindex', String(col + 1));

        if (cell.mark === 'flagged') {
          btn.classList.add('is-flagged');
          btn.setAttribute('aria-label', `Flagged row ${row + 1} column ${col + 1}`);
          btn.innerHTML = '<span class="glyph flag" aria-hidden="true"></span>';
        } else if (cell.mark === 'revealed') {
          btn.classList.add('is-revealed');
          if (cell.mine) {
            btn.classList.add('is-mine');
            if (explodedIndex === row * board.cols + col) btn.classList.add('is-exploded');
            btn.setAttribute('aria-label', `Mine at row ${row + 1} column ${col + 1}`);
            btn.innerHTML = '<span class="glyph mine" aria-hidden="true"></span>';
          } else if (cell.adjacent > 0) {
            btn.dataset.n = String(cell.adjacent);
            btn.classList.add(`n-${cell.adjacent}`);
            btn.setAttribute(
              'aria-label',
              `${cell.adjacent} neighbouring mines, row ${row + 1} column ${col + 1}`,
            );
            btn.textContent = String(cell.adjacent);
          } else {
            btn.setAttribute('aria-label', `Empty cell, row ${row + 1} column ${col + 1}`);
          }
        } else {
          btn.setAttribute('aria-label', `Hidden cell, row ${row + 1} column ${col + 1}`);
        }

        if (row === focusRow && col === focusCol) {
          btn.classList.add('is-focused');
        }

        if (status === 'won' || status === 'lost') {
          btn.tabIndex = -1;
        } else if (row === focusRow && col === focusCol) {
          btn.tabIndex = 0;
        } else {
          btn.tabIndex = -1;
        }

        frag.appendChild(btn);
      }
    }
    root.replaceChildren(frag);
  }

  function coordsFromEvent(event) {
    const target = /** @type {HTMLElement | null} */ (event.target)?.closest?.('.cell');
    if (!target || !root.contains(target)) return null;
    return {
      row: Number(target.dataset.row),
      col: Number(target.dataset.col),
      el: target,
    };
  }

  function setFocus(row, col) {
    const game = getGame();
    focusRow = Math.max(0, Math.min(game.board.rows - 1, row));
    focusCol = Math.max(0, Math.min(game.board.cols - 1, col));
    render();
    cellEl(focusRow, focusCol)?.focus({ preventScroll: true });
  }

  root.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

  root.addEventListener('pointerdown', (event) => {
    const coords = coordsFromEvent(event);
    if (!coords) return;
    setFocus(coords.row, coords.col);
    pressedButtons.add(event.button);
    if (pressedButtons.size >= 2 || event.button === 1) {
      chordArmed = true;
      coords.el.classList.add('is-pressed');
      onPress?.(true);
      return;
    }
    if (event.button === 0) {
      coords.el.classList.add('is-pressed');
      onPress?.(true);
    }
    if (event.button === 2) {
      onFlag(coords.row, coords.col);
    }
  });

  root.addEventListener('pointerup', (event) => {
    const coords = coordsFromEvent(event);
    const wasChord = chordArmed || pressedButtons.size >= 2 || event.button === 1;
    pressedButtons.delete(event.button);
    if (pressedButtons.size === 0) {
      onPress?.(false);
      chordArmed = false;
      root.querySelectorAll('.is-pressed').forEach((el) => el.classList.remove('is-pressed'));
    }
    if (!coords) return;
    if (wasChord && (event.button === 0 || event.button === 1 || event.button === 2)) {
      onChord(coords.row, coords.col);
      return;
    }
    if (event.button === 0 && !wasChord && !longPressFired) {
      onReveal(coords.row, coords.col);
    }
    longPressFired = false;
  });

  root.addEventListener('pointerleave', () => {
    pressedButtons.clear();
    chordArmed = false;
    onPress?.(false);
    root.querySelectorAll('.is-pressed').forEach((el) => el.classList.remove('is-pressed'));
  });

  // Long-press flag for touch.
  let longPressTimer = null;
  let longPressFired = false;
  root.addEventListener(
    'touchstart',
    (event) => {
      const touch = event.changedTouches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      const cell = el?.closest?.('.cell');
      if (!cell || !root.contains(cell)) return;
      longPressFired = false;
      const row = Number(cell.dataset.row);
      const col = Number(cell.dataset.col);
      longPressTimer = window.setTimeout(() => {
        longPressFired = true;
        onFlag(row, col);
        onPress?.(false);
      }, 450);
    },
    { passive: true },
  );
  const cancelLongPress = () => {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };
  root.addEventListener('touchend', (event) => {
    cancelLongPress();
    if (longPressFired) {
      event.preventDefault();
      longPressFired = false;
    }
  });
  root.addEventListener('touchmove', cancelLongPress, { passive: true });
  root.addEventListener('touchcancel', cancelLongPress);

  root.addEventListener('keydown', (event) => {
    const game = getGame();
    if (game.status === 'won' || game.status === 'lost') return;
    const { rows, cols } = game.board;
    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        setFocus(focusRow - 1, focusCol);
        break;
      case 'ArrowDown':
        event.preventDefault();
        setFocus(focusRow + 1, focusCol);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        setFocus(focusRow, focusCol - 1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        setFocus(focusRow, focusCol + 1);
        break;
      case 'Home':
        event.preventDefault();
        setFocus(focusRow, 0);
        break;
      case 'End':
        event.preventDefault();
        setFocus(focusRow, cols - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (event.shiftKey) onFlag(focusRow, focusCol);
        else onReveal(focusRow, focusCol);
        break;
      case 'f':
      case 'F':
        event.preventDefault();
        onFlag(focusRow, focusCol);
        break;
      case 'c':
      case 'C':
        event.preventDefault();
        onChord(focusRow, focusCol);
        break;
      default:
        break;
    }
    void rows;
  });

  return {
    render,
    setFocus,
    get focus() {
      return { row: focusRow, col: focusCol };
    },
  };
}

import { el, icon, iconButton, button } from './lib/ui.js';
import { openMenu } from './lib/menu.js';

/**
 * The Organize pages view: every page as a tile in a grid that replaces the document while
 * it is open. Tiles are selected with a click (Ctrl or Command adds one, Shift a range),
 * dragged to a new place, and turned, duplicated, extracted, or deleted together.
 *
 * actions: { rotate(indices, delta), remove(indices), extract(indices), duplicate(indices),
 *            insertBlank(after), insertFile(after), insertPictures(after), move(indices, to),
 *            open(index), close() } — each may return a promise; the view redraws on refresh().
 * onSelectionChange(indices) hears of each change to the chosen pages.
 */
const SIZES = [110, 150, 200, 260];

export function createOrganizeView({
  getPdf,
  getRevision,
  getLayers = () => undefined,
  currentIndex,
  can,
  isBusy,
  actions,
  onSelectionChange,
}) {
  let selected = new Set();
  let anchor = null; // the tile a Shift range starts from
  let size = 1;
  let visible = false;
  let tiles = [];
  let observer = null;
  let dragging = null;
  const status = el('span', { class: 'organize-status', role: 'status' });
  const sizeInput = el('input', {
    type: 'range',
    min: 0,
    max: SIZES.length - 1,
    step: 1,
    value: size,
    'aria-label': 'Page tile size',
    oninput: () => {
      size = Number(sizeInput.value);
      grid.style.setProperty('--tile', `${SIZES[size]}px`);
      rebuild();
    },
  });
  const grid = el('div', {
    class: 'organize-grid',
    role: 'listbox',
    'aria-multiselectable': 'true',
    'aria-label': 'Pages',
    tabindex: '-1',
  });
  grid.style.setProperty('--tile', `${SIZES[size]}px`);
  const indices = () => [...selected].sort((a, b) => a - b);
  const count = () => getPdf()?.numPages || 0;
  const target = () => (selected.size ? indices() : [currentIndex()]);
  const after = () => (selected.size ? indices().at(-1) : count() - 1);
  const run = (fn) => async () => {
    if (isBusy()) return;
    await fn();
  };
  const commands = {
    insert: button('Insert', 'FilePlus2', (e) => insertMenu(e.currentTarget), 'btn organize-btn', {
      'aria-haspopup': 'menu',
      'data-permission': 'assemble',
    }),
    left: iconButton(
      'Rotate counterclockwise',
      'RotateCcw',
      run(() => actions.rotate(target(), -90)),
      {
        'data-permission': 'assemble',
      },
    ),
    right: iconButton(
      'Rotate clockwise',
      'RotateCw',
      run(() => actions.rotate(target(), 90)),
      {
        'data-permission': 'assemble',
      },
    ),
    duplicate: iconButton(
      'Duplicate pages',
      'Copy',
      run(async () => {
        const list = target();
        const revision = getRevision();
        await actions.duplicate(list);
        if (getRevision() === revision || !selected.size) return;
        // Each copy lands right after its page, pushing later selected pages along; keep the
        // selection on the pages that were chosen rather than on whatever took their places.
        const moved = (i) => i + list.filter((k) => k < i).length;
        selected = new Set(indices().map(moved));
        if (anchor != null) anchor = moved(anchor);
        updateState();
      }),
      {
        'data-permission': 'assemble',
      },
    ),
    extract: iconButton(
      'Extract pages',
      'Scissors',
      run(() => actions.extract(target())),
      {
        'data-permission': 'copy',
      },
    ),
    remove: iconButton(
      'Delete pages',
      'Trash2',
      run(async () => {
        const removed = target();
        if ((await actions.remove(removed)) !== false) selected.clear();
      }),
      { 'data-permission': 'assemble' },
    ),
  };
  function insertMenu(anchorButton) {
    const at = after();
    openMenu({
      anchor: anchorButton,
      label: 'Insert',
      items: [
        { header: `After page ${at + 1}` },
        { label: 'Blank page', icon: 'FilePlus2', onSelect: run(() => actions.insertBlank(at)) },
        { label: 'From PDF file…', icon: 'Plus', onSelect: run(() => actions.insertFile(at)) },
        { label: 'Pictures…', icon: 'Images', onSelect: run(() => actions.insertPictures(at)) },
      ],
    });
  }
  const toolbar = el(
    'div',
    { class: 'organize-toolbar', role: 'toolbar', 'aria-label': 'Organize pages' },
    el('h2', { class: 'organize-title' }, 'Organize pages'),
    status,
    el('span', { class: 'organize-sep', 'aria-hidden': 'true' }),
    commands.insert,
    commands.left,
    commands.right,
    commands.duplicate,
    commands.extract,
    commands.remove,
    el('span', { class: 'organize-sep', 'aria-hidden': 'true' }),
    el(
      'label',
      { class: 'organize-size' },
      icon('ZoomOut', 16, { plain: true }),
      sizeInput,
      icon('ZoomIn', 16, { plain: true }),
    ),
    button('Close', 'X', () => actions.close(), 'btn organize-close'),
  );
  const root = el(
    'section',
    { class: 'organize-view', 'aria-label': 'Organize pages', hidden: true },
    toolbar,
    grid,
  );

  let shownBusy = null,
    shownSelection = null;
  function updateState() {
    shownBusy = isBusy();
    // Other controls offering the same commands, as the tools pane does, follow the choice.
    const chosen = indices();
    if (visible && chosen.join() !== shownSelection) {
      shownSelection = chosen.join();
      onSelectionChange?.(chosen);
    }
    const n = selected.size;
    status.textContent = n
      ? `${n} of ${count()} ${count() === 1 ? 'page' : 'pages'} selected`
      : `${count()} ${count() === 1 ? 'page' : 'pages'}`;
    const busy = isBusy();
    toolbar.querySelectorAll('button[data-permission]').forEach((b) => {
      b.disabled = busy || !can(b.dataset.permission);
    });
    commands.remove.disabled ||= n >= count() || count() < 2;
    tiles.forEach((tile, i) => {
      tile.setAttribute('aria-selected', String(selected.has(i)));
      tile.classList.toggle('is-current', i === currentIndex());
    });
  }

  function select(i, e = {}) {
    if (e.shiftKey && anchor != null) {
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
      if (!(e.ctrlKey || e.metaKey)) selected.clear();
      for (let k = a; k <= b; k++) selected.add(k);
    } else if (e.ctrlKey || e.metaKey) {
      if (selected.has(i)) selected.delete(i);
      else selected.add(i);
      anchor = i;
    } else {
      selected = new Set([i]);
      anchor = i;
    }
    updateState();
  }

  function focusTile(i) {
    const tile = tiles[Math.max(0, Math.min(tiles.length - 1, i))];
    tiles.forEach((t) => (t.tabIndex = t === tile ? 0 : -1));
    tile?.focus();
    return tile ? Number(tile.dataset.index) : -1;
  }

  function columns() {
    if (tiles.length < 2) return 1;
    const top = tiles[0].offsetTop;
    const n = tiles.findIndex((tile) => tile.offsetTop !== top);
    return n === -1 ? tiles.length : n;
  }

  function onKey(e, i) {
    const step = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -columns(),
      ArrowDown: columns(),
      Home: -Infinity,
      End: Infinity,
    }[e.key];
    if (step != null) {
      e.preventDefault();
      const next = Math.max(
        0,
        Math.min(
          tiles.length - 1,
          i + (Number.isFinite(step) ? step : step < 0 ? -i : tiles.length),
        ),
      );
      const reached = focusTile(next);
      if (e.shiftKey) select(reached, { shiftKey: true });
      else if (!(e.ctrlKey || e.metaKey)) select(reached);
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      select(i, { ctrlKey: true });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      actions.open(i);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !isBusy()) {
      e.preventDefault();
      commands.remove.click();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selected = new Set(tiles.map((_, k) => k));
      updateState();
    }
  }

  function dropIndex(e) {
    // The gap nearest the pointer, from the tile under it, or else from the nearest tile of the
    // nearest row: the spaces between and around the tiles are not the end of the document.
    let tile = e.target.closest?.('.organize-tile');
    if (!tile) {
      let nearest = Infinity;
      for (const candidate of tiles) {
        const box = candidate.getBoundingClientRect();
        const dy = Math.max(box.top - e.clientY, 0, e.clientY - box.bottom);
        const dx = Math.max(box.left - e.clientX, 0, e.clientX - box.right);
        if (dy * 1e6 + dx < nearest) {
          nearest = dy * 1e6 + dx;
          tile = candidate;
        }
      }
      if (!tile) return tiles.length;
    }
    const i = Number(tile.dataset.index);
    const box = tile.getBoundingClientRect();
    return e.clientX < box.left + box.width / 2 ? i : i + 1;
  }
  function showDrop(index) {
    tiles.forEach((tile, i) => {
      tile.classList.toggle('drop-before', i === index);
      tile.classList.toggle('drop-after', index === tiles.length && i === tiles.length - 1);
    });
  }

  function tile(i) {
    const canvas = el('canvas', { 'aria-hidden': 'true' });
    const node = el(
      'div',
      {
        class: 'organize-tile',
        role: 'option',
        tabindex: i === (anchor ?? currentIndex()) ? 0 : -1,
        'data-index': i,
        'aria-label': `Page ${i + 1}`,
        draggable: String(can('assemble')),
        onclick: (e) => {
          if (e.target.closest('button')) return;
          select(i, e);
        },
        ondblclick: (e) => {
          if (!e.target.closest('button')) actions.open(i);
        },
        onkeydown: (e) => {
          if (e.target === node) onKey(e, i);
        },
        ondragstart: (e) => {
          if (isBusy() || !can('assemble')) return e.preventDefault();
          if (!selected.has(i)) select(i);
          dragging = indices();
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', `pages:${dragging.join(',')}`);
          root.classList.add('is-dragging');
        },
        ondragend: () => {
          dragging = null;
          showDrop(-1);
          root.classList.remove('is-dragging');
        },
      },
      el(
        'div',
        { class: 'organize-thumb' },
        canvas,
        el(
          'div',
          { class: 'organize-tile-actions' },
          iconButton(
            `Rotate page ${i + 1} counterclockwise`,
            'RotateCcw',
            run(() => actions.rotate([i], -90)),
            {
              'data-permission': 'assemble',
              tabindex: -1,
            },
          ),
          iconButton(
            `Rotate page ${i + 1} clockwise`,
            'RotateCw',
            run(() => actions.rotate([i], 90)),
            {
              'data-permission': 'assemble',
              tabindex: -1,
            },
          ),
          iconButton(
            `Delete page ${i + 1}`,
            'Trash2',
            run(async () => {
              if ((await actions.remove([i])) !== false) selected.clear();
            }),
            { 'data-permission': 'assemble', tabindex: -1 },
          ),
        ),
      ),
      el('span', { class: 'organize-label' }, String(i + 1)),
    );
    return node;
  }

  grid.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    showDrop(dropIndex(e));
  });
  grid.addEventListener('drop', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const to = dropIndex(e);
    const moving = dragging;
    dragging = null;
    showDrop(-1);
    root.classList.remove('is-dragging');
    // The gap counted among the pages that stay.
    const before = moving.filter((k) => k < to).length;
    const destination = to - before;
    if (moving.every((k, n) => k === destination + n)) return;
    run(async () => {
      await actions.move(moving, destination);
      selected = new Set(moving.map((_, n) => destination + n));
      anchor = destination;
      updateState();
    })();
  });

  function rebuild() {
    observer?.disconnect();
    const pdf = getPdf();
    if (!pdf || !visible) return;
    const focusAt = root.contains(document.activeElement)
      ? Number(document.activeElement.closest?.('.organize-tile')?.dataset.index)
      : null;
    selected = new Set([...selected].filter((i) => i < pdf.numPages));
    tiles = Array.from({ length: pdf.numPages }, (_, i) => tile(i));
    grid.replaceChildren(...tiles);
    const revision = getRevision();
    const width = SIZES[size];
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    observer = new IntersectionObserver(
      (entries) =>
        entries.forEach(async (entry) => {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          const index = Number(entry.target.dataset.index);
          const canvas = entry.target.querySelector('canvas');
          try {
            const page = await pdf.getPage(index + 1);
            if (getPdf() !== pdf || getRevision() !== revision || !canvas.isConnected) return;
            const natural = page.getViewport({ scale: 1 });
            const scale = Math.min(width / natural.width, (width * 1.3) / natural.height);
            const view = page.getViewport({ scale });
            canvas.width = Math.max(1, Math.floor(view.width * ratio));
            canvas.height = Math.max(1, Math.floor(view.height * ratio));
            canvas.style.width = `${Math.floor(view.width)}px`;
            canvas.style.height = `${Math.floor(view.height)}px`;
            await page.render({
              canvasContext: canvas.getContext('2d'),
              viewport: view,
              transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
              // Layers hidden in the Layers panel stay hidden here, as on the pages.
              optionalContentConfigPromise: getLayers(),
            }).promise;
            if (index !== currentIndex()) page.cleanup();
          } catch {
            /* A page that cannot be drawn keeps its blank tile. */
          }
        }),
      { root: grid, rootMargin: '200px' },
    );
    tiles.forEach((t) => observer.observe(t));
    updateState();
    if (Number.isInteger(focusAt)) focusTile(Math.min(focusAt, tiles.length - 1));
  }

  return {
    root,
    get visible() {
      return visible;
    },
    get selection() {
      return indices();
    },
    /** The busy state the controls last showed. */
    get busy() {
      return shownBusy;
    },
    show() {
      visible = true;
      root.hidden = false;
      if (!selected.size) {
        selected = new Set([currentIndex()]);
        anchor = currentIndex();
      }
      rebuild();
      tiles[anchor ?? currentIndex()]?.scrollIntoView({ block: 'nearest' });
      focusTile(anchor ?? currentIndex());
    },
    hide() {
      visible = false;
      shownSelection = null;
      root.hidden = true;
      observer?.disconnect();
      grid.replaceChildren();
      tiles = [];
    },
    refresh() {
      if (visible) rebuild();
    },
    updateState() {
      if (visible) updateState();
    },
    select(list) {
      selected = new Set(list);
      anchor = list[0] ?? null;
      updateState();
    },
  };
}

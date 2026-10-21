import { el } from './lib/ui.js';

/**
 * Continuous page view. Every page has a slot sized to the current zoom, stacked in one
 * scrolling column. The page being worked on holds the editor's interactive page (its canvas,
 * text layer, form fields, and editing overlays); the others show pictures rendered as they
 * scroll into view and released again once far away. As the reader scrolls, the page under
 * the middle of the view becomes the current page.
 */
const GAP = 12;

export function createPageStack({
  workspace,
  container,
  getPdf,
  getZoom,
  getRevision,
  getLayers = () => undefined,
  currentIndex,
  canFollowScroll,
  onScrollPage,
}) {
  let slots = [];
  let sizes = []; // natural page sizes at scale 1, rotation applied
  let fallback = { width: 612, height: 792 };
  let continuous = true,
    twoUp = false;
  let paper = null;
  let destroyed = false;
  let sizeRequest = 0;
  const rendering = new Map(); // slot index -> render task
  // Pages are drawn when they come within a screen of the view and released past three.
  const drawObserver = new IntersectionObserver(onDrawEntries, {
    root: workspace,
    rootMargin: '100% 0px',
  });
  const keepObserver = new IntersectionObserver(onKeepEntries, {
    root: workspace,
    rootMargin: '300% 0px',
  });

  function slotSize(i) {
    const size = sizes[i] || fallback;
    const zoom = getZoom();
    return { width: Math.round(size.width * zoom), height: Math.round(size.height * zoom) };
  }

  function rebuild(count) {
    for (const slot of slots) {
      drawObserver.unobserve(slot);
      keepObserver.unobserve(slot);
    }
    cancelAll();
    const keep = paper?.parentNode;
    slots = Array.from({ length: count }, (_, i) =>
      el(
        'div',
        { class: 'page-slot', 'data-page': i },
        el('canvas', { class: 'page-image', 'aria-hidden': 'true' }),
      ),
    );
    container.querySelectorAll(':scope > .page-slot').forEach((slot) => slot.remove());
    container.prepend(...slots);
    if (keep && paper && !paper.isConnected) container.prepend(paper);
    layout();
    for (const slot of slots) {
      drawObserver.observe(slot);
      keepObserver.observe(slot);
    }
  }

  /** Read every page's size once per document, a few at a time, keeping the view in place. */
  async function loadSizes(pdf) {
    const request = ++sizeRequest;
    const count = pdf.numPages;
    sizes = new Array(count);
    for (let i = 0; i < count; i += 16) {
      const batch = [];
      for (let k = i; k < Math.min(count, i + 16); k++)
        batch.push(
          pdf.getPage(k + 1).then((page) => {
            const view = page.getViewport({ scale: 1 });
            sizes[k] = { width: view.width, height: view.height };
          }),
        );
      await Promise.all(batch).catch(() => {});
      if (destroyed || request !== sizeRequest || getPdf() !== pdf) return;
      if (i === 0 && sizes[0]) fallback = sizes[currentIndex()] || sizes[0];
      keepInPlace(() => layout());
    }
  }

  /** Apply a layout change without moving the current page on screen. */
  function keepInPlace(change) {
    const anchor = slots[currentIndex()];
    const before = anchor?.getBoundingClientRect().top;
    change();
    if (anchor && before != null) {
      const after = anchor.getBoundingClientRect().top;
      if (Math.abs(after - before) > 0.5) {
        workspace.scrollTop += after - before;
        quiet();
      }
    }
  }

  let laidOutZoom = null,
    zoomChanged = false;
  function layout() {
    const zoom = getZoom();
    if (zoom !== laidOutZoom) {
      laidOutZoom = zoom;
      zoomChanged = true;
    }
    slots.forEach((slot, i) => {
      const { width, height } = slotSize(i);
      slot.style.width = `${width}px`;
      slot.style.height = `${height}px`;
      // One page at a time, or its spread when pages are side by side.
      const current = currentIndex();
      slot.hidden =
        !continuous && (twoUp ? Math.floor(i / 2) !== Math.floor(current / 2) : i !== current);
      // A picture drawn at another zoom keeps showing, stretched, until it is redrawn.
      if (slot.dataset.zoom && Number(slot.dataset.zoom) !== zoom) slot.dataset.stale = 'true';
    });
    container.style.setProperty('--page-gap', `${GAP}px`);
  }

  /** Whether a slot lies within the keep observer's margin of the view. */
  function nearView(slot) {
    const view = workspace.getBoundingClientRect();
    const box = slot.getBoundingClientRect();
    return box.bottom >= view.top - 3 * view.height && box.top <= view.bottom + 3 * view.height;
  }

  /** Put the interactive page into its slot, leaving a picture of it in the slot it leaves. */
  function place(node, index) {
    paper = node;
    const slot = slots[index];
    if (!slot) {
      if (node.parentNode !== container) container.prepend(node);
      return;
    }
    if (node.parentNode === slot) return layout();
    const previous = node.parentNode?.classList?.contains('page-slot') ? node.parentNode : null;
    // A page left by a jump is already out of the keep margin, whose observer passed it over
    // while it held the interactive page, so its picture would never be released.
    if (previous && !nearView(previous)) release(previous);
    else if (previous) {
      const source = node.querySelector(':scope > canvas');
      const target = previous.querySelector('.page-image');
      if (source?.width && target) {
        target.width = source.width;
        target.height = source.height;
        target.getContext('2d').drawImage(source, 0, 0);
        previous.dataset.revision = String(getRevision());
        previous.dataset.zoom = String(getZoom());
        delete previous.dataset.stale;
      }
    }
    slot.append(node);
    layout();
  }

  function cancelAll() {
    for (const task of rendering.values()) task.cancel?.();
    rendering.clear();
  }

  function release(slot) {
    const canvas = slot.querySelector('.page-image');
    if (canvas) canvas.width = canvas.height = 0;
    delete slot.dataset.revision;
    delete slot.dataset.zoom;
    delete slot.dataset.stale;
  }

  async function draw(index) {
    const slot = slots[index];
    const pdf = getPdf();
    if (!slot || !pdf || index === currentIndex() || slot.contains(paper)) return;
    const zoom = getZoom();
    const revision = String(getRevision());
    if (
      slot.dataset.revision === revision &&
      Number(slot.dataset.zoom) === zoom &&
      !slot.dataset.stale
    )
      return;
    rendering.get(index)?.cancel?.();
    let task = null;
    const marker = { cancel: () => task?.cancel() };
    rendering.set(index, marker);
    try {
      const page = await pdf.getPage(index + 1);
      if (destroyed || rendering.get(index) !== marker || getPdf() !== pdf) return;
      const viewport = page.getViewport({ scale: zoom });
      // Within a pixel budget per picture, as for the page being edited.
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        Math.sqrt(8000000 / (viewport.width * viewport.height)),
      );
      const buffer = el('canvas', {
        width: Math.max(1, Math.floor(viewport.width * ratio)),
        height: Math.max(1, Math.floor(viewport.height * ratio)),
      });
      task = page.render({
        canvasContext: buffer.getContext('2d'),
        viewport,
        transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
        optionalContentConfigPromise: getLayers(),
      });
      await task.promise;
      if (destroyed || rendering.get(index) !== marker || slot.contains(paper)) return;
      const canvas = slot.querySelector('.page-image');
      canvas.width = buffer.width;
      canvas.height = buffer.height;
      canvas.getContext('2d').drawImage(buffer, 0, 0);
      buffer.width = buffer.height = 0;
      slot.dataset.revision = revision;
      slot.dataset.zoom = String(zoom);
      delete slot.dataset.stale;
      page.cleanup();
    } catch {
      /* A cancelled or failed picture leaves the blank page; the next pass retries. */
    } finally {
      if (rendering.get(index) === marker) rendering.delete(index);
    }
  }

  function onDrawEntries(entries) {
    for (const entry of entries) if (entry.isIntersecting) draw(Number(entry.target.dataset.page));
  }
  function onKeepEntries(entries) {
    for (const entry of entries)
      if (!entry.isIntersecting) {
        const index = Number(entry.target.dataset.page);
        rendering.get(index)?.cancel?.();
        rendering.delete(index);
        if (!entry.target.contains(paper)) release(entry.target);
      }
  }

  /** Redraw the pictures in view, after an edit or a zoom. */
  function refresh() {
    const view = workspace.getBoundingClientRect();
    slots.forEach((slot, i) => {
      if (slot.hidden || slot.contains(paper)) return;
      const box = slot.getBoundingClientRect();
      if (box.bottom > view.top - view.height && box.top < view.bottom + view.height) draw(i);
    });
  }

  /** The page under the middle of the view. */
  function pageAtCenter() {
    if (!continuous || !slots.length) return currentIndex();
    const view = workspace.getBoundingClientRect();
    const middle = view.top + Math.min(view.height / 2, 160);
    const under = (box) => box.top <= middle && box.bottom + GAP >= middle;
    // Side by side, both pages of a row are under the middle; the current one stays current.
    if (slots[currentIndex()] && under(slots[currentIndex()].getBoundingClientRect()))
      return currentIndex();
    let best = currentIndex(),
      distance = Infinity;
    for (let i = 0; i < slots.length; i++) {
      const box = slots[i].getBoundingClientRect();
      if (under(box)) return i;
      const d = Math.min(Math.abs(box.top - middle), Math.abs(box.bottom - middle));
      if (d < distance) {
        distance = d;
        best = i;
      }
      if (box.top > view.bottom) break;
    }
    return best;
  }

  let scrollTimer = null,
    programmaticTop = null,
    pendingFollow = false;
  /**
   * Scrolling done here (choosing a page, keeping a zoom anchored) is not the reader's. Call
   * after setting the position: a scroll event that reports exactly it is ignored.
   */
  const quiet = () => {
    programmaticTop = workspace.scrollTop;
  };
  function follow() {
    if (destroyed) return;
    const index = pageAtCenter();
    pendingFollow = false;
    if (index === currentIndex()) return;
    // A busy editor or an open draft keeps its page; the move is retried once it settles.
    if (canFollowScroll()) onScrollPage(index);
    else pendingFollow = true;
  }
  function onScroll() {
    if (!continuous) return;
    if (programmaticTop !== null && Math.abs(workspace.scrollTop - programmaticTop) < 1) return;
    programmaticTop = null;
    // Until the page under the middle has been taken up, a settled editor checks again.
    pendingFollow = true;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(follow, 140);
  }
  workspace.addEventListener('scroll', onScroll, { passive: true });

  return {
    get continuous() {
      return continuous;
    },
    get count() {
      return slots.length;
    },
    slot: (i) => slots[i] || null,
    /**
     * Fit-width zoom follows the widest page, so scrolling never changes the zoom; side by
     * side, two of them have to fit, beside the gap between them that the zoom leaves alone.
     */
    widest(natural) {
      const width = Math.max(
        natural.width,
        sizes.reduce((max, size) => Math.max(max, size?.width || 0), 0),
      );
      return { width: twoUp ? width * 2 : width, height: natural.height };
    },
    /** Fit-page zoom fits every page, widest and tallest, for the same reason. */
    largest(natural) {
      const height = Math.max(
        natural.height,
        sizes.reduce((max, size) => Math.max(max, size?.height || 0), 0),
      );
      return { width: this.widest(natural).width, height };
    },
    get twoUp() {
      return twoUp;
    },
    /** Pages side by side in pairs, as a two-page view shows a spread. */
    setTwoUp(on) {
      twoUp = on;
      container.classList.toggle('two-up', on);
      layout();
    },
    rebuild,
    loadSizes,
    layout: () => keepInPlace(layout),
    place,
    refresh,
    /** Forget every picture, so the pages in view are drawn again (a layer was switched). */
    invalidate() {
      slots.forEach((slot) => {
        if (!slot.contains(paper)) slot.dataset.stale = 'true';
      });
      refresh();
    },
    pageAtCenter,
    setContinuous(on) {
      continuous = on;
      container.classList.toggle('single-page', !on);
      layout();
    },
    /** Bring a page's top into view, as choosing a page does. */
    scrollTo(index) {
      const slot = slots[index];
      if (!slot || !continuous) {
        workspace.scrollTop = 0;
        return;
      }
      const top =
        slot.getBoundingClientRect().top -
        workspace.getBoundingClientRect().top +
        workspace.scrollTop;
      workspace.scrollTop = Math.max(0, top - GAP);
      quiet();
    },
    quiet,
    /** Follow a scroll that arrived while the editor was busy. */
    recheck() {
      // Pictures that stay near the view through a zoom never cross the observers' margins,
      // so they are redrawn here, where the view has settled at the new zoom.
      if (zoomChanged) {
        zoomChanged = false;
        refresh();
      }
      if (pendingFollow && continuous) follow();
    },
    destroy() {
      destroyed = true;
      clearTimeout(scrollTimer);
      cancelAll();
      drawObserver.disconnect();
      keepObserver.disconnect();
      workspace.removeEventListener('scroll', onScroll);
    },
  };
}

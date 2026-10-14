import { renderFaceInto } from './cardview.js';
import { SUITS, RANKS, SUIT_COLOR } from '../game/deck.js';
import { stepCard, isSettled, launchVelocity, MAX_STEP_MS } from './cascade-physics.js';

// mode is the board's current render mode (boardEl.dataset.mode) so a card
// revealing mid-flip or mid-flight shows the same face — rich or simple —
// that it will land on, instead of popping from plain to ornate at the end.
function buildFlipper(card, mode) {
  const flipper = document.createElement('div');
  flipper.className = 'flipper';
  const back = document.createElement('div');
  back.className = 'face back';
  const front = document.createElement('div');
  front.className = 'face front ' + card.color;
  renderFaceInto(front, card, mode);
  flipper.append(back, front);
  return flipper;
}

// The vendored element uses S H D C suit letters (see cardview.js's own
// CID_SUIT); duplicated here rather than exported from cardview.js to keep
// this file's only new dependency on cascade-physics.js, per the task brief.
const CID_SUIT = { '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' };

// Builds every card's <img> once by creating a detached <playing-card> per
// card and reading the data-URI SVG it builds into its own <img>. Setting
// `cid` alone does NOT build it: the vendored element's attributeChangedCallback
// only reacts to a *change* (it reads the reaction's old-value argument), and
// a freshly created element's first attribute set has no old value, so that
// reaction silently no-ops; connectedCallback is what actually builds the
// image, and only fires once the element is connected to the document. So
// each card is briefly appended to an off-screen, zero-size rig div (itself
// attached to document.body) purely to trigger that build, then discarded —
// "detached" in the sense of "not part of the board's real card DOM", not
// "never connected to anything". Returns an empty Map if the custom element
// never became available, which callers treat as "always draw the fallback
// rectangle".
async function loadCardAtlas() {
  const atlas = new Map();
  if (typeof customElements === 'undefined') return atlas;

  let ready = !!customElements.get('playing-card');
  if (!ready) {
    // main.js calls preloadCardmeister() at boot, long before any game can
    // be won, so in practice this is already true. This short race only
    // covers the freak case of a win happening before that script finishes
    // loading — it must not turn into an indefinite hang if the element is
    // simply never going to be defined (script blocked, old browser).
    ready = await Promise.race([
      customElements.whenDefined('playing-card').then(() => true, () => false),
      new Promise(resolve => setTimeout(() => resolve(false), 400)),
    ]);
  }
  if (!ready) return atlas;

  const rig = document.createElement('div');
  rig.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:0;height:0;overflow:hidden;';
  document.body.appendChild(rig);

  const toDecode = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      const pc = document.createElement('playing-card');
      pc.setAttribute('cid', rank + CID_SUIT[suit]);
      rig.appendChild(pc); // connects it — this is what actually builds the <img>
      const img = pc.querySelector('img');
      if (!img || !img.src) continue; // defensive: this card falls back to the plain rectangle
      const clone = new Image();
      clone.src = img.src;
      atlas.set(suit + rank, clone);
      toDecode.push(clone);
    }
  }
  rig.remove();

  // Data URIs never hit the network, but decode() is still async — drawing
  // an undecoded image silently paints nothing, so every card must finish
  // decoding before the first frame.
  await Promise.all(toDecode.map(im => im.decode().catch(() => {})));
  return atlas;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Never simply fails to appear: a plain white rounded card with the rank
// and suit in the card's own colour, drawn when the atlas has no image for
// this card (script blocked, old browser, or an unexpected miss).
function drawFallbackCard(ctx, card, w, h) {
  const r = Math.min(10, w * 0.08);
  ctx.save();
  roundRectPath(ctx, card.x, card.y, w, h, r);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = card.color === 'red' ? '#c0392b' : '#111111';
  ctx.textBaseline = 'top';
  ctx.font = `700 ${Math.round(h * 0.2)}px sans-serif`;
  ctx.fillText(card.rank, card.x + w * 0.08, card.y + h * 0.06);
  ctx.font = `${Math.round(h * 0.16)}px sans-serif`;
  ctx.fillText(card.suit, card.x + w * 0.08, card.y + h * 0.28);
  ctx.restore();
}

function drawCascadeCard(ctx, card, atlas, cardW, cardH) {
  const img = atlas.get(card.suit + card.rank);
  if (img && img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, card.x, card.y, cardW, cardH);
  } else {
    drawFallbackCard(ctx, card, cardW, cardH);
  }
}

// Highest rank first, cycling the foundations: K K K K Q Q ... down to the
// aces. slotSuits[i] is the suit sitting on foundation i (Klondike's aces
// land wherever the player put them; Spider has eight runs, often several
// of one suit), so each card launches from the slot that really holds it.
export function launchOrder(slotSuits) {
  const order = [];
  for (let r = RANKS.length - 1; r >= 0; r--) {
    slotSuits.forEach((suit, slot) => order.push({ suit, rank: RANKS[r], slot }));
  }
  return order;
}

// Klondike launches its 52 cards 90ms apart; Spider's 104 go out twice as
// fast so the whole cascade still takes about as long.
const LAUNCH_SPAN_MS = 52 * 90;

export function createAnimator({ boardEl }) {
  let pendingFlips = [];
  // card id -> { sourceRect, delay }: a draw-three or a Spider deal sends
  // several cards at once, each starting a little after the last.
  let pendingFlights = new Map();
  let celebration = null; // the active cascade's state, or null between/before runs

  function applyFlight(el, card, flight) {
    const src = flight.sourceRect;

    const destRect = el.getBoundingClientRect();
    const originalHTML = el.innerHTML;
    const originalClass = el.className;
    const originalStyle = el.getAttribute('style') || '';

    el.innerHTML = '';
    el.className = flight.slide ? 'card flying slide' : 'card flying';
    el.style.setProperty('--fly-dx', (src.left - destRect.left) + 'px');
    el.style.setProperty('--fly-dy', (src.top - destRect.top) + 'px');
    el.style.setProperty('--fly-delay', flight.delay + 'ms');
    el.appendChild(buildFlipper(card, boardEl.dataset.mode));

    const onEnd = ev => {
      if (ev.target !== el) return;
      el.removeEventListener('animationend', onEnd);
      el.className = originalClass;
      el.setAttribute('style', originalStyle);
      el.innerHTML = originalHTML;
    };
    el.addEventListener('animationend', onEnd);
  }

  function applyFlip(el, card) {
    const i = pendingFlips.indexOf(card.id);
    if (i === -1) return;
    pendingFlips.splice(i, 1);

    const originalHTML = el.innerHTML;
    const originalClass = el.className;

    el.innerHTML = '';
    el.className = 'card flip-host';
    el.appendChild(buildFlipper(card, boardEl.dataset.mode));

    const onEnd = ev => {
      if (ev.target !== el) return;
      el.removeEventListener('animationend', onEnd);
      el.className = originalClass;
      el.innerHTML = originalHTML;
    };
    el.addEventListener('animationend', onEnd);
  }

  function afterCard(el, card) {
    if (!card) return;
    if (pendingFlips.length) applyFlip(el, card);
    const flight = pendingFlights.get(card.id);
    if (flight) {
      pendingFlights.delete(card.id);
      // Defer until the pile is in the DOM, or getBoundingClientRect() on the
      // destination returns (0,0) and the card flies in from the viewport corner.
      requestAnimationFrame(() => applyFlight(el, card, flight));
    }
  }

  // The only externally visible teardown entry point. Safe to call at any
  // point in a run's lifecycle, including while the atlas is still loading
  // (before state.end even has a canvas or timers to dispose of) and after
  // the run has already ended itself (celebration is already null by then).
  function cancelCelebration() {
    if (celebration) celebration.end(false);
  }

  async function startCelebration(onDone, slotSuits) {
    if (celebration) return; // already running — never overlap two cascades

    // Checked first, before building anything: a full-screen bouncing
    // animation is exactly what this preference exists to suppress.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onDone();
      return;
    }

    const state = {
      launchTimer: 0,
      rafId: 0,
      safetyTimer: 0,
      canvas: null,
      hiddenSlots: [],
      removeListeners: null,
      end: null,
    };
    celebration = state;

    // Defined immediately (before the async atlas load below) so
    // cancelCelebration() is safe to call during that load: `celebration`
    // is already `state`, so `celebration !== state` after the await
    // correctly signals "this run was cancelled while loading" and every
    // field it might try to clear is guarded to accept its initial zero.
    state.end = fireOnDone => {
      if (celebration !== state) return;
      celebration = null;
      if (state.launchTimer) clearInterval(state.launchTimer);
      if (state.rafId) cancelAnimationFrame(state.rafId);
      if (state.safetyTimer) clearTimeout(state.safetyTimer);
      if (state.removeListeners) state.removeListeners();
      if (state.canvas) state.canvas.remove();
      for (const slot of state.hiddenSlots) slot.style.opacity = '';
      if (fireOnDone) onDone();
    };

    // `celebration` is assigned above, before this try — so any throw in
    // here (atlas build, getContext('2d'), ctx.scale, or anything else in
    // startup) must not leave it stuck non-null: that would wedge the
    // reentry guard above for every future win, and — worse — silently
    // swallow onDone, since nothing downstream would ever call it. state.end
    // is written to be safe at any point in this lifecycle (every field it
    // touches has a falsy/empty initial value), including right here before
    // the canvas exists, so the catch can call it unconditionally to tear
    // down whatever partial state exists and still tell the caller the
    // player won.
    try {
      const atlas = await loadCardAtlas();
      if (celebration !== state) return; // cancelled while the atlas was loading

      // ---- Canvas overlay ----
      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement('canvas');
      canvas.className = 'cascade-canvas';
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      state.canvas = canvas; // assigned before appendChild so a throw below (e.g. ctx.scale) still leaves state.end() able to remove it
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr); // backing store is device pixels; every draw call below is in CSS pixels

      const rootStyle = getComputedStyle(document.documentElement);
      const cardW = parseFloat(rootStyle.getPropertyValue('--card-w')) || 80;
      const cardH = parseFloat(rootStyle.getPropertyValue('--card-h')) || cardW * 1.4;
      const bounds = { width: window.innerWidth, height: window.innerHeight, cardW, cardH };

      const cards = [];
      const order = launchOrder(slotSuits);
      let launchIdx = 0;

      function launchOne() {
        if (launchIdx >= order.length) return false;
        const { suit, rank, slot: slotIdx } = order[launchIdx++];
        const slot = boardEl.querySelector(`.pile[data-kind="foundation"][data-index="${slotIdx}"]`);
        if (!slot) return true; // shouldn't happen — board.js renders every foundation — but never hang

        const rect = slot.getBoundingClientRect();
        if (!state.hiddenSlots.includes(slot)) state.hiddenSlots.push(slot);
        slot.style.opacity = '0'; // the canvas card takes over this exact spot from here on

        const { vx, vy } = launchVelocity();
        cards.push({
          id: suit + rank, suit, rank, color: SUIT_COLOR[suit],
          x: rect.left, y: rect.top, vx, vy, settled: false,
        });
        return true;
      }

      launchOne(); // first card leaves immediately, no dead gap before the cascade starts
      state.launchTimer = setInterval(() => {
        if (!launchOne()) {
          clearInterval(state.launchTimer);
          state.launchTimer = 0;
        }
      }, Math.max(20, LAUNCH_SPAN_MS / Math.max(1, order.length)));

      // ---- Frame loop. THE CANVAS IS NEVER CLEARED — every drawImage call
      // stamps a new position without erasing the last; the accumulated
      // stamps are the trail effect itself. ----
      let lastT = 0;
      function frame(now) {
        // cascade-physics.js's wall-bounce handling is only exact when at
        // most one wall crossing happens per step, which this cap is what
        // guarantees (see MAX_STEP_MS's own comment in cascade-physics.js) —
        // do not remove or raise it, and do not subdivide a long frame into
        // several steps instead of clamping it.
        const dt = Math.min(MAX_STEP_MS, lastT ? now - lastT : 16);
        lastT = now;

        let allSettled = true;
        for (const c of cards) {
          stepCard(c, dt, bounds);
          drawCascadeCard(ctx, c, atlas, bounds.cardW, bounds.cardH);
          if (!c.settled) allSettled = false;
        }

        const allLaunched = launchIdx >= order.length;
        if (allLaunched && allSettled) {
          state.end(true);
          return;
        }
        state.rafId = requestAnimationFrame(frame);
      }
      state.rafId = requestAnimationFrame(frame);

      // ---- Early-exit triggers ----
      // 'pointerup' rather than 'click': drag.js calls preventDefault() on
      // pointerdown for every draggable card, including the four foundation
      // top cards that are still present (just visually hidden) while a
      // cascade runs. For touch pointers, preventDefault()'ing pointerdown
      // suppresses the browser's synthesized click, so a tap landing on a
      // foundation card would never reach a 'click' listener — 'pointerup'
      // fires regardless and covers mouse and touch uniformly, so a single
      // listener replaces the old 'click' one rather than adding a second.
      //
      // A tap/click on New/Undo must NOT end the cascade itself here: those
      // buttons run their own click handler (newGame() calls
      // cancelCelebration() before dealing), and 'pointerup' fires *before*
      // that handler (pointerup, then mouseup/click on bubble), so ending the
      // cascade from this listener first would show the win overlay between
      // the tap and the button's own handler, and the synthesized click would
      // then land on the overlay instead of the button — exactly the bug the
      // earlier pointerdown-to-click switch fixed. Skipping button targets
      // here lets the button's own handler tear the cascade down instead.
      //
      // Arming the pointerup listener has to dodge a nastier race than the
      // button one above: the very gesture that just completed the winning
      // move — e.g. a double-click auto-move — can still have trailing
      // 'pointerup' dispatches in flight for `window` when this line runs.
      // Verified directly in testing with two separate isTrusted pointerup
      // events from a single double-click: one stamped *before* this point
      // in time, and — because autoMove()'s re-render already removed the
      // card out from under the pointer — a second, retargeted one (fired
      // at whatever plain element is now under that screen position) stamped
      // only ~1ms *after* it. A bare timeStamp comparison catches the first
      // but not the second, so armedAt alone is not a safe filter; without
      // also deferring attachment, either trailing event ends the cascade
      // before a single frame is visible on essentially every double-click
      // win. Deferring by two animation frames gives both time to finish
      // dispatching before this listener can see anything at all; armedAt
      // is kept as a cheap second layer for whatever this margin doesn't
      // catch, since timeStamp is a DOMHighResTimeStamp on the same clock as
      // performance.now(). None of this affects genuine input: a real
      // tap/click arrives tens of milliseconds later at least.
      const armedAt = performance.now();
      function onPointerEnd(ev) {
        if (ev.timeStamp < armedAt) return;
        if (ev.target.closest && ev.target.closest('button')) return;
        state.end(true);
      }
      function onResize() { state.end(true); }
      let armRaf = requestAnimationFrame(() => {
        armRaf = requestAnimationFrame(() => {
          armRaf = 0;
          window.addEventListener('pointerup', onPointerEnd);
        });
      });
      window.addEventListener('resize', onResize, { once: true });
      state.removeListeners = () => {
        if (armRaf) cancelAnimationFrame(armRaf);
        window.removeEventListener('pointerup', onPointerEnd);
        window.removeEventListener('resize', onResize);
      };

      // Safety backstop, not the normal exit path — a healthy run (worst-case
      // single-card settle ~6.7s, ~4.7s to launch all 52) finishes near 11s.
      state.safetyTimer = setTimeout(() => state.end(true), 20000);
    } catch (err) {
      // The player did win, even though the cascade itself blew up — tear
      // down whatever partial state exists (canvas may not exist yet;
      // listeners may not be attached yet; state.end tolerates all of that)
      // and still fire onDone, or the win would go completely unreported:
      // no overlay, no recorded stats, celebration stuck non-null forever.
      // Logged first so a future atlas or canvas regression is diagnosable
      // rather than silently swallowed.
      console.error('cascade failed', err);
      state.end(true);
    }
  }

  return {
    afterCard,
    queueFlip: id => { if (id) pendingFlips.push(id); },
    queueFlips: ids => { for (const id of ids || []) if (id) pendingFlips.push(id); },
    // slide: the card is face up at both ends, so it travels without the
    // back-to-front spin a card turned off the stock gets.
    queueFlights: (ids, sourceRect, { stagger = 70, slide = false } = {}) => {
      ids.forEach((id, i) => pendingFlights.set(id, { sourceRect, delay: i * stagger, slide }));
    },
    // Called after each render: a flight no rendered card claimed (a dealt
    // card swept straight into a finished Spider run) must not linger and
    // fire later, when an undo brings that card back.
    dropUnclaimed: () => pendingFlights.clear(),
    startCelebration,
    cancelCelebration,
  };
}

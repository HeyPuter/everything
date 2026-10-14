// Getting started: a short, skippable tour of callouts anchored to the main
// areas (playback mode, channel rack, piano roll, playlist, mixer, browser),
// ending with the essential shortcuts. Opened from Help or the alpha notice,
// never automatically. Arrow keys step through it and Escape ends it.

import { h, announce } from '../lib/dom.js';
import { formatKeys } from '../commands/registry.js';

const STEPS = [
  {
    anchor: '.mode-seg',
    title: 'Pattern and song mode',
    text: 'PAT plays the selected pattern on a loop while you build it. SONG plays the arrangement in the playlist.',
    keys: [['Space', 'Play or stop'], ['L', 'Switch mode']],
  },
  {
    anchor: '.panel-rack',
    panel: 'rack',
    title: 'Channel rack',
    text: 'Each row is an instrument. Click the steps to program a beat; the pattern loops while you edit.',
    keys: [['F6', 'Show the channel rack']],
  },
  {
    anchor: '.panel-pianoRoll',
    panel: 'pianoRoll',
    title: 'Piano roll',
    text: 'Draw melodies and chords for the selected channel. Notes have length, velocity and pan.',
    keys: [['F7', 'Show the piano roll']],
  },
  {
    anchor: '.panel-playlist',
    panel: 'playlist',
    title: 'Playlist',
    text: 'Arrange patterns, audio and automation clips into a song. Drag patterns in from the browser.',
    keys: [['F5', 'Show the playlist']],
  },
  {
    anchor: '.panel-mixer',
    panel: 'mixer',
    title: 'Mixer',
    text: 'Every channel plays into a mixer insert. Set levels, add effects and route sends here.',
    keys: [['F9', 'Show the mixer']],
  },
  {
    anchor: '.panel-browser',
    panel: 'browser',
    title: 'Browser',
    text: 'Instruments, presets, effects, the parts of your project and your files. Click to preview, double-click or drag to add.',
    keys: [['Alt+F8', 'Show the browser']],
  },
  {
    title: 'Essential shortcuts',
    text: 'Hover any button to see its shortcut. The full list is under Help > Keyboard shortcuts.',
    keys: [['Mod+S', 'Save'], ['Mod+Z', 'Undo'], ['Mod+Shift+Z', 'Redo'], ['Mod+R', 'Export audio'], ['?', 'All shortcuts']],
  },
];

let active = null;

export function startTour(app) {
  active?.end();
  const previous = document.activeElement;
  const phonePanel = app.prefs.get('mobilePanel');
  let index = 0;
  const titleId = 'tour-title';
  const ring = h('div.tour-ring', { 'aria-hidden': 'true' });
  const title = h('h2.tour-title', { id: titleId });
  const text = h('p.tour-text');
  const keys = h('dl.tour-keys');
  const counter = h('span.tour-count');
  const back = h('button.btn.sm', { type: 'button', onclick: () => go(index - 1) }, 'Back');
  const next = h('button.btn.sm.primary', { type: 'button', onclick: () => (index === STEPS.length - 1 ? end() : go(index + 1)) }, 'Next');
  const skip = h('button.btn.sm.ghost', { type: 'button', onclick: () => end() }, 'Skip tour');
  const pop = h(
    'div.tour',
    { role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': titleId, tabindex: '-1' },
    h('div.tour-head', title, counter),
    text,
    keys,
    h('div.tour-foot', skip, h('div.spacer'), back, next),
  );
  document.body.append(ring, pop);

  const anchorFor = (step) => {
    if (!step.anchor) return null;
    const el = document.querySelector(step.anchor);
    if (!el || el.hidden || el.offsetParent === null) return null;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 ? r : null;
  };

  const place = () => {
    const step = STEPS[index];
    const r = anchorFor(step);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    ring.hidden = !r;
    if (!r) {
      pop.style.left = `${Math.max(8, (vw - pw) / 2)}px`;
      pop.style.top = `${Math.max(8, (vh - ph) / 2)}px`;
      return;
    }
    const pad = 4;
    Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    // Prefer below a small anchor, else inside the anchor's top-left area for large panels.
    let left;
    let top;
    if (r.height < vh / 3) {
      left = r.left;
      top = r.bottom + 10;
      if (top + ph > vh - 8) top = r.top - ph - 10;
    } else {
      left = r.left + 16;
      top = r.top + 40;
    }
    pop.style.left = `${Math.round(Math.min(Math.max(8, left), vw - pw - 8))}px`;
    pop.style.top = `${Math.round(Math.min(Math.max(8, top), vh - ph - 8))}px`;
  };

  function go(i) {
    index = Math.max(0, Math.min(STEPS.length - 1, i));
    const step = STEPS[index];
    // On phones one panel shows at a time: switch to the step's panel.
    if (step.panel && app.root.classList.contains('is-phone')) app.shell?.showMobile?.(step.panel);
    title.textContent = step.title;
    text.textContent = step.text;
    keys.replaceChildren(...step.keys.flatMap(([k, label]) => [h('dt', h('kbd.kbd', k === '?' ? '?' : formatKeys(k))), h('dd', label)]));
    counter.textContent = `${index + 1} of ${STEPS.length}`;
    back.disabled = index === 0;
    next.textContent = index === STEPS.length - 1 ? 'Done' : 'Next';
    requestAnimationFrame(place);
    place();
    pop.focus({ preventScroll: true });
    announce(`${step.title}. ${step.text}`);
  }

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      end();
    } else if (e.key === 'ArrowRight' && !e.target.closest?.('input, textarea')) {
      e.preventDefault();
      if (index < STEPS.length - 1) go(index + 1);
    } else if (e.key === 'ArrowLeft' && !e.target.closest?.('input, textarea')) {
      e.preventDefault();
      go(index - 1);
    }
  };
  pop.addEventListener('keydown', onKey);
  window.addEventListener('resize', place);

  function end() {
    pop.remove();
    ring.remove();
    window.removeEventListener('resize', place);
    active = null;
    // Phones: return to the view the tour started from.
    if (app.root.classList.contains('is-phone') && app.prefs.get('mobilePanel') !== phonePanel) app.shell?.showMobile?.(phonePanel);
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  }
  active = { end };
  go(0);
  return active;
}

/** Adds "Take the tour" to the first-run alpha notice when it is showing. */
export function offerTourFromAlphaNotice(app) {
  const actions = document.querySelector('.alpha-notice .alpha-actions');
  if (!actions || actions.querySelector('.tour-offer')) return;
  const gotIt = actions.querySelector('button');
  actions.prepend(
    h(
      'button.btn.sm.tour-offer',
      {
        type: 'button',
        onclick: () => {
          gotIt?.click();
          startTour(app);
        },
      },
      'Take the tour',
    ),
  );
}

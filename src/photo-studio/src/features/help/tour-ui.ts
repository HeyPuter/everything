// Runs a tutorial in the workspace: a step card next to the control it is
// about, a ring around that control, and steps that finish when the user
// actually does them (commands and tool changes through app/activity.ts,
// document changes through the editor's update hooks).
import './help.css';
import type { Editor } from '../../editor';
import { onActivity, type Activity } from '../../app/activity';
import { tools } from '../../app/registry';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { isAction, stepDone, TourMachine, type Anchor, type Step, type Tutorial, type TourView } from './tour';
import { tutorial } from './tutorials';
import { openSample } from './open-sample';

// Time a finished step shows its check mark before the next one.
const DONE_DELAY = 700;
const MARGIN = 12;
// Cards stay below the menu bar so they never hide a menu.
const TOP = 40;
const view = (e: Editor): TourView => ({ doc: e.doc, tool: e.tool, zoom: e.zoom, selected: e.selected, hasDocument: e.hasDocument });

let current: TourRun | undefined;
let hooked = false;
export const runningTour = () => current;

class TourRun {
  machine: TourMachine;
  base: TourView;
  // The document the current step began in; only edits there count.
  session: Editor['session'];
  card: HTMLElement;
  ring: HTMLElement;
  private stop: (() => void)[] = [];
  private pending = 0;
  private timer = 0;
  private key = '';
  constructor(
    readonly e: Editor,
    readonly tour: Tutorial,
  ) {
    this.machine = new TourMachine(tour.steps.length);
    this.base = view(e);
    this.session = e.session;
    this.ring = document.createElement('div');
    this.ring.className = 'tour-ring';
    this.ring.setAttribute('aria-hidden', 'true');
    this.card = document.createElement('section');
    this.card.className = 'tour-card';
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-label', `Tutorial: ${tour.title}`);
    this.card.addEventListener('click', (ev) => {
      const act = (ev.target as HTMLElement).closest<HTMLElement>('[data-tour]')?.dataset.tour;
      if (act) void this.action(act);
    });
    e.root.append(this.ring, this.card);
    this.stop.push(onActivity((a) => this.evaluate(a)));
    // Polling keeps the card on its control as panels move and catches
    // changes that do not announce themselves (zoom); it is cheap and works
    // in background tabs where animation frames do not run.
    this.timer = window.setInterval(() => {
      this.evaluate();
      this.place();
    }, 250);
    const onResize = () => this.place();
    window.addEventListener('resize', onResize);
    this.stop.push(() => window.removeEventListener('resize', onResize));
  }
  get step(): Step | undefined {
    return this.machine.finished ? undefined : this.tour.steps[this.machine.index];
  }
  /** Begin the current step: show its panel and remember the starting state. */
  enter() {
    const s = this.step;
    if (s?.panel) this.e.dock?.show(s.panel);
    this.base = view(this.e);
    this.session = this.e.session;
    this.pending = 0;
    this.render();
    // A step already satisfied (the tool is already chosen) finishes at once.
    this.evaluate();
  }
  evaluate(activity?: Activity) {
    const s = this.step;
    if (!s || this.pending || !isAction(s)) return;
    if (this.e.session !== this.session) {
      // Work in another document does not count. If the step's document was
      // closed, the step continues from the document now active.
      if (this.e.sessions.includes(this.session)) return;
      this.session = this.e.session;
      this.base = view(this.e);
      return;
    }
    if (!stepDone(s, view(this.e), this.base, activity)) return;
    this.card.classList.add('done');
    this.render(true);
    this.pending = window.setTimeout(() => {
      this.pending = 0;
      if (current !== this) return;
      this.machine.complete();
      this.enter();
    }, DONE_DELAY);
  }
  async action(act: string) {
    clearTimeout(this.pending);
    this.pending = 0;
    if (act === 'close') return this.close();
    if (act === 'next' || act === 'skip') this.machine.next();
    else if (act === 'back') this.machine.back();
    else if (act === 'restart') {
      this.machine.restart();
      await this.e.run(() => openSample(this.e, this.tour.sample));
      this.e.setTool('move');
    } else if (act === 'more') {
      this.close();
      (await import('./windows')).showTutorials(this.e);
      return;
    }
    this.enter();
  }
  render(done = false) {
    const { step: n, of } = this.machine.progress();
    const s = this.step;
    this.card.classList.toggle('done', done);
    this.card.classList.toggle('finished', !s);
    if (!s) {
      this.key = '';
      this.card.innerHTML = `<div class="tour-head"><span class="tour-kicker">${escapeXML(this.tour.title)}</span><button type="button" class="icon-button" data-tour="close" aria-label="Close tutorial" title="Close tutorial">${svg('x', 14)}</button></div><div class="tour-progress" aria-hidden="true"><span style="width:100%"></span></div><h3>${svg('check', 16)} Tutorial complete</h3><p>You finished “${escapeXML(this.tour.title)}”. The sample document stays open so you can keep experimenting.</p><div class="tour-actions"><button type="button" data-tour="back">Back</button><button type="button" data-tour="restart">Restart</button><span class="tour-spacer"></span><button type="button" data-tour="more">More tutorials</button><button type="button" class="primary" data-tour="close">Close</button></div>`;
      this.place();
      return;
    }
    const action = isAction(s);
    const status = !action ? '' : done ? `<p class="tour-status tour-status-done" role="status">${svg('check', 14)} Done</p>` : `<p class="tour-status" role="status">Do this step to continue, or skip it.</p>`;
    this.card.innerHTML = `<div class="tour-head"><span class="tour-kicker">${escapeXML(this.tour.title)} · Step ${n} of ${of}</span><button type="button" class="icon-button" data-tour="close" aria-label="Close tutorial" title="Close tutorial">${svg('x', 14)}</button></div><div class="tour-progress" aria-hidden="true"><span style="width:${Math.round(((n - 1) / of) * 100)}%"></span></div><h3>${escapeXML(s.title)}</h3><p>${escapeXML(s.text)}</p>${status}<div class="tour-actions"><button type="button" data-tour="back" ${this.machine.index === 0 ? 'disabled' : ''}>Back</button><button type="button" data-tour="restart" title="Start over with a fresh sample image">Restart</button><span class="tour-spacer"></span>${action ? `<button type="button" data-tour="skip">Skip step</button>` : `<button type="button" class="primary" data-tour="next">${n === of ? 'Finish' : 'Next'}</button>`}</div>`;
    this.key = '';
    this.place();
  }
  /** Position the ring around the step's control and the card beside it. */
  place() {
    const target = this.step?.anchor ? resolveAnchor(this.e, this.step.anchor) : null;
    const r = target?.getBoundingClientRect();
    const W = window.innerWidth,
      H = window.innerHeight;
    const key = r ? `${r.left},${r.top},${r.width},${r.height},${W},${H},${this.card.offsetHeight}` : `none,${W},${H},${this.card.offsetHeight}`;
    if (key === this.key) return;
    this.key = key;
    const cw = this.card.offsetWidth || 320,
      ch = this.card.offsetHeight || 200;
    if (!r || !r.width || !r.height) {
      this.ring.hidden = true;
      this.card.style.left = `${Math.max(MARGIN, W - cw - MARGIN - 300)}px`;
      this.card.style.top = `${Math.max(TOP, H - ch - 48)}px`;
      return;
    }
    this.ring.hidden = false;
    const pad = 4;
    Object.assign(this.ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    const [x, y] = cardPosition(r, { width: cw, height: ch }, { width: W, height: H });
    this.card.style.left = `${x}px`;
    this.card.style.top = `${y}px`;
  }
  close() {
    clearTimeout(this.pending);
    clearInterval(this.timer);
    for (const s of this.stop.splice(0)) s();
    this.card.remove();
    this.ring.remove();
    if (current === this) current = undefined;
  }
}

type Box = { left: number; top: number; width: number; height: number };
/** Where the card goes for a control at `r`: beside it when there is room,
 * otherwise below or above, inside a large control (the canvas) at its
 * lower left; always kept on screen. */
export function cardPosition(r: Box, card: { width: number; height: number }, screen: { width: number; height: number }): [number, number] {
  const gap = 14;
  const clampX = (x: number) => Math.max(MARGIN, Math.min(screen.width - card.width - MARGIN, x));
  const clampY = (y: number) => Math.max(TOP, Math.min(screen.height - card.height - MARGIN, y));
  if (r.width * r.height > screen.width * screen.height * 0.2) return [clampX(r.left + 24), clampY(r.top + r.height - card.height - 24)];
  const right = r.left + r.width + gap;
  if (right + card.width <= screen.width - MARGIN) return [right, clampY(r.top)];
  const left = r.left - gap - card.width;
  if (left >= MARGIN) return [left, clampY(r.top)];
  const below = r.top + r.height + gap;
  if (below + card.height <= screen.height - MARGIN) return [clampX(r.left), below];
  return [clampX(r.left), clampY(r.top - gap - card.height)];
}

const visible = (el: Element | null | undefined): el is HTMLElement => !!el && (el as HTMLElement).getClientRects().length > 0 && !(el as HTMLElement).closest('[hidden]');
function firstVisible(e: Editor, selector: string) {
  return [...e.root.querySelectorAll<HTMLElement>(selector)].find((el) => visible(el)) ?? null;
}
/** The element a step points at, or null when it is not on screen. */
export function resolveAnchor(e: Editor, a: Anchor): HTMLElement | null {
  if ('selector' in a) return firstVisible(e, a.selector);
  if ('command' in a) return firstVisible(e, `[data-command="${CSS.escape(a.command)}"]`);
  if ('panel' in a) return firstVisible(e, `[data-panel="${CSS.escape(a.panel)}"]`);
  if ('canvas' in a) return firstVisible(e, '#viewport');
  if ('menu' in a) return [...e.root.querySelectorAll<HTMLElement>('.menubar-entry > .menubar-button')].find((b) => b.textContent?.trim() === a.menu) ?? null;
  const group = tools.get(a.tool)?.group;
  return (group && firstVisible(e, `.tool-slots [data-slot="${CSS.escape(group)}"]`)) || firstVisible(e, '.tool-slots');
}

/** Start a tutorial on a fresh sample document. */
export async function startTutorial(e: Editor, id: string) {
  const t = tutorial(id);
  if (!t) throw new Error(`Unknown tutorial: ${id}`);
  current?.close();
  if (!hooked) {
    hooked = true;
    e.onUpdate(() => current?.evaluate());
  }
  await openSample(e, t.sample);
  e.setTool('move');
  current = new TourRun(e, t);
  current.enter();
  e.message(`Tutorial: ${t.title}`);
}
export function closeTutorial() {
  current?.close();
}

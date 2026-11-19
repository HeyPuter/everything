// Guided tutorials (the Learn panel): the step engine. A tutorial is data:
//
//   { id, title, summary, minutes, setup?(app, ctx) -> Promise, steps: [Step] }
//   Step = {
//     id, title, text,                 what to do, in our words
//     target?: CSS selector | (app, ctx) => Element | null    what to highlight
//     command?: id                      the command the step is about (highlighted in menus
//                                       and toolbars, its shortcut shown)
//     menu?: ['Effects', 'Submenu']     where that command lives in the menu bar
//     done: { command: id | [ids] }     completes when one of these commands runs
//         | { edit: 'Label' }           ...when the active file's last edit has this label
//         | { check(app, ctx) }         ...when this returns true (checked on app events)
//         | { manual: true }            ...when the user presses Next
//     enter?(app, ctx)                  runs as the step begins (e.g. measures the audio)
//     verify?(app, ctx) -> message | null | Promise   checks the result once `done` is met:
//                                       a message keeps the step open and says what to adjust
//     drag?: { from: [fx, fy], to: [fx, fy] } | { from, by: [dx, dy] }   a drag to show,
//                                       in fractions of the target's box (by: in pixels)
//   }
//
// The runner follows one tutorial at a time, advances when a step's condition is met,
// and keeps each tutorial's progress in app.prefs ('learnProgress') so it can resume.

import { Emitter } from '../lib/emitter.js';

const PROGRESS_KEY = 'learnProgress';

/** Whether `done` is met right now (commands are reported separately as they run). */
export function stepSatisfied(step, app, ctx, ranCommand = null) {
  const done = step?.done || {};
  if (done.command) {
    const ids = [].concat(done.command);
    return ranCommand != null && ids.includes(ranCommand);
  }
  if (done.edit) {
    const label = app.active?.history?.undoLabel || '';
    // Only edits made since the step began count (not an older one with the same name).
    return label.includes(done.edit) && app.active?.history?.index !== ctx?.stepHistory?.index;
  }
  if (typeof done.check === 'function') {
    try {
      return Boolean(done.check(app, ctx || {}));
    } catch {
      return false;
    }
  }
  return false;
}

export class TutorialRunner extends Emitter {
  /**
   * @param {object} app the app (commands, prefs, on/emit)
   * @param {object[]} tutorials tutorial definitions
   */
  constructor(app, tutorials) {
    super();
    this.app = app;
    this.tutorials = tutorials;
    this.run = null; // { tutorial, index, ctx }
    this.offs = [];
  }

  get(id) {
    return this.tutorials.find((t) => t.id === id) || null;
  }

  /** { step, total, done, started } for a tutorial. */
  progress(id) {
    const t = this.get(id);
    const p = (this.app.prefs.get(PROGRESS_KEY) || {})[id] || {};
    const total = t ? t.steps.length : 0;
    const step = Math.max(0, Math.min(total, Number(p.step) || 0));
    return { step, total, done: Boolean(p.done) || (total > 0 && step >= total), started: step > 0 || Boolean(p.done) };
  }

  #save(id, patch) {
    const all = { ...(this.app.prefs.get(PROGRESS_KEY) || {}) };
    all[id] = { ...(all[id] || {}), ...patch };
    this.app.prefs.set(PROGRESS_KEY, all);
  }

  /** The step in progress: { tutorial, index, step, total } or null. */
  get current() {
    if (!this.run) return null;
    const { tutorial, index } = this.run;
    return { tutorial, index, step: tutorial.steps[index] || null, total: tutorial.steps.length, ctx: this.run.ctx };
  }

  /** Starts (or resumes at its saved step) a tutorial. */
  async start(id, { restart = false } = {}) {
    const tutorial = this.get(id);
    if (!tutorial) return false;
    this.stop();
    this.lastFinished = null;
    const ctx = {};
    const prog = this.progress(id);
    const index = restart || prog.done ? 0 : prog.step;
    if (restart || prog.done) this.#save(id, { step: 0, done: false });
    const run = (this.run = { tutorial, index, ctx });
    try {
      await tutorial.setup?.(this.app, ctx);
    } catch (err) {
      this.app.notify?.(`The tutorial could not be set up: ${err?.message || err}`, { error: true });
    }
    // Stopped or replaced while setting up.
    if (this.run !== run) return false;
    // Listen only once set up: opening its practice file is not a step being done.
    this.#listen();
    this.#enterStep();
    return true;
  }

  /** Leaves the tutorial; its progress is kept for later. */
  stop() {
    for (const off of this.offs) off();
    this.offs = [];
    const was = this.run;
    this.run = null;
    if (was) this.emit('change', null);
  }

  /** Skips to the next step (or finishes). */
  next() {
    if (!this.run) return;
    this.#advance();
  }

  back() {
    if (!this.run || this.run.index === 0) return;
    this.run.index--;
    this.#save(this.run.tutorial.id, { step: this.run.index, done: false });
    this.#enterStep();
  }

  #enterStep() {
    const r = this.run;
    if (!r) return;
    // Remembered so an edit step needs a new edit, not one made before it began.
    r.ctx.stepHistory = { index: this.app.active?.history?.index };
    r.ctx.problem = null;
    r.ctx.checking = false;
    r.ctx.verified = undefined;
    this.verifyToken = (this.verifyToken || 0) + 1;
    try {
      r.tutorial.steps[r.index]?.enter?.(this.app, r.ctx);
    } catch {
      // A failed measurement only means the result is not checked.
    }
    this.emit('change', this.current);
    // A condition that already holds (e.g. the display is already on) completes at once.
    queueMicrotask(() => this.#check());
  }

  #advance() {
    const r = this.run;
    if (!r) return;
    r.index++;
    const done = r.index >= r.tutorial.steps.length;
    this.#save(r.tutorial.id, { step: Math.min(r.index, r.tutorial.steps.length), done });
    if (done) {
      const t = r.tutorial;
      // Kept for the panel's closing card (Keep a Copy of the practice file).
      this.lastFinished = { tutorial: t, ctx: r.ctx };
      this.stop();
      this.emit('finished', t);
      return;
    }
    this.#enterStep();
  }

  #check(ranCommand = null) {
    const cur = this.current;
    if (!cur?.step || cur.step.done?.manual) return;
    if (!stepSatisfied(cur.step, this.app, cur.ctx, ranCommand)) return;
    if (cur.step.verify) this.#verify(cur);
    else this.#advance();
  }

  /** Checks the step's result; advances when it is good, else explains what to change. */
  async #verify(cur) {
    const ctx = cur.ctx;
    // Once per state of the audio: other events do not measure the same result again.
    const state = this.app.active?.state ?? null;
    if (ctx.checking || ctx.verified === state) return;
    ctx.verified = state;
    const token = (this.verifyToken = (this.verifyToken || 0) + 1);
    ctx.checking = true;
    this.emit('change', this.current);
    let problem = null;
    try {
      problem = await cur.step.verify(this.app, ctx);
    } catch {
      problem = null; // a measurement that fails does not hold the tutorial up
    }
    if (token !== this.verifyToken || this.run?.ctx !== ctx) return;
    ctx.checking = false;
    if (problem) {
      ctx.problem = String(problem);
      this.emit('change', this.current);
    } else this.#advance();
  }

  #listen() {
    const app = this.app;
    const recheck = () => this.#check();
    if (app.commands?.watch) this.offs.push(app.commands.watch({ after: (id) => this.#check(id) }));
    for (const ev of ['doc-change', 'active', 'documents', 'tool', 'transport', 'spectral-selection', 'prefs']) {
      const off = app.on?.(ev, recheck);
      if (off) this.offs.push(off);
    }
    const dockOff = app.dock?.on?.('change', recheck);
    if (dockOff) this.offs.push(dockOff);
  }
}

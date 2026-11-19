// The Learn panel: the tutorials with their progress, and the step in progress with
// Back, Skip and Stop. Window > Learn and Help > Learn open it.

import { h, announce } from '../lib/dom.js';
import { TutorialRunner } from './engine.js';
import { TUTORIALS } from './tutorials.js';
import { Highlighter, resolveTarget } from './highlight.js';

/** The app's tutorial runner (one per app), with the highlight following its step. */
export function learnRunner(app) {
  if (app.learn) return app.learn;
  const runner = new TutorialRunner(app, TUTORIALS);
  const hl = new Highlighter();
  runner.on('change', (cur) => {
    hl.show(cur?.step || null, () => resolveTarget(cur?.step, app, cur?.ctx));
    if (cur?.step) announce(`Step ${cur.index + 1} of ${cur.total}: ${cur.step.title}. ${cur.step.text}`);
  });
  runner.on('finished', (t) => {
    hl.show(null);
    app.setStatus?.(`Tutorial finished: ${t.title}`);
    announce(`Tutorial finished: ${t.title}`);
  });
  app.learn = runner;
  return runner;
}

export function learnPanel(app) {
  const runner = learnRunner(app);
  const runView = h('section.learn-run', { 'aria-label': 'Tutorial in progress', hidden: true });
  const list = h('ol.learn-list', { 'aria-label': 'Tutorials' });
  const intro = h('p.learn-intro.faint', 'Short guided walkthroughs. Each one makes its own practice audio and moves on as you do each step. Leave at any time and resume later.');
  const el = h('div.learn-panel', runView, intro, list);

  const finishedCard = () => {
    const f = runner.lastFinished;
    if (!f) return null;
    const doc = [f.ctx.doc, f.ctx.voice, f.ctx.music].find((d) => d && app.documents.includes(d) && d.practice) || null;
    return [
      h('div.learn-run-head', h('span.learn-run-title', `Finished: ${f.tutorial.title}`)),
      h('p.learn-step-text', doc ? `Nicely done. The practice file closes without asking to be saved; keep a copy if you want to come back to "${doc.name}".` : 'Nicely done.'),
      h(
        'div.learn-run-buttons',
        doc ? h('button.btn.primary', { type: 'button', onclick: () => { app.activate?.(doc); app.commands.run('file.saveAs'); } }, 'Keep a Copy...') : null,
        h('div.spacer'),
        h('button.btn', { type: 'button', onclick: () => { runner.lastFinished = null; render(); } }, 'Close'),
      ),
    ];
  };

  const renderRun = () => {
    const cur = runner.current;
    const done = !cur && finishedCard();
    runView.hidden = !cur && !done;
    if (done) return runView.replaceChildren(...done.filter(Boolean));
    if (!cur) return runView.replaceChildren();
    const { tutorial, index, total, step } = cur;
    const key = step.command ? app.commands.shortcutLabel?.(step.command) : '';
    const manual = Boolean(step.done?.manual);
    const next = h('button.btn', { type: 'button', onclick: () => runner.next() }, manual ? (index + 1 === total ? 'Finish' : 'Next') : 'Skip Step');
    if (manual) next.classList.add('primary');
    // Optional parts are null when absent: leave them out (h() would print "null").
    const parts = [
      h('div.learn-run-head', h('span.learn-run-title', tutorial.title), h('span.learn-run-count.faint', `Step ${index + 1} of ${total}`)),
      h('div.learn-meter', { role: 'progressbar', 'aria-label': 'Tutorial progress', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(index) }, h('div.learn-meter-fill', { style: { width: `${(index / total) * 100}%` } })),
      h('h3.learn-step-title', { tabindex: '-1' }, step.title),
      h('p.learn-step-text', step.text),
      cur.ctx?.checking ? h('p.learn-checking.faint', { role: 'status' }, 'Checking the result...') : null,
      cur.ctx?.problem ? h('p.learn-problem', { role: 'alert' }, cur.ctx.problem) : null,
      key ? h('p.learn-step-key.faint', 'Shortcut: ', h('kbd', key)) : null,
      h(
        'div.learn-run-buttons',
        h('button.btn', { type: 'button', disabled: index === 0, onclick: () => runner.back() }, 'Back'),
        next,
        h('div.spacer'),
        h('button.btn', { type: 'button', onclick: () => runner.stop() }, 'Stop'),
      ),
    ];
    runView.replaceChildren(...parts.filter(Boolean));
  };

  const renderList = () => {
    list.replaceChildren(
      ...runner.tutorials.map((t) => {
        const p = runner.progress(t.id);
        const running = runner.current?.tutorial === t;
        const state = p.done ? 'Done' : p.started ? `${p.step} of ${p.total} steps` : `${p.total} steps, about ${t.minutes} min`;
        const start = h(
          'button.btn',
          { type: 'button', disabled: running, 'aria-label': `${p.started && !p.done ? 'Resume' : 'Start'} ${t.title}`, onclick: () => runner.start(t.id) },
          p.done ? 'Start Again' : p.started ? 'Resume' : 'Start',
        );
        const restart = p.started && !p.done ? h('button.btn.learn-restart', { type: 'button', 'aria-label': `Start ${t.title} over`, onclick: () => runner.start(t.id, { restart: true }) }, 'Restart') : null;
        return h(
          'li.learn-item',
          { dataset: { tutorial: t.id }, 'aria-current': running ? 'step' : null },
          h('div.learn-item-head', h('span.learn-item-title', t.title), p.done ? h('span.learn-done', { 'aria-label': 'Completed' }, '✓') : null),
          h('p.learn-item-summary.faint', t.summary),
          h('div.learn-meter', { 'aria-hidden': 'true' }, h('div.learn-meter-fill', { style: { width: `${p.total ? (p.step / p.total) * 100 : 0}%` } })),
          h('div.learn-item-foot', h('span.learn-item-state.faint', state), h('div.spacer'), restart, start),
        );
      }),
    );
  };

  // Re-rendering replaces the buttons: keep keyboard focus on the same one (or, when a
  // tutorial starts or moves on from a list button, on the step's title).
  let shown = null;
  const render = () => {
    const focused = el.contains(document.activeElement) ? document.activeElement : null;
    const key = focused && (focused.getAttribute('aria-label') || focused.textContent);
    const wasRunning = shown;
    renderRun();
    renderList();
    shown = runner.current?.tutorial || null;
    if (!focused) return;
    const same = [...el.querySelectorAll('button')].find((b) => !b.disabled && (b.getAttribute('aria-label') || b.textContent) === key);
    if (shown && (!wasRunning || !same)) runView.querySelector('.learn-step-title')?.focus({ preventScroll: true });
    else if (!shown && wasRunning && runner.lastFinished) runView.querySelector('button')?.focus({ preventScroll: true });
    else (same || list.querySelector('button'))?.focus({ preventScroll: true });
  };
  runner.on('change', render);
  runner.on('finished', render);
  render();
  return { el };
}

// Help → Hands-on Tutorials and What's New, and the Learn area of the start
// screen. Registration only: the windows, the tutorial engine and the sample
// images load on first use.
import './learn.css';
import type { Editor } from '../../editor';
import { registerCommand } from '../../app/registry';
import { lazy, lazyRun, whenIdle } from '../../app/lazy';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { TUTORIALS } from './tutorial-list';

const windows = lazy(() => import('./windows'));

function renderLearn(e: Editor) {
  const host = e.root.querySelector<HTMLElement>('#empty');
  if (!host || host.querySelector('.start-learn')) return;
  const section = document.createElement('section');
  section.className = 'start-learn';
  section.setAttribute('aria-label', 'Learn');
  section.innerHTML = `<h2>Learn</h2><div class="start-learn-row">${TUTORIALS.map(
    (t) =>
      `<button type="button" class="start-learn-item" data-learn="${t.id}" title="${escapeXML(t.summary)}"><span class="start-learn-thumb" data-learn-thumb="${t.sample}"></span><span class="start-learn-name">${escapeXML(t.title)}</span><span class="start-learn-time">About ${t.minutes} min</span></button>`,
  ).join('')}<button type="button" class="start-learn-item start-learn-new" data-command="help.whats-new"><span class="start-learn-thumb">${svg('sparkles', 22)}</span><span class="start-learn-name">What’s New</span><span class="start-learn-time">Recent features</span></button></div>`;
  section.addEventListener('click', (ev) => {
    const id = (ev.target as HTMLElement).closest<HTMLElement>('[data-learn]')?.dataset.learn;
    if (id) void windows().then((m) => m.beginTutorial(e, id));
  });
  section.addEventListener('pointerenter', () => windows.prefetch(), { once: true });
  // After the presets, before recent documents and the drop hint.
  const after = host.querySelector('.start-presets') ?? host.querySelector('.start-head');
  if (after) after.after(section);
  else host.append(section);
  // Thumbnails are drawn from the generated samples once the browser is idle.
  whenIdle(() =>
    void windows().then((m) => {
      for (const el of section.querySelectorAll<HTMLElement>('[data-learn-thumb]'))
        el.innerHTML = `<img src="${m.sampleThumb(el.dataset.learnThumb as Parameters<typeof m.sampleThumb>[0])}" alt="">`;
    }),
  );
}

export function installHelp(e: Editor) {
  registerCommand(
    {
      id: 'help.tutorials',
      label: 'Hands-on Tutorials',
      recordable: false,
      description: 'Guided tours that walk you through common tasks on sample images',
      ...lazyRun(windows, (m, e) => m.showTutorials(e)),
    },
    {
      id: 'help.whats-new',
      label: 'What’s New',
      recordable: false,
      description: 'Recent features, with a button to try each one',
      ...lazyRun(windows, (m, e) => m.showWhatsNew(e)),
    },
  );
  renderLearn(e);
}

// Help windows: the tutorial chooser (Help → Hands-on Tutorials) and
// What's New, whose "Try it" buttons run or show the feature.
import './help.css';
import type { Editor } from '../../editor';
import { findCommand, panels, tools } from '../../app/registry';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { TUTORIALS, tutorialInfo } from './tutorial-list';
import { WHATS_NEW, type WhatsNewEntry } from './whats-new-data';
import { makeSample, flattenSample, type SampleId } from './samples';
import { openSample } from './open-sample';

const thumbs = new Map<SampleId, string>();
/** A small rendering of a sample image as a data URL (cached). */
export function sampleThumb(id: SampleId): string {
  let url = thumbs.get(id);
  if (url) return url;
  const img = flattenSample(makeSample(id, 192, 128));
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  url = c.toDataURL('image/png');
  thumbs.set(id, url);
  return url;
}

function windowDialog(e: Editor, cls: string, title: string, body: string) {
  e.root.querySelector(`dialog.${cls}`)?.remove();
  const d = document.createElement('dialog');
  d.className = `help-window ${cls}`;
  d.setAttribute('aria-label', title);
  d.innerHTML = `<div class="help-window-head"><h2>${escapeXML(title)}</h2><button type="button" class="icon-button" data-help-close aria-label="Close" title="Close">${svg('x', 16)}</button></div><div class="help-window-body">${body}</div>`;
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).closest('[data-help-close]')) d.close();
  });
  e.root.append(d);
  d.showModal();
  return d;
}

export async function beginTutorial(e: Editor, id: string) {
  const { startTutorial } = await import('./tour-ui');
  await e.run(() => startTutorial(e, id));
}

/** Help → Hands-on Tutorials. */
export function showTutorials(e: Editor) {
  const body = `<p class="help-intro">Each tutorial opens its own sample image and walks you through a task. A card points at the control to use and moves on when you have done it; you can go back, skip a step or start over at any time.</p><div class="tutorial-grid">${TUTORIALS.map(
    (t) =>
      `<button type="button" class="tutorial-tile" data-tutorial="${t.id}"><img src="${sampleThumb(t.sample)}" alt="" width="192" height="128"><span class="tutorial-title">${escapeXML(t.title)}</span><span class="tutorial-summary">${escapeXML(t.summary)}</span><span class="tutorial-time">${svg('clock', 12)} About ${t.minutes} min</span></button>`,
  ).join('')}</div>`;
  const d = windowDialog(e, 'tutorials-window', 'Hands-on Tutorials', body);
  d.addEventListener('click', (ev) => {
    const id = (ev.target as HTMLElement).closest<HTMLElement>('[data-tutorial]')?.dataset.tutorial;
    if (!id) return;
    d.close();
    void beginTutorial(e, id);
  });
}

/** Whether an entry's "Try it" has something to run in this build. */
export function canTry(entry: WhatsNewEntry): boolean {
  const a = entry.action;
  if (!a) return false;
  if ('tutorial' in a) return !!tutorialInfo(a.tutorial);
  if ('tool' in a) return tools.has(a.tool);
  if ('panel' in a) return panels.has(a.panel);
  return a.commands.some((id) => !!findCommand(id));
}

export async function tryEntry(e: Editor, entry: WhatsNewEntry) {
  const a = entry.action;
  if (!a || !canTry(entry)) return;
  if ('tutorial' in a) return beginTutorial(e, a.tutorial);
  if (a.needs === 'document' && !e.hasDocument) await e.run(() => openSample(e, 'meadow'));
  if ('tool' in a) e.setTool(a.tool);
  else if ('panel' in a) e.dock?.show(a.panel);
  else {
    const id = a.commands.find((c) => !!findCommand(c))!;
    const c = findCommand(id)!;
    if (c.enabled && !c.enabled(e)) {
      e.message(a.hint ?? `${c.label} is not available right now.`);
      return;
    }
    await e.runCommand(id);
  }
  if (a.hint && !('commands' in a)) e.message(a.hint);
}

/** Help → What's New. */
export function showWhatsNew(e: Editor) {
  const releases = [...new Set(WHATS_NEW.map((w) => w.release))];
  const body = releases
    .map(
      (r) =>
        `<h3 class="whats-new-release">${escapeXML(r)}</h3><ul class="whats-new-list">${WHATS_NEW.filter((w) => w.release === r)
          .map(
            (w) =>
              `<li class="whats-new-item"><div><strong>${escapeXML(w.title)}</strong><p>${escapeXML(w.text)}</p></div>${canTry(w) ? `<button type="button" data-try="${w.id}" aria-label="Try ${escapeXML(w.title)}">${svg('play', 12)} Try it</button>` : ''}</li>`,
          )
          .join('')}</ul>`,
    )
    .join('');
  const d = windowDialog(e, 'whats-new-window', 'What’s New', body);
  d.addEventListener('click', (ev) => {
    const id = (ev.target as HTMLElement).closest<HTMLElement>('[data-try]')?.dataset.try;
    const entry = WHATS_NEW.find((w) => w.id === id);
    if (!entry) return;
    d.close();
    void tryEntry(e, entry);
  });
}

import { describe, expect, it } from 'vitest';
import { strings } from '../../src/lib/i18n/index.js';
import { TOPICS } from '../../src/views/help/topics.js';
import { createHelp, matchTopics, openHelp } from '../../src/views/help/index.js';

describe('help pages', () => {
  it('has every string a topic needs', () => {
    for (const topic of TOPICS) {
      for (const key of ['title', 'intro', ...Array.from({ length: topic.steps }, (_, i) => String(i + 1))]) expect(Object.hasOwn(strings, `help.${topic.id}.${key}`), `${topic.id}.${key}`).toBe(true);
      for (const link of topic.links ?? []) expect(Object.hasOwn(strings, link.key)).toBe(true);
    }
  });

  it('searches topics, accents ignored, and switches the article', () => {
    expect(matchTopics('').length).toBe(TOPICS.length);
    expect(matchTopics('settle').map((topic) => topic.id)).toEqual(['costs']);
    expect(matchTopics('nothing-like-this')).toEqual([]);
    const help = createHelp({ topic: 'plan' });
    document.body.append(help.element);
    expect(help.element.querySelector('.help-title').textContent).toBe('Planning days');
    help.element.querySelector('[data-topic="files"]').click();
    expect(help.topic).toBe('files');
    expect(help.element.querySelector('[aria-current="true"]').dataset.topic).toBe('files');
    const search = help.element.querySelector('input[type=search]');
    search.value = 'zzzz';
    search.dispatchEvent(new Event('input'));
    expect(help.element.querySelector('.help-none').hidden).toBe(false);
  });

  it('opens in a drawer with one pane at a time and closes on an in-app link', () => {
    const drawer = openHelp({ topic: 'data' });
    const links = drawer.panel.querySelectorAll('.help-link');
    expect([...links].map((link) => link.getAttribute('href'))).toEqual(['#/settings/data', '#/settings/delete']);
    expect(drawer.panel.querySelector('.help-nav').hidden).toBe(true);
    drawer.panel.querySelector('.help-back').click();
    expect(drawer.panel.querySelector('.help-article').hidden).toBe(true);
    drawer.panel.querySelector('[data-topic="data"]').click();
    drawer.panel.querySelector('.help-link').click();
    expect(drawer.panel.isConnected).toBe(false);
  });
});

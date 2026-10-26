// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDefineBullet, BULLET_CHOICES } from '../src/views/list-dialogs.js';
import { closeAllModals } from '../src/ui/modal.js';
import { el } from '../src/ui/dom.js';

describe('Define New Bullet characters', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    document.body.replaceChildren(el('div', { id: 'app' }));
  });
  afterEach(() => {
    closeAllModals();
    vi.runAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const press = (node, key) => node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  it('are one Tab stop on the chosen bullet, which the arrow keys change', () => {
    const modal = openDefineBullet({ level: { format: 'bullet', text: '○' }, apply: () => true });
    const radios = [...modal.panel.querySelectorAll('[role="radiogroup"] [role="radio"]')];
    const chosen = BULLET_CHOICES.indexOf('○');
    // It opens on the level's own bullet, not the first one.
    expect(document.activeElement).toBe(radios[chosen]);
    expect(radios.filter(radio => radio.tabIndex === 0)).toEqual([radios[chosen]]);
    press(radios[chosen], 'ArrowRight');
    expect(document.activeElement).toBe(radios[chosen + 1]);
    expect(radios[chosen + 1].getAttribute('aria-checked')).toBe('true');
    expect(radios.filter(radio => radio.tabIndex === 0)).toEqual([radios[chosen + 1]]);
    expect(modal.panel.querySelector('input[aria-label="Bullet character"]').value).toBe(BULLET_CHOICES[chosen + 1]);
    press(radios[chosen + 1], 'Home');
    expect(document.activeElement).toBe(radios[0]);
    press(radios[0], 'ArrowLeft');
    expect(document.activeElement).toBe(radios.at(-1));
    expect(radios.at(-1).getAttribute('aria-checked')).toBe('true');
  });
});

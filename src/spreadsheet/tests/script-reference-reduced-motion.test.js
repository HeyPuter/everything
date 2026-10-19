// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openScriptReference } from '../src/ui/script-gallery.js';
import { closeAllModals } from '../src/ui/modal.js';

// The script reference's object links scrolled to their section with behavior: 'smooth', which a script asks for
// outright and so overrides the stylesheet's scroll-behavior: auto, the way reduced motion is turned off for the
// rest of the app. With reduced motion asked for (by the system or in Options) the jump is now immediate.
let reduced = false;
vi.stubGlobal('matchMedia', (q) => ({ matches: reduced && /prefers-reduced-motion:\s*reduce/.test(q), addEventListener() {}, removeEventListener() {} }));
const calls = [];
Element.prototype.scrollIntoView = function scrollIntoView(opts) { calls.push(opts); };

afterEach(() => {
  closeAllModals();
  document.body.replaceChildren();
  document.documentElement.classList.remove('reduce-motion');
  reduced = false;
  calls.length = 0;
});

const clickFirstLink = () => document.querySelector('.sr-toc-link').click();

describe('Script reference links', () => {
  it('scroll smoothly by default', () => {
    openScriptReference();
    clickFirstLink();
    expect(calls.at(-1)).toMatchObject({ block: 'start', behavior: 'smooth' });
  });

  it('jump straight to the section when the system asks for reduced motion', () => {
    reduced = true;
    openScriptReference();
    clickFirstLink();
    expect(calls.at(-1)).toMatchObject({ block: 'start', behavior: 'auto' });
  });

  it('jump straight to the section when Reduce motion is on in Options', () => {
    document.documentElement.classList.add('reduce-motion');
    openScriptReference();
    clickFirstLink();
    expect(calls.at(-1)).toMatchObject({ block: 'start', behavior: 'auto' });
  });
});

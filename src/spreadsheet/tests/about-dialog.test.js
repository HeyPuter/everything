// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { openAbout } from '../src/ui/appmenu.js';
import { closeAllModals } from '../src/ui/modal.js';
import { version } from '../package.json';

afterEach(() => { closeAllModals(); document.body.replaceChildren(); });

it('names the app, its version and its maker, and describes itself to a screen reader', () => {
  openAbout();
  const panel = document.querySelector('.modal-panel.about');
  expect(panel.getAttribute('aria-label')).toBe('About Spreadsheet');
  expect(panel.querySelector('.about-icon img')).not.toBeNull();
  expect(panel.querySelector('.about-meta').textContent).toBe(`Version ${version} · by Puter Technologies Inc.`);
  expect(document.getElementById(panel.getAttribute('aria-describedby'))?.textContent).toContain('private spreadsheet');
  expect(panel.querySelector('.about-legal').textContent).toBe(`© ${new Date().getFullYear()} Puter Technologies Inc. All rights reserved.`);
});

it('links Puter\'s pages and every bundled license, each in a new tab', () => {
  openAbout();
  const links = [...document.querySelectorAll('.about-links a')];
  expect(links.map((a) => a.textContent)).toEqual(['Website', 'Privacy', 'Terms']);
  expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://puter.com', 'https://puter.com/privacy', 'https://puter.com/terms']);
  const credits = [...document.querySelectorAll('.about-credit')];
  expect(credits.map((a) => a.querySelector('.about-credit-name').textContent)).toEqual([
    'SheetJS Community Edition', 'xmldom', 'Apache POI', '.NET Runtime', 'Unicode Character Database',
    'noble-hashes', 'SCOWL and the Hunspell English dictionaries', 'Lucide and Feather', 'Open Sans', 'Carlito', 'Caladea',
  ]);
  for (const a of [...links, ...credits]) {
    expect(a.target).toBe('_blank');
    expect(a.rel).toBe('noopener');
    expect(a.getAttribute('href')).toBeTruthy();
  }
  // The spelling checker's word lists ship with the app (src/vendor/words-en.js): their license is credited, and its
  // file is emitted beside the app with the others, which nothing did while nothing linked it.
  expect(credits.find((a) => /SCOWL/.test(a.textContent)).getAttribute('href')).toMatch(/SCOWL-LICENSE/);
  // Folded away until asked for.
  expect(document.querySelector('.about-credits').open).toBe(false);
});

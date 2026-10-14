// About Music Studio: version, license, source and credits.

import { h } from '../lib/dom.js';
import { openDialog } from '../ui/dialog.js';
import { appIcon } from '../ui/icons.js';
import { REPO_URL } from '../ui/toolbar.js';
import { version } from '../../package.json';

export async function openAbout() {
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  const logo = appIcon(48);
  logo.addEventListener('error', () => logo.remove());
  await openDialog({
    title: 'About Music Studio',
    className: 'dlg-about',
    body: h(
      'div.about',
      h('div.about-head', logo, h('div', h('h3.about-name', 'Music Studio'), h('div.faint', `Version ${version} (alpha)`))),
      h('p', 'A pattern-based music workstation in your browser: program beats in the channel rack, write melodies in the piano roll, arrange in the playlist and mix with studio effects. Every built-in sound is synthesized; no recordings are bundled.'),
      h('p', h('strong', 'Free and open source (MIT). '), 'Read the code, report issues and contribute on ', link(REPO_URL, 'GitHub'), '.'),
      h('p.about-alpha', 'This is an early alpha. Features will change and projects could be lost, so keep copies of important work (File > Save to your device).'),
      h('h3.dlg-section', 'Credits'),
      h('ul.about-credits', h('li', link('https://lucide.dev', 'Lucide'), ' icons (ISC license)'), h('li', 'Cloud storage and sign-in by ', link('https://developer.puter.com', 'Puter'))),
    ),
    buttons: [{ label: 'Close', value: true, primary: true }],
  });
}

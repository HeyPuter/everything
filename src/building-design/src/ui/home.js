/**
 * Home screen: start a project from a template, open the sample, or reopen
 * a recent project.
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { recentFiles, openRecent } from '../io/files.js';

export function renderHome(app, el) {
  clear(el);
  const card = (ic, title, sub, onClick) => h('button.home-card', { type: 'button', onClick }, icon(ic, 26), h('strong', title), h('small', sub));
  const recent = recentFiles();
  el.append(
    h(
      'div.home',
      h('div', h('h1', 'Building Design'), h('p.home-sub', 'Model buildings with walls, doors, windows, floors, roofs and rooms, then work in plans, sections, elevations, 3D, schedules and sheets.')),
      h(
        'section',
        h('h2', 'Start'),
        h(
          'div.home-cards',
          card('file-plus', 'Metric project', 'Millimetres, 1 : 100 plans', () => app.newProject('metric')),
          card('file-plus', 'Imperial project', 'Feet and inches, 1/8" plans', () => app.newProject('imperial')),
          card('house', 'Sample house', 'A small furnished house to explore', () => app.openSample()),
          card('folder-open', 'Open', 'From Puter or this device', () => app.run('open')),
        ),
      ),
      h(
        'section',
        h('h2', 'Recent projects'),
        h(
          'ul.home-recent',
          recent.map((r) =>
            h(
              'li',
              h('button.file-item', { type: 'button', onClick: () => openRecent(app, r) }, icon(r.source === 'cloud' ? 'cloud' : 'device', 16), h('span.file-name', r.name), h('span.file-meta', new Date(r.at).toLocaleDateString())),
            ),
          ),
        ),
      ),
      app.doc
        ? h('section', h('button.btn', { type: 'button', onClick: () => app.openView(app.doc.all('plan')[0]?.id || app.doc.all('view3d')[0]?.id) }, icon('chevron-left', 15), `Back to ${app.file?.name || app.doc.project.name}`))
        : null,
    ),
  );
}

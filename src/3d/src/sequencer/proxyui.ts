// Proxy & Cache tab: the active movie strip's proxy settings and the build state.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { splitRow, num, oid } from '../ui/props';
import { panel, checkbox, opButton } from '../ui/widgets';
import { activeStrip, hasEditor } from './context';
import { PROXY_SIZES, builtSizes, defaultProxy, isBuilding } from './proxy';

export function proxyPanel(previewSize: string): Child {
  const s = hasEditor() ? activeStrip() : null;
  const set = (label: string) => (app.pushUndo(label), app.changed('doc'));
  return panel('seq-strip-proxy', 'Strip Proxy', () => {
    if (!s || s.type !== 'MOVIE') return h('div', { class: 'seq-sb-note' }, 'Proxies are reduced copies of movie strips for a faster preview. Select a movie strip to set them up.');
    const p = (s.proxy ??= defaultProxy());
    const built = builtSizes(s);
    const using = previewSize.startsWith('PROXY_') && built.includes(Number(previewSize.slice(6)) as never);
    return [
      splitRow(
        '',
        checkbox(`seq-useproxy-${oid(s)}`, 'Use Proxies', !!s.use_proxy, (v) => ((s.use_proxy = v), set(v ? 'Use Proxies' : 'Stop Using Proxies'))),
      ),
      s.use_proxy
        ? [
            splitRow(
              'Resolutions',
              h(
                'div',
                { class: 'seq-proxy-sizes' },
                PROXY_SIZES.map((k) => checkbox(`seq-px${k}-${oid(s)}`, `${k}%`, !!p[`build_${k}` as const], (v) => ((p[`build_${k}` as const] = v), set('Proxy Size')))),
              ),
            ),
            num(p, 'quality', 'Quality', { int: true, min: 1, max: 100, slider: true }),
            splitRow(
              '',
              checkbox(`seq-pxow-${oid(s)}`, 'Overwrite', p.use_overwrite, (v) => ((p.use_overwrite = v), set('Proxy Overwrite'))),
            ),
            splitRow('Built', h('span', { class: 'seq-src' }, built.length ? built.map((k) => `${k}%`).join(', ') : 'None yet')),
            splitRow('', opButton('sequencer.rebuild_proxy', isBuilding() ? 'Building…' : 'Rebuild', {}, { icon: 'file_refresh', tip: 'Build the proxies of the selected movie strips (Esc stops)' })),
            h('div', { class: 'seq-sb-note' }, using ? 'The preview is using these proxies.' : 'Set View ▸ Preview Size to a built proxy size to preview with proxies.'),
          ]
        : null,
    ];
  });
}

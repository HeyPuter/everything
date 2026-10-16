// Sidebar ▸ Footage ▸ Proxy panel of the clip editor.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { panel, checkbox, opButton, enumMenu } from '../ui/widgets';
import { num, splitRow } from '../ui/props';
import { builtProxySizes, proxySettings, type ProxyRenderSize } from './proxy';
import type { MovieClipData } from './types';
import type { ClipEditor } from './editor';

export function proxyPanel(ed: ClipEditor, c: MovieClipData): Child {
  const set = proxySettings(c);
  const built = builtProxySizes(c);
  const size = (s: 25 | 50 | 75 | 100) =>
    checkbox(`clip-proxy-${s}`, `${s}%`, set[`build_${s}`], (v) => {
      set[`build_${s}`] = v;
      app.pushUndo('Proxy Size');
      app.changed('doc');
    });
  return panel(
    'clip-n-proxy',
    'Proxy',
    () => [
      splitRow('Build', h('div', { class: 'clip-proxy-sizes' }, size(25), size(50), size(75), size(100))),
      num(set, 'quality', 'Quality', { int: true, min: 1, max: 100, unit: 'percentage', tip: 'JPEG quality of the proxy frames' }),
      h('div', { class: 'btn-row' }, opButton('clip.rebuild_proxy', 'Build Proxy'), opButton('clip.delete_proxy', 'Delete')),
      splitRow(
        'Display',
        enumMenu(
          'clip-proxy-render',
          [
            { value: 'FULL', label: 'Full Size' },
            ...([25, 50, 75, 100] as const).map((s) => ({ value: `PROXY_${s}`, label: `${s}% Proxy${built.includes(s) ? '' : ' (not built)'}` })),
          ],
          ed.proxyRenderSize,
          (v) => {
            ed.proxyRenderSize = v as ProxyRenderSize;
            ed.redrawAll();
          },
          { tip: 'Size the footage is shown at in this editor (a built proxy decodes faster)' },
        ),
      ),
      h('div', { class: 'clip-info' }, built.length ? `Built: ${built.map((s) => `${s}%`).join(', ')}. Frames are exact (decoded by frame number), so no timecode index is needed.` : 'No proxies built in this session.'),
    ],
    {
      closed: !c.use_proxy,
      header: h('span', { class: 'panel-check', onpointerdown: (e: PointerEvent) => e.stopPropagation() }, checkbox('clip-use-proxy', '', !!c.use_proxy, (v) => ((c.use_proxy = v), app.pushUndo(v ? 'Use Proxy' : 'Disable Proxy'), app.changed('doc')), { tip: 'Use Proxy\nShow the footage from reduced-size proxies' })),
    },
  );
}

/**
 * Built-in graphic style libraries (original designs). Built on first use:
 * some effects come from feature modules that register after this one, and
 * styles skip any effect type that is not available.
 */
import { createEffect } from './effects-model.js';

const solid = (color) => ({ type: 'solid', color });
const lin = (angle, ...stops) => ({ type: 'linear', angle, stops: stops.map(([offset, color]) => ({ offset, color, opacity: 1 })) });
const rad = (...stops) => ({ type: 'radial', angle: 0, stops: stops.map(([offset, color]) => ({ offset, color, opacity: 1 })) });
const fx = (...list) => list.map(([type, params]) => createEffect(type, params)).filter(Boolean);
const style = (id, name, s) => ({ id, name, style: { fill: null, stroke: null, strokeWidth: 0, opacity: 1, blendMode: 'normal', effects: [], ...s } });

function build() {
  return [
    {
      id: 'shadows-glows',
      name: 'Shadows and Glows',
      styles: [
        style('sg-lift', 'Lifted Card', { fill: solid('#ffffff'), effects: fx(['dropShadow', { x: 0, y: 4, blur: 10, opacity: 0.25 }]) }),
        style('sg-hard', 'Hard Offset Shadow', { fill: solid('#ffd84d'), stroke: solid('#1d1d1f'), strokeWidth: 2, effects: fx(['dropShadow', { x: 6, y: 6, blur: 0, opacity: 1, mode: 'normal', color: '#1d1d1f' }]) }),
        style('sg-ember', 'Ember Glow', { fill: solid('#ff7a2f'), effects: fx(['outerGlow', { color: '#ffb057', blur: 10, opacity: 0.9 }], ['innerGlow', { color: '#fff1c2', blur: 6, opacity: 0.6, source: 'center' }]) }),
        style('sg-ice', 'Ice Glow', { fill: solid('#d9f4ff'), stroke: solid('#7fd3ff'), strokeWidth: 1, effects: fx(['outerGlow', { color: '#7fd3ff', blur: 8, opacity: 0.8 }]) }),
        style('sg-inset', 'Inset Panel', { fill: solid('#e9ecf1'), effects: fx(['innerGlow', { color: '#9aa3b2', blur: 6, opacity: 0.7, mode: 'multiply' }]) }),
        style('sg-halo', 'Soft Halo', { fill: solid('#fff6d6'), effects: fx(['feather', { radius: 6 }], ['outerGlow', { color: '#ffe38a', blur: 14, opacity: 0.7 }]) }),
      ],
    },
    {
      id: 'buttons',
      name: 'Buttons',
      styles: [
        style('bt-pill-blue', 'Pill Blue', { fill: lin(90, [0, '#5aa2ff'], [1, '#2463d6']), effects: fx(['roundCorners', { radius: 40 }], ['dropShadow', { x: 0, y: 2, blur: 3, opacity: 0.35 }]) }),
        style('bt-mint', 'Mint Rounded', { fill: solid('#3ecf9a'), effects: fx(['roundCorners', { radius: 8 }], ['innerGlow', { color: '#ffffff', blur: 4, opacity: 0.4 }]) }),
        style('bt-ghost', 'Ghost Outline', { stroke: solid('#3b4252'), strokeWidth: 2, effects: fx(['roundCorners', { radius: 6 }]) }),
        style('bt-gel', 'Glossy Gel', { fill: rad([0, '#ffb3d1'], [0.6, '#ff4f9a'], [1, '#b8125c']), effects: fx(['roundCorners', { radius: 14 }], ['dropShadow', { x: 0, y: 3, blur: 5, opacity: 0.4 }]) }),
        style('bt-slate', 'Slate Raised', { fill: lin(90, [0, '#5b6577'], [1, '#353c48']), stroke: solid('#262b33'), strokeWidth: 1, effects: fx(['roundCorners', { radius: 4 }], ['dropShadow', { x: 0, y: 2, blur: 2, opacity: 0.5 }]) }),
      ],
    },
    {
      id: 'sketchy',
      name: 'Hand Drawn',
      styles: [
        style('hd-pencil', 'Pencil Line', { stroke: solid('#3a3a3a'), strokeWidth: 1.5, strokeCap: 'round', strokeJoin: 'round', effects: fx(['roughen', { size: 2, relative: false, detail: 12, smooth: true }]) }),
        style('hd-marker', 'Marker Fill', { fill: solid('#ffd166'), stroke: solid('#222222'), strokeWidth: 2.5, strokeCap: 'round', strokeJoin: 'round', effects: fx(['tweak', { h: 0.02, v: 0.02 }]) }),
        style('hd-zig', 'Zigzag Edge', { fill: solid('#9bdeac'), stroke: solid('#2e7d4f'), strokeWidth: 1, effects: fx(['zigzag', { size: 3, ridges: 6, smooth: true }]) }),
        style('hd-scribble', 'Scribble Fill', { fill: solid('#ef476f'), effects: fx(['scribble', {}]) }),
        style('hd-wobble', 'Wobbly Outline', { stroke: solid('#118ab2'), strokeWidth: 3, strokeCap: 'round', strokeJoin: 'round', effects: fx(['roughen', { size: 4, relative: false, detail: 4, smooth: true }]) }),
      ],
    },
    {
      id: 'outlines',
      name: 'Outlines',
      styles: [
        style('ol-double', 'Double Outline', { fill: solid('#ffffff'), stroke: solid('#1f2937'), strokeWidth: 1, effects: fx(['offsetPath', { offset: 4, joins: 'round' }]) }),
        style('ol-dash', 'Stitched', { stroke: solid('#8d5a2b'), strokeWidth: 1.5, dash: [4, 3], dashAlign: 'corners', strokeCap: 'round' }),
        style('ol-dotted', 'Dotted', { stroke: solid('#334155'), strokeWidth: 2, dash: [0, 5], strokeCap: 'round' }),
        style('ol-neon-pink', 'Neon Pink', { stroke: solid('#ff4fd8'), strokeWidth: 3, strokeCap: 'round', strokeJoin: 'round', effects: fx(['outerGlow', { color: '#ff4fd8', blur: 8, opacity: 0.9, mode: 'normal' }]) }),
        style('ol-heavy', 'Heavy Rule', { stroke: solid('#111111'), strokeWidth: 6, strokeJoin: 'round' }),
      ],
    },
  ];
}

let cache = null;
/** [{ id, name, styles: [{ id, name, style }] }] */
export function graphicStyleLibraries() {
  if (!cache) cache = build();
  return cache;
}

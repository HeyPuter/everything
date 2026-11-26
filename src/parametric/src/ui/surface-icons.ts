// Icons of the surface modeling commands (24px grid, the CAD icon style of
// icons.ts: "a" accent fill, "s" soft fill). A wavy sheet stands for a surface.

type IconNode = [string, Record<string, string | number>][];

const P = (d: string, cls?: string): [string, Record<string, string>] => (cls ? ['path', { d, class: cls }] : ['path', { d }]);
const DASH = (d: string, dash = '3 2'): [string, Record<string, string>] => ['path', { d, 'stroke-dasharray': dash }];

export const SURFACE_ICONS: Record<string, IconNode> = {
  surfaceExtrude: [P('M3 18c3-2.5 6-2.5 9 0s6 2.5 9 0V11c-3 2.5-6 2.5-9 0s-6-2.5-9 0z', 'a'), P('M3 18c3-2.5 6-2.5 9 0s6 2.5 9 0', 'thick-a'), P('M3 18V11c3-2.5 6-2.5 9 0s6 2.5 9 0v7'), P('M12 2v7M9.5 4.5L12 2l2.5 2.5')],
  surfaceRevolve: [DASH('M4 3v18', '4 2 1 2'), P('M8 5c5 3 5 11 0 14h8c5-3 5-11 0-14z', 'a'), P('M8 5c5 3 5 11 0 14M16 5c5 3 5 11 0 14'), P('M8 5h8M8 19h8', 'thin')],
  surfaceSweep: [P('M3 20c5 0 6-12 15-12', 'thick-a'), P('M3 15c5 0 6-12 15-12'), P('M3 20c5 0 6-12 15-12'), P('M3 15v5M18 3v5')],
  surfaceLoft: [P('M3 19c3-2 6-2 9 0M11 6c3-2 6-2 9 0', 'thick-a'), P('M3 19L11 6M12 19l8-13', 'thin'), P('M3 19c3-2 6-2 9 0M11 6c3-2 6-2 9 0')],
  surfacePlanar: [P('M3 17l5-10h13l-5 10z', 'a'), P('M3 17l5-10h13l-5 10z'), P('M7 13h9', 'thin')],
  surfaceOffset: [P('M3 20c3-2.5 6-2.5 9 0s6 2.5 9 0', 'thick-a'), P('M3 20c3-2.5 6-2.5 9 0s6 2.5 9 0'), DASH('M3 10c3-2.5 6-2.5 9 0s6 2.5 9 0', '2.5 2'), P('M12 13.5v5M10.5 15l1.5-1.5 1.5 1.5', 'thin')],
  surfaceFill: [P('M5 7c4-3 10-3 14 0 2 4 1 9-3 11-4 2-9 1-11-3-1.5-3-1.5-6 0-8z', 'a'), P('M5 7c4-3 10-3 14 0 2 4 1 9-3 11-4 2-9 1-11-3-1.5-3-1.5-6 0-8z', 'thick'), P('M8 12c3-1.5 5-1.5 8 0', 'thin')],
  surfaceTrim: [P('M3 17c3-2.5 6-2.5 9 0V9C9 6.5 6 6.5 3 9z', 'a'), P('M3 17c3-2.5 6-2.5 9 0V9C9 6.5 6 6.5 3 9z'), DASH('M12 17c3 2.5 6 2.5 9 0V9c-3 2.5-6 2.5-9 0', '2 2'), P('M12 3v18', 'thin')],
  surfaceExtend: [P('M3 17c3-2.5 6-2.5 9 0V9C9 6.5 6 6.5 3 9z', 'a'), P('M3 17c3-2.5 6-2.5 9 0V9C9 6.5 6 6.5 3 9z'), DASH('M12 17c2 1.6 4 2.2 6 1.5M12 9c2 1.6 4 2.2 6 1.5', '2 2'), P('M16 13h5M19 11l2 2-2 2', 'thin')],
  surfaceKnit: [P('M3 17c2-2 5-2 8 0V8C8 6 5 6 3 8z', 'a'), P('M13 17c3 2 6 2 8 0V8c-2 2-5 2-8 0z', 's'), P('M3 17c2-2 5-2 8 0V8C8 6 5 6 3 8zM13 17c3 2 6 2 8 0V8c-2 2-5 2-8 0z'), P('M10 10.5h4M10 13.5h4M10 16.5h4', 'thin')],
  thicken: [P('M3 14c3-2.5 6-2.5 9 0s6 2.5 9 0V9c-3 2.5-6 2.5-9 0S6 6.5 3 9z', 'a'), P('M3 14c3-2.5 6-2.5 9 0s6 2.5 9 0v4c-3 2.5-6 2.5-9 0s-6-2.5-9 0z', 's'), P('M3 9c3-2.5 6-2.5 9 0s6 2.5 9 0v9c-3 2.5-6 2.5-9 0s-6-2.5-9 0z'), P('M3 14c3-2.5 6-2.5 9 0s6 2.5 9 0', 'thin')],
  thickenCut: [P('M3 8l9-4 9 4v10l-9 4-9-4z', 's'), P('M3 8l9-4 9 4v10l-9 4-9-4z'), P('M7 11c2-1.5 4-1.5 5 0s3 1.5 5 0v4c-2 1.5-4 1.5-5 0s-3-1.5-5 0z', 'a'), P('M7 11c2-1.5 4-1.5 5 0s3 1.5 5 0v4c-2 1.5-4 1.5-5 0s-3-1.5-5 0z')],
  surfaceCut: [P('M4 13l8-4 8 4v6l-8 4-8-4z', 's'), P('M4 13v6l8 4 8-4v-6'), DASH('M4 13l8 4 8-4M12 17v6', '2 1.5'), P('M2 12c3-3 7-3 10-1s7 2 10-1', 'thick-a'), P('M12 2v6M10 6l2 2 2-2', 'thin')],
  deleteFace: [DASH('M4 8l8-4 8 4-8 4z', '2 2'), P('M4 8v9l8 4 8-4V8', 's'), P('M4 8v9l8 4 8-4V8M12 12v9'), P('M10 6.5l4 3M14 6.5l-4 3', 'thin')],
};

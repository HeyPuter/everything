// Font data-blocks: open a font file (TrueType / OpenType / WOFF) for a text object's regular,
// bold, italic or bold-italic style, unlink it, and pack it into the document.
import { app, registerOperators } from '../../app/app';
import { uid } from '../../data/defaults';
import type { CurveData, VectorFontData } from '../../data/types';
import { pickFile } from '../../io/native';
import { parseFontBytes, setFontTable } from '../../io/fonts';
import { activeText } from './text';

setFontTable(() => app.doc?.fonts);

export const FONT_SLOTS: [string, string, keyof CurveData][] = [
  ['REGULAR', 'Regular', 'font'],
  ['BOLD', 'Bold', 'font_bold'],
  ['ITALIC', 'Italic', 'font_italic'],
  ['BOLD_ITALIC', 'Bold & Italic', 'font_bold_italic'],
];

export const slotKey = (slot: string) => (FONT_SLOTS.find((s) => s[0] === slot)?.[2] ?? 'font') as 'font' | 'font_bold' | 'font_italic' | 'font_bold_italic';

/** Bytes read by the file dialog, by token (so the redo panel can re-run the operator). */
const pending = new Map<string, { name: string; bytes: Uint8Array }>();

function uniqueFontName(base: string) {
  const names = new Set(Object.values(app.doc.fonts ?? {}).map((f) => f.name));
  if (!names.has(base)) return base;
  for (let i = 1; ; i++) {
    const n = `${base}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

registerOperators([
  {
    idname: 'font.open',
    label: 'Open Font',
    description: 'Load a font file (TrueType, OpenType or WOFF) and use it for the active text object',
    props: [
      { id: 'slot', label: 'Style', type: 'enum', default: 'REGULAR', items: FONT_SLOTS.map(([v, l]) => [v, l] as [string, string]) },
      { id: 'token', label: 'File', type: 'string', default: '', hidden: true },
    ],
    poll: () => !!activeText(),
    invoke: (_c, p) => {
      void pickFile('.ttf,.otf,.woff,font/ttf,font/otf,font/woff').then(async (f) => {
        if (!f) return;
        if (f.size > 50_000_000) {
          app.report('ERROR', 'Font file too large');
          return;
        }
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (!parseFontBytes(bytes)) {
          app.report('ERROR', `Cannot read font: ${f.name} (use TrueType, OpenType or WOFF)`);
          return;
        }
        const token = uid('fontfile');
        pending.set(token, { name: f.name, bytes });
        app.run('font.open', { slot: p.slot, token }, { invoke: false });
      });
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const file = pending.get(p.token as string);
      const t = activeText();
      if (!file || !t) return 'CANCELLED';
      const fonts = (ctx.doc.fonts ??= {});
      // reuse a data-block holding the same file
      let fd = Object.values(fonts).find((x) => x.filepath === file.name && x.bytes?.length === file.bytes.length);
      if (!fd) {
        fd = { id: uid('vf'), name: uniqueFontName(file.name.replace(/\.(ttf|otf|woff)$/i, '')), filepath: file.name, bytes: file.bytes } satisfies VectorFontData;
        fonts[fd.id] = fd;
      }
      t.cu[slotKey(p.slot as string)] = fd.id;
      app.changed('doc', 'geometry');
    },
  },
  {
    idname: 'font.unlink',
    label: 'Unlink Font',
    description: 'Go back to the built-in font for a style of the active text object',
    props: [{ id: 'slot', label: 'Style', type: 'enum', default: 'REGULAR', items: FONT_SLOTS.map(([v, l]) => [v, l] as [string, string]) }],
    poll: () => !!activeText(),
    exec: (_c, p) => {
      const t = activeText()!;
      const k = slotKey(p.slot as string);
      if (!t.cu[k]) return 'CANCELLED';
      t.cu[k] = null;
      app.changed('doc', 'geometry');
    },
  },
]);

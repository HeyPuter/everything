// CJK paragraph basics: kinsoku line-break rules, mojikumi spacing and
// burasagari.
import { describe, it, expect } from 'vitest';
import { createText } from '../src/model/nodes.js';
import { layoutText } from '../src/model/text-layout.js';
import { kinsokuAllows, applyMojikumi, punctClass, hangsOut } from '../src/model/cjk.js';
import { bootAppWithFeatures } from './helpers.js';
import { resolveItems } from '../src/ui/menubar.js';
import { paraAt } from '../src/model/text-runs.js';

// Without a canvas every CJK character measures 5.5pt at 10pt.
const CHAR = { fontFamily: 'Approx Sans', fontWeight: 400, fontStyle: 'normal', fontSize: 10 };
const area = (t, width, para = {}) => createText(t, 0, 0, { kind: 'area', width, height: 300, char: { ...createText('', 0, 0).char, ...CHAR }, para: { ...createText('', 0, 0).para, composer: 'single', ...para } });
const lines = (lay) => lay.lines.map((l) => l.text);

describe('kinsoku', () => {
  it('knows which characters may not start or end a line', () => {
    expect(kinsokuAllows('none', 'あ', '。')).toBe(true);
    expect(kinsokuAllows('soft', 'あ', '。')).toBe(false);
    expect(kinsokuAllows('soft', '「', 'あ')).toBe(false);
    expect(kinsokuAllows('soft', 'あ', 'ょ')).toBe(true);
    expect(kinsokuAllows('hard', 'あ', 'ょ')).toBe(false);
    expect(kinsokuAllows('hard', 'あ', 'ー')).toBe(false);
    expect(kinsokuAllows('soft', '—', '—')).toBe(false);
  });

  it('keeps a stop off the start of a line and an opening bracket off its end', () => {
    const t = 'あいうえお。かきくけこ';
    expect(lines(layoutText(area(t, 28)))[1][0]).toBe('。');
    for (const composer of ['single', 'every']) {
      const soft = lines(layoutText(area(t, 28, { kinsoku: 'soft', composer })));
      expect(soft.every((l) => l[0] !== '。'), composer).toBe(true);
      expect(soft[0], composer).toBe('あいうえ');
    }
    const open = lines(layoutText(area('あいうえ「かきくけこ」', 28, { kinsoku: 'soft' })));
    expect(open.every((l) => !l.endsWith('「'))).toBe(true);
    const hard = lines(layoutText(area('あいうえおょかきくけ', 28, { kinsoku: 'hard' })));
    expect(hard.every((l) => l[0] !== 'ょ')).toBe(true);
    expect(lines(layoutText(area('あいうえおょかきくけ', 28, { kinsoku: 'soft' })))[1][0]).toBe('ょ');
  });
});

describe('burasagari', () => {
  it('hangs a comma or stop past the margin instead of moving it down', () => {
    const t = 'あいうえお。かきくけこ';
    const lay = layoutText(area(t, 28, { kinsoku: 'soft', burasagari: 'standard' }));
    expect(lines(lay)[0]).toBe('あいうえお。');
    // The hanging stop is outside the frame; the rest of the line fills it.
    const l0 = lay.lines[0];
    expect(l0.xs[6] - l0.xs[0]).toBeGreaterThan(28);
    expect(hangsOut('、')).toBe(true);
    expect(hangsOut('」')).toBe(false);
  });

  it('forced burasagari hangs a final stop even when it fits', () => {
    const t = 'あいう。\nかき';
    const right = layoutText(area(t, 40, { align: 'right', burasagari: 'forced' }));
    const l0 = right.lines[0];
    // Right aligned: the letters before the stop end at the margin.
    expect(l0.xs[3]).toBeCloseTo(40);
    const plain = layoutText(area(t, 40, { align: 'right' }));
    expect(plain.lines[0].xs[4]).toBeCloseTo(40);
  });
});

describe('mojikumi', () => {
  it('halves full-width punctuation that meets more punctuation and spaces Roman text', () => {
    expect(punctClass('「')).toBe('open');
    expect(punctClass('」')).toBe('close');
    expect(punctClass('。')).toBe('stop');
    const text = '」「あA';
    const adv = [10, 10, 10, 6];
    const kern = [0, 0, 0, 0];
    expect(applyMojikumi(text, 0, 4, adv, kern, [10, 10, 10, 10])).toBe(true);
    expect(adv[0]).toBe(5);
    expect(kern[1]).toBe(-5);
    expect(kern[3]).toBe(2.5);
    const none = layoutText(area('」「あ', 100));
    const basic = layoutText(area('」「あ', 100, { mojikumi: 'basic' }));
    const w = (lay) => lay.lines[0].xs[3] - lay.lines[0].xs[0];
    expect(w(basic)).toBeLessThan(w(none));
  });
});

describe('East Asian paragraph options in the panel', () => {
  it('sets kinsoku, mojikumi and burasagari from the panel and its menu', async () => {
    const app = await bootAppWithFeatures();
    if (!app.editor) app.newDocument();
    const doc = app.editor.doc;
    const t = createText('あいう。', 0, 0, { kind: 'area', width: 100, height: 100 });
    doc.transact('Add', () => doc.insert(t, app.editor.targetLayer().id));
    app.editor.select([t.id]);
    app.openPanel('paragraph');
    const p = app.dock.panels.get('paragraph');
    p.ensureBuilt();
    p.update();
    const kin = p.el.querySelector('select[aria-label^="Kinsoku"]');
    expect(kin.closest('.ty-row').hidden).toBe(true);
    app.commands.run('type.showEastAsian');
    p.update();
    expect(kin.closest('.ty-row').hidden).toBe(false);
    kin.value = 'hard';
    kin.dispatchEvent(new Event('change'));
    expect(paraAt(doc.get(t.id), 0).kinsoku).toBe('hard');
    const items = resolveItems(app, p.menu());
    const bura = items.find((i) => i.label === 'Burasagari');
    expect(bura.items.map((i) => i.label)).toEqual(['None', 'Standard', 'Forced']);
    await app.commands.run('type.burasagari.forced');
    expect(paraAt(doc.get(t.id), 0).burasagari).toBe('forced');
    await app.commands.run('type.mojikumi.basic');
    expect(paraAt(doc.get(t.id), 0).mojikumi).toBe('basic');
    expect(app.commands.get('type.mojikumi.basic').checked(app)).toBe(true);
  });
});

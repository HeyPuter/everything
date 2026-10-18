import { expect, it } from 'vitest';
import { normalizeSmartArt, setText, smartArtSvg, textWidth } from '../src/core/smartart.js';

// A SmartArt shape holding a long text without spaces (Chinese or Japanese, a URL, a code) took up to a
// second to draw, and the layout gallery draws every layout: the word was cut to fit by shortening it one
// character at a time, measuring the whole remainder each time. It is now cut in one pass.
const cjk = '这是一个很长的中文句子没有任何空格用于测试文字换行的性能问题'.repeat(34).slice(0, 1000);

it('draws a shape holding a long unspaced text quickly', () => {
  const started = performance.now();
  for (const [layout, w, h] of [['basicProcess', 480, 270], ['continuousArrow', 480, 270], ['blockList', 60, 60]]) {
    const model = normalizeSmartArt({ layout, items: [{ text: cjk, level: 0 }, { text: 'a'.repeat(1000), level: 0 }, { text: 'c', level: 0 }] });
    expect(smartArtSvg(model, w, h, { placeholders: true })).toContain('<svg');
  }
  expect(performance.now() - started).toBeLessThan(400);
});

it('cuts a long word where it did before', () => {
  // The former cut, one character shorter at a time, as the reference.
  const reference = (word, width, size) => {
    const lines = [];
    while (textWidth(word, size) > width && word.length > 1) {
      let k = word.length - 1;
      while (k > 1 && textWidth(word.slice(0, k), size) > width) k--;
      lines.push(word.slice(0, k));
      word = word.slice(k);
    }
    return [...lines, word];
  };
  for (const word of ['Supercalifragilisticexpialidocious', 'https://example.com/a/very/long/path?with=query', cjk.slice(0, 60), 'MiXeD中文Text123']) {
    for (const width of [3, 20, 47.5, 90]) for (const size of [6, 11, 14]) {
      const { lines } = setText([{ text: word, level: 0 }], { x: 0, y: 0, w: width, h: 1000 }, size);
      expect(lines.map(l => l.text)).toEqual(reference(word, width, size));
    }
  }
});

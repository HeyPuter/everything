import { describe, it, expect } from 'vitest';
import {
  cleanHtml, hasFormatting, htmlToText, textToHtml, messageHtml,
  FONTS, SIZES, COLORS,
} from '../src/lib/richtext.js';

const bodyOf = (document_) => /<body>([\s\S]*)<\/body>/.exec(document_)?.[1] ?? '';

describe('cleanHtml: the editor vocabulary', () => {
  it('keeps the marks the toolbar makes', () => {
    const html = '<div><b>bold</b> <i>italic</i> <u>under</u> <s>struck</s></div>';
    expect(cleanHtml(html)).toBe(html);
  });

  it('keeps a styled span, a list, a quote and a link', () => {
    expect(cleanHtml('<span style="color: #c5221f">red</span>'))
      .toBe('<span style="color: #c5221f">red</span>');
    expect(cleanHtml('<ul><li>one</li></ul>')).toBe('<ul><li>one</li></ul>');
    expect(cleanHtml('<blockquote><div>said</div></blockquote>'))
      .toBe('<blockquote><div>said</div></blockquote>');
    expect(cleanHtml('<a href="https://example.com">site</a>'))
      .toBe('<a href="https://example.com">site</a>');
  });

  it('drops a script and everything in it', () => {
    expect(cleanHtml('<div>before</div><script>alert(1)</script><div>after</div>'))
      .toBe('<div>before</div><div>after</div>');
  });

  it('drops a pasted style element rather than letting it restyle the app', () => {
    expect(cleanHtml('<style>.rte-body{display:none}</style><div>hi</div>'))
      .toBe('<div>hi</div>');
  });

  it('drops every event handler and every other attribute', () => {
    expect(cleanHtml('<div onclick="alert(1)" id="x" class="y" dir="rtl">t</div>'))
      .toBe('<div>t</div>');
    expect(cleanHtml('<a href="https://a.test" onmouseover="x" target="_top">a</a>'))
      .toBe('<a href="https://a.test">a</a>');
  });

  it('unwraps an inline element it does not know, keeping the words', () => {
    expect(cleanHtml('<abbr title="t">HTML</abbr>')).toBe('HTML');
    expect(cleanHtml('<font face="Wingdings" size="7">x</font>')).toBe('x');
  });

  it('keeps a block it has no control for as a block', () => {
    // Unwrapping these ran the heading straight into the paragraph under it.
    expect(cleanHtml('<h2>Q3</h2><p>Up 4%</p>')).toBe('<div>Q3</div><p>Up 4%</p>');
    expect(htmlToText(cleanHtml('<h2>Q3</h2><p>Up 4%</p>'))).toBe('Q3\nUp 4%');
    // A pasted table loses its layout and keeps a line per cell.
    expect(htmlToText(cleanHtml('<table><tr><td>a</td><td>b</td></tr></table>')))
      .toBe('a\nb');
  });

  it('drops a declaration that only says "do what you would anyway"', () => {
    // Chrome's own insertHTML sprinkles these over every paste.
    expect(cleanHtml('<span style="font-family: inherit; font-weight: inherit">x</span>'))
      .toBe('x');
    expect(hasFormatting(cleanHtml('<div><span style="font-size: inherit">x</span></div>')))
      .toBe(false);
  });

  it('unwraps a link that points somewhere a message may not', () => {
    expect(cleanHtml('<a href="javascript:alert(1)">tap</a>')).toBe('tap');
    expect(cleanHtml('<a href="data:text/html,<b>x">tap</a>')).toBe('tap');
    expect(cleanHtml('<a href="/relative">tap</a>')).toBe('tap');
    expect(cleanHtml('<a href="mailto:a@b.test">write</a>'))
      .toBe('<a href="mailto:a@b.test">write</a>');
  });

  it('sees through whitespace smuggled into a scheme', () => {
    expect(cleanHtml('<a href="java\tscript:alert(1)">tap</a>')).toBe('tap');
    expect(cleanHtml('<a href="  JavaScript:alert(1)">tap</a>')).toBe('tap');
  });

  it('unwraps a span once its style has been thrown away', () => {
    expect(cleanHtml('<span style="position: fixed; inset: 0">x</span>')).toBe('x');
    expect(cleanHtml('<span>x</span>')).toBe('x');
  });

  it('keeps only the style properties on the list', () => {
    const html = cleanHtml('<div style="color: red; position: fixed; font-size: 18px">x</div>');
    expect(html).toBe('<div style="color: red; font-size: 18px">x</div>');
  });

  it('drops a style value that is not the shape of that property', () => {
    // The escape attempt every CSS injection is built out of: the declaration
    // carrying the brace does not survive, so there is no rule to break out of.
    expect(cleanHtml('<div style="font-family: x; } body { display: none">t</div>'))
      .toBe('<div style="font-family: x">t</div>');
    expect(cleanHtml('<div style="color: url(https://tracker.test/x)">t</div>'))
      .toBe('<div>t</div>');
    expect(cleanHtml('<div style="background-color: expression(alert(1))">t</div>'))
      .toBe('<div>t</div>');
  });

  it('drops a comment, which can hide markup from a naive parser', () => {
    expect(cleanHtml('<div>a<!-- <script>x</script> -->b</div>')).toBe('<div>ab</div>');
  });

  it('answers empty for nothing at all', () => {
    expect(cleanHtml('')).toBe('');
    expect(cleanHtml(null)).toBe('');
    expect(cleanHtml(undefined)).toBe('');
  });

  it('accepts every font, size and colour the toolbar can apply', () => {
    // Single-quoted, because half these stacks quote a family name themselves.
    for (const font of FONTS) {
      expect(cleanHtml(`<span style='font-family: ${font.stack}'>x</span>`))
        .toContain(font.stack.split(',')[0].replace(/"/g, ''));
    }
    for (const size of SIZES) {
      expect(cleanHtml(`<span style="font-size: ${size.css}">x</span>`)).toContain('font-size');
    }
    for (const color of COLORS) {
      expect(cleanHtml(`<span style="color: ${color.value}">x</span>`)).toContain('color');
    }
  });
});

describe('hasFormatting', () => {
  it('is false for a message that was only typed', () => {
    expect(hasFormatting('<div>hello</div><div><br></div><div>bye</div>')).toBe(false);
    expect(hasFormatting('')).toBe(false);
  });

  it('is false for a quote alone, which plain text can carry', () => {
    expect(hasFormatting('<div>yes</div><blockquote><div>asked</div></blockquote>')).toBe(false);
  });

  it('is true once anything is actually marked up', () => {
    expect(hasFormatting('<div><b>hi</b></div>')).toBe(true);
    expect(hasFormatting('<div><span style="color: #c5221f">hi</span></div>')).toBe(true);
    expect(hasFormatting('<ul><li>hi</li></ul>')).toBe(true);
    expect(hasFormatting('<div><i>hi</i></div>')).toBe(true);
    expect(hasFormatting('<div><u>hi</u></div>')).toBe(true);
    expect(hasFormatting('<div><s>hi</s></div>')).toBe(true);
  });
});

describe('htmlToText', () => {
  it('stays linear on a quoted run of spaces, as a reply to a hostile message carries', () => {
    const start = performance.now();
    expect(htmlToText(`<div>&gt; a${'&nbsp;'.repeat(16000)} x</div><div>-- </div><div>Ana   </div>`))
      .toBe(`> a${' '.repeat(16001)}x\n-- \nAna`);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('gives one line per block', () => {
    expect(htmlToText('<div>one</div><div>two</div>')).toBe('one\ntwo');
  });

  it('reads a br as a line break', () => {
    expect(htmlToText('<div>one<br>two</div>')).toBe('one\ntwo');
  });

  it('reads the filler br of an empty block as a blank line, not two', () => {
    expect(htmlToText('<div>one</div><div><br></div><div>two</div>')).toBe('one\n\ntwo');
  });

  it('drops the marks that have no text equivalent', () => {
    expect(htmlToText('<div><b>bold</b> and <i>italic</i></div>')).toBe('bold and italic');
    expect(htmlToText('<div><span style="color: red">red</span></div>')).toBe('red');
  });

  it('collapses the whitespace of the markup, not of the message', () => {
    expect(htmlToText('<div>\n  one   two\n</div>')).toBe('one two');
  });

  it('marks a quote with the > every mail client uses', () => {
    expect(htmlToText('<blockquote><div>said this</div></blockquote>')).toBe('> said this');
  });

  it('keeps the nesting of a quoted quote', () => {
    const html = '<blockquote><div>outer</div><blockquote><div>inner</div></blockquote></blockquote>';
    expect(htmlToText(html)).toBe('> outer\n> > inner');
  });

  it('quotes a blank line as a bare >, not as trailing whitespace', () => {
    expect(htmlToText('<blockquote><div>a</div><div><br></div><div>b</div></blockquote>'))
      .toBe('> a\n>\n> b');
  });

  it('numbers an ordered list and bullets an unordered one', () => {
    expect(htmlToText('<ul><li>a</li><li>b</li></ul>')).toBe('- a\n- b');
    expect(htmlToText('<ol><li>a</li><li>b</li></ol>')).toBe('1. a\n2. b');
  });

  it('keeps a link the reader could not otherwise follow', () => {
    expect(htmlToText('<div><a href="https://example.com/x">the dashboard</a></div>'))
      .toBe('the dashboard <https://example.com/x>');
  });

  it('does not repeat a URL that is already its own label', () => {
    expect(htmlToText('<div><a href="https://example.com">https://example.com</a></div>'))
      .toBe('https://example.com');
  });

  it('keeps the space on the signature separator and takes it off every other line', () => {
    expect(htmlToText('<div>Thanks   </div><div><br></div><div>-- </div><div>Ana</div>'))
      .toBe('Thanks\n\n-- \nAna');
    // Typing on the line turns the space into a non-breaking one; that is
    // still the separator.
    expect(htmlToText('<div>--\u00a0</div><div>Ana</div>')).toBe('-- \nAna');
    // Two dashes with nothing after them are not one.
    expect(htmlToText('<div>--</div><div>Ana</div>')).toBe('--\nAna');
  });
});

describe('textToHtml', () => {
  it('gives one div per line', () => {
    expect(textToHtml('one\ntwo')).toBe('<div>one</div><div>two</div>');
  });

  it('keeps a blank line as a block with a break in it', () => {
    expect(textToHtml('one\n\ntwo')).toBe('<div>one</div><div><br></div><div>two</div>');
  });

  it('escapes markup in the text rather than adopting it', () => {
    expect(textToHtml('<b>not bold</b> & "quoted"'))
      .toBe('<div>&lt;b&gt;not bold&lt;/b&gt; &amp; "quoted"</div>');
  });

  it('turns a run of quoted lines into one blockquote', () => {
    expect(textToHtml('> a\n> b'))
      .toBe('<blockquote><div>a</div><div>b</div></blockquote>');
  });

  it('nests a quoted quote one level at a time', () => {
    expect(textToHtml('> a\n> > b'))
      .toBe('<blockquote><div>a</div><blockquote><div>b</div></blockquote></blockquote>');
  });

  it('round-trips a reply quote back to the same text', () => {
    const quoted = 'Sure.\n\nOn Fri, Ana wrote:\n> the question\n>\n> and more';
    expect(htmlToText(textToHtml(quoted))).toBe(quoted);
  });

  it('round-trips a signed message with its separator intact', () => {
    const signed = 'Sure.\n\n-- \nAna Petrova\nMeridian Labs';
    expect(htmlToText(textToHtml(signed))).toBe(signed);
  });

  it('keeps the spacing the writer typed, or quoted, in the text as well', () => {
    // The editor holds a run of spaces as no-break spaces so the browser
    // does not collapse them; the text part has to bring them back as the
    // spaces they were. For an unformatted message that text is the whole
    // message, and a quoted receipt lost its columns on the way out.
    expect(textToHtml('  a')).toContain('&nbsp;');
    expect(htmlToText(textToHtml('    indented'))).toBe('    indented');
    const receipt = 'Flat white (oat)        4.80\nAlmond croissant        3.50\nend.  Two spaces.';
    expect(htmlToText(textToHtml(receipt))).toBe(receipt);
    const quoted = receipt.split('\n').map((line) => `> ${line}`).join('\n');
    expect(htmlToText(textToHtml(quoted))).toBe(quoted);
  });

  it('still collapses the whitespace of the markup around a kept run', () => {
    expect(htmlToText('<div>\n  one&nbsp;&nbsp; two\n</div>')).toBe('one   two');
    expect(htmlToText('<div>a</div>\n\n<div>b</div>')).toBe('a\nb');
  });
});

describe('messageHtml', () => {
  it('is a whole small document, as every other client sends', () => {
    const document_ = messageHtml('<div>hi</div>');
    expect(document_.startsWith('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'))
      .toBe(true);
    expect(document_.endsWith('</body></html>')).toBe(true);
    expect(bodyOf(document_)).toBe('<div>hi</div>');
  });

  it('cleans on the way out as well as on the way in', () => {
    expect(bodyOf(messageHtml('<div onclick="x">hi</div><script>y</script>')))
      .toBe('<div>hi</div>');
  });

  it('links a URL the writer only typed', () => {
    expect(bodyOf(messageHtml('<div>see https://example.com/x now</div>')))
      .toBe('<div>see <a href="https://example.com/x">https://example.com/x</a> now</div>');
  });

  it('links a bare address as a mailto', () => {
    expect(bodyOf(messageHtml('<div>ask ana@example.com</div>')))
      .toBe('<div>ask <a href="mailto:ana@example.com">ana@example.com</a></div>');
  });

  it('leaves a link that is already a link alone', () => {
    const html = '<div><a href="https://example.com/a">https://example.com/a</a></div>';
    expect(bodyOf(messageHtml(html))).toBe(html);
  });

  it('links inside a quote as well as outside one', () => {
    expect(bodyOf(messageHtml('<blockquote><div>https://a.test/</div></blockquote>')))
      .toContain('<a href="https://a.test/">');
  });

  it('does not turn a full stop after a URL into part of it', () => {
    // The label is the URL as written; the href is the URL as the browser
    // would resolve it, which is where the root slash comes from.
    expect(bodyOf(messageHtml('<div>at https://example.com.</div>')))
      .toBe('<div>at <a href="https://example.com/">https://example.com</a>.</div>');
  });
});

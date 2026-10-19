// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseHtmlClipboard } from '../src/core/clipboard.js';

// A web table often hides text inside its cells: Wikipedia's sortable tables put a sort key in a
// <span style="display:none"> before the name, and pages hide labels for screen readers or toggles. A paste
// read every text node, so "China" came in as "000China" though the page (and its plain text) showed only
// "China". Content a cell hides with display:none or the hidden attribute is now left out.
const texts = (html) => parseHtmlClipboard(html, '').rows.map(row => row.map(cell => cell.text));

describe('pasting a web table', () => {
  it('leaves out text hidden inline in a cell', () => {
    expect(texts('<table><tr><td><span style="display:none" data-sort-value="x">000</span>China</td>'
      + '<td><span style="display: none;">!1E9 </span>1,411,750,000</td></tr></table>')).toEqual([['China', '1,411,750,000']]);
  });

  it('leaves out text hidden by a class rule or the hidden attribute, and keeps what is shown', () => {
    expect(texts('<style>.sortkey { display: none }</style><table><tr><td><span class="sortkey">Smith, John</span>'
      + '<span class="name">John Smith</span></td><td>7<span hidden> (draft)</span></td></tr></table>')).toEqual([['John Smith', '7']]);
  });
});

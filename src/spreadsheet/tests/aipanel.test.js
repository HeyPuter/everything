// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { renderMarkdown, safeHref } from '../src/ui/markdown.js';
import { createAiPanel, loadAiSettings, friendlyAiError } from '../src/ui/aipanel.js';
import * as P from '../src/lib/puter.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { toast } from '../src/ui/toast.js';

// Node's own localStorage (a stub without a file behind it) would stand in for jsdom's.
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

const html = (md, options) => { const d = document.createElement('div'); d.append(renderMarkdown(md, options)); return d; };

describe('reply Markdown', () => {
  it('renders blocks and inline marks as elements, never as markup', () => {
    const d = html('# Title\n\nSome **bold**, *em* and `code`.\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n```\n<b>x</b>\n```\n\n| A | B |\n|---|--:|\n| 1 | 2 |');
    expect(d.querySelector('h3').textContent).toBe('Title');
    expect(d.querySelector('strong').textContent).toBe('bold');
    expect(d.querySelector('em').textContent).toBe('em');
    expect(d.querySelector('code.md-inline').textContent).toBe('code');
    expect(d.querySelectorAll(':scope > ul > li').length).toBe(2);
    expect(d.querySelector('ul li ul li').textContent).toBe('nested');
    expect(d.querySelectorAll('ol > li').length).toBe(2);
    expect(d.querySelector('pre').textContent).toBe('<b>x</b>');
    expect(d.querySelector('pre b')).toBeNull();
    expect(d.querySelector('td:last-child').style.textAlign).toBe('right');
  });

  it('never loads a picture, and links only to web and mail addresses', () => {
    const d = html('![secret](https://evil.example/?d=A1) [ok](https://example.com) [bad](javascript:alert(1)) <img src=x onerror=alert(1)>');
    expect(d.querySelector('img')).toBeNull();
    expect(d.textContent).toContain('[secret]');
    const links = [...d.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/']);
    expect(links[0].rel).toContain('noopener');
    expect(safeHref('data:text/html,hi')).toBeNull();
  });

  it('keeps the parentheses of a link\'s address, but not those around it', () => {
    const d = html('[Mercury](https://en.wikipedia.org/wiki/Mercury_(planet)) and https://en.wikipedia.org/wiki/Venus_(planet). (see https://example.com/a)');
    expect([...d.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://en.wikipedia.org/wiki/Mercury_(planet)', 'https://en.wikipedia.org/wiki/Venus_(planet)', 'https://example.com/a']);
    expect(d.textContent).toBe('Mercury and https://en.wikipedia.org/wiki/Venus_(planet). (see https://example.com/a)');
    expect(html('[x](javascript:alert(1))').querySelector('a')).toBeNull();
  });

  it('reads a table whose divider has a single dash per column', () => {
    const d = html('| Region | Sales |\n|-|-:|\n| West | 120 |');
    expect(d.querySelector('th').textContent).toBe('Region');
    expect(d.querySelector('td:last-child').style.textAlign).toBe('right');
    expect(html('a | b\n-').querySelector('table')).toBeNull();
  });

  it('reads ***text*** as bold and italic, with no stray marks', () => {
    const d = html('Note: ***check B2*** first, then **go**.');
    expect(d.querySelector('strong > em').textContent).toBe('check B2');
    expect(d.textContent).toBe('Note: check B2 first, then go.');
  });

  it('turns references the caller finds into buttons that follow them', () => {
    const onRef = vi.fn();
    const refs = (text) => [...text.matchAll(/B2:B9/g)].map((m) => ({ start: m.index, end: m.index + 5, target: 'T' }));
    const d = html('Totals are in B2:B9 and `B2:B9`.', { refs, onRef });
    const buttons = d.querySelectorAll('button.cell-ref');
    expect(buttons.length).toBe(2);
    buttons[0].click();
    expect(onRef).toHaveBeenCalledWith('T');
  });

  it('leaves snake_case words alone and renders an unfinished code fence while it streams', () => {
    expect(html('use total_sales_by_region here').querySelector('em')).toBeNull();
    expect(html('the my__var__name column').querySelector('strong')).toBeNull();
    expect(html('a __strong__ word').querySelector('strong')?.textContent).toBe('strong');
    expect(html('```\nstill coming').querySelector('pre').textContent).toBe('still coming');
  });

  it('keeps a code block, and what follows a blank line, within the list item it is indented under', () => {
    const steps = html('1. Type:\n   ```\n   =SUM(B2:B4)\n\n   =B5*2\n   ```\n2. Fill it right.\n\n   Then check it.\n3. Done.\n\nAfter.');
    const items = steps.querySelectorAll('ol > li');
    expect(items).toHaveLength(3);
    expect(items[0].querySelector('pre').textContent).toBe('=SUM(B2:B4)\n\n=B5*2');
    expect(items[0].textContent).not.toContain('```');
    expect(items[1].querySelector('p').textContent).toBe('Then check it.');
    expect(steps.querySelector(':scope > p').textContent).toBe('After.');
    expect(html('- Step:\n\n    ```\n    x\n    ```').querySelector('li pre').textContent).toBe('x');
    expect(html('- a\n\n  - b\n- c').querySelectorAll(':scope > ul')).toHaveLength(1);
    // Still arriving: the open block runs to the end, inside its item.
    expect(html('1. Run:\n   ```\n   a').querySelector('li pre').textContent).toBe('a');
  });

  it('keeps a heading\'s own closing #, and reads a long heading line at once', () => {
    expect(html('## Using C#').querySelector('h3').textContent).toBe('Using C#');
    expect(html('# Totals ##').querySelector('h3').textContent).toBe('Totals');
    expect(html('#').querySelector('h3')).toBeNull();
    const t = performance.now();
    html(`# a${' '.repeat(3000)}b`);
    expect(performance.now() - t).toBeLessThan(200);
  });

  // Each underscore within a word looked to the end of the line for one to close it: a line of column names took
  // a second to draw in a long reply, which is drawn again as it streams.
  it('draws a long line of snake_case names quickly', () => {
    const names = Array.from({ length: 6000 }, (_, i) => `col_name_${i}`).join(', ');
    const t = performance.now();
    const d = html(`Columns: ${names} and _this_`);
    expect(performance.now() - t).toBeLessThan(150);
    expect(d.querySelectorAll('em').length).toBe(1);
  });

  it('still renders the marks that follow a snake_case word on the same line', () => {
    const d = html('net_sales rose **12%**, see [docs](https://example.com) and _note_');
    expect(d.querySelector('strong')?.textContent).toBe('12%');
    expect(d.querySelector('a')?.getAttribute('href')).toBe('https://example.com/');
    expect(d.querySelector('em')?.textContent).toBe('note');
    expect(d.textContent).toBe('net_sales rose 12%, see docs and note');
  });

  // Only a single word was taken after the opening marks: "```excel formula" read as text, and each fence after it
  // turned the rest of the reply over between code and text.
  it('reads a fence with any words after its marks, and keeps the rest of the reply as it is', () => {
    const d = html('Use this:\n\n```excel formula\n=SUM(B2:B9)\n# not a heading\n```\n\nThen **check** it.\n\n```c#\nvar x = 1;\n```\n\nDone.');
    expect([...d.querySelectorAll('pre')].map((p) => p.textContent)).toEqual(['=SUM(B2:B9)\n# not a heading', 'var x = 1;']);
    expect(d.querySelector('h3')).toBeNull();
    expect(d.querySelector('strong').textContent).toBe('check');
    expect(d.lastElementChild.textContent).toBe('Done.');
    // Backticks after backticks are code on one line, not a fence.
    expect(html('```=SUM(A1)``` works').querySelector('pre')).toBeNull();
    expect(html('1. Type:\n   ```excel formula\n   =A1\n   ```\n2. Next').querySelector('li pre').textContent).toBe('=A1');
  });

  // Backslashes were left in the text, and "\\*not this\\*" came out in italics.
  it('takes a backslash before a mark as making it plain, except in code', () => {
    const d = html('Costs \\$1,200 \\* 3. \\*not em\\* and Sales\\_2024, `a\\*b` and \\\\*em*');
    expect(d.textContent).toBe('Costs $1,200 * 3. *not em* and Sales_2024, a\\*b and \\em');
    expect([...d.querySelectorAll('em')].map((e) => e.textContent)).toEqual(['em']);
    expect(html('**bold\\**').querySelector('strong')).toBeNull();
    expect(html('\\# not a heading').querySelector('h3, h4')).toBeNull();
    expect(html('\\# not a heading').textContent).toBe('# not a heading');
    // A backslash at a line's end is a break, which the line already is; at the paragraph's end it stays.
    expect(html('one\\\ntwo').innerHTML).toBe('<p>one<br>two</p>');
    expect(html('a path C:\\Users\\x').textContent).toBe('a path C:\\Users\\x');
  });

  // Each ">" is a quote inside the last, drawn by recursion: thousands of them ran out of stack.
  it('draws quotes nested past any real reply\'s depth as text, without running out of stack', () => {
    const d = html(`${'>'.repeat(20000)} hi`);
    expect(d.textContent).toContain('hi');
    expect(d.querySelectorAll('blockquote').length).toBeLessThan(40);
    expect(html('> a\n> > b').querySelector('blockquote blockquote').textContent).toBe('b');
  });
});

describe('assistant panel', () => {
  let wb, id, panel, env;
  const stream = (parts) => (async function* s() { for (const p of parts) yield p; })();

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
    vi.stubGlobal('plausible', vi.fn());
    vi.spyOn(P, 'canAI').mockReturnValue(true);
    localStorage.clear();
    document.body.innerHTML = '';
    wb = new Workbook();
    id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'Qty');
    wb.setInput(id, 1, 0, '4');
    wb.clearHistory();
    env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 1, c2: 0 } }), select: vi.fn(() => true) };
    const ctx = { wb, doc: { name: 'Test' }, subscribe: () => () => {}, grid: { focus() {}, editing: false }, run: vi.fn((cmd, n) => { if (cmd === 'undoSteps') wb.undoSteps(n); }) };
    panel = createAiPanel(ctx, env);
    panel.ctx = ctx;
    document.body.append(panel.el);
    panel.open();
  });
  afterEach(() => { panel.destroy(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const send = async (text) => {
    const input = panel.el.querySelector('textarea');
    input.value = text;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('shows starting points and the selection that goes with a message', () => {
    const suggestions = panel.el.querySelectorAll('.ai-suggestion');
    expect(suggestions.length).toBeGreaterThan(0);
    for (const button of suggestions) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.hasAttribute('role')).toBe(false);
      expect(button.parentElement.tagName).toBe('LI');
    }
    // Inside the chat's log, but redrawn as the sheet changes: not read out as a message would be.
    expect(panel.el.querySelector('[role="log"] .ai-empty').getAttribute('aria-live')).toBe('off');
    const chip = panel.el.querySelector('.ai-context');
    expect(chip.textContent).toContain('Sheet1!A1:A2');
    expect(chip.tagName).not.toBe('BUTTON');
    chip.click();
    expect(env.select).not.toHaveBeenCalled();
    expect(panel.el.hidden).toBe(false);
  });

  it('sends no selection from a chart sheet, which has no cells', () => {
    const chartId = wb.addSheet('Chart1').id;
    wb.sheet(chartId).kind = 'chart';
    const chip = panel.el.querySelector('.ai-context');
    env.selection = () => ({ sheetId: chartId, range: { r1: 0, c1: 0, r2: 0, c2: 0 } });
    panel.close();
    panel.open();
    expect(chip.hidden).toBe(true);
    env.selection = () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } });
    panel.close();
    panel.open();
    expect(chip.hidden).toBe(false);
  });

  it('streams a reply with its steps, and undoes exactly its own changes', async () => {
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream(n++ === 0
      ? [{ type: 'text', text: 'Adding a total.' }, { type: 'tool', id: 'w', name: 'write_cells', input: { start_cell: 'A3', values: [['=SUM(A2)']] } }]
      : [{ type: 'text', text: 'Done: the total is in A3.' }]));
    await send('Add a total');
    expect(wb.getValue(id, 2, 0)).toBe(4);
    const reply = panel.el.querySelector('.ai-assistant');
    expect(reply.querySelector('.ai-step').textContent).toContain('Write 1 cell to Sheet1!A3');
    expect(reply.querySelector('.cell-ref').textContent).toBe('A3');
    expect(reply.getAttribute('aria-busy')).toBeNull();
    expect(plausible.mock.calls).toEqual([['AI Interaction', { props: { feature: 'assistant', changed: true } }]]);
    expect(P.aiChatStream.mock.calls[0][1].model).toBe('claude-opus-5-5');
    const undo = reply.querySelector('.ai-undo');
    expect(undo.disabled).toBe(false);
    undo.click();
    expect(panel.ctx.run).toHaveBeenCalledWith('undoSteps', 1);
    expect(wb.getCell(id, 2, 0)).toBeFalsy();
    expect(reply.querySelector('.ai-foot').textContent).toContain('undone');
  });

  // Each frame of a streaming reply drew its whole run of text again: for a long one that is much of every frame,
  // and the page stuttered for as long as the reply went on. A slow paint now spaces out the next.
  it('paints a reply every frame while that is cheap, and less often once a paint takes long', async () => {
    const deltas = Array.from({ length: 30 }, (_, i) => ({ type: 'text', text: `word${i} ` }));
    const slowly = (parts) => (async function* s() { for (const p of parts) { await new Promise((r) => setTimeout(r, 2)); yield p; } })();
    const paints = async (cost) => {
      let clock = 0;
      if (cost) vi.spyOn(performance, 'now').mockImplementation(() => (clock += cost / 2));
      vi.spyOn(P, 'aiChatStream').mockImplementation(() => slowly(deltas));
      let count = 0;
      const seen = new MutationObserver((records) => { for (const r of records) if (r.target.classList?.contains('ai-text')) count++; });
      seen.observe(panel.el.querySelector('.ai-log'), { childList: true, subtree: true });
      await send('Tell me');
      while (panel.busy) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 0));
      seen.disconnect();
      const text = [...panel.el.querySelectorAll('.ai-assistant .ai-text')].at(-1).textContent;
      vi.mocked(performance.now).mockRestore?.();
      return { count, text };
    };
    const cheap = await paints(0);
    expect(cheap.text).toBe(deltas.map((d) => d.text).join('').trim());
    expect(cheap.count).toBeGreaterThan(15);
    const slow = await paints(40);
    expect(slow.text).toBe(deltas.map((d) => d.text).join('').trim());
    expect(slow.count).toBeLessThan(cheap.count / 2);
  });

  // Who said what showed only in where a message sits and how it is drawn, which a screen reader does not convey.
  it('says in words who said each message, for a screen reader', async () => {
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream([{ type: 'text', text: 'Four.' }]));
    await send('How many?');
    const [mine, theirs] = panel.el.querySelectorAll('.ai-msg');
    expect(mine.firstElementChild.className).toBe('visually-hidden');
    expect(mine.textContent).toBe('You said:How many?');
    expect(theirs.firstElementChild.className).toBe('visually-hidden');
    expect(theirs.firstElementChild.textContent).toBe('The assistant said:');
    expect(theirs.querySelector('.ai-parts').textContent).toBe('Four.');
  });

  // A paint that threw left the reply unfinished: Stop showed on for good, and pressing it did nothing.
  it('finishes a reply the Markdown cannot be drawn for, showing it as text', async () => {
    const md = await import('../src/ui/markdown.js');
    vi.spyOn(md, 'renderMarkdown').mockImplementation(() => { throw new RangeError('Maximum call stack size exceeded'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream([{ type: 'text', text: 'Unusual **reply**' }]));
    await send('Hi');
    expect(panel.busy).toBe(false);
    expect(panel.el.classList.contains('busy')).toBe(false);
    expect(panel.el.querySelector('.ai-send').getAttribute('aria-label')).toBe('Send');
    const reply = panel.el.querySelector('.ai-assistant');
    expect(reply.getAttribute('aria-busy')).toBeNull();
    expect(reply.querySelector('.ai-text').textContent).toBe('Unusual **reply**');
  });

  it('says when a reply was cut off at its length limit', async () => {
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream([{ type: 'text', text: 'The long answer goes on and' }, { type: 'cut' }]));
    await send('Explain everything');
    expect(P.aiChatStream.mock.calls[0][1].maxTokens).toBe(32000);
    const reply = panel.el.querySelector('.ai-assistant');
    expect(reply.querySelector('.ai-stopped').textContent).toBe('The reply reached its length limit and was cut off. Say "continue" for the rest.');
    expect(plausible).not.toHaveBeenCalled();
  });

  it('shows it is still working when its text pauses before a tool call', async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => (n++ === 0
      ? (async function* s() { yield { type: 'text', text: 'Writing the table.' }; await held; yield { type: 'tool', id: 'r', name: 'read_range', input: { range: 'A1' } }; })()
      : stream([{ type: 'text', text: 'Done.' }])));
    await send('build');
    const reply = panel.el.querySelector('.ai-assistant');
    expect(reply.querySelector('.ai-typing')).toBeNull();
    await new Promise((r) => setTimeout(r, 800));
    const parts = reply.querySelector('.ai-parts');
    expect(parts.lastElementChild.className).toBe('ai-typing');
    release();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 800));
    expect(reply.querySelector('.ai-typing')).toBeNull();
    expect(reply.getAttribute('aria-busy')).toBeNull();
  });

  it('says a sheet a reply pointed to is gone, rather than trying to go there', async () => {
    const other = wb.addSheet('Notes').id;
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream(n++ === 0
      ? [{ type: 'tool', id: 'w', name: 'write_cells', input: { start_cell: 'Notes!A1', values: [['x']] } }]
      : [{ type: 'text', text: 'Written to Notes!A1.' }]));
    await send('note it');
    env.select.mockClear();
    wb.deleteSheet(other);
    const reply = panel.el.querySelector('.ai-assistant');
    reply.querySelector('.ai-step-label').click();
    reply.querySelector('.cell-ref').click();
    expect(env.select).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('That sheet is no longer in the workbook', expect.anything());
  });

  it('offers Send only with something to send, and Stop throughout a reply', async () => {
    const button = panel.el.querySelector('.ai-send');
    const input = panel.el.querySelector('textarea');
    expect(button.disabled).toBe(true);
    input.value = '  ';
    input.dispatchEvent(new Event('input'));
    expect(button.disabled).toBe(true);
    input.value = 'Hi';
    input.dispatchEvent(new Event('input'));
    expect(button.disabled).toBe(false);
    let release;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => (async function* s() { await new Promise((r) => { release = r; }); yield { type: 'text', text: 'Hello.' }; })());
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(button.getAttribute('aria-label')).toBe('Stop');
    expect(button.disabled).toBe(false);
    release();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(button.getAttribute('aria-label')).toBe('Send');
    expect(button.disabled).toBe(true);
  });

  it('copies a reply with its runs of text as separate paragraphs', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream(n++ === 0
      ? [{ type: 'text', text: 'Let me look first.' }, { type: 'tool', id: 'r', name: 'read_range', input: { range: 'A1:A2' } }]
      : [{ type: 'text', text: 'A2 holds 4.' }]));
    await send('What is in A2?');
    panel.el.querySelector('[aria-label="Copy the reply"]').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).toHaveBeenCalledWith('Let me look first.\n\nA2 holds 4.');
  });

  it('will not undo a reply once the user has edited since', async () => {
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream(n++ === 0
      ? [{ type: 'tool', id: 'w', name: 'write_cells', input: { start_cell: 'B1', values: [['x']] } }]
      : [{ type: 'text', text: 'ok' }]));
    await send('write');
    wb.setInput(id, 5, 5, 'mine');
    const undo = panel.el.querySelector('.ai-undo');
    expect(undo.disabled).toBe(true);
    undo.disabled = false;
    undo.click();
    expect(panel.ctx.run).not.toHaveBeenCalled();
    expect(wb.getValue(id, 5, 5)).toBe('mine');
  });

  it('waits for Allow before replacing data', async () => {
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream(n++ === 0
      ? [{ type: 'tool', id: 'w', name: 'write_cells', input: { start_cell: 'A2', values: [[9]] } }]
      : [{ type: 'text', text: 'ok' }]));
    await send('change A2');
    const card = panel.el.querySelector('.ai-approve');
    expect(card.textContent).toContain('Replaces 1 cell that already holds data.');
    expect(wb.getValue(id, 1, 0)).toBe(4);
    [...card.querySelectorAll('button')].find((b) => b.textContent === 'Allow').click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(wb.getValue(id, 1, 0)).toBe(9);
  });

  it('links the cells a change asks about, before it is allowed', async () => {
    const other = wb.addSheet('Data').id;
    wb.setInput(other, 3, 1, 'keep');
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream(n++ === 0
      ? [{ type: 'tool', id: 'c', name: 'clear_range', input: { range: 'Data!B2:C4' } }, { type: 'tool', id: 'd', name: 'delete_rows', input: { start_row: 2 } }]
      : [{ type: 'text', text: 'ok' }]));
    await send('clear it');
    const step = panel.el.querySelector('.ai-step-waiting');
    const label = step.querySelector('.ai-step-label');
    expect(label.tagName).toBe('BUTTON');
    label.click();
    expect(env.select).toHaveBeenLastCalledWith(other, { r1: 1, c1: 1, r2: 3, c2: 2 });
    expect(wb.getValue(other, 3, 1)).toBe('keep');
    [...panel.el.querySelectorAll('.ai-approve button')].find((b) => b.textContent === 'Don’t allow').click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    // Declined, the line is no longer a way to the cells; a change that names no cells has none to give.
    expect(panel.el.querySelector('.ai-step-declined .ai-step-label').tagName).toBe('SPAN');
    expect(panel.el.querySelectorAll('.ai-step')[1].querySelector('.ai-step-label').tagName).toBe('SPAN');
  });

  it('links whole columns in a reply, but not letters or ratios in prose', async () => {
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream([{ type: 'text', text: 'The totals are in B:C and Sheet1!A:A. TL:DR it works; see A1:A2: fine, at 3:1.' }]));
    await send('where?');
    const refs = [...panel.el.querySelectorAll('.ai-assistant .cell-ref')];
    expect(refs.map((b) => b.textContent)).toEqual(['B:C', 'Sheet1!A:A', 'A1:A2']);
    refs[0].click();
    expect(env.select).toHaveBeenLastCalledWith(id, expect.objectContaining({ r1: 0, c1: 1, c2: 2 }));
  });

  it('keeps the keyboard in the panel when Send, pressed as a button, is disabled at the end of the reply', async () => {
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream([{ type: 'text', text: 'Hi.' }]));
    const input = panel.el.querySelector('textarea');
    const sendBtn = panel.el.querySelector('.ai-send');
    input.value = 'hello';
    input.dispatchEvent(new Event('input'));
    // The panel's own focus on opening comes first.
    await new Promise((r) => setTimeout(r, 0));
    sendBtn.focus();
    expect(document.activeElement).toBe(sendBtn);
    sendBtn.click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(panel.sent).toEqual(['hello']);
    expect(panel.busy).toBe(false);
    expect(sendBtn.disabled).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('brings a question into view when the user has scrolled up from the reply', async () => {
    const log = panel.el.querySelector('.ai-log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 200 });
    let go;
    const gate = new Promise((r) => { go = r; });
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => (n++ === 0
      ? (async function* s() { yield { type: 'text', text: 'Looking.' }; await gate; yield { type: 'tool', id: 'w', name: 'write_cells', input: { start_cell: 'A2', values: [[9]] } }; })()
      : stream([{ type: 'text', text: 'ok' }])));
    await send('change A2');
    // The user scrolls up to read something earlier while the reply goes on.
    log.scrollTop = 0;
    log.dispatchEvent(new Event('scroll'));
    go();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(panel.el.querySelector('.ai-approve')).not.toBeNull();
    expect(log.scrollTop).toBe(1000);
  });

  it('leaves the keyboard in the message box when a question comes, so typing on cannot press Allow', async () => {
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream(n++ % 2 === 0
      ? [{ type: 'tool', id: `w${n}`, name: 'write_cells', input: { start_cell: 'A2', values: [[9 + n]] } }]
      : [{ type: 'text', text: 'ok' }]));
    const input = panel.el.querySelector('textarea');
    input.focus();
    await send('change A2');
    expect(panel.el.querySelector('.ai-approve')).not.toBeNull();
    expect(document.activeElement).toBe(input);
    [...panel.el.querySelectorAll('.ai-approve button')].find((b) => b.textContent === 'Don’t allow').click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(wb.getValue(id, 1, 0)).toBe(4);
    // From elsewhere in the panel the question still takes the focus, at its Allow.
    const newChat = panel.el.querySelector('.ai-head .icon-btn');
    const pending = send('change A2 again');
    newChat.focus();
    await pending;
    expect(document.activeElement.textContent).toBe('Allow');
  });

  it('stops the reply when the panel is closed on its question, rather than opening again for the next', async () => {
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream(n++ === 0
      ? [{ type: 'tool', id: 'w1', name: 'write_cells', input: { start_cell: 'A2', values: [[9]] } },
        { type: 'tool', id: 'w2', name: 'write_cells', input: { start_cell: 'A1', values: [['x']] } }]
      : [{ type: 'text', text: 'ok' }]));
    await send('change A1 and A2');
    expect(panel.el.querySelector('.ai-approve')).not.toBeNull();
    panel.close();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(panel.isOpen).toBe(false);
    expect(loadAiSettings().open).toBe(false);
    expect(panel.busy).toBe(false);
    expect(wb.getValue(id, 1, 0)).toBe(4);
    expect(wb.getValue(id, 0, 0)).toBe('Qty');
    expect(n).toBe(1);
  });

  it('keeps working on its own sheet when the user looks at another meanwhile', async () => {
    localStorage.setItem('spreadsheet:ai', JSON.stringify({ approval: 'always' }));
    panel.destroy();
    panel = createAiPanel(panel.ctx, env);
    document.body.append(panel.el);
    panel.open();
    const other = wb.addSheet('Other').id;
    wb.setInput(other, 1, 0, 'precious');
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream(n++ === 0
      ? [{ type: 'tool', id: 'w', name: 'write_cells', input: { start_cell: 'A2', values: [[9]] } }]
      : n === 2 ? [{ type: 'tool', id: 'f', name: 'format_cells', input: { range: 'A2', bold: true } }] : [{ type: 'text', text: 'Changed A2.' }]));
    const first = id;
    await send('change A2');
    expect(panel.el.querySelector('.ai-step').textContent).toContain('Sheet1!A2');
    id = other; // the user clicks another sheet's tab while the question waits
    [...panel.el.querySelectorAll('.ai-approve button')].find((b) => b.textContent === 'Allow').click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(panel.el.querySelectorAll('.ai-step')[1].textContent).toContain('Sheet1!A2');
    [...panel.el.querySelectorAll('.ai-approve button')].find((b) => b.textContent === 'Allow').click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(wb.getValue(first, 1, 0)).toBe(9);
    expect(wb.styleAt(first, 1, 0)?.bold).toBe(true);
    expect(wb.getValue(other, 1, 0)).toBe('precious');
    expect(wb.styleAt(other, 1, 0)?.bold).toBeFalsy();
    // And the reply's own mention of A2 leads to the A2 it changed.
    env.select.mockClear();
    [...panel.el.querySelectorAll('.cell-ref')].at(-1).click();
    expect(env.select).toHaveBeenCalledWith(first, { r1: 1, c1: 0, r2: 1, c2: 0 });
  });

  it('asks before writing over what the user typed while it waited for them', async () => {
    let finishTyping, editing = true;
    env.whenIdle = () => (editing ? new Promise((resolve) => { finishTyping = () => { editing = false; resolve(); }; }) : null);
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream(n++ === 0
      ? [{ type: 'tool', id: 'w', name: 'write_cells', input: { start_cell: 'C1', values: [['ai']] } }]
      : [{ type: 'text', text: 'ok' }]));
    await send('write C1');
    expect(panel.el.querySelector('.ai-step-note').textContent).toMatch(/finish the cell you are typing in/);
    expect(panel.el.querySelector('.ai-approve')).toBeNull();
    wb.setInput(id, 0, 2, 'mine'); // the entry the user was typing, into the very cell
    finishTyping();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    const card = panel.el.querySelector('.ai-approve');
    expect(card?.textContent).toContain('Replaces 1 cell that already holds data.');
    expect(panel.el.querySelector('.ai-step-note')).toBeNull();
    [...card.querySelectorAll('button')].find((b) => b.textContent === 'Don’t allow').click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(wb.getValue(id, 0, 2)).toBe('mine');
  });

  it('follows its own steps onto another sheet', async () => {
    const summary = wb.addSheet('Summary').id;
    wb.setActiveSheet(id);
    const first = id;
    env.sheetId = () => wb.activeSheetId;
    env.showSheet = (sheetId) => wb.setActiveSheet(sheetId);
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream(n++ === 0
      ? [{ type: 'tool', id: 's', name: 'manage_sheet', input: { action: 'activate', sheet: 'Summary' } }]
      : n === 2 ? [{ type: 'tool', id: 'w', name: 'write_cells', input: { start_cell: 'B1', values: [['here']] } }] : [{ type: 'text', text: 'ok' }]));
    await send('write on Summary');
    expect(wb.getValue(summary, 0, 1)).toBe('here');
    expect(wb.getCell(first, 0, 1)).toBeFalsy();
  });

  it('tries a failed reply again on the sheet it had moved to, whichever the user looks at now', async () => {
    const summary = wb.addSheet('Summary').id;
    wb.setActiveSheet(id);
    env.sheetId = () => wb.activeSheetId;
    env.showSheet = (sheetId) => wb.setActiveSheet(sheetId);
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => {
      n++;
      if (n === 1) return stream([{ type: 'tool', id: 's', name: 'manage_sheet', input: { action: 'activate', sheet: 'Summary' } }]);
      if (n === 2) return (async function* fail() { throw new Error('The AI service is busy'); })();
      if (n === 3) return stream([{ type: 'tool', id: 'w', name: 'write_cells', input: { start_cell: 'B1', values: [['here']] } }]);
      return stream([{ type: 'text', text: 'ok' }]);
    });
    await send('write on Summary');
    expect(panel.el.querySelector('.ai-retry')).not.toBeNull();
    wb.setActiveSheet(id); // the user looks back at the first sheet before trying again
    panel.el.querySelector('.ai-retry').click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(wb.getValue(summary, 0, 1)).toBe('here');
    expect(wb.getCell(id, 0, 1)).toBeFalsy();
  });

  it('says a first message is too long, and a longer chat has grown so', async () => {
    const tooLong = () => (async function* fail() { throw new Error('prompt is too long: 250000 tokens > 200000 maximum'); })();
    vi.spyOn(P, 'aiChatStream').mockImplementation(tooLong);
    await send('x'.repeat(1000));
    expect(panel.el.querySelector('.ai-error-text').textContent).toMatch(/This message is too long/);
    await send('and again');
    expect([...panel.el.querySelectorAll('.ai-error-text')].at(-1).textContent).toMatch(/This chat has grown too long/);
  });

  // Try again sent the same request, which failed the same way; the new chat the failure names was only in the header.
  it('offers a new chat, not a futile try again, when the chat is too long for the AI', async () => {
    let tooLong = true;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => (tooLong
      ? (async function* fail() { throw new Error('prompt is too long: 250000 tokens > 200000 maximum'); })()
      : stream([{ type: 'text', text: 'Hello.' }])));
    await send('x'.repeat(1000));
    const first = panel.el.querySelector('.ai-error');
    expect(first.querySelector('.ai-retry')).toBeNull();
    expect(first.querySelector('button')).toBeNull();
    await send('and again');
    const error = [...panel.el.querySelectorAll('.ai-error')].at(-1);
    expect(error.querySelector('.ai-retry')).toBeNull();
    const fresh = error.querySelector('button.ai-new-chat');
    expect(fresh.textContent).toBe('New chat');
    fresh.click();
    expect(panel.el.querySelector('.ai-msg')).toBeNull();
    expect(panel.messages).toEqual([]);
    tooLong = false;
    await send('hi');
    expect(panel.el.querySelector('.ai-assistant').textContent).toContain('Hello.');
    // Any other failure is still offered again.
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => (async function* fail() { throw new Error('Failed to fetch'); })());
    await send('more');
    expect([...panel.el.querySelectorAll('.ai-error')].at(-1).querySelector('.ai-retry').textContent).toBe('Try again');
  });

  it('holds a change until the entry the user is typing ends, saying why', async () => {
    let finishTyping, editing = true;
    env.whenIdle = () => (editing ? new Promise((resolve) => { finishTyping = () => { editing = false; resolve(); }; }) : null);
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream(n++ === 0
      ? [{ type: 'tool', id: 'w', name: 'write_cells', input: { start_cell: 'C1', values: [['later']] } }]
      : [{ type: 'text', text: 'ok' }]));
    await send('write C1');
    expect(panel.el.querySelector('.ai-step-note').textContent).toMatch(/finish the cell you are typing in/);
    expect(wb.getCell(id, 0, 2)).toBeFalsy();
    finishTyping();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(wb.getValue(id, 0, 2)).toBe('later');
    expect(panel.el.querySelector('.ai-step-note')).toBeNull();
  });

  it('gives its resize handle the width drawn, as the window narrows and widens', () => {
    const handle = panel.el.querySelector('.ai-resize');
    vi.stubGlobal('innerWidth', 600);
    window.dispatchEvent(new Event('resize'));
    expect([handle.getAttribute('aria-valuenow'), handle.getAttribute('aria-valuemax')]).toEqual(['360', '360']);
    vi.stubGlobal('innerWidth', 2000);
    window.dispatchEvent(new Event('resize'));
    expect([handle.getAttribute('aria-valuenow'), handle.getAttribute('aria-valuemax')]).toEqual(['380', '720']);
  });

  it('resizes only as far as the panel is drawn, so dragging back moves it at once', () => {
    vi.stubGlobal('innerWidth', 1000);
    vi.spyOn(panel.el, 'getBoundingClientRect').mockReturnValue({ left: 620, right: 1000, top: 0, bottom: 800, width: 380, height: 800 });
    const handle = panel.el.querySelector('.ai-resize');
    handle.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 620, bubbles: true }));
    handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, bubbles: true }));
    expect(panel.el.style.getPropertyValue('--ai-w')).toBe('600px');
    handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 450, bubbles: true }));
    expect(panel.el.style.getPropertyValue('--ai-w')).toBe('550px');
    handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 900, bubbles: true }));
    expect(panel.el.style.getPropertyValue('--ai-w')).toBe('300px');
    handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 650, bubbles: true }));
    expect(panel.el.style.getPropertyValue('--ai-w')).toBe('350px');
    handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(handle.getAttribute('aria-valuemax')).toBe('600');
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(handle.getAttribute('aria-valuenow')).toBe('600');
  });

  it('keeps the keyboard in the panel when the button pressed goes away', async () => {
    const input = panel.el.querySelector('textarea');
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => {
      n++;
      if (n === 1) return stream([{ type: 'tool', id: 'w', name: 'write_cells', input: { start_cell: 'C1', values: [['x']] } }]);
      if (n === 2) return (async function* s() { throw new Error('insufficient funds'); })();
      return stream([{ type: 'text', text: 'ok' }]);
    });
    // A suggestion: the empty state it sits in makes way for the chat.
    const suggestion = panel.el.querySelector('.ai-suggestion');
    suggestion.focus();
    suggestion.click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(input);
    // Undo: the button makes way for "undone". The editor's undo focuses the sheet, as it does from the menu.
    const sheet = document.body.appendChild(Object.assign(document.createElement('div'), { tabIndex: 0 }));
    panel.ctx.run.mockImplementation((cmd, n) => { if (cmd === 'undoSteps') { wb.undoSteps(n); sheet.focus(); } });
    const undo = panel.el.querySelector('.ai-undo');
    undo.focus();
    undo.click();
    expect(wb.getCell(id, 0, 2)).toBeFalsy();
    expect(document.activeElement).toBe(input);
    // Try again: the failure (the same reply's, which failed after its change) goes with it.
    const retry = panel.el.querySelector('.ai-retry');
    retry.focus();
    retry.click();
    expect(document.activeElement).toBe(input);
  });

  it('shows the end of the chat when it opens on what arrived while it was closed', () => {
    const log = panel.el.querySelector('.ai-log');
    let top = 0, height = 200;
    Object.defineProperty(log, 'scrollTop', { get: () => top, set: (v) => { top = Math.min(v, height); }, configurable: true });
    Object.defineProperty(log, 'scrollHeight', { get: () => (panel.el.hidden ? 0 : height), configurable: true });
    Object.defineProperty(log, 'clientHeight', { get: () => (panel.el.hidden ? 0 : 100), configurable: true });
    panel.close();
    height = 900; // a reply, or a question to allow a change, came in meanwhile
    panel.open({ focus: false });
    expect(top).toBe(900);
    // Scrolled back through the chat, the user finds it as they left it.
    top = 100;
    log.dispatchEvent(new Event('scroll'));
    panel.close();
    panel.open({ focus: false });
    expect(top).toBe(100);
  });

  it('shows a failure with a way to try again', async () => {
    vi.spyOn(P, 'aiChatStream').mockImplementationOnce(() => (async function* s() { throw new Error('insufficient funds'); })())
      .mockImplementationOnce(() => stream([{ type: 'text', text: 'Back.' }]));
    await send('hello');
    const alert = panel.el.querySelector('[role="alert"]');
    expect(alert.textContent).toContain('allowance');
    expect(plausible).not.toHaveBeenCalled();
    [...alert.querySelectorAll('button')].find((b) => b.textContent === 'Try again').click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(panel.el.querySelectorAll('.ai-assistant .ai-text')[0].textContent).toBe('Back.');
    expect(plausible.mock.calls).toEqual([['AI Interaction', { props: { feature: 'assistant', changed: false } }]]);
  });

  it('does not track an empty assistant reply as delivered value', async () => {
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream([]));
    await send('hello');
    expect(panel.el.querySelector('.ai-text').textContent).toBe('I have nothing to add.');
    expect(plausible).not.toHaveBeenCalled();
  });

  it('does not track a reply the user stops, even after some text has arrived', async () => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => (async function* s() {
      yield { type: 'text', text: 'Starting…' };
      await held;
    })());
    await send('hello');
    panel.el.querySelector('.ai-send').click();
    release();
    for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(panel.el.querySelector('.ai-stopped').textContent).toBe('Stopped.');
    expect(plausible).not.toHaveBeenCalled();
  });

  it('takes back the way to try a failed reply again once another message is sent', async () => {
    vi.spyOn(P, 'aiChatStream').mockImplementationOnce(() => (async function* s() { throw new Error('Failed to fetch'); })())
      .mockImplementation(() => stream([{ type: 'text', text: 'Answered.' }]));
    await send('first');
    const failed = panel.el.querySelector('.ai-assistant');
    expect([...failed.querySelectorAll('button')].some((b) => b.textContent === 'Try again')).toBe(true);
    await send('second');
    expect([...failed.querySelectorAll('button')].some((b) => b.textContent === 'Try again')).toBe(false);
    expect(failed.querySelector('[role="alert"]').textContent).toContain('could not be reached');
    expect(panel.messages.at(-1)).toEqual({ role: 'assistant', content: 'Answered.' });
  });

  it('keeps the Undo of a failed reply\'s changes when it is tried again', async () => {
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => {
      n++;
      if (n === 1) return stream([{ type: 'tool', id: 'w', name: 'write_cells', input: { start_cell: 'B1', values: [['x']] } }]);
      if (n === 2) return (async function* s() { throw new Error('Failed to fetch'); })();
      return stream([{ type: 'text', text: 'Done.' }]);
    });
    await send('write B1');
    const failed = panel.el.querySelector('.ai-assistant');
    expect(failed.querySelector('.ai-undo')).toBeTruthy();
    [...failed.querySelectorAll('button')].find((b) => b.textContent === 'Try again').click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(failed.querySelector('.ai-foot').hidden).toBe(false);
    expect(failed.querySelector('[role="alert"]')).toBeNull();
    const undo = failed.querySelector('.ai-undo');
    expect(undo.disabled).toBe(false);
    undo.click();
    expect(wb.getCell(id, 0, 1)).toBeFalsy();
  });

  it('starts over with New chat', async () => {
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream([{ type: 'text', text: 'hi' }]));
    await send('hello');
    expect(panel.messages.length).toBe(2);
    panel.el.querySelector('[aria-label="New chat"]').click();
    expect(panel.messages.length).toBe(0);
    expect(panel.el.querySelector('.ai-msg')).toBeNull();
    expect(panel.el.querySelector('.ai-empty')).toBeTruthy();
  });
  it('keeps a reply\'s Undo in step with undo and redo from the Edit menu', async () => {
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream(n++ === 0
      ? [{ type: 'tool', id: 'w', name: 'write_cells', input: { start_cell: 'C1', values: [['x']] } }, { type: 'tool', id: 'v', name: 'write_cells', input: { start_cell: 'C2', values: [['y']] } }]
      : [{ type: 'text', text: 'Done.' }]));
    await send('Write two cells');
    const reply = panel.el.querySelector('.ai-assistant');
    const summary = reply.querySelector('.ai-foot-summary');
    const undo = reply.querySelector('.ai-undo');
    // Undone from the panel, then redone from the Edit menu: its changes are back, and so is its Undo.
    undo.click();
    expect(summary.textContent).toBe('2 changes undone');
    expect(undo.hidden).toBe(true);
    wb.redoSteps(2);
    expect(wb.getValue(id, 1, 2)).toBe('y');
    expect(summary.textContent).toBe('2 changes made');
    expect(undo.hidden).toBe(false);
    expect(undo.disabled).toBe(false);
    // Undone step by step from the Edit menu: halfway it cannot be taken back as a whole; once all are, it says so.
    wb.undo();
    expect(summary.textContent).toBe('2 changes made');
    expect(undo.disabled).toBe(true);
    wb.undo();
    expect(summary.textContent).toBe('2 changes undone');
    expect(undo.hidden).toBe(true);
    // An edit of the user's afterwards leaves it undone.
    wb.setInput(id, 5, 5, 'mine');
    expect(summary.textContent).toBe('2 changes undone');
  });

  it('fits the message box to its lines again when the panel is resized', () => {
    const input = panel.el.querySelector('textarea');
    // Forty characters to a line at 380px, more as the panel widens: the text wraps to fewer lines.
    Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => 20 * Math.ceil(input.value.length / (40 * parseInt(panel.el.style.getPropertyValue('--ai-w'), 10) / 380)) });
    vi.stubGlobal('innerWidth', 2000);
    input.value = 'x'.repeat(120);
    input.dispatchEvent(new Event('input'));
    expect(input.style.height).toBe('60px');
    const handle = panel.el.querySelector('.ai-resize');
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(input.style.height).toBe('40px');
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(input.style.height).toBe('80px');
    // Closed, it keeps its height, to be fitted when it opens.
    panel.close();
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(input.style.height).toBe('80px');
    panel.open({ focus: false });
    expect(input.style.height).toBe('40px');
  });

  it('keeps what the user was writing when a suggestion is sent', async () => {
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream([{ type: 'text', text: 'Here is a summary.' }]));
    const input = panel.el.querySelector('textarea');
    input.value = 'Make a chart of the sales by';
    input.dispatchEvent(new Event('input'));
    panel.el.querySelector('.ai-suggestion').click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(panel.sent).toHaveLength(1);
    expect(panel.sent[0]).not.toContain('sales by');
    expect(input.value).toBe('Make a chart of the sales by');
    expect(panel.el.querySelector('.ai-send').disabled).toBe(false);
  });
});

describe('assistant panel settings', () => {
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

  it('opens by default, stays closed once closed, and waits to be asked for on a phone', () => {
    localStorage.clear();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(loadAiSettings().open).toBe(true);
    localStorage.setItem('spreadsheet:ai', JSON.stringify({ open: false }));
    expect(loadAiSettings().open).toBe(false);
    localStorage.clear();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(loadAiSettings().open).toBe(false);
    // On a phone, the choice made on a phone (a wide window's has a layout of its own).
    localStorage.setItem('spreadsheet:ai', JSON.stringify({ openNarrow: true }));
    expect(loadAiSettings().open).toBe(true);
  });
});

describe('failures in plain words', () => {
  it.each([
    ["This model's maximum context length limit was exceeded", /too long/],
    ['prompt is too long: 250000 tokens > 200000 maximum', /too long/],
    ['Rate limit exceeded, retry in 20s', /busy/],
    ['429 Too Many Requests', /busy/],
    ['insufficient_funds', /allowance/],
    ['Usage limit reached for this month', /allowance/],
    ['Failed to fetch', /reached/],
    ['context_length_exceeded', /too long/],
    ['The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).', /too long/],
    ['context deadline exceeded', /reached/],
    ['The request took too long to complete', /reached/],
    ['rpc error: code = Canceled desc = context canceled', /reached/],
    ['Something odd', /said: Something odd/],
  ])('%s', (message, expected) => {
    expect(friendlyAiError(new Error(message))).toMatch(expected);
  });

  it('does not offer a new chat for a first message that is itself too long', () => {
    const error = new Error('prompt is too long: 250000 tokens > 200000 maximum');
    expect(friendlyAiError(error, { firstMessage: true })).toBe('This message is too long for the AI. Shorten it, or ask about a smaller range.');
    expect(friendlyAiError(error)).toMatch(/Start a new chat/);
  });
});

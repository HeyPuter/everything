// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { menubarMenus, menuLeaves } from '../src/ui/menubar.js';
import { memoryStorage } from './helpers/memory-storage.js';

// Toast owns an application-lifetime live region; retain it across test mounts.
const toastRoot = document.querySelector('.toast-root');
let view, write, writeText, png;
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: t => ({ width: t.length * 7 }), font: '', scale() {}, drawImage() {} });
  png = new Blob(['rendered chart'], { type: 'image/png' });
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(done => done(png));
  vi.stubGlobal('Image', class { set src(v) { queueMicrotask(() => this.onload?.()); } });
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:chart'; } static revokeObjectURL() {} });
  write = vi.fn(async () => {}); writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { onLine: true, clipboard: { write, writeText } });
  vi.stubGlobal('ClipboardItem', class { constructor(data) { this.data = data; } });
  document.body.innerHTML = '<div id="app"></div>';
  toastRoot.replaceChildren(); document.body.append(toastRoot);
});
afterEach(() => { closeMenu(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount(type = 'pie') {
  const doc = new Doc({ name: 'Drawing', path: 'Spreadsheets/Drawing.xlsx' }), wb = doc.wb, id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Cells behind drawing'); wb.setInput(id, 0, 1, '-3'); wb.setInput(id, 1, 0, 'Second'); wb.setInput(id, 1, 1, '1');
  wb.addChart(id, { type, title: 'Signed data', text: 'Drawing text', range: { r1: 0, c1: 0, r2: 1, c2: 1 }, anchor: { r: 3, c: 0 }, w: 300, h: 180 });
  wb.clearHistory();
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} }); document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport'); viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', code: 'KeyO', ctrlKey: true, metaKey: true, altKey: true, bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(view.el.querySelector('.chart-box.selected')).not.toBeNull();
  return { wb, id, viewport };
}
function copyEvent(viewport, kind = 'copy') {
  const setData = vi.fn(), event = new Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { setData, getData: () => '', files: [] } });
  viewport.dispatchEvent(event); return { event, setData };
}

it.each(['native', 'menu'])('copies the selected embedded chart through the %s Copy path', async path => {
  const { viewport } = await mount();
  let copied;
  if (path === 'native') copied = copyEvent(viewport);
  else {
    view.el.querySelector('[data-menu="edit"]').click();
    [...document.querySelectorAll('.menu-item')].find(n => n.querySelector('.menu-label')?.textContent === 'Copy').click();
  }
  await vi.advanceTimersByTimeAsync(5);
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0][0][0].data).toEqual({ 'image/png': png });
  if (copied) { expect(copied.event.defaultPrevented).toBe(true); expect(copied.setData).not.toHaveBeenCalled(); }
});

it.each([true, false])('preserves roundedCorners=%s in the chart sent to clipboard rasterization', async roundedCorners => {
  const { viewport, wb, id } = await mount('column'), ch = wb.activeSheet.charts[0];
  wb.updateChart(id, ch.id, { appearance: { roundedCorners } });
  await vi.advanceTimersByTimeAsync(1);
  const svgSources = [];
  vi.stubGlobal('Blob', class extends Blob {
    constructor(parts, options) {
      super(parts, options);
      if (options?.type?.split(';')[0] === 'image/svg+xml') svgSources.push(parts.join(''));
    }
  });
  copyEvent(viewport); await vi.advanceTimersByTimeAsync(5);
  expect(write).toHaveBeenCalledTimes(1);
  expect(svgSources).toHaveLength(1);
  const root = new DOMParser().parseFromString(svgSources[0], 'image/svg+xml').documentElement;
  expect(root.hasAttribute('clip-path')).toBe(roundedCorners);
  expect(root.textContent).toContain('Signed data');
});

it('copies selected drawing text and resumes copying cells after deselection', async () => {
  const { viewport } = await mount('text');
  const first = copyEvent(viewport); await vi.advanceTimersByTimeAsync(5);
  expect(writeText).toHaveBeenCalledWith('Drawing text'); expect(first.setData).not.toHaveBeenCalled();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  const second = copyEvent(viewport);
  expect(second.setData).toHaveBeenCalledWith('text/plain', 'Cells behind drawing');
});

it('includes zero-anchored headroom in the chart picture sent to the clipboard', async () => {
  const {viewport,wb,id} = await mount('column'), chart = wb.activeSheet.charts[0];
  wb.setInput(id,0,1,'80'); wb.setInput(id,1,1,'100');
  wb.updateChart(id,chart.id,{appearance:{yStep:1,yStyle:{color:'#123456'}}});
  await vi.advanceTimersByTimeAsync(1);
  const sources = [];
  vi.stubGlobal('Blob',class extends Blob {
    constructor(parts,options) {
      super(parts,options);
      if (options?.type?.split(';')[0] === 'image/svg+xml') sources.push(parts.join(''));
    }
  });
  copyEvent(viewport); await vi.advanceTimersByTimeAsync(5);
  expect(write).toHaveBeenCalledTimes(1); expect(sources).toHaveLength(1);
  const root = new DOMParser().parseFromString(sources[0],'image/svg+xml');
  const ticks = [...root.querySelectorAll('text[fill="#123456"]')].map(n=>Number(n.textContent));
  expect(Math.min(...ticks)).toBe(0); expect(Math.max(...ticks)).toBe(105);
});

it('does not cut the cells behind a selected drawing', async () => {
  const { viewport, wb, id } = await mount();
  const copied = copyEvent(viewport, 'cut');
  expect(copied.event.defaultPrevented).toBe(true); expect(copied.setData).not.toHaveBeenCalled();
  expect(wb.getValue(id, 0, 0)).toBe('Cells behind drawing'); expect(wb.canUndo()).toBe(false);
  expect(write).not.toHaveBeenCalled();
  const cut = chart => menubarMenus({ chart }).flatMap(m => menuLeaves(m.items)).find(m => m.cmd === 'cut');
  expect(cut('selected-drawing').disabled).toBe(true);
  expect(cut(null).disabled).toBe(false);
});

it('reports a denied drawing copy without copying the underlying cells', async () => {
  const { viewport, wb } = await mount();
  write.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const copied = copyEvent(viewport); await vi.advanceTimersByTimeAsync(5);
  expect(copied.event.defaultPrevented).toBe(true);
  expect(copied.setData).not.toHaveBeenCalled(); expect(writeText).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('Could not copy the picture');
  expect(wb.canUndo()).toBe(false);
});

it.each([true, false])('copies negative bars with inversion=%s using the shared SVG rendering', async invertIfNegative => {
  const { viewport, wb, id } = await mount('column'), ch = wb.activeSheet.charts[0];
  wb.updateChart(id, ch.id, { colors: ['#2468ac'], appearance: { bars: [{ invertIfNegative, negativeColor: '#ff00aa', stroke: '#cc2244', strokeWidth: 2 }] } });
  await vi.advanceTimersByTimeAsync(1);
  const sources = [];
  vi.stubGlobal('Blob', class extends Blob {
    constructor(parts, options) {
      super(parts, options);
      if (options?.type?.split(';')[0] === 'image/svg+xml') sources.push(parts.join(''));
    }
  });
  copyEvent(viewport); await vi.advanceTimersByTimeAsync(5);
  expect(write).toHaveBeenCalledTimes(1);
  const root = new DOMParser().parseFromString(sources[0], 'image/svg+xml');
  const negative = root.querySelector('.chart-column');
  expect(negative.getAttribute('fill')).toBe(invertIfNegative ? '#ff00aa' : '#2468ac');
  expect(negative.getAttribute('stroke')).toBe('#cc2244');
});

it('copies the same automatic range and headroom used by the visible chart', async () => {
  const { viewport, wb, id } = await mount('column'), ch = wb.activeSheet.charts[0];
  wb.setInput(id,0,1,'25'); wb.setInput(id,1,1,'160');
  wb.updateChart(id,ch.id,{appearance:{yStyle:{color:'#123456'},yFormat:'0'}});
  await vi.advanceTimersByTimeAsync(1);
  const sources = [];
  vi.stubGlobal('Blob',class extends Blob { constructor(parts,options) { super(parts,options); if(options?.type?.split(';')[0]==='image/svg+xml') sources.push(parts.join('')); } });
  copyEvent(viewport); await vi.advanceTimersByTimeAsync(5);
  expect(write).toHaveBeenCalledTimes(1); expect(sources).toHaveLength(1);
  const root=new DOMParser().parseFromString(sources[0],'image/svg+xml');
  const ticks=[...root.querySelectorAll('text[fill="#123456"]')].map(n=>Number(n.textContent));
  // The axis the sheet shows: its top tick clears the data with Excel's headroom (its major unit widened
  // to keep the labels apart up this short plot), and the copied picture has the same.
  const shown=[...view.el.querySelectorAll('.chart-box svg text[fill="#123456"]')].map(n=>Number(n.textContent));
  expect(Math.max(...ticks)).toBe(Math.max(...shown));
  expect(Math.max(...ticks)).toBeGreaterThanOrEqual(160);
  expect(wb.activeSheet.charts[0].yMax).toBeNull();
});

it('keeps next-to-axis labels visible over negative bars in copied chart pictures', async () => {
  const { viewport, wb, id } = await mount('column'), chart = wb.activeSheet.charts[0];
  wb.setInput(id, 0, 0, 'First'); wb.setInput(id, 1, 1, '-1');
  wb.updateChart(id, chart.id, { appearance: { xLabelPosition: 'nextTo', xRotationAuto: false, axisStyles: { x: { color: '#000000' } } } });
  await vi.advanceTimersByTimeAsync(1);
  const sources = [];
  vi.stubGlobal('Blob', class extends Blob {
    constructor(parts, options) { super(parts, options); if (options?.type?.split(';')[0] === 'image/svg+xml') sources.push(parts.join('')); }
  });
  copyEvent(viewport); await vi.advanceTimersByTimeAsync(5);
  expect(write).toHaveBeenCalledTimes(1);
  const root = new DOMParser().parseFromString(sources[0], 'image/svg+xml');
  const label = [...root.querySelectorAll('text')].find(n => n.textContent === 'Second');
  const axis = root.querySelector('.chart-axis-line.chart-axis-x');
  const plot = root.querySelector('clipPath rect');
  expect(+label.getAttribute('y')).toBeGreaterThan(+axis.getAttribute('y1'));
  expect(+label.getAttribute('y')).toBeLessThan(+plot.getAttribute('y') + +plot.getAttribute('height') / 2);
  expect(root.querySelector('.chart-column').compareDocumentPosition(label) & 4).toBe(4);
  expect(label.parentElement.tagName).toBe('svg');
});

it('copies custom crossings and column baselines into chart pictures', async () => {
  const { viewport, wb, id } = await mount('column'), chart = wb.activeSheet.charts[0];
  wb.updateChart(id, chart.id, { yMin: -10, yMax: 10, appearance: { axisCrossings: { x: 5, y: 'max' },
    axisStyles: { x: { color: '#000000' }, y: { color: '#000000' } } } });
  await vi.advanceTimersByTimeAsync(1);
  const sources = [];
  vi.stubGlobal('Blob', class extends Blob {
    constructor(parts, options) { super(parts, options); if (options?.type?.split(';')[0] === 'image/svg+xml') sources.push(parts.join('')); }
  });
  copyEvent(viewport); await vi.advanceTimersByTimeAsync(5);
  expect(write).toHaveBeenCalledTimes(1);
  const root = new DOMParser().parseFromString(sources[0], 'image/svg+xml');
  const axis = root.querySelector('.chart-axis-line.chart-axis-x');
  const bars = [...root.querySelectorAll('.chart-column')];
  expect(bars.length).toBeGreaterThan(0);
  for (const bar of bars) expect(+bar.getAttribute('y')).toBeCloseTo(+axis.getAttribute('y1'));
  expect(wb.activeSheet.charts[0].appearance.axisCrossings).toEqual({ x: 5, y: 'max' });
});

it('copies styled area fills into the chart picture', async () => {
  const { viewport, wb, id } = await mount('area'), chart = wb.activeSheet.charts[0];
  wb.updateChart(id, chart.id, { appearance: { axisCrossings: { x: 2 } } });
  await vi.advanceTimersByTimeAsync(1);
  const sources = [];
  vi.stubGlobal('Blob', class extends Blob {
    constructor(parts, options) { super(parts, options); if (options?.type?.split(';')[0] === 'image/svg+xml') sources.push(parts.join('')); }
  });
  copyEvent(viewport); await vi.advanceTimersByTimeAsync(5);
  expect(write).toHaveBeenCalledTimes(1);
  const root = new DOMParser().parseFromString(sources[0], 'image/svg+xml');
  expect(root.querySelectorAll('.chart-area')).toHaveLength(1);
  expect(root.querySelector('.chart-area').getAttribute('d')).toMatch(/ Z$/);
  expect(root.querySelector('.chart-area').getAttribute('fill')).not.toBe('none');
});

it('includes multiline category labels in copied chart pictures', async () => {
  const { viewport, wb, id } = await mount('column'), ch = wb.activeSheet.charts[0];
  wb.setInput(id, 1, 0, 'Second\ncategory');
  wb.updateChart(id, ch.id, { appearance: { xWrap: 'none', xRotation: 35, xLabelSkip: 1 } });
  await vi.advanceTimersByTimeAsync(1);
  const sources = [];
  vi.stubGlobal('Blob', class extends Blob {
    constructor(parts, options) {
      super(parts, options);
      if (options?.type?.split(';')[0] === 'image/svg+xml') sources.push(parts.join(''));
    }
  });
  copyEvent(viewport); await vi.advanceTimersByTimeAsync(5);
  expect(write).toHaveBeenCalledTimes(1);
  const root = new DOMParser().parseFromString(sources[0], 'image/svg+xml');
  const label = root.querySelector('text[aria-label="Second category"]');
  expect([...label.querySelectorAll('tspan')].map(n => n.textContent)).toEqual(['Second', 'category']);
  expect(label.getAttribute('transform')).toContain('rotate(35 ');
});

it('copies saved date bounds and sparse calendar spacing into chart pictures', async () => {
  const { viewport, wb, id } = await mount('column'), ch = wb.activeSheet.charts[0];
  wb.updateChart(id, ch.id, { sourceRefs: [{ name: 'Dates', literal: { categories: [45000, 45009], values: [2, 4] } }],
    appearance: { dateAxis: true, xMin: 44996, xMax: 45014, xStep: 3, xFormat: 'yyyy-mm-dd',
      plot: { x: .2, y: .2, w: .6, h: .6 } } });
  await vi.advanceTimersByTimeAsync(1);
  const sources = [];
  vi.stubGlobal('Blob', class extends Blob {
    constructor(parts, options) { super(parts, options); if (options?.type?.split(';')[0] === 'image/svg+xml') sources.push(parts.join('')); }
  });
  copyEvent(viewport); await vi.advanceTimersByTimeAsync(5);
  expect(write).toHaveBeenCalledTimes(1);
  const root = new DOMParser().parseFromString(sources[0], 'image/svg+xml');
  const bars = [...root.querySelectorAll('.chart-column')], plot = root.querySelector('clipPath rect');
  expect(bars).toHaveLength(2);
  expect(+bars[1].getAttribute('x') - +bars[0].getAttribute('x')).toBeCloseTo(+plot.getAttribute('width') * 9 / 19, 1);
  expect(root.documentElement.textContent).toContain('2023-03-11');
  expect(root.documentElement.textContent).toContain('2023-03-29');
});

it.each(['low', 'none'])('copies independent secondary %s tick labels into chart pictures', async position => {
  const { viewport, wb, id } = await mount('combo'), chart = wb.activeSheet.charts[0];
  wb.updateChart(id, chart.id, { secondaryAxis: true,
    sourceRefs: [{ name: 'Columns', literal: { categories: ['A', 'B'], values: [20, 80] } },
      { name: 'Line', literal: { categories: ['A', 'B'], values: [2, 8] } }],
    appearance: { yLabelPosition: 'none', y2LabelPosition: position, reverseCategories: true,
      y2Min: 0, y2Max: 10, y2Step: 2, y2Style: { color: '#cc2255' }, axisStyles: { y2: { color: '#cc2255' } } } });
  await vi.advanceTimersByTimeAsync(1);
  const sources = [];
  vi.stubGlobal('Blob', class extends Blob {
    constructor(parts, options) { super(parts, options); if (options?.type?.split(';')[0] === 'image/svg+xml') sources.push(parts.join('')); }
  });
  copyEvent(viewport); await vi.advanceTimersByTimeAsync(5);
  expect(write).toHaveBeenCalledTimes(1);
  const root = new DOMParser().parseFromString(sources[0], 'image/svg+xml');
  const labels = [...root.querySelectorAll('text[fill="#cc2255"]')], plot = root.querySelector('clipPath rect');
  expect(labels).toHaveLength(position === 'none' ? 0 : 6);
  expect(root.querySelector('.chart-axis-line.chart-axis-y2')).not.toBeNull();
  for (const label of labels) expect(+label.getAttribute('x')).toBeGreaterThan(+plot.getAttribute('x') + +plot.getAttribute('width'));
});

it.each(['hideYAxis', 'hideY2Axis'])('copies independent %s deletion and shared series scaling', async hidden => {
  const { viewport, wb, id } = await mount('combo'), chart = wb.activeSheet.charts[0];
  wb.updateChart(id, chart.id, { secondaryAxis: true, yMin: 0, yMax: 1000,
    sourceRefs: [{ name: 'Columns', literal: { categories: ['A', 'B'], values: [20, 80] } },
      { name: 'Line', literal: { categories: ['A', 'B'], values: [2, 8] } }],
    appearance: { [hidden]: true, y2Min: 0, y2Max: 100,
      axisStyles: { y: { color: '#336699' }, y2: { color: '#cc2255' } } } });
  await vi.advanceTimersByTimeAsync(1);
  const sources = [];
  vi.stubGlobal('Blob', class extends Blob {
    constructor(parts, options) { super(parts, options); if (options?.type?.split(';')[0] === 'image/svg+xml') sources.push(parts.join('')); }
  });
  copyEvent(viewport); await vi.advanceTimersByTimeAsync(5);
  expect(write).toHaveBeenCalledTimes(1);
  const root = new DOMParser().parseFromString(sources[0], 'image/svg+xml'), plot = root.querySelector('clipPath rect');
  expect(root.querySelector('.chart-axis-line.chart-axis-y') == null).toBe(hidden === 'hideYAxis');
  expect(root.querySelector('.chart-axis-line.chart-axis-y2') == null).toBe(hidden === 'hideY2Axis');
  expect(+root.querySelector('.chart-column').getAttribute('height')).toBeCloseTo((+plot.getAttribute('height') - 2) * 20 / (hidden === 'hideYAxis' ? 100 : 1000), 1);
});

it('preserves reversed value geometry in copied chart pictures', async () => {
  const { viewport, wb, id } = await mount('column'), ch = wb.activeSheet.charts[0];
  wb.updateChart(id, ch.id, { yMin: -4, yMax: 4, appearance: { reverseValues: true, xRotationAuto: false,
    plot: { x: .2, y: .2, w: .6, h: .6 } } });
  await vi.advanceTimersByTimeAsync(1);
  const sources = [];
  vi.stubGlobal('Blob', class extends Blob {
    constructor(parts, options) { super(parts, options); if (options?.type?.split(';')[0] === 'image/svg+xml') sources.push(parts.join('')); }
  });
  copyEvent(viewport); await vi.advanceTimersByTimeAsync(5);
  expect(write).toHaveBeenCalledTimes(1);
  const root = new DOMParser().parseFromString(sources[0], 'image/svg+xml');
  const marks = [...root.querySelectorAll('.chart-column')];
  expect(marks).toHaveLength(2);
  // The negative column ends above zero; the positive column starts there.
  expect(+marks[0].getAttribute('y') + +marks[0].getAttribute('height')).toBeCloseTo(+marks[1].getAttribute('y'));
  expect(+marks[0].getAttribute('y')).toBeLessThan(+marks[1].getAttribute('y'));
});

it('copies the transferred automatic range of a deleted primary axis', async () => {
  const { viewport, wb, id } = await mount('combo'), chart = wb.activeSheet.charts[0];
  wb.updateChart(id, chart.id, { secondaryAxis: true, yMin: null, yMax: null,
    sourceRefs: [{ name: 'Columns', literal: { categories: ['A', 'B'], values: [50, 170] } },
      { name: 'Line', literal: { categories: ['A', 'B'], values: [2, 8] } }],
    appearance: { hideYAxis: true, y2Step: 20, y2Style: { color: '#cc2255' } } });
  await vi.advanceTimersByTimeAsync(1);
  const sources = [];
  vi.stubGlobal('Blob', class extends Blob {
    constructor(parts, options) { super(parts, options); if (options?.type?.split(';')[0] === 'image/svg+xml') sources.push(parts.join('')); }
  });
  copyEvent(viewport); await vi.advanceTimersByTimeAsync(5);
  expect(write).toHaveBeenCalledTimes(1);
  const root = new DOMParser().parseFromString(sources[0], 'image/svg+xml'), plot = root.querySelector('clipPath rect');
  const ticks = [...root.querySelectorAll('text[fill="#cc2255"]')].map(e => Number(e.textContent));
  expect(ticks.at(-1)).toBe(200);
  expect(+root.querySelector('.chart-column').getAttribute('height')).toBeCloseTo((+plot.getAttribute('height') - 2) * 50 / 200, 1);
});

it('copies the live secondary title without replacing the primary title', async () => {
  const {viewport,wb,id}=await mount('combo'), chart=wb.activeSheet.charts[0];
  wb.setInput(id,0,4,'Live secondary');
  wb.updateChart(id,chart.id,{secondaryAxis:true,yTitle:'Primary title',y2Title:'Old cache',y2TitleRef:'E1',
    sourceRefs:[{name:'Amount',literal:{categories:['A','B'],values:[20,80]}},
      {name:'Rate',literal:{categories:['A','B'],values:[2,8]}}],appearance:{hideY2Axis:true}});
  await vi.advanceTimersByTimeAsync(1);
  const sources=[];
  vi.stubGlobal('Blob',class extends Blob { constructor(parts,options) {
    super(parts,options);if(options?.type?.split(';')[0]==='image/svg+xml')sources.push(parts.join(''));
  }});
  copyEvent(viewport);await vi.advanceTimersByTimeAsync(5);
  expect(write).toHaveBeenCalledTimes(1);expect(sources).toHaveLength(1);
  expect(sources[0]).toContain('>Primary title</text>');expect(sources[0]).toContain('>Live secondary</text>');
  expect(sources[0]).not.toContain('Old cache');
});

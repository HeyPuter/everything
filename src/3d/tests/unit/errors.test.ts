// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { reportUncaught, resetErrorReports } from '../../src/app/errors';

beforeEach(() => {
  setApp(new App(startupDocument()));
  resetErrorReports();
});

const errors = () => app.reports.filter((r) => r.type === 'ERROR').map((r) => r.message);

describe('uncaught error reports', () => {
  it('reports an error once while it keeps repeating (a per-frame error)', () => {
    for (let i = 0; i < 100; i++) reportUncaught(new Error('boom'), 1000 + i * 16);
    expect(errors()).toEqual(['Internal error: boom (details in the browser console)']);
    // much later it is reported again
    reportUncaught(new Error('boom'), 1000 + 60000);
    expect(errors()).toHaveLength(2);
  });

  it('reports only a few different errors a minute', () => {
    for (let i = 0; i < 20; i++) reportUncaught(new Error(`e${i}`), 5000 + i);
    expect(errors()).toHaveLength(5);
    reportUncaught(new Error('later'), 5000 + 61000);
    expect(errors()).toHaveLength(6);
  });

  it('describes rejections that are not errors', () => {
    reportUncaught('quota exceeded', 0);
    reportUncaught({ code: 7 }, 0);
    expect(errors()[0]).toContain('quota exceeded');
    expect(errors()[1]).toContain('{"code":7}');
  });
});

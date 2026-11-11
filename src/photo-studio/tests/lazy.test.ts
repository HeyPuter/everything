import { describe, expect, it, vi } from 'vitest';
import { lazy, lazyPanel, lazyRun, lazyTool, loadError, startIdleWork, whenIdle } from '../src/app/lazy';
import type { Editor } from '../src/editor';
import type { CanvasPointer } from '../src/app/pointer';
import type { Tool } from '../src/app/registry';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('lazy modules', () => {
  it('loads once and exposes the loaded module', async () => {
    const load = vi.fn(async () => ({ value: 42 }));
    const mod = lazy(load);
    expect(mod.loaded).toBeUndefined();
    const [a, b] = await Promise.all([mod(), mod()]);
    expect(a).toBe(b);
    expect(mod.loaded).toBe(a);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('retries a failed load on the next use', async () => {
    let fail = true;
    const mod = lazy(async () => {
      if (fail) throw new Error('offline');
      return { ok: true };
    });
    await expect(mod()).rejects.toThrow('offline');
    fail = false;
    expect(await mod()).toEqual({ ok: true });
  });

  it('explains a module that could not be fetched instead of showing its URL', async () => {
    let fail = true;
    const mod = lazy(async () => {
      if (fail) throw new TypeError('Failed to fetch dynamically imported module: https://example.com/assets/dialog-3f2a.js');
      return { ok: true };
    });
    const error = await mod().catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).message).toMatch(/could not be loaded.*reload the page/);
    expect((error as Error).message).not.toContain('https://');
    expect((error as Error).cause).toBeInstanceOf(TypeError);
    fail = false;
    expect(await mod()).toEqual({ ok: true });
    // Firefox and Safari word it differently; errors of the module itself pass through.
    expect((loadError(new TypeError('error loading dynamically imported module: x.js')) as Error).message).toMatch(/could not be loaded/);
    expect((loadError(new TypeError('Importing a module script failed.')) as Error).message).toMatch(/could not be loaded/);
    const own = new RangeError('bad size');
    expect(loadError(own)).toBe(own);
  });

  it('prefetches without surfacing errors', async () => {
    const mod = lazy(async () => {
      throw new Error('missing');
    });
    expect(() => mod.prefetch()).not.toThrow();
    await tick();
  });

  it('runs commands from the loaded module with their argument', async () => {
    const run = vi.fn();
    const mod = lazy(async () => ({ run }));
    const fields = lazyRun(mod, (m, e, arg) => m.run(e, arg));
    const e = {} as Editor;
    await fields.run(e, 'x');
    expect(run).toHaveBeenCalledWith(e, 'x');
    expect(fields.prefetch).toBe(mod.prefetch);
  });

  it('runs idle tasks in order once startup has finished', async () => {
    const order: number[] = [];
    whenIdle(() => order.push(1));
    whenIdle(() => order.push(2));
    await new Promise((r) => setTimeout(r, 120));
    expect(order).toEqual([]);
    startIdleWork();
    await new Promise((r) => setTimeout(r, 200));
    expect(order).toEqual([1, 2]);
  });
});

describe('lazy tools and panels', () => {
  const editor = (tool: string) => ({ tool, options: vi.fn(), overlay: vi.fn(), message: vi.fn() }) as unknown as Editor;
  const p = (x: number) => ({ x, y: 0 }) as CanvasPointer;

  it('replays pointer input that arrives before the tool loads', async () => {
    const seen: string[] = [];
    const impl: Tool = {
      id: 't',
      label: 'T',
      icon: 'x',
      group: 'g',
      activate: () => seen.push('activate'),
      pointerDown: (_e, q) => void seen.push(`down ${q.x}`),
      pointerMove: (_e, q) => void seen.push(`move ${q.x}`),
      pointerUp: (_e, q) => void seen.push(`up ${q.x}`),
      options: () => '<b>loaded</b>',
    };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tool = lazyTool({ id: 't', label: 'T', icon: 'x', group: 'g' }, lazy(async () => (await gate, impl)));
    const e = editor('t');
    tool.activate!(e);
    expect(tool.options!(e)).toBe('');
    tool.pointerDown!(e, p(1));
    tool.pointerMove!(e, p(2));
    tool.pointerUp!(e, p(3));
    expect(seen).toEqual([]);
    release();
    await tick();
    expect(seen).toEqual(['activate', 'down 1', 'move 2', 'up 3']);
    expect(e.options).toHaveBeenCalled();
    expect(tool.options!(e)).toBe('<b>loaded</b>');
    tool.pointerMove!(e, p(4));
    expect(seen.at(-1)).toBe('move 4');
  });

  it('mounts a panel once its module has loaded', async () => {
    const mount = vi.fn((_e: Editor, el: HTMLElement) => (el.textContent = 'mounted'));
    const update = vi.fn();
    const panel = lazyPanel({ id: 'p', title: 'P', icon: 'x', location: 'strip' }, lazy(async () => ({ mount, update })));
    const el = { classList: { add: vi.fn(), remove: vi.fn() }, isConnected: true, textContent: '' } as unknown as HTMLElement;
    const e = editor('move');
    panel.mount(e, el);
    panel.update!(e, el);
    expect(mount).not.toHaveBeenCalled();
    await tick();
    expect(mount).toHaveBeenCalledWith(e, el);
    expect(update).toHaveBeenCalledTimes(1);
    panel.update!(e, el);
    expect(update).toHaveBeenCalledTimes(2);
  });
});

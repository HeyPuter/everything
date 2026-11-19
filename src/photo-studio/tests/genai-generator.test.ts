// The Generate button of the generative layout dialogs (AI Recompose, Remove
// Reflections, Rotate Object): it offers to run again only once a run has
// delivered results.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/features/retouch/ai', () => ({ ensureSignedIn: async () => {} }));

const { Generator } = await import('../src/features/genai/shared');

function setup() {
  const button = { textContent: 'Generate' } as HTMLButtonElement;
  const status = { className: '', textContent: '' } as HTMLElement;
  const gen = new Generator(button, status, { idle: 'Generate', again: 'Regenerate' });
  return { button, status, gen };
}
/** A run that waits until it is released; returns its result then. */
function pending<T>(value: T) {
  let release!: () => void;
  const ready = new Promise<void>((r) => (release = r));
  return { work: async () => (await ready, value), release };
}

describe('Generator', () => {
  it('Stop before any result keeps the button saying Generate', async () => {
    const { button, status, gen } = setup();
    const run = pending(1);
    const done = vi.fn();
    const started = gen.toggle(run.work, done);
    expect(button.textContent).toBe('Stop');
    gen.stop();
    expect(button.textContent).toBe('Generate');
    expect(status.textContent).toMatch(/Stopped/);
    run.release();
    await started;
    expect(done).not.toHaveBeenCalled();
    expect(button.textContent).toBe('Generate');
  });

  it('a failed run keeps Generate; a run with results turns it into Regenerate, also after a later Stop', async () => {
    const { button, gen } = setup();
    await gen.toggle(async () => {
      throw new Error('The service is busy.');
    }, vi.fn());
    expect(button.textContent).toBe('Generate');
    await gen.toggle(async () => 1, vi.fn());
    expect(button.textContent).toBe('Regenerate');
    const run = pending(2);
    const started = gen.toggle(run.work, vi.fn());
    expect(button.textContent).toBe('Stop');
    gen.stop();
    expect(button.textContent).toBe('Regenerate');
    run.release();
    await started;
  });

  it('reset (results cleared for a new object) goes back to Generate', async () => {
    const { button, gen } = setup();
    await gen.toggle(async () => 1, vi.fn());
    expect(button.textContent).toBe('Regenerate');
    gen.reset();
    expect(button.textContent).toBe('Generate');
    expect(gen.running).toBe(false);
  });
});

// Long-running tracking jobs (track sequence, prefetch, detect, export) run as modal operations:
// the UI keeps drawing, Esc stops the job and the work done so far is kept as one undo step.
import { app } from '../app/app';

export interface Job {
  label: string;
  progress: number;
  cancelled: boolean;
  /** current step, shown after the progress */
  detail?: string;
}

let current: Job | null = null;
const listeners = new Set<() => void>();

export const jobState = {
  get: () => current,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function setProgress(job: Job, p: number) {
  job.progress = Math.max(0, Math.min(1, p));
  for (const fn of listeners) fn();
  app.changed('ui');
}

/**
 * Run an async job. With `undo` the job runs modally (Esc cancels) and finishes with an undo
 * step named after the job.
 */
export async function runJob(label: string, fn: (job: Job) => Promise<string | void>, opts: { undo?: boolean } = {}): Promise<boolean> {
  if (current) {
    app.report('WARNING', `${current.label} is still running`);
    return false;
  }
  const job: Job = { label, progress: 0, cancelled: false };
  current = job;
  const undo = opts.undo !== false;
  if (undo)
    app.startModal({
      label,
      onKey: (e) => {
        if (e.type === 'keydown' && e.key === 'Escape') job.cancelled = true;
        return true;
      },
      cancel: () => {},
      header: () => `${label}… ${Math.round(job.progress * 100)}%${job.detail ? ` (${job.detail})` : ''}`,
      status: () => [['Esc', 'Stop']],
    });
  let ok = true;
  try {
    const msg = await fn(job);
    if (msg) app.report('INFO', msg);
  } catch (e) {
    ok = false;
    app.report('ERROR', `${label}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    current = null;
    if (undo && app.modal) app.endModal('FINISHED');
    for (const f of listeners) f();
    app.changed('doc', 'ui');
  }
  return ok;
}

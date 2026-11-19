// App-wide busy state for long operations (applying effects, mixdowns,
// exports, analysis): while any runs, <html data-busy> shows a thin moving
// line under the toolbar and a progress cursor, so work in the background is
// visible even when its own progress dialog has not appeared yet (short tasks)
// or sits in a panel out of view.

let count = 0;

function paint() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (count > 0) root.dataset.busy = '';
  else delete root.dataset.busy;
}

/** Marks the app busy until the returned function is called (safe to call twice). */
export function beginBusy() {
  count += 1;
  paint();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    count = Math.max(0, count - 1);
    paint();
  };
}

/** Runs `work()` with the app marked busy. */
export async function whileBusy(work) {
  const end = beginBusy();
  try {
    return await work();
  } finally {
    end();
  }
}

/** True while any long operation runs. */
export function isBusy() {
  return count > 0;
}

// Downloads to the user's device and local file selection (no Puter involved).

/** Saves a Blob through the browser's download flow. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  // Revoke later: some browsers read the URL after click returns.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * Opens the system file chooser. Resolves File[] (empty when the user
 * cancels, in browsers that report it).
 */
export function chooseFiles({ accept = '', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    let done = false;
    const finish = (files) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish([...(input.files || [])]));
    input.addEventListener('cancel', () => finish([]));
    document.body.append(input);
    input.click();
  });
}

/** A file name safe on every desktop OS (no path separators or reserved characters). */
export function safeFileName(name, fallback = 'Untitled') {
  const s = String(name || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 100);
  return s || fallback;
}

/** "name.ext" -> "name". */
export function stripExtension(name = '') {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

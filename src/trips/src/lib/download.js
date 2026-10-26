/** Saves `blob` through the browser's download as `name`. */
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: name, rel: 'noopener' });
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers read the URL after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Zips a package's parts off the page's thread (package-zip.js): the parts arrive copied, the ZIP goes back moved.
import { zipPackage } from './package-part-paths.js';

self.onmessage = ({ data: { id, parts } }) => {
  try {
    const zipped = zipPackage(parts);
    self.postMessage({ id, zipped }, [zipped.buffer]);
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || error) });
  }
};
self.postMessage({ ready: true });

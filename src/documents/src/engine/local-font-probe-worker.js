// Answers whether a local() font source loads, off the page's thread (see local-font-probe.js).
// It registers nothing: the face is loaded and dropped. null means this worker cannot load fonts.
self.onmessage = async ({ data: { id, source } }) => {
  if (typeof FontFace === 'undefined') { self.postMessage({ id, found: null }); return; }
  let found = false;
  try { await new FontFace('Documents local font probe', source).load(); found = true; } catch { /* not installed */ }
  self.postMessage({ id, found });
};
self.postMessage({ ready: true });

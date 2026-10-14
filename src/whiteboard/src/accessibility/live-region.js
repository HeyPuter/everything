// A modal dialog makes the rest of the page inert, its live regions
// included, so what they say would go unheard while one is open. The same
// words are said as well by a region inside the topmost modal dialog, one
// for each page region so that neither cuts the other off. Those regions
// are added as the dialog opens, since one added with its words is often
// not read, and otherwise a moment before them.
const CLASS = "dialog-announcer";

function topModal(doc) {
  const dialog = [...doc.querySelectorAll("dialog[open]")].at(-1);
  try {
    return dialog?.matches(":modal") ? dialog : null;
  } catch {
    return null;
  }
}
const mirror = (dialog, id) =>
  [...dialog.children].find(
    (el) => el.classList.contains(CLASS) && el.dataset.for === id,
  );
function regionIn(dialog, id) {
  let region = mirror(dialog, id);
  if (!region) {
    region = dialog.ownerDocument.createElement("p");
    region.className = `${CLASS} sr-only`;
    region.dataset.for = id;
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    dialog.append(region);
  }
  return region;
}
// Adds the regions to each modal dialog as it opens, one for each of the
// page regions named.
export function watchDialogs(ids, doc = document) {
  doc.addEventListener(
    "toggle",
    (e) => {
      if (e.newState !== "open" || e.target.localName !== "dialog") return;
      if (topModal(doc) === e.target)
        for (const id of ids) regionIn(e.target, id);
    },
    true,
  );
}
// Says a message through a page region, and through the topmost modal
// dialog's own when the page region is behind it. Emptied first, so the
// same words said twice are read twice.
export function say(region, message, { html = false, delay = 0 } = {}) {
  if (!region) return;
  const dialog = topModal(region.ownerDocument);
  const regions = [region];
  let wait = delay;
  if (dialog && !dialog.contains(region)) {
    const fresh = !mirror(dialog, region.id);
    regions.push(regionIn(dialog, region.id));
    if (fresh) wait = Math.max(wait, 150);
  }
  const write = () => {
    for (const r of regions) {
      if (!r.isConnected) continue;
      if (html) r.innerHTML = message;
      else r.textContent = message;
    }
  };
  for (const r of regions) r.textContent = "";
  if (wait) setTimeout(write, wait);
  else write();
}

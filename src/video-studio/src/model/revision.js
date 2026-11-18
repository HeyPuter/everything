/** Runtime edit generations for derived caches; never serialized into a project file. */
const revisions = new WeakMap();

export const projectRevision = (project) => revisions.get(project) || 0;

export function bumpProjectRevision(project) {
  revisions.set(project, projectRevision(project) + 1);
}

/**
 * Source containment classification — keeps registered sources non-overlapping.
 *
 * Adding a folder that's already inside (or that contains) a registered source
 * would silently double-ingest the same files under two sources. Instead of
 * adding a duplicate, the add flow detects the overlap and either folds the
 * subfolder into its parent (refresh the parent → one source) or warns that the
 * new folder contains existing sources.
 *
 * Operates on REAL (symlink-resolved) paths so a benign-looking symlink can't
 * dodge the check, and uses a path-boundary test so `/Documents-old` is NOT
 * considered inside `/Documents`.
 */

export type Containment =
  | { kind: "none" }
  | { kind: "inside"; parentPath: string }
  | { kind: "contains"; childPaths: string[] };

export type SourceEntry = { path: string; real: string };

function isStrictlyInside(childReal: string, parentReal: string): boolean {
  if (childReal === parentReal) return false;
  const prefix = parentReal.endsWith("/") ? parentReal : `${parentReal}/`;
  return childReal.startsWith(prefix);
}

export function classifyContainment(newReal: string, existing: SourceEntry[]): Containment {
  // New path is the same as, or inside, an existing source → fold into that parent.
  for (const e of existing) {
    if (newReal === e.real || isStrictlyInside(newReal, e.real)) {
      return { kind: "inside", parentPath: e.path };
    }
  }
  // New path contains one or more existing sources → adding it would duplicate them.
  const children = existing.filter((e) => isStrictlyInside(e.real, newReal));
  if (children.length > 0) {
    return { kind: "contains", childPaths: children.map((c) => c.path) };
  }
  return { kind: "none" };
}

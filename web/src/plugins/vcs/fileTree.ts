/** A folder of the Changes tree: a chain of folders that hold only one folder is one row (`server/src/agent`). */
export type TreeDir<F> = { kind: 'dir'; path: string; name: string; dirs: TreeDir<F>[]; files: F[] };

/** The changed files as a folder tree: folders first, then files, each by name. */
export function fileTree<F extends { path: string }>(files: F[]): TreeDir<F> {
  const root: TreeDir<F> = { kind: 'dir', path: '', name: '', dirs: [], files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let at = root;
    for (const name of parts.slice(0, -1)) {
      const path = at.path ? `${at.path}/${name}` : name;
      let next = at.dirs.find((d) => d.path === path);
      if (!next) at.dirs.push((next = { kind: 'dir', path, name, dirs: [], files: [] }));
      at = next;
    }
    at.files.push(f);
  }
  const byName = (a: string, b: string) => a.localeCompare(b);
  const tidy = (d: TreeDir<F>): TreeDir<F> => {
    let cur = d;
    // fold a folder holding just one folder into it (never the root)
    while (cur.path && cur.files.length === 0 && cur.dirs.length === 1) {
      const only = cur.dirs[0]!;
      cur = { ...only, name: `${cur.name}/${only.name}` };
    }
    return {
      ...cur,
      dirs: cur.dirs.map(tidy).sort((a, b) => byName(a.name, b.name)),
      files: [...cur.files].sort((a, b) => byName(a.path, b.path)),
    };
  };
  return tidy(root);
}

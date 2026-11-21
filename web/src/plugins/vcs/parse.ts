export type Row = { t: ' ' | '+' | '-'; o?: number; n?: number; s: string };
export type Hunk = { head: string; rows: Row[] };
export type ParsedPatch = { add: number; del: number; binary: boolean; hunks: Hunk[] };

/** One file's unified patch into hunks. Its name comes from the list row, never from here: a patch quotes unusual names. */
export function parsePatch(patch: string): ParsedPatch {
  const f: ParsedPatch = { add: 0, del: 0, binary: false, hunks: [] };
  let h: Hunk | null = null, o = 0, n = 0;
  for (const l of patch.split('\n')) {
    if (!h && l.startsWith('Binary files')) f.binary = true;
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m) { h = { head: l, rows: [] }; f.hunks.push(h); o = +m[1]!; n = +m[2]!; continue; }
    if (!h) continue;
    const c = l[0];
    if (c === '+') { h.rows.push({ t: '+', n: n++, s: l.slice(1) }); f.add++; }
    else if (c === '-') { h.rows.push({ t: '-', o: o++, s: l.slice(1) }); f.del++; }
    else if (c === ' ') h.rows.push({ t: ' ', o: o++, n: n++, s: l.slice(1) });
  }
  return f;
}

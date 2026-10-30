import { diff3Merge } from "node-diff3";

/** Lines with their line endings attached, so "\r\n" and a missing final newline survive. */
const lines = (s: string) => s.split(/(?<=\n)/);

/**
 * Line-based three-way merge of a note changed here and in Tome (the same rules as Tome's own
 * editor, src/lib/merge.ts). null: both sides changed the same lines.
 */
export function mergeText(base: string, mine: string, theirs: string): string | null {
  if (mine === theirs || theirs === base) return mine;
  if (mine === base) return theirs;
  let out = "";
  for (const block of diff3Merge(lines(mine), lines(base), lines(theirs), { excludeFalseConflicts: true })) {
    if (block.ok) out += block.ok.join("");
    else return null;
  }
  return out;
}

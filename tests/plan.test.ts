import { describe, expect, it } from "vitest";
import { normalizeServer } from "../src/auth";
import { mergeText } from "../src/merge";
import { conflictName, hidden, portable, syncable } from "../src/paths";
import { plan, type Entry, type LocalFile, type RemoteFile, type State } from "../src/plan";

// The same cases as the desktop app's sync.rs, so both behave alike.
const e = (hash: string, tag: string | null): Entry => ({ hash, rev: `rev-${hash}`, tag, size: 1, mtime: 1 });
const l = (hash: string): LocalFile => ({ hash, size: 1, mtime: 1 });
const r = (tag: string): RemoteFile => ({ tag, size: 1 });
const map = <T>(pairs: [string, T][]) => new Map(pairs);

describe("sync plan", () => {
  it("decides each case", () => {
    const s: State = { files: {} };
    for (const p of ["same.md", "mine.md", "theirs.md", "both.md", "gone-here.md", "gone-there.md", "gone-both.md", "edited-gone.md", "deleted-edited.md"]) s.files[p] = e("a", "t1");
    const local = map<LocalFile>([["same.md", l("a")], ["mine.md", l("b")], ["theirs.md", l("a")], ["both.md", l("b")], ["gone-there.md", l("a")], ["edited-gone.md", l("b")], ["new-here.md", l("n")], ["new-both.md", l("n")]]);
    const remote = map<RemoteFile>([["same.md", r("t1")], ["mine.md", r("t1")], ["theirs.md", r("t2")], ["both.md", r("t2")], ["gone-here.md", r("t1")], ["deleted-edited.md", r("t2")], ["new-there.md", r("x")], ["new-both.md", r("y")]]);
    expect(plan(s, local, remote, false)).toEqual([
      { kind: "merge", path: "both.md" },
      { kind: "download", path: "deleted-edited.md", known: null },
      { kind: "upload", path: "edited-gone.md", base: null },
      { kind: "forget", path: "gone-both.md" },
      { kind: "deleteRemote", path: "gone-here.md", rev: "rev-a" },
      { kind: "deleteLocal", path: "gone-there.md" },
      { kind: "upload", path: "mine.md", base: "rev-a" },
      { kind: "merge", path: "new-both.md" },
      { kind: "upload", path: "new-here.md", base: null },
      { kind: "download", path: "new-there.md", known: null },
      { kind: "download", path: "theirs.md", known: "rev-a" },
    ]);
  });

  it("checks an unknown tag instead of assuming", () => {
    const s: State = { files: { "up.md": e("a", null), "gone.md": e("g", null) } };
    expect(plan(s, map([["up.md", l("a")]]), map([["up.md", r("t9")], ["gone.md", r("t9")]]), false)).toEqual([
      { kind: "deleteRemote", path: "gone.md", rev: "rev-g" },
      { kind: "download", path: "up.md", known: "rev-a" },
    ]);
  });

  it("never writes to Tome when the vault is view-only", () => {
    const s: State = { files: { "a.md": e("a", "t1"), "b.md": e("b", "t1") } };
    expect(plan(s, map([["a.md", l("changed")], ["new.md", l("n")]]), map([["a.md", r("t1")], ["b.md", r("t1")]]), true)).toEqual([
      { kind: "keepLocal", path: "a.md" },
      { kind: "download", path: "b.md", known: null },
      { kind: "keepLocal", path: "new.md" },
    ]);
  });

  it("treats a deletion plus a new file with the same content as a rename", () => {
    const s: State = { files: { "Old name.md": e("h1", "t1"), "dup1.md": e("same", "t1"), "dup2.md": e("same", "t1") } };
    const a = plan(s, map([["Folder/New name.md", l("h1")], ["other.md", l("same")]]), map([["Old name.md", r("t1")], ["dup1.md", r("t1")], ["dup2.md", r("t1")]]), false);
    expect(a).toContainEqual({ kind: "moveRemote", from: "Old name.md", path: "Folder/New name.md" });
    expect(a.some((x) => x.kind === "upload" && x.path === "Folder/New name.md")).toBe(false);
    // Two deletions with the same content: not guessed.
    expect(a).toContainEqual({ kind: "upload", path: "other.md", base: null });
  });
});

describe("what syncs", () => {
  it("keeps Tome's file types and portable names", () => {
    expect(syncable("Lore/Dragons.md") && syncable("img/a.PNG") && syncable("b.canvas")).toBe(true);
    for (const p of ["script.js", "page.html", ".md", "README"]) expect(syncable(p)).toBe(false);
    expect(hidden(".obsidian/app.json") && hidden("Notes/.trash/x.md")).toBe(true);
    expect(hidden("Notes/x.md")).toBe(false);
    expect(portable("Lore/Dragons.md") && portable("Ünïcode/é.md")).toBe(true);
    for (const bad of ["a:b.md", "a/b?.md", "CON.md", "x/nul.txt", "trailing./x.md", "space /x.md", "a\\b.md"]) expect(portable(bad)).toBe(false);
  });

  it("names conflict copies for the device and never reuses a name", () => {
    const when = new Date(2026, 9, 30, 14, 32);
    expect(conflictName("Lore/Dragons.md", "Chris's iPhone", when, () => false)).toBe("Lore/Dragons (conflict, Chris's iPhone, 2026-10-30 1432).md");
    expect(conflictName("a.png", "pc:/x", when, (c) => c === "a (conflict, pcx, 2026-10-30 1432).png")).toBe("a (conflict, pcx, 2026-10-30 1432 2).png");
    expect(portable(conflictName("Lore/Dragons.md", "Kaleiki-PC", when, () => false))).toBe(true);
  });
});

describe("merging notes", () => {
  it("merges different lines and refuses the same ones", () => {
    const base = "# Dragons\n\nFire.\n\nScales.\n";
    const mine = "# Dragons\n\nFire and smoke.\n\nScales.\n";
    const theirs = "# Dragons\n\nFire.\n\nRed scales.\n";
    expect(mergeText(base, mine, theirs)).toBe("# Dragons\n\nFire and smoke.\n\nRed scales.\n");
    expect(mergeText(base, base, theirs)).toBe(theirs);
    expect(mergeText(base, mine, mine)).toBe(mine);
    expect(mergeText(base, "# Dragons\n\nIce.\n\nScales.\n", "# Dragons\n\nWater.\n\nScales.\n")).toBeNull();
  });
});

describe("Grimoire address", () => {
  it("is https, or http on this machine", () => {
    expect(normalizeServer("app.noto.gg")).toBe("https://app.noto.gg");
    expect(normalizeServer("https://app.noto.gg/")).toBe("https://app.noto.gg");
    expect(normalizeServer("http://127.0.0.1:3105")).toBe("http://127.0.0.1:3105");
    expect(normalizeServer("https://kaleiki-nuc.tail2b8c24.ts.net:8452/orgs/team-noto")).toBe("https://kaleiki-nuc.tail2b8c24.ts.net:8452");
    for (const bad of ["http://app.noto.gg", "https://user:pw@app.noto.gg", "ftp://x", "https://app.noto.gg/?x=1"]) expect(() => normalizeServer(bad)).toThrow();
  });
});

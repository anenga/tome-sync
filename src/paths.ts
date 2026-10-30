/*
 * Which files sync, and what their names may be. Mirrors Tome's server/sync.ts (and the desktop
 * app's sync.rs), so the plugin never offers Tome a file it would refuse.
 */

const SYNC_EXT = new Set(
  "md canvas png jpg jpeg gif webp svg avif bmp ico pdf txt csv json mp3 wav ogg m4a flac mp4 webm mov m4v zip 7z psd kra blend fbx obj glb gltf ttf otf woff woff2 xlsx docx pptx".split(" "),
);

export function syncable(path: string) {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 && SYNC_EXT.has(name.slice(dot + 1).toLowerCase());
}

/** .obsidian, .trash, .git and anything else starting with a dot stays on this device. */
export const hidden = (path: string) => path.split("/").some((seg) => seg.startsWith("."));

const RESERVED = new Set(["con", "prn", "aux", "nul", ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);

/** Names every computer can hold (Tome refuses the rest too). */
export function portable(path: string) {
  return (
    path.length > 0 &&
    path.split("/").every((seg) => {
      const stem = (seg.split(".")[0] ?? "").toLowerCase();
      // eslint-disable-next-line no-control-regex
      return seg !== "" && seg !== "." && seg !== ".." && !seg.endsWith(" ") && !seg.endsWith(".") && !/[<>:"\\|?*\x00-\x1f]/.test(seg) && !RESERVED.has(stem);
    })
  );
}

export const isNote = (path: string) => path.toLowerCase().endsWith(".md");

const pad = (n: number) => String(n).padStart(2, "0");

/** "Lore/Dragons.md" → "Lore/Dragons (conflict, Chris's iPhone, 2026-10-30 1432).md" */
export function conflictName(path: string, device: string, when: Date, taken: (p: string) => boolean) {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const dev = [...device].filter((c) => /[\p{L}\p{N}\-_ ']/u.test(c)).slice(0, 40).join("").trim() || "Obsidian";
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}${pad(when.getMinutes())}`;
  for (let n = 1; ; n++) {
    const candidate = `${dir}${stem} (conflict, ${dev}, ${stamp}${n === 1 ? "" : ` ${n}`})${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

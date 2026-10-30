// Builds the plugin into dist/ (main.js, manifest.json, styles.css): what Tome serves to Obsidian.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");
mkdirSync("dist", { recursive: true });
const opts = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2021",
  outfile: "dist/main.js",
  // Obsidian provides these at runtime.
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
  banner: { js: "/* Tome Sync for Obsidian: built from tome/obsidian in the Team Noto tools repository. */" },
};
await build(opts);
copyFileSync("manifest.json", "dist/manifest.json");
copyFileSync("styles.css", "dist/styles.css");

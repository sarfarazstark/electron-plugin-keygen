import fs from "node:fs";
import path from "node:path";

// Electron only treats a preload script as ESM when the file ends in `.mjs`.
const dist = path.join(import.meta.dirname, "..", "dist", "preload");
const from = path.join(dist, "index.js");
const to = path.join(dist, "index.mjs");

if (fs.existsSync(to)) fs.rmSync(to);
if (!fs.existsSync(from)) {
	console.error(`postbuild: expected ${from} — run tsc -p tsconfig.build.json first`);
	process.exit(1);
}
fs.renameSync(from, to);

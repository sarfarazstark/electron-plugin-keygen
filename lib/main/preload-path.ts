import { fileURLToPath } from "node:url";

/**
 * Absolute path to the plugin's prebuilt preload script, for
 * `webPreferences.preload`. An ESM preload script must keep the `.mjs`
 * extension, and Electron requires unsandboxed + context-isolated renderers
 * for it.
 */
export function keygenPreloadPath(): string {
	try {
		// installed layout: resolves through the package's "exports" map
		return fileURLToPath(import.meta.resolve("electron-plugin-keygen/preload"));
	} catch {
		// dist/main/preload-path.js -> dist/preload/index.mjs
		return fileURLToPath(new URL("../preload/index.mjs", import.meta.url));
	}
}

import { fileURLToPath } from "node:url";

/**
 * Absolute path to the plugin's prebuilt preload script, for
 * `webPreferences.preload`. An ESM preload script must keep the `.mjs`
 * extension, and Electron requires unsandboxed + context-isolated renderers
 * for it. Prefer `keygenSandboxedPreloadPath()` when the renderer is sandboxed.
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

/**
 * Path to the self-contained CommonJS preload, which is what a `sandbox: true`
 * renderer can load: sandboxed preloads are plain JavaScript and cannot require
 * sibling files. Hosts bundling their own preload should emit CJS instead
 * (see example/electron.vite.config.ts).
 */
export function keygenSandboxedPreloadPath(): string {
	try {
		return fileURLToPath(import.meta.resolve("electron-plugin-keygen/preload/sandboxed"));
	} catch {
		// dist/main/preload-path.js -> dist/preload/sandboxed.cjs
		return fileURLToPath(new URL("../preload/sandboxed.cjs", import.meta.url));
	}
}

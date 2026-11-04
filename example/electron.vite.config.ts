import path from "node:path";
import { defineConfig } from "electron-vite";

const root = import.meta.dirname;

// The app owns its preload script; it installs the plugin bridge on import.
export default defineConfig({
	main: {
		build: {
			rollupOptions: {
				input: { index: path.resolve(root, "src/main/index.ts") },
			},
			externalizeDeps: true,
		},
	},
	preload: {
		build: {
			rollupOptions: {
				input: { index: path.resolve(root, "src/preload/index.ts") },
			},
		},
	},
	renderer: {
		root: path.resolve(root, "src/renderer"),
		build: {
			rollupOptions: {
				input: { index: path.resolve(root, "src/renderer/index.html") },
			},
		},
	},
});

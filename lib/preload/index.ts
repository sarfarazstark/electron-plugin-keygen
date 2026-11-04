import { contextBridge, ipcRenderer } from "electron";
import type { KeygenBridge } from "../shared/keygen-types.ts";
import { createKeygenBridge } from "./api.ts";

/**
 * Preload entry. Importing this module as a window's preload script installs
 * `window.keygen`. Apps with their own preload can call `installKeygenBridge()`
 * themselves, or build the bridge over an injected invoke with
 * `createKeygenBridge()` from `electron-plugin-keygen/preload/api`.
 */

export { createKeygenBridge, type InvokeLike } from "./api.ts";

const bridge = createKeygenBridge((channel, ...args) => ipcRenderer.invoke(channel, ...args));

export function installKeygenBridge(target: KeygenBridge = bridge): void {
	if (process.contextIsolated) {
		try {
			contextBridge.exposeInMainWorld("keygen", target);
		} catch (error) {
			console.error("Failed to expose keygen bridge to main world:", error);
		}
	} else {
		// dev fallback only; the app window runs with contextIsolation enabled
		(globalThis as unknown as { keygen: KeygenBridge }).keygen = target;
	}
}

installKeygenBridge();

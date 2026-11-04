import type {
	IpcResult,
	KeygenBridge,
	KeygenLicense,
	ValidateCheckoutKeyOptions,
	ValidateKeyOptions,
} from "../shared/keygen-types.ts";

/**
 * Sandboxed preload entry: one self-contained CommonJS file.
 *
 * A sandboxed preload runs as plain JavaScript. `require("electron")` works there,
 * but a sibling `require("./api.cjs")` fails with "module not found" — verified on
 * Electron 45 — so this file may not be split across modules and the channel names
 * are inlined rather than imported. `tests/sandboxed-preload.test.ts` pins the
 * inlined names and behaviour against the canonical `KEYGEN_CHANNELS` list, which
 * is what keeps this file from drifting away from `./api.ts`.
 */

type InvokeLike = (channel: string, ...args: unknown[]) => Promise<unknown>;

const CHANNELS = {
	getLicense: "keygen:get-license",
	getLicenseKey: "keygen:get-license-key",
	validateKey: "keygen:validate-key",
	validateCheckoutKey: "keygen:validate-checkout-key",
	resetLicense: "keygen:reset-license",
	resetLicenseKey: "keygen:reset-license-key",
} as const;

/** Exported for the drift test; a sandboxed host loads this file as its preload. */

function createSandboxedKeygenBridge(invoke: InvokeLike): KeygenBridge {
	return {
		getLicense: () => invoke(CHANNELS.getLicense) as Promise<IpcResult<KeygenLicense | null>>,
		getLicenseKey: () => invoke(CHANNELS.getLicenseKey) as Promise<IpcResult<string | null>>,
		validateKey: (options: ValidateKeyOptions) =>
			invoke(CHANNELS.validateKey, options) as Promise<IpcResult<KeygenLicense>>,
		validateCheckoutKey: (options: ValidateCheckoutKeyOptions) =>
			invoke(CHANNELS.validateCheckoutKey, options) as Promise<IpcResult<KeygenLicense>>,
		resetLicense: () => invoke(CHANNELS.resetLicense) as Promise<IpcResult<null>>,
		resetLicenseKey: () => invoke(CHANNELS.resetLicenseKey) as Promise<IpcResult<null>>,
	};
}

/**
 * Installs `window.keygen`. Called automatically when this file is loaded as a
 * preload script; hosts that already own a preload file can call it themselves.
 */
function installKeygenBridge(target?: KeygenBridge): void {
	const { contextBridge, ipcRenderer } = require("electron") as {
		contextBridge: { exposeInMainWorld(name: string, api: unknown): void };
		ipcRenderer: { invoke(channel: string, ...args: unknown[]): Promise<unknown> };
	};

	const bridge =
		target ?? createSandboxedKeygenBridge((channel, ...args) => ipcRenderer.invoke(channel, ...args));

	if (process.contextIsolated) {
		try {
			contextBridge.exposeInMainWorld("keygen", bridge);
		} catch (error) {
			console.error("Failed to expose keygen bridge to main world:", error);
		}
	} else {
		(globalThis as unknown as { keygen: KeygenBridge }).keygen = bridge;
	}
}

const keygenSandboxedPreload = { createSandboxedKeygenBridge, installKeygenBridge };

// Outside an Electron preload context (plain Node, tests) this module is inert:
// requiring `electron` there yields a path string, not the API.
if (process.versions.electron) {
	installKeygenBridge();
}

export = keygenSandboxedPreload;

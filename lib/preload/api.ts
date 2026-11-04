import {
	KEYGEN_CHANNELS,
	type IpcResult,
	type KeygenBridge,
	type KeygenLicense,
	type ValidateCheckoutKeyOptions,
	type ValidateKeyOptions,
} from "../shared/keygen-types.ts";

/**
 * The preload-side bridge: exactly six methods over six fixed channels, each
 * returning the main process envelope untouched.
 *
 * It deliberately does not throw: contextBridge strips custom properties off
 * thrown objects, so `KeygenError` is constructed in the renderer world instead
 * (see the package's `/renderer` entry).
 */
export type InvokeLike = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function createKeygenBridge(invoke: InvokeLike): KeygenBridge {
	return {
		getLicense: () => invoke(KEYGEN_CHANNELS.getLicense) as Promise<IpcResult<KeygenLicense | null>>,
		getLicenseKey: () => invoke(KEYGEN_CHANNELS.getLicenseKey) as Promise<IpcResult<string | null>>,
		validateKey: (options: ValidateKeyOptions) =>
			invoke(KEYGEN_CHANNELS.validateKey, options) as Promise<IpcResult<KeygenLicense>>,
		validateCheckoutKey: (options: ValidateCheckoutKeyOptions) =>
			invoke(KEYGEN_CHANNELS.validateCheckoutKey, options) as Promise<IpcResult<KeygenLicense>>,
		resetLicense: () => invoke(KEYGEN_CHANNELS.resetLicense) as Promise<IpcResult<null>>,
		resetLicenseKey: () => invoke(KEYGEN_CHANNELS.resetLicenseKey) as Promise<IpcResult<null>>,
	};
}

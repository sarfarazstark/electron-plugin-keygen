import { KeygenError } from "../shared/keygen-error.ts";
import type {
	IpcResult,
	KeygenBridge,
	KeygenLicensingAPI,
	ValidateCheckoutKeyOptions,
	ValidateKeyOptions,
} from "../shared/keygen-types.ts";

/**
 * Renderer entry — the counterpart of tauri-plugin-keygen's `guest-js`.
 * It reads the `window.keygen` bridge installed by the preload script and
 * throws `KeygenError` in the renderer realm, so `instanceof` works.
 */

export { KeygenError } from "../shared/keygen-error.ts";

/**
 * guest-js's `isKeygenError`: works across realms, where `instanceof` fails
 * because the error was constructed in the preload/main world.
 */
export function isKeygenError(err: unknown): err is { code: string; detail: string } {
	return (
		typeof err === "object" &&
		err !== null &&
		typeof (err as { code?: unknown }).code === "string" &&
		typeof (err as { detail?: unknown }).detail === "string"
	);
}
export type {
	KeygenLicense,
	KeygenLicensingAPI,
	ValidateKeyOptions,
	ValidateCheckoutKeyOptions,
} from "../shared/keygen-types.ts";

/**
 * Original guest-js defaults: `entitlements: []`, `cacheValidResponse: true`,
 * `ttlSeconds: 86400`, `ttlForever: false`.
 */
function bind(read: () => KeygenBridge | null): KeygenLicensingAPI {
	const call = async <T>(run: (bridge: KeygenBridge) => Promise<IpcResult<T>>): Promise<T> => {
		const bridge = read();
		if (!bridge) {
			throw new KeygenError({
				code: "NO_KEYGEN_BRIDGE",
				detail: "window.keygen is unavailable: is the keygen preload script attached to this window?",
			});
		}
		// A rejection here means the call never reached a licensing handler.
		// Electron's own message names the channel, never license data.
		const res = (await run(bridge).catch((err: unknown) => {
			throw new KeygenError({
				code: "IPC_UNREACHABLE",
				detail: err instanceof Error ? err.message : String(err),
			});
		})) as IpcResult<T> | null | undefined;
		if (res && res.ok === true) return res.data;
		if (res && res.ok === false && res.error) throw new KeygenError(res.error);
		throw new KeygenError({ code: "unknown", detail: "Malformed IPC response" });
	};

	return {
		getLicense: () => call((b) => b.getLicense()),
		getLicenseKey: () => call((b) => b.getLicenseKey()),
		validateKey: (options: ValidateKeyOptions) => call((b) => b.validateKey(options)),
		validateCheckoutKey: (options: ValidateCheckoutKeyOptions) => call((b) => b.validateCheckoutKey(options)),
		resetLicense: () => call((b) => b.resetLicense()).then(() => undefined),
		resetLicenseKey: () => call((b) => b.resetLicenseKey()).then(() => undefined),
	};
}

/** For apps that hold the bridge themselves (e.g. tests, custom preload wiring). */
export function createKeygenLicensingApi(bridge: KeygenBridge | null): KeygenLicensingAPI {
	return bind(() => bridge);
}

function readBridge(): KeygenBridge | null {
	const candidate = (globalThis as { keygen?: Partial<KeygenBridge> }).keygen;
	if (!candidate) return null;
	const names: Array<keyof KeygenBridge> = [
		"getLicense",
		"getLicenseKey",
		"validateKey",
		"validateCheckoutKey",
		"resetLicense",
		"resetLicenseKey",
	];
	return names.every((name) => typeof candidate[name] === "function") ? (candidate as KeygenBridge) : null;
}

/** Ready-to-use API; resolves `window.keygen` at call time. */
export const keygen: KeygenLicensingAPI = bind(readBridge);

export const getLicense = () => keygen.getLicense();
export const getLicenseKey = () => keygen.getLicenseKey();
export const validateKey = (options: ValidateKeyOptions) => keygen.validateKey(options);
export const validateCheckoutKey = (options: ValidateCheckoutKeyOptions) =>
	keygen.validateCheckoutKey(options);
export const resetLicense = () => keygen.resetLicense();
export const resetLicenseKey = () => keygen.resetLicenseKey();

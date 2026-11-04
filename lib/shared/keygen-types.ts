/**
 * Renderer-facing types for the Keygen licensing API.
 * Mirrors `KeygenLicense` and the option structs of tauri-plugin-keygen's
 * guest bindings (guest-js/index.ts), so the ported API surface is unchanged.
 */

export type KeygenLicense = {
	key: string;
	code: string;
	detail: string;
	/**
	 * License expiry can be null at the beginning (before activation)
	 * when its policy's expirationBasis is *not* set to "FROM_CREATION".
	 */
	expiry: string | null;
	valid: boolean;
	policyId: string;
	entitlements: string[];
	metadata: Record<string, unknown>;
};

export type ValidateKeyOptions = {
	key: string;
	entitlements?: string[];
	cacheValidResponse?: boolean;
};

export type ValidateCheckoutKeyOptions = {
	key: string;
	entitlements?: string[];
	ttlSeconds?: number;
	ttlForever?: boolean;
};

export interface KeygenLicensingAPI {
	getLicense(): Promise<KeygenLicense | null>;
	getLicenseKey(): Promise<string | null>;
	validateKey(options: ValidateKeyOptions): Promise<KeygenLicense>;
	validateCheckoutKey(options: ValidateCheckoutKeyOptions): Promise<KeygenLicense>;
	resetLicense(): Promise<void>;
	resetLicenseKey(): Promise<void>;
}

/** IPC envelope: ipcRenderer.invoke drops Error subclasses' custom fields. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; detail: string } };

/**
 * What the preload script puts on `window.keygen`: the six channels, each
 * returning its envelope untouched. Errors are turned into `KeygenError`
 * in the renderer (see the `/renderer` entry) because contextBridge strips
 * custom properties off thrown objects.
 */
export type KeygenBridge = {
	getLicense(): Promise<IpcResult<KeygenLicense | null>>;
	getLicenseKey(): Promise<IpcResult<string | null>>;
	validateKey(options: ValidateKeyOptions): Promise<IpcResult<KeygenLicense>>;
	validateCheckoutKey(options: ValidateCheckoutKeyOptions): Promise<IpcResult<KeygenLicense>>;
	resetLicense(): Promise<IpcResult<null>>;
	resetLicenseKey(): Promise<IpcResult<null>>;
};

export const KEYGEN_CHANNELS = {
	getLicense: "keygen:get-license",
	getLicenseKey: "keygen:get-license-key",
	validateKey: "keygen:validate-key",
	validateCheckoutKey: "keygen:validate-checkout-key",
	resetLicense: "keygen:reset-license",
	resetLicenseKey: "keygen:reset-license-key",
} as const;

export type KeygenChannelName = (typeof KEYGEN_CHANNELS)[keyof typeof KEYGEN_CHANNELS];

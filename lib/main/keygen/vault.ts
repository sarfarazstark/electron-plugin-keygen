import type { SecretCodec } from "./storage.ts";

/**
 * The slice of Electron's `safeStorage` this package uses. Structural so the
 * binding rules can be exercised without an Electron process; the real object
 * satisfies it.
 */
export type SafeStorageLike = {
	isEncryptionAvailable(): boolean;
	encryptString(plaintext: string): Buffer;
	decryptString(blob: Buffer): string;
	/** Linux only: which secret store backed the calls, or `basic_text` for none. */
	getSelectedStorageBackend?(): string;
	/** The async API exists from Electron 45 and is the one Electron 46 keeps. */
	isAsyncEncryptionAvailable?(): Promise<boolean>;
	encryptStringAsync?(plaintext: string): Promise<Buffer>;
	decryptStringAsync?(blob: Buffer): Promise<{ result: string; shouldReEncrypt?: boolean }>;
};

/**
 * `safeStorage`'s methods are native bindings: taken off the object and called
 * bare, they throw "Illegal invocation: Function must be called on an object of
 * type SafeStorage". That failure looks identical to "no vault here" from the
 * outside, because availability probing swallows it — so the async trio is bound
 * once here and never destructured into free functions.
 */
export function buildVaultCodec(vault: SafeStorageLike): SecretCodec {
	const { isAsyncEncryptionAvailable, encryptStringAsync, decryptStringAsync } = vault;
	const as =
		typeof isAsyncEncryptionAvailable === "function" &&
		typeof encryptStringAsync === "function" &&
		typeof decryptStringAsync === "function"
			? {
					available: isAsyncEncryptionAvailable.bind(vault),
					seal: encryptStringAsync.bind(vault),
					open: decryptStringAsync.bind(vault),
				}
			: null;

	return {
		isAvailable: async () => {
			// With no secret store on Linux, safeStorage encrypts under a hardcoded
			// password and still reports itself available — plaintext with extra
			// steps, so the vault counts as unavailable and nothing is written.
			if (process.platform === "linux" && vault.getSelectedStorageBackend?.() === "basic_text") {
				return false;
			}
			return as ? as.available() : vault.isEncryptionAvailable();
		},
		encrypt: async (plaintext) => (as ? as.seal(plaintext) : vault.encryptString(plaintext)),
		decrypt: async (blob) => {
			if (!as) return { plaintext: vault.decryptString(blob), reencrypt: false };
			const out = await as.open(blob);
			return { plaintext: out.result, reencrypt: out.shouldReEncrypt === true };
		},
	};
}

import { safeStorage } from "electron";
import { KeygenError } from "../../shared/keygen-error.ts";
import type { KeygenConfigInput } from "./config.ts";
import { buildDefaultHeaders, resolveConfig } from "./config.ts";
import { KeygenClient } from "./client.ts";
import { createMachine } from "./machine.ts";
import type { SecretCodec } from "./storage.ts";
import { KeygenStorage } from "./storage.ts";
import { LicensingService, type Logger } from "./service.ts";

/**
 * Electron host wiring: safeStorage codec + env-based configuration.
 * Secrets (account id, product id, verify key) come from the environment at
 * build/run time — nothing licensing-critical is hardcoded.
 */

/** The async API only exists from Electron 45; older peers get the sync calls. */
type AsyncSafeStorage = {
	isAsyncEncryptionAvailable?: () => Promise<boolean>;
	encryptStringAsync?: (plaintext: string) => Promise<Buffer>;
	decryptStringAsync?: (blob: Buffer) => Promise<{ result: string; shouldReEncrypt?: boolean }>;
};

export function buildSafeStorageCodec(): SecretCodec {
	const { isAsyncEncryptionAvailable, encryptStringAsync, decryptStringAsync } =
		safeStorage as typeof safeStorage & AsyncSafeStorage;
	const hasAsync =
		typeof isAsyncEncryptionAvailable === "function" &&
		typeof encryptStringAsync === "function" &&
		typeof decryptStringAsync === "function";

	return {
		isAvailable: async () => {
			// On Linux with no secret store, safeStorage encrypts under a hardcoded
			// password and still reports itself available — that is plaintext with
			// extra steps, so the vault counts as unavailable and nothing is written.
			if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") {
				return false;
			}
			return hasAsync ? await isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
		},
		encrypt: async (plaintext) =>
			hasAsync ? await encryptStringAsync(plaintext) : safeStorage.encryptString(plaintext),
		decrypt: async (blob) => {
			if (!hasAsync) return { plaintext: safeStorage.decryptString(blob), reencrypt: false };
			const out = await decryptStringAsync(blob);
			return { plaintext: out.result, reencrypt: out.shouldReEncrypt === true };
		},
	};
}

export type InitArgs = {
	userDataDir: string;
	appName: string;
	appVersion: string;
	locale: string;
	log: Logger;
	config: KeygenConfigInput | null;
};

export async function createLicensingService(args: InitArgs): Promise<LicensingService | null> {
	if (args.config === null) {
		args.log.warn("keygen: no configuration (KEYGEN_VERIFY_KEY unset); licensing disabled");
		return null;
	}

	let config: ReturnType<typeof resolveConfig>;
	try {
		config = resolveConfig(args.config);
	} catch (err) {
		args.log.error(`keygen: invalid configuration: ${err instanceof KeygenError ? err.detail : String(err)}`);
		return null;
	}

	const machine = createMachine({
		appName: args.appName,
		appVersion: args.appVersion,
		locale: args.locale,
	});

	const storage = new KeygenStorage(args.userDataDir, buildSafeStorageCodec(), args.log);
	const client = new KeygenClient(
		config,
		(url, init) => fetch(url, init) as unknown as Promise<import("./client.ts").FetchResponseLike>,
		buildDefaultHeaders(config, machine.userAgent),
	);

	const service = new LicensingService({ machine, storage, client, log: args.log });
	await service.init();
	return service;
}

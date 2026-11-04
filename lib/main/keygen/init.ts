import { safeStorage } from "electron";
import { KeygenError } from "../../shared/keygen-error.ts";
import type { KeygenConfigInput } from "./config.ts";
import { buildDefaultHeaders, resolveConfig } from "./config.ts";
import { KeygenClient } from "./client.ts";
import { createMachine } from "./machine.ts";
import type { SecretCodec } from "./storage.ts";
import { KeygenStorage } from "./storage.ts";
import { buildVaultCodec } from "./vault.ts";
import { LicensingService, type Logger } from "./service.ts";

/**
 * Electron host wiring: safeStorage codec + env-based configuration.
 * Secrets (account id, product id, verify key) come from the environment at
 * build/run time — nothing licensing-critical is hardcoded.
 */

/** Bound to the process's real safeStorage; the binding rules live in vault.ts. */
export function buildSafeStorageCodec(): SecretCodec {
	return buildVaultCodec(safeStorage);
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

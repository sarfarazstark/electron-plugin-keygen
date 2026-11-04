import { configFromEnv, type KeygenConfigInput } from "./config.ts";
import type { InitArgs } from "./init.ts";
import { makeWindowTrustChecker, registerKeygenIpc, type IpcMainLike } from "./ipc.ts";
import type { LicensingService, Logger } from "./service.ts";

/**
 * Host wiring for the plugin, mirroring the Tauri plugin lifecycle: the IPC
 * surface is registered at once, the licensing service is built in the plugin's
 * setup phase (after the app is ready, when userData paths resolve).
 *
 * Nothing here imports `electron`: the app and ipc objects are structural types,
 * so this module runs under plain Node in tests.
 */

export type KeygenAppHost = {
	readonly name: string;
	getPath(name: "userData"): string;
	getVersion(): string;
	getLocale(): string;
	whenReady(): Promise<unknown>;
};

export type RegisterKeygenOptions = {
	app: KeygenAppHost;
	ipc: IpcMainLike;
	/** Trusted senders, re-read per request so closed windows lose access. */
	getTrustedWebContentsIds: () => number[];
	/** Omitted means: read KEYGEN_* from the environment; `null` disables licensing. */
	config?: KeygenConfigInput | null;
	log?: Logger;
	/** Injectable for tests; defaults to the safeStorage-backed factory. */
	createService?: (args: InitArgs) => LicensingService | null;
};

/** Resolves to the service once the app is ready; null when licensing is off. */
export function registerKeygen(options: RegisterKeygenOptions): Promise<LicensingService | null> {
	const log: Logger = options.log ?? {
		info: (msg) => console.log(`[keygen] ${msg}`),
		warn: (msg) => console.warn(`[keygen] ${msg}`),
		error: (msg) => console.error(`[keygen] ${msg}`),
	};

	// Channels are live before the service exists: requests arriving before the
	// app is ready are refused with LICENSING_DISABLED rather than hanging.
	let service: LicensingService | null = null;
	registerKeygenIpc(options.ipc, () => service, makeWindowTrustChecker(options.getTrustedWebContentsIds));

	return options.app.whenReady().then(async () => {
		const createService = options.createService ?? (await import("./init.ts")).createLicensingService;
		const config = options.config === undefined ? configFromEnv() : options.config;
		try {
			service = createService({
				userDataDir: options.app.getPath("userData"),
				appName: options.app.name,
				appVersion: options.app.getVersion(),
				locale: options.app.getLocale(),
				log,
				config,
			});
		} catch (err) {
			// A licensing failure must never take the app down; the app simply
			// runs unlicensed and every channel reports the error.
			log.error(`licensing startup failed: ${err instanceof Error ? err.message : String(err)}`);
			service = null;
		}
		return service;
	});
}

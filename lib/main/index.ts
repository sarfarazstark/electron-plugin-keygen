/**
 * Main-process entry of electron-plugin-keygen.
 *
 *   import { app, BrowserWindow, ipcMain } from "electron";
 *   import { KeygenBuilder, registerKeygen } from "electron-plugin-keygen";
 *
 *   const service = await registerKeygen({
 *     app,
 *     ipc: ipcMain,
 *     config: KeygenBuilder.new(accountId, verifyKey).cacheLifetime(240).build(),
 *     getTrustedWebContentsIds: () => myAppWindows.map((w) => w.webContents.id),
 *   });
 */

export { KeygenBuilder } from "./keygen/builder.ts";
export { registerKeygen, type KeygenAppHost, type RegisterKeygenOptions } from "./keygen/plugin.ts";
export { keygenPreloadPath, keygenSandboxedPreloadPath } from "./preload-path.ts";
export { LicensingService, type Logger } from "./keygen/service.ts";
export { buildSafeStorageCodec, createLicensingService, type InitArgs } from "./keygen/init.ts";
export { makeWindowTrustChecker, registerKeygenIpc, type IpcMainLike } from "./keygen/ipc.ts";
export {
	CACHE_LIFETIME_MAX,
	CACHE_LIFETIME_MIN,
	configFromEnv,
	DEFAULT_API_URL,
	DEFAULT_CACHE_LIFETIME,
	resolveConfig,
	type KeygenConfig,
	type KeygenConfigInput,
} from "./keygen/config.ts";
export { KeygenError, asKeygenError } from "../shared/keygen-error.ts";
export {
	KEYGEN_CHANNELS,
	type KeygenBridge,
	type KeygenChannelName,
	type KeygenLicense,
	type KeygenLicensingAPI,
	type ValidateCheckoutKeyOptions,
	type ValidateKeyOptions,
} from "../shared/keygen-types.ts";

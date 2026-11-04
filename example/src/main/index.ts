import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { KeygenBuilder, registerKeygen } from "electron-plugin-keygen";

/**
 * Example host app. Licensing configuration comes from the environment
 * (KEYGEN_VERIFY_KEY, KEYGEN_ACCOUNT_ID, ...), never from a hardcoded value.
 */

const appWindows = new Set<BrowserWindow>();

function createWindow(): BrowserWindow {
	const win = new BrowserWindow({
		width: 1000,
		height: 720,
		show: false,
		autoHideMenuBar: true,
		title: app.name,
		webPreferences: {
			// Bundled to a single CommonJS file (see electron.vite.config.ts): a
			// sandboxed preload cannot require sibling modules, so the plugin's
			// bridge has to be inside this file. That keeps the renderer sandboxed.
			preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
		},
	});

	win.on("ready-to-show", () => win.show());
	win.on("closed", () => appWindows.delete(win));
	win.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url);
		return { action: "deny" };
	});

	if (process.env.ELECTRON_RENDERER_URL) {
		win.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		win.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
	}

	appWindows.add(win);
	return win;
}

// Registers the IPC surface at once and builds the service when the app is ready.
void registerKeygen({
	app,
	ipc: ipcMain,
	// only windows this app created may reach the licensing channels, and only
	// from their top frame (the frame check lives inside the plugin)
	getTrustedWebContentsIds: () =>
		[...appWindows].filter((win) => !win.isDestroyed()).map((win) => win.webContents.id),
	config: KeygenBuilder.new(process.env.KEYGEN_ACCOUNT_ID ?? "", process.env.KEYGEN_VERIFY_KEY ?? "")
		.apiUrl(process.env.KEYGEN_API_URL ?? "https://api.keygen.sh")
		.cacheLifetime(Number(process.env.KEYGEN_CACHE_LIFETIME ?? 240))
		.build(),
}).then((service) => {
	if (service === null) console.warn("[example] licensing disabled — check the KEYGEN_* environment");
});

app.whenReady().then(() => createWindow());

app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, safeStorage } from "electron";

/**
 * Checks that need a REAL Electron session. The unit tests inject a fake codec
 * and a fake ipc, so they verify policy — this verifies the platform edge: the
 * OS vault (DPAPI / Keychain / libsecret) and both preload entry points loaded
 * into a live renderer.
 *
 * Run after `npm run build`:  npm run verify:electron
 */

const ROOT = path.join(import.meta.dirname, "..");
const SECRET = "KEYGEN-VERIFY-SECRET-0123456789";
const BRIDGE_METHODS = [
	"getLicense",
	"getLicenseKey",
	"resetLicense",
	"resetLicenseKey",
	"validateCheckoutKey",
	"validateKey",
];

let failures = 0;

async function check(name, run) {
	try {
		await run();
		console.log(`  PASS  ${name}`);
	} catch (err) {
		failures++;
		console.log(`  FAIL  ${name}\n        ${String(err.message).split("\n")[0]}`);
		if (process.env.VERIFY_DEBUG) console.log(String(err.stack).split("\n").slice(1, 5).join("\n"));
	}
}

const importDist = (file) => import(pathToFileURL(path.join(ROOT, "dist", file)).href);

/* ---------------------------------- vault ---------------------------------- */

async function verifyVault() {
	const { buildSafeStorageCodec } = await importDist("main/keygen/init.js");
	const { KeygenStorage } = await importDist("main/keygen/storage.js");

	const codec = buildSafeStorageCodec();
	const storage = new KeygenStorage(mkdtempSync(path.join(os.tmpdir(), "keygen-vault-")), codec, {
		warn: (m) => console.log(`        warn: ${m}`),
	});
	const backend = safeStorage.getSelectedStorageBackend?.() ?? "n/a";
	console.log(
		`\nvault: ${os.platform()} sync=${safeStorage.isEncryptionAvailable()} codec=${await codec.isAvailable()} backend=${backend}`,
	);

	if (!(await storage.encryptionAvailable())) {
		console.log("  SKIP  no usable OS vault on this machine — persistence is refused, nothing to verify");
		return;
	}

	await check("the cached license key round-trips through the real vault", async () => {
		await storage.writeLicenseKey(SECRET);
		assert.equal(await storage.readLicenseKey(), SECRET);
	});

	await check("the key file holds no plaintext", async () => {
		const raw = readFileSync(storage.keyFilePath());
		assert.ok(raw.length > 0, "key file is empty");
		assert.ok(!raw.includes(SECRET), "plaintext license key found on disk");
		console.log(`        ${raw.length} bytes, no plaintext`);
	});

	let cachePath = null;
	await check("the validation cache round-trips and leaks nothing", async () => {
		const cache = {
			sig: 'algorithm="ed25519", signature="00"',
			target: "/v1/accounts/x/licenses/actions/validate-key",
			host: "api.keygen.sh",
			date: new Date().toISOString(),
			body: JSON.stringify({ data: { attributes: { key: SECRET, code: "VALID" } } }),
		};
		await storage.cacheResponse(SECRET, cache);
		const loaded = await storage.loadResponseCache(SECRET);
		assert.equal(loaded?.cache.body, cache.body, "cached body changed");
		cachePath = loaded.path;

		const raw = readFileSync(cachePath, "utf8");
		assert.ok(raw.startsWith("KGC1\n"), "cache file is not an encrypted envelope");
		assert.ok(!raw.includes(SECRET), "plaintext license key found in the cache file");
		assert.ok(!raw.includes(cache.sig), "signature found in the cache file");
		console.log(`        ${raw.length} bytes under ${path.basename(cachePath).slice(0, 12)}…`);
	});

	await check("tampered cache ciphertext throws STORAGE_DECRYPT_FAILED", async () => {
		const raw = readFileSync(cachePath, "utf8");
		writeFileSync(cachePath, `${raw.slice(0, -8)}AAAAAAAA`);
		await assert.rejects(storage.loadResponseCache(SECRET), (err) => err.code === "STORAGE_DECRYPT_FAILED");
	});

	await check("a pre-encryption plaintext cache is deleted, not read", async () => {
		const stale = storage.responseCachePath("KEY-OTHER");
		writeFileSync(stale, JSON.stringify({ sig: "x", target: "x", host: "x", date: "x", body: SECRET }));
		assert.equal(await storage.loadResponseCache("KEY-OTHER"), null);
		assert.throws(() => readFileSync(stale), "an unprotected cache survived the read");
	});

	await check("corrupt key ciphertext throws STORAGE_DECRYPT_FAILED", async () => {
		const raw = readFileSync(storage.keyFilePath());
		writeFileSync(storage.keyFilePath(), Buffer.concat([raw.subarray(0, -4), Buffer.from([0, 0, 0, 1])]));
		await assert.rejects(storage.readLicenseKey(), (err) => err.code === "STORAGE_DECRYPT_FAILED");
	});
}

/* --------------------------------- preload --------------------------------- */

const PRELOAD_TARGETS = [
	{ file: "dist/preload/sandboxed.cjs", sandbox: true },
	{ file: "dist/preload/index.mjs", sandbox: false },
	{ file: "example/out/preload/index.cjs", sandbox: true },
];

const READ_BRIDGE = `(() => {
	const b = window.keygen;
	return {
		typeofKeygen: typeof b,
		methods: b && typeof b === "object" ? Object.keys(b).sort() : null,
		nodeVisible: typeof window.process?.type === "string" ? String(window.process.type) : "none",
	};
})()`;

async function verifyPreloads() {
	console.log("\npreload scripts, loaded into a live renderer");
	const pageDir = mkdtempSync(path.join(os.tmpdir(), "keygen-page-"));
	const html = path.join(pageDir, "index.html");
	writeFileSync(html, "<!doctype html><title>verify</title>");

	for (const target of PRELOAD_TARGETS) {
		await check(`${target.file} (sandbox: ${target.sandbox})`, async () => {
			const win = new BrowserWindow({
				show: false,
				webPreferences: {
					preload: path.join(ROOT, target.file),
					sandbox: target.sandbox,
					contextIsolation: true,
					nodeIntegration: false,
				},
			});
			await win.loadFile(html);
			const info = await win.webContents.executeJavaScript(READ_BRIDGE);
			await win.webContents.close();

			assert.equal(
				info.typeofKeygen,
				"object",
				`window.keygen is missing — the preload did not run (${JSON.stringify(info)})`,
			);
			assert.deepEqual(info.methods, BRIDGE_METHODS, `exposed ${JSON.stringify(info.methods)}`);
			if (target.sandbox) {
				assert.equal(info.nodeVisible, "none", "Node leaked into a sandboxed main world");
			}
		});
	}
	rmSync(pageDir, { recursive: true, force: true });
}

/* ---------------------------------- runner --------------------------------- */

app.disableHardwareAcceleration();
app.on("window-all-closed", (e) => e.preventDefault());

app.whenReady().then(async () => {
	console.log(`electron ${process.versions.electron} / chrome ${process.versions.chrome}`);
	await verifyVault();
	await verifyPreloads();
	console.log(
		failures === 0 ? "\nall real-Electron checks passed" : `\n${failures} real-Electron check(s) failed`,
	);
	app.exit(failures === 0 ? 0 : 1);
});

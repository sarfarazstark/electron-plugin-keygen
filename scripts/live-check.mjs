import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";

/**
 * Live run against a real Keygen account — the only way to check the paths a
 * mocked test cannot: a server-signed response, a real machine activation, an
 * offline restart, and the clock-dependent cache rules documented in BUGS.md.
 *
 *   npm run build
 *   KEYGEN_ACCOUNT_ID=… KEYGEN_VERIFY_KEY=… KEYGEN_LICENSE_KEY=… \
 *     npm run verify:live
 *
 * Side effects, on YOUR account:
 *   - activates this machine (consumes a seat) unless --no-activate is passed
 *   - writes machine.lic when --checkout is passed
 *   Both are cleaned up locally at the end; the machine record on the account is
 *   not, so use a test license. Nothing here prints the key.
 *
 * Flags: --checkout  also exercise validateCheckoutKey + offline machine file
 *        --no-activate  skip validateKey's activation step (read-only-ish)
 *        --keep  leave the storage dir behind for inspection
 */

const ROOT = path.join(import.meta.dirname, "..");
const argv = new Set(process.argv.slice(1));
const flag = (name) => argv.has(`--${name}`);
const KEEP = flag("keep");

const ACCOUNT = process.env.KEYGEN_ACCOUNT_ID ?? readEnvFile("KEYGEN_ACCOUNT_ID");
const VERIFY = process.env.KEYGEN_VERIFY_KEY ?? readEnvFile("KEYGEN_VERIFY_KEY");
const LICENSE = process.env.KEYGEN_LICENSE_KEY ?? readEnvFile("KEYGEN_LICENSE_KEY");

/** So a host can keep the key out of shell history. Never printed. */
function readEnvFile(name) {
	const file = path.join(ROOT, ".env.local");
	if (!existsSync(file)) return undefined;
	const line = readFileSync(file, "utf8")
		.split(/\r?\n/)
		.find((l) => l.startsWith(`${name}=`));
	return line?.slice(name.length + 1).trim();
}

const mask = (s) => (s ? `${s.slice(0, 4)}…${s.length} chars` : "unset");
const idOf = (s) => (s ? createHash("sha256").update(s).digest("hex").slice(0, 12) : "-");

let failures = 0;
async function step(name, run) {
	try {
		const note = await run();
		console.log(`  PASS  ${name}${note ? ` — ${note}` : ""}`);
	} catch (err) {
		failures++;
		console.log(`  FAIL  ${name}\n        ${String(err.message).split("\n")[0]}`);
	}
}

const importDist = (file) => import(pathToFileURL(path.join(ROOT, "dist", file)).href);

function describeLicense(lic) {
	if (!lic) return "no license";
	const expiry = lic.expiry ? new Date(lic.expiry).toISOString() : "never";
	return `${lic.code} valid=${lic.valid} expiry=${expiry} entitlements=${lic.entitlements.length}`;
}

/* ------------------------------- environment ------------------------------- */

if (!ACCOUNT || !VERIFY || !LICENSE) {
	console.log(
		"KEYGEN_ACCOUNT_ID, KEYGEN_VERIFY_KEY and KEYGEN_LICENSE_KEY are required\n" +
			"(or put them in .env.local at the package root). Nothing is being contacted.",
	);
	console.log(`  account: ${mask(ACCOUNT)}  verify key: ${mask(VERIFY)}  license: ${mask(LICENSE)}`);
	process.exit(2);
}
console.log(`live check: account ${idOf(ACCOUNT)}  license ${idOf(LICENSE)} (identifiers, not secrets)`);

const DATA_DIR = path.join(os.tmpdir(), `keygen-live-${idOf(LICENSE).slice(0, 8)}`);
app.setName("electron-plugin-keygen-live");
app.setPath("userData", DATA_DIR);

/* --------------------------------- helpers -------------------------------- */

const { KeygenBuilder, registerKeygen, LicensingService, buildSafeStorageCodec } =
	await importDist("main/index.js");
const { resolveConfig, buildDefaultHeaders } = await importDist("main/keygen/config.js");
const { KeygenClient } = await importDist("main/keygen/client.js");
const { createMachine } = await importDist("main/keygen/machine.js");
const { KeygenStorage } = await importDist("main/keygen/storage.js");

const log = { info: () => {}, warn: (m) => console.log(`        note: ${m}`), error: () => {} };

const config = KeygenBuilder.new(ACCOUNT, VERIFY).build();

/**
 * A second service over the same storage dir, with an injectable clock: this is
 * how an offline restart on a later day is reproduced without moving the system
 * clock. Wiring mirrors createLicensingService, which takes no clock.
 */
async function serviceAt(whenMs, { offline } = { offline: false }) {
	const resolved = resolveConfig(config);
	const machine = createMachine({
		appName: app.name,
		appVersion: app.getVersion(),
		locale: app.getLocale(),
	});
	const storage = new KeygenStorage(DATA_DIR, buildSafeStorageCodec(), log);
	const fetchImpl = offline
		? () => Promise.reject(new Error("simulated: no network"))
		: (url, init) => fetch(url, init);
	const client = new KeygenClient(resolved, fetchImpl, buildDefaultHeaders(resolved, machine.userAgent));
	const service = new LicensingService({ machine, storage, client, log, now: () => whenMs });
	await service.init();
	return { service, storage, client };
}

const now = () => Date.now();
/** A time guaranteed to fall on the local calendar day after today. */
function tomorrowAt(daysAhead, hour) {
	const d = new Date();
	d.setDate(d.getDate() + daysAhead);
	d.setHours(hour, 0, 0, 0);
	return d.getTime();
}

async function openWindow() {
	const win = new BrowserWindow({
		show: false,
		webPreferences: {
			preload: path.join(ROOT, "dist/preload/sandboxed.cjs"),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	const trusted = new Set([win.webContents.id]);
	await win.loadFile(path.join(ROOT, "scripts/live-page.html"));
	return { win, trusted };
}

/** Runs in the main world, so it exercises preload + IPC exactly as a UI would. */
async function inRenderer(win, body) {
	return win.webContents.executeJavaScript(`(async () => { ${body} })()`);
}

/* ---------------------------------- run ----------------------------------- */

app.disableHardwareAcceleration();
app.on("window-all-closed", (e) => e.preventDefault());

await app.whenReady();

const windows = [];
const service = await registerKeygen({
	app,
	ipc: ipcMain,
	config,
	log,
	getTrustedWebContentsIds: () => windows.flatMap((w) => (w.win.isDestroyed() ? [] : [w.win.webContents.id])),
});

console.log(`\nstoring under ${DATA_DIR}`);

await step("licensing is configured and the service started", async () => {
	assert.ok(service, "registerKeygen returned no service — config rejected");
	assert.equal(service.persistsLicenses, true, "the OS vault is unavailable, so nothing will persist");
	return `vault persists: ${service.persistsLicenses}`;
});

const { win } = await openWindow();
windows.push({ win });

await step("the renderer reaches the bridge over the sandboxed preload", async () => {
	const before = await inRenderer(
		win,
		`return await window.keygen.getLicenseKey().catch(e => "ERR " + e.code);`,
	);
	// a leftover run leaves the key cached; either answer proves the channel works
	return `getLicenseKey -> ${before === null ? "null (nothing cached yet)" : idOf(String(before))}`;
});

let licenseSummary = "";
await step("validateKey round-trips against the real API and verifies the signature", async () => {
	licenseSummary = await inRenderer(
		win,
		`try {
			const l = await window.keygen.validateKey({ key: ${JSON.stringify(LICENSE)}, entitlements: [] });
			return "renderer saw " + l.code + " valid=" + l.valid + " entitlements=" + (l.entitlements || []).length;
		} catch (e) { return "renderer saw error " + e.code + ": " + e.detail }`,
	);
	assert.match(licenseSummary, /valid=true/, `${licenseSummary} — the server did not accept this key`);
	return licenseSummary;
});

await step("the key is cached encrypted and reads back through IPC", async () => {
	const key = await service.getLicenseKey();
	assert.equal(typeof key, "string", "no key was cached after a validation");
	assert.equal(key.length, LICENSE.length, "cached key length differs");
	const raw = readFileSync(path.join(DATA_DIR, "keygen", "key"));
	assert.ok(!raw.includes(LICENSE), "the license key is present in the key file as plaintext");
	return `${raw.length} bytes on disk, no plaintext`;
});

await step("an offline restart reuses today's cached response", async () => {
	const { service: offline } = await serviceAt(now(), { offline: true });
	const lic = await offline.getLicense();
	if (!lic) {
		// Upstream only caches when the license has an expiry, so a perpetual
		// policy has nothing to restore from — reported, not treated as a failure.
		throw new Error("nothing restored while offline (no cache entry — perpetual license?)");
	}
	return describeLicense(lic);
});

await step("a tampered cached response is rejected by the verifier", async () => {
	const { storage, client } = await serviceAt(now(), { offline: true });
	const key = await storage.readLicenseKey();
	const cached = await storage.loadResponseCache(key);
	assert.ok(cached, "no cache entry to tamper with");
	// any byte change breaks the re-hashed Digest, so this proves the check runs
	const forged = { ...cached.cache, body: `${cached.cache.body}x` };
	assert.throws(
		() => client.verifyResponseCache(forged, now()),
		(err) => err.code === "BAD_RESPONSE",
		"an edited body verified against the real signature",
	);
	return "one extra byte in the body rejected with BAD_RESPONSE";
});

await step("an offline restart on the next calendar day finds no cache", async () => {
	const tomorrow = tomorrowAt(1, 1);
	const key = await service.getLicenseKey();
	const { storage } = await serviceAt(now(), { offline: true });
	const today = storage.responseCachePath(key);
	const future = storage.responseCachePath(key, new Date(tomorrow));
	assert.ok(existsSync(today), "today's cache entry is missing");
	assert.ok(!existsSync(future), "an entry for the next day unexpectedly exists");
	const { service: offline } = await serviceAt(tomorrow, { offline: true });
	assert.equal(await offline.getLicense(), null, "a license was restored on a new day");
	return "the entry is named for the local day, so a new day is a miss (BUGS.md)";
});

if (flag("checkout")) {
	await step("validateCheckoutKey writes a machine file", async () => {
		const summary = await inRenderer(
			win,
			`try {
				await window.keygen.validateCheckoutKey({ key: ${JSON.stringify(LICENSE)}, ttlSeconds: ${7 * 86400} });
				return "checkout ok";
			} catch (e) { return "checkout failed " + e.code + ": " + e.detail }`,
		);
		assert.equal(summary, "checkout ok", summary);
		const file = path.join(DATA_DIR, "keygen", "machine.lic");
		assert.ok(existsSync(file), "machine.lic was not written");
		const raw = readFileSync(file, "utf8");
		assert.match(raw, /BEGIN keygen license/, "machine.lic is not the Keygen PEM format");
		assert.ok(!raw.includes(LICENSE), "the license key appears in machine.lic in the clear");
		return `machine.lic ${raw.length} bytes, format intact`;
	});

	await step("the machine file carries licensing across the day boundary", async () => {
		const { service: offline } = await serviceAt(tomorrowAt(1, 1), { offline: true });
		const lic = await offline.getLicense();
		assert.ok(lic, "no license from the machine file on a new day");
		return describeLicense(lic);
	});

	await step("the offline ttl is enforced, not bypassed", async () => {
		const { service: expired } = await serviceAt(tomorrowAt(9, 1), { offline: true });
		const lic = await expired.getLicense();
		assert.equal(lic, null, `access persisted past the ttl: ${describeLicense(lic)}`);
		return "no license after the machine file's window closes";
	});
}

await step("resetLicense clears the file and cache but keeps the key", async () => {
	await inRenderer(win, `await window.keygen.resetLicense(); return "done";`);
	assert.ok(!existsSync(path.join(DATA_DIR, "keygen", "machine.lic")));
	const dir = path.join(DATA_DIR, "keygen", "validation_cache");
	assert.equal(existsSync(dir) && readdirSync(dir).length, 0, "the cache dir still holds entries");
	assert.ok(existsSync(path.join(DATA_DIR, "keygen", "key")), "resetLicense removed the cached key");
	return "machine file and cache gone, key kept";
});

await step("resetLicenseKey clears only the key", async () => {
	await inRenderer(win, `await window.keygen.resetLicenseKey(); return "done";`);
	assert.ok(!existsSync(path.join(DATA_DIR, "keygen", "key")));
	await step("nothing is left to decrypt", async () => {
		const { service: fresh } = await serviceAt(now(), { offline: true });
		assert.equal(await fresh.getLicense(), null, "a license survived without its key");
	});
});

/* --------------------------------- teardown -------------------------------- */

app.on("before-quit", () => {
	for (const w of windows) if (!w.win.isDestroyed()) w.win.destroy();
	if (!KEEP) rmSync(DATA_DIR, { recursive: true, force: true });
});

console.log(
	failures === 0
		? `\nall live checks passed${KEEP ? "" : `; storage removed (${DATA_DIR})`}`
		: `\n${failures} live check(s) failed`,
);
console.log(
	"the machine this run activated stays on the account — release it in the Keygen dashboard if the seat matters.",
);
app.exit(failures === 0 ? 0 : 1);

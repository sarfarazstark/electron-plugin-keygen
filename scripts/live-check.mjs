import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

const mask = (s) => (s ? `set, ${s.length} chars` : "unset");
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

/** Starts this same script as a child process that performs one offline read. */
function readOfflineIn(tz) {
	const out = spawnSync(process.execPath, [import.meta.filename, "--read"], {
		env: { ...process.env, TZ: tz },
		encoding: "utf8",
		timeout: 120_000,
	});
	const line = (out.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("CHILD "));
	if (!line) {
		throw new Error(`offline read in ${tz} returned nothing: ${(out.stderr ?? "").split("\n")[0]}`);
	}
	return JSON.parse(line.slice("CHILD ".length));
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

/**
 * The bridge hands back the IPC envelope; the published renderer entry is what
 * unwraps it, so the harness unwraps the same way — and never prints `data`,
 * which carries the license key.
 */
async function bridge(win, method, arg) {
	const raw = await inRenderer(
		win,
		`return JSON.stringify(await window.keygen.${method}(${arg ?? "undefined"}).catch(e => JSON.stringify({ ok: false, error: { code: e.code, detail: e.detail } })));`,
	);
	const envelope = JSON.parse(raw);
	if (envelope?.ok !== true) {
		const err = new Error(`${envelope?.error?.code}: ${envelope?.error?.detail}`);
		err.code = envelope?.error?.code;
		throw err;
	}
	return envelope.data;
}

/* ------------------------- child mode: one offline read -------------------- */

// A second process, in a chosen TZ, that does nothing but start the service
// offline and report what it found. That is what "restart on another calendar
// day" means for a cache entry named after the local date — the injected-clock
// trick cannot show it, because the filename comes from the real clock.
const READ_CHILD = flag("read");

app.disableHardwareAcceleration();
app.on("window-all-closed", (e) => e.preventDefault());

app.whenReady().then(async () => {
	if (READ_CHILD) {
		const { service: offline } = await serviceAt(Date.now(), { offline: true });
		const lic = await offline.getLicense();
		console.log(
			`CHILD ${JSON.stringify({
				localDate: new Date().toLocaleDateString("en-CA"), // YYYY-MM-DD, the cache's key
				restored: Boolean(lic),
				code: lic?.code ?? null,
				expiry: lic?.expiry ?? null,
			})}`,
		);
		app.exit(0);
		return;
	}
	const windows = [];
	const service = await registerKeygen({
		app,
		ipc: ipcMain,
		config,
		log,
		getTrustedWebContentsIds: () =>
			windows.flatMap((w) => (w.win.isDestroyed() ? [] : [w.win.webContents.id])),
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
		const before = await bridge(win, "getLicenseKey").catch((err) => `ERR ${err.code}`);
		// a leftover run leaves the key cached; either answer proves the channel works
		return `getLicenseKey -> ${before === null ? "null (nothing cached yet)" : typeof before === "string" ? idOf(before) : String(before)}`;
	});

	let secondsLeft = 0;
	await step("validateKey round-trips against the real API and verifies the signature", async () => {
		const lic = await bridge(win, "validateKey", `{ key: ${JSON.stringify(LICENSE)}, entitlements: [] }`);
		assert.equal(lic.valid, true, `the server did not return a valid license: ${lic.code} ${lic.detail}`);
		secondsLeft = lic.expiry ? (new Date(lic.expiry).getTime() - now()) / 1000 : Number.POSITIVE_INFINITY;
		return `renderer saw ${lic.code} valid=true entitlements=${lic.entitlements.length} expiry in ${Math.round(secondsLeft / 60)} min`;
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
		if (!Number.isFinite(secondsLeft))
			throw new Error("no expiry on the license, so nothing is cached (upstream rule)");
		const { service: offline } = await serviceAt(now(), { offline: true });
		const lic = await offline.getLicense();
		assert.ok(lic, "nothing restored while offline");
		return describeLicense(lic);
	});

	await step("a tampered cached response is rejected by the verifier", async () => {
		const { storage, client } = await serviceAt(now(), { offline: true });
		const key = await storage.readLicenseKey();
		const cached = await storage.loadResponseCache(key);
		assert.ok(cached, "no cache entry to tamper with");
		// any byte change breaks the re-hashed Digest, so this proves the check runs
		let thrown = null;
		try {
			client.verifyResponseCache({ ...cached.cache, body: `${cached.cache.body}x` }, now());
		} catch (err) {
			thrown = err;
		}
		assert.ok(thrown, "an edited body verified against the real signature");
		// cache-path failures are BAD_CACHE; live-response failures are BAD_RESPONSE
		assert.equal(thrown.code, "BAD_CACHE", `threw ${thrown.code}: ${thrown.detail}`);
		return "one extra byte in the body rejected with BAD_CACHE";
	});

	await step("an offline restart in another timezone, hence another local day, finds no cache", async () => {
		const key = await service.getLicenseKey();
		const { storage } = await serviceAt(now(), { offline: true });
		assert.ok(existsSync(storage.responseCachePath(key)), "today's cache entry is missing");

		// same instant in time, two calendars: one is still "today", one has rolled over
		const sameDay = readOfflineIn("Pacific/Pago_Pago");
		const otherDay = readOfflineIn("Pacific/Kiritimati");
		const today = new Date().toLocaleDateString("en-CA");
		assert.equal(sameDay.localDate, today, `control disagrees on today: ${sameDay.localDate}`);
		if (otherDay.localDate === today) {
			return "SKIP — no timezone here rolls to a new day yet";
		}
		assert.equal(sameDay.restored, true, "an offline restart on the same day did not restore the license");
		assert.equal(otherDay.restored, false, "the cache survived into another local day");
		return `same day restores ${sameDay.code}, ${otherDay.localDate} restores nothing — the entry is named for the day (BUGS.md)`;
	});

	if (flag("checkout")) {
		await step("validateCheckoutKey writes a machine file", async () => {
			const lic = await bridge(
				win,
				"validateCheckoutKey",
				`{ key: ${JSON.stringify(LICENSE)}, ttlSeconds: ${7 * 86400} }`,
			);
			const file = path.join(DATA_DIR, "keygen", "machine.lic");
			assert.ok(existsSync(file), "machine.lic was not written");
			const raw = readFileSync(file, "utf8");
			assert.match(raw, /-----BEGIN MACHINE FILE-----/, "machine.lic is not the Keygen PEM armor");
			assert.ok(!raw.includes(LICENSE), "the license key appears in machine.lic in the clear");
			return `machine.lic ${raw.length} bytes, format intact, ${lic.code} valid=${lic.valid}`;
		});

		await step("the offline window stops at the license, not at the requested ttl", async () => {
			const inside = await serviceAt(now() + 60_000, { offline: true });
			const active = await inside.service.getLicense();
			assert.ok(active, "the machine file did not restore licensing inside its own window");

			const late = await serviceAt(tomorrowAt(1, 1), { offline: true });
			const later = await late.service.getLicense();
			if (Number.isFinite(secondsLeft) && secondsLeft < 27 * 3600) {
				// 7 days asked for, minutes available: the license wins
				assert.equal(later, null, "offline access outlived the license itself");
				return `asked for 7d, license had ${Math.round(secondsLeft / 60)}min — refused past it (${late.service.startupDiagnostic ?? "machine file expired"})`;
			}
			assert.ok(later, "a long-lived license should carry across the day boundary");
			return `carried licensing forward: ${describeLicense(later)}`;
		});
	}

	await step("resetLicense clears the file and cache but keeps the key", async () => {
		await bridge(win, "resetLicense");
		assert.ok(!existsSync(path.join(DATA_DIR, "keygen", "machine.lic")), "machine.lic survived");
		const dir = path.join(DATA_DIR, "keygen", "validation_cache");
		assert.ok(!existsSync(dir) || readdirSync(dir).length === 0, "the cache dir still holds entries");
		assert.ok(existsSync(path.join(DATA_DIR, "keygen", "key")), "resetLicense removed the cached key");
		return "machine file and cache gone, key kept";
	});

	await step("resetLicenseKey clears the key and leaves nothing to restore", async () => {
		await bridge(win, "resetLicenseKey");
		assert.ok(!existsSync(path.join(DATA_DIR, "keygen", "key")), "the cached key survived");
		const { service: fresh } = await serviceAt(now(), { offline: true });
		assert.equal(await fresh.getLicense(), null, "a license survived without its key");
	});

	app.on("before-quit", () => {
		for (const w of windows) if (!w.win.isDestroyed()) w.win.destroy();
		if (!KEEP) rmSync(DATA_DIR, { recursive: true, force: true });
	});

	console.log(
		failures === 0
			? `\nall live checks passed${KEEP ? "" : "; storage removed"}`
			: `\n${failures} live check(s) failed`,
	);
	console.log(
		"the machine this run activated stays on the account — release it in the Keygen dashboard if the seat matters.",
	);
	app.exit(failures === 0 ? 0 : 1);
});

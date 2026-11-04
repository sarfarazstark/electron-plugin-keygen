import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { KeygenClient } from "../lib/main/keygen/client.ts";
import { resolveConfig } from "../lib/main/keygen/config.ts";
import { KeygenStorage } from "../lib/main/keygen/storage.ts";
import { LicensingService } from "../lib/main/keygen/service.ts";
import {
	buildCacheRecord,
	buildMachineCert,
	cleanup,
	fakeCodec,
	fixedClock,
	generateTestKeys,
	mockFetch,
	notFoundBody,
	signedResponse,
	silentLog,
	testMachine,
	tmpUserDataDir,
	unsignedResponse,
	validateResponseBody,
} from "./fixtures/keygen.ts";

const keys = generateTestKeys();
const LICENSE_KEY = "KNIF-MHFL-DWKM-GOZL-WRTH";
const iso = (ms: number) => new Date(ms).toISOString();

type Env = ReturnType<typeof makeEnv>;

function makeEnv(opts: { cacheLifetime?: number; codecAvailable?: boolean } = {}) {
	const clock = fixedClock();
	const mf = mockFetch();
	const dir = tmpUserDataDir();
	const machine = { ...testMachine };
	const codec = fakeCodec(opts.codecAvailable ?? true);
	const storage = new KeygenStorage(dir, codec);
	const config = resolveConfig({
		accountId: "acc-1",
		verifyKey: keys.publicHex,
		cacheLifetime: opts.cacheLifetime,
	});
	const client = new KeygenClient(config, mf.fetch, { "User-Agent": machine.userAgent });
	const service = new LicensingService({ machine, storage, client, log: silentLog, now: clock.now });

	const validateUrl = () => client.buildUrl("licenses/actions/validate-key");
	const checkoutUrl = (params: Array<[string, string]>) =>
		client.buildUrl(`machines/${machine.fingerprint}/actions/check-out`, params);

	return { clock, mf, dir, machine, codec, storage, config, client, service, validateUrl, checkoutUrl };
}

function expectKeygenError(promise: Promise<unknown>, code: string, detailPattern?: RegExp): Promise<void> {
	return promise.then(
		() => assert.fail(`expected rejection with code ${code}`),
		(err: unknown) => {
			const e = err as { code?: string; detail?: string };
			assert.equal(e.code, code, `wrong error code: ${JSON.stringify(e)}`);
			if (detailPattern) assert.match(String(e.detail), detailPattern);
		},
	);
}

function enqueueValid(env: Env, over: Parameters<typeof validateResponseBody>[0] = {}) {
	const body = validateResponseBody({ key: LICENSE_KEY, ...over });
	env.mf.enqueue(signedResponse({ keys, url: env.validateUrl(), body, now: env.clock.now }));
	return body;
}

/* ============================== init / load =============================== */

let env: Env;
beforeEach(() => {
	env = makeEnv();
});
afterEach(() => {
	cleanup(env.dir);
});

test("starts unlicensed when nothing is on disk", async () => {
	await env.service.init();
	assert.equal(env.service.getLicense(), null);
});

test("no key file means machine.lic is not consulted (original short-circuit)", async () => {
	env.storage.saveMachineFile(
		buildMachineCert({
			keys,
			licenseKey: LICENSE_KEY,
			fingerprint: env.machine.fingerprint,
			issued: iso(env.clock.now() - 60_000),
			licenseExpiry: iso(env.clock.now() + 86_400_000),
			fileExpiry: iso(env.clock.now() + 86_400_000),
		}),
	);
	await env.service.init();
	assert.equal(env.service.getLicense(), null);
});

test("restores license from a valid machine file on startup", async () => {
	await env.storage.writeLicenseKey(LICENSE_KEY);
	env.storage.saveMachineFile(
		buildMachineCert({
			keys,
			licenseKey: LICENSE_KEY,
			fingerprint: env.machine.fingerprint,
			issued: iso(env.clock.now() - 60_000),
			licenseExpiry: iso(env.clock.now() + 86_400_000),
			fileExpiry: iso(env.clock.now() + 86_400_000),
			entitlementCodes: ["feat-pro"],
		}),
	);
	await env.service.init();
	const l = env.service.getLicense();
	assert.ok(l);
	assert.equal(l.code, "VALID");
	assert.equal(l.valid, true);
	assert.deepEqual(l.entitlements, ["feat-pro"]);
});

test("expired machine file does not become valid again, and skips cache fallback", async () => {
	await env.storage.writeLicenseKey(LICENSE_KEY);
	env.storage.saveMachineFile(
		buildMachineCert({
			keys,
			licenseKey: LICENSE_KEY,
			fingerprint: env.machine.fingerprint,
			issued: iso(env.clock.now() - 86_400_000),
			licenseExpiry: iso(env.clock.now() + 86_400_000),
			fileExpiry: iso(env.clock.now() - 1_000), // offline TTL elapsed
		}),
	);
	// even with a perfectly valid response cache present, the expired file wins
	const licBody = validateResponseBody({ key: LICENSE_KEY, expiry: iso(env.clock.now() + 3600_000) });
	const cache = buildCacheRecord({ keys, url: env.validateUrl(), body: licBody, dateMs: env.clock.now() });
	await env.storage.cacheResponse(LICENSE_KEY, cache);

	await env.service.init();
	assert.equal(env.service.getLicense(), null);
});

test("restores license from a fresh validation cache (no machine file)", async () => {
	await env.storage.writeLicenseKey(LICENSE_KEY);
	const licBody = validateResponseBody({
		key: LICENSE_KEY,
		expiry: iso(env.clock.now() + 3600_000),
		entitlements: ["a", "b"],
	});
	await env.storage.cacheResponse(
		LICENSE_KEY,
		buildCacheRecord({ keys, url: env.validateUrl(), body: licBody, dateMs: env.clock.now() - 60_000 }),
	);
	await env.service.init();
	const l = env.service.getLicense();
	assert.ok(l);
	assert.equal(l.code, "VALID");
	assert.deepEqual(l.entitlements, ["a", "b"]);
});

test("cache older than cache_lifetime yields no license and deletes stale entries", async () => {
	env = makeEnv({ cacheLifetime: 60 });
	await env.storage.writeLicenseKey(LICENSE_KEY);
	const licBody = validateResponseBody({ key: LICENSE_KEY, expiry: iso(env.clock.now() + 3600_000) });
	await env.storage.cacheResponse(
		LICENSE_KEY,
		buildCacheRecord({ keys, url: env.validateUrl(), body: licBody, dateMs: env.clock.now() - 61 * 60_000 }),
	);
	await env.service.init();
	assert.equal(env.service.getLicense(), null);
});

test("cache tampering after the fact is caught (signature over re-hashed body)", async () => {
	await env.storage.writeLicenseKey(LICENSE_KEY);
	const licBody = validateResponseBody({ key: LICENSE_KEY, expiry: iso(env.clock.now() + 3600_000) });
	const cache = buildCacheRecord({ keys, url: env.validateUrl(), body: licBody, dateMs: env.clock.now() });
	await env.storage.cacheResponse(LICENSE_KEY, cache);
	// attacker edits the on-disk cache to extend validity
	const loaded = await env.storage.loadResponseCache(LICENSE_KEY);
	assert.ok(loaded);
	fs.writeFileSync(
		loaded.path,
		JSON.stringify({
			...cache,
			body: validateResponseBody({ key: LICENSE_KEY, expiry: iso(env.clock.now() + 999 * 86_400_000) }),
		}),
	);
	await env.service.init();
	assert.equal(env.service.getLicense(), null);
});

test("undecryptable machine file (wrong machine) does not brick the cache path", async () => {
	await env.storage.writeLicenseKey(LICENSE_KEY);
	env.storage.saveMachineFile(
		buildMachineCert({
			keys,
			licenseKey: LICENSE_KEY,
			fingerprint: "some-other-machine",
			issued: iso(env.clock.now() - 60_000),
			licenseExpiry: iso(env.clock.now() + 86_400_000),
			fileExpiry: iso(env.clock.now() + 86_400_000),
		}),
	);
	const licBody = validateResponseBody({ key: LICENSE_KEY, expiry: iso(env.clock.now() + 3600_000) });
	await env.storage.cacheResponse(
		LICENSE_KEY,
		buildCacheRecord({ keys, url: env.validateUrl(), body: licBody, dateMs: env.clock.now() }),
	);
	await env.service.init();
	// decrypt fails -> fall through to response cache, like the original
	assert.ok(env.service.getLicense());
});

/* ============================= validateKey ============================== */

test("validateKey happy path caches response, key and state", async () => {
	enqueueValid(env, { expiry: iso(env.clock.now() + 3600_000) });
	const l = await env.service.validateKey({ key: `${LICENSE_KEY}   ` }); // trimEnd like the original
	assert.equal(l.code, "VALID");
	assert.equal(l.valid, true);
	assert.ok(l.expiry);
	// "id" never crosses IPC
	assert.equal("id" in l, false);

	// request shape
	const call = env.mf.calls[0];
	assert.ok(call);
	assert.match(call.url, /licenses\/actions\/validate-key$/);
	const body = JSON.parse(String(call.init.body));
	assert.equal(body.meta.key, LICENSE_KEY);
	assert.equal(body.meta.scope.fingerprint, env.machine.fingerprint);
	assert.equal(body.meta.scope.entitlements, undefined);
	assert.equal(call.init.headers["Content-Type"], "application/vnd.api+json");

	// side effects
	assert.equal(fs.existsSync(env.storage.keyFilePath()), true);
	const cached = await env.storage.loadResponseCache(LICENSE_KEY);
	assert.ok(cached);
	assert.equal(JSON.parse(cached.cache.body).meta.code, "VALID");
	assert.ok(env.service.getLicense());
});

test("validateKey caches key but not response when cacheValidResponse=false", async () => {
	enqueueValid(env, { expiry: iso(env.clock.now() + 3600_000) });
	await env.service.validateKey({ key: LICENSE_KEY, cacheValidResponse: false });
	assert.equal(fs.existsSync(env.storage.keyFilePath()), true);
	assert.equal(await env.storage.loadResponseCache(LICENSE_KEY), null);
});

test("validateKey does not cache an un-activated response (expiry null)", async () => {
	enqueueValid(env, { expiry: null });
	await env.service.validateKey({ key: LICENSE_KEY });
	assert.equal(await env.storage.loadResponseCache(LICENSE_KEY), null);
	// valid, so the key is cached even though there is nothing to cache a response for
	assert.equal(await env.storage.readLicenseKey(), LICENSE_KEY);
});

test("an invalid result is not persisted and does not clobber a cached key", async () => {
	// The original cached every returned key, revoked and banned ones included.
	await env.storage.writeLicenseKey(LICENSE_KEY);
	enqueueValid(env, {
		valid: false,
		code: "BANNED",
		detail: "banned",
		expiry: iso(env.clock.now() + 3600_000),
	});

	const l = await env.service.validateKey({ key: "BANNED-KEY-4321" });
	assert.equal(l.valid, false);
	assert.equal(await env.storage.readLicenseKey(), LICENSE_KEY, "no new key written, previous one untouched");
	assert.equal(await env.storage.loadResponseCache("BANNED-KEY-4321"), null);
});

test("validateKey sends requested entitlements", async () => {
	enqueueValid(env, { expiry: iso(env.clock.now() + 3600_000), entitlements: ["feat-pro"] });
	await env.service.validateKey({ key: LICENSE_KEY, entitlements: ["feat-pro"] });
	const body = JSON.parse(String(env.mf.calls[0]?.init.body));
	assert.deepEqual(body.meta.scope.entitlements, ["feat-pro"]);
});

test("validateKey rejects NOT_FOUND meta code", async () => {
	env.mf.enqueue(signedResponse({ keys, url: env.validateUrl(), body: notFoundBody(), now: env.clock.now }));
	await expectKeygenError(env.service.validateKey({ key: LICENSE_KEY }), "NOT_FOUND");
});

test("validateKey rejects an unsigned 200 response", async () => {
	env.mf.enqueue(unsignedResponse(200, validateResponseBody({}), { Date: env.clock.rfc2822() }));
	await expectKeygenError(env.service.validateKey({ key: LICENSE_KEY }), "BAD_RESPONSE", /Missing header/);
	assert.equal(env.service.getLicense(), null, "state must not update on rejected response");
});

test("validateKey passes through Keygen 4xx error codes", async () => {
	env.mf.enqueue(
		unsignedResponse(
			422,
			JSON.stringify({ errors: [{ code: "LICENSE_VALIDATION_FAILED", detail: "License is invalidated" }] }),
		),
	);
	await expectKeygenError(env.service.validateKey({ key: LICENSE_KEY }), "LICENSE_VALIDATION_FAILED");
});

test("validateKey maps unknown 4xx bodies to UNKNOWN", async () => {
	env.mf.enqueue(unsignedResponse(400, "{}"));
	await expectKeygenError(env.service.validateKey({ key: LICENSE_KEY }), "UNKNOWN");
});

test("validateKey maps 5xx to HTTP_ERROR", async () => {
	// the Rust client parses the body as JSON before matching on status, so a
	// non-JSON 5xx body surfaces as ERR; with a JSON body it becomes HTTP_ERROR
	env.mf.enqueue(unsignedResponse(500, "{}"));
	await expectKeygenError(env.service.validateKey({ key: LICENSE_KEY }), "HTTP_ERROR", /500/);

	env.mf.enqueue(unsignedResponse(500, "boom"));
	await expectKeygenError(env.service.validateKey({ key: LICENSE_KEY }), "ERR", /response json/);
});

test("validateKey maps network failures to REQUEST_ERROR", async () => {
	env.mf.enqueue(new Error("ECONNREFUSED"));
	await expectKeygenError(env.service.validateKey({ key: LICENSE_KEY }), "REQUEST_ERROR");
});

test("empty fingerprint blocks validation with NO_FINGERPRINT", async () => {
	env.machine.fingerprint = "";
	await expectKeygenError(env.service.validateKey({ key: LICENSE_KEY }), "NO_FINGERPRINT");
	assert.equal(env.mf.calls.length, 0);
});

test("validateKey auto-activates NO_MACHINE then re-validates", async () => {
	// 1st validate: license exists but no machine for this fingerprint
	enqueueValid(env, { code: "NO_MACHINE", valid: false, detail: "no machine" });
	// activate: 201 + signature
	const machineBody = JSON.stringify({ data: { id: "m-1", type: "machines", attributes: {} } });
	const machinesUrl = env.client.buildUrl("machines");
	env.mf.enqueue(
		signedResponse({ keys, url: machinesUrl, body: machineBody, now: env.clock.now, status: 201 }),
	);
	// 2nd validate: VALID
	enqueueValid(env, { expiry: iso(env.clock.now() + 3600_000) });

	const l = await env.service.validateKey({ key: LICENSE_KEY });
	assert.equal(l.code, "VALID");
	assert.equal(env.mf.calls.length, 3);
	assert.match(env.mf.calls[1]?.url ?? "", /\/machines$/);
	assert.equal(env.mf.calls[1]?.init.headers.Authorization, `License ${LICENSE_KEY}`);
});

test("activate without prior validation fails with NO_LICENSE", async () => {
	await expectKeygenError(env.service.activate(), "NO_LICENSE");
});

test("an unusable vault skips persistence instead of failing a successful validation", async () => {
	env = makeEnv({ codecAvailable: false });
	enqueueValid(env, { expiry: iso(env.clock.now() + 3600_000) });
	const license = await env.service.validateKey({ key: LICENSE_KEY });

	assert.equal(license.valid, true);
	assert.ok(env.service.getLicense(), "reported result and state agree");
	assert.equal(env.service.persistsLicenses, false);
	assert.equal(fs.existsSync(env.storage.keyFilePath()), false, "nothing unprotected reaches disk");
});

/* ============================== checkout ================================ */

async function licensedWith(env: Env, over: Parameters<typeof validateResponseBody>[0]) {
	enqueueValid(env, over);
	await env.service.validateKey({ key: LICENSE_KEY });
}

function enqueueCheckoutOk(env: Env, params: Array<[string, string]>, cert?: string) {
	const certificate =
		cert ??
		buildMachineCert({
			keys,
			licenseKey: LICENSE_KEY,
			fingerprint: env.machine.fingerprint,
			issued: iso(env.clock.now() - 60_000),
			licenseExpiry: iso(env.clock.now() + 86_400_000),
			fileExpiry: iso(env.clock.now() + 86_400_000),
		});
	const body = JSON.stringify({ data: { id: "m-1", attributes: { certificate } } });
	env.mf.enqueue(signedResponse({ keys, url: env.checkoutUrl(params), body, now: env.clock.now }));
	return certificate;
}

test("checkout preconditions mirror the Rust checks", async () => {
	await expectKeygenError(env.service.checkout(3600, false), "NO_LICENSE");

	await licensedWith(env, { valid: false, code: "MACHINE_SCOPE_MISMATCH", detail: "mismatch" });
	await expectKeygenError(env.service.checkout(3600, false), "INVALID_LICENSE");
});

test("checkout rejects un-activated license (expiry null)", async () => {
	await licensedWith(env, { expiry: null });
	await expectKeygenError(env.service.checkout(3600, false), "NOT_ACTIVATED");
});

test("checkout rejects an expired license that cannot maintain access", async () => {
	await licensedWith(env, { expiry: iso(env.clock.now() - 100_000), code: "VALID", valid: true });
	await expectKeygenError(env.service.checkout(3600, false), "EXPIRED");
});

test("checkout persists the certificate after signature verification", async () => {
	await licensedWith(env, { expiry: iso(env.clock.now() + 86_400_000) });
	const params: Array<[string, string]> = [
		["encrypt", "1"],
		["include", "license.entitlements,license"],
		["ttl", "3600"],
	];
	const cert = enqueueCheckoutOk(env, params);

	await env.service.checkout(3600, false);
	assert.equal(env.storage.readMachineFile(), cert);

	const call = env.mf.calls[1];
	assert.ok(call);
	assert.match(call.url, /actions\/check-out/);
	assert.equal(call.init.headers.Accept, "application/vnd.api+json");
	assert.equal(call.init.headers["Content-Type"], undefined, "original sends no Content-Type here");
	assert.match(call.url, /include=license\.entitlements%2Clicense/);
});

test("checkout ttl is clamped to >= 1 hour", async () => {
	await licensedWith(env, { expiry: iso(env.clock.now() + 86_400_000) });
	const params: Array<[string, string]> = [
		["encrypt", "1"],
		["include", "license.entitlements,license"],
		["ttl", "3600"],
	];
	enqueueCheckoutOk(env, params);
	await env.service.checkout(10, false); // 10s -> clamped up to 3600
	const url = new URL(String(env.mf.calls[1]?.url));
	assert.equal(url.searchParams.get("ttl"), "3600");
});

test("checkout ttl never exceeds license expiry", async () => {
	await licensedWith(env, { expiry: iso(env.clock.now() + 70 * 60_000) });
	const params: Array<[string, string]> = [
		["encrypt", "1"],
		["include", "license.entitlements,license"],
		["ttl", "4200"],
	];
	enqueueCheckoutOk(env, params);
	await env.service.checkout(86_400, false);
	const url = new URL(String(env.mf.calls[1]?.url));
	assert.equal(url.searchParams.get("ttl"), "4200");
});

test("checkout rejects expiry inside the current minute (Rust minute truncation)", async () => {
	// has_expired() truncates the remaining duration to whole minutes, so a
	// license expiring in 10s counts as expired and blocks checkout
	await licensedWith(env, { expiry: iso(env.clock.now() + 10_000) });
	await expectKeygenError(Promise.resolve(env.service.checkout(86_400, false)), "EXPIRED");
});

test("ttlForever on a maintained EXPIRED license sends empty ttl", async () => {
	await licensedWith(env, { code: "EXPIRED", valid: true, expiry: iso(env.clock.now() - 100_000) });
	const params: Array<[string, string]> = [
		["encrypt", "1"],
		["include", "license.entitlements,license"],
		["ttl", ""],
	];
	enqueueCheckoutOk(env, params);
	await env.service.checkout(86_400, true);
	const url = new URL(String(env.mf.calls[1]?.url));
	assert.equal(url.searchParams.get("ttl"), "");
	assert.ok(env.storage.readMachineFile());
});

test("a maintained license past its expiry omits ttl instead of sending a negative one", async () => {
	await licensedWith(env, { code: "EXPIRED", valid: true, expiry: iso(env.clock.now() - 100_000) });
	const params: Array<[string, string]> = [
		["encrypt", "1"],
		["include", "license.entitlements,license"],
	];
	enqueueCheckoutOk(env, params);
	await env.service.checkout(86_400, false);
	const url = new URL(String(env.mf.calls[1]?.url));
	assert.equal(url.searchParams.has("ttl"), false, "the server default applies; no negative lifetime");
});

test("checkout refuses when the vault cannot persist the key the machine file needs", async () => {
	env = makeEnv({ codecAvailable: false });
	await licensedWith(env, { expiry: iso(env.clock.now() + 86_400_000) });
	await expectKeygenError(env.service.checkout(3600, false), "STORAGE_UNAVAILABLE");
	assert.equal(env.storage.readMachineFile(), null, "no unusable machine file is issued");
});

test("checkout with a bad response signature does not save the file", async () => {
	await licensedWith(env, { expiry: iso(env.clock.now() + 86_400_000) });
	const body = JSON.stringify({ data: { attributes: { certificate: "FAKE-CERT" } } });
	const params: Array<[string, string]> = [
		["encrypt", "1"],
		["include", "license.entitlements,license"],
		["ttl", "3600"],
	];
	const rogue = generateTestKeys();
	env.mf.enqueue(signedResponse({ keys: rogue, url: env.checkoutUrl(params), body, now: env.clock.now }));
	await expectKeygenError(env.service.checkout(3600, false), "BAD_RESPONSE", /Invalid Signature/);
	assert.equal(env.storage.readMachineFile(), null);
});

test("validateCheckoutKey validates without response caching, then checks out", async () => {
	enqueueValid(env, { expiry: iso(env.clock.now() + 86_400_000) });
	const params: Array<[string, string]> = [
		["encrypt", "1"],
		["include", "license.entitlements,license"],
		["ttl", "86400"],
	];
	enqueueCheckoutOk(env, params);

	const l = await env.service.validateCheckoutKey({ key: LICENSE_KEY, ttlSeconds: 86_400 });
	assert.equal(l.valid, true);
	assert.equal(env.mf.calls.length, 2);
	assert.equal(
		await env.storage.loadResponseCache(LICENSE_KEY),
		null,
		"checkout flow must not write response cache",
	);
	assert.ok(env.storage.readMachineFile());
});

test("validateCheckoutKey on an invalid license does not check out", async () => {
	enqueueValid(env, { valid: false, code: "INVALID_LICENSE", detail: "nope" });
	const l = await env.service.validateCheckoutKey({ key: LICENSE_KEY });
	assert.equal(l.valid, false);
	assert.equal(env.mf.calls.length, 1);
});

/* =============================== resets ================================= */

test("resetLicense clears files + state but keeps the cached key", async () => {
	enqueueValid(env, { expiry: iso(env.clock.now() + 86_400_000) });
	const params: Array<[string, string]> = [
		["encrypt", "1"],
		["include", "license.entitlements,license"],
		["ttl", "3600"],
	];
	enqueueCheckoutOk(env, params);
	await env.service.validateCheckoutKey({ key: LICENSE_KEY, ttlSeconds: 3600 });
	await env.service.validateKey({ key: LICENSE_KEY, expiry: undefined } as never).catch(() => {});
	// ensure a response cache exists for this scenario
	enqueueValid(env, { expiry: iso(env.clock.now() + 86_400_000) });
	await env.service.validateKey({ key: LICENSE_KEY });

	env.service.resetLicense();
	assert.equal(env.service.getLicense(), null);
	assert.equal(env.storage.readMachineFile(), null);
	assert.equal(await env.storage.loadResponseCache(LICENSE_KEY), null);
	assert.equal(await env.storage.readLicenseKey(), LICENSE_KEY, "key file must survive resetLicense()");
});

test("resetLicenseKey removes only the cached key", async () => {
	enqueueValid(env, { expiry: iso(env.clock.now() + 86_400_000) });
	await env.service.validateKey({ key: LICENSE_KEY });
	const cert = buildMachineCert({
		keys,
		licenseKey: LICENSE_KEY,
		fingerprint: env.machine.fingerprint,
		issued: iso(env.clock.now() - 60_000),
		licenseExpiry: iso(env.clock.now() + 86_400_000),
		fileExpiry: iso(env.clock.now() + 86_400_000),
	});
	env.storage.saveMachineFile(cert);

	env.service.resetLicenseKey();
	assert.equal(await env.storage.readLicenseKey(), null);
	assert.equal(env.storage.readMachineFile(), cert);
	assert.ok(env.service.getLicense(), "in-memory license is untouched by resetLicenseKey");
});

/* =========================== restart persistence =========================== */

test("license persists across restarts via machine file", async () => {
	enqueueValid(env, { expiry: iso(env.clock.now() + 86_400_000) });
	const params: Array<[string, string]> = [
		["encrypt", "1"],
		["include", "license.entitlements,license"],
		["ttl", "86400"],
	];
	enqueueCheckoutOk(env, params);
	await env.service.validateCheckoutKey({ key: LICENSE_KEY });

	// "restart": brand-new service over the same directory/clock
	const restart = makeEnvReusing(env);
	await restart.service.init();
	const l = restart.service.getLicense();
	assert.ok(l);
	assert.equal(l.code, "VALID");
	assert.equal(l.key, LICENSE_KEY);
});

function makeEnvReusing(source: Env): Env {
	const clock = source.clock;
	const mf = mockFetch();
	const storage = new KeygenStorage(source.dir, source.codec);
	const client = new KeygenClient(source.config, mf.fetch, { "User-Agent": source.machine.userAgent });
	const service = new LicensingService({
		machine: source.machine,
		storage,
		client,
		log: silentLog,
		now: clock.now,
	});
	return {
		clock,
		mf,
		dir: source.dir,
		machine: source.machine,
		codec: source.codec,
		storage,
		config: source.config,
		client,
		service,
		validateUrl: () => client.buildUrl("licenses/actions/validate-key"),
		checkoutUrl: (p) => client.buildUrl(`machines/${source.machine.fingerprint}/actions/check-out`, p),
	};
}

/* ============================ getLicenseKey =============================== */

test("getLicenseKey returns the decrypted key; decrypt failure is explicit", async () => {
	enqueueValid(env, { expiry: iso(env.clock.now() + 3600_000) });
	await env.service.validateKey({ key: LICENSE_KEY });
	assert.equal(await env.service.getLicenseKey(), LICENSE_KEY);

	fs.writeFileSync(env.storage.keyFilePath(), Buffer.from("undecryptable"));
	await expectKeygenError((async () => env.service.getLicenseKey())(), "STORAGE_DECRYPT_FAILED");
});

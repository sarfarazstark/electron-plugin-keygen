import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { KeygenStorage, toLocalDateNaive } from "../lib/main/keygen/storage.ts";
import { sha256Hex } from "../lib/main/keygen/crypto.ts";
import { fakeCodec, tmpUserDataDir, cleanup } from "./fixtures/keygen.ts";

let dir: string;
let storage: KeygenStorage;
const extraDirs: string[] = [];

before(() => {
	dir = tmpUserDataDir();
	storage = new KeygenStorage(dir, fakeCodec());
});

after(() => {
	cleanup(dir);
	for (const extra of extraDirs) cleanup(extra);
});

test("directory layout matches the original plugin", () => {
	assert.equal(storage.machineFilePath(), path.join(dir, "keygen", "machine.lic"));
	assert.equal(storage.keyFilePath(), path.join(dir, "keygen", "key"));
	assert.equal(storage.cacheDir(), path.join(dir, "keygen", "validation_cache"));
});

test("local date naive uses YYYY-MM-DD", () => {
	const d = new Date(2026, 10, 4);
	assert.equal(toLocalDateNaive(d), "2026-11-04");
});

test("response cache path is sha256 of key:YYYY-MM-DD", () => {
	const p = storage.responseCachePath("KEY-1", new Date(2026, 10, 4));
	assert.equal(path.basename(p), sha256Hex("KEY-1:2026-11-04"));
});

test("machine file save/read/remove", () => {
	storage.saveMachineFile("CERT");
	assert.equal(fs.readFileSync(storage.machineFilePath(), "utf8"), "CERT");
	assert.equal(storage.readMachineFile(), "CERT");
	storage.removeMachineFile();
	assert.equal(storage.readMachineFile(), null);
});

test("license key is persisted through the codec, never as bare plaintext", () => {
	storage.writeLicenseKey("SECRET-KEY");
	const raw = fs.readFileSync(storage.keyFilePath());
	// The production codec is safeStorage (DPAPI). With the test codec we can
	// only assert the layer contract: bytes === codec.encrypt(key), and the
	// plaintext file is not written verbatim.
	assert.deepEqual(raw, fakeCodec().encrypt("SECRET-KEY"));
	assert.notEqual(raw.toString("utf8"), "SECRET-KEY");
	assert.equal(storage.readLicenseKey(), "SECRET-KEY");
	storage.removeLicenseKey();
	assert.equal(storage.readLicenseKey(), null);
});

test("writeLicenseKey refuses to fall back to plaintext", () => {
	const codec = fakeCodec(false);
	const s = new KeygenStorage(tmpUserDataDir(), codec);
	assert.throws(
		() => s.writeLicenseKey("K"),
		(err: unknown) => (err as { code?: string }).code === "STORAGE_UNAVAILABLE",
	);
});

test("readLicenseKey surfaces availability and decrypt failures explicitly", () => {
	const codec = fakeCodec(true);
	const altDir = `${dir}-2`;
	const s = new KeygenStorage(altDir, codec);
	extraDirs.push(altDir);
	s.writeLicenseKey("K1");
	// corruption on the same OS user: ciphertext that this machine can't decrypt
	fs.writeFileSync(s.keyFilePath(), Buffer.from("garbage-bytes"));
	assert.throws(
		() => s.readLicenseKey(),
		(err: unknown) => (err as { code?: string }).code === "STORAGE_DECRYPT_FAILED",
	);
	// DPAPI/session unavailable at read time (e.g. keyring removed)
	codec.setAvailable(false);
	fs.writeFileSync(s.keyFilePath(), Buffer.from("FX::K1"));
	assert.throws(
		() => s.readLicenseKey(),
		(err: unknown) => (err as { code?: string }).code === "STORAGE_UNAVAILABLE",
	);
});

test("cache response roundtrip + malformed cache detection", () => {
	const cache = { sig: "s", target: "post /x", host: "h", date: "d", body: "b" };
	storage.cacheResponse("KEY-2", cache);
	const loaded = storage.loadResponseCache("KEY-2");
	assert.ok(loaded);
	assert.deepEqual(loaded.cache, cache);

	fs.writeFileSync(loaded.path, "not json");
	assert.throws(() => storage.loadResponseCache("KEY-2"), /Failed parsing response cache to json/);

	fs.writeFileSync(loaded.path, '{"sig":1}');
	assert.throws(() => storage.loadResponseCache("KEY-2"), /Failed deserializing response cache/);
});

test("clearResponseCacheExcept keeps only today's entry", () => {
	const cache = { sig: "s", target: "t", host: "h", date: "d", body: "b" };
	storage.cacheResponse("KEY-3", cache);
	const today = storage.responseCachePath("KEY-3");
	const stale = path.join(storage.cacheDir(), "stale-entry");
	fs.writeFileSync(stale, "{}");

	storage.clearResponseCacheExcept(today);
	assert.ok(fs.existsSync(today));
	assert.equal(fs.existsSync(stale), false);

	storage.clearResponseCache();
	assert.equal(fs.existsSync(storage.cacheDir()), false);
});

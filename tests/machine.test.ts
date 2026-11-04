import assert from "node:assert/strict";
import { test } from "node:test";
import { KeygenClient } from "../lib/main/keygen/client.ts";
import { resolveConfig } from "../lib/main/keygen/config.ts";
import {
	createMachine,
	decryptMachineFile,
	readMachineId,
	readPlatformString,
} from "../lib/main/keygen/machine.ts";
import { buildMachineCert, generateTestKeys, mockFetch, testMachine } from "./fixtures/keygen.ts";

const keys = generateTestKeys();
const config = resolveConfig({ accountId: "acc-1", verifyKey: keys.publicHex });
const client = new KeygenClient(config, mockFetch().fetch, {});
const verify = (d: string, s: string) => client.verifySignature(d, s);

const LICENSE_KEY = "KNIF-MHFL-DWKM-GOZL-WRTH";
const now = Date.UTC(2026, 10, 4, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

function cert(over: Partial<Parameters<typeof buildMachineCert>[0]> = {}) {
	return buildMachineCert({
		keys,
		licenseKey: LICENSE_KEY,
		fingerprint: testMachine.fingerprint,
		issued: iso(now - 60_000),
		licenseExpiry: iso(now + 86_400_000),
		fileExpiry: iso(now + 86_400_000),
		...over,
	});
}

/* ---------------------------- fingerprinting ------------------------------ */

test("readMachineId is stable across calls on this host", () => {
	const a = readMachineId();
	const b = readMachineId();
	assert.equal(a, b);
	// the plugin's contract: never empty on a healthy machine
	if (process.platform === "win32" || process.platform === "linux" || process.platform === "darwin") {
		assert.ok(a.length > 0, "expected a non-empty machine id");
	}
});

test("readPlatformString has the 'os - distro - arch' shape", () => {
	const p = readPlatformString();
	assert.equal(p.split(" - ").length, 3);
});

test("createMachine uses injected identity and formats the UA", () => {
	const m = createMachine({
		appName: "motus",
		appVersion: "1.2.3",
		locale: "en-US",
		fingerprint: () => "fp-1",
		deviceName: () => "BOX",
		platformString: () => "Windows - Windows 11 Pro - x86_64",
	});
	assert.equal(m.fingerprint, "fp-1");
	assert.equal(m.name, "BOX");
	assert.match(m.userAgent, /^motus\/1\.2\.3 Windows\/Windows 11 Pro Electron\/\S+ en-US$/);
});

test("createMachine degrades to empty fingerprint on reader failure", () => {
	const m = createMachine({
		appName: "a",
		appVersion: "1",
		locale: "",
		fingerprint: () => {
			throw new Error("registry gone");
		},
	});
	assert.equal(m.fingerprint, "");
});

/* ---------------------------- machine file crypto ------------------------- */

test("decryptMachineFile roundtrip with a fixture certificate", () => {
	const ml = decryptMachineFile(cert(), LICENSE_KEY, testMachine.fingerprint, verify);
	assert.equal(ml.meta.issued, iso(now - 60_000));
	const lic = ml.included.find((i) => i.type === "licenses");
	assert.ok(lic && lic.type === "licenses");
	assert.equal(lic.attributes.key, LICENSE_KEY);
});

test("decryptMachineFile fails with the wrong license key", () => {
	assert.throws(
		() => decryptMachineFile(cert(), "WRONG-KEY", testMachine.fingerprint, verify),
		/Failed decrypting machine file/,
	);
});

test("decryptMachineFile fails with the wrong fingerprint", () => {
	assert.throws(
		() => decryptMachineFile(cert(), LICENSE_KEY, "other-machine", verify),
		/Failed decrypting machine file/,
	);
});

test("decryptMachineFile rejects a tampered envelope signature", () => {
	const good = cert();
	// flip one char inside the base64 payload (after the PEM armor)
	const lines = good.split("\n");
	const payload = lines[1] ?? "";
	const flipped = payload.slice(0, 5) + (payload[5] === "A" ? "B" : "A") + payload.slice(6);
	const tampered = [lines[0], flipped, lines[2]].join("\n");
	assert.throws(
		() => decryptMachineFile(tampered, LICENSE_KEY, testMachine.fingerprint, verify),
		/Invalid signature|machine file/,
	);
});

test("decryptMachineFile rejects an unsupported algorithm", () => {
	assert.throws(
		() =>
			decryptMachineFile(cert({ alg: "aes-128-gcm+ed25519" }), LICENSE_KEY, testMachine.fingerprint, verify),
		/algorithm is not supported/,
	);
});

test("decryptMachineFile rejects garbage", () => {
	assert.throws(
		() =>
			decryptMachineFile(
				"-----BEGIN MACHINE FILE-----\n!!!not-base64!!!\n-----END MACHINE FILE-----",
				LICENSE_KEY,
				testMachine.fingerprint,
				verify,
			),
		/Failed decoding machine file/,
	);
	assert.throws(
		() =>
			decryptMachineFile(
				"-----BEGIN MACHINE FILE-----\n" +
					Buffer.from("{}".repeat(2)).toString("base64") +
					"\n-----END MACHINE FILE-----",
				LICENSE_KEY,
				testMachine.fingerprint,
				verify,
			),
		/failed deserializing machine file/,
	);
});

test("machine file signed by a foreign key is rejected", () => {
	const rogue = generateTestKeys();
	assert.throws(
		() => decryptMachineFile(cert({ keys: rogue }), LICENSE_KEY, testMachine.fingerprint, verify),
		/Invalid signature/,
	);
});

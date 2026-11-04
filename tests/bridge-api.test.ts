import assert from "node:assert/strict";
import { test } from "node:test";
import { createKeygenBridge } from "../lib/preload/api.ts";
import { createKeygenLicensingApi, isKeygenError, keygen } from "../lib/renderer/index.ts";
import { KeygenError } from "../lib/shared/keygen-error.ts";
import { KEYGEN_CHANNELS, type KeygenBridge, type KeygenLicense } from "../lib/shared/keygen-types.ts";

const license: KeygenLicense = {
	key: "K",
	code: "VALID",
	detail: "is valid",
	expiry: null,
	valid: true,
	policyId: "p",
	entitlements: [],
	metadata: {},
};

function makeInvoke(result: unknown) {
	const calls: Array<{ channel: string; args: unknown[] }> = [];
	return {
		calls,
		invoke: async (channel: string, ...args: unknown[]) => {
			calls.push({ channel, args });
			return result;
		},
	};
}

/* ------------------------- preload side: the bridge ------------------------ */

test("bridge exposes exactly the six methods", () => {
	const bridge = createKeygenBridge(async () => ({ ok: true, data: null }));
	assert.deepEqual(Object.keys(bridge).sort(), [
		"getLicense",
		"getLicenseKey",
		"resetLicense",
		"resetLicenseKey",
		"validateCheckoutKey",
		"validateKey",
	]);
});

test("bridge calls only its own channel and returns the envelope untouched", async () => {
	const { invoke, calls } = makeInvoke({ ok: true, data: license });
	const bridge = createKeygenBridge(invoke);

	assert.deepEqual(await bridge.getLicense(), { ok: true, data: license });
	await bridge.validateKey({ key: "K" });
	await bridge.validateCheckoutKey({ key: "K", ttlSeconds: 60 });
	await bridge.resetLicense();
	await bridge.resetLicenseKey();
	await bridge.getLicenseKey();

	assert.deepEqual(
		calls.map((c) => c.channel),
		[
			KEYGEN_CHANNELS.getLicense,
			KEYGEN_CHANNELS.validateKey,
			KEYGEN_CHANNELS.validateCheckoutKey,
			KEYGEN_CHANNELS.resetLicense,
			KEYGEN_CHANNELS.resetLicenseKey,
			KEYGEN_CHANNELS.getLicenseKey,
		],
	);
	// only the options object crosses; no call is given a channel of its own
	assert.deepEqual(calls[1]?.args, [{ key: "K" }]);
});

test("bridge never invents an error: a failed envelope is data, not a throw", async () => {
	const { invoke } = makeInvoke({ ok: false, error: { code: "BAD_RESPONSE", detail: "Invalid Signature" } });
	const bridge = createKeygenBridge(invoke);
	assert.deepEqual(await bridge.validateKey({ key: "K" }), {
		ok: false,
		error: { code: "BAD_RESPONSE", detail: "Invalid Signature" },
	});
});

/* ------------------- renderer side: the licensed API ---------------------- */

function bridgeReturning(result: unknown): KeygenBridge {
	const run = async () => result as never;
	return {
		getLicense: run,
		getLicenseKey: run,
		validateKey: run,
		validateCheckoutKey: run,
		resetLicense: run,
		resetLicenseKey: run,
	} as unknown as KeygenBridge;
}

test("ok envelope unwraps to data; void channels yield undefined", async () => {
	const api = createKeygenLicensingApi(bridgeReturning({ ok: true, data: license }));
	assert.deepEqual(await api.getLicense(), license);

	const voidApi = createKeygenLicensingApi(bridgeReturning({ ok: true, data: null }));
	assert.equal(await voidApi.resetLicense(), undefined);
	assert.equal(await voidApi.resetLicenseKey(), undefined);
});

test("error envelope becomes a real KeygenError in the renderer realm", async () => {
	const api = createKeygenLicensingApi(
		bridgeReturning({
			ok: false,
			error: { code: "LICENSE_VALIDATION_FAILED", detail: "License is invalidated" },
		}),
	);
	await assert.rejects(api.validateKey({ key: "K" }), (err: unknown) => {
		assert.ok(err instanceof KeygenError, "instanceof KeygenError must work for the app");
		assert.ok(isKeygenError(err));
		assert.equal(err.code, "LICENSE_VALIDATION_FAILED");
		assert.equal(err.detail, "License is invalidated");
		assert.equal(err.message, "Keygen Error: LICENSE_VALIDATION_FAILED: License is invalidated");
		return true;
	});
});

test("a malformed IPC response fails closed", async () => {
	// `{ ok: true }` is a success with no payload, so it is not in this list
	for (const bad of [undefined, null, {}, { ok: false }, "nope", 42]) {
		const api = createKeygenLicensingApi(bridgeReturning(bad));
		await assert.rejects(api.getLicense(), (err: unknown) => {
			assert.ok(err instanceof KeygenError);
			assert.equal(err.code, "unknown");
			return true;
		});
	}
});

test("without a bridge every call is refused rather than silently succeeding", async () => {
	const api = createKeygenLicensingApi(null);
	await assert.rejects(api.getLicense(), (err: unknown) => {
		assert.ok(err instanceof KeygenError);
		assert.equal(err.code, "NO_KEYGEN_BRIDGE");
		return true;
	});
	await assert.rejects(api.validateKey({ key: "K" }), { code: "NO_KEYGEN_BRIDGE" });
	await assert.rejects(api.resetLicenseKey(), { code: "NO_KEYGEN_BRIDGE" });

	// the exported singleton reads globalThis.keygen at call time
	assert.equal((globalThis as { keygen?: unknown }).keygen, undefined);
	await assert.rejects(keygen.getLicense(), { code: "NO_KEYGEN_BRIDGE" });

	(globalThis as { keygen?: KeygenBridge }).keygen = bridgeReturning({ ok: true, data: "KEY-9" }) as never;
	assert.equal(await keygen.getLicenseKey(), "KEY-9");
	delete (globalThis as { keygen?: KeygenBridge }).keygen;
});

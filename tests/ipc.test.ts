import assert from "node:assert/strict";
import { test } from "node:test";
import { registerKeygenIpc, makeWindowTrustChecker, type IpcMainLike } from "../lib/main/keygen/ipc.ts";
import { KeygenError } from "../lib/shared/keygen-error.ts";
import { KEYGEN_CHANNELS, type KeygenChannelName } from "../lib/shared/keygen-types.ts";
import type { LicensingService } from "../lib/main/keygen/service.ts";

/* ------------------------------- harness ---------------------------------- */

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function makeIpcMain() {
	const handlers = new Map<string, Handler>();
	const ipc: IpcMainLike = {
		handle(channel, listener) {
			handlers.set(channel, listener as Handler);
		},
	};
	return { ipc, handlers };
}

/** Records calls; each method returns whatever the test queues for it. */
function makeServiceStub() {
	const calls: Array<{ method: string; args: unknown }> = [];
	const record = (method: string) => (args?: unknown) => {
		calls.push({ method, args });
		const out = stub.results[method];
		return typeof out === "function" ? (out as () => unknown)() : out;
	};
	const stub: {
		calls: typeof calls;
		results: Record<string, unknown>;
		service: LicensingService;
	} = {
		calls,
		results: {},
		service: {
			getLicense: record("getLicense"),
			getLicenseKey: record("getLicenseKey"),
			validateKey: record("validateKey"),
			validateCheckoutKey: record("validateCheckoutKey"),
			resetLicense: record("resetLicense"),
			resetLicenseKey: record("resetLicenseKey"),
		} as unknown as LicensingService,
	};
	return stub;
}

const trusted = {};
const isTrusted = (event: unknown): boolean => event === trusted;

function okEnvelope(data: unknown) {
	return { ok: true, data };
}

async function call(
	handlers: Map<string, Handler>,
	channel: KeygenChannelName,
	args: unknown[] = [],
	event: unknown = trusted,
) {
	const handler = handlers.get(channel);
	assert.ok(handler, `no handler registered for ${channel}`);
	return (await handler(event, ...args)) as {
		ok: boolean;
		data?: unknown;
		error?: { code: string; detail: string };
	};
}

/* ------------------------------- registration ------------------------------ */

test("registers exactly the six keygen channels", () => {
	const { ipc, handlers } = makeIpcMain();
	registerKeygenIpc(ipc, () => makeServiceStub().service, isTrusted);
	assert.deepEqual([...handlers.keys()].sort(), Object.values(KEYGEN_CHANNELS).sort());
});

test("each channel returns the service result in an ok envelope", async () => {
	const { ipc, handlers } = makeIpcMain();
	const stub = makeServiceStub();
	registerKeygenIpc(ipc, () => stub.service, isTrusted);

	const license = {
		key: "K",
		code: "VALID",
		detail: "is valid",
		expiry: null,
		valid: true,
		policyId: "p",
		entitlements: [],
		metadata: {},
	};
	stub.results.getLicense = license;
	stub.results.getLicenseKey = "K";
	stub.results.validateKey = license;
	stub.results.validateCheckoutKey = license;
	stub.results.resetLicense = undefined;
	stub.results.resetLicenseKey = undefined;

	assert.deepEqual(await call(handlers, KEYGEN_CHANNELS.getLicense), okEnvelope(license));
	assert.deepEqual(await call(handlers, KEYGEN_CHANNELS.getLicenseKey), okEnvelope("K"));
	assert.deepEqual(await call(handlers, KEYGEN_CHANNELS.validateKey, [{ key: "K" }]), okEnvelope(license));
	assert.deepEqual(
		await call(handlers, KEYGEN_CHANNELS.validateCheckoutKey, [{ key: "K" }]),
		okEnvelope(license),
	);
	// void results become null, never undefined (undefined does not survive clone)
	assert.deepEqual(await call(handlers, KEYGEN_CHANNELS.resetLicense), okEnvelope(null));
	assert.deepEqual(await call(handlers, KEYGEN_CHANNELS.resetLicenseKey), okEnvelope(null));
});

/* --------------------------------- trust ----------------------------------- */

test("untrusted senders are rejected before the service sees the call", async () => {
	const { ipc, handlers } = makeIpcMain();
	const stub = makeServiceStub();
	registerKeygenIpc(ipc, () => stub.service, isTrusted);

	const res = await call(handlers, KEYGEN_CHANNELS.validateKey, [{ key: "K" }], { evil: true });
	assert.equal(res.ok, false);
	assert.equal(res.error?.code, "UNTRUSTED_SENDER");
	assert.equal(stub.calls.length, 0);
});

test("makeWindowTrustChecker accepts only registered top frames", () => {
	const mainFrame = { kind: "main" };
	const id = 7;
	const sender = { id, mainFrame };
	const checker = makeWindowTrustChecker(() => [id]);

	// registered window, main frame
	assert.equal(checker({ sender, senderFrame: mainFrame }), true);
	// iframe inside the trusted window
	assert.equal(checker({ sender, senderFrame: { kind: "sub" } }), false);
	// missing senderFrame metadata
	assert.equal(checker({ sender }), false);
	// window that was never registered
	assert.equal(checker({ sender: { id: 99, mainFrame }, senderFrame: mainFrame }), false);
	// webContents id of the wrong type / absent
	assert.equal(checker({ sender: { mainFrame }, senderFrame: mainFrame }), false);
	// garbage events
	assert.equal(checker(undefined), false);
	assert.equal(checker({}), false);
	// window registration is re-read per call (closed windows lose access)
	const ids = [id];
	const liveChecker = makeWindowTrustChecker(() => ids);
	assert.equal(liveChecker({ sender, senderFrame: mainFrame }), true);
	ids.length = 0;
	assert.equal(liveChecker({ sender, senderFrame: mainFrame }), false);
});

/* ------------------------------ config gate -------------------------------- */

test("missing service reports LICENSING_DISABLED, not a crash", async () => {
	const { ipc, handlers } = makeIpcMain();
	registerKeygenIpc(ipc, () => null, isTrusted);
	const res = await call(handlers, KEYGEN_CHANNELS.getLicense);
	assert.equal(res.ok, false);
	assert.equal(res.error?.code, "LICENSING_DISABLED");
});

/* ---------------------------- argument validation -------------------------- */

test("validateKey rejects missing/typed-wrong arguments", async () => {
	const { ipc, handlers } = makeIpcMain();
	const stub = makeServiceStub();
	registerKeygenIpc(ipc, () => stub.service, isTrusted);

	// no arguments at all
	assert.equal((await call(handlers, KEYGEN_CHANNELS.validateKey, [])).ok, false);
	// wrong key type
	let res = await call(handlers, KEYGEN_CHANNELS.validateKey, [{ key: 123 }]);
	assert.equal(res.ok, false);
	assert.equal(stub.calls.length, 0);
	// entitlements must be an array of strings
	res = await call(handlers, KEYGEN_CHANNELS.validateKey, [{ key: "K", entitlements: "prof-plugin" }]);
	assert.equal(res.ok, false);
	res = await call(handlers, KEYGEN_CHANNELS.validateKey, [{ key: "K", entitlements: [1, 2] }]);
	assert.equal(res.ok, false);
	// extra unvalidated properties are dropped before reaching the service
	await call(handlers, KEYGEN_CHANNELS.validateKey, [
		{ key: "K", cacheValidResponse: true, rm: () => {}, secret: "x" },
	]);
	assert.equal(stub.calls.length, 1);
});

test("validateCheckoutKey enforces ttlSeconds bounds", async () => {
	const { ipc, handlers } = makeIpcMain();
	const stub = makeServiceStub();
	registerKeygenIpc(ipc, () => stub.service, isTrusted);

	assert.equal(
		(await call(handlers, KEYGEN_CHANNELS.validateCheckoutKey, [{ key: "K", ttlSeconds: -5 }])).ok,
		false,
	);
	assert.equal(
		(await call(handlers, KEYGEN_CHANNELS.validateCheckoutKey, [{ key: "K", ttlSeconds: 1.5 }])).ok,
		false,
	);
	assert.equal(
		(await call(handlers, KEYGEN_CHANNELS.validateCheckoutKey, [{ key: "K", ttlSeconds: "3600" }])).ok,
		false,
	);
	assert.equal(stub.calls.length, 0);

	assert.equal(
		(
			await call(handlers, KEYGEN_CHANNELS.validateCheckoutKey, [
				{ key: "K", ttlSeconds: 0, ttlForever: true },
			])
		).ok,
		true,
	);
	assert.equal(stub.calls.length, 1);
});

test("no-arg channels ignore anything the renderer sends", async () => {
	const { ipc, handlers } = makeIpcMain();
	const stub = makeServiceStub();
	registerKeygenIpc(ipc, () => stub.service, isTrusted);
	// valibot tuple([]) tolerates extra positional entries; the handler only
	// ever forwards parsed[0], which is undefined, so nothing reaches the service
	const res = await call(handlers, KEYGEN_CHANNELS.resetLicense, [{ dropEverything: true }]);
	assert.equal(res.ok, true);
	assert.deepEqual(stub.calls, [{ method: "resetLicense", args: undefined }]);
});

/* ------------------------------ error mapping ------------------------------ */

test("KeygenError from the service crosses IPC as code+detail", async () => {
	const { ipc, handlers } = makeIpcMain();
	const stub = makeServiceStub();
	stub.results.validateKey = Promise.reject(
		new KeygenError({ code: "LICENSE_VALIDATION_FAILED", detail: "License is invalidated" }),
	);
	registerKeygenIpc(ipc, () => stub.service, isTrusted);

	const res = await call(handlers, KEYGEN_CHANNELS.validateKey, [{ key: "K" }]);
	assert.equal(res.ok, false);
	assert.deepEqual(res.error, { code: "LICENSE_VALIDATION_FAILED", detail: "License is invalidated" });
});

test("unexpected errors surface as a summary, never a raw throw", async () => {
	const { ipc, handlers } = makeIpcMain();
	const stub = makeServiceStub();
	stub.results.getLicense = () => {
		throw new Error("boom");
	};
	registerKeygenIpc(ipc, () => stub.service, isTrusted);

	const res = await call(handlers, KEYGEN_CHANNELS.getLicense);
	assert.equal(res.ok, false);
	assert.equal(typeof res.error?.code, "string");
	assert.equal(typeof res.error?.detail, "string");
});

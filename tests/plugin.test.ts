import assert from "node:assert/strict";
import { test } from "node:test";
import { registerKeygen, type KeygenAppHost } from "../lib/main/keygen/plugin.ts";
import type { IpcMainLike } from "../lib/main/keygen/ipc.ts";
import type { InitArgs } from "../lib/main/keygen/init.ts";
import type { LicensingService } from "../lib/main/keygen/service.ts";
import type { KeygenConfigInput } from "../lib/main/keygen/config.ts";
import { KEYGEN_CHANNELS } from "../lib/shared/keygen-types.ts";

const config: KeygenConfigInput = { accountId: "acc-1", verifyKey: "a".repeat(64) };

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/**
 * `createService` is always injected here: the default factory lives in
 * init.ts, which imports `electron` and cannot load under plain Node.
 */
/** Pass a pending deferred to control when the app becomes ready. */
function makeHost(ready = deferred<unknown>(), autoResolve = true) {
	if (autoResolve) ready.resolve(undefined);
	const calls: string[] = [];
	const app: KeygenAppHost = {
		name: "example-app",
		getPath: (kind) => {
			calls.push(`getPath:${kind}`);
			return "/tmp/userData";
		},
		getVersion: () => "1.2.3",
		getLocale: () => "en-US",
		whenReady: () => ready.promise,
	};
	return { app, calls, ready };
}

function makeIpc() {
	const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
	const ipc: IpcMainLike = {
		handle(channel, listener) {
			handlers.set(channel, listener);
		},
	};
	return { ipc, handlers };
}

const mainFrame = { kind: "main" };

/** An event shaped like Electron's: registered webContents, top frame. */
function trustedEvent(id = 1) {
	return { sender: { id, mainFrame }, senderFrame: mainFrame };
}

async function callChannel(
	handlers: Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>,
	channel: string,
	args: unknown[] = [],
) {
	const handler = handlers.get(channel);
	assert.ok(handler, `handler for ${channel} must be registered`);
	return (await handler(trustedEvent(), ...args)) as {
		ok: boolean;
		data?: unknown;
		error?: { code: string };
	};
}

test("channels exist before the app is ready and refuse until the service is built", async () => {
	const ready = deferred<unknown>();
	const host = makeHost(ready, false);
	const { ipc, handlers } = makeIpc();
	const created: InitArgs[] = [];

	const installing = registerKeygen({
		app: host.app,
		ipc,
		config,
		getTrustedWebContentsIds: () => [1],
		log: { info() {}, warn() {}, error() {} },
		createService: async (args) => {
			created.push(args);
			return null;
		},
	});

	assert.deepEqual([...handlers.keys()].sort(), Object.values(KEYGEN_CHANNELS).sort());
	const early = await callChannel(handlers, KEYGEN_CHANNELS.getLicense);
	assert.equal(early.ok, false);
	assert.equal(early.error?.code, "LICENSING_DISABLED");
	assert.equal(created.length, 0);

	ready.resolve(undefined);
	await installing;
	assert.equal(created.length, 1);
});

test("the service is built from app metadata once ready", async () => {
	const host = makeHost();
	const { ipc, handlers } = makeIpc();
	const fake = { getLicense: () => ({ key: "K" }) } as unknown as LicensingService;
	let seen: InitArgs | null = null;

	const service = await registerKeygen({
		app: host.app,
		ipc,
		config,
		getTrustedWebContentsIds: () => [1],
		log: { info() {}, warn() {}, error() {} },
		createService: async (args) => {
			seen = args;
			return fake;
		},
	});

	assert.equal(service, fake);
	const init = seen as unknown as InitArgs;
	assert.equal(init.userDataDir, "/tmp/userData");
	assert.equal(init.appName, "example-app");
	assert.equal(init.appVersion, "1.2.3");
	assert.equal(init.locale, "en-US");
	assert.equal(init.config, config);

	// and the live service now answers through the same channel
	const res = await callChannel(handlers, KEYGEN_CHANNELS.getLicense);
	assert.deepEqual(res, { ok: true, data: { key: "K" } });
});

test("a factory that throws leaves the app running unlicensed", async () => {
	const host = makeHost();
	const { ipc, handlers } = makeIpc();
	const errors: string[] = [];

	const service = await registerKeygen({
		app: host.app,
		ipc,
		config,
		getTrustedWebContentsIds: () => [1],
		log: { info() {}, warn() {}, error: (msg) => errors.push(msg) },
		createService: () => {
			throw new Error("safeStorage exploded");
		},
	});

	assert.equal(service, null);
	assert.match(errors[0] ?? "", /safeStorage exploded/);
	const res = await callChannel(handlers, KEYGEN_CHANNELS.getLicenseKey);
	assert.equal(res.ok, false);
	assert.equal(res.error?.code, "LICENSING_DISABLED");
});

test("untrusted senders are rejected regardless of service state", async () => {
	const host = makeHost();
	const { ipc, handlers } = makeIpc();
	await registerKeygen({
		app: host.app,
		ipc,
		config,
		getTrustedWebContentsIds: () => [1],
		log: { info() {}, warn() {}, error() {} },
		createService: async () => ({ getLicense: () => null }) as unknown as LicensingService,
	});

	const res = (await handlers.get(KEYGEN_CHANNELS.getLicense)?.({ sender: { id: 99 } })) as {
		ok: boolean;
		error?: { code: string };
	};
	assert.equal(res.ok, false);
	assert.equal(res.error?.code, "UNTRUSTED_SENDER");
});

test("config omitted means the host reads KEYGEN_* from the environment", async () => {
	const host = makeHost();
	const { ipc } = makeIpc();
	let seen: InitArgs | null = null;

	process.env.KEYGEN_VERIFY_KEY = "b".repeat(64);
	process.env.KEYGEN_ACCOUNT_ID = "acc-env";
	try {
		await registerKeygen({
			app: host.app,
			ipc,
			getTrustedWebContentsIds: () => [1],
			log: { info() {}, warn() {}, error() {} },
			createService: async (args) => {
				seen = args;
				return null;
			},
		});
	} finally {
		delete process.env.KEYGEN_VERIFY_KEY;
		delete process.env.KEYGEN_ACCOUNT_ID;
	}

	assert.deepEqual((seen as unknown as InitArgs).config, {
		accountId: "acc-env",
		verifyKey: "b".repeat(64),
		apiUrl: undefined,
		customDomain: undefined,
		versionHeader: undefined,
		cacheLifetime: undefined,
	});
});

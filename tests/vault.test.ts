import assert from "node:assert/strict";
import { test } from "node:test";
import { buildVaultCodec, type SafeStorageLike } from "../lib/main/keygen/vault.ts";

/**
 * A fake that behaves like Electron's real safeStorage in the one way that
 * matters here: its methods are native bindings that refuse to run detached
 * from the object. Destructuring the async trio out of safeStorage passed every
 * mocked test while failing against the real thing, and the failure looked like
 * "no vault", so persistence silently disappeared.
 */
type Vault = SafeStorageLike & { calls: string[] };

function vaultWithBoundChecks(opts: { async?: boolean; basicText?: boolean } = {}) {
	const useAsync = opts.async !== false;
	const vault: Vault = {
		calls: [],
		isEncryptionAvailable() {
			this.calls.push("sync:available");
			return true;
		},
		encryptString(plaintext: string) {
			this.calls.push("sync:encrypt");
			return Buffer.from(`ENC(${plaintext})`);
		},
		decryptString(blob: Buffer) {
			this.calls.push("sync:decrypt");
			return /^ENC\((.*)\)$/s.exec(blob.toString("utf8"))?.[1] ?? "";
		},
		getSelectedStorageBackend() {
			this.calls.push("backend");
			return opts.basicText ? "basic_text" : "gnome-libsecret";
		},
	};

	if (useAsync) {
		Object.assign(vault, {
			async isAsyncEncryptionAvailable(this: Vault) {
				// what Electron throws when the receiver is not the safeStorage object
				if (this !== vault) throw new TypeError("Illegal invocation");
				this.calls.push("async:available");
				return true;
			},
			async encryptStringAsync(this: Vault, plaintext: string) {
				if (this !== vault) throw new TypeError("Illegal invocation");
				this.calls.push("async:encrypt");
				return Buffer.from(`ENC(${plaintext})`);
			},
			async decryptStringAsync(this: Vault, blob: Buffer) {
				if (this !== vault) throw new TypeError("Illegal invocation");
				this.calls.push("async:decrypt");
				return { result: /^ENC\((.*)\)$/s.exec(blob.toString("utf8"))?.[1] ?? "", shouldReEncrypt: false };
			},
		});
	}
	return vault;
}

function withPlatform(platform: NodeJS.Platform, run: () => Promise<void>) {
	const original = process.platform;
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	return run().finally(() => {
		Object.defineProperty(process, "platform", { value: original, configurable: true });
	});
}

test("the codec never calls safeStorage methods detached from their object", async () => {
	const vault = vaultWithBoundChecks();
	const codec = buildVaultCodec(vault);

	assert.equal(await codec.isAvailable(), true);
	const blob = await codec.encrypt("KEY-1");
	assert.equal(blob.toString("utf8"), "ENC(KEY-1)");
	assert.deepEqual(await codec.decrypt(blob), { plaintext: "KEY-1", reencrypt: false });

	// an unbound call is exactly what used to happen; assert it would have failed
	const loose = vault.encryptStringAsync;
	await assert.rejects(async () => (loose as (p: string) => Promise<Buffer>)("KEY-1"), /Illegal invocation/);
});

test("the async API is what gets used when the host has it", async () => {
	const vault = vaultWithBoundChecks();
	await buildVaultCodec(vault).isAvailable();
	assert.ok(vault.calls.includes("async:available"), `calls: ${vault.calls.join(",")}`);
	assert.ok(!vault.calls.includes("sync:available"));
});

test("an older safeStorage without the async API still works through sync", async () => {
	const vault = vaultWithBoundChecks({ async: false });
	const codec = buildVaultCodec(vault);
	assert.equal(await codec.isAvailable(), true);
	const blob = await codec.encrypt("KEY-2");
	assert.deepEqual(await codec.decrypt(blob), { plaintext: "KEY-2", reencrypt: false });
	assert.ok(vault.calls.includes("sync:encrypt"), `calls: ${vault.calls.join(",")}`);
	assert.ok(vault.calls.includes("sync:decrypt"), `calls: ${vault.calls.join(",")}`);
});

test("a shouldReEncrypt answer is reported so the file can be rewritten", async () => {
	const vault = vaultWithBoundChecks();
	vault.decryptStringAsync = async function (this: typeof vault, _blob: Buffer) {
		this.calls.push("async:decrypt");
		return { result: "KEY-3", shouldReEncrypt: true };
	};
	assert.deepEqual(await buildVaultCodec(vault).decrypt(Buffer.from("ENC(KEY-3)")), {
		plaintext: "KEY-3",
		reencrypt: true,
	});
});

test("Linux basic_text counts as no vault, so nothing is ever written", async () => {
	const vault = vaultWithBoundChecks({ basicText: true });
	const codec = buildVaultCodec(vault);
	await withPlatform("linux", async () => {
		assert.equal(await codec.isAvailable(), false);
	});
	// the same vault on Windows/macOS is a real secret store
	await withPlatform("win32", async () => {
		assert.equal(await codec.isAvailable(), true);
	});
});

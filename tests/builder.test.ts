import assert from "node:assert/strict";
import { test } from "node:test";
import { KeygenBuilder } from "../lib/main/keygen/builder.ts";
import { DEFAULT_API_URL, resolveConfig } from "../lib/main/keygen/config.ts";

const verifyKey = "a".repeat(64);

test("KeygenBuilder.new mirrors Builder::new defaults", () => {
	assert.deepEqual(KeygenBuilder.new("acc-1", verifyKey).build(), {
		verifyKey,
		cacheLifetime: 240,
		apiUrl: DEFAULT_API_URL,
		accountId: "acc-1",
	});
});

test("withCustomDomain mirrors Builder::with_custom_domain", () => {
	const builder = KeygenBuilder.withCustomDomain("https://licensing.example.com", verifyKey);
	assert.deepEqual(builder.build(), {
		verifyKey,
		cacheLifetime: 240,
		customDomain: "https://licensing.example.com",
	});
});

test("apiUrl is ignored once a custom domain is set (Rust Builder::api_url)", () => {
	const builder = KeygenBuilder.withCustomDomain("https://licensing.example.com", verifyKey).apiUrl(
		"https://ignored.example.com",
	);
	assert.equal("apiUrl" in builder.build(), false);
});

test("cacheLifetime clamps to [60, 1440] like Builder::cache_lifetime", () => {
	assert.equal(KeygenBuilder.new("acc-1", verifyKey).cacheLifetime(5).build().cacheLifetime, 60);
	assert.equal(KeygenBuilder.new("acc-1", verifyKey).cacheLifetime(9999).build().cacheLifetime, 1440);
	assert.equal(KeygenBuilder.new("acc-1", verifyKey).cacheLifetime(120).build().cacheLifetime, 120);
});

test("versionHeader maps to the Keygen-Version header", () => {
	const config = resolveConfig(KeygenBuilder.new("acc-1", verifyKey).versionHeader("2026-01-02").build());
	assert.equal(config.versionHeader, "2026-01-02");
});

test("the builder output resolves to the same config the Rust plugin produced", () => {
	const config = resolveConfig(
		KeygenBuilder.new("acc-1", verifyKey).apiUrl("https://api.keygen.sh/v1").cacheLifetime(300).build(),
	);
	assert.deepEqual(config, {
		customDomain: null,
		apiUrl: "https://api.keygen.sh/v1",
		accountId: "acc-1",
		verifyKey,
		versionHeader: null,
		cacheLifetime: 300,
		maxClockDrift: 5,
	});
});

test("an invalid verify key is rejected the same way as the original", () => {
	assert.throws(
		() => resolveConfig(KeygenBuilder.new("acc-1", "not-hex").build()),
		(err: unknown) => (err as { code?: string }).code === "CONFIG",
	);
	// account id is only required when no custom domain is set
	assert.throws(
		() => resolveConfig(KeygenBuilder.new("", verifyKey).build()),
		(err: unknown) => (err as { code?: string }).code === "CONFIG",
	);
	assert.doesNotThrow(() =>
		resolveConfig(KeygenBuilder.withCustomDomain("https://licensing.example.com", verifyKey).build()),
	);
});

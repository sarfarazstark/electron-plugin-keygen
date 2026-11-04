import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildDefaultHeaders,
	clampCacheLifetime,
	DEFAULT_API_URL,
	resolveConfig,
} from "../lib/main/keygen/config.ts";

const KEY = "a".repeat(64);

test("defaults match the Rust Builder", () => {
	const c = resolveConfig({ accountId: "acc-1", verifyKey: KEY });
	assert.equal(c.apiUrl, DEFAULT_API_URL);
	assert.equal(c.accountId, "acc-1");
	assert.equal(c.cacheLifetime, 240);
	assert.equal(c.maxClockDrift, 5);
	assert.equal(c.versionHeader, null);
	assert.equal(c.customDomain, null);
});

test("cache lifetime is clamped to [60, 1440]", () => {
	assert.equal(clampCacheLifetime(10), 60);
	assert.equal(clampCacheLifetime(1), 60);
	assert.equal(clampCacheLifetime(99999), 1440);
	assert.equal(clampCacheLifetime(120), 120);
});

test("invalid verify key rejected", () => {
	assert.throws(() => resolveConfig({ accountId: "a", verifyKey: "nope" }), /verify key/i);
	assert.throws(() => resolveConfig({ accountId: "a", verifyKey: "ab12" }), /verify key/i);
});

test("missing account id without custom domain rejected", () => {
	assert.throws(() => resolveConfig({ verifyKey: KEY }), /account id/i);
});

test("custom domain ignores apiUrl and accountId", () => {
	const c = resolveConfig({
		customDomain: "https://licensing.example.com",
		verifyKey: KEY,
		accountId: "ignored",
		apiUrl: "https://ignored.example",
	});
	assert.equal(c.apiUrl, null);
	assert.equal(c.accountId, null);
	assert.equal(c.customDomain, "https://licensing.example.com");
});

test("default headers carry User-Agent and optional Keygen-Version", () => {
	const c = resolveConfig({ accountId: "a", verifyKey: KEY, versionHeader: "2022-05-30" });
	const h = buildDefaultHeaders(c, "app/1.0.0 Windows/11");
	assert.equal(h["User-Agent"], "app/1.0.0 Windows/11");
	assert.equal(h["Keygen-Version"], "2022-05-30");
});

test("header values filtered to visible ASCII like get_header_value", () => {
	const c = resolveConfig({ accountId: "a", verifyKey: KEY, versionHeader: "2022\n05-30" });
	const h = buildDefaultHeaders(c, "app/1\t0");
	assert.equal(h["Keygen-Version"], "202205-30");
	assert.equal(h["User-Agent"], "app/10");
});

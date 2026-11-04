import assert from "node:assert/strict";
import { test } from "node:test";
import { KeygenClient } from "../lib/main/keygen/client.ts";
import { resolveConfig } from "../lib/main/keygen/config.ts";
import {
	fixedClock,
	generateTestKeys,
	mockFetch,
	signedResponse,
	unsignedResponse,
} from "./fixtures/keygen.ts";

const keys = generateTestKeys();
const account = resolveConfig({ accountId: "acc-1", verifyKey: keys.publicHex });

function makeClient(clock = fixedClock()) {
	const mf = mockFetch();
	const client = new KeygenClient(account, mf.fetch, { "User-Agent": "ua/1.0" });
	return { client, mf, clock };
}

/* -------------------------------- buildUrl -------------------------------- */

test("buildUrl uses v1/accounts/{id} prefix on api.keygen.sh", () => {
	const { client } = makeClient();
	const url = client.buildUrl("licenses/actions/validate-key");
	assert.equal(url.toString(), "https://api.keygen.sh/v1/accounts/acc-1/licenses/actions/validate-key");
});

test("buildUrl respects a custom apiUrl with a path", () => {
	const cfg = resolveConfig({
		accountId: "acc-1",
		verifyKey: keys.publicHex,
		apiUrl: "https://gw.example.com/keys",
	});
	const client = new KeygenClient(cfg, mockFetch().fetch, {});
	const url = client.buildUrl("machines");
	assert.equal(url.toString(), "https://gw.example.com/v1/accounts/acc-1/machines");
});

test("buildUrl custom domain drops accounts prefix", () => {
	const cfg = resolveConfig({ customDomain: "https://licensing.example.com", verifyKey: keys.publicHex });
	const client = new KeygenClient(cfg, mockFetch().fetch, {});
	const url = client.buildUrl("licenses/actions/validate-key");
	assert.equal(url.toString(), "https://licensing.example.com/v1/licenses/actions/validate-key");
});

test("buildUrl appends query params (comma percent-encoded like Rust)", () => {
	const { client } = makeClient();
	const url = client.buildUrl("machines/fp/actions/check-out", [
		["encrypt", "1"],
		["include", "license.entitlements,license"],
		["ttl", "3600"],
	]);
	assert.equal(url.search, "?encrypt=1&include=license.entitlements%2Clicense&ttl=3600");
});

test("buildUrl without account id errors", () => {
	const cfg = { ...account, accountId: null };
	const client = new KeygenClient(cfg, mockFetch().fetch, {});
	assert.throws(() => client.buildUrl("machines"), /missing account_id/);
});

/* ---------------------------- verifyResponse ------------------------------ */

const targetUrl = () => new URL("https://api.keygen.sh/v1/accounts/acc-1/licenses/actions/validate-key");
const body = '{"ok":1}';

test("verifyResponse passes a correctly signed fresh response", () => {
	const { client, clock } = makeClient();
	const res = signedResponse({ keys, url: targetUrl(), body, now: clock.now });
	const cache = client.verifyResponse("post", targetUrl(), res.headers, body, clock.now());
	assert.equal(cache.body, body);
	assert.equal(cache.target, "post /v1/accounts/acc-1/licenses/actions/validate-key");
	assert.equal(cache.host, "api.keygen.sh");
});

test("verifyResponse rejects a missing Keygen-Signature header", () => {
	const { client } = makeClient();
	const res = unsignedResponse(200, body);
	assert.throws(
		() => client.verifyResponse("post", targetUrl(), res.headers, body),
		/Missing header: Keygen-Signature/,
	);
});

test("verifyResponse rejects a body that does not match the Digest", () => {
	const { client, clock } = makeClient();
	const res = signedResponse({ keys, url: targetUrl(), body, now: clock.now });
	assert.throws(
		() => client.verifyResponse("post", targetUrl(), res.headers, `${body}-tampered`, clock.now()),
		/Digest didn't match/,
	);
});

test("verifyResponse rejects a stale Date header (> max clock drift)", () => {
	const { client, clock } = makeClient();
	const res = signedResponse({ keys, url: targetUrl(), body, now: clock.now, dateOffsetMs: -10 * 60_000 });
	assert.throws(
		() => client.verifyResponse("post", targetUrl(), res.headers, body, clock.now()),
		/Request date too old/,
	);
});

test("verifyResponse allows a small clock drift", () => {
	const { client, clock } = makeClient();
	const res = signedResponse({ keys, url: targetUrl(), body, now: clock.now, dateOffsetMs: -3 * 60_000 });
	assert.doesNotThrow(() => client.verifyResponse("post", targetUrl(), res.headers, body, clock.now()));
});

test("verifyResponse rejects a Date header far in the future", () => {
	const { client, clock } = makeClient();
	// Signed minutes used to be compared without abs(), so a negative age always
	// passed: one captured response plus a rolled-back clock stayed "fresh" forever.
	const res = signedResponse({ keys, url: targetUrl(), body, now: clock.now, dateOffsetMs: 60 * 60_000 });
	assert.throws(
		() => client.verifyResponse("post", targetUrl(), res.headers, body, clock.now()),
		/Request date too old/,
	);
});

test("verifyResponse tolerates a slightly future Date header", () => {
	const { client, clock } = makeClient();
	// The bound is symmetric, not tighter than the past tolerance it replaces.
	const res = signedResponse({ keys, url: targetUrl(), body, now: clock.now, dateOffsetMs: 3 * 60_000 });
	assert.doesNotThrow(() => client.verifyResponse("post", targetUrl(), res.headers, body, clock.now()));
});

test("verifyResponse rejects a signature made by another key", () => {
	const { client, clock } = makeClient();
	const rogue = generateTestKeys();
	const res = signedResponse({ keys: rogue, url: targetUrl(), body, now: clock.now });
	assert.throws(
		() => client.verifyResponse("post", targetUrl(), res.headers, body, clock.now()),
		/Invalid Signature/,
	);
});

test("verifyResponse rejects an unsupported algorithm", () => {
	const { client, clock } = makeClient();
	const res = signedResponse({ keys, url: targetUrl(), body, now: clock.now });
	const bad = {
		...res,
		headers: (() => {
			const map: Record<string, string> = {};
			for (const k of ["Keygen-Signature", "Digest", "Date"]) {
				const v = res.headers.get(k);
				if (v) map[k.toLowerCase()] = v;
			}
			map["keygen-signature"] = (map["keygen-signature"] ?? "").replace("ed25519", "rsa");
			return { get: (n: string) => map[n.toLowerCase()] ?? null };
		})(),
	};
	assert.throws(
		() => client.verifyResponse("post", targetUrl(), bad.headers, body, clock.now()),
		/Unsupported algorithm/,
	);
});

/* -------------------------- verifyResponseCache --------------------------- */

test("verifyResponseCache passes for a fresh cache and returns the parsed response", () => {
	const { client, clock } = makeClient();
	const licBody = JSON.stringify({
		meta: { ts: "x", valid: true, detail: "is valid", code: "VALID" },
		data: {
			id: "l",
			attributes: { key: "k", expiry: null, metadata: {} },
			relationships: { policy: { data: { id: "p" } } },
		},
	});
	const res = signedResponse({ keys, url: targetUrl(), body: licBody, now: clock.now });
	const cache = client.verifyResponse("post", targetUrl(), res.headers, licBody, clock.now());
	const parsed = client.verifyResponseCache(cache, clock.now());
	assert.equal(parsed.meta.code, "VALID");
});

test("verifyResponseCache rejects a cache older than cache_lifetime", () => {
	const cfg = { ...account, cacheLifetime: 240 };
	const client = new KeygenClient(cfg, mockFetch().fetch, {});
	const clock = fixedClock();
	const licBody = '{"meta":{"ts":"x","valid":true,"detail":"d","code":"VALID"},"data":null}';
	const res = signedResponse({ keys, url: targetUrl(), body: licBody, now: clock.now });
	const cache = client.verifyResponse("post", targetUrl(), res.headers, licBody, clock.now());
	// 241 minutes later the same cache is stale
	assert.throws(
		() => client.verifyResponseCache(cache, clock.now() + 241 * 60_000),
		/Validation cache has expired/,
	);
	// at 239 minutes it is still usable
	assert.doesNotThrow(() => client.verifyResponseCache(cache, clock.now() + 239 * 60_000));
});

test("verifyResponseCache detects a modified cached body", () => {
	const { client, clock } = makeClient();
	const licBody = '{"meta":{"ts":"x","valid":true,"detail":"d","code":"VALID"},"data":null}';
	const res = signedResponse({ keys, url: targetUrl(), body: licBody, now: clock.now });
	const cache = client.verifyResponse("post", targetUrl(), res.headers, licBody, clock.now());
	cache.body = '{"meta":{"ts":"x","valid":true,"detail":"d","code":"VALID"},"data":null,"x":1}';
	assert.throws(() => client.verifyResponseCache(cache, clock.now()), /Invalid Signature/);
});

/* ---------------------------------- post ---------------------------------- */

test("post merges default headers and maps network errors to REQUEST_ERROR", async () => {
	const { client, mf } = makeClient();
	mf.enqueue(new Error("ECONNREFUSED"));
	await assert.rejects(
		client.post(
			"https://api.keygen.sh/v1/accounts/acc-1/x",
			{ a: 1 },
			{ Accept: "application/vnd.api+json" },
		),
		(err: unknown) => {
			assert.ok(err && typeof err === "object");
			assert.equal((err as { code?: string }).code, "REQUEST_ERROR");
			return true;
		},
	);
});

test("post sends JSON body with merged headers", async () => {
	const { client, mf } = makeClient();
	mf.enqueue(unsignedResponse(200, "{}"));
	await client.post(
		"https://api.keygen.sh/x",
		{ hello: "world" },
		{ "Content-Type": "application/vnd.api+json" },
	);
	const call = mf.calls[0];
	assert.ok(call);
	assert.equal(call.init.headers["User-Agent"], "ua/1.0");
	assert.equal(call.init.headers["Content-Type"], "application/vnd.api+json");
	assert.equal(call.init.body, '{"hello":"world"}');
});

test("resTextJson surfaces a parse error on non-JSON bodies", async () => {
	const { client } = makeClient();
	const res = unsignedResponse(200, "<html>not json</html>");
	await assert.rejects(client.resTextJson(res), /Failed parsing response json/);
});

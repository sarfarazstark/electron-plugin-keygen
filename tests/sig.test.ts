import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildSignatureData,
	parseSignatureHeader,
	signatureDataFromCache,
	signatureDataString,
} from "../lib/main/keygen/sig.ts";
import { sha256DigestHeader } from "../lib/main/keygen/crypto.ts";

test("parseSignatureHeader extracts the ed25519 signature", () => {
	const raw = 'algorithm="ed25519", signature="abc123=="';
	assert.equal(parseSignatureHeader(raw), "abc123==");
});

test("parseSignatureHeader tolerates the signature param first", () => {
	const raw = 'signature="s1gn==", algorithm="ed25519"';
	assert.equal(parseSignatureHeader(raw), "s1gn==");
});

test("parseSignatureHeader rejects missing/unsupported algorithm", () => {
	assert.throws(() => parseSignatureHeader('signature="x=="'), /Missing header: Keygen-Signature\.algorithm/);
	assert.throws(() => parseSignatureHeader('algorithm="rsa", signature="x=="'), /Unsupported algorithm/);
	assert.throws(
		() => parseSignatureHeader('algorithm="ed25519"'),
		/Missing header: Keygen-Signature\.signature/,
	);
});

test("buildSignatureData matches the Rust format exactly", () => {
	const url = new URL("https://api.keygen.sh/v1/accounts/acc-1/licenses/actions/validate-key?x=1");
	const d = buildSignatureData("post", url, "Tue, 04 Nov 2026 12:00:00 GMT", "BODY");
	assert.equal(d.target, "post /v1/accounts/acc-1/licenses/actions/validate-key?x=1");
	assert.equal(d.host, "api.keygen.sh");
	assert.equal(d.date, "Tue, 04 Nov 2026 12:00:00 GMT");
	assert.equal(d.digest, sha256DigestHeader("BODY"));
});

test("lowercase target method and no query", () => {
	const url = new URL("https://api.keygen.sh/v1/accounts/a/machines");
	const d = buildSignatureData("POST", url, "d", "b");
	assert.equal(d.target, "post /v1/accounts/a/machines");
	assert.ok(!d.target.includes("?"));
});

test("signatureDataString is the exact 4-line payload", () => {
	const s = signatureDataString({
		target: "post /v1/x",
		host: "api.keygen.sh",
		date: "Tue, 04 Nov 2026 12:00:00 GMT",
		digest: "sha-256=AAA=",
	});
	assert.equal(
		s,
		"(request-target): post /v1/x\nhost: api.keygen.sh\ndate: Tue, 04 Nov 2026 12:00:00 GMT\ndigest: sha-256=AAA=",
	);
});

test("signatureDataFromCache re-hashes the cached body", () => {
	const body = '{"a":1}';
	const s = signatureDataFromCache({
		sig: "x",
		target: "post /v1/x",
		host: "h",
		date: "d",
		body,
	});
	assert.ok(s.includes(`digest: ${sha256DigestHeader(body)}`));
});

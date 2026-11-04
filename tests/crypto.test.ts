import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import {
	aes256GcmDecrypt,
	decodeBase64,
	sha256DigestHeader,
	sha256Hex,
	verifyEd25519,
} from "../lib/main/keygen/crypto.ts";
import { generateTestKeys } from "./fixtures/keygen.ts";

const keys = generateTestKeys();
const msg = "(request-target): post /v1/accounts/a/licenses/actions/validate-key\nhost: api.keygen.sh";

test("verifyEd25519 accepts a valid signature", () => {
	const sig = keys.sign(msg);
	assert.equal(verifyEd25519(keys.publicHex, msg, sig), true);
});

test("verifyEd25519 rejects a modified message", () => {
	const sig = keys.sign(msg);
	assert.equal(verifyEd25519(keys.publicHex, `${msg}x`, sig), false);
});

test("verifyEd25519 rejects a foreign key", () => {
	const other = generateTestKeys();
	const sig = other.sign(msg);
	assert.equal(verifyEd25519(keys.publicHex, msg, sig), false);
});

test("verifyEd25519 errors on malformed verify key (hex)", () => {
	assert.throws(() => verifyEd25519("not-hex!!", msg, keys.sign(msg)), /Failed parsing verify key/);
	assert.throws(
		() => verifyEd25519(keys.publicHex.slice(0, 62), msg, keys.sign(msg)),
		/Failed parsing verify key/,
	);
});

test("verifyEd25519 errors on non-base64 / wrong-length signature", () => {
	assert.throws(() => verifyEd25519(keys.publicHex, msg, "@@@@"), /Failed decoding signature/);
	assert.throws(
		() => verifyEd25519(keys.publicHex, msg, Buffer.from("short").toString("base64")),
		/Invalid signature format/,
	);
});

test("sha256 digest header format matches Keygen's Digest", () => {
	const body = "hello";
	const expected = `sha-256=${crypto.createHash("sha256").update(body).digest("base64")}`;
	assert.equal(sha256DigestHeader(body), expected);
});

test("sha256Hex matches known vector", () => {
	assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("aes256GcmDecrypt roundtrips and rejects tampering", () => {
	const key = crypto.randomBytes(32);
	const nonce = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
	const ct = Buffer.concat([cipher.update("license data", "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();

	const out = aes256GcmDecrypt(key, nonce, ct, tag);
	assert.equal(out.toString("utf8"), "license data");

	const tampered = Buffer.from(ct);
	tampered[0] = (tampered[0] ?? 0) ^ 0xff;
	assert.throws(() => aes256GcmDecrypt(key, nonce, tampered, tag));
	assert.throws(() => aes256GcmDecrypt(key, nonce, ct, crypto.randomBytes(16)));
});

test("decodeBase64 is strict (STANDARD engine parity)", () => {
	assert.equal(decodeBase64(Buffer.from("abc").toString("base64")).toString(), "abc");
	assert.throws(() => decodeBase64("YWJj="), /Invalid base64/); // bad length: not mult of 4
	assert.throws(() => decodeBase64("!!!!"), /Invalid base64/);
});

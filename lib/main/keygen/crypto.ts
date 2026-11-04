import crypto from "node:crypto";

/**
 * Primitive crypto ported from the Rust plugin:
 * - Ed25519 verification (client/mod.rs verify_signature, ed25519-dalek)
 * - SHA-256 digest header (client/sig.rs, sha2)
 * - AES-256-GCM decryption (machine/mod.rs decrypt_machine_file, aes-gcm)
 */

/** DER SubjectPublicKeyInfo prefix for an Ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PUBLIC_KEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;

export function sha256(data: string): Buffer {
	return sha256Bytes(Buffer.from(data, "utf8"));
}

export function sha256Bytes(data: Uint8Array): Buffer {
	return crypto.createHash("sha256").update(data).digest();
}

export function sha256Hex(data: string): string {
	return sha256(data).toString("hex");
}

/** `sha-256={base64(sha256(body))}` as sent in Keygen's Digest header. */
export function sha256DigestHeader(body: string): string {
	return `sha-256=${sha256(body).toString("base64")}`;
}

/**
 * Verify an Ed25519 signature over `message`.
 * Throws KeygenError-shaped parse errors for malformed inputs so callers can
 * map them like the original (bad hex / bad base64 / wrong length are all
 * distinct failures from a signature simply not matching).
 */
export function verifyEd25519(publicKeyHex: string, message: string, signatureB64: string): boolean {
	let keyBytes: Buffer;
	try {
		keyBytes = decodeHex(publicKeyHex);
	} catch {
		throw new Error("Failed parsing verify key to bytes");
	}
	if (keyBytes.length !== PUBLIC_KEY_LENGTH) {
		throw new Error("Failed parsing verify key to bytes");
	}

	let publicKey: crypto.KeyObject;
	try {
		publicKey = crypto.createPublicKey({
			key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
			format: "der",
			type: "spki",
		});
	} catch {
		throw new Error("Failed parsing verifying key");
	}

	let sig: Buffer;
	try {
		sig = decodeBase64(signatureB64);
	} catch {
		throw new Error("Failed decoding signature");
	}
	if (sig.length !== SIGNATURE_LENGTH) {
		throw new Error("Invalid signature format");
	}

	return crypto.verify(null, Buffer.from(message, "utf8"), publicKey, sig);
}

/** AES-256-GCM decrypt where the ciphertext carries a separate 16-byte tag. */
export function aes256GcmDecrypt(key: Buffer, nonce: Buffer, ciphertext: Buffer, tag: Buffer): Buffer {
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Strict base64 (STANDARD engine in Rust: requires padding, rejects stray chars). */
export function decodeBase64(input: string): Buffer {
	const withoutWs = input.trim();
	if (withoutWs.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(withoutWs)) {
		throw new Error("Invalid base64");
	}
	return Buffer.from(withoutWs, "base64");
}

function decodeHex(input: string): Buffer {
	if (!/^[0-9a-fA-F]+$/.test(input) || input.length % 2 !== 0) {
		throw new Error("Invalid hex");
	}
	return Buffer.from(input, "hex");
}

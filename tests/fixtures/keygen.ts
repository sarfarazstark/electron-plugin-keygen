import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	buildSignatureData,
	signatureDataString,
	type KeygenResponseCache,
} from "../../lib/main/keygen/sig.ts";
import type { FetchInitLike, FetchResponseLike, HeadersLike } from "../../lib/main/keygen/client.ts";
import type { SecretCodec } from "../../lib/main/keygen/storage.ts";

/**
 * Test fixtures. All cryptographic material here is generated per process —
 * no real Keygen accounts, keys, or network are involved. The fixtures sign
 * with the private counterpart of the config's public verify key, which is
 * exactly how a real Keygen server signs (Ed25519 over the 4-line payload).
 */

export type TestKeys = {
	publicHex: string;
	privateKey: crypto.KeyObject;
	sign(data: string): string;
};

export function generateTestKeys(): TestKeys {
	const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
	const der = publicKey.export({ format: "der", type: "spki" });
	const publicHex = der.subarray(der.length - 32).toString("hex");
	return {
		publicHex,
		privateKey,
		sign: (data: string) => crypto.sign(null, Buffer.from(data, "utf8"), privateKey).toString("base64"),
	};
}

/* --------------------------------- clock --------------------------------- */

export function fixedClock(startMs = Date.UTC(2026, 10, 4, 12, 0, 0)) {
	let now = startMs;
	return {
		now: () => now,
		set: (ms: number) => {
			now = ms;
		},
		advance: (ms: number) => {
			now += ms;
		},
		/** RFC-2822 string for the current clock, as Keygen's Date header. */
		rfc2822: (offsetMs = 0) => new Date(now + offsetMs).toUTCString(),
	};
}

/* ---------------------------- signed responses ---------------------------- */

export function headersLike(map: Record<string, string>): HeadersLike {
	const lower: Record<string, string> = {};
	for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
	return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

export type SignedResponseInit = {
	keys: TestKeys;
	method?: string;
	url: URL;
	body: string;
	/** Offset (ms) applied to the Date header, e.g. for staleness tests. */
	dateOffsetMs?: number;
	status?: number;
	/** Override any response header (e.g. drop Digest, break the signature). */
	overrideHeaders?: Record<string, string | null>;
	now?: () => number;
};

/** Produce a fully signed Keygen response (like the real server would). */
export function signedResponse(
	init: SignedResponseInit,
): FetchResponseLike & { cacheHeaders: Record<string, string> } {
	const method = init.method ?? "post";
	const dateStr = new Date((init.now ? init.now() : Date.now()) + (init.dateOffsetMs ?? 0)).toUTCString();
	const sigData = buildSignatureData(method, init.url, dateStr, init.body);
	const signature = init.keys.sign(signatureDataString(sigData));

	const headers: Record<string, string> = {
		"Keygen-Signature": `algorithm="ed25519", signature="${signature}"`,
		Digest: sigData.digest,
		Date: dateStr,
	};
	if (init.overrideHeaders) {
		for (const [k, v] of Object.entries(init.overrideHeaders)) {
			if (v === null) delete headers[k];
			else headers[k] = v;
		}
	}

	return {
		status: init.status ?? 200,
		headers: headersLike(headers),
		text: async () => init.body,
		cacheHeaders: headers,
	};
}

/** Response that was never signed (or signed by the wrong key). */
export function unsignedResponse(
	status: number,
	body: string,
	headers: Record<string, string> = {},
): FetchResponseLike {
	return {
		status,
		headers: headersLike(headers),
		text: async () => body,
	};
}

/** A validation-cache record as the plugin would persist it. */
export function buildCacheRecord(args: {
	keys: TestKeys;
	url: URL;
	body: string;
	dateMs: number;
}): KeygenResponseCache {
	const dateStr = new Date(args.dateMs).toUTCString();
	const d = buildSignatureData("post", args.url, dateStr, args.body);
	return {
		sig: args.keys.sign(signatureDataString(d)),
		target: d.target,
		host: d.host,
		date: dateStr,
		body: args.body,
	};
}

/* ------------------------------ mock fetch ------------------------------ */

export type MockCall = { url: string; init: FetchInitLike };

export function mockFetch() {
	const calls: MockCall[] = [];
	const queue: Array<FetchResponseLike | Error> = [];
	return {
		calls,
		enqueue: (r: FetchResponseLike | Error) => queue.push(r),
		fetch: async (url: string, init: FetchInitLike): Promise<FetchResponseLike> => {
			calls.push({ url, init });
			const next = queue.shift();
			if (next === undefined) throw new Error(`mockFetch: no queued response for ${url}`);
			if (next instanceof Error) throw next;
			return next;
		},
	};
}

/* ------------------------------ license JSON ------------------------------ */

export type ValidateBodyInit = {
	key?: string;
	valid?: boolean;
	code?: string;
	detail?: string;
	expiry?: string | null;
	licenseId?: string;
	policyId?: string;
	entitlements?: string[];
	ts?: string;
};

export function validateResponseBody(init: ValidateBodyInit): string {
	const meta: Record<string, unknown> = {
		ts: init.ts ?? "2026-11-04T12:00:00.000000000Z",
		valid: init.valid ?? true,
		detail: init.detail ?? "is valid",
		code: init.code ?? "VALID",
	};
	const body: Record<string, unknown> = { meta };
	if (init.entitlements) meta.scope = { entitlements: init.entitlements };
	if (init.licenseId !== null) {
		body.data = {
			id: init.licenseId ?? "lic-1",
			type: "licenses",
			attributes: {
				name: "test",
				key: init.key ?? "TEST-LICENSE-KEY",
				expiry: init.expiry ?? null,
				metadata: { tier: "pro" },
			},
			relationships: { policy: { data: { type: "policies", id: init.policyId ?? "pol-1" } } },
		};
	}
	return JSON.stringify(body);
}

/** NOT_FOUND: no data member. */
export function notFoundBody(detail = "License not found."): string {
	return JSON.stringify({
		meta: { ts: "2026-11-04T12:00:00Z", valid: false, detail, code: "NOT_FOUND" },
	});
}

/* ------------------------------ machine files ------------------------------ */

export type MachineCertInit = {
	keys: TestKeys;
	licenseKey: string;
	fingerprint: string;
	/** meta.expiry of the machine FILE (offline TTL), null = none */
	fileExpiry?: string | null;
	issued: string;
	ttl?: number | null;
	/** the LICENSE expiry inside included[licenses] */
	licenseExpiry: string;
	licenseId?: string;
	policyId?: string;
	entitlementCodes?: string[];
	alg?: string;
};

/**
 * Build a spec-correct encrypted machine file certificate:
 * AES key = sha256(licenseKey || fingerprint), enc = "ct.nonce.tag"
 * (standard base64), sig = Ed25519 over "machine/{enc}".
 */
export function buildMachineCert(init: MachineCertInit): string {
	const plaintext = JSON.stringify({
		meta: {
			expiry: init.fileExpiry ?? null,
			issued: init.issued,
			ttl: init.ttl ?? null,
		},
		included: [
			{
				type: "licenses",
				id: init.licenseId ?? "lic-1",
				attributes: {
					name: "test",
					key: init.licenseKey,
					expiry: init.licenseExpiry,
					metadata: {},
				},
				relationships: { policy: { data: { type: "policies", id: init.policyId ?? "pol-1" } } },
			},
			...(init.entitlementCodes ?? []).map((code, i) => ({
				type: "entitlements",
				id: `ent-${i}`,
				attributes: { code },
			})),
		],
	});

	const key = crypto
		.createHash("sha256")
		.update(Buffer.concat([Buffer.from(init.licenseKey, "utf8"), Buffer.from(init.fingerprint, "utf8")]))
		.digest();
	const nonce = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();

	const enc = [ciphertext, nonce, tag].map((b) => b.toString("base64")).join(".");
	const sig = init.keys.sign(`machine/${enc}`);
	const payload = Buffer.from(
		JSON.stringify({ enc, sig, alg: init.alg ?? "aes-256-gcm+ed25519" }),
		"utf8",
	).toString("base64");

	return `-----BEGIN MACHINE FILE-----\n${payload}\n-----END MACHINE FILE-----`;
}

/* -------------------------------- storage -------------------------------- */

export function fakeCodec(available = true): SecretCodec & { setAvailable(v: boolean): void } {
	const codec = {
		available,
		async isAvailable() {
			return codec.available;
		},
		setAvailable(v: boolean) {
			codec.available = v;
		},
		async encrypt(s: string) {
			return Buffer.from(`FX::${s}`, "utf8");
		},
		async decrypt(b: Buffer) {
			const t = b.toString("utf8");
			if (!t.startsWith("FX::")) throw new Error("not decryptable");
			return { plaintext: t.slice(4), reencrypt: false };
		},
	};
	return codec;
}

export function tmpUserDataDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "keygen-port-test-"));
}

export function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

export const silentLog = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

/** Machine identity fixture used across service tests (no reg.exe in tests). */
export const testMachine = {
	fingerprint: "test-fingerprint-abc",
	name: "TESTBOX",
	platform: "Windows - Windows 11 Pro - x86_64",
	userAgent: "motus/1.0.0 Windows/11 Pro Electron/45.0.0 en-US",
};

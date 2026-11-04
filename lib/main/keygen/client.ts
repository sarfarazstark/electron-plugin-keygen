import { badCache, badResponse, KeygenError, parseErr, requestError } from "../../shared/keygen-error.ts";
import type { KeygenConfig } from "./config.ts";
import { verifyEd25519 } from "./crypto.ts";
import {
	buildSignatureData,
	parseSignatureHeader,
	signatureDataFromCache,
	signatureDataString,
	type KeygenResponseCache,
} from "./sig.ts";
import { parseLicenseResponse, type LicenseResponse } from "./types.ts";

/** Minimal surface of fetch used here, so tests can stub it without types coupling. */
export type HeadersLike = { get(name: string): string | null };

export type FetchResponseLike = {
	status: number;
	headers: HeadersLike;
	text(): Promise<string>;
};

export type FetchInitLike = {
	method: string;
	headers: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
};

export type FetchLike = (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;

/** Duration::from_secs(90) on every request, like the original reqwest calls. */
export const REQUEST_TIMEOUT_MS = 90_000;

/**
 * Port of tauri src/client/mod.rs. Owns URL construction, Ed25519 response
 * verification and validation-cache verification. No filesystem access.
 */
export class KeygenClient {
	private readonly apiVersion = 1;
	private readonly headers: Record<string, string>;
	private readonly config: KeygenConfig;
	private readonly fetchImpl: FetchLike;

	constructor(config: KeygenConfig, fetchImpl: FetchLike, defaultHeaders: Record<string, string>) {
		this.config = config;
		this.fetchImpl = fetchImpl;
		this.headers = { ...defaultHeaders };
	}

	buildUrl(path: string, params?: Array<[string, string]>): URL {
		const base = this.getBaseUrl();
		const fullPath = this.getFullPath(path);
		let url: URL;
		try {
			url = new URL(fullPath, base);
		} catch {
			throw parseErr("Failed to join path to base url");
		}
		if (params) {
			for (const [key, value] of params) url.searchParams.append(key, value);
		}
		return url;
	}

	private getBaseUrl(): string {
		if (this.config.customDomain) return this.config.customDomain;
		if (this.config.apiUrl) return this.config.apiUrl;
		throw parseErr("Failed getting base url: neither custom_domain nor api_url is provided");
	}

	private getFullPath(path: string): string {
		if (this.config.customDomain) {
			return `v${this.apiVersion}/${path}`;
		}
		if (this.config.apiUrl) {
			if (this.config.accountId) {
				return `v${this.apiVersion}/accounts/${this.config.accountId}/${path}`;
			}
			throw parseErr("Error parsing url: missing account_id");
		}
		throw parseErr("Error parsing url path");
	}

	/**
	 * Live-response verification (verify_response). The digest header must
	 * match the re-hashed body, the Date must be fresh, and the Ed25519
	 * signature over (request-target, host, date, digest) must verify.
	 * Returns the cache record on success.
	 */
	verifyResponse(
		method: string,
		url: URL,
		headers: HeadersLike,
		body: string,
		now = Date.now(),
	): KeygenResponseCache {
		const sigRaw = headers.get("Keygen-Signature");
		if (sigRaw === null) throw badResponse("Missing header: Keygen-Signature");
		const sig = parseSignatureHeader(sigRaw);

		// build_signature_data errors on a missing Date header before Digest is read
		const dateHeader = headers.get("Date");
		if (dateHeader === null) throw badResponse("Missing header: Date");

		const data = buildSignatureData(method, url, dateHeader, body);

		const resDigest = headers.get("Digest");
		if (resDigest === null) throw badResponse("Missing header: Digest");
		if (data.digest !== resDigest) throw badResponse("Digest didn't match");

		const dateMs = Date.parse(data.date);
		if (Number.isNaN(dateMs)) throw badResponse("Invalid signature date");

		// chrono's num_minutes truncates toward zero; negative (future dates) pass.
		const minutesSinceResponse = Math.trunc((now - dateMs) / 60000);
		if (this.config.maxClockDrift >= 0 && minutesSinceResponse > this.config.maxClockDrift) {
			throw badResponse("Request date too old");
		}

		try {
			this.verifySignature(signatureDataString(data), sig);
		} catch {
			throw badResponse("Invalid Signature");
		}

		return { sig, target: data.target, host: data.host, date: data.date, body };
	}

	/**
	 * Validation-cache verification (verify_response_cache): re-hashes the
	 * cached body, enforces cache_lifetime, then verifies the stored signature.
	 */
	verifyResponseCache(cache: KeygenResponseCache, now = Date.now()): LicenseResponse {
		const dateMs = Date.parse(cache.date);
		if (Number.isNaN(dateMs)) throw badCache("Failed parsing cached response date");

		const minutesSinceResponse = Math.trunc((now - dateMs) / 60000);
		if (minutesSinceResponse > this.config.cacheLifetime) {
			throw badCache("Validation cache has expired");
		}

		try {
			this.verifySignature(signatureDataFromCache(cache), cache.sig);
		} catch {
			throw badCache("Invalid Signature");
		}

		let resJson: unknown;
		try {
			resJson = JSON.parse(cache.body);
		} catch {
			throw badCache("Failed parsing cached response body");
		}
		return parseLicenseResponse(resJson, "Failed deserializing license response");
	}

	/** verify_signature in client/mod.rs; parse failures surface as ERR-coded errors. */
	verifySignature(data: string, signature: string): void {
		try {
			if (!verifyEd25519(this.config.verifyKey, data, signature)) {
				throw parseErr("Invalid signature");
			}
		} catch (err) {
			if (err instanceof Error && err.name === "KeygenError") throw err;
			throw parseErr(err instanceof Error ? err.message : "Invalid signature");
		}
	}

	/** res_text_json: text() is the source of truth; JSON parse failure is a hard error. */
	async resTextJson(res: FetchResponseLike): Promise<[string, unknown]> {
		const text = await res.text();
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			throw parseErr("Failed parsing response json");
		}
		return [text, json];
	}

	/** reqwest default headers (User-Agent, optional Keygen-Version). */
	get defaultHeaders(): Record<string, string> {
		return { ...this.headers };
	}

	/** POST a JSON body with the configured timeout; network failures map to REQUEST_ERROR. */
	async post(
		url: string,
		body: unknown | undefined,
		headers: Record<string, string>,
	): Promise<FetchResponseLike> {
		const merged = { ...this.headers, ...headers };
		try {
			return await this.fetchImpl(url, {
				method: "POST",
				headers: merged,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (err) {
			if (err instanceof KeygenError) throw err;
			throw requestError();
		}
	}
}

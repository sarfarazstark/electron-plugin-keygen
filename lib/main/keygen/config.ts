import { licenseErr } from "../../shared/keygen-error.ts";

/**
 * Port of the plugin `Builder` (tauri src/lib.rs).
 * Defaults and boundaries here must match the original exactly.
 */

export const DEFAULT_API_URL = "https://api.keygen.sh";
export const DEFAULT_CACHE_LIFETIME = 240; // minutes
export const CACHE_LIFETIME_MIN = 60;
export const CACHE_LIFETIME_MAX = 1440;
/** Hardcoded in the original KeygenClient::new. */
export const MAX_CLOCK_DRIFT = 5; // minutes

export type KeygenConfigInput = {
	/** When set, requests go to `{custom_domain}/v1/...` and apiUrl/accountId are ignored. */
	customDomain?: string;
	/** Ignored when customDomain is set (mirrors Builder::api_url()). */
	apiUrl?: string;
	accountId?: string;
	/** Hex-encoded Ed25519 public key (the account's "public key" in Keygen). */
	verifyKey: string;
	versionHeader?: string;
	/** Minutes; clamped to [60, 1440] like Builder::cache_lifetime(). */
	cacheLifetime?: number;
};

export type KeygenConfig = {
	customDomain: string | null;
	apiUrl: string | null;
	accountId: string | null;
	verifyKey: string;
	versionHeader: string | null;
	cacheLifetime: number;
	maxClockDrift: number;
};

export function isHexKey(key: unknown): key is string {
	return typeof key === "string" && /^[0-9a-fA-F]{64}$/.test(key);
}

export function resolveConfig(input: KeygenConfigInput): KeygenConfig {
	if (!isHexKey(input.verifyKey)) {
		throw licenseErr("CONFIG", "Invalid verify key: expected a 64-character hex Ed25519 public key");
	}

	const customDomain = input.customDomain?.trim() || null;
	const apiUrl = customDomain ? null : input.apiUrl?.trim() || DEFAULT_API_URL;
	const accountId = customDomain ? null : input.accountId?.trim() || null;

	if (!customDomain && !accountId) {
		throw licenseErr("CONFIG", "Missing account id: required unless a custom domain is used");
	}

	const cacheLifetime = clampCacheLifetime(input.cacheLifetime ?? DEFAULT_CACHE_LIFETIME);

	return {
		customDomain,
		apiUrl,
		accountId,
		verifyKey: input.verifyKey,
		versionHeader: input.versionHeader?.trim() || null,
		cacheLifetime,
		maxClockDrift: MAX_CLOCK_DRIFT,
	};
}

export function clampCacheLifetime(minutes: number): number {
	if (!Number.isFinite(minutes)) return DEFAULT_CACHE_LIFETIME;
	return Math.min(Math.max(Math.trunc(minutes), CACHE_LIFETIME_MIN), CACHE_LIFETIME_MAX);
}

/** Headers the original reqwest client attaches to every request (get_default_headers). */
export function buildDefaultHeaders(config: KeygenConfig, userAgent: string): Record<string, string> {
	const headers: Record<string, string> = { "User-Agent": headerSafe(userAgent) };
	if (config.versionHeader) headers["Keygen-Version"] = headerSafe(config.versionHeader);
	return headers;
}

/** Rust filtered to visible ASCII 32-127 before HeaderValue::from_str (get_header_value). */
function headerSafe(input: string): string {
	return [...input]
		.filter((c) => {
			const code = c.codePointAt(0) ?? 0;
			return code >= 32 && code <= 127;
		})
		.join("");
}

/**
 * Configuration from the environment. No production account id, verification
 * key, or server URL is hardcoded in the package: without KEYGEN_VERIFY_KEY
 * licensing is simply off.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): KeygenConfigInput | null {
	const verifyKey = env.KEYGEN_VERIFY_KEY;
	if (!verifyKey) return null;
	return {
		accountId: env.KEYGEN_ACCOUNT_ID,
		verifyKey,
		apiUrl: env.KEYGEN_API_URL,
		customDomain: env.KEYGEN_CUSTOM_DOMAIN,
		versionHeader: env.KEYGEN_VERSION_HEADER,
		cacheLifetime: env.KEYGEN_CACHE_LIFETIME ? Number(env.KEYGEN_CACHE_LIFETIME) : undefined,
	};
}

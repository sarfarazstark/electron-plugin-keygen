import { parseErr } from "../../shared/keygen-error.ts";
import type { KeygenLicense } from "../../shared/keygen-types.ts";

/**
 * Internal license struct + runtime guards mirroring the serde structs in
 * tauri src/licensed/types.rs and src/machine/types.rs. serde's default
 * behaviour is strict for non-Option fields, so required-field checks here
 * reproduce "Failed deserializing ..." errors instead of silently coercing.
 */

export type License = {
	/** Not exposed to the renderer: the original skips serializing it. */
	id: string;
	policyId: string;
	key: string;
	code: string;
	detail: string;
	expiry: string | null;
	entitlements: string[];
	metadata: unknown;
	valid: boolean;
};

export function toPublicLicense(l: License): KeygenLicense {
	return {
		key: l.key,
		code: l.code,
		detail: l.detail,
		expiry: l.expiry,
		valid: l.valid,
		policyId: l.policyId,
		entitlements: l.entitlements,
		metadata: (l.metadata ?? {}) as Record<string, unknown>,
	};
}

/* ------------------------------ license API ------------------------------ */

export type LicenseResponse = {
	meta: { ts: string; valid: boolean; detail: string; code: string; scope?: unknown };
	data: {
		id: string;
		attributes: { key: string; expiry: string | null; metadata: unknown };
		relationships: { policy: { data: { id: string } } };
	} | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function req<T>(value: unknown, check: (v: unknown) => v is T, detail: string): T {
	if (!check(value)) throw parseErr(detail);
	return value;
}

export function parseLicenseResponse(json: unknown, failDetail: string): LicenseResponse {
	if (!isRecord(json) || !isRecord(json.meta)) {
		throw parseErr(failDetail);
	}
	const meta = json.meta;
	const parsed: LicenseResponse = {
		meta: {
			ts: req(meta.ts, (v): v is string => typeof v === "string", failDetail),
			valid: req(meta.valid, (v): v is boolean => typeof v === "boolean", failDetail),
			detail: req(meta.detail, (v): v is string => typeof v === "string", failDetail),
			code: req(meta.code, (v): v is string => typeof v === "string", failDetail),
			scope: meta.scope,
		},
		data: null,
	};

	// NOT_FOUND responses carry no data
	if (json.data != null) {
		if (!isRecord(json.data)) throw parseErr(failDetail);
		const data = json.data;
		if (!isRecord(data.attributes) || !isRecord(data.relationships)) throw parseErr(failDetail);
		const policy = data.relationships.policy;
		if (!isRecord(policy) || !isRecord(policy.data)) throw parseErr(failDetail);
		parsed.data = {
			id: req(data.id, (v): v is string => typeof v === "string", failDetail),
			attributes: {
				key: req(data.attributes.key, (v): v is string => typeof v === "string", failDetail),
				expiry:
					data.attributes.expiry == null
						? null
						: req(data.attributes.expiry, (v): v is string => typeof v === "string", failDetail),
				metadata: data.attributes.metadata,
			},
			relationships: {
				policy: { data: { id: req(policy.data.id, (v): v is string => typeof v === "string", failDetail) } },
			},
		};
	}

	return parsed;
}

/* ------------------------------ machine file ------------------------------ */

export type IncludedItem =
	| {
			type: "licenses";
			id: string;
			attributes: { key: string; expiry: string; metadata: unknown };
			relationships: { policy: { data: { id: string } } };
	  }
	| { type: "entitlements"; attributes: { code: string } };

export type MachineLicense = {
	meta: { expiry: string | null; issued: string; ttl: number | null };
	included: IncludedItem[];
};

/**
 * #[serde(tag = "type")] with only licenses/entitlements variants: an unknown
 * tag fails the whole deserialization in the original, so it does here.
 */
export function parseMachineLicense(json: unknown, failDetail: string): MachineLicense {
	if (!isRecord(json) || !isRecord(json.meta) || !Array.isArray(json.included)) {
		throw parseErr(failDetail);
	}
	const meta = json.meta;
	if (typeof meta.issued !== "string") throw parseErr(failDetail);

	const included: IncludedItem[] = json.included.map((item) => {
		if (!isRecord(item)) throw parseErr(failDetail);
		if (item.type === "licenses") {
			if (!isRecord(item.attributes) || !isRecord(item.relationships)) throw parseErr(failDetail);
			const policy = item.relationships.policy;
			if (!isRecord(policy) || !isRecord(policy.data)) throw parseErr(failDetail);
			if (
				typeof item.id !== "string" ||
				typeof item.attributes.key !== "string" ||
				typeof item.attributes.expiry !== "string" ||
				typeof policy.data.id !== "string"
			) {
				throw parseErr(failDetail);
			}
			return {
				type: "licenses",
				id: item.id,
				attributes: {
					key: item.attributes.key,
					expiry: item.attributes.expiry,
					metadata: item.attributes.metadata,
				},
				relationships: { policy: { data: { id: policy.data.id } } },
			};
		}
		if (item.type === "entitlements") {
			if (!isRecord(item.attributes) || typeof item.attributes.code !== "string") throw parseErr(failDetail);
			return { type: "entitlements", attributes: { code: item.attributes.code } };
		}
		throw parseErr(failDetail);
	});

	return {
		meta: {
			expiry: typeof meta.expiry === "string" ? meta.expiry : null,
			issued: meta.issued,
			ttl: typeof meta.ttl === "number" ? meta.ttl : null,
		},
		included,
	};
}

/* --------------------------- checkout response --------------------------- */

export function parseMachineFileResponse(json: unknown, failDetail: string): string {
	if (!isRecord(json) || !isRecord(json.data) || !isRecord(json.data.attributes)) {
		throw parseErr(failDetail);
	}
	const cert = json.data.attributes.certificate;
	if (typeof cert !== "string") throw parseErr(failDetail);
	return cert;
}

/* ----------------------------- error payloads ---------------------------- */

export type ApiErrorPayload = { detail?: string; code?: string };

/**
 * parse_err_json in src/err.rs (client-error branch): serde deserializes
 * `{ errors: [{ code?, detail? }] }`, the first item wins; anything that
 * doesn't fit that shape throws like the original.
 */
export function parseApiErrors(json: unknown): { code: string; detail: string } {
	const deserializeFail = "Failed deserializing Keygen API error json";
	if (!isRecord(json)) throw parseErr(deserializeFail);

	// errors missing or null: Option field absent -> UNKNOWN
	if (!("errors" in json) || json.errors === null) {
		return { code: "UNKNOWN", detail: "Unknown Keygen API Error" };
	}
	if (!Array.isArray(json.errors)) throw parseErr(deserializeFail);
	if (json.errors.length === 0) {
		return { code: "UNKNOWN", detail: "Unknown Keygen API Error" };
	}

	const first = json.errors[0];
	if (!isRecord(first)) throw parseErr(deserializeFail);
	return {
		code: typeof first.code === "string" ? first.code : "",
		detail: typeof first.detail === "string" ? first.detail : "",
	};
}

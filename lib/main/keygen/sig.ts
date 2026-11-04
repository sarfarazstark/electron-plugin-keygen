import { badResponse } from "../../shared/keygen-error.ts";
import { sha256DigestHeader } from "./crypto.ts";

/**
 * Port of tauri src/client/sig.rs: parsing of the `Keygen-Signature` header
 * and construction of the exact 4-line string that Keygen signs.
 */

export type KeygenSigData = {
	target: string;
	host: string;
	date: string;
	digest: string;
};

/** What gets persisted in the validation cache (client/mod.rs KeygenResponseCache). */
export type KeygenResponseCache = {
	sig: string;
	target: string;
	host: string;
	date: string;
	body: string;
};

/**
 * Parse the parameterized header `algorithm="ed25519", signature="..."`.
 * Mirrors parse_header_params: split on ", ", then split each param on `"`
 * (splitn 3) and match keys prefixed "algorithm"/"signature".
 */
export function parseSignatureHeader(raw: string): string {
	let algorithm: string | undefined;
	let signature: string | undefined;

	for (const param of raw.split(", ")) {
		const parts = param.split('"');
		const key = parts[0];
		const val = parts[1];
		if (key === undefined || val === undefined) continue;
		if (key.startsWith("algorithm")) algorithm = val;
		if (key.startsWith("signature")) signature = val;
	}

	if (algorithm === undefined) {
		throw badResponse("Missing header: Keygen-Signature.algorithm");
	}
	if (algorithm !== "ed25519") {
		throw badResponse("Unsupported algorithm");
	}
	if (signature === undefined) {
		throw badResponse("Missing header: Keygen-Signature.signature");
	}
	return signature;
}

/** build_signature_data: `{method} {path}?{query}`, host (no port), Date header, body digest. */
export function buildSignatureData(
	method: string,
	url: URL,
	dateHeader: string,
	body: string,
): KeygenSigData {
	const target = `${method.toLowerCase()} ${url.pathname}${url.search}`;
	return {
		target,
		host: url.hostname,
		date: dateHeader,
		digest: sha256DigestHeader(body),
	};
}

/** KeygenSig::data(): the signed payload. */
export function signatureDataString(d: KeygenSigData): string {
	return [`(request-target): ${d.target}`, `host: ${d.host}`, `date: ${d.date}`, `digest: ${d.digest}`].join(
		"\n",
	);
}

/** from_response_cache: the digest is re-hashed from the cached body on verification. */
export function signatureDataFromCache(cache: KeygenResponseCache): string {
	return signatureDataString({
		target: cache.target,
		host: cache.host,
		date: cache.date,
		digest: sha256DigestHeader(cache.body),
	});
}

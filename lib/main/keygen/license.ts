import { parseErr } from "../../shared/keygen-error.ts";
import type { IncludedItem, License, LicenseResponse, MachineLicense } from "./types.ts";

/** Port of tauri src/licensed/license.rs. */

export function shouldMaintainAccess(l: License): boolean {
	return l.valid && l.code === "EXPIRED";
}

export function hasExpired(l: License, now = Date.now()): boolean {
	if (l.expiry === null) return true;
	const expiryMs = Date.parse(l.expiry);
	if (Number.isNaN(expiryMs)) return true;
	return Math.trunc((expiryMs - now) / 60000) <= 0;
}

export function fromLicenseResponse(res: LicenseResponse): License | null {
	if (res.data === null) return null;

	let entitlements: string[] = [];
	const scope = res.meta.scope;
	if (scope !== null && typeof scope === "object" && !Array.isArray(scope)) {
		const ent = (scope as Record<string, unknown>).entitlements;
		if (Array.isArray(ent) && ent.every((e) => typeof e === "string")) {
			entitlements = ent as string[];
		}
	}

	return {
		id: res.data.id,
		policyId: res.data.relationships.policy.data.id,
		key: res.data.attributes.key,
		code: res.meta.code,
		detail: res.meta.detail,
		expiry: res.data.attributes.expiry,
		metadata: res.data.attributes.metadata,
		entitlements,
		valid: res.meta.valid,
	};
}

export function fromMachineLicense(ml: MachineLicense, now = Date.now()): License | null {
	// If the machine file has an expiry, enforce issued/expiry window.
	if (ml.meta.expiry !== null) {
		if (hasMachineFileExpired(ml.meta.issued, ml.meta.expiry, now)) return null;
	}

	const licItem = ml.included.find((i) => i.type === "licenses");
	if (licItem?.type !== "licenses") return null;

	const entitlementCodes = ml.included
		.filter((i): i is Extract<IncludedItem, { type: "entitlements" }> => i.type === "entitlements")
		.map((i) => i.attributes.code);

	return {
		id: licItem.id,
		policyId: licItem.relationships.policy.data.id,
		key: licItem.attributes.key,
		code: "VALID",
		detail: "is valid",
		expiry: licItem.attributes.expiry,
		entitlements: entitlementCodes,
		metadata: licItem.attributes.metadata,
		valid: true,
	};
}

/**
 * has_machine_file_expired: also a clock-tamper check — an "issued" date in
 * the future invalidates the file (minutes_since_issued < 0).
 */
export function hasMachineFileExpired(issued: string, expiry: string, now = Date.now()): boolean {
	const issuedMs = Date.parse(issued);
	if (Number.isNaN(issuedMs)) throw parseErr("Failed parsing machine file issued date");
	const expiryMs = Date.parse(expiry);
	if (Number.isNaN(expiryMs)) throw parseErr("Failed parsing machine file expiry date");

	const minutesSinceIssued = Math.trunc((now - issuedMs) / 60000);
	const minutesToExpiry = Math.trunc((expiryMs - now) / 60000);

	const valid = minutesSinceIssued >= 0 && minutesToExpiry > 0;
	return !valid;
}

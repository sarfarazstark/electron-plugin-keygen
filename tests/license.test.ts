import assert from "node:assert/strict";
import { test } from "node:test";
import {
	fromLicenseResponse,
	fromMachineLicense,
	hasExpired,
	hasMachineFileExpired,
	shouldMaintainAccess,
} from "../lib/main/keygen/license.ts";
import {
	parseLicenseResponse,
	parseMachineLicense,
	toPublicLicense,
	type License,
} from "../lib/main/keygen/types.ts";

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const future = new Date(NOW + 3600_000).toISOString();
const past = new Date(NOW - 3600_000).toISOString();

function baseLicense(over: Partial<License> = {}): License {
	return {
		id: "lic-1",
		policyId: "pol-1",
		key: "KEY-1",
		code: "VALID",
		detail: "is valid",
		expiry: future,
		entitlements: [],
		metadata: {},
		valid: true,
		...over,
	};
}

/* ------------------------------ conversions ------------------------------ */

test("fromLicenseResponse maps meta + data", () => {
	const res = parseLicenseResponse(
		{
			meta: {
				ts: "t",
				valid: true,
				detail: "is valid",
				code: "VALID",
				scope: { entitlements: ["f1", "f2"] },
			},
			data: {
				id: "lic-1",
				attributes: { key: "K", expiry: future, metadata: { a: 1 } },
				relationships: { policy: { data: { id: "pol-1" } } },
			},
		},
		"fail",
	);
	const l = fromLicenseResponse(res);
	assert.ok(l);
	assert.equal(l.id, "lic-1");
	assert.equal(l.policyId, "pol-1");
	assert.equal(l.code, "VALID");
	assert.equal(l.valid, true);
	assert.deepEqual(l.entitlements, ["f1", "f2"]);
});

test("fromLicenseResponse without data returns null", () => {
	const res = parseLicenseResponse(
		{ meta: { ts: "t", valid: false, detail: "not found", code: "NOT_FOUND" }, data: null },
		"fail",
	);
	assert.equal(fromLicenseResponse(res), null);
});

test("parseLicenseResponse rejects missing required fields (serde parity)", () => {
	assert.throws(
		() => parseLicenseResponse({ meta: { valid: true, detail: "d", code: "c" } }, "boom"),
		/boom/,
	);
});

/* -------------------------------- expiry --------------------------------- */

test("hasExpired: null expiry counts as expired (like map_or(true))", () => {
	assert.equal(hasExpired(baseLicense({ expiry: null }), NOW), true);
});

test("hasExpired: past/future/unparseable", () => {
	assert.equal(hasExpired(baseLicense({ expiry: past }), NOW), true);
	assert.equal(hasExpired(baseLicense({ expiry: future }), NOW), false);
	assert.equal(hasExpired(baseLicense({ expiry: "not-a-date" }), NOW), true);
});

test("hasExpired: expiry exactly now is expired (<= 0 minutes)", () => {
	assert.equal(hasExpired(baseLicense({ expiry: new Date(NOW).toISOString() }), NOW), true);
});

test("shouldMaintainAccess requires valid && EXPIRED", () => {
	assert.equal(shouldMaintainAccess(baseLicense({ valid: true, code: "EXPIRED" })), true);
	assert.equal(shouldMaintainAccess(baseLicense({ valid: false, code: "EXPIRED" })), false);
	assert.equal(shouldMaintainAccess(baseLicense({ code: "VALID" })), false);
});

/* ----------------------------- machine license ---------------------------- */

const mlFixture = {
	meta: { expiry: future, issued: new Date(NOW - 60_000).toISOString(), ttl: 86400 },
	included: [
		{
			type: "licenses",
			id: "lic-9",
			attributes: { key: "MK", expiry: future, metadata: { m: 2 } },
			relationships: { policy: { data: { id: "pol-9" } } },
		},
		{ type: "entitlements", id: "e1", attributes: { code: "feat-pro" } },
	],
};

test("fromMachineLicense yields a VALID license", () => {
	const l = fromMachineLicense(parseMachineLicense(mlFixture, "fail"), NOW);
	assert.ok(l);
	assert.equal(l.code, "VALID");
	assert.equal(l.detail, "is valid");
	assert.equal(l.valid, true);
	assert.equal(l.id, "lic-9");
	assert.deepEqual(l.entitlements, ["feat-pro"]);
});

test("expired machine FILE returns null", () => {
	const l = fromMachineLicense(
		parseMachineLicense({ ...mlFixture, meta: { ...mlFixture.meta, expiry: past } }, "fail"),
		NOW,
	);
	assert.equal(l, null);
});

test("clock tampering (issued in the future) invalidates the file", () => {
	const l = fromMachineLicense(
		parseMachineLicense(
			{ ...mlFixture, meta: { ...mlFixture.meta, issued: new Date(NOW + 3600_000).toISOString() } },
			"fail",
		),
		NOW,
	);
	assert.equal(l, null);
});

test("machine file with no meta.expiry is accepted (perpetual)", () => {
	const l = fromMachineLicense(
		parseMachineLicense({ ...mlFixture, meta: { expiry: null, issued: "whatever", ttl: null } }, "fail"),
		NOW,
	);
	assert.ok(l);
	assert.equal(l.valid, true);
});

test("hasMachineFileExpired throws on unparseable dates", () => {
	assert.throws(() => hasMachineFileExpired("garbage", future, NOW), /issued date/);
	assert.throws(() => hasMachineFileExpired(new Date(NOW).toISOString(), "garbage", NOW), /expiry date/);
});

test("parseMachineLicense rejects unknown included item types", () => {
	assert.throws(
		() =>
			parseMachineLicense(
				{
					meta: mlFixture.meta,
					included: [...mlFixture.included, { type: "mystery", id: "x", attributes: {} }],
				},
				"deserialize fail",
			),
		/deserialize fail/,
	);
});

test("toPublicLicense omits the internal id", () => {
	const pub = toPublicLicense(baseLicense());
	assert.equal("id" in pub, false);
	assert.equal(pub.policyId, "pol-1");
});

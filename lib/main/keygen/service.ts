import { badResponse, httpError, type KeygenError, licenseErr, parseErr } from "../../shared/keygen-error.ts";
import type {
	KeygenLicense,
	ValidateCheckoutKeyOptions,
	ValidateKeyOptions,
} from "../../shared/keygen-types.ts";
import type { KeygenClient } from "./client.ts";
import { decryptMachineFile, type Machine } from "./machine.ts";
import { hasExpired, fromLicenseResponse, fromMachineLicense, shouldMaintainAccess } from "./license.ts";
import type { KeygenStorage } from "./storage.ts";
import {
	parseApiErrors,
	parseLicenseResponse,
	parseMachineFileResponse,
	toPublicLicense,
	type License,
	type MachineLicense,
} from "./types.ts";

export type Logger = {
	info: (msg: string) => void;
	warn: (msg: string) => void;
	error: (msg: string) => void;
};

export type ServiceDeps = {
	machine: Machine;
	storage: KeygenStorage;
	client: KeygenClient;
	log: Logger;
	now?: () => number;
};

/**
 * Main-process licensing service. Ports:
 * - src/licensed/mod.rs  (LicensedState: load, validate_key, caches)
 * - src/commands.rs      (side-effect ordering: cache -> update -> cache key)
 * - src/machine/mod.rs   (activate / checkout HTTP flows)
 * - guest-js/index.ts    (validateKey auto-activation dance, validateCheckoutKey combo)
 */
export class LicensingService {
	private license: License | null = null;
	private readonly now: () => number;
	private readonly deps: ServiceDeps;
	private vaultUsable = true;
	private startupError: string | null = null;

	constructor(deps: ServiceDeps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
	}

	/**
	 * False when the OS vault cannot hold licensing secrets: validations still
	 * succeed, but nothing is persisted and the license will not survive a
	 * restart. Main-process only — the renderer has no business reading it.
	 */
	get persistsLicenses(): boolean {
		return this.vaultUsable;
	}

	/** lib.rs setup: LicensedState::load or default (null) on any error. */
	async init(): Promise<void> {
		this.vaultUsable = await this.deps.storage.encryptionAvailable();
		if (!this.vaultUsable) {
			this.deps.log.warn(
				"OS-backed encryption is unavailable; license keys and validation caches will not be persisted",
			);
		}
		try {
			this.license = await this.load();
		} catch (err) {
			// Kept visible through the host's Logger rather than re-thrown: the app
			// starts unlicensed either way, and a stack trace would carry cache paths.
			this.startupError = describe(err);
			this.deps.log.warn(`licensing init failed, starting unlicensed: ${describe(err)}`);
			this.license = null;
		}
	}

	private async load(): Promise<License | null> {
		const key = await this.deps.storage.readLicenseKey();
		if (key === null) return null;

		// 1. offline machine license file
		const ml = this.loadMachineLicense(key);
		if (ml !== null) {
			try {
				// Note: a present-but-expired machine file returns null here and
				// short-circuits the response-cache fallback, exactly like the
				// original's `Ok(license) => return Ok(Self { license })`.
				return fromMachineLicense(ml, this.now());
			} catch (err) {
				this.deps.log.warn(`machine license conversion failed: ${describe(err)}`);
			}
		}

		// 2. validation response cache for today
		const cached = await this.deps.storage.loadResponseCache(key);
		if (cached !== null) {
			try {
				this.deps.storage.clearResponseCacheExcept(cached.path);
			} catch (err) {
				this.deps.log.warn(`cache housekeeping failed: ${describe(err)}`);
			}
			const licRes = this.deps.client.verifyResponseCache(cached.cache, this.now());
			const license = fromLicenseResponse(licRes);
			return license;
		}

		return null;
	}

	private loadMachineLicense(key: string): MachineLicense | null {
		let cert: string | null;
		try {
			cert = this.deps.storage.readMachineFile();
		} catch (err) {
			this.deps.log.warn(`machine file read failed: ${describe(err)}`);
			return null;
		}
		if (cert === null) return null;
		try {
			return decryptMachineFile(cert, key, this.deps.machine.fingerprint, (d, s) =>
				this.deps.client.verifySignature(d, s),
			);
		} catch (err) {
			this.deps.log.warn(`machine file decrypt failed: ${describe(err)}`);
			return null;
		}
	}

	/* ------------------------------ queries ------------------------------- */

	getLicense(): KeygenLicense | null {
		return this.license === null ? null : toPublicLicense(this.license);
	}

	async getLicenseKey(): Promise<string | null> {
		return this.deps.storage.readLicenseKey();
	}

	/** Sanitized reason startup left the app unlicensed, for host diagnostics (main process). */
	get startupDiagnostic(): string | null {
		return this.startupError;
	}

	/* --------------------------- validate flow ---------------------------- */

	/** guest-js validateKey: validate, auto-activate on NO_MACHINE*, re-validate. */
	async validateKey(options: ValidateKeyOptions): Promise<KeygenLicense> {
		const entitlements = options.entitlements ?? [];
		const cacheValidResponse = options.cacheValidResponse ?? true;

		let license = await this.rawValidate(options.key, entitlements, cacheValidResponse);

		const noMachine =
			license.code === "NO_MACHINE" ||
			license.code === "NO_MACHINES" ||
			license.code === "FINGERPRINT_SCOPE_MISMATCH";

		if (noMachine) {
			await this.activate();
			license = await this.rawValidate(options.key, entitlements, cacheValidResponse);
		}

		return toPublicLicense(license);
	}

	/** commands.rs validate_key + LicensedState::validate_key. */
	private async rawValidate(
		key: string,
		entitlements: string[],
		cacheValidResponse: boolean,
	): Promise<License> {
		const machine = this.deps.machine;
		if (machine.fingerprint === "") {
			throw licenseErr(
				"NO_FINGERPRINT",
				"Can't validate license for this machine: Failed parsing machine fingerprint",
			);
		}

		// Probed before the request so an unusable vault cannot turn a successful
		// validation into a storage error after the fact.
		this.vaultUsable = await this.deps.storage.encryptionAvailable();

		const url = this.deps.client.buildUrl("licenses/actions/validate-key");
		const scope: Record<string, unknown> = { fingerprint: machine.fingerprint };
		if (entitlements.length > 0) scope.entitlements = entitlements;
		const body = { meta: { key: key.trimEnd(), scope } };

		const res = await this.deps.client.post(url.toString(), body, {
			"Content-Type": "application/vnd.api+json",
			Accept: "application/vnd.api+json",
		});

		const [text, json] = await this.deps.client.resTextJson(res);

		if (res.status === 200) {
			const resCache = this.deps.client.verifyResponse("post", url, res.headers, text, this.now());
			const licRes = parseLicenseResponse(json, "Failed deserializing license validation response");

			if (licRes.meta.code === "NOT_FOUND") {
				throw licenseErr(licRes.meta.code, licRes.meta.detail);
			}

			const license = fromLicenseResponse(licRes);
			if (license === null) {
				throw badResponse("Missing data on license validation response");
			}

			// Deviation from commands.rs, which cached the key unconditionally: an
			// invalid (revoked, banned, expired-without-grace) key is never written,
			// and an invalid result never overwrites a previously cached key either.
			// Persistence happens before the state assignment so that a storage
			// failure leaves the reported result and getLicense() agreeing.
			if (license.valid && this.vaultUsable) {
				if (cacheValidResponse && license.expiry !== null) {
					await this.deps.storage.cacheResponse(license.key, resCache);
				}
				await this.deps.storage.writeLicenseKey(license.key);
			}
			if (license.valid && !this.vaultUsable) {
				this.deps.log.warn(
					"validated but did not persist the license key: OS-backed encryption is unavailable, so this license will not survive a restart",
				);
			}
			this.license = license;

			return license;
		}

		throw this.mapStatusError(res.status, json);
	}

	/* ---------------------------- activation ------------------------------ */

	/** commands.rs activate + Machine::activate. */
	async activate(): Promise<void> {
		const license = this.license;
		if (license === null) {
			throw licenseErr(
				"NO_LICENSE",
				"Can't activate a machine. Current app state has no license. Call validate(key) first.",
			);
		}

		const machine = this.deps.machine;
		if (machine.fingerprint === "") {
			throw licenseErr("NO_FINGERPRINT", "Can't activate this machine. Failed parsing machine fingerprint");
		}

		const url = this.deps.client.buildUrl("machines");
		const body = {
			data: {
				type: "machines",
				attributes: {
					fingerprint: machine.fingerprint,
					name: machine.name,
					platform: machine.platform,
				},
				relationships: {
					license: { data: { type: "licenses", id: license.id } },
				},
			},
		};

		const res = await this.deps.client.post(url.toString(), body, {
			"Content-Type": "application/vnd.api+json",
			Accept: "application/vnd.api+json",
			Authorization: `License ${license.key}`,
		});

		const [text, json] = await this.deps.client.resTextJson(res);

		if (res.status === 201) {
			this.deps.client.verifyResponse("post", url, res.headers, text, this.now());
			return;
		}
		throw this.mapStatusError(res.status, json);
	}

	/* ----------------------------- checkout ------------------------------- */

	/** commands.rs checkout_machine + Machine::checkout. */
	async checkout(ttlSeconds: number, ttlForever: boolean): Promise<void> {
		const license = this.license;
		if (license === null) {
			throw licenseErr(
				"NO_LICENSE",
				"Can't checkout machine file. Current app state has no license. Call validateKey() first.",
			);
		}
		if (!license.valid) {
			throw licenseErr("INVALID_LICENSE", "Can't checkout machine file. Current license is invalid");
		}
		if (license.expiry === null) {
			throw licenseErr(
				"NOT_ACTIVATED",
				"Can't checkout machine file. License hasn't been fully activated. Expiry still Null",
			);
		}
		if (hasExpired(license, this.now()) && !shouldMaintainAccess(license)) {
			throw licenseErr("EXPIRED", "Can't checkout machine file. License has expired");
		}
		// A machine file is encrypted under sha256(key || fingerprint), so it is
		// unreadable without the cached key. Issuing one that the next launch cannot
		// decrypt would claim offline access that does not exist.
		if (!(await this.deps.storage.encryptionAvailable())) {
			throw licenseErr(
				"STORAGE_UNAVAILABLE",
				"Can't checkout machine file. OS-backed encryption is unavailable, so the license key needed to read the machine file cannot be persisted",
			);
		}

		// ttl: min 1 hour, max 1 year (u32 in Rust — clamp bounds identical)
		const clamped = Math.trunc(Math.min(Math.max(ttlSeconds, 3600), 31_556_952));

		const expiryMs = Date.parse(license.expiry);
		if (Number.isNaN(expiryMs)) throw parseErr("Failed parsing license expiry date");
		const secondsToExpiry = Math.trunc((expiryMs - this.now()) / 1000);
		// A signed/unsigned min, like std::cmp::min on i64
		const ttlValue = Math.min(secondsToExpiry, clamped);

		const params: Array<[string, string]> = [
			["encrypt", "1"],
			["include", "license.entitlements,license"],
		];
		if (ttlForever && shouldMaintainAccess(license)) {
			params.push(["ttl", ""]); // perpetual fallback license
		} else if (ttlValue > 0) {
			params.push(["ttl", String(ttlValue)]);
		}
		// Otherwise omitted: a license already past its expiry has no remaining
		// lifetime, and the original sent the negative value verbatim (ttl=-100).
		// Clamping up to a floor would hand out offline access the licence does not
		// have, so the server default applies instead.

		const url = this.deps.client.buildUrl(
			`machines/${this.deps.machine.fingerprint}/actions/check-out`,
			params,
		);

		// The original sends no Content-Type on this request
		const res = await this.deps.client.post(url.toString(), undefined, {
			Accept: "application/vnd.api+json",
			Authorization: `License ${license.key}`,
		});

		const [text, json] = await this.deps.client.resTextJson(res);

		if (res.status === 200) {
			this.deps.client.verifyResponse("post", url, res.headers, text, this.now());
			const cert = parseMachineFileResponse(json, "Failed deserializing machine file response");
			this.deps.storage.saveMachineFile(cert);
			return;
		}
		throw this.mapStatusError(res.status, json);
	}

	/** guest-js validateCheckoutKey. */
	async validateCheckoutKey(options: ValidateCheckoutKeyOptions): Promise<KeygenLicense> {
		const license = await this.validateKey({
			key: options.key,
			entitlements: options.entitlements ?? [],
			cacheValidResponse: false,
		});

		if (license.valid) {
			await this.checkout(options.ttlSeconds ?? 86400, options.ttlForever ?? false);
		}

		return license;
	}

	/* ------------------------------ resets -------------------------------- */

	/** commands.rs reset_license: files + state, but NOT the cached key. */
	resetLicense(): void {
		this.license = null;
		this.deps.storage.removeMachineFile();
		this.deps.storage.clearResponseCache();
	}

	/** commands.rs reset_license_key: only the cached key. */
	resetLicenseKey(): void {
		this.deps.storage.removeLicenseKey();
	}

	/* ------------------------------ helpers ------------------------------- */

	private mapStatusError(status: number, json: unknown): KeygenError {
		if (status >= 400 && status <= 499) {
			const { code, detail } = parseApiErrors(json);
			return licenseErr(code, detail);
		}
		return httpError(String(status));
	}
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

import fs from "node:fs";
import path from "node:path";
import { licenseErr, parseErr } from "../../shared/keygen-error.ts";
import { sha256Hex } from "./crypto.ts";
import type { KeygenResponseCache } from "./sig.ts";

/**
 * Replaces the Tauri filesystem/paths layer with `app.getPath("userData")`.
 * Layout preserved from the original:
 *   userData/keygen/machine.lic          (offline machine license cert, raw format)
 *   userData/keygen/key                  (cached license key — safeStorage-encrypted here)
 *   userData/keygen/validation_cache/    (per-day validation response caches)
 */

/** OS-backed secret storage seam so tests and non-Electron hosts don't import electron. */
export type SecretCodec = {
	isAvailable(): boolean;
	encrypt(plaintext: string): Buffer;
	decrypt(blob: Buffer): string;
};

export class KeygenStorage {
	private readonly baseDir: string;
	private readonly codec: SecretCodec;

	constructor(userDataDir: string, codec: SecretCodec) {
		this.baseDir = path.join(userDataDir, "keygen");
		this.codec = codec;
	}

	/* ------------------------------ machine file ------------------------------ */

	machineFilePath(): string {
		return path.join(this.baseDir, "machine.lic");
	}

	saveMachineFile(cert: string): void {
		fs.mkdirSync(this.baseDir, { recursive: true });
		fs.writeFileSync(this.machineFilePath(), cert, "utf8");
	}

	readMachineFile(): string | null {
		const p = this.machineFilePath();
		if (!fs.existsSync(p)) return null;
		return fs.readFileSync(p, "utf8");
	}

	removeMachineFile(): void {
		const p = this.machineFilePath();
		if (fs.existsSync(p)) fs.unlinkSync(p);
	}

	/* ----------------------------- license key ------------------------------ */

	keyFilePath(): string {
		return path.join(this.baseDir, "key");
	}

	/**
	 * Writes the license key encrypted via safeStorage. Never falls back to
	 * plaintext: silently downgrading a licensing secret is worse than failing.
	 */
	writeLicenseKey(key: string): void {
		fs.mkdirSync(this.baseDir, { recursive: true });
		if (!this.codec.isAvailable()) {
			throw licenseErr(
				"STORAGE_UNAVAILABLE",
				"OS-backed encryption is unavailable; refusing to store the license key in plaintext",
			);
		}
		let blob: Buffer;
		try {
			blob = this.codec.encrypt(key);
		} catch {
			throw licenseErr("STORAGE_UNAVAILABLE", "Failed encrypting the license key");
		}
		fs.writeFileSync(this.keyFilePath(), blob);
	}

	readLicenseKey(): string | null {
		const p = this.keyFilePath();
		if (!fs.existsSync(p)) return null;
		if (!this.codec.isAvailable()) {
			throw licenseErr(
				"STORAGE_UNAVAILABLE",
				"OS-backed encryption became unavailable; cannot read the cached license key",
			);
		}
		try {
			return this.codec.decrypt(fs.readFileSync(p));
		} catch {
			throw licenseErr("STORAGE_DECRYPT_FAILED", "Failed decrypting the cached license key");
		}
	}

	removeLicenseKey(): void {
		const p = this.keyFilePath();
		if (fs.existsSync(p)) fs.unlinkSync(p);
	}

	/* ---------------------------- response cache ---------------------------- */

	cacheDir(): string {
		return path.join(this.baseDir, "validation_cache");
	}

	/**
	 * get_response_cache_path: sha256("{licenseKey}:{YYYY-MM-DD local}") hex as
	 * the filename, so caches are keyed per calendar day like the original.
	 */
	responseCachePath(licenseKey: string, date = new Date()): string {
		const dir = this.cacheDir();
		fs.mkdirSync(dir, { recursive: true });
		return path.join(dir, sha256Hex(`${licenseKey}:${toLocalDateNaive(date)}`));
	}

	cacheResponse(licenseKey: string, cache: KeygenResponseCache): void {
		const p = this.responseCachePath(licenseKey);
		fs.writeFileSync(p, JSON.stringify(cache), "utf8");
	}

	loadResponseCache(
		licenseKey: string,
		date = new Date(),
	): { cache: KeygenResponseCache; path: string } | null {
		const p = this.responseCachePath(licenseKey, date);
		if (!fs.existsSync(p)) return null;

		let cache: unknown;
		try {
			cache = JSON.parse(fs.readFileSync(p, "utf8"));
		} catch {
			throw parseErr("Failed parsing response cache to json");
		}
		if (
			typeof cache !== "object" ||
			cache === null ||
			!["sig", "target", "host", "date", "body"].every(
				(k) => typeof (cache as Record<string, unknown>)[k] === "string",
			)
		) {
			throw parseErr("Failed deserializing response cache");
		}
		return { cache: cache as KeygenResponseCache, path: p };
	}

	clearResponseCache(): void {
		const dir = this.cacheDir();
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
	}

	/** clear_response_cache_except: housekeeping at startup keeps only today's entry. */
	clearResponseCacheExcept(keepPath: string): void {
		const dir = this.cacheDir();
		if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
		for (const entry of fs.readdirSync(dir)) {
			const p = path.join(dir, entry);
			if (fs.statSync(p).isFile() && p !== keepPath) fs.unlinkSync(p);
		}
	}
}

/** chrono's Date::to_string for the local (naive) date. */
export function toLocalDateNaive(d: Date): string {
	const y = d.getFullYear().toString().padStart(4, "0");
	const m = (d.getMonth() + 1).toString().padStart(2, "0");
	const day = d.getDate().toString().padStart(2, "0");
	return `${y}-${m}-${day}`;
}

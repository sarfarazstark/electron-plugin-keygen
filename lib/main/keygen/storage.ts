import fs from "node:fs";
import path from "node:path";
import { licenseErr, parseErr } from "../../shared/keygen-error.ts";
import { sha256Hex } from "./crypto.ts";
import type { KeygenResponseCache } from "./sig.ts";

/**
 * Replaces the Tauri filesystem/paths layer with `app.getPath("userData")`.
 * Layout preserved from the original:
 *   userData/keygen/machine.lic          (offline machine license cert, raw format)
 *   userData/keygen/key                  (cached license key — safeStorage-encrypted)
 *   userData/keygen/validation_cache/    (per-day validation response caches, encrypted)
 */

/** OS-backed secret storage seam so tests and non-Electron hosts don't import electron. */
export type SecretCodec = {
	isAvailable(): Promise<boolean>;
	encrypt(plaintext: string): Promise<Buffer>;
	/** `reencrypt` is Electron's key-rotation signal: the caller should rewrite the blob. */
	decrypt(blob: Buffer): Promise<{ plaintext: string; reencrypt: boolean }>;
};

export type StorageLogger = { warn: (msg: string) => void };

/**
 * A cached response is a signed copy of the whole validate-key body, license key
 * included, so it is encrypted like the cached key. The prefix lets the loader
 * tell an encrypted entry from a pre-fix plaintext one rather than guessing from
 * bytes that happen to fail decryption.
 */
const CACHE_MAGIC = "KGC1\n";

export class KeygenStorage {
	private readonly baseDir: string;
	private readonly codec: SecretCodec;
	private readonly log: StorageLogger | null;

	constructor(userDataDir: string, codec: SecretCodec, log: StorageLogger | null = null) {
		this.baseDir = path.join(userDataDir, "keygen");
		this.codec = codec;
		this.log = log;
	}

	/**
	 * Callers gate persistence on this so an unavailable vault is known before a
	 * network round trip, not after a validation has already succeeded.
	 */
	async encryptionAvailable(): Promise<boolean> {
		try {
			return await this.codec.isAvailable();
		} catch {
			return false;
		}
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

	async writeLicenseKey(key: string): Promise<void> {
		fs.mkdirSync(this.baseDir, { recursive: true });
		await this.guard("store the license key in plaintext");
		const blob = await this.encrypt(key, "Failed encrypting the license key");
		fs.writeFileSync(this.keyFilePath(), blob);
	}

	async readLicenseKey(): Promise<string | null> {
		const p = this.keyFilePath();
		if (!fs.existsSync(p)) return null;
		await this.guard("read the cached license key");
		const { plaintext, reencrypt } = await this.decrypt(
			fs.readFileSync(p),
			"Failed decrypting the cached license key",
		);
		if (reencrypt) await this.rewrite(p, plaintext, null);
		return plaintext;
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

	async cacheResponse(licenseKey: string, cache: KeygenResponseCache): Promise<void> {
		const p = this.responseCachePath(licenseKey);
		await this.guard("store the validation cache in plaintext");
		const blob = await this.encrypt(JSON.stringify(cache), "Failed encrypting the validation cache");
		fs.writeFileSync(p, CACHE_MAGIC + blob.toString("base64"));
	}

	async loadResponseCache(
		licenseKey: string,
		date = new Date(),
	): Promise<{ cache: KeygenResponseCache; path: string } | null> {
		const p = this.responseCachePath(licenseKey, date);
		if (!fs.existsSync(p)) return null;

		const raw = fs.readFileSync(p, "utf8");
		if (!raw.startsWith(CACHE_MAGIC)) {
			// Written before caches were encrypted: an unprotected copy of the license
			// key. Deleted instead of read, so the app revalidates online.
			fs.rmSync(p, { force: true });
			this.log?.warn("removed an unencrypted validation cache; the license must be revalidated");
			return null;
		}

		await this.guard("read the validation cache");
		const { plaintext, reencrypt } = await this.decrypt(
			Buffer.from(raw.slice(CACHE_MAGIC.length), "base64"),
			"Failed decrypting the validation cache",
		);

		let cache: unknown;
		try {
			cache = JSON.parse(plaintext);
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
		if (reencrypt) await this.rewrite(p, plaintext, CACHE_MAGIC);
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

	/* -------------------------------- codec --------------------------------- */

	/** Never a plaintext fallback: an unusable vault is an explicit error. */
	private async guard(refuse: string): Promise<void> {
		if (!(await this.encryptionAvailable())) {
			throw licenseErr("STORAGE_UNAVAILABLE", `OS-backed encryption is unavailable; refusing to ${refuse}`);
		}
	}

	private async encrypt(plaintext: string, failure: string): Promise<Buffer> {
		try {
			return await this.codec.encrypt(plaintext);
		} catch {
			throw licenseErr("STORAGE_UNAVAILABLE", failure);
		}
	}

	private async decrypt(blob: Buffer, failure: string): Promise<{ plaintext: string; reencrypt: boolean }> {
		try {
			return await this.codec.decrypt(blob);
		} catch {
			throw licenseErr("STORAGE_DECRYPT_FAILED", failure);
		}
	}

	/** Key rotation: rewrite under the current key. Failing to do so is not fatal. */
	private async rewrite(p: string, plaintext: string, magic: string | null): Promise<void> {
		try {
			const blob = await this.codec.encrypt(plaintext);
			fs.writeFileSync(p, magic === null ? blob : magic + blob.toString("base64"));
		} catch (err) {
			this.log?.warn(`failed to re-encrypt licensing data after a key rotation: ${String(err)}`);
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

import type { KeygenConfigInput } from "./config.ts";
import { DEFAULT_API_URL, clampCacheLifetime } from "./config.ts";

/**
 * Fluent mirror of the Rust plugin `Builder` (tauri src/lib.rs). Setters behave
 * like the original: `apiUrl` is ignored once a custom domain is set, and
 * `cacheLifetime` clamps to [60, 1440] minutes at set time.
 */
export class KeygenBuilder {
	#customDomain: string | null = null;
	#apiUrl: string | null = DEFAULT_API_URL;
	#accountId: string | null = null;
	#verifyKey: string;
	#versionHeader: string | null = null;
	#cacheLifetime = 240;

	private constructor(verifyKey: string) {
		this.#verifyKey = verifyKey;
	}

	/** Hosted Keygen: `KeygenBuilder.new(accountId, verifyKey)`. */
	static new(accountId: string, verifyKey: string): KeygenBuilder {
		const builder = new KeygenBuilder(verifyKey);
		builder.#accountId = accountId;
		return builder;
	}

	/** Self-hosted / custom domain: account id and api url become irrelevant. */
	static withCustomDomain(customDomain: string, verifyKey: string): KeygenBuilder {
		const builder = new KeygenBuilder(verifyKey);
		builder.#customDomain = customDomain;
		builder.#apiUrl = null;
		builder.#accountId = null;
		return builder;
	}

	apiUrl(url: string): this {
		if (this.#customDomain === null) this.#apiUrl = url;
		return this;
	}

	versionHeader(header: string): this {
		this.#versionHeader = header;
		return this;
	}

	cacheLifetime(minutes: number): this {
		this.#cacheLifetime = clampCacheLifetime(minutes);
		return this;
	}

	build(): KeygenConfigInput {
		const input: KeygenConfigInput = { verifyKey: this.#verifyKey, cacheLifetime: this.#cacheLifetime };
		if (this.#customDomain !== null) input.customDomain = this.#customDomain;
		if (this.#apiUrl !== null) input.apiUrl = this.#apiUrl;
		if (this.#accountId !== null) input.accountId = this.#accountId;
		if (this.#versionHeader !== null) input.versionHeader = this.#versionHeader;
		return input;
	}
}

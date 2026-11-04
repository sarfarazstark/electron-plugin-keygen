/**
 * Error shape crossing the IPC boundary, equivalent to the Rust plugin's
 * `ErrorSummary` (src/err.rs) and the guest binding's `KeygenError`
 * (guest-js/error.ts). `ipcRenderer.invoke` cannot preserve Error subclasses
 * (custom fields are lost during structured clone), so handlers return an
 * envelope and the renderer entry rebuilds this object and throws it.
 */

export class KeygenError extends Error {
	public code: string;
	public detail: string;

	constructor({ code, detail }: { code: string; detail: string }) {
		super(`Keygen Error: ${code}: ${detail}`);
		Object.setPrototypeOf(this, new.target.prototype);
		this.name = "KeygenError";
		this.code = code;
		this.detail = detail;
	}

	public toSummary(): { code: string; detail: string } {
		return { code: this.code, detail: this.detail };
	}
}

/* The factories below mirror ErrorSummary's From<Error> mapping in src/err.rs. */

export const httpError = (detail: string) => new KeygenError({ code: "HTTP_ERROR", detail });

export const requestError = () =>
	new KeygenError({ code: "REQUEST_ERROR", detail: "Failed sending request: Check your internet" });

export const badResponse = (detail: string) => new KeygenError({ code: "BAD_RESPONSE", detail });

export const badCache = (detail: string) => new KeygenError({ code: "BAD_CACHE", detail });

/** Rust's Error::ParseErr / Io / PathErr all map to code "ERR". */
export const parseErr = (detail: string) => new KeygenError({ code: "ERR", detail });

export const licenseErr = (code: string, detail: string) => new KeygenError({ code, detail });

export const apiErr = (code: string, detail: string) => new KeygenError({ code, detail });

export function asKeygenError(err: unknown): KeygenError {
	if (err instanceof KeygenError) return err;
	if (err instanceof Error) return parseErr(err.message);
	try {
		return parseErr(JSON.stringify(err));
	} catch {
		return parseErr(String(err));
	}
}

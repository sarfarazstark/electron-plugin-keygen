import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { parseErr } from "../../shared/keygen-error.ts";
import { aes256GcmDecrypt, decodeBase64, sha256Bytes } from "./crypto.ts";
import { parseMachineLicense, type MachineLicense } from "./types.ts";

/**
 * Port of tauri src/machine/mod.rs (identity part) and decrypt_machine_file.
 *
 * Fingerprint source must match the original `machine-uid` crate, otherwise
 * existing Keygen machines stop matching after the port:
 * - Windows: HKLM\SOFTWARE\Microsoft\Cryptography MachineGuid (registry, with braces)
 * - macOS:   IOPlatformUUID from ioreg
 * - Linux:   /etc/machine-id or /var/lib/dbus/machine-id
 */

export type Machine = {
	fingerprint: string;
	name: string;
	platform: string;
	userAgent: string;
};

export type MachineDeps = {
	appName: string;
	appVersion: string;
	locale: string;
	/** Injectable for tests; defaults to the real platform readers. */
	fingerprint?: () => string;
	deviceName?: () => string;
	platformString?: () => string;
};

export function createMachine(deps: MachineDeps): Machine {
	// machine_uid::get().unwrap_or("") — a failed read yields an empty string,
	// which validateKey surfaces as NO_FINGERPRINT.
	let fingerprint = "";
	try {
		fingerprint = (deps.fingerprint ?? readMachineId)();
	} catch {
		fingerprint = "";
	}
	const name = (deps.deviceName ?? (() => os.hostname()))();
	const platform = (deps.platformString ?? readPlatformString)();

	// Original: "{app}/{ver} {os}/{osver} {engine}/{enginever} {locale}".
	// Tauri embedded WebView2; Electron embeds Electron/Chromium, so the engine
	// token is "Electron/<version>". Format is preserved.
	const engineName = "Electron";
	const engineVersion = process.versions.electron ?? "unknown";
	const osName = platform.split(" - ")[0] ?? "";
	const osVersion = platform.split(" - ")[1] ?? "";
	const userAgent =
		`${deps.appName}/${deps.appVersion} ${osName}/${osVersion} ${engineName}/${engineVersion} ${deps.locale}`.trim();

	return { fingerprint, name, platform, userAgent };
}

/* --------------------------- identity readers --------------------------- */

export function readMachineId(): string {
	switch (process.platform) {
		case "win32": {
			const out = execFileSync(
				"reg",
				["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
				{ encoding: "utf8", windowsHide: true },
			);
			const match = out.match(/MachineGuid\s+REG_SZ\s+(.+)/)?.[1];
			return match ? match.trim() : "";
		}
		case "darwin": {
			const out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
				encoding: "utf8",
			});
			const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
			return match ?? "";
		}
		default: {
			for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
				try {
					const v = fs.readFileSync(p, "utf8").trim();
					if (v) return v;
				} catch {
					// try next
				}
			}
			return "";
		}
	}
}

/** whoami port: "{os} - {distro} - {arch}" (os names per whoami::platform Display). */
export function readPlatformString(): string {
	const osName = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
	const distro = readDistro(osName);
	const arch = readArch();
	return `${osName} - ${distro} - ${arch}`;
}

function readDistro(osName: string): string {
	if (osName === "Windows") {
		// whoami::distro() reads the registry ProductName (e.g. "Windows 11 Pro")
		try {
			const out = execFileSync(
				"reg",
				["query", "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "/v", "ProductName"],
				{ encoding: "utf8", windowsHide: true },
			);
			const match = out.match(/ProductName\s+REG_SZ\s+(.+)/)?.[1];
			if (match) return match.trim();
		} catch {
			// fall through
		}
		return os.release();
	}
	if (osName === "Linux") {
		try {
			const rel = fs.readFileSync("/etc/os-release", "utf8");
			const match = rel.match(/PRETTY_NAME="?([^"\n]+)"?/)?.[1];
			if (match) return match;
		} catch {
			// fall through
		}
		return "Linux";
	}
	return `macOS ${os.release()}`;
}

function readArch(): string {
	// whoami::arch() Display strings, not Node's os.arch() names
	switch (os.arch()) {
		case "x64":
			return "x86_64";
		case "arm64":
			return "aarch64";
		case "ia32":
			return "x86";
		default:
			return os.arch();
	}
}

/* --------------------------- machine file crypto -------------------------- */

type MachineFileEnvelope = { enc: string; sig: string; alg: string };

/** decrypt_machine_file in src/machine/mod.rs, reproduced byte-for-byte. */
export function decryptMachineFile(
	cert: string,
	licenseKey: string,
	fingerprint: string,
	verifySignature: (data: string, signature: string) => void,
): MachineLicense {
	// Strip the PEM armor and newlines (original only strips '\n').
	const enc = cert
		.replace("-----BEGIN MACHINE FILE-----", "")
		.replace("-----END MACHINE FILE-----", "")
		.replace(/\n/g, "");

	let payloadJson: string;
	try {
		payloadJson = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(enc));
	} catch {
		throw parseErr("Failed decoding machine file");
	}

	let lic: unknown;
	try {
		lic = JSON.parse(payloadJson);
	} catch {
		throw parseErr("failed deserializing machine file");
	}

	if (
		typeof lic !== "object" ||
		lic === null ||
		typeof (lic as Record<string, unknown>).enc !== "string" ||
		typeof (lic as Record<string, unknown>).sig !== "string" ||
		typeof (lic as Record<string, unknown>).alg !== "string"
	) {
		throw parseErr("failed deserializing machine file");
	}
	const envelope = lic as MachineFileEnvelope;

	if (envelope.alg !== "aes-256-gcm+ed25519") {
		throw parseErr("algorithm is not supported");
	}

	// Verify the machine file signature over "machine/{enc}" with the account's
	// public key. Failures propagate as-is (ERR coded), like the original `?`.
	verifySignature(`machine/${envelope.enc}`, envelope.sig);

	// AES key = SHA-256(license key bytes || fingerprint bytes)
	const digest = sha256Key(licenseKey, fingerprint);

	const parts = envelope.enc.trim().split(".");
	// The original indexes [0..2] and panics on malformed base64; in a host
	// process a crash is unacceptable, so malformed input becomes an error.
	const [encCiphertext, encNonce, encTag] = parts;
	if (encCiphertext === undefined || encNonce === undefined || encTag === undefined) {
		throw parseErr("Failed decrypting machine file");
	}

	let ciphertext: Buffer;
	let nonce: Buffer;
	let tag: Buffer;
	try {
		ciphertext = decodeBase64(encCiphertext);
		nonce = decodeBase64(encNonce);
		tag = decodeBase64(encTag);
	} catch {
		throw parseErr("Failed decrypting machine file");
	}

	let plaintext: Buffer;
	try {
		plaintext = aes256GcmDecrypt(digest, nonce, ciphertext, tag);
	} catch {
		throw parseErr("Failed decrypting machine file");
	}

	let obj: unknown;
	try {
		obj = JSON.parse(plaintext.toString("utf8"));
	} catch {
		throw parseErr("Failed parsing decrypted machine file to json");
	}

	return parseMachineLicense(obj, "Failed deserializing machine license");
}

function sha256Key(licenseKey: string, fingerprint: string): Buffer {
	// AES key = SHA-256 over raw bytes: licenseKey bytes || fingerprint bytes
	// (machine/mod.rs: Sha256::update([key.as_bytes(), fp.as_bytes()].concat()))
	return sha256Bytes(Buffer.concat([Buffer.from(licenseKey, "utf8"), Buffer.from(fingerprint, "utf8")]));
}

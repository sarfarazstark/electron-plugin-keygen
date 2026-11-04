import { isKeygenError, keygen, type KeygenLicense } from "electron-plugin-keygen/renderer";

const $ = (id: string): HTMLElement => {
	const el = document.getElementById(id);
	if (!el) throw new Error(`missing element #${id}`);
	return el;
};

const stateEl = $("license-state");
const keyEl = $("license-key");
const outEl = $("output");
const input = $("key-input") as unknown as HTMLInputElement;

function show(license: KeygenLicense | null): void {
	if (!license) {
		stateEl.textContent = "null — not licensed";
		return;
	}
	stateEl.textContent = JSON.stringify(license, null, 2);
}

function fail(err: unknown): void {
	if (isKeygenError(err)) {
		outEl.textContent = `${err.code}: ${err.detail}`;
		return;
	}
	outEl.textContent = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

async function refresh(): Promise<void> {
	try {
		show(await keygen.getLicense());
	} catch (err) {
		fail(err);
	}
}

$("btn-refresh").addEventListener("click", () => void refresh());

$("btn-license-key").addEventListener("click", async () => {
	try {
		const key = await keygen.getLicenseKey();
		// masked: the renderer never displays or logs the full key
		keyEl.textContent = key ? `••••-••••-••••-${key.slice(-4)}` : "(no cached key)";
	} catch (err) {
		fail(err);
	}
});

$("btn-validate").addEventListener("click", async () => {
	outEl.textContent = "validating…";
	try {
		const license = await keygen.validateKey({ key: input.value });
		show(license);
		outEl.textContent = `code=${license.code} valid=${license.valid}`;
	} catch (err) {
		fail(err);
	}
});

$("btn-checkout").addEventListener("click", async () => {
	outEl.textContent = "validating + checking out machine file…";
	try {
		const license = await keygen.validateCheckoutKey({ key: input.value, ttlSeconds: 86400 });
		show(license);
		outEl.textContent = `code=${license.code} valid=${license.valid}; offline license stored`;
	} catch (err) {
		fail(err);
	}
});

$("btn-reset-license").addEventListener("click", async () => {
	try {
		await keygen.resetLicense();
		outEl.textContent = "license + offline files reset (cached key kept)";
		await refresh();
	} catch (err) {
		fail(err);
	}
});

$("btn-reset-key").addEventListener("click", async () => {
	try {
		await keygen.resetLicenseKey();
		outEl.textContent = "cached license key removed";
		keyEl.textContent = "";
	} catch (err) {
		fail(err);
	}
});

void refresh();

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createKeygenBridge } from "../lib/preload/api.ts";
import { KEYGEN_CHANNELS } from "../lib/shared/keygen-types.ts";

/**
 * The sandboxed preload is a second, deliberate copy of the bridge: a sandboxed
 * preload runs as plain JavaScript and cannot require sibling files, so it may
 * not share a module with `api.ts`. These tests are what keep the two from
 * drifting apart.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "../lib/preload/sandboxed.cts");
const builtPath = path.join(here, "../dist/preload/sandboxed.cjs");

test("the sandboxed preload names all six channels literally", () => {
	const source = fs.readFileSync(sourcePath, "utf8");
	for (const channel of Object.values(KEYGEN_CHANNELS)) {
		assert.ok(source.includes(`"${channel}"`), `channel ${channel} is not inlined`);
	}
});

test("the built sandboxed preload depends on nothing but electron", async (t) => {
	if (!fs.existsSync(builtPath)) {
		await t.skip("dist/ not built; run npm run build:lib");
		return;
	}
	// Any relative require here fails at load time with "module not found" in a
	// sandboxed renderer, which is the whole reason this file is self-contained.
	const built = fs.readFileSync(builtPath, "utf8");
	assert.equal(/\brequire\((["'])\.\1/.test(built), false, "relative require in the sandboxed preload");
	assert.deepEqual([...built.matchAll(/\brequire\((["'])([^"']+)\1\)/g)].map((m) => m[2]).sort(), [
		"electron",
	]);
});

test("sandboxed and ESM bridges expose and call the same six methods", async (t) => {
	if (!fs.existsSync(builtPath)) {
		await t.skip("dist/ not built; run npm run build:lib");
		return;
	}
	const { createSandboxedKeygenBridge } = createRequire(import.meta.url)(builtPath) as {
		createSandboxedKeygenBridge: typeof createKeygenBridge;
	};

	const recorded = (prefix: string) => {
		const calls: string[] = [];
		const invoke = async (channel: string) => {
			calls.push(`${prefix}:${channel}`);
			return { ok: true, data: null };
		};
		return { calls, invoke };
	};

	const esm = recorded("esm");
	const cjs = recorded("cjs");
	const a = createKeygenBridge(esm.invoke);
	const b = createSandboxedKeygenBridge(cjs.invoke);

	assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort());

	for (const name of Object.keys(a) as Array<keyof typeof a>) {
		const run = (bridge: Record<string, unknown>) =>
			(bridge[name] as (arg?: unknown) => Promise<unknown>)(
				name === "validateKey" ? { key: "K" } : undefined,
			);
		await run(a);
		await run(b);
	}

	assert.deepEqual(
		cjs.calls,
		esm.calls.map((c) => c.replace("esm:", "cjs:")),
	);
});

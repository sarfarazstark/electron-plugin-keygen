# electron-plugin-keygen

Keygen.sh licensing for Electron. Port of `tauri-plugin-keygen` (v2): same renderer API, same
cryptography, same on-disk machine license format, with the Tauri shell replaced by Electron's
process model — the main process owns licensing, the renderer reaches it over six fixed channels.

```
npm install electron-plugin-keygen
```

Requires Electron >= 30 (peer) and `valibot` (installed automatically). No native addons.

## Entry points

| Entry | Runs in | Provides |
| --- | --- | --- |
| `electron-plugin-keygen` | main | `registerKeygen`, `KeygenBuilder`, `keygenPreloadPath`, `keygenSandboxedPreloadPath`, `LicensingService`, `KeygenError` |
| `electron-plugin-keygen/preload` | preload | self-installing `window.keygen` bridge, `installKeygenBridge` (ESM, unsandboxed) |
| `electron-plugin-keygen/preload/sandboxed` | preload | the same bridge as one self-contained CommonJS file, for `sandbox: true` |
| `electron-plugin-keygen/renderer` | renderer | `keygen`, `createKeygenLicensingApi`, `isKeygenError`, types |

## Main process

```ts
import { app, BrowserWindow, ipcMain } from "electron";
import { KeygenBuilder, registerKeygen } from "electron-plugin-keygen";

const appWindows = new Set<BrowserWindow>();

// Registers IPC at once, builds the service when the app is ready.
void registerKeygen({
	app,
	ipc: ipcMain,
	// only windows this app created may reach the licensing channels
	getTrustedWebContentsIds: () =>
		[...appWindows].filter((w) => !w.isDestroyed()).map((w) => w.webContents.id),
	config: KeygenBuilder.new(accountId, verifyKey).cacheLifetime(240).build(),
});
```

- `config` omitted reads `KEYGEN_ACCOUNT_ID`, `KEYGEN_VERIFY_KEY`, `KEYGEN_API_URL`,
  `KEYGEN_CUSTOM_DOMAIN`, `KEYGEN_VERSION_HEADER`, `KEYGEN_CACHE_LIFETIME`.
- `config: null` disables licensing; every channel then answers `LICENSING_DISABLED`.
- Self-hosted Keygen: `KeygenBuilder.withCustomDomain(url, verifyKey)`.

No account id, product id, verification key, or server URL is hardcoded in the package.

## Window and preload

Keep the renderer sandboxed and give it a CommonJS preload:

```ts
new BrowserWindow({
	webPreferences: {
		preload: keygenSandboxedPreloadPath(), // one self-contained .cjs
		contextIsolation: true,
		nodeIntegration: false,
		sandbox: true,
	},
});
```

A sandboxed preload runs as plain JavaScript and cannot `require` sibling files, so the plugin ships
this entry as a single self-contained file. If your app owns the preload instead, bundle it to CJS
(`example/electron.vite.config.ts` sets `format: "cjs"` and `externalizeDeps: false` so the bridge is
inlined) and import `electron-plugin-keygen/preload` from it.

`keygenPreloadPath()` returns the ESM `.mjs` entry, which needs `sandbox: false`. Prefer the sandboxed
path unless something else in your app forces an unsandboxed renderer.

## Renderer

```ts
import { keygen, isKeygenError } from "electron-plugin-keygen/renderer";

const license = await keygen.validateKey({ key, entitlements: ["pro-plugin"] });

try {
	await keygen.validateCheckoutKey({ key, ttlSeconds: 86_400 });
} catch (err) {
	if (isKeygenError(err)) console.log(err.code, err.detail); // e.g. NO_MACHINE
}
```

## API (unchanged from the plugin)

| Method | Behaviour |
| --- | --- |
| `getLicense()` | License from app state, or `null` |
| `getLicenseKey()` | Cached license key, or `null` |
| `validateKey({ key, entitlements = [], cacheValidResponse = true })` | Validates; on `NO_MACHINE`, `NO_MACHINES` or `FINGERPRINT_SCOPE_MISMATCH` it activates the machine and re-validates |
| `validateCheckoutKey({ key, entitlements = [], ttlSeconds = 86400, ttlForever = false })` | Validates without caching the response, then checks out an offline machine file |
| `resetLicense()` | Removes `machine.lic`, the validation cache and app state — keeps the cached key |
| `resetLicenseKey()` | Removes only the cached key |

Every failure this API raises is a `KeygenError`, transport failures included: a window whose preload
is installed but whose main process never called `registerKeygen` rejects with `IPC_UNREACHABLE`
rather than Electron's raw "No handler registered" error, so `isKeygenError(err)` never lies.

## Storage

`{userData}/keygen/`

- `machine.lic` — Keygen machine file (AES-256-GCM envelope, Ed25519 signature), format unchanged
- `validation_cache/{sha256("key:YYYY-MM-DD")}` — signed response, encrypted with `safeStorage`, reused
  offline **for the remainder of that local day** — the filename is the day, so an offline restart after
  midnight does not find it. `validateCheckoutKey()` is the call that survives a restart.
- `key` — license key encrypted with Electron `safeStorage` (DPAPI / Keychain / libsecret)

Both encrypted files are secrets: the cached response body contains the license key, so it is
encrypted as a whole and re-hashed for the `Digest` check after decryption, never redacted. A cache
written before cache encryption existed is deleted on sight rather than read, so such an install
revalidates once online.

Startup loads in the original order: machine license first, then today's response cache. An expired
machine file short-circuits the cache; an undecryptable one falls through to it.

`safeStorage` unavailability never degrades to plaintext. Availability is checked *before* the
network call: `validateKey` then succeeds without persisting anything (the license does not survive a
restart; `service.persistsLicenses` is `false`), and `checkout` refuses with `STORAGE_UNAVAILABLE`
because a machine file whose key cannot be stored is unreadable. Undecryptable data throws
`STORAGE_DECRYPT_FAILED`. On Linux, a `basic_text` backend — `safeStorage` encrypting under a
hardcoded password because no secret store exists — counts as unavailable.

## Verification

- Every response, live or cached, is verified with the account's public ed25519 key over the
  `(request-target)`, `host`, `date` and `digest` lines. HTTP 200 without a matching signature is
  `BAD_RESPONSE` — a successful status is never treated as a valid license.
- Replay and staleness: live responses must be within 5 minutes of the local clock **in either
  direction**, so a captured response stays useless once the drift window passes; cached responses
  must be younger than `cacheLifetime` (clamped to 60–1440 minutes).
- Offline machine files are only honoured while their own issued/expiry window and the license
  expiry allow it; a future "issued" date is treated as clock tampering.
- The renderer never touches the network, filesystem, or verification key.
- License keys, machine files and raw API bodies are never logged.

## Deviations from the original

Deliberate behaviour changes, all of them divergences from `tauri-plugin-keygen` v2 rather than
bug-for-bug reproduction:

| Change | Why |
| --- | --- |
| Cached key **and** validation cache stored via `safeStorage`, never plaintext | the response body carries the license key; plaintext at rest leaked it |
| `validateKey` does not persist a key the server called invalid, and does not overwrite a previously cached one | a revoked or banned key has no business staying on disk |
| Checkout omits `ttl` instead of sending a negative remaining lifetime | a negative lifetime cannot buy offline access; clamping it upward would fabricate some |
| Clock drift is checked symmetrically | accepting any future `Date` made replay resistance depend on the server's clock |
| Async `safeStorage` API when available (Electron 45+), sync API as fallback | the synchronous API is deprecated at 45 and removed at 46 |
| Rust `panic!` paths (malformed base64, bad nonce/tag length) become errors | a crash in a host process is not acceptable |
| Sandboxed preload option, six fixed channels, sender + top-frame gating, valibot arguments | the Tauri host exposed commands to whatever its capabilities allowed |
| User-Agent reports the Electron engine instead of WebView2/WebKit | the original read Tauri's `webview_version` and `os` plugins |
| Fingerprints from the same sources as `machine-uid`: MachineGuid, IOPlatformUUID, `/etc/machine-id` | keeps machine identity stable across restarts |

Still preserved on purpose, because the offline format and existing installs depend on it: the
`machine.lic` format, whole-minute expiry comparisons (a license with 10 seconds left reports as
expired), an `EXPIRED` license that maintains access while the server says so, and `resetLicense()`
keeping the cached key while `resetLicenseKey()` removes it.

`BUGS.md` lists what remains advisory rather than enforced.

## Development

```
npm install
npm run build:lib    # dist/: js + d.ts, preload renamed to .mjs
npm test             # node --test with mocked Keygen HTTP; no real activations
npm run typecheck
npm run lint
npm run dev          # runs the example app
npm run verify:electron   # after build: real OS vault + live renderer, see BUGS.md
npm run verify:live       # after build: against a real Keygen account, spends a seat — see BUGS.md
```

`npm test` mocks the network and injects a fake codec, so it verifies policy. `verify:electron` is the
part that needs a real session: `safeStorage` through DPAPI / Keychain / libsecret, and both preload
entry points loaded into a live renderer — the layer that a mocked codec cannot catch.
`verify:live` goes one step further and talks to an actual licensing server with credentials from the
environment; it activates a machine it cannot release, so it is a deliberate, seat-consuming check.

`example/` is a complete Electron app consuming the published surface (`file:..` dependency).
`tauri/` is the upstream plugin kept as the reference for this port — it is not built or shipped.

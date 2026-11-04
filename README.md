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
| `electron-plugin-keygen` | main | `registerKeygen`, `KeygenBuilder`, `keygenPreloadPath`, `LicensingService`, `KeygenError` |
| `electron-plugin-keygen/preload` | preload | self-installing `window.keygen` bridge, `installKeygenBridge` |
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

```ts
new BrowserWindow({
	webPreferences: {
		preload: keygenPreloadPath(),   // or your own preload, see below
		contextIsolation: true,
		nodeIntegration: false,
		sandbox: false,                 // ESM (.mjs) preload scripts require this
	},
});
```

A host with its own preload script calls `installKeygenBridge()` from
`electron-plugin-keygen/preload` instead.

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

## Storage

`{userData}/keygen/`

- `machine.lic` — Keygen machine file (AES-256-GCM envelope, Ed25519 signature), format unchanged
- `validation_cache/{sha256("key:YYYY-MM-DD")}` — signed response, reused offline; entries from
  other days are deleted at startup
- `key` — license key encrypted with Electron `safeStorage` (DPAPI / Keychain / libsecret)

Startup loads in the original order: machine license first, then today's response cache. An expired
machine file short-circuits the cache; an undecryptable one falls through to it.

`safeStorage` unavailability never degrades to plaintext: writes and reads throw
`STORAGE_UNAVAILABLE`, undecryptable data throws `STORAGE_DECRYPT_FAILED`.

## Verification

- Every response, live or cached, is verified with the account's public ed25519 key over the
  `(request-target)`, `host`, `date` and `digest` lines. HTTP 200 without a matching signature is
  `BAD_RESPONSE` — a successful status is never treated as a valid license.
- Replay and staleness: live responses older than 5 minutes are rejected, cached responses must be
  younger than `cacheLifetime` (clamped to 60–1440 minutes).
- Offline machine files are only honoured while their own issued/expiry window and the license
  expiry allow it; a future "issued" date is treated as clock tampering.
- The renderer never touches the network, filesystem, or verification key.
- License keys, machine files and raw API bodies are never logged.

## Deviations from the original

| Change | Why |
| --- | --- |
| Cached key stored via `safeStorage`, not as plaintext | Electron provides OS-backed encryption; plaintext secrets were a weakness of the original |
| User-Agent reports the Electron engine instead of WebView2/WebKit | the original read Tauri's `webview_version` and `os` plugins |
| Rust `panic!` paths (malformed base64, bad nonce/tag length) become errors | a crash in a host process is not acceptable |
| Fingerprints from the same sources as `machine-uid`: MachineGuid, IOPlatformUUID, `/etc/machine-id` | keeps machine identity stable across restarts |

Preserved deliberately, because the server and existing machine files depend on it: future-dated
responses are accepted (minute truncation), `ttl` can go negative for a maintained `EXPIRED`
license when `ttlForever` is false, `resetLicense` keeps the cached key, and the license key is
cached even when the validation response is invalid.

## Development

```
npm install
npm run build:lib    # dist/: js + d.ts, preload renamed to .mjs
npm test             # node --test with mocked Keygen HTTP; no real activations
npm run typecheck
npm run lint
npm run dev          # runs the example app
```

`example/` is a complete Electron app consuming the published surface (`file:..` dependency).
`tauri/` is the upstream plugin kept as the reference for this port — it is not built or shipped.

# BUGS.md

Issues found while porting `tauri-plugin-keygen` (v2) to Electron. Three groups: flaws inherited
from the original and kept on purpose, weaknesses the port fixes, and limitations of this port.
Severity is about the licensing guarantee, not about code style. Nothing here was demonstrated
against a live Keygen account — analysis is from the Rust/TypeScript source and the tests in `tests/`.

## 1. Inherited from the original, reproduced deliberately

Compatibility with existing servers, licenses and machine files outweighs fixing these in a port.
Each one has a test that pins the behaviour.

### 1.1 License key cached even when the license is invalid — medium
`service.ts` `rawValidate` mirrors `commands.rs`: cache the response, update state, then
`writeLicenseKey(license.key)` — unconditionally, including for `valid: false` results.

Impact: a revoked, expired or soft-banned key stays on disk in `{userData}/keygen/key` (encrypted at
rest by `safeStorage`, but still retrievable through `getLicenseKey()`), and `resetLicense()` does not
remove it. A user who "loses" a license still has the key material on the machine.
Fixing it means diverging from the plugin: keep `resetLicense()` clearing the key too, or stop
caching invalid keys. Either change alters what an upgrading app sees on disk.

### 1.2 `ttl` can be sent to the server as a negative number — low
`machine.ts`/`service.ts` `checkout` replicate Rust's
`ttl = min(seconds_to_expiry, clamp(ttlSeconds, 3600, 31_556_952))` with signed minutes truncation.
For a `EXPIRED`-but-maintained license (`valid && code === "EXPIRED"`) with `ttlForever: false`,
`seconds_to_expiry` is negative and is sent verbatim (`ttl=-100`, pinned by a test).

Impact: undefined server behaviour; Keygen currently tolerates it. If the API tightens validation,
the same call that "worked" on the Tauri plugin starts failing here too — it fails identically on both.

### 1.3 Future-dated responses are accepted without an upper bound — medium
`client.ts` `verifyResponse` mirrors the chrono check:
`Math.trunc((now - date) / 60000) > maxClockDrift` — a negative value (Date header in the future)
always passes, so a response dated years ahead is "fresh" forever.

Impact: replay resistance relies on the signing server never sending a skewed-future `Date`, and on
the client clock not being set behind a captured response's date. An attacker who can capture one
signed response and roll the local clock back far enough keeps a valid cached response far beyond the
5-minute window. Signature verification still holds — this is a freshness gap, not a forgery gap.
A bounded check (`abs(minutes) <= maxClockDrift`) would close it but changes which responses the
plugin accepts, so it is not done here.

### 1.4 Offline artifacts are only bound to the machine identity — medium
`machine.lic` is AES-256-GCM under `sha256(licenseKey || fingerprint)` with an Ed25519 signature over
`machine/{enc}`, and the fingerprint is the OS machine identifier (MachineGuid / IOPlatformUUID /
machine-id). Nothing else ties the file to the install.

Impact: anyone with write access to the user's own machine can read the key out of
`{userData}/keygen/key` (they are the same OS user that `safeStorage` protects against), copy
`machine.lic` to a machine whose fingerprint they can also compute, and keep offline access until the
license expiry. This is inherent to client-side offline licensing; listed so nobody assumes the
machine file is tamper-proof. Not fixable inside this plugin.

### 1.5 Expiry checks trust the system clock — medium
`hasExpired`, `hasMachineFileExpired` and the cache lifetime all compare against the wall clock. The
"issued in the future means tampering" rule catches a clock set *ahead*, but a clock set *behind*
extends offline access, silently.

Impact: offline enforcement is advisory. Any monotonic/last-seen-time anchor would be a design change
beyond the port's scope.

### 1.6 A failed init is swallowed — low
The Tauri plugin's `setup` did `dbg!(err)` and fell back to a default (unlicensed) state;
`service.ts` `init()` keeps that behaviour and logs through the injected `Logger`.

Impact: if today's cache file is corrupt or fails verification, the app starts unlicensed with no
user-visible signal, and a re-validation is required. Debugging relies on the host wiring the logger.

## 2. Weaknesses of the original that this port closes

### 2.1 Plaintext cached license key — fixed
The original wrote `{app_data}/keygen/key` as plain bytes (`cache_license_key`, `fs::write`). Any
process running as the user could read a paid license key. The port routes that file through
Electron `safeStorage` and refuses plaintext: unavailable OS encryption raises `STORAGE_UNAVAILABLE`,
undecryptable data raises `STORAGE_DECRYPT_FAILED` (no silent fallback).

### 2.2 Unsigned/undated response acceptance — same rules, verified in tests
Both implementations reject a missing `Keygen-Signature`, missing `Date`/`Digest`, digest mismatch,
stale date and foreign signing key with `BAD_RESPONSE`. The port pins each branch with tests
(`tests/client.test.ts`), including "HTTP 200 is never treated as license validity".

### 2.3 Panics on malformed machine files — fixed
Rust `unwrap`/`expect` paths on bad base64 and wrong nonce/tag lengths crashed the host process. A
malformed or hostile `machine.lic` was a crash trigger. The port turns every such path into
`Failed decrypting machine file` / `Failed parsing decrypted machine file to json` errors
(`tests/machine.test.ts`).

### 2.4 Unrestricted command surface — fixed
Tauri exposed the plugin commands to whatever the app's capabilities allowed; the port hard-requires
a registered application window **and** the window's top frame, so an iframe or an untracked
`WebContents` gets `UNTRUSTED_SENDER` before any argument is read, and every argument goes through a
valibot schema (`tests/ipc.test.ts`, `tests/plugin.test.ts`).

## 3. Limitations and open items in this port

### 3.1 The response cache still contains the license key — open, medium
`storage.ts` `cacheResponse` writes `JSON.stringify(cache)`, and `cache.body` is the raw response
text, which contains `data.attributes.key` — in plaintext (no `safeStorage`), because verification
re-hashes the body and any redaction would break the `digest`.

Impact: the key is readable on disk by any process as the same user, which undercuts 2.1.
Options (all behaviour-changing, so not chosen here): store the body only as the hash needed for
replay checks, encrypt the whole cache file with `safeStorage` (the body would have to be re-hashed
after decrypt, which works), or bind cache entries to the machine fingerprint.

### 3.2 `STORAGE_UNAVAILABLE` arrives after a successful validation — open, medium
`rawValidate` caches the response and updates state before `writeLicenseKey`, so on a machine with no
OS keyring (common on headless/wayland-less Linux) a *successful* validation throws
`STORAGE_UNAVAILABLE` to the renderer even though the license is now in state.

Impact: apps on such machines see an error dialog after a valid key, and `getLicense()` disagrees with
the reported failure. Fix: make key caching best-effort with an explicit warning, or preflight
`safeStorage.isEncryptionAvailable()` before the network call and disable key caching for the session.

### 3.3 ESM preload requires an unsandboxed renderer — known constraint
An ESM preload script must be `.mjs`, and Electron only loads ESM preloads when `sandbox: false`.
So the plugin's own preload (and the example) run with the renderer unsandboxed.

Mitigation in place: `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`, bridge
limited to six methods over six fixed channels, window-open handler denied. A sandboxed variant would
need a CommonJS preload build (`require` is unavailable in ESM) — see 3.4.

### 3.4 No CommonJS/sandboxed preload build — open, low
`scripts/postbuild.mjs` renames `dist/preload/index.js` to `index.mjs` and nothing else is emitted.
Hosts that require a sandboxed preload have no build to point at.

Next step if needed: emit `dist/preload/index.cjs` as well (same bridge, `require`-based) and add a
`./preload/cjs` export. Untouched until a consumer needs it.

### 3.5 Fingerprint collection blocks the main process — open, low
`machine.ts` runs `reg query HKLM\SOFTWARE\Microsoft\Cryptography` / `ioreg` synchronously via
`child_process`. Startup takes the subprocess latency; on failure the fingerprint is `""` and every
validation fails with `NO_FINGERPRINT`.

Impact: a slow or locked registry query delays app start; the failure mode is loud (error code) but
not actionable by the user. Fix: cache the value, and/or run the query off the startup path.

### 3.6 `keygenPreloadPath()` relies on self-reference resolution — open, low
It uses `import.meta.resolve("electron-plugin-keygen/preload")` with a relative-path fallback
(`../preload/index.mjs`). A bundler that rewrites the main entry's location (asar-less layouts,
single-file bundles) can land outside `dist/` and miss both.

Workaround for such hosts: call `installKeygenBridge()` from their own preload, which the example
demonstrates.

### 3.7 `v.tuple([])` does not reject extra arguments — open, low
The no-argument channels use `emptyArgs = v.tuple([])`, which tolerates extra positional values —
they are dropped because handlers only ever pass `parsed[0]`, so nothing reaches the service (pinned
by a test), but "strict rejection" would be a stronger statement. Fix if desired: assert
`args.length === 0` per channel.

### 3.8 OS-backed encryption is untested in CI — known gap
`safeStorage` needs a real keyring/DPAPI session. The tests inject a fake codec, so what is verified
is the *policy* (never plaintext, explicit failure codes), not DPAPI/Keychain/libsecret behaviour
itself. Anyone claiming "the key is encrypted at rest on all platforms" has not tested it here.

### 3.9 Deviations that could matter to a server-side integration — known
- User-Agent reports the Electron engine rather than Tauri's WebView2/WebKit version, so Keygen
  `whoami`-style metadata differs from a Tauri install of the same app.
- `app.getPath("userData")` replaces Tauri's `app_data_dir`; existing installs' data does not migrate.
- `Activation`/`Checkout` request/response formats are unchanged, so a server that accepts one accepts
  the other — no Key.sh-side work is required.

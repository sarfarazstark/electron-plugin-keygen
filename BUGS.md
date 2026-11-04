# Known issues

What you need to know before shipping licensing in an Electron app with this package: behaviours that
will surprise you, the real limits of the offline guarantee, and open defects. Analysis is from the
implementation and the tests in `tests/`. Items marked *verified in Electron* were run against a real
Electron 45 session on Windows, not only against mocks.

What is *guaranteed* — signature and digest verification, sender gating on every IPC channel, no
plaintext fallback for licensing secrets — is in README.md. This file is about what is still wrong or
unexpected.

Severity is about the licensing guarantee, not code style. "Pinned by a test" means the behaviour is
intentional and a change to it will fail loudly — not that it is good.

## Limits of offline licensing (not fixable here)

### Expiry and freshness trust the system clock — medium

`hasExpired`, `hasMachineFileExpired` and the cache lifetime compare against wall-clock time. The
"issued in the future means tampering" rule catches a clock set *ahead*; a clock set *behind* extends
offline access silently. There is no monotonic or server-anchored clock in this package.

Mitigations that belong to the app, not the plugin: keep offline TTLs short, require periodic online
revalidation, and treat offline access as a convenience.

### A machine file can be moved to another machine — medium

`machine.lic` is AES-256-GCM under `sha256(licenseKey || fingerprint)` with an Ed25519 signature over
`machine/{enc}`, and the fingerprint is the OS machine identifier (MachineGuid / IOPlatformUUID /
`/etc/machine-id`). Anyone with write access as the same OS user can read the key out of
`{userData}/keygen/key` — that is the same user `safeStorage` protects against, and on Windows DPAPI
protects against *other users*, not other applications in your session — copy `machine.lic` to a
machine whose fingerprint they can also compute, and keep access until the license expires.

Treat machine binding as a deterrent to casual sharing, not as hardware identity. Seat limits and
online revalidation are the enforcement mechanism.

## Behaviours to design around

### A valid license may be validated and then not persisted — medium

When the OS vault is unusable, `validateKey` succeeds and keeps nothing on disk: the license does not
survive a restart. This is deliberate (availability is probed before the network call, so a working
validation never turns into a storage error), but the user needs to be told.

Check `service.persistsLicenses` in the main process and surface it. On Linux, a `basic_text` backend
— no secret store, so `safeStorage` encrypts under a hardcoded password — counts as unusable, and
`checkout` refuses outright with `STORAGE_UNAVAILABLE` because a machine file whose key cannot be
stored is unreadable.

### Startup license state can be wrong with no user-visible signal — low

If the cache file is corrupt or fails verification, `init()` logs through the injected `Logger` and
continues unlicensed; a re-validation is required. The reason is now readable in the main process as
`service.startupDiagnostic` (sanitized message, no key material, deliberately not an IPC channel).
Wire a logger that reaches your diagnostics.

### The validation cache is only valid for the local calendar day — medium

`responseCachePath()` names each entry `sha256("{key}:{YYYY-MM-DD}")`, and `load()` reads today's name
(`lib/main/keygen/storage.ts:118`, `lib/main/keygen/service.ts:99`). So an offline restart on a *new*
day finds nothing, whatever `cacheLifetime` says — the maximum 1440 minutes is unreachable through this
path. This is upstream's design, not a regression: the durable offline artefact is the checked-out
machine file, and the response cache is only "the app was validated earlier today".

Consequence for a host: if you want offline use that survives a restart, call
`validateCheckoutKey()`, not `validateKey()`. A user who flies overnight and opens the app on the other
side revalidates or stays unlicensed.

Observed against a real account rather than argued from the source: the offline restart that restores
the license today restores nothing when the same read runs under `TZ=Pacific/Kiritimati`, because that
is already a different local date and therefore a different filename. `npm run verify:live` covers both.

### Seats are never released — medium

`validateKey` auto-activates on `NO_MACHINE` / `NO_MACHINES` / `FINGERPRINT_SCOPE_MISMATCH`
(`lib/main/keygen/service.ts:157`), and there is no machine deletion anywhere in this package — nothing
calls `DELETE /v1/machines/{id}`, so `resetLicense()` forgets the local file and leaves the seat taken.
Any change to the fingerprint (OS reinstall, a reimaged VM, a cloned `/etc/machine-id` fixed up later)
creates a *new* machine, and the old one accumulates.

At `maxMachinesByLicense` the user is locked out of a key they own, with an error that reads as
"license invalid". Releasing a seat needs an account-level token, which must not ship inside the app, so
the only correct fix is operational: leave headroom in the policy, and give support a dashboard step.
`FINGERPRINT_SCOPE_MISMATCH` is the code to watch for — it means the same machine reported a different
fingerprint, i.e. a seat just leaked.

### The renderer can read the raw license key — medium

`getLicenseKey()` returns the decrypted key over IPC (`lib/main/keygen/ipc.ts:47`), because the
plugin's own UI is expected to display it, and `validateKey` echoes it in the license object too. It is
never placed in renderer storage by this package, but anything that executes JS in that window can read
it and use it elsewhere — combined with the machine-file note above, a stolen key plus a target
fingerprint (trivially readable on a machine the attacker controls) is a working copy.

Only surface this channel to windows that need it, keep remote content out of licensed windows, and if
your UI can show a masked key, mask it.

### Licensing fails open when the build is unconfigured — medium

With no verify key, every channel throws `LICENSING_DISABLED` (`lib/main/keygen/ipc.ts:75`) and the app
is expected to keep running — that is what the example does, and what the README documents as a
supported state. Right for development, wrong by default for a release: an env var that failed to bake
into the packaged app ships a build with no licensing signal at all, and whether that means "features
off" or "features free" is decided by your own gate, not here.

In a release build, assert that licensing is configured at startup and refuse to run paid features if it
is not.

### Old response-cache entries are swept only on a cache hit — low

`clearResponseCacheExcept()` runs inside the branch where *today's* entry was found
(`lib/main/keygen/service.ts:102`), mirroring upstream's call site. If the machine file satisfies the
start, or if today's entry is missing, entries from previous days stay on disk indefinitely. They are
encrypted and they fail verification once past `cacheLifetime`, so this is clutter rather than a leak —
but it means README's "entries from other days are deleted at startup" is only true on a start that hits
the cache. `resetLicense()` does clear the whole directory.

## Fixed since the security review

| Was | Now |
| --- | --- |
| Validation cache held the license key in plaintext | whole cache record encrypted via `safeStorage`; verified after decrypt, so the `Digest` re-hash still runs on the original body |
| A cache entry dated arbitrarily far in the future was always "fresh" | clock drift is checked in both directions; ±3 min still passes, +60 min does not |
| The license key was cached even when the server said invalid, overwriting a previously good one | invalid results persist nothing and leave the old cached key alone |
| Checkout sent `ttl=-100` for a maintained expired license | `ttl` is omitted, so the server default applies |
| The renderer had to run unsandboxed for the ESM preload | a self-contained CommonJS preload is shipped, and the example runs `sandbox: true` — verified in Electron 45 |
| Synchronous `safeStorage` only | async API on Electron 45+, sync fallback for older peers, `shouldReEncrypt` honoured by rewriting the file |
| Linux without a keyring stored "encrypted" data under a hardcoded password | `basic_text` is treated as no vault at all |
| `STORAGE_UNAVAILABLE` thrown after a successful validation | availability probed before the request; checkout fails before issuing an unreadable file |
| The async `safeStorage` trio was called detached from its object | bound once in `vault.ts`; Electron's native bindings throw "Illegal invocation" otherwise, the availability probe read that as "no vault", and on Electron 45 nothing persisted at all |
| A window with no registered handlers threw Electron's raw error into the renderer | `IPC_UNREACHABLE` — every rejection from the renderer API is a `KeygenError` (found by the live probe below) |

Two of these are still open as *documentation* problems rather than code problems: nothing here makes
offline access tamper-proof, and encryption at rest does not stop someone who controls the running
application.

The detached-bindings row is not a finding from the review — it is a regression this port introduced
when it moved to the async API, and the whole suite passed without seeing it: every test injected a
plain-object codec, and detached methods on a plain object work fine. It surfaced the first time the real
`safeStorage` was called, and it is the reason this file now distinguishes "tested" from "run against
Electron".

## Open items in this port

### Fingerprint collection blocks the main process — low

`lib/main/keygen/machine.ts` runs `reg query HKLM\SOFTWARE\Microsoft\Cryptography` / `ioreg`
synchronously through `child_process`, so startup pays the subprocess latency. On failure the
fingerprint is `""` and every validation fails with `NO_FINGERPRINT` — loud, but not actionable by the
user. Fix if it bites: cache the value and move the query off the startup path.

### `keygenPreloadPath()` relies on self-reference resolution — low

It resolves `import.meta.resolve("electron-plugin-keygen/preload")` with a relative-path fallback, as
does `keygenSandboxedPreloadPath()`. A bundler that relocates your main entry — asar-less layouts,
single-file bundles — can miss both. If that happens, bundle your own preload and import
`electron-plugin-keygen/preload` from it, which is what the example does.

Packaged-app layouts (asar, asar with unpacked files) have **not** been tested here; the example was
verified as an unpacked build.

### Extra arguments on no-argument channels are dropped, not rejected — low

The no-argument channels validate with `v.tuple([])`, which tolerates extra positional values. They
never reach the service because handlers only pass the first parsed argument (pinned by a test), but
that is not "strict rejection". Fix if you want the stronger statement: assert `args.length === 0` per
channel.

### OS-backed encryption is untested in CI — medium

`safeStorage` needs a real DPAPI session, Keychain, or keyring, and CI has none of them. The tests
inject a fake codec, so what they verify is the *policy* — never plaintext, explicit
`STORAGE_UNAVAILABLE` / `STORAGE_DECRYPT_FAILED`, cache round-trip — not the platform itself.

What has been run by hand, on Windows against a real Electron 45 session and the built `dist/`, via
`npm run verify:electron` (it exits non-zero, so a host can run it in CI on a machine with a vault):

- codec availability and the sync API both report a vault (DPAPI on Windows; `getSelectedStorageBackend`
  is Linux-only and reports `n/a` here)
- license key: written, 62 bytes of ciphertext on disk, the plaintext key is not present in the file,
  reads back equal
- validation cache: a `KGC1` envelope, 401 bytes, neither the license key nor the signature string
  appears in the file, and the record decrypts back to what went in
- flipping the last eight characters of the cache, or four bytes of the key ciphertext, makes the read
  throw `STORAGE_DECRYPT_FAILED` rather than return garbage
- a cache file written without the envelope — the pre-encryption format — is deleted on sight and the
  read returns `null`, so an unprotected copy cannot be replayed after an upgrade

Not run: macOS Keychain, Linux libsecret, and the `basic_text` branch — that path is argued from
Electron's documented behaviour, not observed. Anyone extending this to "encrypted at rest on all
platforms" has overclaimed the evidence.

### What the preload scripts were verified against — note

`npm run verify:electron` loads each shipped preload into a live Electron 45 renderer and reads the
bridge back from the main world: `dist/preload/sandboxed.cjs` and `example/out/preload/index.cjs` under
`sandbox: true`, `dist/preload/index.mjs` under `sandbox: false` (Electron refuses ESM preloads in a
sandbox). All three expose exactly the six methods, and in the sandboxed renderers `window.process` is
absent, so nothing about the Node environment reaches the page.

The first run of that check also produced the `IPC_UNREACHABLE` fix: it called `getLicenseKey()` with no
`registerKeygen` in the process, the invoke reached `keygen:get-license-key`, and Electron's raw "No
handler registered" error surfaced in the renderer where `isKeygenError(err)` said it was not a keygen
error. A host that forgets to wire the main process now gets a `KeygenError` like every other failure.

## What the live account run proved — note

`npm run verify:live` (credentials from the environment or a gitignored `.env.local`, nothing printed
but hashed identifiers) drives the built `dist/` inside Electron 45 on Windows against a real Keygen
account, with a sandboxed renderer wired through the real preload. Eleven steps, all passing:

- `registerKeygen` with a real account/verify key starts, and `persistsLicenses` reports `true`
- `validateKey()` round-trips over IPC, verifies the Ed25519 signature on the live response, and the
  renderer sees the license object (`VALID`, `valid=true`, an expiry ~2h out)
- the key lands in `keygen/key` as 560 bytes with no plaintext key in the file, and reads back through
  the same channel
- an offline restart with the network stubbed to always reject restores the license from today's cache
- appending one byte to the cached response body makes that offline restart return `BAD_CACHE` — the
  signature is checked against the decrypted body, so a stored response cannot be edited
- the local-day rule above, seen from two timezones
- `validateCheckoutKey()` writes a 10,382-byte `machine.lic` in Keygen's armor
  (`-----BEGIN MACHINE FILE-----`), containing no plaintext key, and it restores licensing offline
- asking for a 7-day offline window against a license with 123 minutes left is refused past the license
  itself — the ttl is a ceiling, not a grant
- `resetLicense()` removes the machine file and the cache and keeps the key; `resetLicenseKey()` leaves
  nothing restorable

That last item is the shape of the end-to-end claim: the package's behaviour with real server
signatures, a real DPAPI-backed vault, and a real renderer, rather than a mocked transport. It does not
cover macOS or Linux, packaged asar layouts, or a license long enough to watch a machine file carry
across a day boundary — and each run activates a machine that this package cannot release (see "Seats
are never released"), so it is a credential- and seat-consuming check, not a CI default.

## Where this port diverges from `tauri-plugin-keygen` v2

The four rows marked "was/now" above that change licensing semantics — invalid keys not cached,
`ttl` omitted instead of negative, bounded drift, encrypted cache — are intentional divergences from
the Tauri host, accepted after a security review. A side-by-side comparison of two hosts will now
disagree on those points. Everything else is still a faithful port: same endpoints, same signed
payload, same `machine.lic` format, same renderer API.

- Storage lives under `app.getPath("userData")`, not Tauri's `app_data_dir`; existing data does not
  migrate, so a migrated app starts unlicensed and re-activates.
- The User-Agent reports the Electron engine rather than WebView2/WebKit, so Keygen-side machine
  metadata differs from a Tauri install of the same app.
- Activation and Checkout request/response formats are unchanged — nothing on the Key.sh side is
  required.
- A malformed `machine.lic` crashes the Tauri host on Rust `unwrap` paths; here it is a
  `Failed decrypting machine file` error.

## Upstream

The findings that come from the original plugin, and are therefore worth reporting to
`bagindo/tauri-plugin-keygen` rather than only noting here: plaintext key cache, plaintext response
cache, unbounded future-dated acceptance, negative `ttl`, and the swallowed setup failure. This port
fixes them for Electron hosts only; the Rust plugin still behaves as described.

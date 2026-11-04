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
| A window with no registered handlers threw Electron's raw error into the renderer | `IPC_UNREACHABLE` — every rejection from the renderer API is a `KeygenError` (found by the live probe below) |

Two of these are still open as *documentation* problems rather than code problems: nothing here makes
offline access tamper-proof, and encryption at rest does not stop someone who controls the running
application.

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

`safeStorage` needs a real DPAPI session, Keychain, or keyring. The tests inject a fake codec, so what
is verified is the *policy* — never plaintext, explicit `STORAGE_UNAVAILABLE` /
`STORAGE_DECRYPT_FAILED`, cache encryption round-trip — and not the platform encryption itself.
Anyone claiming "the license key is encrypted at rest on all platforms" has not tested it here. A real
DPAPI round trip on Windows, plus a Keychain and a libsecret run, are still outstanding.

### What the sandboxed preload was verified against — note

Both shipped preload artifacts (`example/out/preload/index.cjs` and `dist/preload/sandboxed.cjs`) were
loaded in a live Electron 45 window with `sandbox: true` and `contextIsolation: true`, and from the
main world `window.keygen` exposed exactly the six bridge methods, with no `process` visible. The
probe called `getLicenseKey()` with no `registerKeygen` in the process: the invoke reached
`keygen:get-license-key` and failed with "No handler registered" — which is what surfaced the gap the
`IPC_UNREACHABLE` code now closes, so a host that forgot to register gets a `KeygenError` like every
other failure. The ESM entry (`keygenPreloadPath()`) is covered by the parity test but is only loadable
unsandboxed, by Electron's own rule.

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

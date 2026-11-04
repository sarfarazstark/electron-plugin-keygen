# example

Minimal Electron app that uses the plugin through its published surface
(`electron-plugin-keygen`, `/preload`, `/renderer`) — the same imports a real host app would write.

```
npm install          # links electron-plugin-keygen from .. (file:..)
npm run build        # or: npm run dev
```

The plugin needs a Keygen account to validate against. Without configuration it stays disabled and
every channel answers `LICENSING_DISABLED`, so the app still starts.

```
set KEYGEN_ACCOUNT_ID=<account uuid>
set KEYGEN_VERIFY_KEY=<64-char hex public key>
set KEYGEN_API_URL=https://api.keygen.sh
npm run dev
```

Never put the account's **secret** or private signing key in these variables — the plugin only ever
needs the public verification key.

## What the buttons call

| UI | Renderer API | Effect |
| --- | --- | --- |
| Refresh | `keygen.getLicense()` | current license from main-process state, or `null` |
| Show cached key | `keygen.getLicenseKey()` | masked last four of the cached key |
| `validateKey()` | `keygen.validateKey({ key })` | online validation, auto-activates the machine when needed |
| `validateCheckoutKey()` | `keygen.validateCheckoutKey({ key, ttlSeconds: 86400 })` | validation + offline machine file for 24 h |
| `resetLicense()` | `keygen.resetLicense()` | removes `machine.lic` and the validation cache, keeps the cached key |
| `resetLicenseKey()` | `keygen.resetLicenseKey()` | removes only the cached key |

## Layout

```
src/main/index.ts       registerKeygen + trusted window set + BrowserWindow wiring
src/preload/index.ts    imports the plugin's preload entry (installs window.keygen)
src/renderer/           vanilla UI over the /renderer entry; no key is ever logged
```

Restart the app after a successful `validateCheckoutKey()`: the license is restored offline from
`{userData}/keygen/machine.lic`, with no request to Keygen.

# protonmail-api-client

Reusable Proton Mail client package with two layers:

1. `ProtonMailClient` for REST/API access when you already have a valid cookie session store
2. `ProtonMailBrowserClient` for Playwright-based login, saved-session reuse, plaintext inbox/message extraction, and OTP retrieval

The browser client is the canonical dependency surface when other local projects need to log into Proton Mail and read email content programmatically.

## Browser Client Usage

```js
import { ProtonMailBrowserClient } from "protonmail-api-client";

const client = new ProtonMailBrowserClient({
  headless: true,
  envFile: "/absolute/path/to/env.env",
  sessionFile: "/absolute/path/to/protonmail-auth.json",
});

const login = await client.loginAndSaveSession({
  headless: true,
  manualFallback: false,
});

if (!login.success) {
  throw new Error(login.error);
}

const latest = await client.getLatestMessage({
  matchText: /openai|noreply@openai\.com/i,
  limit: 10,
});

if (!latest.success) {
  throw new Error(latest.error);
}

console.log(latest.message.subject);
console.log(latest.message.bodyText);

const otp = await client.extractOtpCode();
if (otp.success) {
  console.log(otp.code);
}
```

### Browser Client Methods

- `loginAndSaveSession(options)`
- `getInboxMessages(options)`
- `getLatestMessage(options)`
- `extractOtpCode(options)`

### Browser Client Runtime Notes

- Fresh automated logins can trigger Proton CAPTCHA or other human-verification challenges.
- Accounts with 2FA/TOTP enabled require manual completion. The browser client detects Proton's 2FA/TOTP step and returns a structured failure such as `{ success: false, twoFactor: true, manualRequired: true }`; it does not generate or submit TOTP codes.
- The durable operational model is:
  1. automatic login when Proton allows it
  2. saved-session reuse for normal programmatic runs
- For accounts with 2FA, run a headful/manual capture once, complete the challenge in the browser, and reuse the saved session file for automation.
- `envFile` should be an absolute path to a trusted credentials file when used.
- Session files contain secret-bearing browser state and should stay untracked.

## Security

This repo handles secret-bearing browser session state (Playwright storage state). Read `SECURITY.md` before using CI secrets or sharing logs.

## REST/API Usage

```js
import { ProtonMailClient, Labels } from "protonmail-api-client";

const client = new ProtonMailClient({
  sessionStore: mySessionStore,
  baseUrl: "https://mail.proton.me/api",
  rateLimit: {
    maxRetries: 2,
    baseDelayMs: 200,
    maxDelayMs: 3000,
  },
});

const { messages, total } = await client.getMessageMetadata({ LabelID: Labels.INBOX });
const message = await client.getMessage("MESSAGE_ID");
await client.markMessagesRead(["MESSAGE_ID"]);
const attachmentBytes = await client.getAttachment("ATTACHMENT_ID");
const labels = await client.getLabels();
const newLabel = await client.createLabel("Important", "#ff0000");
const calendars = await client.api("GET", "/calendar/v1");
```

HTTP 429 responses respect `Retry-After` when Proton sends it. Without that header, retries use exponential back-off with jitter until the `rateLimit.maxRetries` budget is exhausted, then throw `RateLimitError` with `retryAfter` and `retryAfterMs` fields.

## Session Store Interface

Your REST/API session store must implement at minimum:

```js
{
  getCookieHeader(url: string): Promise<string>
  getUIDCandidates(): Promise<string[]>

  getUID(): string | Promise<string>
  applySetCookieHeaders(url, headers): Promise<any[]>
  getRefreshPayload(uid): Promise<object | null>
  invalidate(): Promise<void>
}
```

See [docs/session-store.md](docs/session-store.md) for the full method contract, stored-session schema, default browser session-file behavior, and a runnable in-memory reference implementation.

## Implemented

| Area | Methods |
|------|---------|
| Browser automation | `ProtonMailBrowserClient.loginAndSaveSession`, `getInboxMessages`, `getLatestMessage`, `extractOtpCode` |
| Auth/User | `getUser`, `getAddresses`, `getKeySalts` |
| Messages (read) | `getMessage`, `getMessageMetadata`, `getAllMessageMetadata`, `getMessageIds`, `getAllMessageIds`, `getMessageCount` |
| Messages (actions) | `deleteMessages`, `markMessagesRead`, `markMessagesUnread`, `labelMessages`, `unlabelMessages`, `markMessagesForwarded`, `markMessagesUnforwarded` |
| Attachments | `getAttachment` |
| Labels/Folders | `getLabels`, `createLabel`, `updateLabel`, `deleteLabel` |
| Conversations | `getConversation`, `getConversations` |
| Events | `getLatestEventId`, `getEvents` |
| Passthrough | `api(method, path, options)` |

## Not Yet Implemented

- SRP authentication
- Draft creation / update / send via encrypted REST payloads
- Attachment decryption
- REST message body decryption
- Key management
- Contacts
- Automated 2FA/TOTP completion during auth
- FIDO2/WebAuthn during auth
- Import messages
- Undo actions
- Search
- Filters/Rules
- Settings
- Guaranteed fresh-login success when Proton presents CAPTCHA/human verification

2FA/TOTP challenge detection is implemented for the browser login path. Automated 2FA/TOTP completion is intentionally unsupported; CI and other unattended jobs must use a pre-captured saved session instead of trying to solve 2FA during fresh login.

## Architecture

```
src/
  index.js
  browser-client.js
  client.js
  http.js
  errors.js
  constants.js
```

## Debug Mode

For troubleshooting login failures, CAPTCHA issues, or selector problems, use the built-in debug mode:

```bash
PROTONMAIL_DEBUG=1 node scripts/debug-login.mjs
```

This opens a headful Chromium browser with CDP enabled, keeps it open on failure, and suppresses cooldown writes. See [DEBUG.md](DEBUG.md) for full documentation including Playwright MCP attach instructions.

## Environment Variables

This project uses a small set of `PROTONMAIL_*` environment variables for live tests, session seeding, and debug mode.

Notes:

- Values marked **Secret** must never be committed or printed (see `SECURITY.md`).
- When `PROTONMAIL_ENV_FILE` is not set, the browser client will also try `./env.env` and `./.env` at repo root.
- Session file paths are not secrets themselves, but the referenced files typically are.

| Variable | Purpose | Secret | Values / Defaults | Used by |
|---|---|---:|---|---|
| `PROTONMAIL_USERNAME` | Proton test account username for fresh login | Yes | Required for credential login; typically an email address; no default | `src/browser-client.js`, `scripts/capture-session.mjs`, `scripts/probe-login-state.mjs`, `.github/workflows/live-proton.yml`, `test/live/proton-login.test.js`, `docs/ci.md` |
| `PROTONMAIL_PASSWORD` | Proton test account password for fresh login | Yes | Required for credential login; no default | `src/browser-client.js`, `scripts/capture-session.mjs`, `scripts/probe-login-state.mjs`, `.github/workflows/live-proton.yml`, `test/live/proton-login.test.js`, `docs/ci.md` |
| `PROTONMAIL_ENV_FILE` | Absolute path to an env file containing credentials | No | Default: unset; if unset, tries `./env.env` then `./.env` | `src/browser-client.js`, `scripts/debug-login.mjs` |
| `PROTONMAIL_SESSION_FILE` | Override path to the Playwright session JSON file for scripts | No | Default (script behavior): `data/protonmail-auth.json` | `scripts/capture-session.mjs`, `scripts/debug-login.mjs`, `scripts/set-session-secret.mjs` |
| `PROTONMAIL_SESSION_JSON` | Seed session JSON (minimized Playwright storage state) for CI/live tests | Yes | Default: unset; when set, CI writes it to an isolated session file before running live tests | `.github/workflows/live-proton.yml`, `test/live/proton-login.test.js`, `docs/ci.md`, `scripts/capture-session.mjs`, `scripts/set-session-secret.mjs`, `DEBUG.md` |
| `PROTONMAIL_SESSION_CACHE_KEY` | Encryption key for short-lived cached session payloads (`.ci-proton/session.enc`) | Yes | Default: unset; when unset, workflow skips saving cache; if a cache exists, decryption requires this key. Recommended: ≥32 random bytes (see `SECURITY.md`) | `.github/workflows/live-proton.yml`, `scripts/session-cache.mjs`, `docs/ci.md` |
| `PROTONMAIL_LIVE_TEST` | Enable live Proton regression tests | No | `1` enables; default is disabled (`0`/unset) | `package.json` (`pnpm test:live`), `.github/workflows/live-proton.yml`, `test/live/proton-login.test.js`, `docs/ci.md` |
| `PROTONMAIL_LIVE_SESSION_FILE` | Path to the live-test session file used by `pnpm test:live` | No | Default (workflow): `.ci-proton/session.json`; when set and file exists, live tests reuse it | `.github/workflows/live-proton.yml`, `test/live/proton-login.test.js` |
| `PROTONMAIL_LIVE_HEADLESS` | Control headless mode for live tests | No | Default behavior: headless unless set to `0` | `.github/workflows/live-proton.yml`, `test/live/proton-login.test.js` |
| `PROTONMAIL_ALLOW_FRESH_LOGIN` | Allow fresh username/password login in live tests when no session is seeded | No | `1` allows; default is `0`/unset (live tests prefer seeded session) | `.github/workflows/live-proton.yml`, `test/live/proton-login.test.js` |
| `PROTONMAIL_DEBUG` | Enable debug mode (headful, verbose, keep browser open on error) | No | `1` or `true` enables; default disabled | `src/debug-config.js`, `src/browser-client.js`, `scripts/debug-login.mjs`, `test/debug-config.test.js`, `test/browser-client.test.js`, `README.md`, `DEBUG.md` |
| `PROTONMAIL_DEBUG_CDP_PORT` | Override Chrome DevTools Protocol port in debug mode | No | Default `9222` | `src/debug-config.js`, `scripts/debug-login.mjs`, `DEBUG.md` |
| `PROTONMAIL_DEBUG_PROFILE_DIR` | Override the debug browser profile directory | No | Default `<repo>/data/debug-profile` | `src/debug-config.js`, `scripts/debug-login.mjs`, `scripts/capture-session.mjs`, `DEBUG.md` |
| `PROTONMAIL_DEBUG_CHROMIUM` | Override Chromium executable path for debug runs | No | Default: auto (Playwright-managed Chromium unless overridden) | `src/debug-config.js`, `scripts/debug-login.mjs`, `DEBUG.md` |

## CI/CD

Required pull-request gates are offline only: install, typecheck, unit tests, and package smoke. Proton-facing checks are isolated in a separate workflow that requires repository secrets and can report Proton-side drift such as CAPTCHA, selector changes, or backend auth changes without becoming the deterministic merge gate.

Releases are automated by semantic-release on pushes to `main` after the offline gate passes. Because the package is currently private, releases publish GitHub Releases with attached npm tarballs instead of publishing to the npm registry.

See [docs/ci.md](docs/ci.md) for the full gate contract, local commands, live-test secrets, and drift policy. See [docs/RELEASING.md](docs/RELEASING.md) for release behavior and the npm-publishing checklist.

## Related

- [ProtonMail/go-proton-api](https://github.com/ProtonMail/go-proton-api)
- [proton-calendar-api](../proton-calendar-api)
